import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { runYahooSync } from "@/lib/yahoo/sync";
import { notifyManagers } from "@/lib/notifications";
import { requireCommissioner } from "@/lib/current-manager";

export async function POST() {
  if (!(await requireCommissioner())) {
    return NextResponse.json({ error: "Commissioner access required" }, { status: 403 });
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
