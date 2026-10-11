import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { yahooFantasyGet } from "@/lib/yahoo/client";
import { fantasyContent } from "@/lib/yahoo/parse";
import { findLeagueTeams, readYahooTeam, type YahooTeamSummary } from "@/lib/yahoo/sync";
import { requireCommissioner } from "@/lib/current-manager";

export interface LinkableTeam {
  id: string;
  name: string;
  managerName: string;
  yahooTeamId: string | null;
}

export interface YahooTeamLinkRow extends YahooTeamSummary {
  linkedTeamId: string | null;
  suggestedTeamId: string | null;
}

const normalize = (s: string) => s.trim().toLowerCase();

/**
 * Lists the selected Yahoo league's teams next to Antlerboard's own, so the
 * commissioner can link each Yahoo team to the real Antlerboard team (and
 * its keeper history) before the sync writes names and standings. Suggests
 * a link on an exact team-name match, then on a manager name matching the
 * Yahoo manager's nickname; nothing is saved until POST.
 */
export async function GET() {
  if (!(await requireCommissioner())) {
    return NextResponse.json({ error: "Commissioner access required" }, { status: 403 });
  }

  const league = await prisma.league.findFirst();
  if (!league) return NextResponse.json({ error: "No league configured" }, { status: 500 });
  const connection = await prisma.yahooConnection.findUnique({ where: { leagueId: league.id } });
  if (!connection?.yahooLeagueKey) {
    return NextResponse.json({ error: "Pick a Yahoo league first" }, { status: 400 });
  }

  let yahooTeams: YahooTeamSummary[];
  try {
    const data = await yahooFantasyGet(league.id, `/league/${connection.yahooLeagueKey}/teams`);
    yahooTeams = findLeagueTeams(fantasyContent(data).league)
      .map((entry) => readYahooTeam(entry)?.summary)
      .filter((t): t is YahooTeamSummary => !!t);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to load Yahoo teams" },
      { status: 502 }
    );
  }

  const teams = await prisma.team.findMany({
    where: { leagueId: league.id, active: true },
    include: { manager: { select: { name: true } } },
    orderBy: { name: "asc" },
  });
  const antlerboardTeams: LinkableTeam[] = teams.map((t) => ({
    id: t.id,
    name: t.name,
    managerName: t.manager.name,
    yahooTeamId: t.yahooTeamId,
  }));

  const rows: YahooTeamLinkRow[] = yahooTeams.map((yt) => {
    const linked = teams.find((t) => t.yahooTeamId === yt.key);
    const unlinked = teams.filter((t) => !t.yahooTeamId);
    const nicknames = yt.managerNicknames.map(normalize);
    const suggested =
      unlinked.find((t) => normalize(t.name) === normalize(yt.name)) ??
      unlinked.find((t) => nicknames.includes(normalize(t.manager.name)));
    return { ...yt, linkedTeamId: linked?.id ?? null, suggestedTeamId: linked ? null : (suggested?.id ?? null) };
  });

  return NextResponse.json({ yahooTeams: rows, antlerboardTeams });
}

const linkSchema = z.object({
  links: z.array(z.object({ yahooTeamKey: z.string().min(1), teamId: z.string().min(1).nullable() })),
});

/**
 * Saves Yahoo-team -> Antlerboard-team links. Each Yahoo team links to at
 * most one Antlerboard team and vice versa (enforced here and by the
 * (leagueId, yahooTeamId) unique index). Only Team.yahooTeamId changes -
 * no team, manager, or keeper data is created or removed.
 */
export async function POST(req: Request) {
  if (!(await requireCommissioner())) {
    return NextResponse.json({ error: "Commissioner access required" }, { status: 403 });
  }

  const league = await prisma.league.findFirst();
  if (!league) return NextResponse.json({ error: "No league configured" }, { status: 500 });

  let parsed;
  try {
    parsed = linkSchema.safeParse(await req.json());
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  if (!parsed.success) return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  const { links } = parsed.data;

  const yahooKeys = links.map((l) => l.yahooTeamKey);
  const teamIds = links.map((l) => l.teamId).filter((id): id is string => id !== null);
  if (new Set(yahooKeys).size !== yahooKeys.length || new Set(teamIds).size !== teamIds.length) {
    return NextResponse.json({ error: "Each team can only be linked once." }, { status: 400 });
  }
  const owned = await prisma.team.count({ where: { id: { in: teamIds }, leagueId: league.id } });
  if (owned !== teamIds.length) {
    return NextResponse.json({ error: "Unknown team." }, { status: 400 });
  }

  await prisma.$transaction([
    // Release the Yahoo keys and teams being (re)assigned first so the
    // unique index never sees a key on two teams mid-update.
    prisma.team.updateMany({
      where: { leagueId: league.id, OR: [{ yahooTeamId: { in: yahooKeys } }, { id: { in: teamIds } }] },
      data: { yahooTeamId: null },
    }),
    ...links
      .filter((l) => l.teamId !== null)
      .map((l) => prisma.team.update({ where: { id: l.teamId! }, data: { yahooTeamId: l.yahooTeamKey } })),
  ]);

  return NextResponse.json({ ok: true });
}
