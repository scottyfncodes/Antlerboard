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
    expect(records[records.length - 1].keeperCost).toBe(24); // 20 + (5-1)*1
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
