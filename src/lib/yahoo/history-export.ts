/**
 * Read-only recovery of the league's historical Yahoo data: every past
 * season reachable from the connected league, with its settings, teams,
 * auction draft results and complete transaction log. Nothing here writes
 * - not to Yahoo, not to the database (the route calls Yahoo with
 * allowRefresh: false, so even the token is never refreshed).
 *
 * Seasons are found the way Yahoo links them: each renewed league's
 * metadata carries `renew` = "{previous game_key}_{previous league_id}",
 * so the chain is walked back from the connected league until it ends or
 * passes LEAGUE_FIRST_SEASON_YEAR. A season Yahoo refuses (403/404) stops
 * the walk - its own `renew` can't be read - and is reported, not guessed.
 *
 * Everything Yahoo returns is kept as-is where it matters (raw transaction
 * JSON, player and team keys), and nothing missing is filled in: a draft
 * pick with no `cost` stays null, a section that failed is an error in the
 * report. The transactions CSV is the exact `season, league_key,
 * transaction_raw` format the league-history import already reads.
 */

import { fantasyContent, mergeMeta, readFields, toArray } from "./parse";

export type YahooGet = (path: string) => Promise<unknown>;

export interface ExportOptions {
  /** Oldest season to export (the league's first season in Antlerboard). */
  firstSeasonYear: number;
  /** Pause between Yahoo requests, to stay well inside its rate limits. */
  delayMs?: number;
  /** Skip the per-player lookups for draft picks (the report doesn't need names). */
  resolveDraftPlayers?: boolean;
  /** Export only this season; others on the way are read for their settings (the season link) only. */
  onlySeason?: number;
  /**
   * Errors that end the whole export instead of being recorded as a gap -
   * an expired or rejected token fails every request, so reporting it per
   * section would misreport accessible seasons as refused.
   */
  isFatal?: (err: unknown) => boolean;
  sleep?: (ms: number) => Promise<void>;
  /**
   * Epoch ms after which no new Yahoo request starts. Whatever wasn't read
   * by then is reported as not checked - never as refused or missing - so a
   * slow run degrades to a partial report instead of a timed-out request.
   */
  deadline?: number;
  now?: () => number;
}

/** Raised instead of making a request once the time budget is spent. */
export class TimeBudgetExceeded extends Error {
  constructor() {
    super("Not read in this run: the time budget ran out before this request.");
    this.name = "TimeBudgetExceeded";
  }
}

export interface ExportedTeam {
  teamKey: string;
  name: string;
  /** Manager nicknames and ids only - Yahoo's email/guid/image fields are dropped. */
  managers: { managerId: string | null; nickname: string | null; isCommissioner: boolean }[];
}

export interface ExportedDraftPick {
  pick: number;
  round: number | null;
  teamKey: string | null;
  playerKey: string | null;
  /** The winning bid, exactly as Yahoo reports it; null when Yahoo has none (never 0 as a stand-in). */
  cost: number | null;
  player: { playerId: string | null; name: string | null; mlbTeam: string | null; positions: string[] } | null;
}

export interface SeasonExport {
  seasonYear: number | null;
  leagueKey: string;
  leagueName: string | null;
  renew: string | null;
  settings: { draftType: string | null; isAuctionDraft: boolean | null; usesFaab: boolean | null; draftStatus: string | null; numTeams: number | null };
  teams: ExportedTeam[];
  draftResults: ExportedDraftPick[];
  /** Each transaction exactly as Yahoo returned it: [metadata, players?]. */
  transactionsRaw: unknown[][];
  transactionPages: number;
  errors: { section: string; message: string }[];
  /** The time budget ran out while reading this season: whatever is here is incomplete. */
  incomplete: boolean;
}

export interface HistoryExport {
  startLeagueKey: string;
  seasons: SeasonExport[];
  /** Why the season walk stopped. */
  discovery: { stoppedBecause: string; olderLeagueKey: string | null };
}

const TX_PAGE_SIZE = 25;
const PLAYER_BATCH = 25;
const MAX_SEASONS = 20;
const MAX_TX_PAGES = 400;

const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : typeof v === "number" ? String(v) : null);
const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};
const bool = (v: unknown): boolean | null => (v === 1 || v === "1" || v === true ? true : v === 0 || v === "0" || v === false ? false : null);
const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** The named sub-resource of a /league/{key}/... response (league is [metadata, {field: ...}]). */
function leagueSection(data: unknown, field: string): unknown {
  const parts = toArray(fantasyContent(data).league);
  const found = parts.find((p) => p && typeof p === "object" && !Array.isArray(p) && field in (p as object));
  return found ? (found as Record<string, unknown>)[field] : undefined;
}

/** "458_12345" -> "458.l.12345"; anything else -> null. */
export function renewToLeagueKey(renew: string | null): string | null {
  const m = renew?.match(/^(\d+)_(\d+)$/);
  return m ? `${m[1]}.l.${m[2]}` : null;
}

export async function exportLeagueHistory(get: YahooGet, startLeagueKey: string, opts: ExportOptions): Promise<HistoryExport> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const delay = opts.delayMs ?? 150;
  const now = opts.now ?? Date.now;
  let calls = 0;
  const call = async (path: string) => {
    if (calls++ > 0 && delay > 0) await sleep(delay);
    if (opts.deadline !== undefined && now() >= opts.deadline) throw new TimeBudgetExceeded();
    return get(path);
  };

  const seasons: SeasonExport[] = [];
  let leagueKey: string | null = startLeagueKey;
  let stoppedBecause = "Reached the oldest season linked from the connected league.";
  let olderLeagueKey: string | null = null;
  const seen = new Set<string>();

  while (leagueKey) {
    if (seen.has(leagueKey) || seasons.length >= MAX_SEASONS) {
      stoppedBecause = "Stopped: the season chain repeated or ran unexpectedly long.";
      break;
    }
    seen.add(leagueKey);
    const season = await exportSeason(call, leagueKey, opts.resolveDraftPlayers ?? true, opts.onlySeason, opts.isFatal ?? (() => false));
    if (opts.onlySeason === undefined || season.seasonYear === opts.onlySeason || season.errors.length > 0) seasons.push(season);
    if (opts.onlySeason !== undefined && season.seasonYear !== null && season.seasonYear <= opts.onlySeason) {
      if (season.seasonYear < opts.onlySeason) stoppedBecause = `Season ${opts.onlySeason} isn't in the chain linked from the connected league.`;
      break;
    }

    if (season.incomplete) {
      stoppedBecause = `The time budget ran out while reading ${leagueKey}; download that season (and any older ones) one at a time.`;
      break;
    }
    if (season.errors.some((e) => e.section === "settings")) {
      stoppedBecause = `Yahoo refused ${leagueKey}'s settings, so older seasons linked from it can't be found.`;
      break;
    }
    const previous = renewToLeagueKey(season.renew);
    if (!previous) break;
    if (season.seasonYear !== null && season.seasonYear - 1 < opts.firstSeasonYear) {
      stoppedBecause = `Stopped at ${opts.firstSeasonYear}, Antlerboard's first season; Yahoo links an older season (${previous}) that isn't exported.`;
      olderLeagueKey = previous;
      break;
    }
    leagueKey = previous;
  }

  return { startLeagueKey, seasons, discovery: { stoppedBecause, olderLeagueKey } };
}

async function exportSeason(
  call: (path: string) => Promise<unknown>,
  leagueKey: string,
  resolvePlayers: boolean,
  onlySeason: number | undefined,
  isFatal: (err: unknown) => boolean
): Promise<SeasonExport> {
  const out: SeasonExport = {
    seasonYear: null,
    leagueKey,
    leagueName: null,
    renew: null,
    settings: { draftType: null, isAuctionDraft: null, usesFaab: null, draftStatus: null, numTeams: null },
    teams: [],
    draftResults: [],
    transactionsRaw: [],
    transactionPages: 0,
    errors: [],
    incomplete: false,
  };
  // A spent time budget ends this season's reading; it isn't a Yahoo answer.
  const budgetSpent = (err: unknown, section: string) => {
    if (!(err instanceof TimeBudgetExceeded)) return false;
    out.incomplete = true;
    out.errors.push({ section, message: err.message });
    return true;
  };

  try {
    const data = await call(`/league/${leagueKey}/settings`);
    const meta = readFields(toArray(fantasyContent(data).league)[0]);
    const settings = readFields(toArray(leagueSection(data, "settings"))[0]);
    out.seasonYear = num(meta.season);
    out.leagueName = str(meta.name);
    out.renew = str(meta.renew);
    out.settings = {
      draftType: str(settings.draft_type),
      isAuctionDraft: bool(settings.is_auction_draft),
      usesFaab: bool(settings.uses_faab),
      draftStatus: str(meta.draft_status),
      numTeams: num(meta.num_teams),
    };
  } catch (err) {
    if (isFatal(err)) throw err;
    if (budgetSpent(err, "settings")) return out;
    out.errors.push({ section: "settings", message: errorMessage(err) });
    return out; // nothing else for this league is worth asking for
  }
  if (onlySeason !== undefined && out.seasonYear !== onlySeason) return out; // passing through

  try {
    const data = await call(`/league/${leagueKey}/teams`);
    for (const entry of toArray(leagueSection(data, "teams"))) {
      const team = (entry as { team?: unknown })?.team;
      const meta = mergeMeta(Array.isArray(team) ? team[0] : team);
      out.teams.push({
        teamKey: str(meta.team_key) ?? "",
        name: str(meta.name) ?? "",
        managers: toArray(meta.managers).map((m) => {
          const mgr = readFields((m as { manager?: unknown })?.manager);
          return { managerId: str(mgr.manager_id), nickname: str(mgr.nickname), isCommissioner: bool(mgr.is_commissioner) === true };
        }),
      });
    }
  } catch (err) {
    if (isFatal(err)) throw err;
    if (budgetSpent(err, "teams")) return out;
    out.errors.push({ section: "teams", message: errorMessage(err) });
  }

  try {
    const data = await call(`/league/${leagueKey}/draftresults`);
    for (const entry of toArray(leagueSection(data, "draft_results"))) {
      const r = readFields((entry as { draft_result?: unknown })?.draft_result);
      const pick = num(r.pick);
      if (pick === null) continue;
      out.draftResults.push({ pick, round: num(r.round), teamKey: str(r.team_key), playerKey: str(r.player_key), cost: num(r.cost), player: null });
    }
    out.draftResults.sort((a, b) => a.pick - b.pick);
  } catch (err) {
    if (isFatal(err)) throw err;
    if (budgetSpent(err, "draftresults")) return out;
    out.errors.push({ section: "draftresults", message: errorMessage(err) });
  }

  if (resolvePlayers) {
    const keys = [...new Set(out.draftResults.map((d) => d.playerKey).filter((k): k is string => !!k))];
    const players = new Map<string, ExportedDraftPick["player"]>();
    try {
      for (let i = 0; i < keys.length; i += PLAYER_BATCH) {
        const data = await call(`/league/${leagueKey}/players;player_keys=${keys.slice(i, i + PLAYER_BATCH).join(",")}`);
        for (const entry of toArray(leagueSection(data, "players"))) {
          const player = (entry as { player?: unknown })?.player;
          const meta = mergeMeta(Array.isArray(player) ? player[0] : player);
          const key = str(meta.player_key);
          if (!key) continue;
          players.set(key, {
            playerId: str(meta.player_id),
            name: str((meta.name as { full?: unknown } | undefined)?.full),
            mlbTeam: str(meta.editorial_team_abbr),
            positions: (str(meta.display_position) ?? "").split(",").map((p) => p.trim()).filter(Boolean),
          });
        }
      }
    } catch (err) {
      if (isFatal(err)) throw err;
      if (budgetSpent(err, "players")) return out;
      out.errors.push({ section: "players", message: errorMessage(err) });
    }
    for (const d of out.draftResults) d.player = (d.playerKey && players.get(d.playerKey)) || null;
  }

  // Paged by start/count. Advances by what each page actually returned and
  // stops when a page adds nothing new - correct whether Yahoo honors the
  // page size, caps it lower, or ignores it and returns everything.
  try {
    const seen = new Set<string>();
    let start = 0;
    while (out.transactionPages < MAX_TX_PAGES) {
      const data = await call(`/league/${leagueKey}/transactions;start=${start};count=${TX_PAGE_SIZE}`);
      out.transactionPages++;
      const page = toArray(leagueSection(data, "transactions"))
        .map((e) => (e as { transaction?: unknown })?.transaction)
        .filter((t): t is unknown[] => Array.isArray(t) && t.length > 0);
      let added = 0;
      for (const tx of page) {
        const key = str(readFields(tx[0]).transaction_key);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        out.transactionsRaw.push(tx);
        added++;
      }
      if (page.length === 0 || added === 0) break;
      start += page.length;
    }
    if (out.transactionPages >= MAX_TX_PAGES) out.errors.push({ section: "transactions", message: `Stopped after ${MAX_TX_PAGES} pages - the log may be incomplete.` });
  } catch (err) {
    if (isFatal(err)) throw err;
    if (budgetSpent(err, "transactions")) return out;
    out.errors.push({ section: "transactions", message: `${errorMessage(err)} (${out.transactionsRaw.length} transactions read before the error)` });
  }

  return out;
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const csvLine = (cells: unknown[]) => cells.map(csvCell).join(",");

/**
 * The league-history import's Yahoo export format: one metadata row per
 * transaction, then its players row (commissioner moves have none).
 */
export function transactionsCsv(seasons: SeasonExport[]): string {
  const lines = [csvLine(["season", "league_key", "transaction_raw"])];
  for (const s of seasons) {
    for (const tx of s.transactionsRaw) {
      for (const part of tx.slice(0, 2)) lines.push(csvLine([s.seasonYear ?? "", s.leagueKey, JSON.stringify(part)]));
    }
  }
  return lines.join("\n") + "\n";
}

/**
 * Spreadsheet apps run a cell starting with = + - @ as a formula, and team
 * names are user-chosen - so text cells in the draft CSV get a leading
 * apostrophe there. (The transactions CSV is raw JSON for the importer and
 * is never altered.)
 */
const safeText = (v: string | null | undefined) => (v && /^[=+\-@\t\r]/.test(v) ? `'${v}` : (v ?? ""));

export function draftCsv(season: SeasonExport): string {
  const teamName = new Map(season.teams.map((t) => [t.teamKey, t.name]));
  const lines = [csvLine(["Season", "Pick", "Round", "Player", "Player_ID", "Player_Key", "MLB_Team", "Positions", "Salary", "Team_Key", "Fantasy_Team"])];
  for (const d of season.draftResults) {
    lines.push(
      csvLine([
        season.seasonYear ?? "",
        d.pick,
        d.round ?? "",
        safeText(d.player?.name),
        d.player?.playerId ?? "",
        d.playerKey ?? "",
        d.player?.mlbTeam ?? "",
        d.player?.positions.join("/") ?? "",
        d.cost ?? "",
        d.teamKey ?? "",
        safeText(d.teamKey ? teamName.get(d.teamKey) : null),
      ])
    );
  }
  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// Recovery report
// ---------------------------------------------------------------------------

export interface AntlerboardComparison {
  seasonYear: number;
  leagueKey: string;
  storedTransactionKeys: string[];
}

export interface RecoveryReport {
  startLeagueKey: string;
  discovery: HistoryExport["discovery"];
  seasons: {
    seasonYear: number | null;
    leagueKey: string;
    leagueName: string | null;
    draft: { isAuction: boolean | null; picks: number; pricedPicks: number; unpricedPicks: number; playersResolved: number };
    transactions: { count: number; pages: number; byType: Record<string, number>; withFaabBid: number; firstAt: string | null; lastAt: string | null };
    teams: number;
    errors: SeasonExport["errors"];
    incomplete: boolean;
    antlerboard: { storedTransactions: number; matchedByKey: number; onlyInYahoo: number; onlyInAntlerboard: number } | null;
  }[];
  recovered: string[];
  inaccessible: string[];
  requiresOriginalFiles: string[];
  /** Seasons this run didn't finish reading (time budget) - neither recovered nor missing; check them one at a time. */
  notChecked: string[];
}

/** Facts no Yahoo endpoint holds for this league - they come from the commissioner's workbook regardless. */
const ALWAYS_FROM_FILES = [
  "Recorded keeper costs and commissioner overrides (the league's own ladder; Yahoo has no keeper-cost field) - master workbook manager sheets.",
  "Which picks were keepers: Yahoo's draft results carry no keeper marker - master workbook keeper lists (and the auction file's keeper sheet).",
  "Offseason trades made between Yahoo seasons - master workbook 'Off Season Trades' plus the commissioner-confirmed trades in known-league-history.ts.",
  "Pre-2021 franchise handoffs and team-season records - known-league-history.ts and the workbook.",
  "FYPD drafts - not on Yahoo; already stored in Antlerboard and verified (2025: 60 picks, 2026: 53).",
];

export function buildRecoveryReport(history: HistoryExport, comparisons: AntlerboardComparison[]): RecoveryReport {
  const recovered: string[] = [];
  const inaccessible: string[] = [];
  const requiresOriginalFiles: string[] = [];
  const notChecked: string[] = [];

  const seasons = history.seasons.map((s) => {
    const byType: Record<string, number> = {};
    let withFaabBid = 0;
    const times: number[] = [];
    for (const tx of s.transactionsRaw) {
      const meta = readFields(tx[0]);
      const type = str(meta.type) ?? "unknown";
      byType[type] = (byType[type] ?? 0) + 1;
      if (num(meta.faab_bid) !== null) withFaabBid++;
      const ts = num(meta.timestamp);
      if (ts !== null) times.push(ts * 1000);
    }
    const priced = s.draftResults.filter((d) => d.cost !== null).length;
    const cmp = comparisons.find((c) => c.leagueKey === s.leagueKey);
    let antlerboard: RecoveryReport["seasons"][number]["antlerboard"] = null;
    if (cmp) {
      const yahooKeys = new Set(s.transactionsRaw.map((tx) => str(readFields(tx[0]).transaction_key)).filter((k): k is string => !!k));
      const stored = new Set(cmp.storedTransactionKeys);
      const matched = [...stored].filter((k) => yahooKeys.has(k)).length;
      antlerboard = { storedTransactions: stored.size, matchedByKey: matched, onlyInYahoo: yahooKeys.size - matched, onlyInAntlerboard: stored.size - matched };
    }
    const label = `${s.seasonYear ?? "?"} (${s.leagueKey})`;
    const failed = new Set(s.errors.map((e) => e.section));

    if (s.incomplete) {
      notChecked.push(`${label}: not fully read in this run (time budget) - open ?file=season.json&season=${s.seasonYear ?? "YYYY"} for this season on its own.`);
    } else if (failed.has("settings")) {
      inaccessible.push(`${label}: Yahoo refused the league (${s.errors[0].message}).`);
      requiresOriginalFiles.push(`${label}: auction results and transactions - this season isn't readable through the connected Yahoo account.`);
    } else {
      if (!failed.has("transactions")) recovered.push(`${label}: ${s.transactionsRaw.length} transactions (all types, timestamps, players, teams, FAAB bids where charged).`);
      else {
        inaccessible.push(`${label}: transactions - ${s.errors.find((e) => e.section === "transactions")!.message}`);
        requiresOriginalFiles.push(`${label}: the Yahoo transaction export for this season.`);
      }
      if (failed.has("draftresults")) {
        inaccessible.push(`${label}: draft results - ${s.errors.find((e) => e.section === "draftresults")!.message}`);
        requiresOriginalFiles.push(`${label}: auction results - auction history file.`);
      } else if (s.draftResults.length === 0) {
        requiresOriginalFiles.push(`${label}: Yahoo has no draft results for this season (auction held or recorded outside Yahoo) - auction history file.`);
      } else if (priced < s.draftResults.length) {
        recovered.push(`${label}: ${s.draftResults.length} draft picks, ${priced} with a price.`);
        requiresOriginalFiles.push(`${label}: ${s.draftResults.length - priced} draft picks have no price in Yahoo - auction history file for those.`);
      } else {
        recovered.push(`${label}: ${s.draftResults.length} auction picks, all priced, in Yahoo's recorded order.`);
      }
      if (failed.has("teams")) inaccessible.push(`${label}: teams - ${s.errors.find((e) => e.section === "teams")!.message}`);
      if (failed.has("players")) inaccessible.push(`${label}: draft player names - ${s.errors.find((e) => e.section === "players")!.message} (player keys are still exported).`);
    }

    return {
      seasonYear: s.seasonYear,
      leagueKey: s.leagueKey,
      leagueName: s.leagueName,
      draft: {
        isAuction: s.settings.isAuctionDraft,
        picks: s.draftResults.length,
        pricedPicks: priced,
        unpricedPicks: s.draftResults.length - priced,
        playersResolved: s.draftResults.filter((d) => d.player?.name).length,
      },
      transactions: {
        count: s.transactionsRaw.length,
        pages: s.transactionPages,
        byType,
        withFaabBid,
        firstAt: times.length ? new Date(Math.min(...times)).toISOString() : null,
        lastAt: times.length ? new Date(Math.max(...times)).toISOString() : null,
      },
      teams: s.teams.length,
      errors: s.errors,
      incomplete: s.incomplete,
      antlerboard,
    };
  });

  // A chain that simply ends (or reaches the first season) is information,
  // not a gap; a refused or runaway walk is.
  if (/^(Yahoo refused|Stopped:)/.test(history.discovery.stoppedBecause)) inaccessible.push(history.discovery.stoppedBecause);
  requiresOriginalFiles.push(...ALWAYS_FROM_FILES);

  return { startLeagueKey: history.startLeagueKey, discovery: history.discovery, seasons, recovered, inaccessible, requiresOriginalFiles, notChecked };
}
