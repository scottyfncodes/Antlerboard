/**
 * Scheduled notification generation - the logic behind the "Keeper
 * deadline checks" and "DPUD expiration reminders" Vercel Cron jobs (spec
 * section 32). Each check is idempotent: it looks for an existing
 * notification of the same type tied to the same entity before creating
 * another one, so re-running the cron on a schedule never spams anyone.
 */

import { prisma } from "./db";
import { notifyManager } from "./notifications";
import { CURRENT_SEASON_YEAR } from "./config";

async function alreadyNotified(managerId: string, type: string, relatedEntityId: string): Promise<boolean> {
  const existing = await prisma.notification.findFirst({
    where: { managerId, type: type as never, relatedEntityId },
  });
  return !!existing;
}

export async function runKeeperDeadlineChecks(): Promise<{ notified: number }> {
  let notified = 0;

  const season = await prisma.season.findFirst({ where: { year: CURRENT_SEASON_YEAR } });

  if (season?.keeperDeadline) {
    const daysUntil = Math.ceil((season.keeperDeadline.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
    if (daysUntil <= 30 && daysUntil >= 0) {
      const teams = await prisma.team.findMany({ include: { manager: true } });
      for (const team of teams) {
        if (await alreadyNotified(team.managerId, "KEEPER_DEADLINE_APPROACHING", season.id)) continue;
        await notifyManager({
          managerId: team.managerId,
          type: "KEEPER_DEADLINE_APPROACHING",
          title: `Keeper deadline in ${daysUntil} day${daysUntil === 1 ? "" : "s"}`,
          body: `Finalize your keepers for ${team.name} before the ${season.year + 1} draft.`,
          link: "/keepers",
          relatedEntityType: "Season",
          relatedEntityId: season.id,
        });
        notified++;
      }
    }
  }

  const criticalRecords = await prisma.keeperRecord.findMany({
    where: { seasonYear: CURRENT_SEASON_YEAR, keeperYear: { in: [4, 5] } },
    include: { player: true, team: true },
  });

  for (const record of criticalRecords) {
    const type = record.keeperYear === 5 ? "KEEPER_YEAR_FIVE" : "KEEPER_FINAL_YEAR";
    if (await alreadyNotified(record.team.managerId, type, record.playerId)) continue;
    await notifyManager({
      managerId: record.team.managerId,
      type,
      title:
        record.keeperYear === 5
          ? `Keeper Alert: ${record.player.name} is in Year 5/5`
          : `Heads up: ${record.player.name} enters Year 5 next season`,
      body:
        record.keeperYear === 5
          ? `${record.player.name} will be forced back into the ${CURRENT_SEASON_YEAR + 1} draft unless traded.`
          : `${record.player.name} has one keeper year left after this season.`,
      link: `/players/${record.playerId}`,
      relatedEntityType: "Player",
      relatedEntityId: record.playerId,
    });
    notified++;
  }

  return { notified };
}

export async function runDpudEndingSoonChecks(): Promise<{ notified: number }> {
  let notified = 0;
  const soon = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);

  const bets = await prisma.dpudBet.findMany({
    where: { status: "ACTIVE", endDate: { lte: soon, gte: new Date() } },
    include: { participants: true },
  });

  for (const bet of bets) {
    for (const participant of bet.participants) {
      if (await alreadyNotified(participant.managerId, "DPUD_ENDING_SOON", bet.id)) continue;
      await notifyManager({
        managerId: participant.managerId,
        type: "DPUD_ENDING_SOON",
        title: `Ending soon: ${bet.title}`,
        body: `This bet resolves on ${bet.endDate.toDateString()}.`,
        link: "/dpud",
        relatedEntityType: "DpudBet",
        relatedEntityId: bet.id,
      });
      notified++;
    }
  }

  return { notified };
}
