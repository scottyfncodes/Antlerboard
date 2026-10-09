/**
 * Trade-offer state machine (an "Open to Discuss" tag leads here once a
 * manager sends a concrete offer), extracted from the API route for the
 * same reason as src/lib/trades.ts: one place to test and reuse.
 */

import type { Prisma } from "@prisma/client";
import { prisma } from "./db";
import { notifyManagers } from "./notifications";
import { recomputeKeeperRecordsForPlayer } from "./keeper-sync";
import { CURRENT_SEASON_YEAR } from "./config";
import { firstOffRosterMove, lockPlayers, lockRow } from "./roster-guard";

export class OfferActionError extends Error {}

const OFFER_INCLUDE = { sendingTeam: true, receivingTeam: true } as const;

/** Locks the offer row and reads it fresh; throws unless it's still PENDING. */
async function loadPendingOfferForUpdate(tx: Prisma.TransactionClient, id: string) {
  await lockRow(tx, "Offer", id);
  const offer = await tx.offer.findUnique({ where: { id }, include: OFFER_INCLUDE });
  if (!offer) throw new OfferActionError("Offer not found");
  if (offer.status !== "PENDING") throw new OfferActionError("This offer is no longer open");
  return offer;
}

function offerMoves(offer: { playersOffered: string[]; playersRequested: string[]; sendingTeamId: string; receivingTeamId: string }) {
  return [
    ...offer.playersOffered.map((playerId) => ({ playerId, fromTeamId: offer.sendingTeamId, toTeamId: offer.receivingTeamId })),
    ...offer.playersRequested.map((playerId) => ({ playerId, fromTeamId: offer.receivingTeamId, toTeamId: offer.sendingTeamId })),
  ];
}

export interface OfferProposal {
  sendingTeamId: string;
  receivingTeamId: string;
  targetPlayerId?: string | null;
  playersOffered: string[];
  playersRequested: string[];
}

/**
 * Returns a user-facing reason a new offer can't be sent, or null. Offered
 * players must be on the sending team, requested players (and the target)
 * on the receiving team.
 */
export async function offerProposalProblem(o: OfferProposal): Promise<string | null> {
  const ids = [...o.playersOffered, ...o.playersRequested, ...(o.targetPlayerId ? [o.targetPlayerId] : [])];
  if (new Set([...o.playersOffered, ...o.playersRequested]).size !== o.playersOffered.length + o.playersRequested.length) {
    return "The same player can't be in an offer twice";
  }
  const receiving = await prisma.team.findUnique({ where: { id: o.receivingTeamId }, select: { active: true } });
  if (!receiving?.active) return "That team isn't an active team in the league";
  if (ids.length === 0) return null;

  const offRoster = await firstOffRosterMove(prisma, [
    ...offerMoves(o),
    ...(o.targetPlayerId ? [{ playerId: o.targetPlayerId, fromTeamId: o.receivingTeamId }] : []),
  ]);
  if (!offRoster) return null;
  return offRoster.fromTeamId === o.sendingTeamId
    ? `${offRoster.playerName} isn't on your roster`
    : `${offRoster.playerName} isn't on that team's roster`;
}

export async function withdrawOffer(id: string) {
  await prisma.$transaction(async (tx) => {
    await loadPendingOfferForUpdate(tx, id);
    await tx.offer.update({ where: { id }, data: { status: "WITHDRAWN" } });
  });
}

export async function rejectOffer(id: string) {
  const offer = await prisma.$transaction(async (tx) => {
    const offer = await loadPendingOfferForUpdate(tx, id);
    await tx.offer.update({ where: { id }, data: { status: "REJECTED" } });
    return offer;
  });
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
  const offer = await prisma.$transaction(async (tx) => {
    const offer = await loadPendingOfferForUpdate(tx, id);
    const season = await tx.season.findFirst({ where: { year: CURRENT_SEASON_YEAR } });
    if (!season) throw new OfferActionError("No current season");

    // Same guard as an executing trade: lock every player, confirm each is
    // still on the team giving him up, and rebuild keeper records before
    // commit so no other deal can move him on stale data.
    const moves = offerMoves(offer);
    await lockPlayers(tx, moves.map((m) => m.playerId));
    const offRoster = await firstOffRosterMove(tx, moves);
    if (offRoster) {
      const team = offRoster.fromTeamId === offer.sendingTeamId ? offer.sendingTeam : offer.receivingTeam;
      throw new OfferActionError(`${offRoster.playerName} is no longer on ${team.name}'s roster - this offer can't go through`);
    }

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
          // Before the keeper deadline the receiving team is the one that
          // declares the keeper - see keeper-engine's preseason trades.
          preseason: !!season.keeperDeadline && new Date() < season.keeperDeadline,
        },
      });
      const txn = await tx.transaction.create({
        data: {
          seasonId: season.id,
          seasonYear: CURRENT_SEASON_YEAR,
          type: "TRADE",
          notes: "Trade offer accepted",
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
    for (const move of moves) {
      await recomputeKeeperRecordsForPlayer(move.playerId, CURRENT_SEASON_YEAR, tx);
    }
    return offer;
  }, { timeout: 30_000 });

  await notifyManagers([offer.sendingManagerId], {
    type: "OFFER_ACTIVITY",
    title: "Offer accepted",
    body: `${offer.receivingTeam.name} accepted your offer.`,
    link: "/trades",
    relatedEntityType: "Offer",
    relatedEntityId: offer.id,
  });
}
