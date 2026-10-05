import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getCurrentManager, requireCommissioner } from "@/lib/current-manager";
import { CURRENT_SEASON_YEAR } from "@/lib/config";
import { commitLeagueHistory } from "@/lib/import/league-history-commit";
import { buildResolver } from "@/lib/import/league-history-sources";
import type { LeagueHistoryPreview } from "@/lib/import/league-history-builder";

export const maxDuration = 300;

interface CommitBody extends LeagueHistoryPreview {
  applyRecordedKeeperCosts?: boolean;
}

/**
 * Writes the reviewed league-history preview. Like the other import
 * commit routes, this trusts the structured preview it is handed because
 * that preview only ever comes from the server-side /check step a
 * commissioner has just looked at. Runs in one transaction so a failure
 * never leaves half a history behind.
 */
export async function POST(req: Request) {
  if (!(await requireCommissioner())) {
    return NextResponse.json({ error: "Commissioner access required" }, { status: 403 });
  }
  const commissioner = await getCurrentManager();
  const league = await prisma.league.findFirst();
  if (!league) return NextResponse.json({ error: "No league configured" }, { status: 500 });

  const body = (await req.json()) as CommitBody;
  if (!Array.isArray(body.events) || !Array.isArray(body.players)) {
    return NextResponse.json({ error: "Expected a league-history preview body." }, { status: 400 });
  }

  const dbRecords = (await prisma.teamSeasonRecord.findMany({ where: { team: { leagueId: league.id } }, include: { team: { include: { manager: true } } } })).map((r) => ({
    managerSheetName: r.team.manager.name,
    seasonYear: r.seasonYear,
    teamName: r.teamName,
  }));
  const resolver = buildResolver([], dbRecords);

  try {
    const result = await prisma.$transaction(
      (tx) =>
        commitLeagueHistory(tx, league.id, body, {
          currentSeason: league.currentSeasonYear ?? CURRENT_SEASON_YEAR,
          applyRecordedKeeperCosts: body.applyRecordedKeeperCosts ?? true,
          actorName: commissioner?.name ?? null,
          resolver,
        }),
      { timeout: 280_000, maxWait: 15_000 }
    );
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Import failed." }, { status: 500 });
  }
}
