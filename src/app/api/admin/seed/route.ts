import { NextResponse } from "next/server";
import { runSeed } from "@/lib/db-seed";
import { isAuthorizedCronRequest } from "@/lib/cron-auth";

/**
 * One-off/manual re-seed endpoint for a brand-new, empty database. Exists
 * because some database providers (Vercel's Postgres/Neon marketplace
 * integration in particular) only ever expose their real connection string
 * inside a running Vercel build or deployment.
 *
 * The seed wipes ~30 tables, so it never runs on a deployed environment:
 * Production holds the real league, and Preview deployments share
 * Production's database. Gated behind CRON_SECRET as well.
 */
export async function POST(req: Request) {
  if (!isAuthorizedCronRequest(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (process.env.VERCEL_ENV) {
    return NextResponse.json(
      { error: "The demo seed is disabled on deployed environments: it would wipe the league's data." },
      { status: 403 }
    );
  }

  try {
    await runSeed();
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("Manual seed failed", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 }
    );
  }
}
