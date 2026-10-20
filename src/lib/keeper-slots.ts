/**
 * The one definition of "Keepers x/N" (KEEPER_SLOT_COUNT): the keepers a
 * team declared at the season's keeper deadline. A row counts against its
 * startTeam - the team whose slot and budget it used - whether or not the
 * player was later traded away or DROPPED, since the slot was spent at the
 * deadline. Year-0 rows (in-season pickups) never used a slot, and neither
 * does a FORCED_BACK row: that player went back into the draft. Older rows
 * without a startTeam count against the team holding them.
 */

import type { Prisma } from "@prisma/client";
import { prisma } from "./db";

/** Where-clause for the keeper slots declared in a season (by one team, if given). */
export function declaredKeeperWhere(seasonYear: number, teamId?: string): Prisma.KeeperRecordWhereInput {
  const where: Prisma.KeeperRecordWhereInput = { seasonYear, keeperYear: { gte: 1 }, status: { not: "FORCED_BACK" } };
  if (teamId) where.OR = [{ startTeamId: teamId }, { startTeamId: null, teamId }];
  return where;
}

/** The team a declared keeper's slot counts against. */
export function keeperSlotTeamId(r: { startTeamId: string | null; teamId: string }): string {
  return r.startTeamId ?? r.teamId;
}

/** Declared keeper count per team id for a season; teams with none are absent. */
export async function countDeclaredKeepers(seasonYear: number): Promise<Map<string, number>> {
  const rows = await prisma.keeperRecord.findMany({
    where: declaredKeeperWhere(seasonYear),
    select: { startTeamId: true, teamId: true },
  });
  const counts = new Map<string, number>();
  for (const r of rows) {
    const id = keeperSlotTeamId(r);
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
}
