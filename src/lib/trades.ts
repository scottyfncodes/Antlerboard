/**
 * Trade Center state machine. Pulled out of the API route so it can be
 * unit tested directly against the database and reused without
 * duplicating the accept/reject/counter/withdraw logic anywhere else.
 */

import { prisma } from "./db";
import { notifyManagers } from "./notifications";
import { recomputeKeeperRecordsForPlayer } from "./keeper-sync";
import { CURRENT_SEASON_YEAR } from "./config";
import type { Prisma } from "@prisma/client";

export class TradeActionError extends Error {}

async function loadTrade(id: string) {
  const trade = await prisma.trade.findUnique({
    where: { id },
    include: { teamA: { include: { manager: true } }, teamB: { include: { manager: true } }, assets: true },
  });
  if (!trade) throw new TradeActionError("Trade not found");
  return trade;
}

export async function withdrawTrade(id: string) {
  await prisma.trade.update({ where: { id }, data: { status: "WITHDRAWN" } });
}

export async function rejectTrade(id: string) {
  const trade = await loadTrade(id);
  await prisma.trade.update({ where: { id }, data: { status: "REJECTED" } });
  await notifyManagers([trade.proposerId], {
    type: "TRADE_REJECTED",
    title: `Trade rejected: ${trade.teamA.name} ↔ ${trade.teamB.name}`,
    body: "Your trade proposal was rejected.",
    link: "/trades",
    relatedEntityType: "Trade",
    relatedEntityId: trade.id,
  });
}

export async function counterTrade(
  id: string,
  proposerId: string,
  assets: Prisma.TradeAssetCreateWithoutTradeInput[],
  notes?: string
) {
  const trade = await loadTrade(id);
  await prisma.trade.update({ where: { id }, data: { status: "COUNTERED" } });
  const counter = await prisma.trade.create({
    data: {
      seasonId: trade.seasonId,
      seasonYear: trade.seasonYear,
      teamAId: trade.teamAId,
      teamBId: trade.teamBId,
      proposerId,
      parentTradeId: trade.id,
      status: "PROPOSED",
      notes,
      assets: { create: assets },
    },
  });
  await notifyManagers([trade.proposerId], {
    type: "TRADE_COUNTERED",
    title: `Countered: ${trade.teamA.name} ↔ ${trade.teamB.name}`,
    body: "A counter-offer is waiting for you in the Trade Center.",
    link: "/trades",
    relatedEntityType: "Trade",
    relatedEntityId: counter.id,
  });
  return counter;
}

export async function acceptTrade(id: string) {
  const trade = await loadTrade(id);
  const season = await prisma.season.findFirst({ where: { year: CURRENT_SEASON_YEAR } });
  if (!season) throw new TradeActionError("No current season");

  await prisma.$transaction(async (tx) => {
    await tx.trade.update({ where: { id }, data: { status: "ACCEPTED" } });

    for (const asset of trade.assets) {
      if (asset.assetType !== "PLAYER" || !asset.playerId) continue;

      await tx.acquisition.create({
        data: {
          seasonId: season.id,
          seasonYear: CURRENT_SEASON_YEAR,
          playerId: asset.playerId,
          teamId: asset.toTeamId,
          method: "TRADE",
          cost: 0,
        },
      });

      const txn = await tx.transaction.create({
        data: {
          seasonId: season.id,
          seasonYear: CURRENT_SEASON_YEAR,
          type: "TRADE",
          notes: `Traded from ${asset.fromTeamId === trade.teamAId ? trade.teamA.name : trade.teamB.name} to ${asset.toTeamId === trade.teamAId ? trade.teamA.name : trade.teamB.name}`,
        },
      });
      await tx.transactionPlayer.create({ data: { transactionId: txn.id, playerId: asset.playerId } });
      await tx.transactionTeam.createMany({
        data: [
          { transactionId: txn.id, teamId: asset.fromTeamId, role: "FROM" },
          { transactionId: txn.id, teamId: asset.toTeamId, role: "TO" },
        ],
      });
    }
  });

  for (const asset of trade.assets) {
    if (asset.assetType === "PLAYER" && asset.playerId) {
      await recomputeKeeperRecordsForPlayer(asset.playerId, CURRENT_SEASON_YEAR);
    }
  }

  await notifyManagers(
    [trade.proposerId, trade.teamA.managerId, trade.teamB.managerId].filter((v, i, arr) => arr.indexOf(v) === i),
    {
      type: "TRADE_ACCEPTED",
      title: `Trade accepted: ${trade.teamA.name} ↔ ${trade.teamB.name}`,
      body: "The trade has gone through and rosters are updated.",
      link: "/trades",
      relatedEntityType: "Trade",
      relatedEntityId: trade.id,
    }
  );
}
