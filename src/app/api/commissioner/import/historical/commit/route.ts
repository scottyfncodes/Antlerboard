import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getCurrentManager, requireCommissioner } from "@/lib/current-manager";
import { clearLeagueOperationalData, pickContinuingCommissioner } from "@/lib/import/demo-cleanup";
import { resolveTeamIdByManagerAndYear } from "@/lib/import/team-identity-resolution";
import type { Prisma } from "@prisma/client";
import type { ResolvedTeamSeasonRecord, ParsedTrade, ParsedPropBet, ParsedDraftDayEvent, ParsedFypdSection } from "@/lib/import/types";

const MANAGER_SHEETS = ["Aaron", "Andrew", "Ed", "Hugo", "Jorge", "Kurt", "MattyJ", "Michael", "Neel", "Scott", "Tyler", "Zach"];

interface CommitBody {
  teamSeasons: ResolvedTeamSeasonRecord[];
  trades: ParsedTrade[];
  propBets: ParsedPropBet[];
  draftDayEvents: ParsedDraftDayEvent[];
  fypdSections: ParsedFypdSection[];
  /**
   * When true, wipes the league's current teams/managers/players/seasons
   * before writing the import - see clearLeagueOperationalData. Meant for
   * the one-time switch from Antlerboard's fictional demo league to a
   * commissioner's real history, not for re-running an import that's
   * already landed.
   */
  clearDemoData?: boolean;
}

/**
 * Writes the reviewed historical import to the database. Only ever
 * called after a commissioner has seen the /check preview - this route
 * trusts the structured data it's given the same way the existing CSV
 * import's commit route does, because both are gated behind a prior
 * server-validated preview step, not because client input is trusted in
 * general.
 *
 * Runs as a single transaction: an optional demo-data wipe (see
 * clearDemoData above) followed by the actual import, so a failure
 * partway through never leaves the league emptied out with no real data
 * written.
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

  const result = await prisma.$transaction(
    async (tx) => await runImport(tx, league.id, commissioner?.name ?? null, body, attributedSeasons),
    { timeout: 60_000, maxWait: 15_000 }
  );

  return NextResponse.json(result);
}

async function runImport(
  tx: Prisma.TransactionClient,
  leagueId: string,
  outgoingCommissionerName: string | null,
  body: CommitBody,
  attributedSeasons: ResolvedTeamSeasonRecord[]
) {
  const demoCleanup = body.clearDemoData ? await clearLeagueOperationalData(tx, leagueId) : null;

  const managerCache = new Map<string, string>(); // name -> id
  async function getOrCreateManager(name: string): Promise<string> {
    if (managerCache.has(name)) return managerCache.get(name)!;
    const active = MANAGER_SHEETS.includes(name);
    const existing = await tx.manager.findFirst({ where: { leagueId, name } });
    const manager = existing ?? (await tx.manager.create({ data: { leagueId, name, active } }));
    managerCache.set(name, manager.id);
    return manager.id;
  }

  const teamCache = new Map<string, string>(); // managerSheetName -> teamId
  async function getOrCreateTeam(managerSheetName: string, currentTeamName: string, currentManagerId: string): Promise<string> {
    if (teamCache.has(managerSheetName)) return teamCache.get(managerSheetName)!;
    const existing = await tx.team.findFirst({ where: { leagueId, managerId: currentManagerId } });
    const team = existing ?? (await tx.team.create({ data: { leagueId, name: currentTeamName, managerId: currentManagerId } }));
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
      await tx.teamSeasonRecord.upsert({
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
    await tx.historicalTrade.create({
      data: {
        leagueId,
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
    // The prop-bet sheet identifies each side by manager name, not team
    // name (unlike the trades sheet, which uses real team names) - see
    // resolveTeamIdByManagerAndYear.
    const teamAId = await resolveTeamIdByManagerAndYear(tx, leagueId, b.teamAName, b.seasonYear);
    const teamBId = await resolveTeamIdByManagerAndYear(tx, leagueId, b.teamBName, b.seasonYear);
    await tx.historicalPropBet.create({
      data: {
        leagueId,
        seasonYear: b.seasonYear,
        teamAName: b.teamAName,
        teamAId,
        teamBName: b.teamBName,
        teamBId,
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
    const season = await tx.season.upsert({
      where: { leagueId_year: { leagueId, year: d.seasonYear } },
      create: { leagueId, year: d.seasonYear, status: "COMPLETE" },
      update: {},
    });
    const notesParts = [d.attendeesRaw ? `Attendees: ${d.attendeesRaw}` : null, d.scheduleRaw ? `Schedule:\n${d.scheduleRaw}` : null].filter(
      Boolean
    );
    await tx.draftDayDetails.upsert({
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
    await tx.fypdImportBatch.create({
      data: {
        leagueId,
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

  // A demo-data wipe clears isCommissioner off every manager in the
  // league - reassign it now so /commissioner routes don't lock everyone
  // out the moment this transaction commits (see pickContinuingCommissioner).
  let newCommissionerName: string | null = null;
  if (demoCleanup) {
    const realManagerNames = MANAGER_SHEETS.filter((name) => managerCache.has(name));
    newCommissionerName = pickContinuingCommissioner(outgoingCommissionerName, realManagerNames);
    if (newCommissionerName) {
      await tx.manager.update({
        where: { id: managerCache.get(newCommissionerName)! },
        data: { isCommissioner: true },
      });
    }
  }

  await tx.auditLogEntry.create({
    data: {
      actorName: outgoingCommissionerName ?? "Unknown",
      action: "HISTORICAL_WORKBOOK_IMPORT",
      entityType: "League",
      entityId: leagueId,
      isHistoricalCorrection: false,
      after: {
        teamSeasonsWritten,
        tradesWritten,
        propBetsWritten,
        draftDaysWritten,
        fypdBatchesWritten,
        demoCleanup,
        newCommissionerName,
      } as unknown as object,
    },
  });

  return {
    teamSeasonsWritten,
    tradesWritten,
    propBetsWritten,
    draftDaysWritten,
    fypdBatchesWritten,
    demoCleanup,
    newCommissionerName,
  };
}
