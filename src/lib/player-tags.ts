/**
 * Self-service player tagging for My Team - lets a manager tag their own
 * roster without going through the commissioner/CSV-import path. Reuses the
 * existing PlayerTagType vocabulary rather than inventing a parallel one.
 *
 * Deliberately restricted to a subset of tags a manager should be choosing
 * for themselves: FORCED_BACK and RECENTLY_ACQUIRED are system-derived
 * facts (computed by the keeper engine / roster-move sync), not opinions a
 * manager expresses, so they're excluded here.
 */

import { prisma } from "./db";
import type { PlayerTagType } from "@prisma/client";

export class PlayerTagActionError extends Error {}

export const MANAGER_SELECTABLE_TAGS: PlayerTagType[] = [
  "KEEPING",
  "ON_THE_TABLE",
  "OPEN_TO_DISCUSS",
  "AVAILABLE",
  "NEEDS_DECISION",
];

/**
 * Sets (or clears, when `tag` is null) the tag a manager has put on one of
 * their own players. Verifies the player is actually on one of the
 * manager's teams before writing anything - a manager can only speak for
 * their own roster.
 */
export async function setOwnPlayerTag(
  managerId: string,
  playerId: string,
  tag: PlayerTagType | null,
  note?: string
): Promise<void> {
  if (tag && !MANAGER_SELECTABLE_TAGS.includes(tag)) {
    throw new PlayerTagActionError(`${tag} cannot be set by a manager directly.`);
  }

  const keeperRecord = await prisma.keeperRecord.findFirst({
    where: { playerId, team: { managerId } },
    orderBy: { seasonYear: "desc" },
  });
  if (!keeperRecord) {
    throw new PlayerTagActionError("That player is not on one of your rosters.");
  }

  if (tag === null) {
    await prisma.playerTag.deleteMany({ where: { playerId, teamId: keeperRecord.teamId } });
    return;
  }

  await prisma.playerTag.upsert({
    where: { playerId_teamId: { playerId, teamId: keeperRecord.teamId } },
    create: { playerId, teamId: keeperRecord.teamId, tag, note },
    update: { tag, note },
  });
}
