import { describe, it, expect } from "vitest";
import { auctionHistoryWorkbook, generateAuctionHistory, parseYahooDraftCsv, type YahooDraftPick } from "./auction-from-yahoo";
import { buildResolver, loadWorkbook, readAuctionWorkbook } from "./league-history-sources";
import { draftCsv, type SeasonExport } from "../yahoo/history-export";
import type { ManagerSeasonBlock } from "./league-history-types";

const block = (managerSheetName: string, teamName: string, keepers: [string, number][], draft: [string, number][], seasonYear = 2024): ManagerSeasonBlock => ({
  managerSheetName,
  seasonYear,
  teamName,
  finish: null,
  sourceLabel: `${teamName} - ${seasonYear}`,
  keepers: keepers.map(([name, cost]) => ({ name, cost })),
  keeperTotal: null,
  draft: draft.map(([name, cost]) => ({ name, cost })),
  eoyRoster: [],
  prospects: [],
  flags: [],
});

let n = 0;
const pick = (teamName: string, playerName: string, cost: number, seasonYear = 2024): YahooDraftPick => ({
  seasonYear,
  pick: ++n,
  round: null,
  playerName,
  playerId: String(n),
  playerKey: `431.p.${n}`,
  mlbTeam: "DET",
  positions: ["2B"],
  cost,
  teamKey: null,
  teamName,
  line: n + 1,
});

function league() {
  n = 0;
  const blocks = [
    block("Andrew", "Lost and Confused", [["B.Harper", 41], ["C.Keith", 2]], [["Nolan Arenado", 27], ["Hunter Brown", 19]]),
    block("Scott", "Ranger Thingz", [["J.Soto", 60]], [["Wyatt Langford", 37]]),
  ];
  // Yahoo lists keepers among the picks, with no marker, in its own order.
  const picks = [
    pick("Lost and Confused", "Bryce Harper", 41),
    pick("Ranger Thingz", "Juan Soto", 60),
    pick("Lost and Confused", "Nolan Arenado", 27),
    pick("Ranger Thingz", "Wyatt Langford", 37),
    pick("Lost and Confused", "Colt Keith", 2),
    pick("Lost and Confused", "Hunter Brown", 19),
  ];
  return { blocks, picks, resolver: buildResolver(blocks) };
}

describe("generateAuctionHistory", () => {
  it("writes every Yahoo pick exactly once: keepers from the workbook's list, the rest as auction buys in Yahoo's order", () => {
    const { blocks, picks, resolver } = league();
    const g = generateAuctionHistory({ picks, blocks, resolver, seasons: [2024] });
    expect(g.ok).toBe(true);
    expect(g.keepers.map((k) => [k.player, k.salary, k.franchise])).toEqual([
      ["Bryce Harper", 41, "Andrew"],
      ["Colt Keith", 2, "Andrew"],
      ["Juan Soto", 60, "Scott"],
    ]);
    expect(g.auctions.map((a) => [a.pick, a.player, a.salary, a.yahooPick])).toEqual([
      [1, "Nolan Arenado", 27, 3],
      [2, "Wyatt Langford", 37, 4],
      [3, "Hunter Brown", 19, 6],
    ]);
    expect(g.seasons[0]).toMatchObject({ yahooPicks: 6, keepers: 3, auctionBuys: 3, workbookKeepers: 3, workbookAuctionRows: 3, reconciled: true, yahooTotalSalary: 186, keeperSalary: 103, auctionSalary: 83 });
    expect(g.issues).toEqual([]);
  });

  it("blocks a player the workbook lists as both keeper and auction buy when Yahoo has one pick - and says why", () => {
    const { blocks, picks, resolver } = league();
    blocks[0].draft.push({ name: "Colt Keith", cost: 2 }); // Andrew 2024, as in the master workbook
    const g = generateAuctionHistory({ picks, blocks, resolver, seasons: [2024] });
    expect(g.ok).toBe(false);
    expect(g.issues).toEqual([
      expect.objectContaining({
        severity: "blocking",
        kind: "keeper-and-auction",
        franchise: "Andrew",
        message: expect.stringMatching(/Yahoo has one 2024 pick for Colt Keith \(pick 5, \$2, Lost and Confused\).*keeper "C\.Keith" \(\$2\).*auction buy "Colt Keith" \(\$2\).*Needs the commissioner's decision/),
      }),
    ]);
    expect(g.seasons[0].reconciled).toBe(false);
    return expect(auctionHistoryWorkbook(g, [])).rejects.toThrow(/blocking/);
  });

  it("applies the commissioner's decision either way without double-counting", () => {
    const asKeeper = (() => {
      const { blocks, picks, resolver } = league();
      blocks[0].draft.push({ name: "Colt Keith", cost: 2 });
      return generateAuctionHistory({ picks, blocks, resolver, seasons: [2024], decisions: [{ season: 2024, franchise: "Andrew", player: "Colt Keith", was: "keeper", approvedBy: "test" }] });
    })();
    expect(asKeeper.ok).toBe(true);
    expect(asKeeper.keepers.filter((k) => k.player === "Colt Keith")).toHaveLength(1);
    expect(asKeeper.auctions.some((a) => a.player === "Colt Keith")).toBe(false);
    expect(asKeeper.seasons[0]).toMatchObject({ keepers: 3, auctionBuys: 3, approvedDuplicates: 1, reconciled: true });

    const asBuy = (() => {
      const { blocks, picks, resolver } = league();
      blocks[0].draft.push({ name: "Colt Keith", cost: 2 });
      return generateAuctionHistory({ picks, blocks, resolver, seasons: [2024], decisions: [{ season: 2024, franchise: "Andrew", player: "Colt Keith", was: "auction", approvedBy: "test" }] });
    })();
    expect(asBuy.ok).toBe(true);
    expect(asBuy.keepers.some((k) => k.player === "Colt Keith")).toBe(false);
    expect(asBuy.auctions.filter((a) => a.player === "Colt Keith")).toHaveLength(1);
    expect(asBuy.seasons[0]).toMatchObject({ keepers: 2, auctionBuys: 4, approvedDuplicates: 1, reconciled: true });
  });

  it("uses the workbook's keeper cost (overrides included) and Yahoo's auction price, reporting every difference", () => {
    const { blocks, picks, resolver } = league();
    blocks[0].keepers[0].cost = 38; // commissioner override on Harper
    blocks[1].draft[0].cost = 36; // workbook typo on Langford
    const g = generateAuctionHistory({ picks, blocks, resolver, seasons: [2024] });
    expect(g.ok).toBe(true);
    expect(g.keepers.find((k) => k.player === "Bryce Harper")).toMatchObject({ salary: 38, yahooSalary: 41 });
    expect(g.auctions.find((a) => a.player === "Wyatt Langford")).toMatchObject({ salary: 37 });
    expect(g.issues.map((i) => [i.kind, i.severity])).toEqual([
      ["keeper-cost-differs", "review"],
      ["auction-cost-differs", "review"],
    ]);
  });

  it("blocks a workbook keeper Yahoo has no pick for, and reports one-sided auction rows", () => {
    const { blocks, picks, resolver } = league();
    blocks[1].keepers.push({ name: "M.Trout", cost: 30 });
    blocks[1].draft.push({ name: "Ghost Player", cost: 4 });
    picks.push(pick("Ranger Thingz", "Kumar Rocker", 7));
    const g = generateAuctionHistory({ picks, blocks, resolver, seasons: [2024] });
    expect(g.ok).toBe(false);
    expect(g.issues.map((i) => i.kind).sort()).toEqual(["keeper-not-in-yahoo", "workbook-buy-not-in-yahoo", "yahoo-buy-not-in-workbook"]);
    expect(g.auctions.some((a) => a.player === "Kumar Rocker")).toBe(true);
    expect(g.auctions.some((a) => a.player === "Ghost Player")).toBe(false);
  });

  it("blocks unpriced picks, unknown teams and a missing season", () => {
    const { blocks, picks, resolver } = league();
    picks[2].cost = null;
    picks.push(pick("Nobody's Team", "Someone Else", 1));
    const g = generateAuctionHistory({ picks, blocks, resolver, seasons: [2024, 2025] });
    expect(g.issues.filter((i) => i.severity === "blocking").map((i) => i.kind).sort()).toEqual(["missing-season", "unpriced-pick", "unresolved-team"]);
  });
});

describe("the generated workbook", () => {
  it("reads back through the importer's own reader: keepers flagged, buys not, every row once", async () => {
    const { blocks, picks, resolver } = league();
    const g = generateAuctionHistory({ picks, blocks, resolver, seasons: [2024] });
    const rows = readAuctionWorkbook(await loadWorkbook(await auctionHistoryWorkbook(g, ["test provenance"])), 2021);
    expect(rows.filter((r) => r.isKeeper).map((r) => [r.seasonYear, r.playerName, r.salary, r.teamName])).toEqual([
      [2024, "Bryce Harper", 41, "Lost and Confused"],
      [2024, "Colt Keith", 2, "Lost and Confused"],
      [2024, "Juan Soto", 60, "Ranger Thingz"],
    ]);
    expect(rows.filter((r) => !r.isKeeper).map((r) => [r.pick, r.playerName, r.salary, r.positions])).toEqual([
      [1, "Nolan Arenado", 27, ["2B"]],
      [2, "Wyatt Langford", 37, ["2B"]],
      [3, "Hunter Brown", 19, ["2B"]],
    ]);
    expect(rows.every((r) => r.flags.length === 0)).toBe(true);
    // Yahoo's player id rides along, so the importer ties picks to Yahoo players, not names.
    expect(rows.map((r) => r.yahooPlayerId)).toEqual(["3", "4", "6", "1", "5", "2"]);
  });
});

describe("parseYahooDraftCsv", () => {
  it("reads the history export's draft CSV, undoing its formula guard", () => {
    const season = {
      seasonYear: 2024,
      leagueKey: "431.l.2411",
      teams: [{ teamKey: "431.l.2411.t.1", name: "=Lost and Confused", managers: [] }],
      draftResults: [{ pick: 1, round: 1, teamKey: "431.l.2411.t.1", playerKey: "431.p.1", cost: 41, player: { playerId: "1", name: "Bryce Harper", mlbTeam: "PHI", positions: ["1B", "DH"] } }],
    } as unknown as SeasonExport;
    const { picks, flags } = parseYahooDraftCsv(draftCsv(season));
    expect(flags).toEqual([]);
    expect(picks).toEqual([
      { seasonYear: 2024, pick: 1, round: 1, playerName: "Bryce Harper", playerId: "1", playerKey: "431.p.1", mlbTeam: "PHI", positions: ["1B", "DH"], cost: 41, teamKey: "431.l.2411.t.1", teamName: "=Lost and Confused", sourceKeeper: null, line: 2 },
    ]);
  });
});

describe("ambiguous workbook names", () => {
  it("tells two same-initial players on one team apart by price, and never calls different players a duplicate", () => {
    n = 0;
    const blocks = [block("Ed", "Seattle Pilots", [["A. Nola", 34]], [["A. Nola", 5], ["Jhoan Duran", 21]], 2021)];
    blocks[0].keepers.push({ name: "Jarren Duran", cost: 16 });
    const picks = [pick("Seattle Pilots", "Austin Nola", 5, 2021), pick("Seattle Pilots", "Aaron Nola", 34, 2021), pick("Seattle Pilots", "Jarren Duran", 16, 2021), pick("Seattle Pilots", "Jhoan Duran", 21, 2021)];
    const g = generateAuctionHistory({ picks, blocks, resolver: buildResolver(blocks), seasons: [2021] });
    expect(g.issues).toEqual([]);
    expect(g.keepers.map((k) => k.player).sort()).toEqual(["Aaron Nola", "Jarren Duran"]);
    expect(g.auctions.map((a) => a.player).sort()).toEqual(["Austin Nola", "Jhoan Duran"]);
  });
});

describe("Yahoo's truncated team names", () => {
  it("treats two truncations of one team name as the same team, but not two different teams", () => {
    n = 0;
    const blocks = [block("MattyJ", "Cron & Cronenworth LLP", [], [["Ann Alpha", 3], ["Bob Beta", 4]], 2023)];
    const picks = [pick("Cron & Cronenwort...", "Ann Alpha", 3, 2023), pick("Cron & Cronenworth...", "Bob Beta", 4, 2023)];
    expect(generateAuctionHistory({ picks, blocks, resolver: buildResolver(blocks), seasons: [2023] }).issues).toEqual([]);
  });
});

describe("real-data name differences (2021-2025 league auction file)", () => {
  it("matches a multi-word surname written as one word, and pairs same-price spelling differences", () => {
    n = 0;
    const blocks = [block("Jorge", "Pitches Be Trippin'", [["E.DeLaCruz", 6]], [["T.Stroy", 47]], 2024)];
    const picks = [pick("Pitches Be Trippin'", "Elly De La Cruz", 6, 2024), pick("Pitches Be Trippin'", "Trevor Story", 47, 2024)];
    const g = generateAuctionHistory({ picks, blocks, resolver: buildResolver(blocks), seasons: [2024] });
    expect(g.ok).toBe(true);
    expect(g.keepers.map((k) => k.player)).toEqual(["Elly De La Cruz"]);
    expect(g.issues).toEqual([expect.objectContaining({ kind: "name-differs", severity: "review", message: expect.stringMatching(/"T\.Stroy" and Yahoo pick 2 Trevor Story, both \$47/) })]);
  });

  it("cross-checks the source's own keeper flags when they're usable, and ignores all-or-nothing flags", () => {
    n = 0;
    const blocks = [block("Andrew", "Lost and Confused", [["C.Keith", 2]], [["Hunter Brown", 19]], 2024)];
    const flagged = (keeper: [boolean, boolean]) => [
      { ...pick("Lost and Confused", "Colt Keith", 2, 2024), sourceKeeper: keeper[0] },
      { ...pick("Lost and Confused", "Hunter Brown", 19, 2024), sourceKeeper: keeper[1] },
    ];
    const run = (k: [boolean, boolean]) => generateAuctionHistory({ picks: flagged(k), blocks, resolver: buildResolver(blocks), seasons: [2024] }).issues;
    n = 0;
    expect(run([true, false])).toEqual([]);
    n = 0;
    expect(run([false, true]).map((i) => i.kind)).toEqual(["keeper-flag-differs", "keeper-flag-differs"]);
    n = 0;
    expect(run([true, true])).toEqual([]); // every pick flagged: the flags say nothing
  });
});
