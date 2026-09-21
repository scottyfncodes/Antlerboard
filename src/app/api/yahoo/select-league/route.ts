import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireCommissioner } from "@/lib/current-manager";

export async function POST(req: Request) {
  if (!(await requireCommissioner())) {
    return NextResponse.json({ error: "Commissioner access required" }, { status: 403 });
  }

  const { leagueKey, gameKey } = await req.json();
  const league = await prisma.league.findFirst();
  if (!league) return NextResponse.json({ error: "No league configured" }, { status: 500 });

  await prisma.yahooConnection.update({
    where: { leagueId: league.id },
    data: { yahooLeagueKey: leagueKey, yahooGameKey: gameKey },
  });

  return NextResponse.json({ ok: true });
}
