import { describe, it, expect } from "vitest";
import { buildLeagueHistory, MIN_EOY_ROWS_FOR_RECONCILE, type HistoryEvent } from "./league-history-builder";
import { FranchiseResolver } from "./team-aliases";
import type { AuctionRow, ManagerSeasonBlock, YahooTransaction, YahooTransactionPlayer } from "./league-history-types";
import type { ParsedTrade } from "./types";

// ---------------------------------------------------------------------------
// Fixture: two franchises (Alpha = "A", Bravo = "B"), 2021 through 2023.
// 2021-2022 have Yahoo + auction-file data; 2023 only has the workbook.
// ---------------------------------------------------------------------------

const resolver = new FranchiseResolver(
  [
    { managerSheetName: "A", seasonYear: 2021, teamName: "Alpha" },
    { managerSheetName: "B", seasonYear: 2021, teamName: "Bravo" },
  ],
  ["A", "B"]
);

function auction(seasonYear: number, playerName: string, teamName: string, salary: number, isKeeper: boolean, pick: number | null = null): AuctionRow {
  return { seasonLabel: String(seasonYear), seasonYear, pick, playerName, mlbTeam: null, positions: [], salary, teamName, isKeeper, sourceRef: `${seasonYear} ${playerName}`, flags: [] };
}

function yPlayer(id: string, name: string, action: YahooTransactionPlayer["action"], from: string | null, to: string | null, sourceType = "team"): YahooTransactionPlayer {
  return {
    yahooPlayerId: id,
    name,
    mlbTeam: "NYM",
    positions: ["OF"],
    action,
    sourceType: action === "add" ? sourceType : "team",
    sourceTeamName: from,
    destinationType: to ? "team" : "freeagents",
    destinationTeamName: to,
  };
}

function tx(seasonYear: number, key: string, type: YahooTransaction["type"], date: string, players: YahooTransactionPlayer[], faabBid: number | null = null): YahooTransaction {
  return { seasonYear, leagueKey: "k", transactionKey: key, type, status: "successful", timestamp: new Date(date), faabBid, traderTeamName: null, tradeeTeamName: null, players };
}

function block(managerSheetName: string, seasonYear: number, data: Partial<ManagerSeasonBlock>): ManagerSeasonBlock {
  return {
    managerSheetName,
    seasonYear,
    teamName: managerSheetName === "A" ? "Alpha" : "Bravo",
    finish: null,
    sourceLabel: "",
    keepers: [],
    keeperTotal: null,
    draft: [],
    eoyRoster: [],
    prospects: [],
    flags: [],
    ...data,
  };
}

const auctionRows: AuctionRow[] = [
  // 2021: one carried-over keeper, two auction buys
  auction(2021, "Old Keeper", "Alpha", 10, true),
  auction(2021, "Drafted Guy", "Alpha", 20, false, 1),
  auction(2021, "Other Guy", "Bravo", 5, false, 2),
  // 2022: keepers declared after the offseason trade below
  auction(2022, "Old Keeper", "Alpha", 13, true),
  auction(2022, "Waiver Guy", "Alpha", 4, true),
  auction(2022, "Other Guy", "Bravo", 6, true),
  auction(2022, "Drafted Guy", "Alpha", 15, false, 1),
];

const yahoo: YahooTransaction[] = [
  // first FAAB add of 2021 fixes the draft date at the day before
  tx(2021, "t1", "add", "2021-03-28T12:00:00Z", [yPlayer("y-waiver", "Waiver Guy", "add", null, "Alpha", "waivers")], 3),
  tx(2021, "t2", "drop", "2021-06-10T12:00:00Z", [yPlayer("y-drafted", "Drafted Guy", "drop", "Alpha", null)]),
  tx(2021, "t3", "trade", "2021-08-01T12:00:00Z", [yPlayer("y-other", "Other Guy", "trade", "Bravo", "Alpha")]),
  tx(2022, "t4", "add", "2022-04-02T12:00:00Z", [yPlayer("y-prospect", "Hot Prospect", "add", null, "Bravo", "waivers")], null),
];

const offseasonTrades: ParsedTrade[] = [
  {
    seasonYear: 2022,
    tradeDate: "2022-01-10T00:00:00.000Z",
    teamAName: "Alpha",
    teamAPlayersRaw: "Other Guy",
    teamADropsRaw: null,
    teamBName: "Bravo",
    teamBPlayersRaw: "None",
    teamBDropsRaw: null,
    sourceRef: "row 2",
    flags: [],
  },
];

const eoy2023 = [
  { name: "Old Keeper (NYM - OF)", cost: 18, nextSeasonCost: 25 },
  { name: "New Draft NYY - SP", cost: 30, nextSeasonCost: 31 },
  ...Array.from({ length: MIN_EOY_ROWS_FOR_RECONCILE - 2 }, (_, i) => ({ name: `Filler Player${i}`, cost: 2, nextSeasonCost: 3 })),
];

const blocks: ManagerSeasonBlock[] = [
  block("A", 2021, { keepers: [{ name: "O.Keeper", cost: 10 }], eoyRoster: [{ name: "O.Keeper", cost: 10, nextSeasonCost: 13 }, { name: "W.Guy", cost: 3, nextSeasonCost: 4 }, { name: "Other Guy", cost: 5, nextSeasonCost: 6 }] }),
  block("A", 2022, { keepers: [{ name: "Old Keeper", cost: 13 }, { name: "Waiver Guy", cost: 4 }] }),
  block("B", 2022, { keepers: [{ name: "Other Guy", cost: 7 }], prospects: [{ name: "Hot Prospect", mlbTeam: "Mets", position: "OF", draftAge: 19 }] }),
  block("A", 2023, { keepers: [{ name: "Old Keeper", cost: 18 }], draft: [{ name: "New Draft (NYY - SP)", cost: 30 }], eoyRoster: eoy2023 }),
  block("B", 2023, { keepers: [{ name: "Other Guy", cost: 9 }], draft: [], eoyRoster: [] }),
];

const preview = buildLeagueHistory({ blocks, auctionRows, yahoo, offseasonTrades, resolver, firstSeason: 2021, currentSeason: 2023 });
const eventsFor = (name: string): HistoryEvent[] => {
  const key = preview.players.find((p) => p.name === name)!.key;
  return preview.events.filter((e) => e.playerKey === key).sort((a, b) => a.season - b.season || a.date.localeCompare(b.date));
};

describe("buildLeagueHistory", () => {
  it("infers each season's draft date from the first FAAB add", () => {
    expect(preview.draftDates[2021]).toBe("2021-03-27T12:00:00.000Z");
    expect(preview.draftDates[2023]).toBe(new Date(Date.UTC(2023, 2, 20)).toISOString());
  });

  it("gives a first-season keeper a flagged pre-history origin so that season is keeper year 1", () => {
    const [origin] = eventsFor("Old Keeper");
    expect(origin).toMatchObject({ kind: "ACQUIRED", season: 2020, method: "DRAFT", cost: 9, franchise: "A" });
    expect(origin.flags[0]).toMatch(/Pre-2021 history/);
  });

  it("records auction buys, in-season drops and re-drafts as separate stints", () => {
    expect(eventsFor("Drafted Guy").map((e) => [e.season, e.kind, e.cost ?? null])).toEqual([
      [2021, "ACQUIRED", 20],
      [2021, "DROPPED", null],
      [2022, "ACQUIRED", 15],
      [2022, "DROPPED", null], // not kept into 2023
    ]);
    expect(preview.draftPicks.filter((d) => d.season === 2021).map((d) => [d.overallPick, d.franchise])).toEqual([
      [1, "A"],
      [2, "B"],
    ]);
  });

  it("uses the FAAB bid as the base cost of a waiver add", () => {
    expect(eventsFor("Waiver Guy")[0]).toMatchObject({ kind: "ACQUIRED", method: "WAIVER", cost: 3, franchise: "A", sourceRef: "yahoo:t1" });
  });

  it("applies Yahoo trades and the workbook's offseason trades as clock-preserving moves", () => {
    expect(eventsFor("Other Guy").map((e) => [e.season, e.kind, e.franchise, e.sourceRef])).toEqual([
      [2021, "ACQUIRED", "B", "auction:2021 Other Guy"],
      [2021, "TRADED", "A", "yahoo:t3"],
      [2022, "TRADED", "B", "offseason trades row 2"],
    ]);
  });

  it("tags a prospect-list player added for $0 as an FYPD call-up", () => {
    const [add] = eventsFor("Hot Prospect");
    expect(add).toMatchObject({ kind: "ACQUIRED", method: "FYPD", cost: 0, franchise: "B" });
    expect(preview.players.find((p) => p.name === "Hot Prospect")?.isFypdProspect).toBe(true);
  });

  it("releases players who weren't kept, charged to the season just finished", () => {
    const release = eventsFor("Hot Prospect").find((e) => e.kind === "DROPPED");
    expect(release).toMatchObject({ season: 2022, sourceRef: "not kept into 2023" });
  });

  it("falls back to the workbook for keepers and the auction when the other files have a gap", () => {
    expect(preview.flags).toContain("2023: keepers taken from the workbook (no keeper rows in the auction file).");
    expect(eventsFor("New Draft")[0]).toMatchObject({ season: 2023, method: "DRAFT", cost: 30, franchise: "A" });
    expect(eventsFor("Old Keeper").some((e) => e.season === 2023)).toBe(false); // continuity, no new event
  });

  it("reconstructs in-season moves from a complete EOY roster when no transaction export exists", () => {
    const filler = eventsFor("Filler Player0");
    expect(filler[0]).toMatchObject({ season: 2023, kind: "ACQUIRED", method: "WAIVER", cost: 2, franchise: "A" });
    expect(filler[0].flags[0]).toMatch(/end-of-year roster/);
    // Bravo's empty EOY list is too short to trust, so Other Guy is left alone.
    expect(eventsFor("Other Guy").some((e) => e.season === 2023 && e.kind === "DROPPED")).toBe(false);
    expect(preview.flags.some((f) => f.startsWith("2023: no transaction export"))).toBe(true);
  });

  it("compares the workbook's recorded keeper costs against the engine", () => {
    const byName = Object.fromEntries(preview.keeperChecks.map((c) => [`${c.season} ${c.franchise} ${c.rawName}`, c]));
    expect(byName["2021 A O.Keeper"]).toMatchObject({ status: "match", recordedCost: 10, computedCost: 10 });
    expect(byName["2022 A Old Keeper"]).toMatchObject({ status: "match", computedCost: 13 }); // 9 + 4
    expect(byName["2022 A Waiver Guy"]).toMatchObject({ status: "match", computedCost: 4 });
    expect(byName["2022 B Other Guy"]).toMatchObject({ status: "mismatch", recordedCost: 7, computedCost: 6 });
    expect(byName["2023 A Old Keeper"]).toMatchObject({ status: "match", computedCost: 18 }); // 9 + 9
    expect(preview.summary.keeperChecks).toEqual({ match: 5, mismatch: 1, unmatched: 0, "not-computed": 0 });
  });

  it("checks EOY costs and next-season projections, matching abbreviated names on the roster", () => {
    const eoy = preview.eoyChecks.filter((c) => c.season === 2021 && c.franchise === "A");
    expect(eoy.map((c) => [c.rawName, c.status, c.nextStatus])).toEqual([
      ["O.Keeper", "match", "match"],
      ["W.Guy", "match", "match"],
      ["Other Guy", "match", "match"],
    ]);
  });

  it("reports nothing unresolved for this fixture", () => {
    expect(preview.unresolvedTeams).toEqual([]);
    expect(preview.unmatchedPlayers).toEqual([]);
  });
});

describe("buildLeagueHistory - price and order provenance", () => {
  it("marks each acquisition's price as recorded, inferred, missing or set by rule - never a bare 0", () => {
    expect(eventsFor("Old Keeper")[0]).toMatchObject({ cost: 9, priceStatus: "inferred" }); // back-solved from the $10 keeper cost
    expect(eventsFor("Drafted Guy")[0]).toMatchObject({ cost: 20, priceStatus: "recorded" }); // auction file
    expect(eventsFor("Waiver Guy")[0]).toMatchObject({ cost: 3, priceStatus: "recorded" }); // FAAB bid
    expect(eventsFor("Hot Prospect")[0]).toMatchObject({ cost: 0, priceStatus: "rule" }); // FYPD call-up
    expect(eventsFor("Filler Player0")[0]).toMatchObject({ cost: 2, priceStatus: "recorded" }); // EOY sheet price
    expect(preview.events.filter((e) => e.kind === "ACQUIRED" && !e.priceStatus)).toEqual([]);
    expect(preview.events.filter((e) => e.kind !== "ACQUIRED" && e.priceStatus)).toEqual([]);
  });

  it("keeps a missing price missing: auction rows, workbook drafts and EOY rows with no cost", () => {
    const p = buildLeagueHistory({
      blocks: [
        block("A", 2021, {
          draft: [{ name: "No Price Draftee", cost: null }],
          eoyRoster: Array.from({ length: MIN_EOY_ROWS_FOR_RECONCILE }, (_, i) => ({ name: `Blank Cost${i}`, cost: null, nextSeasonCost: null })),
        }),
      ],
      auctionRows: [{ ...auction(2022, "No Salary Guy", "Alpha", 0, false, 1), salary: null }],
      yahoo: [],
      offseasonTrades: [],
      resolver,
      firstSeason: 2021,
      currentSeason: 2022,
    });
    const byName = (n: string) => p.events.find((e) => e.kind === "ACQUIRED" && p.players.find((x) => x.key === e.playerKey)?.name === n)!;
    expect(byName("No Price Draftee")).toMatchObject({ cost: 0, priceStatus: "missing" });
    expect(byName("No Salary Guy")).toMatchObject({ cost: 0, priceStatus: "missing" });
    expect(byName("Blank Cost0")).toMatchObject({ cost: 0, priceStatus: "missing" });
    expect(p.draftPicks.find((d) => d.season === 2021)).toMatchObject({ order: "sheet", cost: null });
    expect(p.draftPicks.find((d) => d.season === 2022)).toMatchObject({ order: "source", cost: null });
  });

  it("labels workbook draft numbering as sheet order and the auction file's pick column as the source's", () => {
    expect(preview.draftPicks.filter((d) => d.season <= 2022).every((d) => d.order === "source")).toBe(true);
    expect(preview.draftPicks.filter((d) => d.season === 2023).map((d) => d.order)).toEqual(["sheet"]);
  });

  it("does not reconstruct in-season moves from EOY rosters for a season the Yahoo sync records", () => {
    const synced = buildLeagueHistory({ blocks, auctionRows, yahoo, offseasonTrades, resolver, firstSeason: 2021, currentSeason: 2023, yahooSyncedSeasons: [2023] });
    expect(synced.events.some((e) => e.sourceRef.endsWith("/2023/eoy"))).toBe(false);
    expect(synced.flags.some((f) => f.startsWith("2023: in-season moves were not reconstructed"))).toBe(true);
    // Pre-season facts for that season are still imported.
    expect(synced.events.some((e) => e.season === 2023 && e.method === "DRAFT")).toBe(true);
  });
});

describe("auction rows that carry Yahoo's player id", () => {
  const run = (rows: AuctionRow[], txs: YahooTransaction[] = []) =>
    buildLeagueHistory({ blocks: [], auctionRows: rows, yahoo: txs, offseasonTrades: [], resolver, firstSeason: 2021, currentSeason: 2023 });

  it("keeps two players who share a name apart (2024's two Will Smiths) - one pick each", () => {
    const rows = [
      { ...auction(2021, "Will Smith", "Alpha", 21, false, 1), yahooPlayerId: "10642", positions: ["C"] },
      { ...auction(2021, "Will Smith", "Bravo", 1, false, 2), yahooPlayerId: "9999", positions: ["RP"] },
    ];
    const p = run(rows);
    const picks = p.draftPicks.filter((d) => d.season === 2021);
    expect(picks).toHaveLength(2);
    expect(new Set(picks.map((d) => d.playerKey)).size).toBe(2);
    expect(p.players.filter((x) => x.name === "Will Smith").map((x) => x.yahooPlayerId).sort()).toEqual(["10642", "9999"]);
  });

  it("is the same player as his Yahoo transactions, and a later keeper is found by id, not by name", () => {
    const rows = [
      { ...auction(2021, "Jarren Duran", "Alpha", 3, false, 1), yahooPlayerId: "10542" },
      { ...auction(2021, "Jhoan Duran", "Bravo", 12, false, 2), yahooPlayerId: "11495" },
      { ...auction(2022, "Jarren Duran", "Alpha", 6, true), yahooPlayerId: "10542" },
    ];
    const txs = [tx(2021, "t1", "add", "2021-04-02T12:00:00Z", [yPlayer("10542", "Jarren Duran", "add", null, "Alpha", "freeagents")], null)];
    const p = run(rows, txs);
    const jarren = p.players.find((x) => x.yahooPlayerId === "10542")!;
    expect(p.players.filter((x) => x.yahooPlayerId === "10542")).toHaveLength(1);
    expect(p.events.filter((e) => e.playerKey === jarren.key && e.kind === "ACQUIRED").map((e) => e.season)).toEqual([2021, 2021]);
    // Kept in 2022 from Alpha's own roster: no invented trade or acquisition
    // (his 2023 release, with no 2023 keepers in this fixture, is the only 2022 event).
    expect(p.events.filter((e) => e.playerKey === jarren.key && e.season === 2022).map((e) => e.kind)).toEqual(["DROPPED"]);
    expect(p.flags.join(" ")).not.toMatch(/Jarren Duran|Jhoan Duran/);
  });
});
