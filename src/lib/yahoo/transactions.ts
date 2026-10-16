/**
 * Yahoo transaction ingestion: read, parse, resolve and write.
 *
 * One pipeline serves both the daily sync and the explicit recovery of
 * transactions synced before this detail existed (transaction-recovery.ts):
 *
 *   fetchLeagueTransactions  -> every raw transaction in a league, paged
 *   parseYahooTransaction    -> one raw transaction, validated (no DB)
 *   resolveTransaction       -> Yahoo team/player keys to Antlerboard ids (DB reads only)
 *   applyTransactionPlan     -> one idempotent write, keyed on Yahoo's transaction_key
 *
 * Yahoo's transaction resource (JSON) is `{transaction: [meta, {players}]}`.
 * `meta` holds transaction_key, type, status, timestamp, and - when Yahoo
 * reports them - faab_bid and, for trades, trader_team_key / tradee_team_key.
 * Each player is `{player: [[info...], {transaction_data}]}`, where
 * transaction_data carries type ("add" / "drop" / "trade"), source_type /
 * destination_type ("freeagents", "waivers", "team") and
 * source_team_key / destination_team_key when the side is a team. These are
 * the field names the league-history export already reads from real Yahoo
 * responses (src/lib/import/yahoo-transactions.ts), plus the team keys
 * Yahoo sends alongside the team names.
 *
 * Nothing here guesses. An unknown Yahoo type, an add whose source isn't
 * waivers or free agents, or a transaction without a key is not written and
 * is counted; a team or player that can't be matched by its Yahoo key is
 * left unlinked and recorded as an issue on the row, so the row shows as
 * incomplete rather than as a fully described move. Team names are never
 * matched - Yahoo team keys are the only team evidence used.
 */

import type { Prisma, PrismaClient, TransactionType } from "@prisma/client";
import { prisma } from "@/lib/db";
import { fantasyContent, readFields, toArray } from "./parse";
import { canonicalYahooPlayerId, yahooPlayerIdForms } from "./player-id";

type Db = PrismaClient | Prisma.TransactionClient;
type Json = Record<string, unknown>;

export const SUPPORTED_YAHOO_TYPES = ["add", "drop", "add/drop", "trade", "commish"] as const;
export type YahooTransactionKind = (typeof SUPPORTED_YAHOO_TYPES)[number];

/** Yahoo's status for a completed move. Anything else is stored as reported and shown as such. */
export const YAHOO_SUCCESSFUL = "successful";

const str = (v: unknown): string | null => (typeof v === "string" && v.trim().length > 0 ? v.trim() : typeof v === "number" ? String(v) : null);

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------

export type YahooGet = (path: string) => Promise<unknown>;

export interface FetchedTransactions {
  /** The league's own fields (league_key, season, ...) from the first page. */
  leagueMeta: Json;
  /** Each transaction's `transaction` array, in Yahoo's order, deduplicated by key. */
  entries: unknown[];
  /** Raw entries without a usable transaction_key - kept so they can be counted, never written. */
  entriesWithoutKey: number;
  pages: number;
  /** False when the log may continue past what was read. `incompleteReason` says why. */
  complete: boolean;
  incompleteReason: string | null;
}

export const TX_PAGE_SIZE = 25;
export const MAX_TX_PAGES = 200;

function leagueParts(data: unknown): unknown[] {
  return toArray(fantasyContent(data).league);
}

/**
 * Every transaction in a league, paged with `;start=N;count=25`. Advances by
 * what each page actually returned and stops on a page that adds nothing new,
 * so it is correct whether Yahoo honors the page size, caps it, or ignores it
 * and returns the whole log (the history export reads Yahoo the same way).
 *
 * The first page must carry the league's `transactions` field - a response
 * without it is unreadable, not an empty log. A request that fails after the
 * first page returns what was read with `complete: false`; a failure on the
 * first page throws, since nothing was read.
 */
export async function fetchLeagueTransactions(
  get: YahooGet,
  leagueKey: string,
  opts: { delayMs?: number; sleep?: (ms: number) => Promise<void>; maxPages?: number } = {}
): Promise<FetchedTransactions> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const maxPages = opts.maxPages ?? MAX_TX_PAGES;
  const seen = new Set<string>();
  const entries: unknown[] = [];
  let entriesWithoutKey = 0;
  let leagueMeta: Json = {};
  let pages = 0;
  let start = 0;

  while (true) {
    if (pages >= maxPages) {
      return { leagueMeta, entries, entriesWithoutKey, pages, complete: false, incompleteReason: `Stopped after ${maxPages} pages - the log may continue.` };
    }
    if (pages > 0 && opts.delayMs) await sleep(opts.delayMs);

    let data: unknown;
    try {
      data = await get(`/league/${leagueKey}/transactions;start=${start};count=${TX_PAGE_SIZE}`);
    } catch (err) {
      if (pages === 0) throw err;
      const message = err instanceof Error ? err.message : "Unknown error";
      return { leagueMeta, entries, entriesWithoutKey, pages, complete: false, incompleteReason: `Page ${pages + 1} failed (${message}); ${entries.length} transactions read before it.` };
    }
    pages++;

    const parts = leagueParts(data);
    const container = parts.find((p) => p && typeof p === "object" && !Array.isArray(p) && "transactions" in (p as object)) as
      | { transactions?: unknown }
      | undefined;
    if (pages === 1) {
      leagueMeta = readFields(parts[0]);
      if (!container) throw new MalformedYahooResponseError(`Yahoo's transactions response for ${leagueKey} has no transactions field - it couldn't be read.`);
      const answered = str(leagueMeta.league_key);
      if (answered && answered !== leagueKey) {
        throw new MalformedYahooResponseError(`Asked Yahoo for league ${leagueKey} but it answered for ${answered} - nothing read.`);
      }
    } else if (parts.length > 0) {
      const season = str(readFields(parts[0]).season);
      if (season && str(leagueMeta.season) && season !== str(leagueMeta.season)) {
        return { leagueMeta, entries, entriesWithoutKey, pages, complete: false, incompleteReason: `Page ${pages} reported season ${season}, the first page ${String(leagueMeta.season)} - stopped.` };
      }
    }

    const page = toArray(container?.transactions);
    let added = 0;
    let keyless = 0;
    for (const item of page) {
      const tx = (item as { transaction?: unknown })?.transaction;
      const key = transactionKeyOf(tx);
      if (!key) {
        keyless++;
        continue;
      }
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push(tx);
      added++;
    }
    // A keyless entry can't be deduplicated, so a repeated page (Yahoo
    // ignoring `start`) isn't counted again.
    if (added > 0 || pages === 1) entriesWithoutKey += keyless;
    if (page.length === 0 || added === 0) break;
    start += page.length;
  }

  return { leagueMeta, entries, entriesWithoutKey, pages, complete: true, incompleteReason: null };
}

export class MalformedYahooResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MalformedYahooResponseError";
  }
}

function metaOf(tx: unknown): Json {
  return readFields(toArray(tx)[0]);
}

export function transactionKeyOf(tx: unknown): string | null {
  return str(metaOf(tx).transaction_key);
}

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

export interface ParsedTransactionPlayer {
  /** Yahoo's season-scoped key ("469.p.12345"), when sent. */
  playerKey: string | null;
  /** The bare, season-independent id ("12345"). */
  canonicalId: string;
  name: string;
  mlbTeam: string | null;
  positions: string[];
  action: "add" | "drop" | "trade";
  sourceType: string | null;
  destinationType: string | null;
  sourceTeamKey: string | null;
  destinationTeamKey: string | null;
}

export interface ParsedTransaction {
  key: string;
  yahooType: YahooTransactionKind;
  type: TransactionType;
  status: string | null;
  /** Null when Yahoo sent no usable timestamp. Never filled in with "now". */
  timestamp: Date | null;
  faabBid: number | null;
  traderTeamKey: string | null;
  tradeeTeamKey: string | null;
  players: ParsedTransactionPlayer[];
  /** Things Yahoo's own record is missing or contradicts - the row is written but marked incomplete. */
  issues: string[];
}

export type ParseOutcome =
  | { ok: true; tx: ParsedTransaction }
  | { ok: false; key: string | null; kind: "missing_key" | "unsupported" | "malformed"; reason: string };

function parsePlayer(entry: unknown): ParsedTransactionPlayer | string {
  const parts = toArray((entry as { player?: unknown })?.player);
  if (parts.length === 0) return "a player entry with no player data";
  const info = readFields(parts[0]);
  const playerKey = str(info.player_key);
  const canonicalId = canonicalYahooPlayerId(str(info.player_id) ?? playerKey);
  const nameField = info.name;
  const name =
    nameField && typeof nameField === "object" && !Array.isArray(nameField)
      ? str((nameField as Json).full)
      : str(readFields(nameField).full);
  if (!canonicalId) return `a player with no Yahoo player id${name ? ` (${name})` : ""}`;

  const tdPart = parts.slice(1).find((p) => p && typeof p === "object" && "transaction_data" in (p as object)) as { transaction_data?: unknown } | undefined;
  const tdRaw = tdPart?.transaction_data;
  const td = readFields(Array.isArray(tdRaw) ? tdRaw[0] : tdRaw);
  const rawAction = str(td.type);
  if (rawAction !== "add" && rawAction !== "drop" && rawAction !== "trade") {
    return `${name ?? canonicalId}: Yahoo's transaction_data type is ${rawAction ? `"${rawAction}"` : "missing"}`;
  }
  return {
    playerKey,
    canonicalId,
    name: name ?? `Yahoo player ${canonicalId}`,
    mlbTeam: str(info.editorial_team_abbr)?.toUpperCase() ?? null,
    positions: (str(info.display_position) ?? "").split(",").map((p) => p.trim()).filter(Boolean),
    action: rawAction,
    sourceType: str(td.source_type),
    destinationType: str(td.destination_type),
    sourceTeamKey: str(td.source_team_key),
    destinationTeamKey: str(td.destination_team_key),
  };
}

/** The Antlerboard type for an add, from where Yahoo says the player came from. */
function addType(sourceType: string | null): TransactionType | null {
  if (sourceType === "waivers") return "WAIVER_ADD";
  if (sourceType === "freeagents") return "FREE_AGENT_ADD";
  return null;
}

/**
 * Validates one raw Yahoo transaction. Returns `ok: false` - never a guess -
 * when it can't be typed: no transaction_key, a Yahoo type this code doesn't
 * support, or an add whose source isn't waivers or free agents. Anything
 * else that's missing (a timestamp, a player row, a team key) is recorded
 * in `issues` and the row is written as incomplete.
 */
export function parseYahooTransaction(raw: unknown): ParseOutcome {
  const parts = toArray(raw);
  const meta = metaOf(raw);
  const key = str(meta.transaction_key);
  if (!key) return { ok: false, key: null, kind: "missing_key", reason: "Yahoo sent a transaction without a transaction_key." };

  const rawType = str(meta.type);
  if (!rawType || !(SUPPORTED_YAHOO_TYPES as readonly string[]).includes(rawType)) {
    return { ok: false, key, kind: "unsupported", reason: `${key}: Yahoo type ${rawType ? `"${rawType}"` : "(missing)"} isn't supported - not written.` };
  }
  const yahooType = rawType as YahooTransactionKind;
  const issues: string[] = [];

  const ts = Number(str(meta.timestamp) ?? NaN);
  const timestamp = Number.isFinite(ts) && ts > 0 ? new Date(ts * 1000) : null;
  if (!timestamp) issues.push("Yahoo sent no usable timestamp.");

  // Absent (or blank) means Yahoo reported no bid - never read as $0.
  const faabRaw = meta.faab_bid;
  let faabBid: number | null = null;
  if (faabRaw !== undefined && faabRaw !== null && !(typeof faabRaw === "string" && faabRaw.trim() === "")) {
    const n = typeof faabRaw === "number" || typeof faabRaw === "string" ? Number(faabRaw) : NaN;
    if (Number.isInteger(n) && n >= 0) faabBid = n;
    else issues.push(`Yahoo's faab_bid "${String(faabRaw)}" isn't a whole number - not recorded.`);
  }

  const playersContainer = parts.slice(1).find((p) => p && typeof p === "object" && "players" in (p as object)) as { players?: unknown } | undefined;
  const players: ParsedTransactionPlayer[] = [];
  for (const entry of toArray(playersContainer?.players)) {
    const parsed = parsePlayer(entry);
    if (typeof parsed === "string") issues.push(`Unreadable player: ${parsed}.`);
    else players.push(parsed);
  }

  let type: TransactionType;
  const adds = players.filter((p) => p.action === "add");
  const drops = players.filter((p) => p.action === "drop");
  const trades = players.filter((p) => p.action === "trade");
  switch (yahooType) {
    case "add":
    case "add/drop": {
      if (adds.length === 0) {
        return { ok: false, key, kind: "malformed", reason: `${key}: a Yahoo "${yahooType}" with no readable added player - its type can't be determined.` };
      }
      const types = new Set(adds.map((a) => addType(a.sourceType)));
      if (types.size !== 1 || types.has(null)) {
        const sources = [...new Set(adds.map((a) => a.sourceType ?? "(missing)"))].join(", ");
        return { ok: false, key, kind: "unsupported", reason: `${key}: added from "${sources}", not waivers or free agents - its type can't be determined.` };
      }
      type = [...types][0]!;
      if (yahooType === "add/drop" && drops.length === 0) issues.push("Yahoo's add/drop has no dropped player.");
      if (yahooType === "add" && drops.length > 0) issues.push("Yahoo's add also lists a dropped player.");
      break;
    }
    case "drop":
      type = "DROP";
      if (drops.length === 0) issues.push("Yahoo's drop has no dropped player.");
      break;
    case "trade":
      type = "TRADE";
      if (trades.length === 0) issues.push("Yahoo's trade lists no traded players.");
      break;
    case "commish":
      // Yahoo sends no player row for most commissioner moves; whatever it
      // does send is kept as reported.
      type = "COMMISSIONER_MOVE";
      break;
  }
  return {
    ok: true,
    tx: {
      key,
      yahooType,
      type,
      status: str(meta.status),
      timestamp,
      faabBid,
      traderTeamKey: str(meta.trader_team_key),
      tradeeTeamKey: str(meta.tradee_team_key),
      players,
      issues,
    },
  };
}

// ---------------------------------------------------------------------------
// Resolve (in memory, from one load of the league's teams and players)
// ---------------------------------------------------------------------------

export interface PlannedPlayer {
  yahooPlayerKey: string | null;
  canonicalId: string;
  name: string;
  /** The Antlerboard player matched by Yahoo identity; null when one would be created or it's ambiguous. */
  playerId: string | null;
  /** True when no player has this Yahoo identity and a new Yahoo-linked one would be created. */
  createPlayer: boolean;
  mlbTeam: string | null;
  positions: string[];
  action: "add" | "drop" | "trade";
  sourceType: string | null;
  destinationType: string | null;
  sourceTeamKey: string | null;
  destinationTeamKey: string | null;
  sourceTeamId: string | null;
  destinationTeamId: string | null;
}

export interface TransactionPlan {
  key: string;
  seasonId: string;
  seasonYear: number;
  yahooType: YahooTransactionKind;
  type: TransactionType;
  status: string | null;
  /** ISO time from Yahoo, or null when Yahoo sent none. */
  date: string | null;
  faabBid: number | null;
  players: PlannedPlayer[];
  teams: { teamId: string; role: "FROM" | "TO" }[];
  /** Empty when the transaction is fully described. */
  issues: string[];
}

export interface ResolveContext {
  leagueId: string;
  season: { id: string; year: number };
  /** Yahoo team_key -> Antlerboard Team id, for teams linked to Yahoo. */
  teamsByYahooKey: Map<string, string>;
  /** Canonical Yahoo player id -> every Antlerboard player stored with that identity (any key form). */
  playersByYahooId: Map<string, string[]>;
  /** Lower-cased name -> how many players with no Yahoo id carry it. */
  unlinkedNames: Map<string, number>;
}

export async function loadResolveContext(db: Db, leagueId: string, season: { id: string; year: number }): Promise<ResolveContext> {
  const [teams, players] = await Promise.all([
    db.team.findMany({ where: { leagueId, yahooTeamId: { not: null } }, select: { id: true, yahooTeamId: true } }),
    db.player.findMany({ where: { leagueId }, select: { id: true, yahooPlayerId: true, name: true } }),
  ]);
  const playersByYahooId = new Map<string, string[]>();
  const unlinkedNames = new Map<string, number>();
  for (const p of players) {
    if (p.yahooPlayerId === null) {
      const n = p.name.toLowerCase();
      unlinkedNames.set(n, (unlinkedNames.get(n) ?? 0) + 1);
      continue;
    }
    // Same identity rule as yahooPlayerIdForms: the bare id or a full key from any season.
    const canonical = canonicalYahooPlayerId(p.yahooPlayerId);
    if (!canonical) continue;
    playersByYahooId.set(canonical, [...(playersByYahooId.get(canonical) ?? []), p.id]);
  }
  return { leagueId, season, teamsByYahooKey: new Map(teams.map((t) => [t.yahooTeamId!, t.id])), playersByYahooId, unlinkedNames };
}

/** Records players created during a run so later transactions link to them instead of creating copies. */
export function rememberCreatedPlayers(ctx: ResolveContext, created: { canonicalId: string; playerId: string }[]) {
  for (const c of created) ctx.playersByYahooId.set(c.canonicalId, [c.playerId]);
}

function resolvePlayer(ctx: ResolveContext, p: ParsedTransactionPlayer): { playerId: string | null; createPlayer: boolean; issue?: string } {
  const sameIdentity = ctx.playersByYahooId.get(p.canonicalId) ?? [];
  if (sameIdentity.length === 1) return { playerId: sameIdentity[0], createPlayer: false };
  if (sameIdentity.length > 1) {
    return { playerId: null, createPlayer: false, issue: `${p.name} (Yahoo ${p.canonicalId}) matches more than one Antlerboard player - not linked.` };
  }
  // No player carries this Yahoo id. A same-named player without any Yahoo id
  // might be the same person entered by hand: don't guess, and don't add a
  // second copy next to it.
  const sameName = ctx.unlinkedNames.get(p.name.toLowerCase()) ?? 0;
  if (sameName > 0) {
    return { playerId: null, createPlayer: false, issue: `${p.name} (Yahoo ${p.canonicalId}) isn't linked to Yahoo, but ${sameName} unlinked player(s) share the name - not linked.` };
  }
  return { playerId: null, createPlayer: true };
}

function resolveTeam(ctx: ResolveContext, key: string | null, sideType: string | null, label: string, issues: string[]): string | null {
  if (sideType !== "team") return null;
  if (!key) {
    issues.push(`Yahoo gave no team key for ${label}.`);
    return null;
  }
  const id = ctx.teamsByYahooKey.get(key);
  if (!id) issues.push(`Yahoo team ${key} (${label}) isn't linked to an Antlerboard team.`);
  return id ?? null;
}

/** Maps a parsed transaction onto Antlerboard ids. Writes nothing; every gap becomes an issue. */
export function resolveTransaction(ctx: ResolveContext, tx: ParsedTransaction): TransactionPlan {
  const issues = [...tx.issues];
  const players: PlannedPlayer[] = [];
  for (const p of tx.players) {
    const r = resolvePlayer(ctx, p);
    if (r.issue) issues.push(r.issue);
    players.push({
      yahooPlayerKey: p.playerKey,
      canonicalId: p.canonicalId,
      name: p.name,
      playerId: r.playerId,
      createPlayer: r.createPlayer,
      mlbTeam: p.mlbTeam,
      positions: p.positions,
      action: p.action,
      sourceType: p.sourceType,
      destinationType: p.destinationType,
      sourceTeamKey: p.sourceTeamKey,
      destinationTeamKey: p.destinationTeamKey,
      sourceTeamId: resolveTeam(ctx, p.sourceTeamKey, p.sourceType, `${p.name}'s source`, issues),
      destinationTeamId: resolveTeam(ctx, p.destinationTeamKey, p.destinationType, `${p.name}'s destination`, issues),
    });
  }

  const teams: TransactionPlan["teams"] = [];
  const addTeam = (teamId: string | null, role: "FROM" | "TO") => {
    if (teamId && !teams.some((t) => t.teamId === teamId && t.role === role)) teams.push({ teamId, role });
  };
  for (const p of players) {
    addTeam(p.sourceTeamId, "FROM");
    addTeam(p.destinationTeamId, "TO");
  }
  if (tx.yahooType === "trade") {
    // Both sides of a trade, from Yahoo's own trader/tradee keys when its
    // players didn't already name them.
    for (const [key, label] of [[tx.traderTeamKey, "the trading team"], [tx.tradeeTeamKey, "the receiving team"]] as const) {
      if (!key) continue;
      const id = ctx.teamsByYahooKey.get(key);
      if (!id) issues.push(`Yahoo team ${key} (${label}) isn't linked to an Antlerboard team.`);
      else if (!teams.some((t) => t.teamId === id)) {
        addTeam(id, "FROM");
        addTeam(id, "TO");
      }
    }
    if (new Set(teams.map((t) => t.teamId)).size < 2) issues.push("Fewer than two teams could be identified for this trade.");
  }

  return {
    key: tx.key,
    seasonId: ctx.season.id,
    seasonYear: ctx.season.year,
    yahooType: tx.yahooType,
    type: tx.type,
    status: tx.status,
    date: tx.timestamp ? tx.timestamp.toISOString() : null,
    faabBid: tx.faabBid,
    players,
    teams,
    issues: [...new Set(issues)],
  };
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

export type ApplyOutcome =
  | "created"
  | "updated"
  | "unchanged"
  /** An existing row synced before detailed ingestion - only the explicit recovery step may fill it in. */
  | "legacy_skipped"
  /** The stored row belongs to another season - never moved silently. */
  | "season_conflict";

export interface ApplyResult {
  outcome: ApplyOutcome;
  transactionId: string | null;
  createdPlayers: { canonicalId: string; playerId: string }[];
  /** The plan's issues plus any found while comparing with the stored row. */
  issues: string[];
}

const existingInclude = { players: true, teams: true } as const;
export type ExistingTransaction = Prisma.TransactionGetPayload<{ include: typeof existingInclude }>;

/** The stored Yahoo rows for these keys, with their links - one query for a whole run. */
export async function loadExistingByKey(db: Db, keys: string[]): Promise<Map<string, ExistingTransaction>> {
  const rows = keys.length === 0 ? [] : await db.transaction.findMany({ where: { yahooTransactionId: { in: keys } }, include: existingInclude });
  return new Map(rows.map((r) => [r.yahooTransactionId!, r]));
}

function linkFields(p: PlannedPlayer) {
  return {
    action: p.action,
    sourceType: p.sourceType,
    destinationType: p.destinationType,
    sourceTeamId: p.sourceTeamId,
    destinationTeamId: p.destinationTeamId,
    yahooPlayerKey: p.yahooPlayerKey,
  };
}

interface WriteDiff {
  outcome: ApplyOutcome;
  issues: string[];
  /** Transaction columns to set (null: leave the row's columns as they are). */
  columns: { type: TransactionType; yahooType: string; yahooStatus: string | null; faabBid: number | null; dateUnavailable: boolean; date: Date | null; yahooDetailIssues: string[] } | null;
  links: PlannedPlayer[];
  newTeams: TransactionPlan["teams"];
}

/**
 * What writing `plan` over `existing` would change. Pure: the sync uses it to
 * skip unchanged rows without a write, and the recovery report shows it.
 */
export function diffTransaction(existing: ExistingTransaction | null, plan: TransactionPlan, opts: { allowLegacy?: boolean } = {}): WriteDiff {
  const issues = [...plan.issues];
  if (existing && existing.yahooType === null && !opts.allowLegacy) {
    return { outcome: "legacy_skipped", issues, columns: null, links: [], newTeams: [] };
  }
  if (existing && existing.seasonId !== plan.seasonId) {
    return {
      outcome: "season_conflict",
      issues: [...issues, `Stored in another season (${existing.seasonYear}), Yahoo says ${plan.seasonYear} - left as is.`],
      columns: null,
      links: [],
      newTeams: [],
    };
  }

  const linkable = plan.players.filter((p) => p.playerId || p.createPlayer);
  if (!existing) {
    return {
      outcome: "created",
      issues,
      columns: { type: plan.type, yahooType: plan.yahooType, yahooStatus: plan.status, faabBid: plan.faabBid, dateUnavailable: plan.date === null, date: plan.date ? new Date(plan.date) : null, yahooDetailIssues: issues },
      links: linkable,
      newTeams: plan.teams,
    };
  }

  // Links stored earlier that Yahoo's current record doesn't include: kept, flagged.
  const plannedPlayerIds = new Set(plan.players.map((p) => p.playerId).filter(Boolean));
  for (const stale of existing.players.filter((tp) => !plannedPlayerIds.has(tp.playerId))) {
    issues.push(`Player link ${stale.playerId} is stored but not in Yahoo's current record - kept for review.`);
  }
  const plannedTeams = new Set(plan.teams.map((t) => `${t.teamId}:${t.role}`));
  for (const stale of existing.teams.filter((tt) => !plannedTeams.has(`${tt.teamId}:${tt.role}`))) {
    issues.push(`Team link ${stale.teamId} (${stale.role}) is stored but not in Yahoo's current record - kept for review.`);
  }

  // A stored date came from Yahoo's timestamp when it had one; keep it unless Yahoo now sends one.
  const date = plan.date ? new Date(plan.date) : existing.date;
  const columns = { type: plan.type, yahooType: plan.yahooType, yahooStatus: plan.status, faabBid: plan.faabBid, dateUnavailable: plan.date === null, date, yahooDetailIssues: issues };
  const columnsChanged =
    existing.type !== columns.type ||
    existing.yahooType !== columns.yahooType ||
    existing.yahooStatus !== columns.yahooStatus ||
    existing.faabBid !== columns.faabBid ||
    existing.dateUnavailable !== columns.dateUnavailable ||
    existing.date.getTime() !== date.getTime() ||
    JSON.stringify(existing.yahooDetailIssues) !== JSON.stringify(issues);

  const stored = new Map(existing.players.map((tp) => [tp.playerId, tp]));
  const links = linkable.filter((p) => {
    const prior = p.playerId ? stored.get(p.playerId) : undefined;
    if (!prior) return true;
    const want = linkFields(p);
    return (Object.keys(want) as (keyof typeof want)[]).some((k) => prior[k] !== want[k]);
  });
  const storedTeams = new Set(existing.teams.map((tt) => `${tt.teamId}:${tt.role}`));
  const newTeams = plan.teams.filter((t) => !storedTeams.has(`${t.teamId}:${t.role}`));

  const changed = columnsChanged || links.length > 0 || newTeams.length > 0;
  return { outcome: changed ? "updated" : "unchanged", issues, columns: columnsChanged ? columns : null, links, newTeams };
}

/**
 * Writes one planned transaction, keyed on Yahoo's transaction_key. Run it
 * inside a database transaction:
 *
 *  - a new key creates the row with its player and team links;
 *  - a known key updates Yahoo's fields (type, status, date, FAAB) and adds
 *    or corrects links - replaying the same source changes nothing;
 *  - a link stored earlier that Yahoo no longer reports is kept, never
 *    deleted, and recorded as an issue for review;
 *  - a row synced before detailed ingestion (yahooType null) is left alone
 *    unless `allowLegacy` - the explicit recovery step - is set;
 *  - a row in another season is never moved.
 *
 * Players Yahoo names that no Antlerboard player carries are created as
 * Yahoo-linked players (the roster sync does the same). Acquisitions and
 * keeper records are never written here.
 */
export async function applyTransactionPlan(db: Db, leagueId: string, plan: TransactionPlan, opts: { allowLegacy?: boolean; now?: Date } = {}): Promise<ApplyResult> {
  const now = opts.now ?? new Date();
  const existing = await db.transaction.findUnique({ where: { yahooTransactionId: plan.key }, include: existingInclude });
  const diff = diffTransaction(existing, plan, opts);
  const result: ApplyResult = { outcome: diff.outcome, transactionId: existing?.id ?? null, createdPlayers: [], issues: diff.issues };
  if (diff.outcome === "unchanged" || diff.outcome === "legacy_skipped" || diff.outcome === "season_conflict") return result;

  let transactionId: string;
  if (!existing) {
    const { date, ...columns } = diff.columns!;
    const created = await db.transaction.create({
      data: {
        seasonId: plan.seasonId,
        seasonYear: plan.seasonYear,
        yahooTransactionId: plan.key,
        // A missing timestamp is stored as the time the row was first written
        // and flagged (dateUnavailable), so it's never shown as the real date.
        date: date ?? now,
        ...columns,
        yahooDetailSyncedAt: now,
      },
    });
    transactionId = created.id;
  } else {
    transactionId = existing.id;
    if (diff.columns) {
      await db.transaction.update({ where: { id: existing.id }, data: { ...diff.columns, date: diff.columns.date ?? existing.date, yahooDetailSyncedAt: now } });
    }
  }
  result.transactionId = transactionId;

  for (const p of diff.links) {
    let playerId = p.playerId;
    if (!playerId) {
      // The plan was resolved from a snapshot; another writer (the roster
      // sync, or the daily sync during a recovery) may have added this Yahoo
      // identity since. Link that player rather than create a second one.
      const sameIdentity = await db.player.findMany({ where: { leagueId, OR: yahooPlayerIdForms(p.canonicalId) }, select: { id: true }, take: 2 });
      if (sameIdentity.length > 1) throw new Error(`${p.name} (Yahoo ${p.canonicalId}) now matches more than one Antlerboard player - not written.`);
      playerId = sameIdentity[0]?.id ?? null;
    }
    if (!playerId) {
      const created = await db.player.create({
        data: { leagueId, yahooPlayerId: p.yahooPlayerKey ?? p.canonicalId, name: p.name, mlbTeam: p.mlbTeam, positions: p.positions },
      });
      playerId = created.id;
      result.createdPlayers.push({ canonicalId: p.canonicalId, playerId });
    }
    await db.transactionPlayer.upsert({
      where: { transactionId_playerId: { transactionId, playerId } },
      create: { transactionId, playerId, ...linkFields(p) },
      update: linkFields(p),
    });
  }
  if (diff.newTeams.length > 0) {
    await db.transactionTeam.createMany({ data: diff.newTeams.map((t) => ({ transactionId, ...t })), skipDuplicates: true });
  }
  return result;
}

// ---------------------------------------------------------------------------
// The sync section
// ---------------------------------------------------------------------------

export interface TransactionSyncCounts {
  read: number;
  pages: number;
  created: number;
  updated: number;
  unchanged: number;
  /** Written, but with issues (unresolved team/player, missing timestamp, ...). */
  incomplete: number;
  playersCreated: number;
  skippedMissingKey: number;
  skippedUnsupported: number;
  skippedMalformed: number;
  legacyAwaitingRecovery: number;
  seasonConflicts: number;
  writeErrors: number;
}

export interface TransactionSyncReport {
  counts: TransactionSyncCounts;
  complete: boolean;
  incompleteReason: string | null;
  /** Up to 25 examples per problem kind, for the SyncLog. */
  examples: Record<string, string[]>;
  /** One line per problem, empty when the run is a clean SUCCESS. */
  problems: string[];
}

export function emptyCounts(): TransactionSyncCounts {
  return {
    read: 0,
    pages: 0,
    created: 0,
    updated: 0,
    unchanged: 0,
    incomplete: 0,
    playersCreated: 0,
    skippedMissingKey: 0,
    skippedUnsupported: 0,
    skippedMalformed: 0,
    legacyAwaitingRecovery: 0,
    seasonConflicts: 0,
    writeErrors: 0,
  };
}

/**
 * Syncs one Yahoo league's transaction log into one Antlerboard season.
 *
 * `expectedSeasonYear` pins the season for historical recovery: the run
 * refuses unless Yahoo's league reports that same season. Without it the
 * season is the one Yahoo reports, and it must already exist in Antlerboard.
 * Every problem - a skipped or unsupported transaction, an incomplete row, a
 * page that couldn't be read - is listed in `problems`, which makes the
 * sync PARTIAL; a clean run has none.
 */
export async function syncLeagueTransactions(
  leagueId: string,
  leagueKey: string,
  get: YahooGet,
  opts: { expectedSeasonYear?: number; delayMs?: number; sleep?: (ms: number) => Promise<void>; maxPages?: number; now?: Date } = {}
): Promise<TransactionSyncReport> {
  const counts = emptyCounts();
  const examples: Record<string, string[]> = {};
  const note = (kind: string, line: string) => {
    examples[kind] ??= [];
    if (examples[kind].length < 25) examples[kind].push(line);
  };

  const fetched = await fetchLeagueTransactions(get, leagueKey, opts);
  counts.read = fetched.entries.length;
  counts.pages = fetched.pages;
  counts.skippedMissingKey = fetched.entriesWithoutKey;

  const year = Number(fetched.leagueMeta.season);
  if (!Number.isInteger(year) || year <= 0) {
    throw new Error("Yahoo didn't report which season this league is - no transactions written.");
  }
  if (opts.expectedSeasonYear !== undefined && year !== opts.expectedSeasonYear) {
    throw new Error(`Yahoo league ${leagueKey} is the ${year} season, not ${opts.expectedSeasonYear} - no transactions written.`);
  }
  const season = await prisma.season.findUnique({ where: { leagueId_year: { leagueId, year } } });
  if (!season) throw new Error(`No ${year} season exists in Antlerboard - create it before syncing. No transactions written.`);

  const ctx = await loadResolveContext(prisma, leagueId, season);
  const parsedAll = fetched.entries.map(parseYahooTransaction);
  const existingByKey = await loadExistingByKey(prisma, parsedAll.flatMap((p) => (p.ok ? [p.tx.key] : [])));

  for (const parsed of parsedAll) {
    if (!parsed.ok) {
      if (parsed.kind === "missing_key") counts.skippedMissingKey++;
      else if (parsed.kind === "unsupported") counts.skippedUnsupported++;
      else counts.skippedMalformed++;
      note(parsed.kind, parsed.reason);
      continue;
    }
    try {
      const plan = resolveTransaction(ctx, parsed.tx);
      // Unchanged rows (the daily case) need no write at all.
      const preview = diffTransaction(existingByKey.get(plan.key) ?? null, plan);
      const result: { outcome: ApplyOutcome; issues: string[]; createdPlayers: ApplyResult["createdPlayers"] } =
        preview.outcome === "unchanged" || preview.outcome === "legacy_skipped" || preview.outcome === "season_conflict"
          ? { outcome: preview.outcome, issues: preview.issues, createdPlayers: [] }
          : await prisma.$transaction((tx) => applyTransactionPlan(tx, leagueId, plan, { now: opts.now }));
      rememberCreatedPlayers(ctx, result.createdPlayers);
      counts.playersCreated += result.createdPlayers.length;
      if (result.outcome === "legacy_skipped") {
        counts.legacyAwaitingRecovery++;
        continue;
      }
      if (result.outcome === "season_conflict") {
        counts.seasonConflicts++;
        note("season_conflict", `${plan.key}: ${result.issues[result.issues.length - 1]}`);
        continue;
      }
      counts[result.outcome]++;
      if (result.issues.length > 0) {
        counts.incomplete++;
        note("incomplete", `${plan.key}: ${result.issues.join(" ")}`);
      }
    } catch (err) {
      counts.writeErrors++;
      note("write_error", `${parsed.tx.key}: ${err instanceof Error ? err.message : "Unknown error"}`);
    }
  }

  const problems: string[] = [];
  if (!fetched.complete) problems.push(`Transaction log not read to the end: ${fetched.incompleteReason}`);
  if (counts.skippedMissingKey) problems.push(`${counts.skippedMissingKey} transaction(s) had no Yahoo transaction_key and were skipped`);
  if (counts.skippedUnsupported) problems.push(`${counts.skippedUnsupported} transaction(s) have a type that can't be determined and were skipped (${examples.unsupported?.[0] ?? ""})`);
  if (counts.skippedMalformed) problems.push(`${counts.skippedMalformed} transaction(s) couldn't be read and were skipped (${examples.malformed?.[0] ?? ""})`);
  if (counts.incomplete) problems.push(`${counts.incomplete} transaction(s) were written without full team/player detail (${examples.incomplete?.[0] ?? ""})`);
  if (counts.legacyAwaitingRecovery) problems.push(`${counts.legacyAwaitingRecovery} transaction(s) synced before detailed ingestion still lack teams and players - run the transaction recovery dry run`);
  if (counts.seasonConflicts) problems.push(`${counts.seasonConflicts} transaction(s) are stored under a different season than Yahoo reports - left as is`);
  if (counts.writeErrors) problems.push(`${counts.writeErrors} transaction(s) failed to write (${examples.write_error?.[0] ?? ""})`);

  return { counts, complete: fetched.complete, incompleteReason: fetched.incompleteReason, examples, problems };
}
