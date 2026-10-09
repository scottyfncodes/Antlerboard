/**
 * Roster checks shared by trades and offers: is each player really on the
 * team that's giving him up, and can two deals move the same player at once?
 *
 * A player's current team is his one live (non-DROPPED) KeeperRecord for
 * the current season. Those rows are rebuilt from acquisitions, so a deal
 * must rebuild them inside the same transaction that writes its
 * acquisitions - otherwise a second deal can read the old owner and move
 * the same player again.
 */

import type { Prisma, PrismaClient } from "@prisma/client";
import { CURRENT_SEASON_YEAR } from "./config";

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
  const [live, players] = await Promise.all([
    db.keeperRecord.findMany({
      where: { seasonYear: CURRENT_SEASON_YEAR, playerId: { in: playerIds }, status: { not: "DROPPED" } },
      select: { playerId: true, teamId: true },
    }),
    db.player.findMany({ where: { id: { in: playerIds } }, select: { id: true, name: true } }),
  ]);
  const name = new Map(players.map((p) => [p.id, p.name]));

  for (const move of moves) {
    const stints = live.filter((r) => r.playerId === move.playerId);
    if (stints.length !== 1 || stints[0].teamId !== move.fromTeamId) {
      return { ...move, playerName: name.get(move.playerId) ?? "A player" };
    }
  }
  return null;
}

/** Row lock on one Trade or Offer, so every action on it runs one at a time. */
export async function lockRow(tx: Prisma.TransactionClient, table: "Trade" | "Offer", id: string): Promise<void> {
  if (table === "Trade") await tx.$queryRaw`SELECT id FROM "Trade" WHERE id = ${id} FOR UPDATE`;
  else await tx.$queryRaw`SELECT id FROM "Offer" WHERE id = ${id} FOR UPDATE`;
}
