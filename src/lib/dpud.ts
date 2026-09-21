/**
 * DPUD bet lifecycle, extracted from its API routes for testability - see
 * src/lib/trades.ts for why.
 */

import { prisma } from "./db";
import { notifyManagers } from "./notifications";

export class DpudActionError extends Error {}

export async function optIntoBet(betId: string, managerId: string) {
  const bet = await prisma.dpudBet.findUnique({ where: { id: betId } });
  if (!bet) throw new DpudActionError("Bet not found");

  await prisma.dpudParticipant.upsert({
    where: { betId_managerId: { betId, managerId } },
    create: { betId, managerId },
    update: {},
  });

  if (bet.status === "OPEN") {
    await prisma.dpudBet.update({ where: { id: betId }, data: { status: "ACTIVE" } });
  }

  const manager = await prisma.manager.findUnique({ where: { id: managerId } });
  await notifyManagers([bet.creatorId], {
    type: "DPUD_OPT_IN",
    title: `${manager?.name ?? "Someone"} opted into your bet`,
    body: bet.title,
    link: "/prop-bets",
    relatedEntityType: "DpudBet",
    relatedEntityId: betId,
  });
}

export async function resolveBet(betId: string, result: string | undefined, winnerParticipantId: string | undefined) {
  const bet = await prisma.dpudBet.findUnique({ where: { id: betId }, include: { participants: true } });
  if (!bet) throw new DpudActionError("Bet not found");

  await prisma.dpudBet.update({
    where: { id: betId },
    data: { status: "COMPLETE", result, winnerParticipantId },
  });

  await notifyManagers(bet.participants.map((p) => p.managerId), {
    type: "DPUD_RESOLVED",
    title: `Resolved: ${bet.title}`,
    body: result ?? "The bet has been resolved.",
    link: "/prop-bets",
    relatedEntityType: "DpudBet",
    relatedEntityId: betId,
  });
}

export async function cancelBet(betId: string) {
  const bet = await prisma.dpudBet.findUnique({ where: { id: betId } });
  if (!bet) throw new DpudActionError("Bet not found");
  await prisma.dpudBet.update({ where: { id: betId }, data: { status: "CANCELLED" } });
}
