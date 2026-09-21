import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireCommissioner } from "@/lib/current-manager";

interface RawRow {
  playerName?: string;
  mlbTeam?: string;
  positions?: string;
  teamName?: string;
  season?: string;
  method?: string;
  cost?: string;
  draftRound?: string;
  draftPick?: string;
}

const VALID_METHODS = new Set(["DRAFT", "WAIVER", "FREE_AGENT", "TRADE"]);

export async function POST(req: Request) {
  if (!(await requireCommissioner())) {
    return NextResponse.json({ error: "Commissioner access required" }, { status: 403 });
  }
  const { rows }: { rows: RawRow[] } = await req.json();

  const teams = await prisma.team.findMany({ select: { id: true, name: true } });
  const teamByName = new Map(teams.map((t) => [t.name.toLowerCase().trim(), t.id]));

  const results = await Promise.all(
    rows.map(async (row) => {
      const errors: string[] = [];

      const playerName = row.playerName?.trim();
      const teamName = row.teamName?.trim();
      const season = Number(row.season);
      const method = row.method?.trim().toUpperCase().replace(/\s+/g, "_");
      const cost = row.cost ? Number(row.cost) : 0;

      if (!playerName) errors.push("Missing player name");
      if (!teamName) errors.push("Missing team name");
      else if (!teamByName.has(teamName.toLowerCase())) errors.push(`Unknown C&A team "${teamName}"`);
      if (!row.season || Number.isNaN(season)) errors.push("Season must be a number");
      if (!method || !VALID_METHODS.has(method)) errors.push("Method must be DRAFT, WAIVER, FREE_AGENT, or TRADE");
      if (row.cost && Number.isNaN(cost)) errors.push("Cost must be a number");

      let conflict: string | undefined;
      let existingPlayerId: string | undefined;

      if (playerName) {
        const existingPlayer = await prisma.player.findFirst({
          where: { name: { equals: playerName, mode: "insensitive" } },
        });
        if (existingPlayer) {
          existingPlayerId = existingPlayer.id;
          if (!Number.isNaN(season)) {
            const existingAcquisition = await prisma.acquisition.findFirst({
              where: { playerId: existingPlayer.id, seasonYear: season },
            });
            if (existingAcquisition) {
              conflict = `${playerName} already has a recorded acquisition for ${season}`;
            }
          }
        }
      }

      return {
        ...row,
        parsed: { playerName, teamName, season, method, cost },
        teamId: teamName ? teamByName.get(teamName.toLowerCase()) : undefined,
        existingPlayerId,
        errors,
        conflict,
      };
    })
  );

  return NextResponse.json({ rows: results });
}
