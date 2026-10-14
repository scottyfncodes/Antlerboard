import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { recomputeKeeperRecordsForPlayer } from "@/lib/keeper-sync";
import { requireCommissioner } from "@/lib/current-manager";
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
  const commissioner = await requireCommissioner();
  if (!commissioner) {
    return NextResponse.json({ error: "Commissioner access required" }, { status: 403 });
  }
  const { rows }: { rows: CommitRow[] } = await req.json();

  // Everything below is scoped to the signed-in commissioner's own league -
  // never "the first league in the database".
  const leagueId = commissioner.leagueId;
  const league = await prisma.league.findUnique({ where: { id: leagueId } });
  if (!league) return NextResponse.json({ error: "Commissioner's league not found" }, { status: 500 });

  // The team and player ids come back from the browser, so they are checked
  // against this league before anything is written. Any id that isn't one of
  // this league's teams or players, or a player id that isn't the player the
  // row names, means the payload isn't what the check
  // step produced (tampered, stale, or from another league): the whole batch
  // is rejected and nothing is imported, rather than importing around it.
  const rowsToImport = rows.filter((r) => !(r.conflict && !r.force) && r.teamId && r.season && r.method && r.playerName);
  const [validTeams, validPlayers] = await Promise.all([
    prisma.team.findMany({
      where: { leagueId, id: { in: rowsToImport.map((r) => String(r.teamId)) } },
      select: { id: true },
    }),
    prisma.player.findMany({
      where: {
        leagueId,
        id: { in: rowsToImport.flatMap((r) => (r.existingPlayerId ? [String(r.existingPlayerId)] : [])) },
      },
      select: { id: true },
    }),
  ]);
  const teamIds = new Set(validTeams.map((t) => t.id));
  const playerIds = new Set(validPlayers.map((p) => p.id));

  // An in-league player id must also be the player the row names. The check
  // step matched it as: the trimmed row name equals Player.name,
  // case-insensitively, within this league - the same Prisma query is run
  // here for each distinct (id, name) pair, so a row can never attach its
  // acquisition to a different player than the one it names.
  const nameKey = (id: string, name: string) => `${id}\u0000${name}`;
  const pairs = new Map<string, { id: string; name: string }>();
  for (const r of rowsToImport) {
    if (typeof r.existingPlayerId === "string" && playerIds.has(r.existingPlayerId) && typeof r.playerName === "string") {
      const name = r.playerName.trim();
      pairs.set(nameKey(r.existingPlayerId, name), { id: r.existingPlayerId, name });
    }
  }
  const nameMatches = new Set<string>();
  await Promise.all(
    [...pairs].map(async ([key, { id, name }]) => {
      const match = await prisma.player.findFirst({
        where: { id, leagueId, name: { equals: name, mode: "insensitive" } },
        select: { id: true },
      });
      if (match) nameMatches.add(key);
    })
  );

  const invalidRows = rows.flatMap((r, index) => {
    if (!rowsToImport.includes(r)) return [];
    const reasons: string[] = [];
    if (typeof r.teamId !== "string" || !teamIds.has(r.teamId)) reasons.push("team is not in this league");
    if (r.existingPlayerId !== undefined && r.existingPlayerId !== null && r.existingPlayerId !== "") {
      if (typeof r.existingPlayerId !== "string" || !playerIds.has(r.existingPlayerId)) {
        reasons.push("player is not in this league");
      } else if (typeof r.playerName !== "string" || !nameMatches.has(nameKey(r.existingPlayerId, r.playerName.trim()))) {
        reasons.push("player id does not match the player name");
      }
    }
    return reasons.length > 0 ? [{ index, playerName: r.playerName, reasons }] : [];
  });
  if (invalidRows.length > 0) {
    return NextResponse.json(
      {
        error: `Import rejected: ${invalidRows.length} row(s) reference a team or player that doesn't match this league's records. Nothing was imported - re-run the check and try again.`,
        imported: 0,
        skipped: rows.length,
        invalidRows,
      },
      { status: 400 }
    );
  }

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
        actorName: commissioner.name,
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
