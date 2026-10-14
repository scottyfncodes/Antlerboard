import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireCommissioner } from "@/lib/current-manager";
import { buildTeamMatcher } from "@/lib/import/team-match";

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

const VALID_METHODS = new Set(["DRAFT", "WAIVER", "FREE_AGENT", "FYPD", "TRADE"]);

export async function POST(req: Request) {
  const commissioner = await requireCommissioner();
  if (!commissioner) {
    return NextResponse.json({ error: "Commissioner access required" }, { status: 403 });
  }
  const { rows }: { rows: RawRow[] } = await req.json();

  // Only the commissioner's own league's teams - see buildTeamMatcher for
  // how a CSV team name resolves (ids, exact name, normalized name, manager).
  const teams = await prisma.team.findMany({
    where: { leagueId: commissioner.leagueId },
    select: { id: true, name: true, yahooTeamId: true, manager: { select: { name: true } } },
  });
  const matchTeam = buildTeamMatcher(
    teams.map((t) => ({ id: t.id, name: t.name, yahooTeamId: t.yahooTeamId, managerName: t.manager.name }))
  );

  const results = await Promise.all(
    rows.map(async (row) => {
      const errors: string[] = [];

      const playerName = row.playerName?.trim();
      const teamName = row.teamName?.trim();
      const season = Number(row.season);
      const method = row.method?.trim().toUpperCase().replace(/\s+/g, "_");
      const cost = row.cost ? Number(row.cost) : 0;

      const teamMatch = teamName ? matchTeam(teamName) : undefined;

      if (!playerName) errors.push("Missing player name");
      if (!teamName) errors.push("Missing team name");
      else if (teamMatch && "error" in teamMatch) errors.push(teamMatch.error);
      if (!row.season || Number.isNaN(season)) errors.push("Season must be a number");
      if (!method || !VALID_METHODS.has(method)) errors.push("Method must be DRAFT, WAIVER, FREE_AGENT, FYPD, or TRADE");
      if (row.cost && Number.isNaN(cost)) errors.push("Cost must be a number");

      let conflict: string | undefined;
      let existingPlayerId: string | undefined;

      if (playerName) {
        // Only this league's players, and only an unambiguous name: two
        // same-named players here (e.g. two Will Smiths) can't be told apart
        // from a CSV row, so the row is held back rather than attached to
        // either one.
        const sameName = await prisma.player.findMany({
          where: { leagueId: commissioner.leagueId, name: { equals: playerName, mode: "insensitive" } },
          select: { id: true },
          take: 2,
        });
        if (sameName.length > 1) {
          errors.push(`Player "${playerName}" matches more than one player in this league - resolve the duplicate before importing`);
        }
        const existingPlayer = sameName.length === 1 ? sameName[0] : undefined;
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
        teamId: teamMatch?.teamId,
        existingPlayerId,
        errors,
        conflict,
      };
    })
  );

  return NextResponse.json({ rows: results });
}
