/**
 * The Vercel Cron side of the Yahoo sync (see /api/cron/yahoo-sync and
 * vercel.json). Every authenticated scheduled run writes one AuditLogEntry
 * saying what it did - including the runs that sync nothing (no eligible
 * connection, or skipped because the last attempt was too recent). Without
 * that, a scheduled run that did nothing left no trace, so "the cron never
 * fired" and "the cron fired with nothing to do" looked identical.
 *
 * A run that does sync is also recorded by its SyncLog row; the audit entry
 * names that row, which is how a SyncLog is attributed to the schedule
 * rather than to a commissioner's "Sync Now".
 */

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { runYahooSync } from "./sync";

export const SCHEDULED_SYNC_ACTION = "YAHOO_SYNC_CRON";

export type ScheduledSyncOutcome =
  | { leagueId: string; outcome: "synced"; status: string; syncLogId: string | null; totalRecordsUpdated: number }
  | { leagueId: string; outcome: "skipped"; reason: string; minutesSinceLastAttempt: number }
  /** runYahooSync threw before finishing (e.g. no league selected); per-section Yahoo errors come back as a FAILED/PARTIAL "synced" outcome with its SyncLog. */
  | { leagueId: string; outcome: "failed"; error: string };

/**
 * Neon suspends an idle compute, and the cron is usually its first request of
 * the day. A start normally takes under a second, but on 2026-10-20 it took
 * 8.4 s, the first query timed out after 10 s and the day's sync never ran
 * (nor left an audit entry). So the run waits for the database first,
 * retrying only connection failures.
 */
export async function waitForDatabase(attempts = 4, pauseMs = 3_000) {
  for (let attempt = 1; ; attempt++) {
    try {
      await prisma.$queryRaw`SELECT 1`;
      return;
    } catch (err) {
      if (!(err instanceof Prisma.PrismaClientInitializationError) || attempt >= attempts) throw err;
      console.warn(`Database not reachable yet (attempt ${attempt} of ${attempts}); retrying`);
      await new Promise((resolve) => setTimeout(resolve, pauseMs));
    }
  }
}

export async function runScheduledYahooSync(now: Date = new Date()) {
  await waitForDatabase();
  const connections = await prisma.yahooConnection.findMany({
    where: { yahooLeagueKey: { not: null }, accessToken: { not: null } },
  });

  const results: ScheduledSyncOutcome[] = [];
  for (const connection of connections) {
    // Honors each connection's configured interval so a manual "Sync Now"
    // shortly before the schedule isn't immediately repeated.
    if (connection.lastSyncAttemptAt) {
      const elapsedMs = now.getTime() - connection.lastSyncAttemptAt.getTime();
      const minutesSinceLastAttempt = Math.floor(elapsedMs / 60_000);
      if (elapsedMs <= connection.syncIntervalMinutes * 60_000) {
        results.push({
          leagueId: connection.leagueId,
          outcome: "skipped",
          reason: `Last attempt ${minutesSinceLastAttempt} min ago; interval is ${connection.syncIntervalMinutes} min.`,
          minutesSinceLastAttempt,
        });
        continue;
      }
    }

    try {
      const result = await runYahooSync(connection.leagueId);
      results.push({
        leagueId: connection.leagueId,
        outcome: "synced",
        status: result.status,
        syncLogId: result.syncLogId ?? null,
        totalRecordsUpdated: result.totalRecordsUpdated,
      });
    } catch (err) {
      results.push({
        leagueId: connection.leagueId,
        outcome: "failed",
        error: err instanceof Error ? err.message : "Unknown error",
      });
    }
  }

  // Best effort: a failure to write the evidence must not turn a good sync
  // into a failed cron response.
  try {
    await prisma.auditLogEntry.create({
      data: {
        actorName: "Vercel Cron",
        action: SCHEDULED_SYNC_ACTION,
        entityType: "YahooConnection",
        isHistoricalCorrection: false,
        after: {
          ranAt: now.toISOString(),
          eligibleConnections: connections.length,
          results,
        },
      },
    });
  } catch (err) {
    console.error("Could not record the scheduled Yahoo sync run", err instanceof Error ? err.message : err);
  }

  return results;
}
