/**
 * Turns the three league-history sources into one event stream per player
 * that the keeper engine can run, plus a validation report comparing what
 * the engine computes with what the commissioner's workbook recorded.
 *
 * Season by season (2021 through the current season):
 *
 *   1. Offseason trades from the workbook's log move players between the
 *      previous end-of-year rosters (TRADED), unless Yahoo already logged
 *      the same move in its pre-draft window.
 *   2. Declared keepers (Yahoo draft results, or the workbook where that
 *      file has a gap - 2023 and the current season) define the roster at
 *      the keeper deadline. A keeper found on another team's roster gets a
 *      flagged synthetic trade; one with no history at all gets a flagged
 *      synthetic origin. 2021 keepers are all keeper year 1, as the
 *      workbook's own +3 step into 2022 shows.
 *   3. Everyone on a previous roster who wasn't kept is released
 *      (DROPPED against the season just finished).
 *   4. Auction buys (DRAFT acquisitions) join the roster.
 *   5. Yahoo's in-season adds (FAAB bid = base cost; FYPD prospects get
 *      the FYPD method), drops and trades apply chronologically. For a
 *      season with no Yahoo export (the current one), the workbook's
 *      end-of-year roster stands in: players on it but not on the computed
 *      roster become flagged adds, and vice versa flagged drops.
 *
 * Nothing here touches the database: the output is a serializable
 * preview the commissioner reviews before the commit route writes it.
 */

import {
  getContinuousKeeperHistory,
  getProjectedKeeperCost,
  type PlayerHistoryEvent,
  type StintStartMethod,
} from "../keeper-engine";
import type { AuctionRow, ManagerSeasonBlock, YahooTransaction } from "./league-history-types";
import type { ParsedTrade } from "./types";
import { editDistance, matchPlayerName, normalizePlayerName } from "./player-names";
import type { FranchiseResolver } from "./team-aliases";

// ---------------------------------------------------------------------------
// Output types
// ---------------------------------------------------------------------------

export interface HistoryPlayer {
  /** Yahoo player id when known, else "n:<normalized full name>". */
  key: string;
  yahooPlayerId: string | null;
  name: string;
  mlbTeam: string | null;
  positions: string[];
  isFypdProspect: boolean;
  flags: string[];
}

export type HistoryEventKind = "ACQUIRED" | "TRADED" | "DROPPED";

export interface HistoryEvent {
  playerKey: string;
  kind: HistoryEventKind;
  /** Engine season (a pre-draft drop is charged to the season just finished). */
  season: number;
  date: string;
  /** Destination franchise for ACQUIRED/TRADED; the releasing franchise for DROPPED. */
  franchise: string;
  method?: StintStartMethod;
  cost?: number;
  /** TRADED only: completed before the season's keeper deadline. */
  preseason?: boolean;
  sourceRef: string;
  flags: string[];
}

export interface HistoryDraftPick {
  season: number;
  overallPick: number;
  franchise: string;
  playerKey: string;
  cost: number | null;
  sourceRef: string;
}

export type CheckStatus = "match" | "mismatch" | "unmatched" | "not-computed";

export interface KeeperCheck {
  season: number;
  franchise: string;
  rawName: string;
  playerKey: string | null;
  recordedCost: number | null;
  computedCost: number | null;
  status: CheckStatus;
}

export interface EoyCheck extends KeeperCheck {
  recordedNextCost: number | null;
  computedNextCost: number | null;
  nextStatus: CheckStatus;
}

export interface UnresolvedName {
  name: string;
  source: string;
  count: number;
}

export interface LeagueHistoryPreview {
  players: HistoryPlayer[];
  events: HistoryEvent[];
  draftPicks: HistoryDraftPick[];
  keeperChecks: KeeperCheck[];
  eoyChecks: EoyCheck[];
  unresolvedTeams: UnresolvedName[];
  unmatchedPlayers: UnresolvedName[];
  draftDates: Record<number, string>;
  summary: {
    players: number;
    events: number;
    flaggedEvents: number;
    draftPicks: number;
    seasons: number[];
    keeperChecks: Record<CheckStatus, number>;
    eoyCostChecks: Record<CheckStatus, number>;
    eoyProjectionChecks: Record<CheckStatus, number>;
    unresolvedTeamNames: number;
    unmatchedPlayerNames: number;
  };
  flags: string[];
}

export interface BuilderInput {
  blocks: ManagerSeasonBlock[];
  auctionRows: AuctionRow[];
  yahoo: YahooTransaction[];
  offseasonTrades: ParsedTrade[];
  /** Extra prospect names (e.g. from the FYPD boards) on top of the manager sheets' lists. */
  prospectNames?: string[];
  resolver: FranchiseResolver;
  firstSeason: number;
  currentSeason: number;
  /** Known draft dates (ISO date) per season; otherwise inferred from the first FAAB add. */
  draftDates?: Record<number, string>;
}

// ---------------------------------------------------------------------------
// Player identity registry
// ---------------------------------------------------------------------------

const PITCHER_POSITIONS = new Set(["SP", "RP", "P", "LHP", "RHP"]);

function isPitcherPositions(positions: string[]): boolean | null {
  if (positions.length === 0) return null;
  const pitcher = positions.some((p) => PITCHER_POSITIONS.has(p.toUpperCase()));
  // Util / DH only ever describe a hitter (that is how Yahoo lists Ohtani's batting half).
  const hitter = positions.some((p) => !PITCHER_POSITIONS.has(p.toUpperCase()));
  if (pitcher && !hitter) return true;
  if (hitter && !pitcher) return false;
  return null;
}

type Located = { player: HistoryPlayer; where: "roster" | "elsewhere" | "global" };

class PlayerRegistry {
  readonly players = new Map<string, HistoryPlayer>();
  private byFullKey = new Map<string, Set<string>>();
  private byInitialKey = new Map<string, Set<string>>();

  private index(key: string, name: string) {
    const n = normalizePlayerName(name);
    if (!this.byFullKey.has(n.fullKey)) this.byFullKey.set(n.fullKey, new Set());
    this.byFullKey.get(n.fullKey)!.add(key);
    if (!this.byInitialKey.has(n.initialKey)) this.byInitialKey.set(n.initialKey, new Set());
    this.byInitialKey.get(n.initialKey)!.add(key);
  }

  upsertYahoo(p: { yahooPlayerId: string; name: string; mlbTeam: string | null; positions: string[] }): HistoryPlayer {
    const existing = this.players.get(p.yahooPlayerId);
    if (existing) {
      if (p.mlbTeam) existing.mlbTeam = p.mlbTeam;
      if (p.positions.length) existing.positions = p.positions;
      if (existing.name !== p.name) this.index(existing.key, p.name);
      return existing;
    }
    const player: HistoryPlayer = {
      key: p.yahooPlayerId,
      yahooPlayerId: p.yahooPlayerId,
      name: p.name,
      mlbTeam: p.mlbTeam,
      positions: p.positions,
      isFypdProspect: false,
      flags: [],
    };
    this.players.set(player.key, player);
    this.index(player.key, p.name);
    return player;
  }

  /**
   * Exact full-name match across everyone known, using positions / the
   * Ohtani marker to split shared names. A definite hitter never matches a
   * definite pitcher of the same name, even when that pitcher is the only
   * "Will Smith" seen so far - the other one may simply never have been
   * added, dropped or traded on Yahoo.
   */
  matchGlobalExact(raw: string, positions: string[] = []): HistoryPlayer | null {
    const n = normalizePlayerName(raw);
    let keys = [...(this.byFullKey.get(n.fullKey) ?? [])];
    const wantPitcher = n.twoWayMarker === "P" ? true : n.twoWayMarker === "B" ? false : isPitcherPositions(positions);
    if (wantPitcher !== null) {
      keys = keys.filter((k) => {
        const theirs = isPitcherPositions(this.players.get(k)!.positions);
        return theirs === null || theirs === wantPitcher;
      });
    }
    return keys.length === 1 ? this.players.get(keys[0])! : null;
  }

  /**
   * Finds a player by name or creates a name-keyed one: a drafted player
   * who was never added, dropped or traded on Yahoo has no id anywhere.
   */
  resolveOrCreateByName(raw: string, hint: { positions?: string[]; mlbTeam?: string | null; sourceRef: string }): HistoryPlayer {
    const exact = this.matchGlobalExact(raw, hint.positions ?? []);
    if (exact) return exact;
    const n = normalizePlayerName(raw);
    if (n.abbreviated) {
      const byInitial = [...(this.byInitialKey.get(n.initialKey) ?? [])];
      if (byInitial.length === 1) return this.players.get(byInitial[0])!;
    }
    const sharedName = (this.byFullKey.get(n.fullKey)?.size ?? 0) > 0;
    const pitcher = n.twoWayMarker === "P" ? true : n.twoWayMarker === "B" ? false : isPitcherPositions(hint.positions ?? []);
    // Same name as someone already known: key the new identity by role so
    // the hitter and the pitcher stay apart.
    const key = `n:${n.fullKey}${sharedName && pitcher !== null ? (pitcher ? ":P" : ":H") : n.twoWayMarker ? `:${n.twoWayMarker}` : ""}`;
    const existing = this.players.get(key);
    if (existing) return existing;
    const player: HistoryPlayer = {
      key,
      yahooPlayerId: null,
      name: n.display,
      mlbTeam: hint.mlbTeam ?? null,
      positions: hint.positions ?? [],
      isFypdProspect: false,
      flags: sharedName ? [`Shares a name with another player; kept separate as a ${pitcher === true ? "pitcher" : pitcher === false ? "hitter" : "second player"} (${hint.sourceRef}).`] : [],
    };
    this.players.set(key, player);
    this.index(key, n.display);
    return player;
  }

  /** Roster-scoped match: exact, then initial + last name, then typo-tolerant, then lone-token rules. */
  matchOnRoster(raw: string, candidateKeys: Iterable<string>): HistoryPlayer | null {
    const candidates = [...candidateKeys].map((k) => this.players.get(k)!).filter(Boolean);
    const m = matchPlayerName(
      raw,
      candidates.map((p) => ({ name: p.name, value: p }))
    );
    if (m) return m.value;
    const n = normalizePlayerName(raw);
    if (n.fullKey.split(" ").length === 1) {
      // "Shaw" / "Gunnar": unique last name, then unique first name, on this
      // roster only; a one-letter typo in a longer last name ("Dovall") too.
      const byLast = candidates.filter((p) => normalizePlayerName(p.name).lastKey === n.fullKey);
      if (byLast.length === 1) return byLast[0];
      const byFirst = candidates.filter((p) => normalizePlayerName(p.name).fullKey.split(" ")[0] === n.fullKey);
      if (byFirst.length === 1) return byFirst[0];
      if (n.fullKey.length >= 5) {
        const near = candidates.filter((p) => editDistance(normalizePlayerName(p.name).lastKey, n.fullKey) <= 1);
        if (near.length === 1) return near[0];
      }
    }
    return null;
  }

  /**
   * Where is this named player? Preferred roster first; a full name that
   * isn't there is looked up exactly across everyone before any roster
   * fuzziness is allowed (so "Jhoan Duran" can't land on a roster-mate
   * named Jarren); abbreviations may fall back to the other rosters and
   * finally to a unique league-wide initial match.
   */
  locate(raw: string, preferred: Iterable<string>, allRosters: Roster): Located | null {
    const preferredKeys = [...preferred];
    const exactHere = this.matchOnRoster(raw, preferredKeys);
    const n = normalizePlayerName(raw);
    if (exactHere && (!n.abbreviated || normalizePlayerName(exactHere.name).fullKey === n.fullKey)) {
      return { player: exactHere, where: "roster" };
    }
    if (!n.abbreviated) {
      const global = this.matchGlobalExact(raw);
      if (global) {
        if (preferredKeys.includes(global.key)) return { player: global, where: "roster" };
        return { player: global, where: franchiseHolding(allRosters, global.key) ? "elsewhere" : "global" };
      }
    }
    if (exactHere) return { player: exactHere, where: "roster" };
    const everywhere = [...allRosters.values()].flatMap((s) => [...s]);
    const elsewhere = this.matchOnRoster(raw, everywhere);
    if (elsewhere) return { player: elsewhere, where: "elsewhere" };
    if (n.abbreviated) {
      const byInitial = [...(this.byInitialKey.get(n.initialKey) ?? [])];
      if (byInitial.length === 1) return { player: this.players.get(byInitial[0])!, where: "global" };
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

type Roster = Map<string, Set<string>>; // franchise -> player keys

function franchiseHolding(r: Roster, key: string): string | null {
  for (const [f, set] of r) if (set.has(key)) return f;
  return null;
}

function endOfSeasonDate(season: number): string {
  return `${season}-12-31T00:00:00.000Z`;
}

function midSeasonDate(season: number): string {
  return `${season}-07-01T00:00:00.000Z`;
}

function splitPlayerList(raw: string | null): string[] {
  if (!raw) return [];
  if (/^(none|n\/a|-)$/i.test(raw.trim())) return [];
  return raw
    .split(/,|\/|&|\band\b|;/i)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function countStatuses(list: { status: CheckStatus }[]): Record<CheckStatus, number> {
  const out: Record<CheckStatus, number> = { match: 0, mismatch: 0, unmatched: 0, "not-computed": 0 };
  for (const c of list) out[c.status]++;
  return out;
}

/** Minimum EOY rows before a workbook roster is trusted to stand in for missing transaction data. */
export const MIN_EOY_ROWS_FOR_RECONCILE = 15;

export function buildLeagueHistory(input: BuilderInput): LeagueHistoryPreview {
  const { blocks, auctionRows, yahoo, offseasonTrades, resolver, firstSeason, currentSeason } = input;
  const registry = new PlayerRegistry();
  const events: HistoryEvent[] = [];
  const draftPicks: HistoryDraftPick[] = [];
  const flags: string[] = [];
  const unresolvedTeams = new Map<string, UnresolvedName>();
  const unmatchedPlayers = new Map<string, UnresolvedName>();

  const noteUnresolvedTeam = (name: string, source: string) => {
    const k = `${name}|${source}`;
    const e = unresolvedTeams.get(k) ?? { name, source, count: 0 };
    e.count++;
    unresolvedTeams.set(k, e);
  };
  const noteUnmatchedPlayer = (name: string, source: string) => {
    const k = `${name}|${source}`;
    const e = unmatchedPlayers.get(k) ?? { name, source, count: 0 };
    e.count++;
    unmatchedPlayers.set(k, e);
  };
  const franchiseOf = (name: string | null | undefined, source: string): string | null => {
    const r = resolver.resolve(name);
    if (!r && name) noteUnresolvedTeam(name, source);
    return r?.managerSheetName ?? null;
  };

  // --- seed identities: Yahoo ids first, then every auction-file name -----
  for (const tx of yahoo) for (const p of tx.players) registry.upsertYahoo(p);
  for (const r of auctionRows) {
    if (r.playerName) registry.resolveOrCreateByName(r.playerName, { positions: r.positions, mlbTeam: r.mlbTeam, sourceRef: r.sourceRef });
  }

  const prospectKeys = new Set<string>();
  const prospectNames = [...blocks.flatMap((b) => b.prospects.map((p) => p.name)), ...(input.prospectNames ?? [])];
  for (const name of prospectNames) prospectKeys.add(normalizePlayerName(name).fullKey);
  const isProspect = (player: HistoryPlayer) => prospectKeys.has(normalizePlayerName(player.name).fullKey);

  // --- draft dates --------------------------------------------------------
  const draftDates: Record<number, string> = {};
  for (let y = firstSeason; y <= currentSeason; y++) {
    if (input.draftDates?.[y]) {
      draftDates[y] = new Date(input.draftDates[y]).toISOString();
      continue;
    }
    const firstFaab = yahoo
      .filter((t) => t.seasonYear === y && (t.type === "add" || t.type === "add/drop") && t.faabBid !== null)
      .map((t) => t.timestamp.getTime())
      .sort((a, b) => a - b)[0];
    draftDates[y] = firstFaab ? new Date(firstFaab - 24 * 3600 * 1000).toISOString() : new Date(Date.UTC(y, 2, 20)).toISOString();
  }

  // --- per-season source lookups ------------------------------------------
  const blocksBySeason = new Map<number, ManagerSeasonBlock[]>();
  for (const b of blocks) {
    if (b.seasonYear === null) continue;
    if (!blocksBySeason.has(b.seasonYear)) blocksBySeason.set(b.seasonYear, []);
    blocksBySeason.get(b.seasonYear)!.push(b);
  }
  const auctionBySeason = new Map<number, AuctionRow[]>();
  for (const r of auctionRows) {
    if (r.seasonYear === null) continue;
    if (!auctionBySeason.has(r.seasonYear)) auctionBySeason.set(r.seasonYear, []);
    auctionBySeason.get(r.seasonYear)!.push(r);
  }
  const yahooBySeason = new Map<number, YahooTransaction[]>();
  for (const t of yahoo) {
    if (!yahooBySeason.has(t.seasonYear)) yahooBySeason.set(t.seasonYear, []);
    yahooBySeason.get(t.seasonYear)!.push(t);
  }
  for (const list of yahooBySeason.values()) list.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

  let rosters: Roster = new Map();
  // Roster snapshots for validation: who each franchise held right after
  // the keeper deadline + auction, and at the end of the season.
  const startRosters = new Map<string, Set<string>>(); // `${season}|${franchise}`
  const endRosters = new Map<string, Set<string>>();
  const snapshot = (into: Map<string, Set<string>>, season: number, r: Roster) => {
    for (const [f, set] of r) into.set(`${season}|${f}`, new Set(set));
  };
  const rosterOf = (r: Roster, franchise: string) => {
    if (!r.has(franchise)) r.set(franchise, new Set());
    return r.get(franchise)!;
  };
  const removeEverywhere = (r: Roster, key: string) => {
    for (const set of r.values()) set.delete(key);
  };
  const moveTo = (r: Roster, key: string, franchise: string) => {
    removeEverywhere(r, key);
    rosterOf(r, franchise).add(key);
  };

  const seasons: number[] = [];
  for (let season = firstSeason; season <= currentSeason; season++) {
    seasons.push(season);
    const draftDate = new Date(draftDates[season]);
    const seasonYahoo = yahooBySeason.get(season) ?? [];
    const prevRosters = rosters;

    // 1. Offseason trades (workbook) ahead of this season's keeper deadline.
    const yahooTradeKeys = new Set<string>(); // `${playerKey}|${toFranchise}` logged by Yahoo pre-draft
    for (const tx of seasonYahoo) {
      if (tx.type !== "trade" || tx.timestamp >= draftDate) continue;
      for (const p of tx.players) {
        const to = franchiseOf(p.destinationTeamName, `yahoo ${season}`);
        if (to) yahooTradeKeys.add(`${p.yahooPlayerId}|${to}`);
      }
    }
    for (const trade of offseasonTrades) {
      if (trade.seasonYear !== season) continue;
      const a = franchiseOf(trade.teamAName, "offseason trades");
      const b = franchiseOf(trade.teamBName, "offseason trades");
      if (!a || !b) continue;
      const date = trade.tradeDate ? new Date(trade.tradeDate) : new Date(Date.UTC(season, 0, 15));
      const tradeFlags: string[] = [];
      if (date.getUTCFullYear() > season) tradeFlags.push(`Trade dated ${date.toISOString().slice(0, 10)} but filed under the ${season} offseason - date looks like a typo.`);
      const sides: [string, string, string | null][] = [
        [a, b, trade.teamAPlayersRaw],
        [b, a, trade.teamBPlayersRaw],
      ];
      for (const [from, to, raw] of sides) {
        for (const name of splitPlayerList(raw)) {
          const found = registry.locate(name, rosterOf(prevRosters, from), prevRosters);
          if (!found || found.where === "global") {
            noteUnmatchedPlayer(name, `offseason trade ${trade.sourceRef} (${from} -> ${to})`);
            continue;
          }
          if (yahooTradeKeys.has(`${found.player.key}|${to}`)) continue; // Yahoo already has it
          const holder = franchiseHolding(prevRosters, found.player.key);
          events.push({
            playerKey: found.player.key,
            kind: "TRADED",
            season,
            date: date.toISOString(),
            franchise: to,
            preseason: true,
            sourceRef: `offseason trades ${trade.sourceRef}`,
            flags: holder && holder !== from ? [...tradeFlags, `Sheet says ${from} sent this player, but the roster history has them with ${holder}.`] : tradeFlags,
          });
          moveTo(prevRosters, found.player.key, to);
        }
      }
      const dropSides: [string, string | null][] = [
        [a, trade.teamADropsRaw],
        [b, trade.teamBDropsRaw],
      ];
      for (const [from, raw] of dropSides) {
        for (const name of splitPlayerList(raw)) {
          const found = registry.matchOnRoster(name, rosterOf(prevRosters, from));
          if (!found) {
            noteUnmatchedPlayer(name, `offseason trade drop ${trade.sourceRef} (${from})`);
            continue;
          }
          events.push({
            playerKey: found.key,
            kind: "DROPPED",
            season: season - 1,
            date: date.toISOString(),
            franchise: from,
            sourceRef: `offseason trades ${trade.sourceRef} (drop)`,
            flags: [],
          });
          removeEverywhere(prevRosters, found.key);
        }
      }
    }

    // 2. Keepers at the deadline.
    const newRosters: Roster = new Map();
    const canonKeepers = (auctionBySeason.get(season) ?? []).filter((r) => r.isKeeper);
    const keeperSource: { franchise: string; name: string; cost: number | null; positions: string[]; mlbTeam: string | null; ref: string }[] = [];
    if (canonKeepers.length > 0) {
      for (const r of canonKeepers) {
        const f = franchiseOf(r.teamName, `auction file ${season}`);
        if (f) keeperSource.push({ franchise: f, name: r.playerName, cost: r.salary, positions: r.positions, mlbTeam: r.mlbTeam, ref: r.sourceRef });
      }
    } else {
      for (const b of blocksBySeason.get(season) ?? []) {
        for (const k of b.keepers) keeperSource.push({ franchise: b.managerSheetName, name: k.name, cost: k.cost, positions: [], mlbTeam: null, ref: `${b.managerSheetName} ${season} keepers` });
      }
      if (keeperSource.length > 0) flags.push(`${season}: keepers taken from the workbook (no keeper rows in the auction file).`);
    }

    for (const k of keeperSource) {
      let player: HistoryPlayer;
      if (season === firstSeason) {
        player = registry.resolveOrCreateByName(k.name, { positions: k.positions, mlbTeam: k.mlbTeam, sourceRef: k.ref });
        events.push({
          playerKey: player.key,
          kind: "ACQUIRED",
          season: season - 1,
          date: new Date(Date.UTC(season - 1, 2, 15)).toISOString(),
          franchise: k.franchise,
          method: "DRAFT",
          cost: Math.max(0, (k.cost ?? 1) - 1),
          sourceRef: k.ref,
          flags: [`Pre-${firstSeason} history: treated as acquired in ${season - 1} so ${season} is keeper year 1 (the workbook's +3 step into ${season + 1} confirms this for every ${season} keeper).`],
        });
      } else {
        const found = registry.locate(k.name, rosterOf(prevRosters, k.franchise), prevRosters);
        if (found && found.where === "roster") {
          player = found.player;
        } else if (found && found.where === "elsewhere") {
          player = found.player;
          const holder = franchiseHolding(prevRosters, player.key)!;
          // The workbook's end-of-year column is maintained into the
          // offseason, so if the keeping team's prior-season list already
          // names the player, the move is an offseason trade that simply
          // never made the trade log - not a mystery.
          const priorEoy = (blocksBySeason.get(season - 1) ?? []).find((b) => b.managerSheetName === k.franchise)?.eoyRoster ?? [];
          const corroborated = priorEoy.some((row) => matchPlayerName(row.name, [{ name: player.name, value: true }]) !== null);
          events.push({
            playerKey: player.key,
            kind: "TRADED",
            season,
            date: new Date(draftDate.getTime() - 48 * 3600 * 1000).toISOString(),
            franchise: k.franchise,
            preseason: true,
            sourceRef: k.ref,
            flags: [
              corroborated
                ? `Offseason trade missing from the trade log: ${holder} -> ${k.franchise} before the ${season} deadline (${k.franchise}'s ${season - 1} end-of-year roster already lists the player). Clock carried.`
                : `Kept by ${k.franchise} in ${season} but finished ${season - 1} with ${holder}; nothing in Yahoo, the trade log or the end-of-year rosters explains the move - treated as an unrecorded offseason trade.`,
            ],
          });
        } else {
          player = found?.player ?? registry.resolveOrCreateByName(k.name, { positions: k.positions, mlbTeam: k.mlbTeam, sourceRef: k.ref });
          events.push({
            playerKey: player.key,
            kind: "ACQUIRED",
            season: season - 1,
            date: endOfSeasonDate(season - 1),
            franchise: k.franchise,
            method: "WAIVER",
            cost: Math.max(0, (k.cost ?? 1) - 1),
            sourceRef: k.ref,
            flags: [`Kept in ${season} with no acquisition on record - origin assumed to be a ${season - 1} pickup priced to match the recorded keeper cost.`],
          });
        }
      }
      removeEverywhere(prevRosters, player.key);
      rosterOf(newRosters, k.franchise).add(player.key);
    }

    // 3. Everyone left on a previous roster was not kept.
    if (season > firstSeason) {
      for (const [franchise, set] of prevRosters) {
        for (const key of set) {
          events.push({
            playerKey: key,
            kind: "DROPPED",
            season: season - 1,
            date: endOfSeasonDate(season - 1),
            franchise,
            sourceRef: `not kept into ${season}`,
            flags: [],
          });
        }
      }
    }

    // 4. Auction buys.
    const canonBuys = (auctionBySeason.get(season) ?? []).filter((r) => !r.isKeeper);
    if (canonBuys.length > 0) {
      for (const r of canonBuys) {
        const f = franchiseOf(r.teamName, `auction file ${season}`);
        if (!f) continue;
        const player = registry.resolveOrCreateByName(r.playerName, { positions: r.positions, mlbTeam: r.mlbTeam, sourceRef: r.sourceRef });
        events.push({
          playerKey: player.key,
          kind: "ACQUIRED",
          season,
          date: draftDate.toISOString(),
          franchise: f,
          method: "DRAFT",
          cost: r.salary ?? 0,
          sourceRef: `auction:${r.sourceRef}`,
          flags: r.salary === null ? ["Auction row had no salary - cost recorded as 0."] : [],
        });
        moveTo(newRosters, player.key, f);
        if (r.pick !== null) draftPicks.push({ season, overallPick: r.pick, franchise: f, playerKey: player.key, cost: r.salary, sourceRef: r.sourceRef });
      }
    } else {
      let pick = 0;
      for (const b of blocksBySeason.get(season) ?? []) {
        for (const d of b.draft) {
          const player = registry.resolveOrCreateByName(d.name, { sourceRef: `${b.managerSheetName} ${season} draft` });
          pick++;
          events.push({
            playerKey: player.key,
            kind: "ACQUIRED",
            season,
            date: draftDate.toISOString(),
            franchise: b.managerSheetName,
            method: "DRAFT",
            cost: d.cost ?? 0,
            sourceRef: `workbook:${b.managerSheetName}/${season}/draft`,
            flags: d.cost === null ? ["Draft row had no cost - recorded as 0."] : [],
          });
          moveTo(newRosters, player.key, b.managerSheetName);
          draftPicks.push({ season, overallPick: pick, franchise: b.managerSheetName, playerKey: player.key, cost: d.cost, sourceRef: `${b.managerSheetName} ${season} draft` });
        }
      }
      if (pick > 0) flags.push(`${season}: auction results taken from the workbook (nomination order unknown - picks numbered by sheet order).`);
    }

    snapshot(startRosters, season, newRosters);

    // 5. In-season activity.
    if (seasonYahoo.some((t) => t.type !== "commish")) {
      for (const tx of seasonYahoo) {
        if (tx.type === "commish" || tx.players.length === 0) continue;
        const ref = `yahoo:${tx.transactionKey}`;
        for (const p of tx.players) {
          const player = registry.upsertYahoo(p);
          if (p.action === "trade") {
            const to = franchiseOf(p.destinationTeamName, `yahoo ${season}`);
            if (!to) continue;
            events.push({
              playerKey: player.key,
              kind: "TRADED",
              season,
              date: tx.timestamp.toISOString(),
              franchise: to,
              preseason: tx.timestamp < draftDate,
              sourceRef: ref,
              flags: [],
            });
            moveTo(newRosters, player.key, to);
          } else if (p.action === "add") {
            const to = franchiseOf(p.destinationTeamName, `yahoo ${season}`);
            if (!to) continue;
            const addFlags: string[] = [];
            let method: StintStartMethod;
            if (isProspect(player)) {
              method = "FYPD";
              player.isFypdProspect = true;
            } else if (p.sourceType === "waivers" && tx.faabBid === null && season >= 2024) {
              method = "FYPD";
              player.isFypdProspect = true;
              addFlags.push("$0 waiver add in the FYPD era with no matching prospect row - assumed to be an FYPD call-up.");
            } else {
              method = p.sourceType === "freeagents" ? "FREE_AGENT" : "WAIVER";
            }
            events.push({
              playerKey: player.key,
              kind: "ACQUIRED",
              season,
              date: tx.timestamp.toISOString(),
              franchise: to,
              method,
              cost: tx.faabBid ?? 0,
              sourceRef: ref,
              flags: addFlags,
            });
            moveTo(newRosters, player.key, to);
          } else if (p.action === "drop") {
            const from = franchiseOf(p.sourceTeamName, `yahoo ${season}`) ?? franchiseHolding(newRosters, player.key) ?? "";
            const preDraft = tx.timestamp < draftDate;
            events.push({
              playerKey: player.key,
              kind: "DROPPED",
              season: preDraft ? season - 1 : season,
              date: tx.timestamp.toISOString(),
              franchise: from,
              sourceRef: ref,
              flags: preDraft ? [`Dropped before the ${season} draft - counted against ${season - 1}.`] : [],
            });
            removeEverywhere(newRosters, player.key);
          }
        }
      }
    } else {
      // No transaction export for this season: reconcile against the
      // workbook's end-of-year rosters where they look complete.
      let reconciled = 0;
      for (const b of blocksBySeason.get(season) ?? []) {
        if (b.eoyRoster.length < MIN_EOY_ROWS_FOR_RECONCILE) continue;
        reconciled++;
        const franchise = b.managerSheetName;
        const seen = new Set<string>();
        for (const row of b.eoyRoster) {
          const found = registry.locate(row.name, rosterOf(newRosters, franchise), newRosters);
          if (found && found.where === "roster") {
            seen.add(found.player.key);
            continue;
          }
          if (found && found.where === "elsewhere") {
            const holder = franchiseHolding(newRosters, found.player.key)!;
            events.push({
              playerKey: found.player.key,
              kind: "TRADED",
              season,
              date: midSeasonDate(season),
              franchise,
              sourceRef: `workbook:${franchise}/${season}/eoy`,
              flags: [`On ${franchise}'s ${season} end-of-year roster but last known with ${holder}; no ${season} transaction export - treated as an in-season trade.`],
            });
            moveTo(newRosters, found.player.key, franchise);
            seen.add(found.player.key);
            continue;
          }
          const player = found?.player ?? registry.resolveOrCreateByName(row.name, { sourceRef: `${franchise} ${season} EOY` });
          const prospect = isProspect(player);
          if (prospect) player.isFypdProspect = true;
          events.push({
            playerKey: player.key,
            kind: "ACQUIRED",
            season,
            date: midSeasonDate(season),
            franchise,
            method: prospect ? "FYPD" : "WAIVER",
            cost: prospect ? 0 : (row.cost ?? 0),
            sourceRef: `workbook:${franchise}/${season}/eoy`,
            flags: [`Added from ${franchise}'s ${season} end-of-year roster (no ${season} transaction export); cost taken from the sheet.`],
          });
          moveTo(newRosters, player.key, franchise);
          seen.add(player.key);
        }
        for (const key of [...rosterOf(newRosters, franchise)]) {
          if (seen.has(key)) continue;
          events.push({
            playerKey: key,
            kind: "DROPPED",
            season,
            date: midSeasonDate(season),
            franchise,
            sourceRef: `workbook:${franchise}/${season}/eoy`,
            flags: [`Not on ${franchise}'s ${season} end-of-year roster (no ${season} transaction export) - treated as dropped during the season.`],
          });
          rosterOf(newRosters, franchise).delete(key);
        }
      }
      if (reconciled > 0) {
        flags.push(`${season}: no transaction export - in-season moves reconstructed from ${reconciled} end-of-year rosters in the workbook (${(blocksBySeason.get(season)?.length ?? 0) - reconciled} not yet filled in).`);
      }
    }

    snapshot(endRosters, season, newRosters);
    rosters = newRosters;
  }

  // --- run the engine once per player for validation -----------------------
  const eventsByPlayer = new Map<string, PlayerHistoryEvent[]>();
  for (const e of events) {
    if (!eventsByPlayer.has(e.playerKey)) eventsByPlayer.set(e.playerKey, []);
    const list = eventsByPlayer.get(e.playerKey)!;
    if (e.kind === "ACQUIRED") list.push({ type: "ACQUIRED", season: e.season, method: e.method!, cost: e.cost ?? 0, teamId: e.franchise, date: new Date(e.date) });
    else if (e.kind === "TRADED") list.push({ type: "TRADED", season: e.season, teamId: e.franchise, date: new Date(e.date), preseason: !!e.preseason });
    else list.push({ type: "DROPPED", season: e.season, date: new Date(e.date) });
  }
  const timelines = new Map<string, ReturnType<typeof getContinuousKeeperHistory>>();
  for (const [key, evs] of eventsByPlayer) timelines.set(key, getContinuousKeeperHistory(evs, currentSeason));

  /** Cost of the player's first stint in a season (the keeper deadline) or the last (end of year). */
  const costFor = (key: string, season: number, pick: "first" | "last"): number | null => {
    const rows = (timelines.get(key) ?? []).filter((r) => r.season === season);
    if (rows.length === 0) return null;
    return (pick === "first" ? rows[0] : rows[rows.length - 1]).cost;
  };

  /** Validation-time name match: roster candidates, ties broken by the recorded cost. */
  const matchForCheck = (raw: string, candidates: Set<string>, season: number, pick: "first" | "last", recorded: number | null) => {
    const direct = registry.matchOnRoster(raw, candidates);
    if (direct) return direct;
    const n = normalizePlayerName(raw);
    const tied = [...candidates]
      .map((k) => registry.players.get(k)!)
      .filter((p) => {
        const pn = normalizePlayerName(p.name);
        return pn.fullKey === n.fullKey || pn.initialKey === n.initialKey;
      });
    if (tied.length > 1 && recorded !== null) {
      const byCost = tied.filter((p) => costFor(p.key, season, pick) === recorded);
      if (byCost.length === 1) return byCost[0];
    }
    return null;
  };

  const keeperChecks: KeeperCheck[] = [];
  const eoyChecks: EoyCheck[] = [];
  const compare = (recorded: number | null, computed: number | null): CheckStatus =>
    computed === null || recorded === null ? "not-computed" : recorded === computed ? "match" : "mismatch";

  for (const b of blocks) {
    if (b.seasonYear === null) continue;
    const season = b.seasonYear;
    const franchise = b.managerSheetName;
    const startCandidates = startRosters.get(`${season}|${franchise}`) ?? new Set<string>();
    // The workbook's EOY column is maintained into the offseason, so it
    // also holds players picked up in trades before the next deadline.
    const endCandidates = new Set([
      ...(endRosters.get(`${season}|${franchise}`) ?? []),
      ...(startRosters.get(`${season + 1}|${franchise}`) ?? []),
    ]);
    for (const k of b.keepers) {
      const player = matchForCheck(k.name, startCandidates, season, "first", k.cost);
      if (!player) {
        noteUnmatchedPlayer(k.name, `${franchise} ${season} keepers`);
        keeperChecks.push({ season, franchise, rawName: k.name, playerKey: null, recordedCost: k.cost, computedCost: null, status: "unmatched" });
        continue;
      }
      const computed = costFor(player.key, season, "first");
      keeperChecks.push({ season, franchise, rawName: k.name, playerKey: player.key, recordedCost: k.cost, computedCost: computed, status: compare(k.cost, computed) });
    }
    for (const row of b.eoyRoster) {
      const player = matchForCheck(row.name, endCandidates, season, "last", row.cost) ?? matchForCheck(row.name, startCandidates, season, "last", row.cost);
      if (!player) {
        noteUnmatchedPlayer(row.name, `${franchise} ${season} EOY`);
        eoyChecks.push({
          season,
          franchise,
          rawName: row.name,
          playerKey: null,
          recordedCost: row.cost,
          computedCost: null,
          status: "unmatched",
          recordedNextCost: row.nextSeasonCost,
          computedNextCost: null,
          nextStatus: "unmatched",
        });
        continue;
      }
      const computed = costFor(player.key, season, "last");
      const computedNext = getProjectedKeeperCost(eventsByPlayer.get(player.key) ?? [], season + 1);
      eoyChecks.push({
        season,
        franchise,
        rawName: row.name,
        playerKey: player.key,
        recordedCost: row.cost,
        computedCost: computed,
        status: compare(row.cost, computed),
        recordedNextCost: row.nextSeasonCost,
        computedNextCost: computedNext,
        nextStatus: compare(row.nextSeasonCost, computedNext),
      });
    }
  }

  const players = [...registry.players.values()].filter((p) => eventsByPlayer.has(p.key));
  return {
    players,
    events,
    draftPicks,
    keeperChecks,
    eoyChecks,
    unresolvedTeams: [...unresolvedTeams.values()].sort((a, b) => b.count - a.count),
    unmatchedPlayers: [...unmatchedPlayers.values()].sort((a, b) => b.count - a.count),
    draftDates,
    summary: {
      players: players.length,
      events: events.length,
      flaggedEvents: events.filter((e) => e.flags.length > 0).length,
      draftPicks: draftPicks.length,
      seasons,
      keeperChecks: countStatuses(keeperChecks),
      eoyCostChecks: countStatuses(eoyChecks),
      eoyProjectionChecks: countStatuses(eoyChecks.map((c) => ({ status: c.nextStatus }))),
      unresolvedTeamNames: unresolvedTeams.size,
      unmatchedPlayerNames: unmatchedPlayers.size,
    },
    flags,
  };
}
