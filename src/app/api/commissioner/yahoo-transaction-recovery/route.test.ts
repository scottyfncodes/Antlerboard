import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { makeLeagueWithSeason, resetDatabase } from "@/lib/test-helpers";
import { LK, txKey, yPlayer, yTx, meta, pagedYahoo, dropTo, teamKey } from "@/lib/yahoo/yahoo-transaction-fixtures";

vi.mock("@/lib/current-manager", () => ({ requireCommissioner: vi.fn() }));
vi.mock("@/lib/yahoo/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/yahoo/client")>()),
  yahooFantasyGet: vi.fn(),
  isYahooConfigured: vi.fn(),
}));
import { requireCommissioner } from "@/lib/current-manager";
import { isYahooConfigured, yahooFantasyGet, YahooTokenUnavailableError } from "@/lib/yahoo/client";
import { GET, POST } from "./route";

const mockedRequire = vi.mocked(requireCommissioner);
const mockedGet = vi.mocked(yahooFantasyGet);
const mockedConfigured = vi.mocked(isYahooConfigured);

beforeEach(async () => {
  await resetDatabase();
  mockedRequire.mockReset();
  mockedRequire.mockResolvedValue({ id: "c", name: "Scott" } as Awaited<ReturnType<typeof requireCommissioner>>);
  mockedGet.mockReset();
  mockedConfigured.mockReset();
  mockedConfigured.mockReturnValue(true);
  // The route paces its Yahoo pages; skip the pauses.
  vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void) => { fn(); return 0; }) as unknown as typeof setTimeout);
});
afterAll(async () => {
  vi.restoreAllMocks();
  await resetDatabase();
});

async function legacy() {
  const { league, season } = await makeLeagueWithSeason(2026);
  await prisma.yahooConnection.create({ data: { leagueId: league.id, accessToken: "stored", yahooLeagueKey: LK, yahooGameKey: "469", tokenExpiresAt: new Date(Date.now() + 3_600_000) } });
  const m = await prisma.manager.create({ data: { leagueId: league.id, name: "M" } });
  await prisma.team.create({ data: { leagueId: league.id, name: "Ranger Thingz", managerId: m.id, yahooTeamId: teamKey(1) } });
  await prisma.transaction.create({ data: { seasonId: season.id, seasonYear: 2026, type: "DROP", yahooTransactionId: txKey(4), notes: "Synced from Yahoo (drop)" } });
  const yahoo = pagedYahoo([yTx(meta(4, "drop"), [yPlayer(200, "Juan Soto", dropTo(1))])]);
  mockedGet.mockImplementation((_leagueId, path, opts) => {
    expect(opts).toEqual({ allowRefresh: false });
    return yahoo.get(path);
  });
  return { league };
}

const get = (qs: string) => GET(new NextRequest(`http://localhost/api/commissioner/yahoo-transaction-recovery${qs}`));
const post = (body: unknown) =>
  POST(new NextRequest("http://localhost/api/commissioner/yahoo-transaction-recovery", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }));

describe("GET /api/commissioner/yahoo-transaction-recovery (dry run)", () => {
  it("is commissioner-only", async () => {
    mockedRequire.mockResolvedValue(null);
    expect((await get("?season=2026")).status).toBe(403);
  });

  it("returns the plan, never refreshing the token, and writes nothing", async () => {
    await legacy();
    const res = await get("?season=2026");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    const report = await res.json();
    expect(report).toMatchObject({ mode: "dry-run", leagueKey: LK, targets: 1, summary: { ready: 1 } });
    const row = await prisma.transaction.findUniqueOrThrow({ where: { yahooTransactionId: txKey(4) }, include: { players: true } });
    expect(row.yahooType).toBeNull();
    expect(row.players).toEqual([]);
  });

  it("answers 409 when the stored token has expired", async () => {
    await legacy();
    mockedGet.mockRejectedValue(new YahooTokenUnavailableError("expired"));
    expect((await get("?season=2026")).status).toBe(409);
  });

  it("requires a season", async () => {
    await legacy();
    expect((await get("")).status).toBe(400);
  });
});

describe("POST /api/commissioner/yahoo-transaction-recovery (apply)", () => {
  it("requires the explicit confirmation and a fingerprint", async () => {
    await legacy();
    expect((await post({ season: 2026, fingerprint: "a".repeat(64) })).status).toBe(400);
    expect((await post({ season: 2026, confirm: "APPLY_YAHOO_TRANSACTION_RECOVERY", fingerprint: "nope" })).status).toBe(400);
    expect(mockedGet).not.toHaveBeenCalled();
  });

  it("refuses to write from an environment without Yahoo configured (preview deployments)", async () => {
    await legacy();
    mockedConfigured.mockReturnValue(false);
    expect((await post({ season: 2026, confirm: "APPLY_YAHOO_TRANSACTION_RECOVERY", fingerprint: "a".repeat(64) })).status).toBe(503);
  });

  it("refuses a stale fingerprint with 409, and applies the reviewed one", async () => {
    await legacy();
    expect((await post({ season: 2026, confirm: "APPLY_YAHOO_TRANSACTION_RECOVERY", fingerprint: "a".repeat(64) })).status).toBe(409);
    expect((await prisma.transaction.findUniqueOrThrow({ where: { yahooTransactionId: txKey(4) } })).yahooType).toBeNull();

    const { fingerprint } = await (await get("?season=2026")).json();
    const res = await post({ season: 2026, confirm: "APPLY_YAHOO_TRANSACTION_RECOVERY", fingerprint });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ mode: "apply", written: 1 });
    const row = await prisma.transaction.findUniqueOrThrow({ where: { yahooTransactionId: txKey(4) }, include: { players: true } });
    expect(row).toMatchObject({ type: "DROP", yahooType: "drop" });
    expect(row.players).toHaveLength(1);
    expect(await prisma.auditLogEntry.count({ where: { action: "YAHOO_TRANSACTION_RECOVERY", actorName: "Scott" } })).toBe(1);
  });
});

describe("the dry run is production-only too", () => {
  it("refuses on a deployment without the Yahoo env vars, before reading anything", async () => {
    await legacy();
    mockedConfigured.mockReturnValue(false);
    expect((await get("?season=2026")).status).toBe(503);
    expect(mockedGet).not.toHaveBeenCalled();
  });
});

describe("the dedicated dry-run token (scheduled preflight)", () => {
  const TOKEN = "t".repeat(48);
  const withAuth = (method: "GET" | "POST", qs: string, authorization: string, body?: unknown) =>
    (method === "GET" ? GET : POST)(
      new NextRequest(`http://localhost/api/commissioner/yahoo-transaction-recovery${qs}`, {
        method,
        headers: { authorization, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
    );
  const apply = (fingerprint: string) => ({ season: 2026, confirm: "APPLY_YAHOO_TRANSACTION_RECOVERY", fingerprint });

  beforeEach(() => {
    vi.stubEnv("RECOVERY_DRYRUN_TOKEN", TOKEN);
    // No commissioner session: only the token could authorize anything here.
    mockedRequire.mockResolvedValue(null);
  });
  afterAll(() => vi.unstubAllEnvs());

  it("authorizes the read-only dry run without a session, never refreshing the token or writing", async () => {
    await legacy();
    const res = await withAuth("GET", "?season=2026", `Bearer ${TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(await res.json()).toMatchObject({ mode: "dry-run", targets: 1, summary: { ready: 1 } });
    expect(mockedRequire).not.toHaveBeenCalled();
    expect((await prisma.transaction.findUniqueOrThrow({ where: { yahooTransactionId: txKey(4) } })).yahooType).toBeNull();
    expect(await prisma.auditLogEntry.count()).toBe(0);
  });

  it("cannot authorize the apply, even with a valid fingerprint and confirmation", async () => {
    await legacy();
    const { fingerprint } = await (await withAuth("GET", "?season=2026", `Bearer ${TOKEN}`)).json();
    mockedGet.mockClear();
    const res = await withAuth("POST", "", `Bearer ${TOKEN}`, apply(fingerprint));
    expect(res.status).toBe(403);
    expect(mockedGet).not.toHaveBeenCalled();
    const row = await prisma.transaction.findUniqueOrThrow({ where: { yahooTransactionId: txKey(4) }, include: { players: true } });
    expect(row.yahooType).toBeNull();
    expect(row.players).toEqual([]);
    expect(await prisma.auditLogEntry.count()).toBe(0);
  });

  it("leaves the apply exactly as it was for the commissioner", async () => {
    await legacy();
    const { fingerprint } = await (await withAuth("GET", "?season=2026", `Bearer ${TOKEN}`)).json();
    mockedRequire.mockResolvedValue({ id: "c", name: "Scott" } as Awaited<ReturnType<typeof requireCommissioner>>);
    // The commissioner's apply still needs the confirmation phrase...
    expect((await post({ season: 2026, fingerprint })).status).toBe(400);
    // ...and with it, works as before, attributed to the commissioner.
    expect((await post(apply(fingerprint))).status).toBe(200);
    expect(await prisma.auditLogEntry.count({ where: { action: "YAHOO_TRANSACTION_RECOVERY", actorName: "Scott" } })).toBe(1);
  });

  it.each([
    ["a wrong token", `Bearer ${"x".repeat(48)}`],
    ["a token with a suffix", `Bearer ${TOKEN}x`],
    ["a different scheme", `Basic ${TOKEN}`],
    ["an empty bearer", "Bearer "],
  ])("rejects %s with 401 before reading anything", async (_label, authorization) => {
    await legacy();
    expect((await withAuth("GET", "?season=2026", authorization)).status).toBe(401);
    expect(mockedGet).not.toHaveBeenCalled();
  });

  it("rejects every token when the variable is unset or too short", async () => {
    await legacy();
    vi.stubEnv("RECOVERY_DRYRUN_TOKEN", "");
    expect((await withAuth("GET", "?season=2026", "Bearer ")).status).toBe(401);
    vi.stubEnv("RECOVERY_DRYRUN_TOKEN", "short");
    expect((await withAuth("GET", "?season=2026", "Bearer short")).status).toBe(401);
    expect(mockedGet).not.toHaveBeenCalled();
  });

  it("doesn't let a bad Authorization header fall back to the commissioner's session", async () => {
    await legacy();
    mockedRequire.mockResolvedValue({ id: "c", name: "Scott" } as Awaited<ReturnType<typeof requireCommissioner>>);
    expect((await withAuth("GET", "?season=2026", "Bearer wrong")).status).toBe(401);
  });

  it("still enforces production-only, the season and the connected league", async () => {
    await legacy();
    mockedConfigured.mockReturnValue(false);
    expect((await withAuth("GET", "?season=2026", `Bearer ${TOKEN}`)).status).toBe(503);
    mockedConfigured.mockReturnValue(true);
    expect((await withAuth("GET", "", `Bearer ${TOKEN}`)).status).toBe(400);
    expect((await withAuth("GET", "?season=2026&leagueKey=469.l.1", `Bearer ${TOKEN}`)).status).toBe(400);
    expect(mockedGet).not.toHaveBeenCalled();
  });
});
