import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireCommissioner } from "@/lib/current-manager";

export async function POST() {
  if (!(await requireCommissioner())) {
    return NextResponse.json({ error: "Commissioner access required" }, { status: 403 });
  }

  const league = await prisma.league.findFirst();
  if (!league) return NextResponse.json({ error: "No league configured" }, { status: 500 });

  await prisma.yahooConnection.update({
    where: { leagueId: league.id },
    data: {
      accessToken: null,
      refreshToken: null,
      tokenExpiresAt: null,
      yahooGuid: null,
      yahooLeagueKey: null,
      yahooGameKey: null,
      lastSyncStatus: "NEVER_RUN",
    },
  });

  return NextResponse.json({ ok: true });
}
