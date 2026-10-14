import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getCurrentManager, requireCommissioner } from "@/lib/current-manager";
import { CURRENT_SEASON_YEAR } from "@/lib/config";
import { commitLeagueHistory, LeagueHistoryConflictError } from "@/lib/import/league-history-commit";
import { verifyPreview } from "@/lib/import/preview-signature";
import { buildResolver } from "@/lib/import/league-history-sources";
import type { LeagueHistoryPreview } from "@/lib/import/league-history-builder";

export const maxDuration = 300;

interface CommitBody extends LeagueHistoryPreview {
  applyRecordedKeeperCosts?: boolean;
  previewToken?: string;
}

/**
 * Writes the reviewed league-history preview. The preview must carry the
 * signature /check gave it, so only a preview the server built from the
 * uploaded files - unedited - can be written. Database-side checks (player
 * identity, overlap with Yahoo-synced transactions) re-run inside the
 * transaction; any conflict stops it before the first write. Runs in one
 * transaction so a failure never leaves half a history behind.
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
  if (!verifyPreview(body, body.previewToken)) {
    return NextResponse.json({ error: "This preview wasn't produced by Build preview, or was changed since. Build the preview again." }, { status: 400 });
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
    if (err instanceof LeagueHistoryConflictError) {
      return NextResponse.json({ error: err.message, conflicts: err.conflicts }, { status: 409 });
    }
    return NextResponse.json({ error: err instanceof Error ? err.message : "Import failed." }, { status: 500 });
  }
}
