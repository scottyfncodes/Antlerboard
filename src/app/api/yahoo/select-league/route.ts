import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getCurrentManager, requireCommissioner } from "@/lib/current-manager";

export async function POST(req: Request) {
  if (!(await requireCommissioner())) {
    return NextResponse.json({ error: "Commissioner access required" }, { status: 403 });
  }

  const { leagueKey, gameKey } = await req.json();
  const league = await prisma.league.findFirst();
  if (!league) return NextResponse.json({ error: "No league configured" }, { status: 500 });

  const before = await prisma.yahooConnection.findUnique({ where: { leagueId: league.id }, select: { yahooLeagueKey: true, yahooGameKey: true } });
  await prisma.yahooConnection.update({
    where: { leagueId: league.id },
    data: { yahooLeagueKey: leagueKey, yahooGameKey: gameKey },
  });
  // Selecting the league is what makes the connection eligible for the
  // scheduled sync, so it's recorded (no tokens - only the league keys).
  const actor = await getCurrentManager();
  await prisma.auditLogEntry.create({
    data: {
      actorName: actor?.name ?? "Commissioner",
      action: "YAHOO_LEAGUE_SELECTED",
      entityType: "YahooConnection",
      isHistoricalCorrection: false,
      before: before ?? undefined,
      after: { yahooLeagueKey: leagueKey, yahooGameKey: gameKey },
    },
  });

  return NextResponse.json({ ok: true });
}
