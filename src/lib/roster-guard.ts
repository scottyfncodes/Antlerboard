/**
 * Roster checks shared by trades and offers: is each player really on the
 * team that's giving him up, and can two deals move the same player at once?
 *
 * A player's current team comes from getCurrentHolders (src/lib/rosters.ts):
 * the season's Yahoo roster snapshot, adjusted for TRADE acquisitions agreed
 * in Antlerboard since that snapshot - or, for a season with no Yahoo
 * rosters, his one live keeper stint. A deal writes its TRADE acquisitions
 * (and rebuilds keeper records) inside the transaction that holds the
 * players' locks, so the next deal to take those locks sees the new owner
 * and can't move the same player again.
 */

import type { Prisma, PrismaClient } from "@prisma/client";
import { CURRENT_SEASON_YEAR } from "./config";
import { getCurrentHolders } from "./rosters";

type Db = PrismaClient | Prisma.TransactionClient;

export interface PlayerMove {
  playerId: string;
  fromTeamId: string;
}

/**
 * Takes a transaction-scoped advisory lock per player, in a fixed order so
 * two deals sharing players can't deadlock. Any other deal touching one of
 * these players waits until this transaction commits or rolls back.
 */
export async function lockPlayers(tx: Prisma.TransactionClient, playerIds: string[]): Promise<void> {
  for (const id of [...new Set(playerIds)].sort()) {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${id}))::text`;
  }
}

/**
 * The first move whose player isn't on `fromTeamId` right now - no live
 * stint (dropped, never rostered, unknown id), more than one, or a live
 * stint on another team - or null when every move checks out.
 */
export async function firstOffRosterMove(db: Db, moves: PlayerMove[]): Promise<(PlayerMove & { playerName: string }) | null> {
  if (moves.length === 0) return null;
  const playerIds = [...new Set(moves.map((m) => m.playerId))];
  const players = await db.player.findMany({ where: { id: { in: playerIds } }, select: { id: true, name: true, leagueId: true } });
  const player = new Map(players.map((p) => [p.id, p]));

  // Each player's holder is resolved within his own league, so a player
  // from another league can never count as held by the sending team.
  const holders = new Map<string, string>();
  for (const leagueId of new Set(players.map((p) => p.leagueId))) {
    const ids = players.filter((p) => p.leagueId === leagueId).map((p) => p.id);
    for (const [id, teamId] of await getCurrentHolders(db, leagueId, CURRENT_SEASON_YEAR, ids)) holders.set(id, teamId);
  }

  for (const move of moves) {
    if (!player.has(move.playerId) || holders.get(move.playerId) !== move.fromTeamId) {
      return { ...move, playerName: player.get(move.playerId)?.name ?? "A player" };
    }
  }
  return null;
}

/** Row lock on one Trade or Offer, so every action on it runs one at a time. */
export async function lockRow(tx: Prisma.TransactionClient, table: "Trade" | "Offer", id: string): Promise<void> {
  if (table === "Trade") await tx.$queryRaw`SELECT id FROM "Trade" WHERE id = ${id} FOR UPDATE`;
  else await tx.$queryRaw`SELECT id FROM "Offer" WHERE id = ${id} FOR UPDATE`;
}
