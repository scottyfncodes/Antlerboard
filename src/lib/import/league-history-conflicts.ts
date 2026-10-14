/**
 * Overlap between the league-history import and transactions the Yahoo
 * sync already recorded.
 *
 * The sync owns the transaction log of every season it has synced (today:
 * 2026, 907 rows). Its rows are keyed by Yahoo's transaction_key; the
 * import's Yahoo-derived events carry the same key in their sourceRef
 * ("yahoo:469.l.8891.tr.123"). Writing those events again would duplicate
 * transactions the league already has, so instead of guessing which copy
 * to keep, any overlap stops the import before it writes anything:
 *
 *  - the same transaction_key already synced;
 *  - any transaction from a Yahoo league (season) the sync already records,
 *    even one the sync hasn't reached yet - that season is the sync's;
 *  - moves reconstructed from the workbook's end-of-year rosters for a
 *    season the sync records (a preview built before the sync owned it).
 *
 * Matching is by Yahoo's own identifiers and season ownership, never by
 * dates or descriptions that merely look alike.
 */

import type { HistoryEvent } from "./league-history-builder";

export interface SyncedTransactionState {
  /** transaction_key of every synced row. */
  yahooTransactionIds: string[];
  /** Seasons with at least one synced row. */
  seasons: number[];
}

/** "469.l.8891.tr.123" -> "469.l.8891" (the Yahoo league, i.e. one season of it). */
export function yahooLeagueKeyOf(transactionKey: string): string | null {
  const m = transactionKey.match(/^(\d+\.l\.\d+)\.tr\.\d+$/);
  return m ? m[1] : null;
}

function yahooKeyOfEvent(e: Pick<HistoryEvent, "sourceRef">): string | null {
  return e.sourceRef.startsWith("yahoo:") ? e.sourceRef.slice("yahoo:".length) : null;
}

function eoySeasonOfEvent(e: Pick<HistoryEvent, "sourceRef">): number | null {
  const m = e.sourceRef.match(/^workbook:[^/]+\/(\d{4})\/eoy$/);
  return m ? Number(m[1]) : null;
}

export function findTransactionConflicts(events: Pick<HistoryEvent, "sourceRef">[], synced: SyncedTransactionState): string[] {
  const syncedIds = new Set(synced.yahooTransactionIds);
  const syncedLeagues = new Set(synced.yahooTransactionIds.map(yahooLeagueKeyOf).filter((k): k is string => !!k));
  const syncedSeasons = new Set(synced.seasons);

  const sameKey = new Set<string>();
  const sameLeague = new Map<string, Set<string>>();
  const eoySeasons = new Map<number, number>();
  for (const e of events) {
    const key = yahooKeyOfEvent(e);
    if (key) {
      if (syncedIds.has(key)) sameKey.add(key);
      const league = yahooLeagueKeyOf(key);
      if (league && syncedLeagues.has(league)) {
        if (!sameLeague.has(league)) sameLeague.set(league, new Set());
        sameLeague.get(league)!.add(key);
      }
      continue;
    }
    const eoy = eoySeasonOfEvent(e);
    if (eoy !== null && syncedSeasons.has(eoy)) eoySeasons.set(eoy, (eoySeasons.get(eoy) ?? 0) + 1);
  }

  const conflicts: string[] = [];
  if (sameKey.size > 0) {
    conflicts.push(`${sameKey.size} Yahoo transaction${sameKey.size === 1 ? " is" : "s are"} already recorded by the Yahoo sync (e.g. ${[...sameKey][0]}).`);
  }
  for (const [league, keys] of sameLeague) {
    conflicts.push(
      `The Yahoo export includes ${keys.size} transaction${keys.size === 1 ? "" : "s"} from league ${league}, a season the Yahoo sync already records. Export only the seasons before it.`
    );
  }
  for (const [season, n] of eoySeasons) {
    conflicts.push(`${n} move${n === 1 ? "" : "s"} for ${season} were reconstructed from end-of-year rosters, but the Yahoo sync already records ${season}. Rebuild the preview.`);
  }
  return conflicts;
}
