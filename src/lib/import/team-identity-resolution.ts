import type { Prisma } from "@prisma/client";

type Db = Prisma.TransactionClient;

function normalizeManagerName(name: string): string {
  return name.replace(/\s+/g, "").toLowerCase();
}

/**
 * Resolves a manager name exactly as one of the workbook's sheets records
 * it - the FYPD and prop-bet sheets both identify a "team" by a manager's
 * first name, current or historical (e.g. "Aaron", or a departed
 * predecessor like "Drew"), never by the team's own name - to whichever
 * Team that person actually ran *in that specific season*, via the
 * TeamSeasonRecord ledger the main historical import writes. Matching
 * against a team's current name would be wrong here: these sheets never
 * use team names in the first place, and even if they did, a team's name
 * changes over time while TeamSeasonRecord keeps the season-accurate one.
 *
 * Names are compared with whitespace stripped and case-insensitively
 * ("Matty J" in the FYPD sheet vs. the "MattyJ" tab/manager name is a
 * real quirk in the source workbook, not a typo to "fix" - both spellings
 * mean the same person).
 *
 * Returns null - never a guess - when there's no manager by that name, or
 * that manager has no TeamSeasonRecord for that exact season (e.g. a bet
 * dated for a year before/after that person actually ran a team).
 */
export async function resolveTeamIdByManagerAndYear(
  db: Db,
  leagueId: string,
  managerName: string | null,
  seasonYear: number | null
): Promise<string | null> {
  if (!managerName || seasonYear === null) return null;

  const managers = await db.manager.findMany({ where: { leagueId } });
  const target = normalizeManagerName(managerName);
  const manager = managers.find((m) => normalizeManagerName(m.name) === target);
  if (!manager) return null;

  const record = await db.teamSeasonRecord.findFirst({ where: { managerId: manager.id, seasonYear } });
  return record?.teamId ?? null;
}

/**
 * Resolves a manager name to whichever Team that manager *currently* runs
 * - for sheets like FYPD, where the "team" column is always the current
 * owner's name regardless of which season the pick happened in (FYPD
 * grants a forward-looking right to call the player up, so it's the
 * franchise's present-day owner who holds that right - not whoever ran
 * the franchise the year the pick was actually made). Using the
 * season-scoped resolveTeamIdByManagerAndYear here would incorrectly
 * skip perfectly valid picks: e.g. a 2024 FYPD pick recorded under
 * "Neel" fails a TeamSeasonRecord lookup for 2024, since Neel didn't
 * take that franchise over until 2025 - but the pick is still Neel's by
 * the sheet's own convention.
 */
export async function resolveTeamIdByCurrentManagerName(db: Db, leagueId: string, managerName: string | null): Promise<string | null> {
  if (!managerName) return null;

  const managers = await db.manager.findMany({ where: { leagueId }, include: { teams: true } });
  const target = normalizeManagerName(managerName);
  const manager = managers.find((m) => normalizeManagerName(m.name) === target);
  return manager?.teams[0]?.id ?? null;
}
