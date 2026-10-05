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
