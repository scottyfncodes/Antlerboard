/**
 * Yahoo -> Antlerboard synchronization.
 *
 * THE CORE RULE: this module may only write fields Yahoo actually owns
 * (team names/logos, standings, player identity/MLB team/positions,
 * roster-add/drop transactions). It must never touch keeper history, tags,
 * trades, DPUD, or league history - those are Antlerboard's own data and a
 * sync would silently destroy real work if it clobbered them. Every write
 * below is scoped to exactly the Yahoo-owned columns for that model.
 *
 * Each section is wrapped so one failing section (e.g. Yahoo temporarily
 * rate-limiting transactions) doesn't take down the whole sync - a partial
 * sync still commits whatever succeeded and reports which parts failed.
 */

import { prisma } from "@/lib/db";
import { yahooFantasyGet } from "./client";
import { toArray, mergeMeta, fantasyContent } from "./parse";

export interface SyncSectionResult {
  section: string;
  recordsUpdated: number;
  error?: string;
}

export interface SyncResult {
  status: "SUCCESS" | "PARTIAL" | "FAILED";
  sections: SyncSectionResult[];
  totalRecordsUpdated: number;
}

async function syncTeamsAndStandings(leagueId: string, leagueKey: string): Promise<SyncSectionResult> {
  let updated = 0;
  const data = await yahooFantasyGet(leagueId, `/league/${leagueKey}/standings`);

  const leagueField = fantasyContent(data).league;
  const leagueNode = mergeMeta(leagueField);
  const teamsContainer = toArray(leagueField).find(
    (n) => n && typeof n === "object" && "teams" in (n as object)
  ) as { teams?: unknown } | undefined;

  const teamEntries = toArray(teamsContainer?.teams);

  const season = await prisma.season.findFirst({ where: { league: { id: leagueId } }, orderBy: { year: "desc" } });

  for (const entry of teamEntries) {
    const teamArray = (entry as { team?: unknown })?.team;
    if (!teamArray) continue;
    const [metaPart, standingsPart] = toArray(teamArray);
    const meta = mergeMeta(metaPart);
    const standings = mergeMeta((standingsPart as { team_standings?: unknown })?.team_standings);
    const outcomeTotals = mergeMeta((standings as { outcome_totals?: unknown })?.outcome_totals);

    const yahooTeamId = String(meta.team_key ?? meta.team_id ?? "");
    const name = String(meta.name ?? "Unnamed Team");
    if (!yahooTeamId) continue;

    let team = await prisma.team.findFirst({ where: { leagueId, yahooTeamId } });
    if (!team) {
      // Brand new Yahoo team we haven't mapped to a C&A manager yet.
      // Created unassigned - a commissioner links it to a real manager
      // from Commissioner > Teams rather than the sync guessing.
      const placeholderManager = await prisma.manager.create({
        data: { leagueId, name: `Unassigned (${name})` },
      });
      team = await prisma.team.create({
        data: { leagueId, yahooTeamId, name, managerId: placeholderManager.id },
      });
    } else if (team.name !== name) {
      await prisma.team.update({ where: { id: team.id }, data: { name } });
    }
    updated++;

    if (season && standings.rank !== undefined) {
      await prisma.teamStanding.upsert({
        where: { seasonId_teamId: { seasonId: season.id, teamId: team.id } },
        create: {
          seasonId: season.id,
          teamId: team.id,
          wins: Number(outcomeTotals.wins ?? 0),
          losses: Number(outcomeTotals.losses ?? 0),
          ties: Number(outcomeTotals.ties ?? 0),
          rank: Number(standings.rank),
        },
        update: {
          wins: Number(outcomeTotals.wins ?? 0),
          losses: Number(outcomeTotals.losses ?? 0),
          ties: Number(outcomeTotals.ties ?? 0),
          rank: Number(standings.rank),
        },
      });
      updated++;
    }
  }

  void leagueNode;
  return { section: "teams+standings", recordsUpdated: updated };
}

async function syncTransactions(leagueId: string, leagueKey: string): Promise<SyncSectionResult> {
  let updated = 0;
  const data = await yahooFantasyGet(leagueId, `/league/${leagueKey}/transactions`);

  const txContainer = toArray(fantasyContent(data).league).find(
    (n) => n && typeof n === "object" && "transactions" in (n as object)
  ) as { transactions?: unknown } | undefined;

  const season = await prisma.season.findFirst({ where: { league: { id: leagueId } }, orderBy: { year: "desc" } });
  if (!season) return { section: "transactions", recordsUpdated: 0, error: "No season configured" };

  for (const entry of toArray(txContainer?.transactions)) {
    const txArray = (entry as { transaction?: unknown })?.transaction;
    if (!txArray) continue;
    const meta = mergeMeta(txArray);
    const yahooTransactionId = meta.transaction_key ? String(meta.transaction_key) : undefined;
    if (!yahooTransactionId) continue;

    const existing = await prisma.transaction.findUnique({ where: { yahooTransactionId } });
    if (existing) continue; // already synced - keeps this idempotent

    const type =
      meta.type === "drop"
        ? "DROP"
        : meta.type === "add"
          ? "FREE_AGENT_ADD"
          : meta.type === "trade"
            ? "TRADE"
            : "FREE_AGENT_ADD";

    await prisma.transaction.create({
      data: {
        seasonId: season.id,
        seasonYear: season.year,
        type,
        yahooTransactionId,
        notes: `Synced from Yahoo (${meta.type ?? "unknown"})`,
        date: meta.timestamp ? new Date(Number(meta.timestamp) * 1000) : new Date(),
      },
    });
    updated++;
  }

  return { section: "transactions", recordsUpdated: updated };
}

/**
 * Runs a full sync for a league and records the outcome. Safe to call
 * repeatedly (manually via "Sync Now" or on the Vercel Cron schedule) -
 * every write above is either an upsert keyed on a stable Yahoo id, or
 * skips records it has already seen.
 */
export async function runYahooSync(leagueId: string): Promise<SyncResult> {
  const connection = await prisma.yahooConnection.findUnique({ where: { leagueId } });
  if (!connection?.yahooLeagueKey) {
    throw new Error("No Yahoo league selected yet - connect Yahoo and pick the C&A league first.");
  }

  await prisma.yahooConnection.update({
    where: { leagueId },
    data: { lastSyncAttemptAt: new Date(), lastSyncStatus: "RUNNING" },
  });

  const syncLog = await prisma.syncLog.create({
    data: { connectionId: connection.id, status: "RUNNING" },
  });

  const sections: SyncSectionResult[] = [];
  const runSection = async (fn: () => Promise<SyncSectionResult>) => {
    try {
      sections.push(await fn());
    } catch (err) {
      sections.push({
        section: fn.name,
        recordsUpdated: 0,
        error: err instanceof Error ? err.message : "Unknown error",
      });
    }
  };

  await runSection(() => syncTeamsAndStandings(leagueId, connection.yahooLeagueKey!));
  await runSection(() => syncTransactions(leagueId, connection.yahooLeagueKey!));

  const totalRecordsUpdated = sections.reduce((sum, s) => sum + s.recordsUpdated, 0);
  const failedSections = sections.filter((s) => s.error);
  const status: SyncResult["status"] =
    failedSections.length === 0 ? "SUCCESS" : failedSections.length === sections.length ? "FAILED" : "PARTIAL";

  await prisma.$transaction([
    prisma.syncLog.update({
      where: { id: syncLog.id },
      data: {
        status,
        finishedAt: new Date(),
        recordsUpdated: totalRecordsUpdated,
        error: failedSections.length > 0 ? failedSections.map((s) => `${s.section}: ${s.error}`).join("; ") : null,
        detail: sections as unknown as object,
      },
    }),
    prisma.yahooConnection.update({
      where: { leagueId },
      data: {
        lastSyncStatus: status,
        lastSyncSuccessAt: status !== "FAILED" ? new Date() : connection.lastSyncSuccessAt,
        lastSyncError: failedSections.length > 0 ? failedSections.map((s) => s.error).join("; ") : null,
        lastSyncRecordCount: totalRecordsUpdated,
      },
    }),
  ]);

  return { status, sections, totalRecordsUpdated };
}
