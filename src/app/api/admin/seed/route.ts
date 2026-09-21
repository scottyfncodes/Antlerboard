import { NextResponse } from "next/server";
import { runSeed } from "@/lib/db-seed";

/**
 * One-off/manual re-seed endpoint. Exists because some database providers
 * (Vercel's Postgres/Neon marketplace integration in particular) only ever
 * expose their real connection string inside a running Vercel build or
 * deployment - never through the Management API, and never to an external
 * script. Running the seed through this route, from inside the deployment
 * itself, is the only way to populate that kind of database at all.
 *
 * Gated behind CRON_SECRET (already a private secret nobody but the
 * commissioner has) rather than adding a new one for a rarely-used route.
 */
export async function POST(req: Request) {
  const auth = req.headers.get("authorization");
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
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
