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
// Skip the real pauses: the route's pacing, the client's 1-3 s retries and the export's 20-45 s throttle waits.
const realSetTimeout = globalThis.setTimeout;
beforeEach(() => {
  vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms?: number) => realSetTimeout(fn, (ms ?? 0) >= 100 ? 0 : ms)) as typeof setTimeout);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.mocked(globalThis.setTimeout).mockRestore();
});
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
    // The connected season's log is the daily sync's: counted from Antlerboard, not re-read from Yahoo.
    expect(report.seasons[0]).toMatchObject({ seasonYear: 2026, draft: { picks: 1, pricedPicks: 1 }, transactions: { count: 0, complete: false, skipped: expect.stringMatching(/daily Yahoo sync/) } });
    expect(report.recovered).toContain("2026 (469.l.8891): transactions not re-read - Antlerboard's daily Yahoo sync keeps this season's log (1 stored).");
    expect(report.notChecked).toEqual([]);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/transactions"))).toBe(false);
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
    expect((await get("?file=report&season=abc")).status).toBe(400);
    const one = await (await get("?file=report&season=2026")).json();
    expect(one.seasons.map((x: { seasonYear: number }) => x.seasonYear)).toEqual([2026]);
    expect(one.discovery.stoppedBecause).toBe("Read season 2026 only.");
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

  it("never downloads a partial season: throttled mid-log gives 503 and no file", async () => {
    await connected(3_600_000);
    const page = (n: number) => ({ transaction: [{ transaction_key: `469.l.8891.tr.${n}`, type: "commish", timestamp: "1760000000" }] });
    fetchMock.mockImplementation(async (url: string) => {
      const path = new URL(url).pathname;
      if (path.endsWith("/settings")) return json(league({ settings: [{}] }));
      if (path.endsWith("/teams")) return json(league({ teams: { count: 0 } }));
      if (path.endsWith("/draftresults")) return json(league({ draft_results: { count: 0 } }));
      if (path.includes("start=0")) return json(league({ transactions: { ...Object.fromEntries(Array.from({ length: 25 }, (_, i) => [String(i), page(i + 1)])), count: 25 } }));
      // Every later page: Yahoo's rate limit, past the client's retries.
      return { ok: false, status: 999, statusText: "Request denied", headers: new Headers(), text: async () => "Request denied", json: async () => ({}) };
    });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await get("?file=transactions.csv&season=2026");
    spy.mockRestore();
    // Asked again after each throttle wait before giving up.
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes("start=25")).length).toBe(9);
    expect(res.status).toBe(503);
    expect(res.headers.get("content-disposition")).toBeNull();
    expect((await res.json()).error).toMatch(/couldn't be read completely/);
  }, 30_000);
});

describe("season=all: every season before the connected one, in one download", () => {
  // 2026 (connected) renews 2025 ... back to 2021, which links an older 2020 league.
  const KEYS: Record<number, string> = { 2026: "469.l.8891", 2025: "458.l.2049", 2024: "431.l.2411", 2023: "422.l.1954", 2022: "412.l.2989", 2021: "404.l.3033", 2020: "398.l.6179" };
  const yearOf = (key: string) => Number(Object.entries(KEYS).find(([, k]) => k === key)![0]);
  const prev = (y: number) => KEYS[y - 1].replace(".l.", "_");

  function wireChain(opts: { throttle?: (path: string) => boolean } = {}) {
    const calls: string[] = [];
    fetchMock.mockImplementation(async (url: string) => {
      const path = new URL(url).pathname.replace("/fantasy/v2", "");
      calls.push(path);
      if (opts.throttle?.(path)) return { ok: false, status: 999, statusText: "Request denied", headers: new Headers(), text: async () => "Request denied", json: async () => ({}) };
      const key = path.split("/")[2].split(";")[0];
      const y = yearOf(key);
      const lg = (sub: object) => json({ fantasy_content: { league: [{ league_key: key, name: "Claw & Antler League", season: String(y), renew: prev(y), num_teams: 12 }, sub] } });
      if (path.endsWith("/settings")) return lg({ settings: [{ is_auction_draft: "1", uses_faab: "1" }] });
      if (path.endsWith("/teams")) return lg({ teams: { "0": { team: [[{ team_key: `${key}.t.1` }, { name: `Team ${y}` }]] }, count: 1 } });
      if (path.endsWith("/draftresults")) return lg({ draft_results: { "0": { draft_result: { pick: 1, round: 1, team_key: `${key}.t.1`, player_key: `${key.split(".")[0]}.p.7`, cost: String(y - 2000) } }, count: 1 } });
      if (path.includes("/players;player_keys=")) return lg({ players: { "0": { player: [[{ player_key: `${key.split(".")[0]}.p.7` }, { player_id: "7" }, { name: { full: "Aaron Judge" } }, { editorial_team_abbr: "NYY" }, { display_position: "OF" }]] }, count: 1 } });
      if (path.includes("/transactions")) {
        const start = Number(path.match(/start=(\d+)/)![1]);
        const tx = { transaction: [{ transaction_key: `${key}.tr.1`, type: "add", status: "successful", timestamp: "1700000000" }, { players: { "0": { player: [[{ player_key: "p" }, { player_id: "7" }, { name: { full: "Aaron Judge" } }], { transaction_data: [{ type: "add", source_type: "freeagents", destination_type: "team", destination_team_name: `Team ${y}` }] }] }, count: 1 } }] };
        return lg({ transactions: start === 0 ? { "0": tx, count: 1 } : { count: 0 } });
      }
      throw new Error(`unexpected ${path}`);
    });
    return calls;
  }

  it("draft.csv: 2021-2025 in one CSV, oldest first, one header - the connected season only passed through", async () => {
    await connected(3_600_000);
    const calls = wireChain();
    const res = await get("?file=draft.csv&season=all");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toContain("antlerboard-yahoo-2021-2025-draft.csv");
    const lines = (await res.text()).trim().split("\n");
    expect(lines[0]).toMatch(/^Season,Pick/);
    expect(lines.slice(1).map((l) => l.split(",")[0])).toEqual(["2021", "2022", "2023", "2024", "2025"]);
    expect(lines.filter((l) => l.startsWith("Season,"))).toHaveLength(1);
    expect(calls.filter((c) => c.startsWith("/league/469.l.8891/"))).toEqual(["/league/469.l.8891/settings"]);
    expect(calls.some((c) => c.includes("/transactions"))).toBe(false);
    expect(calls.some((c) => c.startsWith("/league/398.l.6179"))).toBe(false);
  });

  it("transactions.csv: 2021-2025 gzipped, exactly the import's file - and the importer reads it", async () => {
    await connected(3_600_000);
    const calls = wireChain();
    const res = await get("?file=transactions.csv&season=all");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/gzip");
    expect(res.headers.get("content-disposition")).toContain("antlerboard-yahoo-2021-2025-transactions.csv.gz");
    const { yahooCsvText, readYahooExport } = await import("@/lib/import/league-history-sources");
    const parsed = readYahooExport(yahooCsvText(Buffer.from(await res.arrayBuffer())));
    expect(parsed.flags).toEqual([]);
    expect(parsed.transactions.map((t) => [t.seasonYear, t.transactionKey])).toEqual([2021, 2022, 2023, 2024, 2025].map((y) => [y, `${KEYS[y]}.tr.1`]));
    expect(calls.some((c) => c.startsWith("/league/469.l.8891/transactions"))).toBe(false);
    expect(calls.some((c) => c.includes("/players;player_keys="))).toBe(false);
  });

  it("all or nothing: a season Yahoo won't finish gives 503 and no file", async () => {
    await connected(3_600_000);
    wireChain({ throttle: (p) => p.startsWith("/league/422.l.1954/transactions") });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await get("?file=transactions.csv&season=all");
    spy.mockRestore();
    expect(res.status).toBe(503);
    expect(res.headers.get("content-disposition")).toBeNull();
    const body = await res.json();
    expect(body.error).toMatch(/Nothing was downloaded/);
    expect(body.seasons.find((s: { seasonYear: number }) => s.seasonYear === 2023)).toMatchObject({ incomplete: true });
  });

  it("is only for the two downloads", async () => {
    await connected(3_600_000);
    expect((await get("?file=report&season=all")).status).toBe(400);
    expect((await get("?file=season.json&season=all")).status).toBe(400);
  });
});
