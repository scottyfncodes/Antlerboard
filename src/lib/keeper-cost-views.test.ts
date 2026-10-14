import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { prisma } from "./db";
import { AUCTION_BUDGET } from "./config";
import { makeLeagueWithSeason, makeManagerAndTeam, makePlayer, resetDatabase } from "./test-helpers";
import { loadDraftBoard, loadMarketRows, loadTeamRosterCosts, shapeAuctionPick } from "./keeper-cost-views";
import { costLabel, type CostValue } from "./player-costs";

// Integration tests against the test database for the dense views that show
// a keeper cost or an auction number: the team page, Players › Market, and
// the per-year draft board (plus the team page's Draft tab).

beforeEach(resetDatabase);
afterAll(resetDatabase);

const label = (v: CostValue | undefined) => (v ? costLabel(v) : "no keeper record");

/**
 * Team A's 2026 keepers, one per cost case:
 *  Recorded  - kept from a 2024 auction price on record      -> $14
 *  Guessed   - kept from a price the import back-solved       -> Unavailable
 *  Forced    - forced back to the auction (engine stores $0)  -> None
 *  Untraced  - no acquisition on record for the stint         -> Unavailable
 *  Free      - a real $0 waiver claim this season (year 0)    -> $0
 */
async function setup() {
  const { league, season: s2026 } = await makeLeagueWithSeason(2026);
  const s2024 = await prisma.season.create({ data: { leagueId: league.id, year: 2024, status: "COMPLETE" } });
  const a = (await makeManagerAndTeam(league.id, "Alpha")).team;
  const b = (await makeManagerAndTeam(league.id, "Bravo")).team;

  const keep = async (name: string, k: { keeperYear: number; keeperCost: number; status?: "KEPT" | "FORCED_BACK"; origin?: { seasonId: string; seasonYear: number; cost: number; price: string; method?: "DRAFT" | "WAIVER" } }) => {
    const p = await makePlayer(league.id, name);
    if (k.origin) {
      await prisma.acquisition.create({
        data: {
          seasonId: k.origin.seasonId,
          seasonYear: k.origin.seasonYear,
          playerId: p.id,
          teamId: a.id,
          method: k.origin.method ?? "DRAFT",
          cost: k.origin.cost,
          sourceRef: `league-history:x|price=${k.origin.price}`,
        },
      });
    }
    await prisma.keeperRecord.create({
      data: {
        seasonId: s2026.id,
        seasonYear: 2026,
        playerId: p.id,
        teamId: a.id,
        startTeamId: a.id,
        keeperYear: k.keeperYear,
        keeperCost: k.keeperCost,
        yearsRemaining: Math.max(0, 5 - k.keeperYear),
        status: k.status ?? "KEPT",
      },
    });
    return p;
  };

  const recorded = await keep("Recorded", { keeperYear: 2, keeperCost: 14, origin: { seasonId: s2024.id, seasonYear: 2024, cost: 10, price: "recorded" } });
  const guessed = await keep("Guessed", { keeperYear: 2, keeperCost: 19, origin: { seasonId: s2024.id, seasonYear: 2024, cost: 15, price: "inferred" } });
  const forced = await keep("Forced", { keeperYear: 6, keeperCost: 0, status: "FORCED_BACK" });
  const untraced = await keep("Untraced", { keeperYear: 1, keeperCost: 11 });
  const free = await keep("Free", { keeperYear: 0, keeperCost: 0, origin: { seasonId: s2026.id, seasonYear: 2026, cost: 0, price: "recorded", method: "WAIVER" } });
  return { league, s2024, s2026, a, b, players: { recorded, guessed, forced, untraced, free } };
}

describe("team page roster costs", () => {
  it("shows each keeper cost by the shared rules, never the raw stored number", async () => {
    const { a } = await setup();
    const { roster } = await loadTeamRosterCosts(a.id, 2026);
    const byName = Object.fromEntries(roster.rows.map((r) => [r.player.name, label(r.cost)]));
    expect(byName).toEqual({ Recorded: "$14", Guessed: "Unavailable", Forced: "None", Untraced: "Unavailable", Free: "$0" });
  });

  it("won't state a budget left while a declared keeper's cost is unconfirmed", async () => {
    const { a } = await setup();
    const { budget, declaredCount } = await loadTeamRosterCosts(a.id, 2026);
    // Declared slots are keeper year 1+: Recorded, Guessed, Forced, Untraced.
    expect(declaredCount).toBe(4);
    expect(budget).toEqual({ confirmedTotal: 14, unconfirmed: 2, budgetLeft: null });
  });

  it("states the budget left from confirmed costs once every cost is confirmed", async () => {
    const { a, players } = await setup();
    await prisma.keeperRecord.deleteMany({ where: { playerId: { in: [players.guessed.id, players.untraced.id] } } });
    const { budget } = await loadTeamRosterCosts(a.id, 2026);
    // Forced back costs nothing - it's None, not an unconfirmed cost.
    expect(budget).toEqual({ confirmedTotal: 14, unconfirmed: 0, budgetLeft: AUCTION_BUDGET - 14 });
  });

  it("on a Yahoo roster, shows a cost only where a keeper record exists", async () => {
    const { league, s2026, a, players } = await setup();
    const yahooOnly = await makePlayer(league.id, "Yahoo Only");
    for (const [i, p] of [players.recorded, players.forced, yahooOnly].entries()) {
      await prisma.rosterSpot.create({
        data: { seasonId: s2026.id, teamId: a.id, playerId: p.id, yahooPlayerKey: `469.p.${i}`, onTeamSince: new Date(), lastSeenAt: new Date() },
      });
    }
    const { roster } = await loadTeamRosterCosts(a.id, 2026);
    expect(roster.source).toBe("yahoo");
    expect(Object.fromEntries(roster.rows.map((r) => [r.player.name, label(r.cost)]))).toEqual({
      Recorded: "$14",
      Forced: "None",
      "Yahoo Only": "no keeper record",
    });
  });
});

describe("Players › Market", () => {
  it("shows each row's checked cost", async () => {
    await setup();
    const rows = await loadMarketRows({ seasonYear: 2026 });
    expect(rows.map((r) => [r.player.name, label(r.cost)])).toEqual([
      ["Forced", "None"],
      ["Free", "$0"],
      ["Guessed", "Unavailable"],
      ["Recorded", "$14"],
      ["Untraced", "Unavailable"],
    ]);
  });

  it("sorts by cost on confirmed amounts only - an unconfirmed $19 never outranks a real $14", async () => {
    await setup();
    const rows = await loadMarketRows({ seasonYear: 2026, sort: "cost" });
    expect(rows.map((r) => [r.player.name, label(r.cost)])).toEqual([
      ["Recorded", "$14"],
      ["Free", "$0"],
      ["Forced", "None"],
      ["Guessed", "Unavailable"],
      ["Untraced", "Unavailable"],
    ]);
  });

  it("keeps the existing filters", async () => {
    const { b } = await setup();
    expect((await loadMarketRows({ seasonYear: 2026, q: "rec" })).map((r) => r.player.name)).toEqual(["Recorded"]);
    expect(await loadMarketRows({ seasonYear: 2026, team: b.id })).toEqual([]);
  });
});

describe("draft board and team Draft tab numbers", () => {
  async function picks() {
    const { league, s2024, s2026, a } = await setup();
    const p = await makePlayer(league.id, "Auction Guy");
    const pick = (seasonId: string, seasonYear: number, overallPick: number, cost: number | null, sourceRef: string | null, isKeeperSlot = false) =>
      prisma.draftPick.create({ data: { seasonId, seasonYear, round: 1, pick: overallPick, overallPick, teamId: a.id, playerId: p.id, cost, sourceRef, isKeeperSlot } });
    // 2024: imported from the workbook, numbered by row.
    await pick(s2024.id, 2024, 1, 25, "league-history:auction:A!2|order=sheet");
    await pick(s2024.id, 2024, 2, 0, "league-history:auction:A!3|order=sheet");
    // 2026: mixed - a real nomination number, a row number, an unpriced pick, a keeper slot.
    await pick(s2026.id, 2026, 1, 30, "league-history:auction:B!2|order=source");
    await pick(s2026.id, 2026, 2, null, "league-history:auction:B!3|order=sheet");
    await pick(s2026.id, 2026, 3, 12, null, true);
  }

  it("labels workbook row numbers Row, and heads the column Row when all are", async () => {
    await picks();
    const board = await loadDraftBoard(2024);
    expect(board.header).toBe("Row");
    expect(board.inferredCount).toBe(2);
    expect(board.rows.map((r) => [r.number.text, costLabel(r.cost)])).toEqual([
      ["Row 1", "$25"],
      ["Row 2", "$0"],
    ]);
  });

  it("keeps real nominations as Nom., says which is which when mixed, and never shows a missing price as a number", async () => {
    await picks();
    const board = await loadDraftBoard(2026);
    expect(board.header).toBe("#");
    expect(board.rows.map((r) => [r.number.text, costLabel(r.cost), r.isKeeperSlot])).toEqual([
      ["Nom. 1", "$30", false],
      ["Row 2", "Unavailable", false],
      ["Nom. 3", "$12", true],
    ]);
  });

  it("the team Draft tab labels each pick the same way", () => {
    expect(shapeAuctionPick({ id: "x", overallPick: 37, sourceRef: "league-history:auction:A!38|order=sheet", cost: 4, isKeeperSlot: false })).toMatchObject({
      number: { text: "Row 37", inferred: true },
      cost: { status: "recorded", amount: 4 },
    });
  });
});
