import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { runYahooSync } from "@/lib/yahoo/sync";
import { notifyManagers } from "@/lib/notifications";
import { requireCommissioner } from "@/lib/current-manager";
import { isYahooConfigured } from "@/lib/yahoo/client";

// Twelve roster requests plus retries on Yahoo rate limits can outrun the
// default function timeout.
export const maxDuration = 120;

export async function POST() {
  if (!(await requireCommissioner())) {
    return NextResponse.json({ error: "Commissioner access required" }, { status: 403 });
  }

  // Preview deployments share the production database but don't carry the
  // Yahoo env vars. A stored access token still works there until it
  // expires, so without this check a Preview build (possibly running older
  // sync code) writes into production data - the page there already shows
  // the "isn't configured in this environment" warning.
  if (!isYahooConfigured()) {
    return NextResponse.json(
      { status: "FAILED", error: "Yahoo isn't configured in this environment - sync from the production site." },
      { status: 503 }
    );
  }

  const league = await prisma.league.findFirst();
  if (!league) return NextResponse.json({ error: "No league configured" }, { status: 500 });

  try {
    const result = await runYahooSync(league.id);

    if (result.status === "FAILED") {
      const managers = await prisma.manager.findMany();
      await notifyManagers(managers.map((m) => m.id), {
        type: "SYNC_FAILED",
        title: "Yahoo sync failed",
        body: result.sections.map((s) => s.error).filter(Boolean).join("; ") || "Unknown error",
        link: "/commissioner/yahoo",
      });
    }

    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { status: "FAILED", error: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 }
    );
  }
}
