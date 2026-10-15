import { describe, it, expect } from "vitest";
import { buildRecoveryReport, draftCsv, exportLeagueHistory, renewToLeagueKey, transactionsCsv, type SeasonExport, type YahooGet } from "./history-export";
import { parseYahooTransactionsCsv } from "../import/yahoo-transactions";
import { YahooApiError } from "./errors";

// A fake Yahoo serving the same JSON shapes the Fantasy API returns
// (league = [metadata, {sub-resource}], collections keyed "0".."n" + count).

interface FakeSeason {
  key: string;
  season: number;
  renew: string;
  draft: { pick: number; player: string; cost?: number }[];
  transactions: number;
}

const CHAIN: FakeSeason[] = [
  { key: "469.l.8891", season: 2026, renew: "458_100", draft: [], transactions: 3 },
  { key: "458.l.100", season: 2025, renew: "431_90", draft: [{ pick: 1, player: "458.p.1", cost: 45 }, { pick: 2, player: "458.p.2", cost: 0 }], transactions: 60 },
  { key: "431.l.90", season: 2024, renew: "422_80", draft: [{ pick: 1, player: "431.p.3", cost: 30 }, { pick: 2, player: "431.p.4" }], transactions: 5 },
  { key: "422.l.80", season: 2023, renew: "412_70", draft: [], transactions: 4 },
  { key: "412.l.70", season: 2022, renew: "404_60", draft: [{ pick: 1, player: "412.p.5", cost: 12 }], transactions: 2 },
  { key: "404.l.60", season: 2021, renew: "398_50", draft: [{ pick: 1, player: "404.p.6", cost: 9 }], transactions: 1 },
];

const list = (items: unknown[]) => ({ ...Object.fromEntries(items.map((v, i) => [String(i), v])), count: items.length });

function tx(s: FakeSeason, n: number) {
  const meta = { transaction_key: `${s.key}.tr.${n}`, transaction_id: String(n), type: n % 3 === 0 ? "commish" : "add", status: "successful", timestamp: String(1_700_000_000 + n * 60), ...(n % 2 ? { faab_bid: "7" } : {}) };
  if (meta.type === "commish") return [meta];
  return [
    meta,
    {
      players: list([
        { player: [[{ player_key: `${s.key.split(".")[0]}.p.${900 + n}` }, { player_id: String(900 + n) }, { name: { full: `Player ${n}` } }, { editorial_team_abbr: "SEA" }, { display_position: "SS" }], { transaction_data: [{ type: "add", source_type: "waivers", destination_type: "team", destination_team_name: "Alpha" }] }] },
      ]),
    },
  ];
}

function fakeYahoo(opts: { pageMode?: "honor" | "ignore" | "cap10"; refuse?: string[] } = {}) {
  const calls: string[] = [];
  const get: YahooGet = async (path) => {
    calls.push(path);
    const key = path.split("/")[2].split(";")[0];
    if (opts.refuse?.includes(key)) throw new YahooApiError(403, path, "You are not allowed to view this page");
    const s = CHAIN.find((c) => c.key === key);
    if (!s) throw new YahooApiError(404, path, "League not found");
    const meta = { league_key: s.key, name: "Claw & Antler League", season: String(s.season), renew: s.renew, num_teams: 12, draft_status: "postdraft" };
    const league = (sub: object) => ({ fantasy_content: { league: [meta, sub] } });

    if (path.endsWith("/settings")) return league({ settings: [{ draft_type: "live", is_auction_draft: "1", uses_faab: "1" }] });
    if (path.endsWith("/teams")) {
      return league({
        teams: list([{ team: [[{ team_key: `${s.key}.t.1` }, { name: "Alpha" }, { managers: [{ manager: { manager_id: "1", nickname: "Scott", guid: "SECRETGUID", email: "someone@example.com", is_commissioner: "1" } }] }]] }]),
      });
    }
    if (path.endsWith("/draftresults")) {
      return league({ draft_results: list(s.draft.map((d) => ({ draft_result: { pick: d.pick, round: 1, team_key: `${s.key}.t.1`, player_key: d.player, ...(d.cost !== undefined ? { cost: String(d.cost) } : {}) } }))) });
    }
    if (path.includes("/players;player_keys=")) {
      const keys = path.split("player_keys=")[1].split(",");
      return league({ players: list(keys.map((k) => ({ player: [[{ player_key: k }, { player_id: k.split(".p.")[1] }, { name: { full: `Name ${k}` } }, { editorial_team_abbr: "NYY" }, { display_position: "OF,DH" }]] }))) });
    }
    if (path.includes("/transactions")) {
      const all = Array.from({ length: s.transactions }, (_, i) => tx(s, i + 1));
      const start = Number(path.match(/start=(\d+)/)![1]);
      const count = Number(path.match(/count=(\d+)/)![1]);
      const size = opts.pageMode === "ignore" ? all.length : opts.pageMode === "cap10" ? 10 : count;
      const page = opts.pageMode === "ignore" ? all : all.slice(start, start + size);
      return league({ transactions: list(page.map((t) => ({ transaction: t }))) });
    }
    throw new Error(`unexpected path ${path}`);
  };
  return { get, calls };
}

const opts = { firstSeasonYear: 2021, delayMs: 0 };

describe("renewToLeagueKey", () => {
  it("turns Yahoo's renew link into the previous season's league key", () => {
    expect(renewToLeagueKey("458_100")).toBe("458.l.100");
    expect(renewToLeagueKey("")).toBeNull();
    expect(renewToLeagueKey(null)).toBeNull();
  });
});

describe("exportLeagueHistory", () => {
  it("walks the renew chain back to the first season and stops there, noting the older league", async () => {
    const { get } = fakeYahoo();
    const h = await exportLeagueHistory(get, "469.l.8891", opts);
    expect(h.seasons.map((s) => s.seasonYear)).toEqual([2026, 2025, 2024, 2023, 2022, 2021]);
    expect(h.discovery.olderLeagueKey).toBe("398.l.50");
    expect(h.seasons.every((s) => s.errors.length === 0)).toBe(true);
  });

  it("stops at a season Yahoo refuses and reports it, without guessing older ones", async () => {
    const { get } = fakeYahoo({ refuse: ["422.l.80"] });
    const h = await exportLeagueHistory(get, "469.l.8891", opts);
    expect(h.seasons.map((s) => s.leagueKey)).toEqual(["469.l.8891", "458.l.100", "431.l.90", "422.l.80"]);
    expect(h.seasons[3].errors[0]).toMatchObject({ section: "settings" });
    expect(h.discovery.stoppedBecause).toMatch(/Yahoo refused 422\.l\.80/);
  });

  it.each(["honor", "ignore", "cap10"] as const)("reads every transaction exactly once when Yahoo %s the page size", async (pageMode) => {
    const { get } = fakeYahoo({ pageMode });
    const h = await exportLeagueHistory(get, "469.l.8891", opts);
    const s2025 = h.seasons.find((s) => s.seasonYear === 2025)!;
    expect(s2025.transactionsRaw).toHaveLength(60);
    expect(new Set(s2025.transactionsRaw.map((t) => (t[0] as { transaction_key: string }).transaction_key)).size).toBe(60);
  });

  it("keeps a missing auction price as null, never as 0, and keeps a real $0", async () => {
    const { get } = fakeYahoo();
    const h = await exportLeagueHistory(get, "469.l.8891", opts);
    const s2024 = h.seasons.find((s) => s.seasonYear === 2024)!;
    expect(s2024.draftResults.map((d) => d.cost)).toEqual([30, null]);
    expect(h.seasons.find((s) => s.seasonYear === 2025)!.draftResults.map((d) => d.cost)).toEqual([45, 0]);
  });

  it("resolves draft players in batches and keeps their Yahoo keys and ids", async () => {
    const { get, calls } = fakeYahoo();
    const h = await exportLeagueHistory(get, "469.l.8891", opts);
    const pick = h.seasons.find((s) => s.seasonYear === 2025)!.draftResults[0];
    expect(pick).toMatchObject({ playerKey: "458.p.1", player: { playerId: "1", name: "Name 458.p.1", mlbTeam: "NYY", positions: ["OF", "DH"] } });
    expect(calls.filter((c) => c.includes("player_keys")).length).toBe(4); // one per season with picks (2025, 2024, 2022, 2021)
  });

  it("drops manager emails and guids", async () => {
    const { get } = fakeYahoo();
    const h = await exportLeagueHistory(get, "469.l.8891", opts);
    expect(h.seasons[0].teams[0].managers).toEqual([{ managerId: "1", nickname: "Scott", isCommissioner: true }]);
    expect(JSON.stringify(h)).not.toMatch(/SECRETGUID|example\.com/);
  });

  it("with onlySeason, reads just the settings of the seasons on the way", async () => {
    const { get, calls } = fakeYahoo();
    const h = await exportLeagueHistory(get, "469.l.8891", { ...opts, onlySeason: 2024 });
    expect(h.seasons.map((s) => s.seasonYear)).toEqual([2024]);
    expect(calls.filter((c) => !c.includes("431.l.90"))).toEqual(["/league/469.l.8891/settings", "/league/458.l.100/settings"]);
  });

  it("aborts on a fatal error instead of reporting accessible seasons as refused", async () => {
    const tokenGone = new Error("token expired");
    const get: YahooGet = async () => {
      throw tokenGone;
    };
    await expect(exportLeagueHistory(get, "469.l.8891", { ...opts, isFatal: (e) => e === tokenGone })).rejects.toBe(tokenGone);
  });

  it("only ever issues GETs through the injected reader, pausing between them", async () => {
    const { get } = fakeYahoo();
    const sleeps: number[] = [];
    await exportLeagueHistory(get, "469.l.8891", { firstSeasonYear: 2026, delayMs: 50, sleep: async (ms) => void sleeps.push(ms) });
    expect(sleeps.length).toBeGreaterThan(0);
    expect(sleeps.every((ms) => ms === 50)).toBe(true);
  });
});

describe("export files", () => {
  it("writes transactions in the league-history import's format, which its parser reads back intact", async () => {
    const { get } = fakeYahoo();
    const h = await exportLeagueHistory(get, "469.l.8891", opts);
    const s2025 = h.seasons.find((s) => s.seasonYear === 2025)!;
    const parsed = parseYahooTransactionsCsv(transactionsCsv([s2025]));
    expect(parsed.flags).toEqual([]);
    expect(parsed.transactions).toHaveLength(60);
    const t1 = parsed.transactions.find((t) => t.transactionKey === "458.l.100.tr.1")!;
    expect(t1).toMatchObject({ seasonYear: 2025, leagueKey: "458.l.100", type: "add", faabBid: 7 });
    expect(t1.players[0]).toMatchObject({ yahooPlayerId: "901", name: "Player 1", destinationTeamName: "Alpha" });
    expect(parsed.transactions.find((t) => t.transactionKey === "458.l.100.tr.3")!.type).toBe("commish");
  });

  it("writes draft results with names, prices (blank when Yahoo has none) and team names", async () => {
    const { get } = fakeYahoo();
    const h = await exportLeagueHistory(get, "469.l.8891", opts);
    const lines = draftCsv(h.seasons.find((s) => s.seasonYear === 2024)!).trim().split("\n");
    expect(lines[0]).toBe("Season,Pick,Round,Player,Player_ID,Player_Key,MLB_Team,Positions,Salary,Team_Key,Fantasy_Team");
    expect(lines[1]).toBe("2024,1,1,Name 431.p.3,3,431.p.3,NYY,OF/DH,30,431.l.90.t.1,Alpha");
    expect(lines[2]).toBe("2024,2,1,Name 431.p.4,4,431.p.4,NYY,OF/DH,,431.l.90.t.1,Alpha");
  });
});

describe("buildRecoveryReport", () => {
  it("separates recovered data, inaccessible seasons and what still needs the original files", async () => {
    const { get } = fakeYahoo({ refuse: ["412.l.70"] });
    const h = await exportLeagueHistory(get, "469.l.8891", opts);
    const r = buildRecoveryReport(h, []);
    expect(r.recovered).toContain("2025 (458.l.100): 2 auction picks, all priced, in Yahoo's recorded order.");
    expect(r.recovered).toContain("2025 (458.l.100): 60 transactions (all types, timestamps, players, teams, FAAB bids where charged).");
    expect(r.requiresOriginalFiles).toContain("2024 (431.l.90): 1 draft picks have no price in Yahoo - auction history file for those.");
    expect(r.requiresOriginalFiles).toContain("2023 (422.l.80): Yahoo has no draft results for this season (auction held or recorded outside Yahoo) - auction history file.");
    // A refused league's season can't be read, so it isn't guessed either.
    expect(r.inaccessible.join(" ")).toMatch(/\? \(412\.l\.70\): Yahoo refused the league/);
    expect(r.requiresOriginalFiles.join(" ")).toMatch(/412\.l\.70\): auction results and transactions/);
    expect(r.requiresOriginalFiles.join(" ")).toMatch(/keeper costs and commissioner overrides/);
    const s2025 = r.seasons.find((s) => s.seasonYear === 2025)!;
    expect(s2025.transactions).toMatchObject({ count: 60, byType: { add: 40, commish: 20 }, withFaabBid: 30 });
  });

  it("compares Yahoo's transaction keys with the ones Antlerboard already stores", async () => {
    const { get } = fakeYahoo();
    const h = await exportLeagueHistory(get, "469.l.8891", { firstSeasonYear: 2026, delayMs: 0 });
    const r = buildRecoveryReport(h, [{ leagueKey: "469.l.8891", seasonYear: 2026, storedTransactionKeys: ["469.l.8891.tr.1", "469.l.8891.tr.2", "469.l.8891.tr.99"] }]);
    expect(r.seasons[0].antlerboard).toEqual({ storedTransactions: 3, matchedByKey: 2, onlyInYahoo: 1, onlyInAntlerboard: 1 });
  });
});

describe("time budget", () => {
  it("stops starting requests at the deadline and reports the unread season as not checked - never refused or missing", async () => {
    const { get, calls } = fakeYahoo();
    let clock = 0;
    // Each request advances the clock; the budget runs out partway through 2024.
    const h = await exportLeagueHistory(
      async (p) => {
        clock += 1;
        return get(p);
      },
      "469.l.8891",
      { ...opts, deadline: 14, now: () => clock }
    );
    const last = h.seasons[h.seasons.length - 1];
    expect(last.incomplete).toBe(true);
    expect(h.discovery.stoppedBecause).toMatch(/time budget ran out while reading/);
    expect(calls.length).toBe(14);

    const r = buildRecoveryReport(h, []);
    const label = `${last.seasonYear ?? "?"} (${last.leagueKey})`;
    expect(r.notChecked.join(" ")).toContain(label);
    expect([...r.inaccessible, ...r.requiresOriginalFiles, ...r.recovered].join(" ")).not.toContain(label);
    expect(r.seasons.find((s) => s.leagueKey === last.leagueKey)!.incomplete).toBe(true);
  });
});

describe("draft CSV safety", () => {
  it("neutralizes spreadsheet formulas in user-chosen names, leaving prices and keys alone", () => {
    const season: SeasonExport = {
      seasonYear: 2024,
      leagueKey: "431.l.90",
      leagueName: null,
      renew: null,
      settings: { draftType: null, isAuctionDraft: true, usesFaab: true, draftStatus: null, numTeams: 12 },
      teams: [{ teamKey: "431.l.90.t.1", name: "=HYPERLINK(\"http://x\")", managers: [] }],
      draftResults: [{ pick: 1, round: 1, teamKey: "431.l.90.t.1", playerKey: "431.p.3", cost: 30, player: { playerId: "3", name: "@Player", mlbTeam: "NYY", positions: [] } }],
      transactionsRaw: [],
      transactionPages: 0,
      errors: [],
      incomplete: false,
    };
    const row = draftCsv(season).trim().split("\n")[1];
    expect(row).toContain("'@Player");
    expect(row).toContain(`"'=HYPERLINK(""http://x"")"`);
    expect(row).toContain(",30,");
  });
});
