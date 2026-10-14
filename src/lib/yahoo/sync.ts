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
import { canonicalYahooPlayerId, yahooPlayerIdForms } from "./player-id";
import type { Season } from "@prisma/client";

export interface SyncSectionResult {
  section: string;
  recordsUpdated: number;
  error?: string;
  /** Section-specific audit detail, stored with the SyncLog. */
  detail?: Record<string, unknown>;
}

/** State one sync section hands to a later one within the same run. */
interface SyncContext {
  leagueMeta?: Record<string, unknown>;
}

export interface SyncResult {
  status: "SUCCESS" | "PARTIAL" | "FAILED";
  sections: SyncSectionResult[];
  totalRecordsUpdated: number;
  /** The SyncLog row this run wrote (lets the scheduled run cite it). */
  syncLogId?: string;
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
async function syncTeamsAndStandings(
  leagueId: string,
  leagueKey: string,
  context: SyncContext
): Promise<SyncSectionResult> {
  let updated = 0;
  const data = await yahooFantasyGet(leagueId, `/league/${leagueKey}/standings`);

  const leagueField = fantasyContent(data).league;
  const leagueMeta = readFields(toArray(leagueField)[0]);
  context.leagueMeta = leagueMeta;
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

/** One player entry read from a Yahoo `/team/{key}/roster` response. */
export interface YahooRosterEntry {
  yahooPlayerId: string;
  name: string;
  mlbTeam: string | null;
  positions: string[];
  selectedPosition: string | null;
}

/**
 * Reads a roster response into its player entries. `total` counts every
 * entry Yahoo sent and `entries` only the ones that could be read, so a
 * caller can tell "Yahoo sent nothing" from "Yahoo sent players we couldn't
 * read" - neither may be mistaken for an empty roster.
 */
export function readYahooRoster(data: unknown): { entries: YahooRosterEntry[]; total: number } {
  const teamField = fantasyContent(data).team;
  const rosterContainer = toArray(teamField).find(
    (n) => n && typeof n === "object" && "roster" in (n as object)
  ) as { roster?: unknown } | undefined;
  const roster = mergeMeta(rosterContainer?.roster) as { players?: unknown };

  const rawEntries = toArray(roster.players);
  const entries: YahooRosterEntry[] = [];
  for (const entry of rawEntries) {
    const playerParts = toArray((entry as { player?: unknown })?.player);
    if (playerParts.length === 0) continue;
    const meta = mergeMeta(playerParts[0]);

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

    // The lineup slot sits in a later element of the player array; when
    // it's missing or unreadable the spot simply has no slot - never a guess.
    const slotPart = playerParts.slice(1).find(
      (p) => p && typeof p === "object" && "selected_position" in (p as object)
    ) as { selected_position?: unknown } | undefined;
    const slot = mergeMeta(slotPart?.selected_position).position;
    const selectedPosition = typeof slot === "string" && slot.length > 0 ? slot : null;

    entries.push({ yahooPlayerId, name, mlbTeam, positions, selectedPosition });
  }
  return { entries, total: rawEntries.length };
}

/**
 * Finds or creates the Player for a Yahoo roster entry and refreshes its
 * Yahoo-owned identity columns (name, mlbTeam, positions).
 *
 * Matching order:
 *   1. Already linked (Player.yahooPlayerId === player_key).
 *   1b. Linked under another form of the same Yahoo identity: the bare
 *      player_id the league-history import stores ("12345"), or a key from
 *      an earlier season ("458.p.12345"). Exactly one such player is the
 *      same person and its key is brought up to date; more than one means
 *      the data is already duplicated, and none of them is guessed at.
 *   2. Not linked yet, and exactly ONE unlinked player in the league has
 *      this exact name - claim it (covers players entered by hand or by
 *      import before Yahoo was connected).
 *   3. Otherwise a new Yahoo-linked player. When two or more unlinked
 *      players share the name, none is claimed: guessing would attach the
 *      wrong person's keeper history. The new player is reported as
 *      ambiguous for the commissioner to review; records are never merged
 *      on approximate names.
 *
 * `notes` (commissioner-owned) and every relation are never touched here.
 */
async function resolveRosterPlayer(
  leagueId: string,
  entry: YahooRosterEntry
): Promise<{ playerId: string; ambiguous: boolean }> {
  const { yahooPlayerId, name, mlbTeam, positions } = entry;
  let player = await prisma.player.findFirst({ where: { leagueId, yahooPlayerId } });
  let ambiguous = false;

  const canonical = canonicalYahooPlayerId(yahooPlayerId);
  if (!player && canonical) {
    const sameIdentity = await prisma.player.findMany({ where: { leagueId, OR: yahooPlayerIdForms(canonical) }, take: 2 });
    if (sameIdentity.length === 1) player = sameIdentity[0];
    else ambiguous = sameIdentity.length > 1;
  }

  if (!player && !ambiguous) {
    const candidates = await prisma.player.findMany({
      where: { leagueId, yahooPlayerId: null, name: { equals: name, mode: "insensitive" } },
      take: 2,
    });
    if (candidates.length === 1) player = candidates[0];
    else ambiguous = candidates.length > 1;
  }

  if (!player) {
    const created = await prisma.player.create({ data: { leagueId, yahooPlayerId, name, mlbTeam, positions } });
    return { playerId: created.id, ambiguous };
  }

  const changed =
    player.yahooPlayerId !== yahooPlayerId ||
    player.name !== name ||
    player.mlbTeam !== mlbTeam ||
    (positions.length > 0 && JSON.stringify(player.positions) !== JSON.stringify(positions));
  if (changed) {
    await prisma.player.update({
      where: { id: player.id },
      data: { yahooPlayerId, name, mlbTeam, ...(positions.length > 0 ? { positions } : {}) },
    });
  }
  return { playerId: player.id, ambiguous: false };
}

export interface RosterTeamChanges {
  team: string;
  yahooTeamId: string;
  added: string[];
  movedIn: string[];
  removed: string[];
  unchanged: number;
  /** Set when this team's existing spots were deliberately left alone. */
  rostersLeftUnchanged?: string;
}

/**
 * Syncs each Yahoo-linked team's roster: player identity (above) and the
 * team's current RosterSpot rows for the Yahoo league's season.
 *
 * For each team, in one database transaction, every player Yahoo lists
 * gets a spot on this team, keyed on (season, player) so a traded player's
 * row moves instead of duplicating. Once every roster is written, spots
 * still pointing at a fully-read team whose players Yahoo no longer lists
 * there are deleted (dropped, released, or traded away) - deferring that
 * step makes a trade a move in either processing order.
 *
 * Nothing here can wipe a roster by accident: a failed request, an empty
 * roster for a team that has spots, or any unreadable entry leaves that
 * team's existing spots in place (unreadable entries might be players who
 * are still there). Each of those is reported, so the run is PARTIAL.
 * Keeper records, acquisitions, tags, and transactions are never touched.
 */
async function syncRosters(
  leagueId: string,
  leagueMeta: Record<string, unknown> | undefined,
  syncLogId: string
): Promise<SyncSectionResult> {
  const teams = await prisma.team.findMany({ where: { leagueId, yahooTeamId: { not: null } }, orderBy: { yahooTeamId: "asc" } });
  const resolved = leagueMeta
    ? await seasonForLeague(leagueId, leagueMeta)
    : { season: null, missing: "the Yahoo league's season couldn't be read" };
  const season = resolved.season;

  let processed = 0;
  const problems: string[] = [];
  const ambiguous: { name: string; yahooPlayerId: string; team: string }[] = [];
  const conflicts: { yahooPlayerId: string; keptOn: string; alsoOn: string }[] = [];
  const changes: RosterTeamChanges[] = [];
  // Which team claimed each player this run, so a player listed on two
  // rosters (a trade landing mid-sync) stays on the first and is reported.
  const claimedBy = new Map<string, string>();
  const pendingRemovals: { teamId: string; seenIds: string[]; change: RosterTeamChanges }[] = [];

  if (!season) problems.push(`Rosters not recorded: ${resolved.missing}`);

  for (const team of teams) {
    let read: ReturnType<typeof readYahooRoster>;
    try {
      read = readYahooRoster(await yahooFantasyGet(leagueId, `/team/${team.yahooTeamId}/roster`));
    } catch (err) {
      problems.push(`${team.name}: ${describeSyncError(err)} - existing roster left unchanged`);
      continue;
    }

    const unreadable = read.total - read.entries.length;
    if (read.total > 0 && read.entries.length === 0) {
      problems.push(`${team.name}: none of ${read.total} roster entries could be read - existing roster left unchanged`);
      continue;
    }
    if (read.total === 0) {
      // Before a draft an empty roster is real; for a team that has spots
      // it's far more likely a bad response than twelve simultaneous drops.
      const held = season ? await prisma.rosterSpot.count({ where: { seasonId: season.id, teamId: team.id } }) : 0;
      if (held > 0) {
        problems.push(`${team.name}: Yahoo returned an empty roster - existing ${held} roster spot(s) left unchanged`);
      }
      continue;
    }
    if (unreadable > 0) {
      problems.push(`${team.name}: ${unreadable} of ${read.total} roster entries could not be read - no players removed`);
    }

    // Identity first (outside the roster transaction - a player record is
    // valid on its own even if the roster write below fails).
    const seen = new Map<string, YahooRosterEntry>();
    for (const entry of read.entries) {
      const { playerId, ambiguous: isAmbiguous } = await resolveRosterPlayer(leagueId, entry);
      processed++;
      if (isAmbiguous) ambiguous.push({ name: entry.name, yahooPlayerId: entry.yahooPlayerId, team: team.name });
      const owner = claimedBy.get(playerId);
      if (owner && owner !== team.id) {
        const keptOn = teams.find((t) => t.id === owner)?.name ?? owner;
        conflicts.push({ yahooPlayerId: entry.yahooPlayerId, keptOn, alsoOn: team.name });
        continue;
      }
      claimedBy.set(playerId, team.id);
      seen.set(playerId, entry);
    }

    if (!season) continue;

    const now = new Date();
    const change: RosterTeamChanges = {
      team: team.name,
      yahooTeamId: team.yahooTeamId!,
      added: [],
      movedIn: [],
      removed: [],
      unchanged: 0,
      ...(unreadable > 0 ? { rostersLeftUnchanged: "unreadable entries - no removals" } : {}),
    };

    await prisma.$transaction(async (tx) => {
      const seenIds = [...seen.keys()];
      const existing = await tx.rosterSpot.findMany({ where: { seasonId: season.id, playerId: { in: seenIds } } });
      const existingByPlayer = new Map(existing.map((s) => [s.playerId, s]));

      for (const [playerId, entry] of seen) {
        const prior = existingByPlayer.get(playerId);
        const movedHere = !prior || prior.teamId !== team.id;
        await tx.rosterSpot.upsert({
          where: { seasonId_playerId: { seasonId: season.id, playerId } },
          create: {
            seasonId: season.id,
            teamId: team.id,
            playerId,
            yahooPlayerKey: entry.yahooPlayerId,
            selectedPosition: entry.selectedPosition,
            onTeamSince: now,
            lastSeenAt: now,
            lastSyncLogId: syncLogId,
          },
          update: {
            teamId: team.id,
            yahooPlayerKey: entry.yahooPlayerId,
            selectedPosition: entry.selectedPosition,
            lastSeenAt: now,
            lastSyncLogId: syncLogId,
            ...(movedHere ? { onTeamSince: now } : {}),
          },
        });
        if (!prior) change.added.push(entry.yahooPlayerId);
        else if (movedHere) change.movedIn.push(entry.yahooPlayerId);
        else change.unchanged++;
      }

      // ~35 upserts per roster: well inside this, even against a cold database.
    }, { timeout: 30_000 });

    changes.push(change);
    // Removals wait until every roster is written (below), so a player
    // traded to a team processed later has already moved by then.
    if (unreadable === 0) pendingRemovals.push({ teamId: team.id, seenIds: [...seen.keys()], change });
  }

  // Spots still pointing at a fully-read team whose players Yahoo no longer
  // lists there: dropped, released, or traded to a team that didn't sync.
  for (const { teamId, seenIds, change } of season ? pendingRemovals : []) {
    await prisma.$transaction(async (tx) => {
      const stale = await tx.rosterSpot.findMany({
        where: { seasonId: season!.id, teamId, playerId: { notIn: seenIds } },
        select: { id: true, yahooPlayerKey: true },
      });
      if (stale.length > 0) {
        await tx.rosterSpot.deleteMany({ where: { id: { in: stale.map((s) => s.id) } } });
        change.removed.push(...stale.map((s) => s.yahooPlayerKey));
      }
    });
  }

  if (ambiguous.length > 0) {
    problems.push(
      `${ambiguous.length} player name(s) matched more than one existing player and were added as new Yahoo-linked players for review (${ambiguous
        .map((a) => a.name)
        .join(", ")})`
    );
  }
  if (conflicts.length > 0) {
    problems.push(
      `${conflicts.length} player(s) appeared on two Yahoo rosters in one sync and were kept on the first (${conflicts
        .map((c) => `${c.yahooPlayerId}: ${c.keptOn} / ${c.alsoOn}`)
        .join(", ")})`
    );
  }

  return {
    section: "players",
    recordsUpdated: processed,
    error: problems.length > 0 ? problems.join("; ") : undefined,
    detail: { rosters: changes, ambiguous, conflicts },
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

  // The roster step needs the Yahoo league's season, which only the league
  // (standings) response carries - the teams step records it here.
  const context: SyncContext = {};
  await runSection("teams+standings", () => syncTeamsAndStandings(leagueId, connection.yahooLeagueKey!, context));
  await runSection("players", () => syncRosters(leagueId, context.leagueMeta, syncLog.id));
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

  return { status, sections, totalRecordsUpdated, syncLogId: syncLog.id };
}
