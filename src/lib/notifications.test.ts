import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { prisma } from "./db";
import { notifyManager } from "./notifications";
import { runKeeperDeadlineChecks } from "./notification-jobs";
import { makeLeagueWithSeason, makeManagerAndTeam, makePlayer, resetDatabase } from "./test-helpers";

beforeEach(resetDatabase);
afterAll(resetDatabase);

describe("notifyManager", () => {
  it("does not create a notification when the preference is disabled (off by default)", async () => {
    const { league } = await makeLeagueWithSeason();
    const { manager } = await makeManagerAndTeam(league.id, "Alex");

    await notifyManager({
      managerId: manager.id,
      type: "TRADE_PROPOSED",
      title: "Test",
      body: "Test body",
    });

    const count = await prisma.notification.count({ where: { managerId: manager.id } });
    expect(count).toBe(0);
  });

  it("creates an in-app notification once the manager opts in", async () => {
    const { league } = await makeLeagueWithSeason();
    const { manager } = await makeManagerAndTeam(league.id, "Alex");

    await prisma.notificationPreference.create({
      data: { managerId: manager.id, type: "TRADE_PROPOSED", channel: "IN_APP", enabled: true },
    });

    await notifyManager({
      managerId: manager.id,
      type: "TRADE_PROPOSED",
      title: "Trade proposed",
      body: "Body",
    });

    const notifications = await prisma.notification.findMany({ where: { managerId: manager.id } });
    expect(notifications).toHaveLength(1);
    expect(notifications[0].read).toBe(false);
  });

  it("marking a notification read is reflected in unread counts", async () => {
    const { league } = await makeLeagueWithSeason();
    const { manager } = await makeManagerAndTeam(league.id, "Alex");
    await prisma.notificationPreference.create({
      data: { managerId: manager.id, type: "SYNC_FAILED", channel: "IN_APP", enabled: true },
    });
    await notifyManager({ managerId: manager.id, type: "SYNC_FAILED", title: "t", body: "b" });

    const before = await prisma.notification.count({ where: { managerId: manager.id, read: false } });
    expect(before).toBe(1);

    await prisma.notification.updateMany({ where: { managerId: manager.id }, data: { read: true } });

    const after = await prisma.notification.count({ where: { managerId: manager.id, read: false } });
    expect(after).toBe(0);
  });
});

describe("runKeeperDeadlineChecks (idempotency / duplicate prevention)", () => {
  it("does not send a duplicate Year-5 alert on a second run", async () => {
    const { league, season } = await makeLeagueWithSeason();
    const { manager, team } = await makeManagerAndTeam(league.id, "Alex");
    const player = await makePlayer(league.id, "Test Player");

    await prisma.notificationPreference.create({
      data: { managerId: manager.id, type: "KEEPER_YEAR_FIVE", channel: "IN_APP", enabled: true },
    });
    await prisma.keeperRecord.create({
      data: {
        seasonId: season.id,
        seasonYear: season.year,
        playerId: player.id,
        teamId: team.id,
        keeperYear: 5,
        keeperCost: 30,
        yearsRemaining: 0,
        status: "KEPT",
      },
    });

    const first = await runKeeperDeadlineChecks();
    const second = await runKeeperDeadlineChecks();

    expect(first.notified).toBeGreaterThan(0);
    expect(second.notified).toBe(0);

    const count = await prisma.notification.count({ where: { managerId: manager.id, type: "KEEPER_YEAR_FIVE" } });
    expect(count).toBe(1);
  });
});
