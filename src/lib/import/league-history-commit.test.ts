import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { prisma } from "../db";
import { resetDatabase, makeLeagueWithSeason, makeManagerAndTeam } from "../test-helpers";
import { commitLeagueHistory, SOURCE_PREFIX } from "./league-history-commit";
import type { LeagueHistoryPreview } from "./league-history-builder";

function preview(): LeagueHistoryPreview {
  return {
    players: [
      { key: "1001", yahooPlayerId: "1001", name: "Keeper Guy", mlbTeam: "NYM", positions: ["OF"], isFypdProspect: false, flags: [] },
      { key: "n:drafted guy", yahooPlayerId: null, name: "Drafted Guy", mlbTeam: null, positions: [], isFypdProspect: false, flags: [] },
    ],
    events: [
      { playerKey: "1001", kind: "ACQUIRED", season: 2023, date: "2023-03-25T00:00:00.000Z", franchise: "Scott", method: "DRAFT", cost: 10, sourceRef: "auction:1", flags: [] },
      { playerKey: "1001", kind: "TRADED", season: 2024, date: "2024-06-01T00:00:00.000Z", franchise: "Ed", sourceRef: "yahoo:t1", flags: [] },
      { playerKey: "n:drafted guy", kind: "ACQUIRED", season: 2024, date: "2024-03-23T00:00:00.000Z", franchise: "Scott", method: "DRAFT", cost: 4, sourceRef: "auction:2", flags: [] },
      { playerKey: "n:drafted guy", kind: "DROPPED", season: 2024, date: "2024-12-31T00:00:00.000Z", franchise: "Scott", sourceRef: "not kept into 2025", flags: ["example flag"] },
    ],
    draftPicks: [
      { season: 2023, overallPick: 1, franchise: "Scott", playerKey: "1001", cost: 10, sourceRef: "auction:1" },
      { season: 2024, overallPick: 1, franchise: "Scott", playerKey: "n:drafted guy", cost: 4, sourceRef: "auction:2" },
    ],
    keeperChecks: [
      // Rule says 10 + 4 = 14 in 2025 (year 2); the workbook recorded 13.
      { season: 2025, franchise: "Ed", rawName: "K.Guy", playerKey: "1001", recordedCost: 13, computedCost: 14, status: "mismatch" },
    ],
    eoyChecks: [],
    unresolvedTeams: [],
    unmatchedPlayers: [],
    draftDates: {},
    summary: {
      players: 2,
      events: 4,
      flaggedEvents: 1,
      draftPicks: 2,
      seasons: [2023, 2024, 2025],
      keeperChecks: { match: 0, mismatch: 1, unmatched: 0, "not-computed": 0 },
      eoyCostChecks: { match: 0, mismatch: 0, unmatched: 0, "not-computed": 0 },
      eoyProjectionChecks: { match: 0, mismatch: 0, unmatched: 0, "not-computed": 0 },
      unresolvedTeamNames: 0,
      unmatchedPlayerNames: 0,
    },
    flags: [],
  };
}

describe("commitLeagueHistory", () => {
  let leagueId: string;

  beforeEach(async () => {
    await resetDatabase();
    const { league } = await makeLeagueWithSeason(2025);
    leagueId = league.id;
    await makeManagerAndTeam(leagueId, "Scott", true);
    // "Ed" deliberately missing - the commit must create the franchise.
  });

  afterAll(async () => {
    await resetDatabase();
    await prisma.$disconnect();
  });

  it("writes players, events, picks and keeper records, keeping the recorded cost as an override", async () => {
    const result = await prisma.$transaction((tx) =>
      commitLeagueHistory(tx, leagueId, preview(), { currentSeason: 2025, applyRecordedKeeperCosts: true, actorName: "Scott" })
    );

    expect(result).toMatchObject({ managersCreated: 1, teamsCreated: 1, playersCreated: 2, acquisitionsWritten: 3, dropsWritten: 1, draftPicksWritten: 2, overridesApplied: 1 });

    const keeper = await prisma.player.findFirstOrThrow({ where: { yahooPlayerId: "1001" } });
    const records = await prisma.keeperRecord.findMany({ where: { playerId: keeper.id }, orderBy: { seasonYear: "asc" } });
    expect(records.map((r) => [r.seasonYear, r.keeperYear, r.keeperCost, r.commissionerOverride])).toEqual([
      [2023, 0, 10, false],
      [2024, 1, 11, false],
      [2025, 2, 13, true], // workbook's 13 kept over the rule's 14
    ]);
    const edTeam = await prisma.team.findFirstOrThrow({ where: { manager: { name: "Ed" } } });
    expect(records[2].teamId).toBe(edTeam.id); // the trade moved the clock, not reset it

    const drafted = await prisma.player.findFirstOrThrow({ where: { name: "Drafted Guy" } });
    const draftedRecords = await prisma.keeperRecord.findMany({ where: { playerId: drafted.id } });
    expect(draftedRecords.map((r) => r.seasonYear)).toEqual([2024]); // released, so nothing in 2025

    const drop = await prisma.transaction.findFirstOrThrow({ where: { type: "DROP" } });
    expect(drop.sourceRef).toBe(`${SOURCE_PREFIX}not kept into 2025`);
    expect(drop.notes).toBe("example flag");

    const audit = await prisma.auditLogEntry.findFirst({ where: { action: "LEAGUE_HISTORY_IMPORT" } });
    expect(audit).not.toBeNull();
  });

  it("is idempotent: a second run replaces its own rows instead of duplicating them", async () => {
    await prisma.$transaction((tx) => commitLeagueHistory(tx, leagueId, preview(), { currentSeason: 2025, applyRecordedKeeperCosts: true, actorName: "Scott" }));
    const second = await prisma.$transaction((tx) =>
      commitLeagueHistory(tx, leagueId, preview(), { currentSeason: 2025, applyRecordedKeeperCosts: false, actorName: "Scott" })
    );
    expect(second.previousImportRowsRemoved).toBe(3 + 1 + 2);
    expect(second.playersCreated).toBe(0);
    expect(second.playersMatched).toBe(2);
    expect(await prisma.acquisition.count()).toBe(3);
    expect(await prisma.transaction.count()).toBe(1);
    expect(await prisma.draftPick.count()).toBe(2);

    // Without applyRecordedKeeperCosts the override is gone and the rule wins again.
    const keeper = await prisma.player.findFirstOrThrow({ where: { yahooPlayerId: "1001" } });
    const r2025 = await prisma.keeperRecord.findFirstOrThrow({ where: { playerId: keeper.id, seasonYear: 2025 } });
    expect(r2025.keeperCost).toBe(14);
    expect(r2025.commissionerOverride).toBe(false);
  });
});
