import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { prisma } from "../db";
import { makeLeagueWithSeason, makeManagerAndTeam, resetDatabase } from "../test-helpers";
import { commitLeagueHistory, LeagueHistoryConflictError, SOURCE_PREFIX } from "./league-history-commit";
import { readProvenance } from "./provenance";
import type { HistoryEvent, LeagueHistoryPreview } from "./league-history-builder";

// Regression tests for the League History import audit: Yahoo identity,
// same-name players, overlap with Yahoo-synced transactions, provenance,
// repeat runs and rollback. Every scenario runs the real commit (and, for
// identity, the real Yahoo sync) against the test database.

vi.mock("../yahoo/client", () => ({ yahooFantasyGet: vi.fn() }));
import { yahooFantasyGet } from "../yahoo/client";
import { runYahooSync } from "../yahoo/sync";
const mockedGet = vi.mocked(yahooFantasyGet);

beforeEach(async () => {
  await resetDatabase();
  mockedGet.mockReset();
});
afterAll(resetDatabase);

const LEAGUE_KEY = "469.l.8891";

/** League with one Yahoo-linked team ("Alex", 469.l.8891.t.1), like production. */
async function setup() {
  const { league, season } = await makeLeagueWithSeason(2026);
  const { team } = await makeManagerAndTeam(league.id, "Alex", true);
  await prisma.team.update({ where: { id: team.id }, data: { yahooTeamId: `${LEAGUE_KEY}.t.1` } });
  await prisma.yahooConnection.create({ data: { leagueId: league.id, accessToken: "fake", yahooLeagueKey: LEAGUE_KEY, yahooGameKey: "469" } });
  return { league, season, team };
}

/** Yahoo responses for a sync where team t.1's roster is `players`. */
function wireYahoo(players: { key: string; full: string; positions?: string[] }[]) {
  mockedGet.mockImplementation(async (_l: string, path: string) => {
    if (path.includes("/standings")) {
      return {
        fantasy_content: {
          league: [
            { league_key: LEAGUE_KEY, name: "C&A", season: "2026" },
            {
              standings: [
                {
                  teams: {
                    "0": {
                      team: [
                        [{ team_key: `${LEAGUE_KEY}.t.1` }, { team_id: "1" }, { name: "Alex's Team" }],
                        { team_points: { total: "0" } },
                        { team_standings: { rank: "1", outcome_totals: { wins: "1", losses: "0", ties: "0" } } },
                      ],
                    },
                    count: 1,
                  },
                },
              ],
            },
          ],
        },
      };
    }
    if (path.includes("/transactions")) return { fantasy_content: { league: [{ league_key: LEAGUE_KEY, season: "2026" }, { transactions: { count: 0 } }] } };
    if (path.includes("/roster")) {
      return {
        fantasy_content: {
          team: [
            [{ team_key: `${LEAGUE_KEY}.t.1` }],
            {
              roster: {
                "0": {
                  players: {
                    ...Object.fromEntries(
                      players.map((p, i) => [
                        String(i),
                        {
                          player: [
                            [
                              { player_key: p.key },
                              { name: { full: p.full } },
                              { editorial_team_abbr: "NYY" },
                              { eligible_positions: { "0": { position: (p.positions ?? ["OF"])[0] }, count: 1 } },
                            ],
                            { selected_position: [{ position: (p.positions ?? ["OF"])[0] }] },
                          ],
                        },
                      ])
                    ),
                    count: players.length,
                  },
                },
              },
            },
          ],
        },
      };
    }
    throw new Error(`Unexpected path ${path}`);
  });
}

function preview(o: Partial<LeagueHistoryPreview> = {}): LeagueHistoryPreview {
  return {
    players: [],
    events: [],
    draftPicks: [],
    keeperChecks: [],
    eoyChecks: [],
    unresolvedTeams: [],
    unmatchedPlayers: [],
    draftDates: {},
    summary: {
      players: 0,
      events: 0,
      flaggedEvents: 0,
      draftPicks: 0,
      seasons: [],
      keeperChecks: { match: 0, mismatch: 0, unmatched: 0, "not-computed": 0 },
      eoyCostChecks: { match: 0, mismatch: 0, unmatched: 0, "not-computed": 0 },
      eoyProjectionChecks: { match: 0, mismatch: 0, unmatched: 0, "not-computed": 0 },
      unresolvedTeamNames: 0,
      unmatchedPlayerNames: 0,
    },
    flags: [],
    ...o,
  };
}

const commit = (leagueId: string, p: LeagueHistoryPreview, applyRecordedKeeperCosts = true) =>
  prisma.$transaction((tx) => commitLeagueHistory(tx, leagueId, p, { currentSeason: 2026, applyRecordedKeeperCosts, actorName: "test" }));

const acquired = (playerKey: string, season: number, cost: number, o: Partial<HistoryEvent> = {}): HistoryEvent => ({
  playerKey,
  kind: "ACQUIRED",
  season,
  date: `${season}-04-10T00:00:00.000Z`,
  franchise: "Alex",
  method: "WAIVER",
  cost,
  priceStatus: "recorded",
  sourceRef: `yahoo:458.l.1.tr.${playerKey}${season}`,
  flags: [],
  ...o,
});

const judge = { key: "9999", yahooPlayerId: "9999", name: "Aaron Judge", mlbTeam: "NYY", positions: ["OF"], isFypdProspect: false, flags: [] };

describe("Yahoo identity: the audit's failure (bare id vs 469.p.N)", () => {
  async function rosteredJudge() {
    const ctx = await setup();
    const player = await prisma.player.create({ data: { leagueId: ctx.league.id, name: "Aaron Judge", yahooPlayerId: "469.p.9999", positions: ["OF"] } });
    await prisma.rosterSpot.create({
      data: { seasonId: ctx.season.id, teamId: ctx.team.id, playerId: player.id, yahooPlayerKey: "469.p.9999", onTeamSince: new Date(), lastSeenAt: new Date() },
    });
    return { ...ctx, player };
  }

  it("matches the rostered player by canonical Yahoo id and never rewrites its 469.p.N key", async () => {
    const { league, player } = await rosteredJudge();
    const r = await commit(league.id, preview({ players: [judge], events: [acquired("9999", 2025, 12)] }));
    expect(r).toMatchObject({ playersCreated: 0, playersMatchedByYahooId: 1 });
    const players = await prisma.player.findMany({ where: { leagueId: league.id } });
    expect(players).toHaveLength(1);
    expect(players[0]).toMatchObject({ id: player.id, yahooPlayerId: "469.p.9999" });
    expect(await prisma.acquisition.count({ where: { playerId: player.id } })).toBe(1);
  });

  it("the next Yahoo sync finds the same player: no duplicate, roster and keeper history stay connected", async () => {
    const { league, team, player } = await rosteredJudge();
    await commit(league.id, preview({ players: [judge], events: [acquired("9999", 2025, 12)] }));
    const keeperBefore = await prisma.keeperRecord.findMany({ where: { playerId: player.id } });
    expect(keeperBefore.length).toBeGreaterThan(0);

    wireYahoo([{ key: "469.p.9999", full: "Aaron Judge" }]);
    const sync = await runYahooSync(league.id);
    expect(sync.sections.find((s) => s.section === "players")?.error).toBeUndefined();

    expect(await prisma.player.count({ where: { leagueId: league.id } })).toBe(1);
    const spot = await prisma.rosterSpot.findFirstOrThrow({ where: { teamId: team.id } });
    expect(spot.playerId).toBe(player.id);
    expect(await prisma.keeperRecord.count({ where: { playerId: player.id } })).toBe(keeperBefore.length);
  });

  it("a player the import created with a bare id is claimed by the sync, not duplicated, and gets the full key", async () => {
    const { league, team } = await setup();
    await commit(league.id, preview({ players: [{ ...judge, key: "777", yahooPlayerId: "777", name: "Juan Soto" }], events: [acquired("777", 2025, 30)] }));
    const created = await prisma.player.findFirstOrThrow({ where: { leagueId: league.id } });
    expect(created.yahooPlayerId).toBe("777");

    wireYahoo([{ key: "469.p.777", full: "Juan Soto" }]);
    await runYahooSync(league.id);
    const players = await prisma.player.findMany({ where: { leagueId: league.id } });
    expect(players).toHaveLength(1);
    expect(players[0]).toMatchObject({ id: created.id, yahooPlayerId: "469.p.777" });
    expect((await prisma.rosterSpot.findFirstOrThrow({ where: { teamId: team.id } })).playerId).toBe(created.id);
  });

  it("links an unlinked prospect by unique name without writing a Yahoo id, and the sync still claims it", async () => {
    const { league, team } = await setup();
    const prospect = await prisma.player.create({ data: { leagueId: league.id, name: "Konnor Griffin", positions: ["SS"] } });
    const r = await commit(
      league.id,
      preview({
        players: [{ ...judge, key: "555", yahooPlayerId: "555", name: "Konnor Griffin", positions: ["SS"] }],
        events: [acquired("555", 2026, 0, { method: "FYPD", priceStatus: "rule" })],
      })
    );
    expect(r).toMatchObject({ playersCreated: 0, playersMatchedByName: 1 });
    expect((await prisma.player.findUniqueOrThrow({ where: { id: prospect.id } })).yahooPlayerId).toBeNull();

    wireYahoo([{ key: "469.p.555", full: "Konnor Griffin", positions: ["SS"] }]);
    await runYahooSync(league.id);
    expect(await prisma.player.count({ where: { leagueId: league.id } })).toBe(1);
    expect((await prisma.rosterSpot.findFirstOrThrow({ where: { teamId: team.id } })).playerId).toBe(prospect.id);
  });

  it("stops before writing when one Yahoo id is already stored on two players", async () => {
    const { league } = await setup();
    await prisma.player.create({ data: { leagueId: league.id, name: "Aaron Judge", yahooPlayerId: "469.p.9999" } });
    await prisma.player.create({ data: { leagueId: league.id, name: "Aaron Judge", yahooPlayerId: "458.p.9999" } });
    await expect(commit(league.id, preview({ players: [judge], events: [acquired("9999", 2025, 12)] }))).rejects.toBeInstanceOf(LeagueHistoryConflictError);
    expect(await prisma.acquisition.count()).toBe(0);
  });
});

describe("same-name players are never merged on name alone", () => {
  async function twoWillSmiths() {
    const ctx = await setup();
    const catcher = await prisma.player.create({ data: { leagueId: ctx.league.id, name: "Will Smith", yahooPlayerId: "469.p.100", positions: ["C"] } });
    const pitcher = await prisma.player.create({ data: { leagueId: ctx.league.id, name: "Will Smith", yahooPlayerId: "469.p.200", positions: ["RP"] } });
    return { ...ctx, catcher, pitcher };
  }

  it("matches by role when positions tell the two apart", async () => {
    const { league, pitcher, catcher } = await twoWillSmiths();
    const r = await commit(
      league.id,
      preview({
        players: [{ key: "n:will smith:P", yahooPlayerId: null, name: "Will Smith", mlbTeam: null, positions: ["RP"], isFypdProspect: false, flags: [] }],
        events: [acquired("n:will smith:P", 2025, 3, { sourceRef: "auction:x", method: "DRAFT" })],
      })
    );
    expect(r).toMatchObject({ playersCreated: 0, playersMatchedByName: 1 });
    expect(await prisma.acquisition.count({ where: { playerId: pitcher.id } })).toBe(1);
    expect(await prisma.acquisition.count({ where: { playerId: catcher.id } })).toBe(0);
  });

  it("keeps an ambiguous name as a separate player flagged for review, leaving both existing players untouched", async () => {
    const { league, pitcher, catcher } = await twoWillSmiths();
    const r = await commit(
      league.id,
      preview({
        players: [{ key: "n:will smith", yahooPlayerId: null, name: "Will Smith", mlbTeam: null, positions: [], isFypdProspect: false, flags: [] }],
        events: [acquired("n:will smith", 2025, 3, { sourceRef: "auction:x", method: "DRAFT" })],
      })
    );
    expect(r.playersCreated).toBe(1);
    expect(r.identityReview).toHaveLength(1);
    expect(r.identityReview[0].candidateIds.sort()).toEqual([catcher.id, pitcher.id].sort());
    expect(await prisma.acquisition.count({ where: { playerId: { in: [pitcher.id, catcher.id] } } })).toBe(0);
    for (const p of [catcher, pitcher]) expect(await prisma.player.findUniqueOrThrow({ where: { id: p.id } })).toMatchObject({ yahooPlayerId: p.yahooPlayerId });
  });

  it("re-running reuses the player it kept separate (no new duplicate per run) and marks it for review on the player page", async () => {
    const { league } = await twoWillSmiths();
    const p = preview({
      players: [{ key: "n:will smith", yahooPlayerId: null, name: "Will Smith", mlbTeam: null, positions: [], isFypdProspect: false, flags: [] }],
      events: [acquired("n:will smith", 2025, 3, { sourceRef: "auction:x", method: "DRAFT" })],
    });
    await commit(league.id, p);
    const second = await commit(league.id, p);
    expect(second.playersCreated).toBe(0);
    expect(await prisma.player.count({ where: { leagueId: league.id, name: "Will Smith" } })).toBe(3);
    const kept = await prisma.player.findFirstOrThrow({ where: { leagueId: league.id, yahooPlayerId: null } });
    expect(kept.notes).toMatch(/^Needs review/);
    expect(await prisma.acquisition.count({ where: { playerId: kept.id } })).toBe(1);
  });

  it("never treats a player with a different Yahoo id as the same person", async () => {
    const { league, catcher } = await twoWillSmiths();
    const r = await commit(
      league.id,
      preview({ players: [{ key: "300", yahooPlayerId: "300", name: "Will Smith", mlbTeam: null, positions: ["C"], isFypdProspect: false, flags: [] }], events: [acquired("300", 2025, 1)] })
    );
    expect(r.playersCreated).toBe(1);
    expect(await prisma.acquisition.count({ where: { playerId: catcher.id } })).toBe(0);
  });
});

describe("overlap with Yahoo-synced transactions", () => {
  async function withSyncedDrop() {
    const ctx = await setup();
    await prisma.transaction.create({
      data: { seasonId: ctx.season.id, seasonYear: 2026, type: "DROP", yahooTransactionId: `${LEAGUE_KEY}.tr.5`, notes: "Synced from Yahoo (drop)" },
    });
    return ctx;
  }
  const drop = (key: string, season = 2026): HistoryEvent => ({
    playerKey: "9999",
    kind: "DROPPED",
    season,
    date: `${season}-06-01T00:00:00.000Z`,
    franchise: "Alex",
    sourceRef: `yahoo:${key}`,
    flags: [],
  });

  it("stops before writing anything when a transaction is already synced, and leaves the synced row intact", async () => {
    const { league } = await withSyncedDrop();
    const err = await commit(league.id, preview({ players: [judge], events: [acquired("9999", 2025, 12), drop(`${LEAGUE_KEY}.tr.5`)] })).catch((e) => e);
    expect(err).toBeInstanceOf(LeagueHistoryConflictError);
    expect(await prisma.transaction.count()).toBe(1);
    expect(await prisma.player.count()).toBe(0);
    expect(await prisma.acquisition.count()).toBe(0);
  });

  it("stops on any transaction from a season the sync owns, even one it hasn't synced yet", async () => {
    const { league } = await withSyncedDrop();
    await expect(commit(league.id, preview({ players: [judge], events: [drop(`${LEAGUE_KEY}.tr.999`)] }))).rejects.toBeInstanceOf(LeagueHistoryConflictError);
  });

  it("stops on end-of-year reconstructed moves for a synced season", async () => {
    const { league } = await withSyncedDrop();
    const eoy: HistoryEvent = { ...drop("x"), sourceRef: "workbook:Alex/2026/eoy" };
    await expect(commit(league.id, preview({ players: [judge], events: [eoy] }))).rejects.toBeInstanceOf(LeagueHistoryConflictError);
  });

  it("imports earlier seasons' Yahoo transactions alongside the synced season, counting each drop once", async () => {
    const { league } = await withSyncedDrop();
    await commit(league.id, preview({ players: [judge], events: [acquired("9999", 2024, 12), drop("458.l.1.tr.77", 2025)] }));
    const drops = await prisma.transaction.findMany({ where: { type: "DROP" }, include: { players: true } });
    expect(drops).toHaveLength(2);
    expect(drops.filter((d) => d.yahooTransactionId)).toHaveLength(1);
    const imported = drops.filter((d) => d.sourceRef?.startsWith(SOURCE_PREFIX));
    expect(imported).toHaveLength(1);
    // Keeper history: the 2024 stint ends in 2025 - one drop, no 2026 row.
    const records = await prisma.keeperRecord.findMany({ orderBy: { seasonYear: "asc" } });
    expect(records.map((r) => [r.seasonYear, r.status])).toEqual([
      [2024, "KEPT"],
      [2025, "DROPPED"],
    ]);
  });
});

describe("provenance written by the import", () => {
  it("tags every acquisition price and draft-pick order, and records workbook-matched keeper seasons on the origin", async () => {
    const { league } = await setup();
    const players = [judge, { ...judge, key: "n:drafted", yahooPlayerId: null, name: "Drafted Guy" }];
    await commit(
      league.id,
      preview({
        players,
        events: [
          acquired("9999", 2023, 10, { method: "DRAFT", sourceRef: "auction:A1" }),
          acquired("n:drafted", 2024, 0, { method: "DRAFT", priceStatus: "missing", sourceRef: "workbook:Alex/2024/draft", flags: ["Draft row had no cost - recorded as 0."] }),
          { playerKey: "9999", kind: "TRADED", season: 2024, date: "2024-06-01T00:00:00.000Z", franchise: "Alex", sourceRef: "yahoo:458.l.1.tr.9", flags: [] },
        ],
        draftPicks: [
          { season: 2023, overallPick: 4, franchise: "Alex", playerKey: "9999", cost: 10, sourceRef: "A1", order: "source" },
          { season: 2024, overallPick: 1, franchise: "Alex", playerKey: "n:drafted", cost: null, sourceRef: "Alex 2024 draft", order: "sheet" },
        ],
        keeperChecks: [{ season: 2024, franchise: "Alex", rawName: "Judge", playerKey: "9999", recordedCost: 11, computedCost: 11, status: "match" }],
      })
    );
    const acqs = await prisma.acquisition.findMany({ orderBy: { seasonYear: "asc" } });
    const byMethod = Object.fromEntries(acqs.map((a) => [`${a.method}${a.seasonYear}`, readProvenance(a.sourceRef)]));
    expect(byMethod.DRAFT2023).toEqual({ price: "recorded", keeperRecorded: [2024] });
    expect(byMethod.DRAFT2024).toEqual({ price: "missing", keeperRecorded: [] });
    expect(byMethod.TRADE2024).toEqual({ keeperRecorded: [] });
    const picks = await prisma.draftPick.findMany({ orderBy: { seasonYear: "asc" } });
    expect(picks.map((p) => [p.cost, readProvenance(p.sourceRef).order])).toEqual([
      [10, "source"],
      [null, "sheet"],
    ]);
  });
});

describe("repeat runs and rollback", () => {
  const full = () =>
    preview({
      players: [judge],
      events: [acquired("9999", 2024, 12), { playerKey: "9999", kind: "DROPPED", season: 2025, date: "2025-05-01T00:00:00.000Z", franchise: "Alex", sourceRef: "yahoo:458.l.1.tr.3", flags: [] }],
      draftPicks: [{ season: 2024, overallPick: 1, franchise: "Alex", playerKey: "9999", cost: 12, sourceRef: "A", order: "source" }],
    });

  it("a second run replaces its own rows: no duplicate players, transactions, acquisitions, picks or keeper records", async () => {
    const { league } = await setup();
    await prisma.player.create({ data: { leagueId: league.id, name: "Aaron Judge", yahooPlayerId: "469.p.9999" } });
    await commit(league.id, full());
    const counts = async () => ({
      players: await prisma.player.count(),
      tx: await prisma.transaction.count(),
      acq: await prisma.acquisition.count(),
      picks: await prisma.draftPick.count(),
      keepers: await prisma.keeperRecord.count(),
    });
    const first = await counts();
    await commit(league.id, full());
    expect(await counts()).toEqual(first);
    expect(first).toMatchObject({ players: 1, tx: 1, acq: 1, picks: 1 });
  });

  it("rolls back every write when the commit fails partway through", async () => {
    const { league } = await setup();
    const failing = (tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0]) =>
      new Proxy(tx, {
        get(target, prop) {
          if (prop === "keeperRecord") throw new Error("simulated failure after acquisitions were written");
          return Reflect.get(target, prop);
        },
      });
    await expect(
      prisma.$transaction((tx) => commitLeagueHistory(failing(tx), league.id, full(), { currentSeason: 2026, applyRecordedKeeperCosts: true, actorName: "t" }))
    ).rejects.toThrow("simulated failure");
    expect(await prisma.acquisition.count()).toBe(0);
    expect(await prisma.player.count()).toBe(0);
    expect(await prisma.season.count()).toBe(1);
  });
});
