import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { prisma } from "../db";
import { makeLeagueWithSeason, makeManagerAndTeam, makePlayer, resetDatabase } from "../test-helpers";
import { clearLeagueOperationalData, pickContinuingCommissioner } from "./demo-cleanup";

beforeEach(resetDatabase);
afterAll(resetDatabase);

describe("clearLeagueOperationalData", () => {
  it("removes every team/manager/player/season under a league, leaving the league itself", async () => {
    const { league, season } = await makeLeagueWithSeason(2025);
    const { manager, team } = await makeManagerAndTeam(league.id, "Demo Manager", true);
    const player = await makePlayer(league.id, "Demo Player");
    await prisma.acquisition.create({
      data: { seasonId: season.id, seasonYear: 2025, playerId: player.id, teamId: team.id, method: "DRAFT", cost: 5 },
    });
    await prisma.keeperRecord.create({
      data: {
        seasonId: season.id,
        seasonYear: 2025,
        playerId: player.id,
        teamId: team.id,
        keeperYear: 1,
        keeperCost: 5,
        yearsRemaining: 4,
        status: "KEPT",
      },
    });
    await prisma.playerTag.create({ data: { playerId: player.id, teamId: team.id, tag: "KEEPING" } });
    await prisma.notification.create({
      data: { managerId: manager.id, type: "SYNC_SUCCESSFUL", title: "t", body: "b" },
    });

    const result = await clearLeagueOperationalData(prisma, league.id);

    expect(result).toEqual({ managersDeleted: 1, teamsDeleted: 1, playersDeleted: 1, seasonsDeleted: 1 });
    expect(await prisma.manager.count({ where: { leagueId: league.id } })).toBe(0);
    expect(await prisma.team.count({ where: { leagueId: league.id } })).toBe(0);
    expect(await prisma.player.count({ where: { leagueId: league.id } })).toBe(0);
    expect(await prisma.season.count({ where: { leagueId: league.id } })).toBe(0);
    expect(await prisma.league.findUnique({ where: { id: league.id } })).not.toBeNull();
  });

  it("leaves a different league's data alone", async () => {
    const { league: leagueA } = await makeLeagueWithSeason(2025);
    await makeManagerAndTeam(leagueA.id, "Manager A");
    const { league: leagueB } = await makeLeagueWithSeason(2025);
    await makeManagerAndTeam(leagueB.id, "Manager B");

    await clearLeagueOperationalData(prisma, leagueA.id);

    expect(await prisma.manager.count({ where: { leagueId: leagueA.id } })).toBe(0);
    expect(await prisma.manager.count({ where: { leagueId: leagueB.id } })).toBe(1);
  });

  it("does nothing to League/LeagueSettings/AuditLogEntry", async () => {
    const { league } = await makeLeagueWithSeason(2025);
    await prisma.leagueSettings.create({ data: { leagueId: league.id } });
    await prisma.auditLogEntry.create({ data: { actorName: "x", action: "TEST", entityType: "League" } });

    await clearLeagueOperationalData(prisma, league.id);

    expect(await prisma.league.count()).toBe(1);
    expect(await prisma.leagueSettings.count()).toBe(1);
    expect(await prisma.auditLogEntry.count()).toBe(1);
  });
});

describe("pickContinuingCommissioner", () => {
  it("matches the outgoing commissioner's first name against the new roster", () => {
    expect(pickContinuingCommissioner("Scott Lawrence", ["Aaron", "Scott", "Zach"])).toBe("Scott");
  });

  it("is case-insensitive", () => {
    expect(pickContinuingCommissioner("scott lawrence", ["Aaron", "Scott", "Zach"])).toBe("Scott");
  });

  it("falls back to the alphabetically-first candidate when there's no match", () => {
    expect(pickContinuingCommissioner("Someone Else", ["Zach", "Aaron", "Kurt"])).toBe("Aaron");
  });

  it("falls back to the alphabetically-first candidate when there's no outgoing commissioner", () => {
    expect(pickContinuingCommissioner(null, ["Zach", "Aaron", "Kurt"])).toBe("Aaron");
  });

  it("returns null when there are no candidates at all", () => {
    expect(pickContinuingCommissioner("Scott Lawrence", [])).toBeNull();
  });
});
