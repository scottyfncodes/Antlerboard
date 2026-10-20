import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { prisma } from "./db";
import { recomputeKeeperRecordsForPlayer, getPlayerHistoryEvents } from "./keeper-sync";
import { makeLeagueWithSeason, makeManagerAndTeam, makePlayer, resetDatabase } from "./test-helpers";

beforeEach(resetDatabase);
afterAll(resetDatabase);

describe("keeper-sync (engine <-> database bridge)", () => {
  it("materializes KeeperRecord rows for every season in an active stint", async () => {
    const { league } = await makeLeagueWithSeason(2021);
    for (const year of [2022, 2023, 2024, 2025, 2026]) {
      await prisma.season.create({ data: { leagueId: league.id, year, status: "COMPLETE" } });
    }
    const { team } = await makeManagerAndTeam(league.id, "Alex");
    const player = await makePlayer(league.id, "Five Year Player");

    const season2021 = await prisma.season.findFirstOrThrow({ where: { leagueId: league.id, year: 2021 } });
    await prisma.acquisition.create({
      data: { seasonId: season2021.id, seasonYear: 2021, playerId: player.id, teamId: team.id, method: "DRAFT", cost: 20 },
    });

    await recomputeKeeperRecordsForPlayer(player.id, 2026);

    const records = await prisma.keeperRecord.findMany({ where: { playerId: player.id }, orderBy: { seasonYear: "asc" } });
    expect(records.map((r) => r.seasonYear)).toEqual([2021, 2022, 2023, 2024, 2025, 2026]);
    expect(records.map((r) => r.keeperYear)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(records[records.length - 1].status).toBe("KEPT");
    expect(records[records.length - 1].keeperCost).toBe(45); // 20 + 25 (year 5 on the ladder)
  });

  it("reads DROP transactions back out as reset events", async () => {
    const { league, season } = await makeLeagueWithSeason(2025);
    const { team } = await makeManagerAndTeam(league.id, "Alex");
    const player = await makePlayer(league.id, "Dropped Player");

    await prisma.acquisition.create({
      data: { seasonId: season.id, seasonYear: 2025, playerId: player.id, teamId: team.id, method: "DRAFT", cost: 10 },
    });
    const dropTxn = await prisma.transaction.create({
      data: { seasonId: season.id, seasonYear: 2025, type: "DROP" },
    });
    await prisma.transactionPlayer.create({ data: { transactionId: dropTxn.id, playerId: player.id } });

    const events = await getPlayerHistoryEvents(player.id);
    expect(events).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "DROPPED", season: 2025 })])
    );
  });

  it("does nothing for a player with no acquisition history", async () => {
    const { league } = await makeLeagueWithSeason();
    const player = await makePlayer(league.id, "Never Rostered");

    await expect(recomputeKeeperRecordsForPlayer(player.id, 2026)).resolves.not.toThrow();
    const count = await prisma.keeperRecord.count({ where: { playerId: player.id } });
    expect(count).toBe(0);
  });
});

describe("keeper history ignores Yahoo-synced transactions (until in-season moves feed Acquisition)", () => {
  async function draftedThenYahooDropped() {
    const { league, season } = await makeLeagueWithSeason(2026);
    await prisma.season.create({ data: { leagueId: league.id, year: 2027, status: "UPCOMING" } });
    const { team } = await makeManagerAndTeam(league.id, "Alex");
    const player = await makePlayer(league.id, "Kept Player");
    await prisma.acquisition.create({ data: { seasonId: season.id, seasonYear: 2026, playerId: player.id, teamId: team.id, method: "DRAFT", cost: 10 } });
    return { season, team, player };
  }

  it("leaves a player's events and keeper records exactly as they were when a recovered Yahoo drop links them", async () => {
    const { season, team, player } = await draftedThenYahooDropped();
    const eventsBefore = await getPlayerHistoryEvents(player.id);
    await recomputeKeeperRecordsForPlayer(player.id, 2027);
    const recordsBefore = await prisma.keeperRecord.findMany({ where: { playerId: player.id }, orderBy: { seasonYear: "asc" }, select: { seasonYear: true, keeperYear: true, keeperCost: true, status: true, teamId: true } });

    // What the transaction recovery (or the detailed sync) writes for a Yahoo drop.
    await prisma.transaction.create({
      data: {
        seasonId: season.id,
        seasonYear: 2026,
        type: "DROP",
        yahooTransactionId: "469.l.8891.tr.4",
        yahooType: "drop",
        players: { create: { playerId: player.id, action: "drop", sourceType: "team", sourceTeamId: team.id, destinationType: "waivers" } },
        teams: { create: { teamId: team.id, role: "FROM" } },
      },
    });

    expect(await getPlayerHistoryEvents(player.id)).toEqual(eventsBefore);
    await recomputeKeeperRecordsForPlayer(player.id, 2027);
    const recordsAfter = await prisma.keeperRecord.findMany({ where: { playerId: player.id }, orderBy: { seasonYear: "asc" }, select: { seasonYear: true, keeperYear: true, keeperCost: true, status: true, teamId: true } });
    expect(recordsAfter).toEqual(recordsBefore);
  });

  it("still counts imported and Antlerboard-entered drops", async () => {
    const { season, player } = await draftedThenYahooDropped();
    await prisma.transaction.create({
      data: { seasonId: season.id, seasonYear: 2026, type: "DROP", sourceRef: "league-history:not kept into 2027", players: { create: { playerId: player.id } } },
    });
    expect(await getPlayerHistoryEvents(player.id)).toEqual(expect.arrayContaining([expect.objectContaining({ type: "DROPPED", season: 2026 })]));
  });
});

describe("commissioner overrides pin the cost, not the owner", () => {
  it("a traded player's overridden row moves to the new team and keeps its cost", async () => {
    const { league } = await makeLeagueWithSeason(2025);
    const season2026 = await prisma.season.create({ data: { leagueId: league.id, year: 2026 } });
    const season2025 = await prisma.season.findFirstOrThrow({ where: { leagueId: league.id, year: 2025 } });
    const { team: a } = await makeManagerAndTeam(league.id, "A");
    const { team: b } = await makeManagerAndTeam(league.id, "B");
    const player = await makePlayer(league.id, "Overridden Player");
    await prisma.acquisition.create({
      data: { seasonId: season2025.id, seasonYear: 2025, playerId: player.id, teamId: a.id, method: "DRAFT", cost: 10, date: new Date("2025-03-15") },
    });
    await recomputeKeeperRecordsForPlayer(player.id, 2026);
    await prisma.keeperRecord.updateMany({ where: { playerId: player.id, seasonYear: 2026 }, data: { keeperCost: 99, commissionerOverride: true } });

    await prisma.acquisition.create({
      data: { seasonId: season2026.id, seasonYear: 2026, playerId: player.id, teamId: b.id, method: "TRADE", cost: 0, date: new Date("2026-06-01") },
    });
    await recomputeKeeperRecordsForPlayer(player.id, 2026);

    const row = await prisma.keeperRecord.findFirstOrThrow({ where: { playerId: player.id, seasonYear: 2026 } });
    expect(row).toMatchObject({ teamId: b.id, keeperCost: 99, commissionerOverride: true, keeperYear: 1 });
    expect(await prisma.keeperRecord.count({ where: { playerId: player.id, seasonYear: 2026 } })).toBe(1);
  });
});

describe("after five kept years", () => {
  it("writes one FORCED_BACK row, not a new one every later season", async () => {
    const { league } = await makeLeagueWithSeason(2019);
    for (let y = 2020; y <= 2027; y++) await prisma.season.create({ data: { leagueId: league.id, year: y } });
    const s2019 = await prisma.season.findFirstOrThrow({ where: { leagueId: league.id, year: 2019 } });
    const { team } = await makeManagerAndTeam(league.id, "Alex");
    const player = await makePlayer(league.id, "Long Keeper");
    await prisma.acquisition.create({
      data: { seasonId: s2019.id, seasonYear: 2019, playerId: player.id, teamId: team.id, method: "DRAFT", cost: 5 },
    });

    await recomputeKeeperRecordsForPlayer(player.id, 2027);

    const rows = await prisma.keeperRecord.findMany({ where: { playerId: player.id }, orderBy: { seasonYear: "asc" } });
    expect(rows.map((r) => [r.seasonYear, r.status])).toEqual([
      [2019, "KEPT"], [2020, "KEPT"], [2021, "KEPT"], [2022, "KEPT"], [2023, "KEPT"], [2024, "KEPT"],
      [2025, "FORCED_BACK"],
    ]);
  });
});
