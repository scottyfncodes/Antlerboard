import { NextRequest, NextResponse } from "next/server";
import { runScheduledYahooSync } from "@/lib/yahoo/scheduled-sync";
import { isAuthorizedCronRequest } from "@/lib/cron-auth";
import { dispatchRecoveryPreflight, recordRecoveryDispatch } from "@/lib/recovery-preflight-dispatch";

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
 *
 * Once a league has synced, it starts the read-only recovery preflight on
 * GitHub (see recovery-preflight-dispatch.ts); that does nothing until its
 * token is configured.
 */
export async function GET(req: NextRequest) {
  if (!isAuthorizedCronRequest(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const results = await runScheduledYahooSync();
  const recoveryDispatch = results.some((r) => r.outcome === "synced")
    ? await dispatchRecoveryPreflight()
    : { status: "skipped" as const, reason: "nothing synced" };
  if (recoveryDispatch.status !== "skipped") await recordRecoveryDispatch(recoveryDispatch);
  return NextResponse.json({ results, recoveryDispatch });
}
