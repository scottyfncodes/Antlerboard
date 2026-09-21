import type { Prisma, PrismaClient } from "@prisma/client";

type Db = PrismaClient | Prisma.TransactionClient;

export interface DemoCleanupResult {
  managersDeleted: number;
  teamsDeleted: number;
  playersDeleted: number;
  seasonsDeleted: number;
}

/**
 * Retires everything under a league's current teams/managers/players/
 * seasons - meant for the one-time switch from Antlerboard's fictional
 * demo league to a commissioner's real historical import, run as part of
 * that same commit rather than as a separate step (see the historical
 * import UI). Leaves League, LeagueSettings, and AuditLogEntry alone (league
 * config and the audit trail survive), and leaves HistoricalTrade/
 * HistoricalPropBet/TeamSeasonRecord/FypdImportBatch alone since the
 * caller is about to (re)populate those in the same transaction.
 *
 * Every FK here is ON DELETE RESTRICT (see the init migration), so this
 * must delete children before parents - the order mirrors
 * test-helpers.ts's resetDatabase(), which already proves this ordering
 * works, scoped down to one league via relation filters.
 *
 * This is a blanket wipe of the league's operational data, not a
 * selective "remove only the fictional rows" pass - safe for the
 * intended one-time transition, but running it again after a real
 * import is already in place would erase that real data too.
 */
export async function clearLeagueOperationalData(db: Db, leagueId: string): Promise<DemoCleanupResult> {
  await db.syncLog.deleteMany({ where: { connection: { leagueId } } });
  await db.yahooConnection.deleteMany({ where: { leagueId } });
  await db.pushSubscription.deleteMany({ where: { manager: { leagueId } } });
  await db.notificationPreference.deleteMany({ where: { manager: { leagueId } } });
  await db.notification.deleteMany({ where: { manager: { leagueId } } });
  await db.dpudParticipant.deleteMany({ where: { manager: { leagueId } } });
  await db.dpudBetPlayer.deleteMany({ where: { bet: { season: { leagueId } } } });
  await db.dpudBet.deleteMany({ where: { season: { leagueId } } });
  await db.offer.deleteMany({ where: { sendingTeam: { leagueId } } });
  await db.tradeAsset.deleteMany({ where: { trade: { season: { leagueId } } } });
  await db.trade.deleteMany({ where: { season: { leagueId } } });
  await db.playerTag.deleteMany({ where: { team: { leagueId } } });
  await db.transactionTeam.deleteMany({ where: { transaction: { season: { leagueId } } } });
  await db.transactionPlayer.deleteMany({ where: { transaction: { season: { leagueId } } } });
  await db.transaction.deleteMany({ where: { season: { leagueId } } });
  await db.keeperRecord.deleteMany({ where: { season: { leagueId } } });
  await db.teamStanding.deleteMany({ where: { season: { leagueId } } });
  await db.draftPick.deleteMany({ where: { season: { leagueId } } });
  await db.fypdSelection.deleteMany({ where: { draft: { leagueId } } });
  await db.fypdDraftOrderSlot.deleteMany({ where: { draft: { leagueId } } });
  await db.fypdDraft.deleteMany({ where: { leagueId } });
  await db.acquisition.deleteMany({ where: { season: { leagueId } } });

  const { count: playersDeleted } = await db.player.deleteMany({ where: { leagueId } });
  const { count: teamsDeleted } = await db.team.deleteMany({ where: { leagueId } });
  const { count: managersDeleted } = await db.manager.deleteMany({ where: { leagueId } });

  await db.draftDayDetails.deleteMany({ where: { season: { leagueId } } });
  const { count: seasonsDeleted } = await db.season.deleteMany({ where: { leagueId } });

  return { managersDeleted, teamsDeleted, playersDeleted, seasonsDeleted };
}

/**
 * After clearLeagueOperationalData wipes every manager, nobody in the
 * league has isCommissioner set - and getCurrentManager()'s fallback
 * (see current-manager.ts) can't find anyone, locking every /commissioner
 * route for everyone until a row is fixed by hand. Rather than leave
 * that gap, match the outgoing commissioner's first name against the
 * real roster (e.g. the demo league's "Scott Lawrence" -> the real
 * league's "Scott") so the same person keeps access; fall back to the
 * first name alphabetically so a league is never left with zero
 * commissioners.
 */
export function pickContinuingCommissioner(
  outgoingCommissionerName: string | null | undefined,
  candidateManagerNames: string[]
): string | null {
  if (candidateManagerNames.length === 0) return null;
  const firstToken = outgoingCommissionerName?.trim().split(/\s+/)[0]?.toLowerCase();
  const match = firstToken ? candidateManagerNames.find((n) => n.toLowerCase() === firstToken) : undefined;
  return match ?? [...candidateManagerNames].sort((a, b) => a.localeCompare(b))[0];
}
