import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { makeLeagueWithSeason, resetDatabase } from "@/lib/test-helpers";

vi.mock("@/lib/current-manager", () => ({ requireCommissioner: vi.fn() }));
import { requireCommissioner } from "@/lib/current-manager";
import { GET } from "./route";
const mockedRequire = vi.mocked(requireCommissioner);

const fetchMock = vi.fn();
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const league = (sub: object, season = "2026", renew = "") => ({
  fantasy_content: { league: [{ league_key: "469.l.8891", name: "Claw & Antler League", season, renew, num_teams: 12 }, sub] },
});

beforeEach(async () => {
  await resetDatabase();
  mockedRequire.mockReset();
  mockedRequire.mockResolvedValue({ id: "c" } as Awaited<ReturnType<typeof requireCommissioner>>);
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());
afterAll(resetDatabase);

async function connected(expiresInMs: number) {
  const { league: l, season } = await makeLeagueWithSeason(2026);
  await prisma.yahooConnection.create({
    data: { leagueId: l.id, accessToken: "stored-access", refreshToken: "stored-refresh", yahooLeagueKey: "469.l.8891", yahooGameKey: "469", tokenExpiresAt: new Date(Date.now() + expiresInMs) },
  });
  return { league: l, season };
}

const get = (qs: string) => GET(new NextRequest(`http://localhost/api/commissioner/yahoo-history${qs}`));

/** A one-season Yahoo: 2026, no older season linked. */
function wireYahoo() {
  fetchMock.mockImplementation(async (url: string) => {
    const path = new URL(url).pathname;
    if (path.endsWith("/settings")) return json(league({ settings: [{ is_auction_draft: "1", uses_faab: "1" }] }));
    if (path.endsWith("/teams")) return json(league({ teams: { count: 0 } }));
    if (path.endsWith("/draftresults")) return json(league({ draft_results: { "0": { draft_result: { pick: 1, round: 1, team_key: "469.l.8891.t.1", player_key: "469.p.7", cost: "40" } }, count: 1 } }));
    if (path.includes("/players;player_keys=")) return json(league({ players: { "0": { player: [[{ player_key: "469.p.7" }, { player_id: "7" }, { name: { full: "Aaron Judge" } }]] }, count: 1 } }));
    if (path.includes("/transactions")) {
      const start = Number(path.match(/start=(\d+)/)![1]);
      const all = [{ transaction: [{ transaction_key: "469.l.8891.tr.1", type: "commish", timestamp: "1760000000" }] }];
      return json(league({ transactions: start === 0 ? { "0": all[0], count: 1 } : { count: 0 } }));
    }
    throw new Error(`unexpected ${path}`);
  });
}

describe("GET /api/commissioner/yahoo-history", () => {
  it("is commissioner-only", async () => {
    mockedRequire.mockResolvedValue(null as Awaited<ReturnType<typeof requireCommissioner>>);
    expect((await get("")).status).toBe(403);
  });

  it("stops with 409 when the stored token has expired - no Yahoo call, no refresh, no write", async () => {
    await connected(-60_000);
    const before = await prisma.yahooConnection.findFirstOrThrow();
    const res = await get("?file=report");
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/doesn't refresh/);
    expect(fetchMock).not.toHaveBeenCalled();
    const after = await prisma.yahooConnection.findFirstOrThrow();
    expect(after.updatedAt).toEqual(before.updatedAt);
    expect(after.accessToken).toBe("stored-access");
  });

  it("returns the recovery report, compared with the transactions Antlerboard stores, writing nothing", async () => {
    const { season } = await connected(3_600_000);
    await prisma.transaction.create({ data: { seasonId: season.id, seasonYear: 2026, type: "DROP", date: new Date(), yahooTransactionId: "469.l.8891.tr.1" } });
    wireYahoo();
    const counts = async () => [await prisma.transaction.count(), await prisma.auditLogEntry.count(), (await prisma.yahooConnection.findFirstOrThrow()).updatedAt.getTime()];
    const before = await counts();

    const res = await get("?file=report");
    expect(res.status).toBe(200);
    const report = await res.json();
    expect(report.seasons[0]).toMatchObject({ seasonYear: 2026, draft: { picks: 1, pricedPicks: 1 }, transactions: { count: 1 }, antlerboard: { matchedByKey: 1, onlyInYahoo: 0 } });
    expect(await counts()).toEqual(before);
    // Only Yahoo's Fantasy API was called - never the token endpoint.
    expect(fetchMock.mock.calls.every(([url]) => String(url).startsWith("https://fantasysports.yahooapis.com/"))).toBe(true);
  });

  it("downloads a season's transactions in the import format and its draft results", async () => {
    await connected(3_600_000);
    wireYahoo();
    const csv = await get("?file=transactions.csv&season=2026");
    expect(csv.headers.get("content-disposition")).toContain("antlerboard-yahoo-2026-transactions.csv");
    expect((await csv.text()).split("\n")[0]).toBe("season,league_key,transaction_raw");
    const draft = await (await get("?file=draft.csv&season=2026")).text();
    expect(draft.split("\n")[1]).toBe("2026,1,1,Aaron Judge,7,469.p.7,,,40,469.l.8891.t.1,");
  });

  it("explains a season outside the chain, and validates parameters", async () => {
    await connected(3_600_000);
    wireYahoo();
    expect((await get("?file=season.json&season=2019")).status).toBe(404);
    expect((await get("?file=season.json")).status).toBe(400);
    expect((await get("?file=everything")).status).toBe(400);
  });

  it("marks responses private and uncacheable", async () => {
    await connected(3_600_000);
    wireYahoo();
    expect((await get("?file=report")).headers.get("cache-control")).toBe("private, no-store");
    expect((await get("?file=draft.csv&season=2026")).headers.get("cache-control")).toBe("private, no-store");
  });

  it("never returns internal error detail (e.g. a database host) for an unexpected failure", async () => {
    await connected(3_600_000);
    wireYahoo();
    const spy = vi.spyOn(prisma.transaction, "findMany").mockRejectedValueOnce(new Error("Can't reach database server at secret-db-host:5432"));
    const res = await get("?file=report");
    spy.mockRestore();
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain("secret-db-host");
  });

  it("splits an oversized season's transactions into parts that together hold every transaction once", async () => {
    await connected(3_600_000);
    const pad = "x".repeat(1_500);
    const all = Array.from({ length: 3_200 }, (_, i) => ({ transaction: [{ transaction_key: `469.l.8891.tr.${i + 1}`, type: "commish", timestamp: "1760000000", note: pad }] }));
    fetchMock.mockImplementation(async (url: string) => {
      const path = new URL(url).pathname;
      if (path.endsWith("/settings")) return json(league({ settings: [{}] }));
      if (path.endsWith("/teams")) return json(league({ teams: { count: 0 } }));
      if (path.endsWith("/draftresults")) return json(league({ draft_results: { count: 0 } }));
      // Yahoo ignoring count: every page is the whole log.
      if (path.includes("/transactions")) return json(league({ transactions: { ...Object.fromEntries(all.map((t, i) => [String(i), t])), count: all.length } }));
      throw new Error(`unexpected ${path}`);
    });

    const first = await get("?file=transactions.csv&season=2026");
    expect(first.status).toBe(413);
    const { parts } = await first.json();
    expect(parts).toBeGreaterThan(1);

    const keys: string[] = [];
    for (let part = 1; part <= parts; part++) {
      const res = await get(`?file=transactions.csv&season=2026&part=${part}`);
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(Buffer.byteLength(text)).toBeLessThan(4_500_000);
      keys.push(...[...text.matchAll(/469\.l\.8891\.tr\.(\d+)/g)].map((m) => m[1]));
    }
    expect(keys).toHaveLength(3_200);
    expect(new Set(keys).size).toBe(3_200);
  }, 60_000);
});
