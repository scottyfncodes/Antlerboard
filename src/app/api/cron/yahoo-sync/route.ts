import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { runYahooSync } from "@/lib/yahoo/sync";

/**
 * Vercel Cron target - see vercel.json for the schedule. Protected by
 * CRON_SECRET so it can't be triggered by an arbitrary public request.
 * Skips leagues that haven't connected Yahoo yet, and honors each
 * connection's configured sync interval so it doesn't hammer Yahoo just
 * because the cron fires more often than the league wants to sync.
 */
export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const connections = await prisma.yahooConnection.findMany({
    where: { yahooLeagueKey: { not: null }, accessToken: { not: null } },
  });

  const results = [];
  for (const connection of connections) {
    const dueForSync =
      !connection.lastSyncAttemptAt ||
      Date.now() - connection.lastSyncAttemptAt.getTime() > connection.syncIntervalMinutes * 60_000;

    if (!dueForSync) {
      results.push({ leagueId: connection.leagueId, skipped: true });
      continue;
    }

    try {
      const result = await runYahooSync(connection.leagueId);
      results.push({ leagueId: connection.leagueId, ...result });
    } catch (err) {
      results.push({
        leagueId: connection.leagueId,
        status: "FAILED",
        error: err instanceof Error ? err.message : "Unknown error",
      });
    }
  }

  return NextResponse.json({ results });
}
