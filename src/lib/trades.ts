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

import type { Prisma } from "@prisma/client";
import { prisma } from "./db";
import { notifyManagers } from "./notifications";
import { recomputeKeeperRecordsForPlayer } from "./keeper-sync";
import { CURRENT_SEASON_YEAR } from "./config";
import { tradeProposalProblem, type TradeAssetInput } from "./trade-proposal";
import { firstOffRosterMove, lockPlayers, lockRow } from "./roster-guard";

export class TradeActionError extends Error {}

const TRADE_INCLUDE = {
  // Returned by POST /api/trades - names only, never a manager's email.
  participants: { include: { team: { include: { manager: { select: { id: true, name: true } } } } } },
  assets: true,
} as const;

async function loadTrade(id: string) {
  const trade = await prisma.trade.findUnique({ where: { id }, include: TRADE_INCLUDE });
  if (!trade) throw new TradeActionError("Trade not found");
  return trade;
}

type LoadedTrade = Awaited<ReturnType<typeof loadTrade>>;

// Executing a trade rebuilds keeper records inside the transaction.
const TX_OPTIONS = { timeout: 30_000 };

/**
 * Locks the trade row and reads it fresh, so reject / withdraw / accept /
 * counter on the same trade run one at a time against its current state.
 */
async function loadTradeForUpdate(tx: Prisma.TransactionClient, id: string): Promise<LoadedTrade> {
  await lockRow(tx, "Trade", id);
  const trade = await tx.trade.findUnique({ where: { id }, include: TRADE_INCLUDE });
  if (!trade) throw new TradeActionError("Trade not found");
  return trade;
}

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

/** Shape, team and roster checks for a new proposal; returns the current season. */
async function validateProposal(input: CreateTradeInput) {
  const problem = tradeProposalProblem(input);
  if (problem) throw new TradeActionError(problem);

  const season = await prisma.season.findFirst({ where: { year: CURRENT_SEASON_YEAR } });
  if (!season) throw new TradeActionError("No current season");

  const teamIds = [...new Set(input.teamIds)];
  const teams = await prisma.team.findMany({ where: { id: { in: teamIds } }, select: { id: true, name: true, active: true } });
  if (teams.length !== teamIds.length || teams.some((t) => !t.active)) {
    throw new TradeActionError("Every team in the trade has to be an active team in the league");
  }

  const offRoster = await firstOffRosterMove(prisma, playerMoves(input.assets));
  if (offRoster) {
    const team = teams.find((t) => t.id === offRoster.fromTeamId)!;
    throw new TradeActionError(`${offRoster.playerName} isn't on ${team.name}'s roster`);
  }
  return season;
}

function playerMoves(assets: { assetType: string; playerId?: string | null; fromTeamId: string }[]) {
  return assets.flatMap((a) => (a.assetType === "PLAYER" && a.playerId ? [{ playerId: a.playerId, fromTeamId: a.fromTeamId }] : []));
}

async function insertTrade(db: Prisma.TransactionClient | typeof prisma, input: CreateTradeInput, seasonId: string) {
  return db.trade.create({
    data: {
      seasonId,
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
}

async function notifyProposal(tradeId: string, input: CreateTradeInput) {
  const trade = await loadTrade(tradeId);
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

export async function createTrade(input: CreateTradeInput) {
  const season = await validateProposal(input);
  const created = await insertTrade(prisma, input, season.id);
  return notifyProposal(created.id, input);
}

export async function withdrawTrade(id: string) {
  await prisma.$transaction(async (tx) => {
    const trade = await loadTradeForUpdate(tx, id);
    assertOpen(trade);
    await tx.trade.update({ where: { id }, data: { status: "WITHDRAWN" } });
  });
}

export async function rejectTrade(id: string, teamId: string) {
  const { trade, participant } = await prisma.$transaction(async (tx) => {
    const trade = await loadTradeForUpdate(tx, id);
    assertOpen(trade);
    const participant = participantFor(trade, teamId);
    await tx.tradeParticipant.update({
      where: { id: participant.id },
      data: { response: "REJECTED", respondedAt: new Date() },
    });
    await tx.trade.update({ where: { id }, data: { status: "REJECTED" } });
    return { trade, participant };
  });
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
 * outstanding acceptance and the trade has now executed. The acceptance and
 * the execution happen in one transaction with the trade row locked, so two
 * teams accepting at the same moment can't both see the other as pending.
 */
export async function acceptTrade(id: string, teamId: string): Promise<boolean> {
  const { trade, participant, stillWaiting } = await prisma.$transaction(async (tx) => {
    const trade = await loadTradeForUpdate(tx, id);
    assertOpen(trade);
    const participant = participantFor(trade, teamId);
    if (participant.response === "ACCEPTED") throw new TradeActionError("You've already accepted this trade");

    await tx.tradeParticipant.update({
      where: { id: participant.id },
      data: { response: "ACCEPTED", respondedAt: new Date() },
    });
    const stillWaiting = trade.participants.filter((p) => p.teamId !== teamId && p.response !== "ACCEPTED");
    if (stillWaiting.length === 0) await executeTrade(tx, trade);
    return { trade, participant, stillWaiting };
  }, TX_OPTIONS);

  if (stillWaiting.length > 0) {
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

  await notifyManagers(managerIdsExcept(trade), {
    type: "TRADE_ACCEPTED",
    title: `Trade accepted: ${tradeTitle(trade.participants)}`,
    body: "Every team has accepted - the trade has gone through and rosters are updated.",
    link: "/trades",
    relatedEntityType: "Trade",
    relatedEntityId: trade.id,
  });
  return true;
}

/** Moves the players. Runs inside acceptTrade's transaction. */
async function executeTrade(tx: Prisma.TransactionClient, trade: LoadedTrade) {
  const season = await tx.season.findFirst({ where: { year: CURRENT_SEASON_YEAR } });
  if (!season) throw new TradeActionError("No current season");
  const teamName = new Map(trade.participants.map((p) => [p.teamId, p.team.name]));

  const flipped = await tx.trade.updateMany({ where: { id: trade.id, status: "PROPOSED" }, data: { status: "ACCEPTED" } });
  if (flipped.count === 0) throw new TradeActionError("This trade is no longer open");

  // The same player can sit in more than one open proposal, or have been
  // dropped since this one was proposed. Lock him so no other deal can move
  // him until this one commits, then confirm he's still on the sending team.
  const moves = playerMoves(trade.assets);
  await lockPlayers(tx, moves.map((m) => m.playerId));
  const offRoster = await firstOffRosterMove(tx, moves);
  if (offRoster) {
    throw new TradeActionError(
      `${offRoster.playerName} is no longer on ${teamName.get(offRoster.fromTeamId)}'s roster - this trade can't go through as proposed`
    );
  }

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

  // Rebuilt before commit, so the next deal to take these players' locks
  // sees the new owner.
  for (const { playerId } of moves) {
    await recomputeKeeperRecordsForPlayer(playerId, CURRENT_SEASON_YEAR, tx);
  }
}

/**
 * Marks `id` COUNTERED and creates the replacement proposal (linked via
 * parentTradeId) from the countering team, sent to everyone else.
 */
export async function counterTrade(
  id: string,
  counter: Omit<CreateTradeInput, "parentTradeId">
) {
  const input = { ...counter, parentTradeId: id };
  const season = await validateProposal(input);

  // Closing the original and creating the counter commit together - a
  // counter that fails to save leaves the original open.
  const created = await prisma.$transaction(async (tx) => {
    const trade = await loadTradeForUpdate(tx, id);
    assertOpen(trade);
    participantFor(trade, counter.proposingTeamId);
    await tx.trade.update({ where: { id }, data: { status: "COUNTERED" } });
    return insertTrade(tx, input, season.id);
  });
  return notifyProposal(created.id, input);
}
