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

/**
 * Syncs each Yahoo-linked team's roster into the Player table, keyed on the
 * stable Yahoo `player_key` (not display name - names change, and Yahoo
 * returns different display contexts for the same player across seasons).
 *
 * Matching order:
 *   1. Already linked (Player.yahooPlayerId === player_key) - refresh the
 *      Yahoo-owned fields (name, mlbTeam, positions) in place.
 *   2. Not linked yet, but an existing C&A player with an exact name match
 *      and no yahooPlayerId - claim it rather than creating a duplicate
 *      (covers players entered manually or via CSV import before Yahoo was
 *      connected).
 *   3. Otherwise, create a new Player row.
 *
 * `notes` (commissioner-owned) and every relation (tags, keeper records,
 * acquisitions, trades, DPUD) are never touched here - only the
 * Yahoo-owned identity columns are written.
 *
 * Isolated per-team: one team's roster request failing (rate limit,
 * temporary Yahoo outage) does not block the others from syncing.
 */
async function syncPlayers(leagueId: string): Promise<SyncSectionResult> {
  const teams = await prisma.team.findMany({ where: { leagueId, yahooTeamId: { not: null } } });

  let updated = 0;
  const perTeamErrors: string[] = [];

  for (const team of teams) {
    try {
      const data = await yahooFantasyGet(leagueId, `/team/${team.yahooTeamId}/roster`);
      const teamField = fantasyContent(data).team;
      const rosterContainer = toArray(teamField).find(
        (n) => n && typeof n === "object" && "roster" in (n as object)
      ) as { roster?: unknown } | undefined;
      const roster = mergeMeta(rosterContainer?.roster) as { players?: unknown };

      for (const entry of toArray(roster.players)) {
        const playerArray = (entry as { player?: unknown })?.player;
        if (!playerArray) continue;
        const [metaPart] = toArray(playerArray);
        const meta = mergeMeta(metaPart);

        const yahooPlayerId = meta.player_key ? String(meta.player_key) : undefined;
        if (!yahooPlayerId) continue;

        // Unlike most Yahoo sub-resources, `name` comes back as an
        // already-flat {full, first, last, ...} object rather than the
        // usual array-of-single-key-field shape - mergeMeta's generic
        // object handling would misparse a flat object (it treats an
        // unrecognized plain object as a values-only list), so it's read
        // directly here, with the array shape as a defensive fallback in
        // case a future Yahoo API version wraps it after all.
        const nameField = meta.name;
        const name =
          nameField && typeof nameField === "object" && "full" in (nameField as object)
            ? String((nameField as { full: unknown }).full)
            : String(mergeMeta(nameField).full ?? "Unknown Player");
        const mlbTeam = meta.editorial_team_abbr ? String(meta.editorial_team_abbr).toUpperCase() : null;
        // Each entry here is already a flat single-key object (e.g.
        // {position: "OF"}) from Yahoo's <position> list, not the
        // multi-field shape mergeMeta is for - read it directly.
        const positions = toArray(meta.eligible_positions)
          .map((p) => (p as { position?: unknown })?.position)
          .filter((p): p is string => typeof p === "string" && p.length > 0);

        let player = await prisma.player.findFirst({ where: { leagueId, yahooPlayerId } });

        if (!player) {
          player = await prisma.player.findFirst({
            where: { leagueId, yahooPlayerId: null, name: { equals: name, mode: "insensitive" } },
          });
        }

        if (player) {
          const changed =
            player.yahooPlayerId !== yahooPlayerId ||
            player.name !== name ||
            player.mlbTeam !== mlbTeam ||
            (positions.length > 0 && JSON.stringify(player.positions) !== JSON.stringify(positions));

          if (changed) {
            await prisma.player.update({
              where: { id: player.id },
              data: {
                yahooPlayerId,
                name,
                mlbTeam,
                ...(positions.length > 0 ? { positions } : {}),
              },
            });
          }
        } else {
          await prisma.player.create({
            data: { leagueId, yahooPlayerId, name, mlbTeam, positions },
          });
        }

        updated++;
      }
    } catch (err) {
      perTeamErrors.push(`${team.name}: ${err instanceof Error ? err.message : "Unknown error"}`);
    }
  }

  return {
    section: "players",
    recordsUpdated: updated,
    error: perTeamErrors.length > 0 ? perTeamErrors.join("; ") : undefined,
  };
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
  await runSection(() => syncPlayers(leagueId));
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
