import { NextRequest, NextResponse } from "next/server";
import { runScheduledYahooSync } from "@/lib/yahoo/scheduled-sync";
import { isAuthorizedCronRequest } from "@/lib/cron-auth";

// Twelve roster requests plus retries on Yahoo rate limits can outrun the
// default function timeout.
export const maxDuration = 120;

/**
 * Vercel Cron target - see vercel.json for the schedule (12:00 UTC daily).
 * Vercel sends "Authorization: Bearer $CRON_SECRET"; without a configured
 * secret the route refuses every request rather than running for anyone.
 * Skips leagues that haven't connected Yahoo yet, honors each connection's
 * sync interval, and records every run in the audit log (see
 * runScheduledYahooSync) so a scheduled run is provable after the fact.
 */
export async function GET(req: NextRequest) {
  if (!isAuthorizedCronRequest(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const results = await runScheduledYahooSync();
  return NextResponse.json({ results });
}
