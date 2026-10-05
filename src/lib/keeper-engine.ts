/**
 * C&A Keeper Engine.
 *
 * This is the ONLY place keeper-year, keeper-cost, and forced-redraft logic
 * should live. UI components and API routes must call these functions
 * rather than re-deriving keeper math themselves.
 *
 * --- Rules implemented (confirmed by the commissioner, Oct 2026) ---
 *
 * - Teams keep up to KEEPER_SLOT_COUNT players.
 * - A player may be kept for at most MAX_CONSECUTIVE_KEEPER_YEARS
 *   consecutive seasons. The season a player is *acquired* (drafted,
 *   claimed off waivers, signed as a free agent, or called up from the
 *   FYPD prospect list) is keeper year 0 - keeper year 1 is the first
 *   season after acquisition the player is retained. A player kept in
 *   years 1 through 5 goes back to the auction in the season after year 5.
 * - Base price is the auction cost or the winning FAAB bid, as paid - no
 *   extra bump for a waiver claim. An FYPD call-up is free on Yahoo but
 *   carries an assumed base of FYPD_CALL_UP_BASE_COST ($4).
 * - Keeper cost climbs the ladder in config.ts (+1, +3, +5, +7, +9), so
 *   year 1 = base + 1, year 2 = base + 4, ... year 5 = base + 25.
 * - A DROP ends the stint. A player who is later re-added (e.g. from
 *   waivers) starts an entirely new "stint" at keeper year 0, with cost
 *   computed fresh from that new acquisition. The old stint's history
 *   remains visible but has zero bearing on the new stint.
 * - A TRADE moves a player between two rostered teams *without* resetting
 *   the clock or cost - only a DROP resets tenure.
 * - Five consecutive keeper years forces the player back into the draft
 *   pool the following season. If the data shows a new ACQUIRED event for
 *   that player in that season, it naturally starts a new stint.
 *
 * --- Event ordering ---
 *
 * Events carry an optional `date`. Within a season, dated events are
 * applied chronologically, which is what lets a real transaction log
 * (draft in March, drop in June, re-added by another team in July) resolve
 * to the right stint. Undated events fall back to the fixed order
 * DROPPED, ACQUIRED, TRADED, matching how season-granular data (a drop
 * recorded against the season it "took effect" in) was written before
 * dates existed.
 *
 * --- Drop semantics ---
 *
 * A DROPPED event in season S means the player left the roster *during*
 * S: the stint still covers S (the player was kept into / acquired in S)
 * and ends before S + 1. An importer expressing "not kept into next
 * season" therefore records the drop against the season just finished.
 *
 * All calculations are derived strictly from the supplied acquisition/drop
 * event history - never from a player's age or raw seasons-in-league count.
 */

import {
  KEEPER_SLOT_COUNT,
  MAX_CONSECUTIVE_KEEPER_YEARS,
  FYPD_CALL_UP_BASE_COST,
  keeperCostIncrement,
} from "./config";

export type StintStartMethod = "DRAFT" | "WAIVER" | "FREE_AGENT" | "FYPD";

/** A player joining a team from outside the league's rostered pool. */
export interface AcquiredEvent {
  type: "ACQUIRED";
  season: number;
  method: StintStartMethod;
  cost: number;
  teamId: string;
  date?: Date;
}

/** A player moving between two rostered teams. Never resets the clock. */
export interface TradedEvent {
  type: "TRADED";
  season: number;
  teamId: string; // the team the player moves TO
  date?: Date;
}

/** A player leaving a roster entirely. Ends the stint after this season. */
export interface DroppedEvent {
  type: "DROPPED";
  season: number;
  date?: Date;
}

export type PlayerHistoryEvent = AcquiredEvent | TradedEvent | DroppedEvent;

export type KeeperRecordStatus =
  | "ACQUISITION_SEASON"
  | "KEPT"
  | "FORCED_BACK"
  | "NOT_ROSTERED";

export interface KeeperYearInfo {
  season: number;
  stintIndex: number;
  teamId: string;
  keeperYear: number; // 0 = acquisition season, 1-5 = keeper years
  cost: number | null;
  yearsRemaining: number | null;
  status: KeeperRecordStatus;
  acquisitionMethod: StintStartMethod;
  acquisitionSeason: number;
  /** True on the last season of a stint that ended with a drop. */
  droppedThisSeason: boolean;
}

export interface Stint {
  index: number;
  startSeason: number;
  method: StintStartMethod;
  /** The literal cost paid at acquisition (draft $, FAAB bid, or 0 for a call-up). */
  rawCost: number;
  /** The basis keeper-cost calculations build on (the FYPD assumed $4, else the raw cost). */
  baseCost: number;
  /** Inclusive - the season the DROPPED event landed in, or null if still active. */
  endSeason: number | null;
  /** teamId for each season within the stint, accounting for trades. */
  teamBySeason: Map<number, string>;
  lastKnownSeason: number;
}

const UNDATED_TYPE_ORDER: Record<PlayerHistoryEvent["type"], number> = {
  DROPPED: 0,
  ACQUIRED: 1,
  TRADED: 2,
};

function sortEvents(events: PlayerHistoryEvent[]): PlayerHistoryEvent[] {
  return [...events].sort((a, b) => {
    if (a.season !== b.season) return a.season - b.season;
    if (a.date && b.date && a.date.getTime() !== b.date.getTime()) {
      return a.date.getTime() - b.date.getTime();
    }
    return UNDATED_TYPE_ORDER[a.type] - UNDATED_TYPE_ORDER[b.type];
  });
}

export function baseCostForAcquisition(method: StintStartMethod, rawCost: number): number {
  return method === "FYPD" ? FYPD_CALL_UP_BASE_COST : rawCost;
}

/**
 * Reduce raw event history into a list of keeper "stints" - continuous
 * tenure chains bounded by ACQUIRED ... DROPPED (or present).
 */
export function buildStints(events: PlayerHistoryEvent[]): Stint[] {
  const sorted = sortEvents(events);
  const stints: Stint[] = [];
  let current: Stint | null = null;

  for (const event of sorted) {
    if (event.type === "ACQUIRED") {
      // An acquisition always starts a fresh stint, even if one is
      // "open" - this defensively handles messy/incomplete drop data.
      current = {
        index: stints.length,
        startSeason: event.season,
        method: event.method,
        rawCost: event.cost,
        baseCost: baseCostForAcquisition(event.method, event.cost),
        endSeason: null,
        teamBySeason: new Map([[event.season, event.teamId]]),
        lastKnownSeason: event.season,
      };
      stints.push(current);
    } else if (event.type === "TRADED") {
      if (!current || current.endSeason !== null) {
        // Trade with no open stint is a data error; ignore defensively.
        continue;
      }
      current.teamBySeason.set(event.season, event.teamId);
      current.lastKnownSeason = event.season;
    } else if (event.type === "DROPPED") {
      if (!current || current.endSeason !== null) continue;
      current.endSeason = event.season;
    }
  }

  return stints;
}

function teamForSeason(stint: Stint, season: number): string {
  let team = stint.teamBySeason.get(stint.startSeason)!;
  for (const [s, t] of [...stint.teamBySeason.entries()].sort(
    (a, b) => a[0] - b[0]
  )) {
    if (s > season) break;
    team = t;
  }
  return team;
}

function isSeasonWithinStint(stint: Stint, season: number): boolean {
  if (season < stint.startSeason) return false;
  if (stint.endSeason !== null && season > stint.endSeason) return false;
  return true;
}

export function computeKeeperCost(baseCost: number, keeperYear: number): number {
  if (keeperYear <= 0) return baseCost;
  return baseCost + keeperCostIncrement(keeperYear);
}

/** Find the stint active for a given season (or null if none). */
function findStintForSeason(stints: Stint[], season: number): Stint | null {
  // Later stints take precedence: a player drafted, dropped, and re-added
  // in the same season belongs to the re-adding team for that season.
  for (let i = stints.length - 1; i >= 0; i--) {
    if (isSeasonWithinStint(stints[i], season)) return stints[i];
  }
  return null;
}

function keeperYearWithinStint(stint: Stint, season: number): number {
  return season - stint.startSeason;
}

/**
 * Full per-season keeper info for a single stint, driving both the engine's
 * public getters and getContinuousKeeperHistory's display timeline.
 */
function keeperInfoForStintSeason(stint: Stint, season: number): KeeperYearInfo {
  const keeperYear = keeperYearWithinStint(stint, season);
  const teamId = teamForSeason(stint, season);
  const droppedThisSeason = stint.endSeason === season;
  const common = {
    season,
    stintIndex: stint.index,
    teamId,
    keeperYear,
    acquisitionMethod: stint.method,
    acquisitionSeason: stint.startSeason,
    droppedThisSeason,
  };

  if (keeperYear === 0) {
    return {
      ...common,
      cost: stint.rawCost,
      yearsRemaining: MAX_CONSECUTIVE_KEEPER_YEARS,
      status: "ACQUISITION_SEASON",
    };
  }

  if (keeperYear > MAX_CONSECUTIVE_KEEPER_YEARS) {
    return { ...common, cost: null, yearsRemaining: 0, status: "FORCED_BACK" };
  }

  return {
    ...common,
    cost: computeKeeperCost(stint.baseCost, keeperYear),
    yearsRemaining: MAX_CONSECUTIVE_KEEPER_YEARS - keeperYear,
    status: "KEPT",
  };
}

/** getKeeperYear(playerId, season): 0 for the acquisition season, 1-5 for keeper years, null if not rostered. */
export function getKeeperYear(
  events: PlayerHistoryEvent[],
  season: number
): number | null {
  const stint = findStintForSeason(buildStints(events), season);
  if (!stint) return null;
  return keeperYearWithinStint(stint, season);
}

/** getKeeperCost(playerId, season): dollar cost to own/keep the player that season. */
export function getKeeperCost(
  events: PlayerHistoryEvent[],
  season: number
): number | null {
  const stint = findStintForSeason(buildStints(events), season);
  if (!stint) return null;
  return keeperInfoForStintSeason(stint, season).cost;
}

/**
 * getProjectedKeeperCost(playerId, season): what it would cost to keep the
 * player INTO `season` given the stint active in the season before it -
 * the number a manager weighs at the keeper deadline. Null when the player
 * isn't rostered the season before, or would be forced back.
 */
export function getProjectedKeeperCost(
  events: PlayerHistoryEvent[],
  season: number
): number | null {
  const stint = findStintForSeason(buildStints(events), season - 1);
  if (!stint) return null;
  if (stint.endSeason !== null && stint.endSeason < season - 1) return null;
  const keeperYear = keeperYearWithinStint(stint, season);
  if (keeperYear > MAX_CONSECUTIVE_KEEPER_YEARS) return null;
  return computeKeeperCost(stint.baseCost, keeperYear);
}

/** getYearsRemaining(playerId, season): consecutive keeper years left before forced redraft. */
export function getYearsRemaining(
  events: PlayerHistoryEvent[],
  season: number
): number | null {
  const stint = findStintForSeason(buildStints(events), season);
  if (!stint) return null;
  return keeperInfoForStintSeason(stint, season).yearsRemaining;
}

/**
 * getForcedRedraftSeason(playerId): the season year the player must return
 * to the draft pool, for whichever stint is active as of `asOfSeason`
 * (defaults to the most recent stint). Returns null if the player has no
 * acquisition history, or the stint already ended via a drop.
 */
export function getForcedRedraftSeason(
  events: PlayerHistoryEvent[],
  asOfSeason?: number
): number | null {
  const stints = buildStints(events);
  if (stints.length === 0) return null;

  const stint =
    asOfSeason !== undefined
      ? findStintForSeason(stints, asOfSeason)
      : stints[stints.length - 1];
  if (!stint) return null;
  if (stint.endSeason !== null) return null;

  return stint.startSeason + MAX_CONSECUTIVE_KEEPER_YEARS + 1;
}

/**
 * isKeeperEligible(playerId, season): can the team keep this player INTO
 * `season` (i.e. would that season's keeper year be within the allowed
 * max)? False once the fifth consecutive keeper year has already passed.
 */
export function isKeeperEligible(
  events: PlayerHistoryEvent[],
  season: number
): boolean {
  const stint = findStintForSeason(buildStints(events), season);
  if (!stint) return false;
  const keeperYear = keeperYearWithinStint(stint, season);
  return keeperYear >= 0 && keeperYear <= MAX_CONSECUTIVE_KEEPER_YEARS;
}

/**
 * didPlayerResetKeeperClock(playerId): true if the player's history
 * contains more than one stint, i.e. a drop (voluntary or forced) has at
 * some point reset their tenure.
 */
export function didPlayerResetKeeperClock(events: PlayerHistoryEvent[]): boolean {
  return buildStints(events).length > 1;
}

/**
 * getContinuousKeeperHistory(playerId): full multi-stint timeline for
 * display (e.g. a player profile's draft/keeper history), covering every
 * season from each stint's acquisition through its end (drop, forced
 * redraft, or present).
 */
export function getContinuousKeeperHistory(
  events: PlayerHistoryEvent[],
  presentSeason: number
): KeeperYearInfo[] {
  const stints = buildStints(events);
  const timeline: KeeperYearInfo[] = [];

  for (const stint of stints) {
    const lastSeason =
      stint.endSeason !== null ? Math.min(stint.endSeason, presentSeason) : presentSeason;
    for (let season = stint.startSeason; season <= lastSeason; season++) {
      timeline.push(keeperInfoForStintSeason(stint, season));
    }
  }

  return timeline;
}

export { KEEPER_SLOT_COUNT, MAX_CONSECUTIVE_KEEPER_YEARS, FYPD_CALL_UP_BASE_COST };
