/**
 * Trade Center state machine. Pulled out of the API route so it can be
 * unit tested directly against the database and reused without
 * duplicating the propose/accept/reject/counter/withdraw logic.
 *
 * A trade has 2-4 participating teams. The proposing team's participant
 * row starts ACCEPTED; each other team accepts or rejects. The trade only
 * executes (players move, transactions are logged) once every participant
 * has accepted, and a single rejection ends it. Who is *allowed* to call
 * each of these is decided by src/lib/trade-access.ts, in the API route.
 */

import { prisma } from "./db";
import { notifyManagers } from "./notifications";
import { recomputeKeeperRecordsForPlayer } from "./keeper-sync";
import { CURRENT_SEASON_YEAR } from "./config";
import { tradeProposalProblem, type TradeAssetInput } from "./trade-proposal";

export class TradeActionError extends Error {}

const TRADE_INCLUDE = {
  participants: { include: { team: { include: { manager: true } } } },
  assets: true,
} as const;

async function loadTrade(id: string) {
  const trade = await prisma.trade.findUnique({ where: { id }, include: TRADE_INCLUDE });
  if (!trade) throw new TradeActionError("Trade not found");
  return trade;
}

type LoadedTrade = Awaited<ReturnType<typeof loadTrade>>;

function assertOpen(trade: LoadedTrade) {
  if (trade.status !== "PROPOSED") throw new TradeActionError("This trade is no longer open");
}

function participantFor(trade: LoadedTrade, teamId: string) {
  const p = trade.participants.find((x) => x.teamId === teamId);
  if (!p) throw new TradeActionError("That team isn't part of this trade");
  return p;
}

/** "A ↔ B ↔ C", proposing team first. */
export function tradeTitle(participants: { isProposer: boolean; team: { name: string } }[]): string {
  return [...participants]
    .sort((a, b) => Number(b.isProposer) - Number(a.isProposer))
    .map((p) => p.team.name)
    .join(" ↔ ");
}

function managerIdsExcept(trade: LoadedTrade, teamId?: string) {
  return [...new Set(trade.participants.filter((p) => p.teamId !== teamId).map((p) => p.team.managerId))];
}

export interface CreateTradeInput {
  proposerId: string;
  proposingTeamId: string;
  teamIds: string[];
  assets: TradeAssetInput[];
  notes?: string | null;
  parentTradeId?: string;
}

export async function createTrade(input: CreateTradeInput) {
  const problem = tradeProposalProblem(input);
  if (problem) throw new TradeActionError(problem);

  const season = await prisma.season.findFirst({ where: { year: CURRENT_SEASON_YEAR } });
  if (!season) throw new TradeActionError("No current season");

  const created = await prisma.trade.create({
    data: {
      seasonId: season.id,
      seasonYear: CURRENT_SEASON_YEAR,
      proposerId: input.proposerId,
      parentTradeId: input.parentTradeId,
      notes: input.notes?.trim() || null,
      status: "PROPOSED",
      participants: {
        create: [...new Set(input.teamIds)].map((teamId) => ({
          teamId,
          isProposer: teamId === input.proposingTeamId,
          response: teamId === input.proposingTeamId ? "ACCEPTED" : "PENDING",
          respondedAt: teamId === input.proposingTeamId ? new Date() : null,
        })),
      },
      assets: {
        create: input.assets.map((a) => ({
          fromTeamId: a.fromTeamId,
          toTeamId: a.toTeamId,
          assetType: a.assetType,
          playerId: a.assetType === "PLAYER" ? a.playerId : null,
          draftPickDescription: a.assetType === "DRAFT_PICK" ? a.draftPickDescription?.trim() : null,
        })),
      },
    },
  });

  const trade = await loadTrade(created.id);
  const multi = trade.participants.length > 2;
  await notifyManagers(managerIdsExcept(trade, input.proposingTeamId), {
    type: input.parentTradeId ? "TRADE_COUNTERED" : "TRADE_PROPOSED",
    title: `${input.parentTradeId ? "Counter-offer" : multi ? `${trade.participants.length}-team trade proposed` : "Trade proposed"}: ${tradeTitle(trade.participants)}`,
    body: trade.notes || "A trade proposal is waiting on you in the Trade Center.",
    link: "/trades",
    relatedEntityType: "Trade",
    relatedEntityId: trade.id,
  });
  return trade;
}

export async function withdrawTrade(id: string) {
  const trade = await loadTrade(id);
  assertOpen(trade);
  await prisma.trade.update({ where: { id }, data: { status: "WITHDRAWN" } });
}

export async function rejectTrade(id: string, teamId: string) {
  const trade = await loadTrade(id);
  assertOpen(trade);
  const participant = participantFor(trade, teamId);
  await prisma.$transaction([
    prisma.tradeParticipant.update({
      where: { id: participant.id },
      data: { response: "REJECTED", respondedAt: new Date() },
    }),
    prisma.trade.update({ where: { id }, data: { status: "REJECTED" } }),
  ]);
  await notifyManagers(managerIdsExcept(trade, teamId), {
    type: "TRADE_REJECTED",
    title: `Trade rejected: ${tradeTitle(trade.participants)}`,
    body: `${participant.team.name} rejected the trade.`,
    link: "/trades",
    relatedEntityType: "Trade",
    relatedEntityId: trade.id,
  });
}

/**
 * Records `teamId`'s acceptance. Returns true when that was the last
 * outstanding acceptance and the trade has now executed.
 */
export async function acceptTrade(id: string, teamId: string): Promise<boolean> {
  const trade = await loadTrade(id);
  assertOpen(trade);
  const participant = participantFor(trade, teamId);
  if (participant.response === "ACCEPTED") throw new TradeActionError("You've already accepted this trade");

  const stillWaiting = trade.participants.filter((p) => p.teamId !== teamId && p.response !== "ACCEPTED");

  if (stillWaiting.length > 0) {
    await prisma.tradeParticipant.update({
      where: { id: participant.id },
      data: { response: "ACCEPTED", respondedAt: new Date() },
    });
    await notifyManagers(managerIdsExcept(trade, teamId), {
      type: "TRADE_ACCEPTED",
      title: `${participant.team.name} accepted: ${tradeTitle(trade.participants)}`,
      body: `Still waiting on ${stillWaiting.map((p) => p.team.name).join(", ")}.`,
      link: "/trades",
      relatedEntityType: "Trade",
      relatedEntityId: trade.id,
    });
    return false;
  }

  await executeTrade(trade, participant.id);
  return true;
}

async function executeTrade(trade: LoadedTrade, finalParticipantId: string) {
  const season = await prisma.season.findFirst({ where: { year: CURRENT_SEASON_YEAR } });
  if (!season) throw new TradeActionError("No current season");
  const teamName = new Map(trade.participants.map((p) => [p.teamId, p.team.name]));

  await prisma.$transaction(async (tx) => {
    // Guard against two last acceptances racing: only one request gets to
    // flip PROPOSED -> ACCEPTED and move the players.
    const flipped = await tx.trade.updateMany({ where: { id: trade.id, status: "PROPOSED" }, data: { status: "ACCEPTED" } });
    if (flipped.count === 0) throw new TradeActionError("This trade is no longer open");

    // The same player can sit in more than one open proposal. If another
    // deal already moved him, this one can't go through as written.
    const playerIds = trade.assets.flatMap((a) => (a.assetType === "PLAYER" && a.playerId ? [a.playerId] : []));
    const current = await tx.keeperRecord.findMany({
      where: { seasonYear: CURRENT_SEASON_YEAR, playerId: { in: playerIds } },
      include: { player: true },
    });
    for (const record of current) {
      const asset = trade.assets.find((a) => a.playerId === record.playerId)!;
      if (record.teamId !== asset.fromTeamId) {
        throw new TradeActionError(
          `${record.player.name} is no longer on ${teamName.get(asset.fromTeamId)}'s roster - this trade can't go through as proposed`
        );
      }
    }
    await tx.tradeParticipant.update({
      where: { id: finalParticipantId },
      data: { response: "ACCEPTED", respondedAt: new Date() },
    });

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
          notes: `Traded from ${teamName.get(asset.fromTeamId)} to ${teamName.get(asset.toTeamId)}`,
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

  await notifyManagers(managerIdsExcept(trade), {
    type: "TRADE_ACCEPTED",
    title: `Trade accepted: ${tradeTitle(trade.participants)}`,
    body: "Every team has accepted - the trade has gone through and rosters are updated.",
    link: "/trades",
    relatedEntityType: "Trade",
    relatedEntityId: trade.id,
  });
}

/**
 * Marks `id` COUNTERED and creates the replacement proposal (linked via
 * parentTradeId) from the countering team, sent to everyone else.
 */
export async function counterTrade(
  id: string,
  counter: Omit<CreateTradeInput, "parentTradeId">
) {
  const trade = await loadTrade(id);
  assertOpen(trade);
  participantFor(trade, counter.proposingTeamId);
  const problem = tradeProposalProblem(counter);
  if (problem) throw new TradeActionError(problem);

  await prisma.trade.update({ where: { id }, data: { status: "COUNTERED" } });
  return createTrade({ ...counter, parentTradeId: id });
}
