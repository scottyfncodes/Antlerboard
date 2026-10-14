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
import { toArray, mergeMeta, fantasyContent, readFields } from "./parse";
import { YahooApiError } from "./errors";
import type { Season } from "@prisma/client";

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

/**
 * The Antlerboard season a Yahoo league response belongs to: the Season row
 * matching the league's own `season` field, and nothing else. There is
 * deliberately no fallback to "the latest season" - when the matching row
 * doesn't exist, guessing files a whole season of Yahoo data under the
 * wrong year (2026 transactions landed in 2022 that way). Callers skip the
 * write and report `missing` instead.
 */
async function seasonForLeague(
  leagueId: string,
  leagueMeta: Record<string, unknown>
): Promise<{ season: Season; missing?: undefined } | { season: null; missing: string }> {
  const year = Number(leagueMeta.season);
  if (!Number.isInteger(year) || year <= 0) {
    return { season: null, missing: "Yahoo didn't report which season this league is" };
  }
  const season = await prisma.season.findUnique({ where: { leagueId_year: { leagueId, year } } });
  if (!season) {
    return { season: null, missing: `No ${year} season exists in Antlerboard - create it before syncing` };
  }
  return { season };
}

/** The `{teams: ...}` list from a league response, wherever Yahoo nested it. */
export function findLeagueTeams(leagueField: unknown): unknown[] {
  for (const node of toArray(leagueField)) {
    if (!node || typeof node !== "object") continue;
    if ("teams" in node) return toArray((node as { teams?: unknown }).teams);
    // /league/{key}/standings nests it one level deeper:
    // league[1].standings[0].teams
    if ("standings" in node) {
      for (const inner of toArray((node as { standings?: unknown }).standings)) {
        if (inner && typeof inner === "object" && "teams" in inner) {
          return toArray((inner as { teams?: unknown }).teams);
        }
      }
    }
  }
  return [];
}

export interface YahooTeamSummary {
  key: string;
  name: string;
  managerNicknames: string[];
}

/** Reads one `{team: [...]}` entry into its key, name, and manager nicknames. */
export function readYahooTeam(entry: unknown): { summary: YahooTeamSummary; parts: unknown[] } | null {
  const parts = toArray((entry as { team?: unknown })?.team);
  if (parts.length === 0) return null;
  const meta = mergeMeta(parts[0]);
  const key = meta.team_key ? String(meta.team_key) : "";
  if (!key) return null;
  const managerNicknames = toArray(meta.managers)
    .map((m) => (m as { manager?: { nickname?: unknown } })?.manager?.nickname)
    .filter((n): n is string => typeof n === "string" && n.length > 0);
  return { summary: { key, name: String(meta.name ?? "Unnamed Team"), managerNicknames }, parts };
}

/**
 * Updates names and standings for teams already linked to Yahoo.
 *
 * A Yahoo team with no linked Antlerboard team is linked automatically only
 * on an exact (case-insensitive) team-name match. Otherwise, if the league
 * still has unlinked Antlerboard teams, it's left for the commissioner to
 * link on Commissioner > Yahoo instead of guessing - creating a placeholder
 * there would duplicate a real team and orphan its keeper history. Only a
 * league with no unlinked teams left (a brand new league) gets placeholder
 * teams created.
 */
async function syncTeamsAndStandings(leagueId: string, leagueKey: string): Promise<SyncSectionResult> {
  let updated = 0;
  const data = await yahooFantasyGet(leagueId, `/league/${leagueKey}/standings`);

  const leagueField = fantasyContent(data).league;
  const leagueMeta = readFields(toArray(leagueField)[0]);
  const teamEntries = findLeagueTeams(leagueField);
  if (teamEntries.length === 0) {
    return { section: "teams+standings", recordsUpdated: 0, error: `Yahoo returned no teams for league ${leagueKey}` };
  }

  // An entry readYahooTeam can't read is counted, never silently dropped:
  // a response whose every team is unreadable must not look like a sync
  // that simply had nothing to do.
  const readTeams = teamEntries.map(readYahooTeam).filter((t) => t !== null);
  const unreadable = teamEntries.length - readTeams.length;
  if (readTeams.length === 0) {
    return {
      section: "teams+standings",
      recordsUpdated: 0,
      error: `Yahoo returned ${teamEntries.length} team entries for league ${leagueKey} but none could be read`,
    };
  }

  const { season, missing: missingSeason } = await seasonForLeague(leagueId, leagueMeta);
  const unlinked: string[] = [];

  for (const read of readTeams) {
    const { key: yahooTeamId, name } = read.summary;
    const standingsPart = read.parts.find(
      (p) => p && typeof p === "object" && "team_standings" in (p as object)
    ) as { team_standings?: unknown } | undefined;
    const standings = readFields(standingsPart?.team_standings);
    const outcomeTotals = readFields(standings.outcome_totals);

    let team = await prisma.team.findFirst({ where: { leagueId, yahooTeamId } });
    if (!team) {
      const byName = await prisma.team.findFirst({
        where: { leagueId, yahooTeamId: null, active: true, name: { equals: name, mode: "insensitive" } },
      });
      if (byName) {
        team = await prisma.team.update({ where: { id: byName.id }, data: { yahooTeamId } });
      } else if ((await prisma.team.count({ where: { leagueId, yahooTeamId: null, active: true } })) > 0) {
        unlinked.push(name);
        continue;
      } else {
        // Brand new league with nothing to link to - create the team under
        // a placeholder manager the commissioner can rename later.
        const placeholderManager = await prisma.manager.create({
          data: { leagueId, name: `Unassigned (${name})` },
        });
        team = await prisma.team.create({
          data: { leagueId, yahooTeamId, name, managerId: placeholderManager.id },
        });
      }
    }
    if (team.name !== name) {
      await prisma.team.update({ where: { id: team.id }, data: { name } });
    }
    updated++;

    if (season && standings.rank !== undefined && standings.rank !== "") {
      const values = {
        wins: Number(outcomeTotals.wins ?? 0),
        losses: Number(outcomeTotals.losses ?? 0),
        ties: Number(outcomeTotals.ties ?? 0),
        rank: Number(standings.rank),
      };
      await prisma.teamStanding.upsert({
        where: { seasonId_teamId: { seasonId: season.id, teamId: team.id } },
        create: { seasonId: season.id, teamId: team.id, ...values },
        update: values,
      });
      updated++;
    }
  }

  const problems: string[] = [];
  if (unreadable > 0) {
    problems.push(`${unreadable} of ${teamEntries.length} Yahoo team entries could not be read`);
  }
  if (unlinked.length > 0) {
    problems.push(
      `${unlinked.length} Yahoo team(s) not linked to an Antlerboard team yet (${unlinked.join(", ")}) - link them on Commissioner > Yahoo`
    );
  }
  if (missingSeason) problems.push(`Standings not recorded: ${missingSeason}`);

  return {
    section: "teams+standings",
    recordsUpdated: updated,
    error: problems.length > 0 ? problems.join("; ") : undefined,
  };
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
      perTeamErrors.push(`${team.name}: ${describeSyncError(err)}`);
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

  const leagueField = fantasyContent(data).league;
  const txContainer = toArray(leagueField).find(
    (n) => n && typeof n === "object" && "transactions" in (n as object)
  ) as { transactions?: unknown } | undefined;

  const { season, missing } = await seasonForLeague(leagueId, readFields(toArray(leagueField)[0]));
  if (!season) {
    return { section: "transactions", recordsUpdated: 0, error: `No transactions imported: ${missing}` };
  }

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

function describeSyncError(err: unknown): string {
  if (err instanceof YahooApiError && err.isAppNotAuthorized) {
    return "Yahoo hasn't enabled Fantasy Sports API access for this app's Client ID (403). Check the Client ID set in Vercel matches the one Yahoo approved.";
  }
  return err instanceof Error ? err.message : "Unknown error";
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
  const runSection = async (section: string, fn: () => Promise<SyncSectionResult>) => {
    try {
      sections.push(await fn());
    } catch (err) {
      sections.push({ section, recordsUpdated: 0, error: describeSyncError(err) });
    }
  };

  await runSection("teams+standings", () => syncTeamsAndStandings(leagueId, connection.yahooLeagueKey!));
  await runSection("players", () => syncPlayers(leagueId));
  await runSection("transactions", () => syncTransactions(leagueId, connection.yahooLeagueKey!));

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
