/**
 * "Make Me an Offer" state machine, extracted from the API route for the
 * same reason as src/lib/trades.ts: one place to test and reuse.
 */

import { prisma } from "./db";
import { notifyManagers } from "./notifications";
import { recomputeKeeperRecordsForPlayer } from "./keeper-sync";
import { CURRENT_SEASON_YEAR } from "./config";

export class OfferActionError extends Error {}

async function loadOffer(id: string) {
  const offer = await prisma.offer.findUnique({
    where: { id },
    include: { sendingTeam: true, receivingTeam: true },
  });
  if (!offer) throw new OfferActionError("Offer not found");
  return offer;
}

export async function withdrawOffer(id: string) {
  await prisma.offer.update({ where: { id }, data: { status: "WITHDRAWN" } });
}

export async function rejectOffer(id: string) {
  const offer = await loadOffer(id);
  await prisma.offer.update({ where: { id }, data: { status: "REJECTED" } });
  await notifyManagers([offer.sendingManagerId], {
    type: "OFFER_ACTIVITY",
    title: "Offer declined",
    body: `${offer.receivingTeam.name} declined your offer.`,
    link: "/trades",
    relatedEntityType: "Offer",
    relatedEntityId: offer.id,
  });
}

export async function acceptOffer(id: string) {
  const offer = await loadOffer(id);
  const season = await prisma.season.findFirst({ where: { year: CURRENT_SEASON_YEAR } });
  if (!season) throw new OfferActionError("No current season");

  const moves: { playerId: string; toTeamId: string; fromTeamId: string }[] = [
    ...offer.playersOffered.map((playerId) => ({ playerId, toTeamId: offer.receivingTeamId, fromTeamId: offer.sendingTeamId })),
    ...offer.playersRequested.map((playerId) => ({ playerId, toTeamId: offer.sendingTeamId, fromTeamId: offer.receivingTeamId })),
  ];

  await prisma.$transaction(async (tx) => {
    await tx.offer.update({ where: { id }, data: { status: "ACCEPTED" } });
    for (const move of moves) {
      await tx.acquisition.create({
        data: {
          seasonId: season.id,
          seasonYear: CURRENT_SEASON_YEAR,
          playerId: move.playerId,
          teamId: move.toTeamId,
          method: "TRADE",
          cost: 0,
        },
      });
      const txn = await tx.transaction.create({
        data: {
          seasonId: season.id,
          seasonYear: CURRENT_SEASON_YEAR,
          type: "TRADE",
          notes: "Make Me an Offer accepted",
        },
      });
      await tx.transactionPlayer.create({ data: { transactionId: txn.id, playerId: move.playerId } });
      await tx.transactionTeam.createMany({
        data: [
          { transactionId: txn.id, teamId: move.fromTeamId, role: "FROM" },
          { transactionId: txn.id, teamId: move.toTeamId, role: "TO" },
        ],
      });
    }
  });

  for (const move of moves) {
    await recomputeKeeperRecordsForPlayer(move.playerId, CURRENT_SEASON_YEAR);
  }

  await notifyManagers([offer.sendingManagerId], {
    type: "OFFER_ACTIVITY",
    title: "Offer accepted",
    body: `${offer.receivingTeam.name} accepted your offer.`,
    link: "/trades",
    relatedEntityType: "Offer",
    relatedEntityId: offer.id,
  });
}
