import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { recomputeKeeperRecordsForPlayer } from "@/lib/keeper-sync";
import { getCurrentManager, requireCommissioner } from "@/lib/current-manager";
import { CURRENT_SEASON_YEAR } from "@/lib/config";
import type { AcquisitionMethod } from "@prisma/client";

interface CommitRow {
  teamId: string;
  season: number;
  method: AcquisitionMethod;
  cost: number;
  playerName: string;
  mlbTeam?: string;
  positions?: string;
  draftRound?: string;
  draftPick?: string;
  existingPlayerId?: string;
  conflict?: string;
  force?: boolean;
}

export async function POST(req: Request) {
  if (!(await requireCommissioner())) {
    return NextResponse.json({ error: "Commissioner access required" }, { status: 403 });
  }
  const manager = await getCurrentManager();
  const { rows }: { rows: CommitRow[] } = await req.json();

  const league = await prisma.league.findFirst();
  if (!league) return NextResponse.json({ error: "No league configured" }, { status: 500 });

  let imported = 0;
  let skipped = 0;
  const playerIdsTouched = new Set<string>();

  for (const row of rows) {
    if (row.conflict && !row.force) {
      skipped++;
      continue;
    }
    if (!row.teamId || !row.season || !row.method || !row.playerName) {
      skipped++;
      continue;
    }

    const season = await prisma.season.upsert({
      where: { leagueId_year: { leagueId: league.id, year: row.season } },
      create: { leagueId: league.id, year: row.season, status: "COMPLETE" },
      update: {},
    });

    let playerId = row.existingPlayerId;
    if (!playerId) {
      const positions = row.positions
        ? row.positions.split(/[/,]/).map((p) => p.trim()).filter(Boolean)
        : [];
      const player = await prisma.player.create({
        data: { leagueId: league.id, name: row.playerName, mlbTeam: row.mlbTeam, positions },
      });
      playerId = player.id;
    }

    await prisma.acquisition.create({
      data: {
        seasonId: season.id,
        seasonYear: row.season,
        playerId,
        teamId: row.teamId,
        method: row.method,
        cost: row.cost || 0,
        draftRound: row.draftRound ? Number(row.draftRound) : undefined,
        draftPick: row.draftPick ? Number(row.draftPick) : undefined,
      },
    });

    await prisma.auditLogEntry.create({
      data: {
        actorName: manager?.name ?? "Unknown",
        action: "CSV_IMPORT_ACQUISITION",
        entityType: "Player",
        entityId: playerId,
        isHistoricalCorrection: true,
        after: { ...row },
      },
    });

    playerIdsTouched.add(playerId);
    imported++;
  }

  for (const playerId of playerIdsTouched) {
    await recomputeKeeperRecordsForPlayer(playerId, CURRENT_SEASON_YEAR);
  }

  return NextResponse.json({ imported, skipped });
}
