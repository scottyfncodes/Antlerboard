import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireCommissioner } from "@/lib/current-manager";

/**
 * Quick-add for an FYPD-eligible player (a U.S. MLB draftee), for use
 * before the historical spreadsheet import exists. Creates a normal
 * Player row with MLB draft pedigree fields populated - the same
 * canonical Player used everywhere else, not a separate prospect entity.
 */
export async function POST(req: Request) {
  if (!(await requireCommissioner())) {
    return NextResponse.json({ error: "Commissioner access required" }, { status: 403 });
  }

  const league = await prisma.league.findFirst();
  if (!league) return NextResponse.json({ error: "No league configured" }, { status: 500 });

  const { name, mlbDraftYear, mlbDraftRound, mlbDraftOverallPick, mlbOrganization, positions } = await req.json();
  if (!name) return NextResponse.json({ error: "name is required" }, { status: 400 });

  const player = await prisma.player.create({
    data: {
      leagueId: league.id,
      name,
      mlbDraftYear: mlbDraftYear ? Number(mlbDraftYear) : null,
      mlbDraftRound: mlbDraftRound ? Number(mlbDraftRound) : null,
      mlbDraftOverallPick: mlbDraftOverallPick ? Number(mlbDraftOverallPick) : null,
      mlbOrganization: mlbOrganization || null,
      positions: Array.isArray(positions) ? positions : [],
    },
  });

  return NextResponse.json({ player });
}
