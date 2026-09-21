import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getCurrentManager, requireCommissioner } from "@/lib/current-manager";
import type { ResolvedTeamSeasonRecord, ParsedTrade, ParsedPropBet, ParsedDraftDayEvent, ParsedFypdSection } from "@/lib/import/types";

const MANAGER_SHEETS = ["Aaron", "Andrew", "Ed", "Hugo", "Jorge", "Kurt", "MattyJ", "Michael", "Neel", "Scott", "Tyler", "Zach"];

interface CommitBody {
  teamSeasons: ResolvedTeamSeasonRecord[];
  trades: ParsedTrade[];
  propBets: ParsedPropBet[];
  draftDayEvents: ParsedDraftDayEvent[];
  fypdSections: ParsedFypdSection[];
}

/**
 * Writes the reviewed historical import to the database. Only ever
 * called after a commissioner has seen the /check preview - this route
 * trusts the structured data it's given the same way the existing CSV
 * import's commit route does, because both are gated behind a prior
 * server-validated preview step, not because client input is trusted in
 * general.
 *
 * Deliberately additive: creates/updates Manager, Team, and
 * TeamSeasonRecord rows, but never deletes or renames anything that
 * already exists (e.g. the demo league's fictional teams are left
 * alone - see project notes on why merging or removing them is a
 * separate, explicit decision, not something a historical import should
 * do as a side effect).
 */
export async function POST(req: Request) {
  if (!(await requireCommissioner())) {
    return NextResponse.json({ error: "Commissioner access required" }, { status: 403 });
  }
  const commissioner = await getCurrentManager();

  const league = await prisma.league.findFirst();
  if (!league) return NextResponse.json({ error: "No league configured" }, { status: 500 });

  const body = (await req.json()) as CommitBody;
  const attributedSeasons = body.teamSeasons.filter((r) => r.seasonYear !== null && r.attribution !== "unattributed");

  const managerCache = new Map<string, string>(); // name -> id
  async function getOrCreateManager(name: string): Promise<string> {
    if (managerCache.has(name)) return managerCache.get(name)!;
    const active = MANAGER_SHEETS.includes(name);
    const existing = await prisma.manager.findFirst({ where: { leagueId: league!.id, name } });
    const manager =
      existing ??
      (await prisma.manager.create({ data: { leagueId: league!.id, name, active } }));
    managerCache.set(name, manager.id);
    return manager.id;
  }

  const teamCache = new Map<string, string>(); // managerSheetName -> teamId
  async function getOrCreateTeam(managerSheetName: string, currentTeamName: string, currentManagerId: string): Promise<string> {
    if (teamCache.has(managerSheetName)) return teamCache.get(managerSheetName)!;
    const existing = await prisma.team.findFirst({ where: { leagueId: league!.id, managerId: currentManagerId } });
    const team =
      existing ??
      (await prisma.team.create({ data: { leagueId: league!.id, name: currentTeamName, managerId: currentManagerId } }));
    teamCache.set(managerSheetName, team.id);
    return team.id;
  }

  let teamSeasonsWritten = 0;
  const byManagerSheet = new Map<string, ResolvedTeamSeasonRecord[]>();
  for (const r of attributedSeasons) {
    if (!byManagerSheet.has(r.managerSheetName)) byManagerSheet.set(r.managerSheetName, []);
    byManagerSheet.get(r.managerSheetName)!.push(r);
  }

  for (const [managerSheetName, records] of byManagerSheet) {
    const currentManagerId = await getOrCreateManager(managerSheetName);
    const latest = [...records].sort((a, b) => (a.seasonYear ?? 0) - (b.seasonYear ?? 0)).at(-1)!;
    const teamId = await getOrCreateTeam(managerSheetName, latest.teamName, currentManagerId);

    for (const r of records) {
      const seasonManagerId = await getOrCreateManager(r.resolvedManagerName);
      await prisma.teamSeasonRecord.upsert({
        where: { teamId_seasonYear: { teamId, seasonYear: r.seasonYear! } },
        create: {
          teamId,
          seasonYear: r.seasonYear!,
          teamName: r.teamName,
          managerId: seasonManagerId,
          finish: r.finish,
          sourceNote: r.sourceLabel,
        },
        update: {
          teamName: r.teamName,
          managerId: seasonManagerId,
          finish: r.finish,
          sourceNote: r.sourceLabel,
        },
      });
      teamSeasonsWritten++;
    }
  }

  let tradesWritten = 0;
  for (const t of body.trades) {
    if (!t.teamAName || !t.teamBName) continue;
    await prisma.historicalTrade.create({
      data: {
        leagueId: league.id,
        seasonYear: t.seasonYear,
        tradeDate: t.tradeDate ? new Date(t.tradeDate) : null,
        teamAName: t.teamAName,
        teamAPlayersRaw: t.teamAPlayersRaw,
        teamADropsRaw: t.teamADropsRaw,
        teamBName: t.teamBName,
        teamBPlayersRaw: t.teamBPlayersRaw,
        teamBDropsRaw: t.teamBDropsRaw,
        sourceRef: t.sourceRef,
      },
    });
    tradesWritten++;
  }

  let propBetsWritten = 0;
  for (const b of body.propBets) {
    if (!b.teamAName || !b.teamBName || !b.description) continue;
    await prisma.historicalPropBet.create({
      data: {
        leagueId: league.id,
        seasonYear: b.seasonYear,
        teamAName: b.teamAName,
        teamBName: b.teamBName,
        amount: b.amount,
        description: b.description,
        sourceRef: b.sourceRef,
      },
    });
    propBetsWritten++;
  }

  let draftDaysWritten = 0;
  for (const d of body.draftDayEvents) {
    if (!d.seasonYear) continue;
    const season = await prisma.season.upsert({
      where: { leagueId_year: { leagueId: league.id, year: d.seasonYear } },
      create: { leagueId: league.id, year: d.seasonYear, status: "COMPLETE" },
      update: {},
    });
    const notesParts = [d.attendeesRaw ? `Attendees: ${d.attendeesRaw}` : null, d.scheduleRaw ? `Schedule:\n${d.scheduleRaw}` : null].filter(
      Boolean
    );
    await prisma.draftDayDetails.upsert({
      where: { seasonId: season.id },
      create: {
        seasonId: season.id,
        venue: d.venue,
        commissionerNotes: notesParts.join("\n\n") || null,
      },
      update: {
        venue: d.venue,
        commissionerNotes: notesParts.join("\n\n") || null,
      },
    });
    draftDaysWritten++;
  }

  let fypdBatchesWritten = 0;
  for (const s of body.fypdSections) {
    await prisma.fypdImportBatch.create({
      data: {
        leagueId: league.id,
        label: s.label,
        sourceSheet: s.sourceSheet,
        rawPicks: s.picks as unknown as object,
        seasonYear: s.seasonYear,
        status: "PENDING_REVIEW",
        notes: s.flags.length > 0 ? s.flags.join("; ") : null,
      },
    });
    fypdBatchesWritten++;
  }

  await prisma.auditLogEntry.create({
    data: {
      actorName: commissioner?.name ?? "Unknown",
      action: "HISTORICAL_WORKBOOK_IMPORT",
      entityType: "League",
      entityId: league.id,
      isHistoricalCorrection: false,
      after: {
        teamSeasonsWritten,
        tradesWritten,
        propBetsWritten,
        draftDaysWritten,
        fypdBatchesWritten,
      },
    },
  });

  return NextResponse.json({
    teamSeasonsWritten,
    tradesWritten,
    propBetsWritten,
    draftDaysWritten,
    fypdBatchesWritten,
  });
}
