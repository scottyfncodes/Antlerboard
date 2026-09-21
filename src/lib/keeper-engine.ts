/**
 * C&A Keeper Engine.
 *
 * This is the ONLY place keeper-year, keeper-cost, and forced-redraft logic
 * should live. UI components and API routes must call these functions
 * rather than re-deriving keeper math themselves.
 *
 * --- Rules implemented (see project spec sections 12-18) ---
 *
 * - Teams keep up to KEEPER_SLOT_COUNT players.
 * - A player may be kept for at most MAX_CONSECUTIVE_KEEPER_YEARS
 *   consecutive seasons. The season a player is *acquired* (drafted,
 *   claimed off waivers, or signed as a free agent) is not itself a keeper
 *   year - keeper year 1 is the first season after acquisition the player
 *   is retained.
 * - Keeper cost for a drafted player starts at their draft cost. Keeper
 *   cost for a waiver pickup starts at (waiver cost + 1). Cost then rises
 *   by KEEPER_COST_INCREMENT_PER_YEAR for each additional consecutive
 *   keeper year (see config.ts - the league's historical data does not
 *   unambiguously fix a different progression, so this is a configurable
 *   default rather than a guess).
 * - A DROP completely resets the keeper clock and cost. A player who is
 *   later re-added (e.g. from waivers) starts an entirely new "stint" at
 *   keeper year 0, with cost computed fresh from that new acquisition. The
 *   old stint's history remains visible but has zero bearing on the new
 *   stint's year, cost, or forced-redraft season.
 * - A TRADE moves a player between two rostered teams *without* resetting
 *   the clock or cost - only a DROP resets tenure.
 * - Five consecutive keeper years forces the player back into the draft
 *   pool the following season. If the data shows a new ACQUIRED event for
 *   that player in that season, it naturally starts a new stint.
 *
 * All calculations are derived strictly from the supplied acquisition/drop
 * event history - never from a player's age or raw seasons-in-league count.
 */

import {
  KEEPER_SLOT_COUNT,
  MAX_CONSECUTIVE_KEEPER_YEARS,
  KEEPER_COST_INCREMENT_PER_YEAR,
} from "./config";

export type StintStartMethod = "DRAFT" | "WAIVER" | "FREE_AGENT";

/** A player joining a team from outside the league's rostered pool. */
export interface AcquiredEvent {
  type: "ACQUIRED";
  season: number;
  method: StintStartMethod;
  cost: number;
  teamId: string;
}

/** A player moving between two rostered teams. Never resets the clock. */
export interface TradedEvent {
  type: "TRADED";
  season: number;
  teamId: string; // the team the player moves TO
}

/** A player leaving a roster entirely. Resets the clock. */
export interface DroppedEvent {
  type: "DROPPED";
  season: number;
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
}

interface Stint {
  index: number;
  startSeason: number;
  method: StintStartMethod;
  /** The literal cost paid at acquisition (draft $ or waiver claim cost). */
  rawCost: number;
  /** The basis keeper-cost calculations build on (waiver cost + 1, or draft cost as-is). */
  baseCost: number;
  /** endSeason is exclusive - the season the DROPPED event landed in, or null if still active. */
  endSeason: number | null;
  /** teamId for each season within the stint, accounting for trades. */
  teamBySeasson: Map<number, string>;
  lastKnownSeason: number;
}

function sortEvents(events: PlayerHistoryEvent[]): PlayerHistoryEvent[] {
  return [...events].sort((a, b) => {
    if (a.season !== b.season) return a.season - b.season;
    const order: Record<PlayerHistoryEvent["type"], number> = {
      DROPPED: 0,
      ACQUIRED: 1,
      TRADED: 2,
    };
    return order[a.type] - order[b.type];
  });
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
        baseCost:
          event.method === "WAIVER" ? event.cost + 1 : event.cost,
        endSeason: null,
        teamBySeasson: new Map([[event.season, event.teamId]]),
        lastKnownSeason: event.season,
      };
      stints.push(current);
    } else if (event.type === "TRADED") {
      if (!current || current.endSeason !== null) {
        // Trade with no open stint is a data error; ignore defensively.
        continue;
      }
      current.teamBySeasson.set(event.season, event.teamId);
      current.lastKnownSeason = event.season;
    } else if (event.type === "DROPPED") {
      if (!current || current.endSeason !== null) continue;
      current.endSeason = event.season;
    }
  }

  return stints;
}

function teamForSeason(stint: Stint, season: number): string {
  let team = stint.teamBySeasson.get(stint.startSeason)!;
  for (const [s, t] of [...stint.teamBySeasson.entries()].sort(
    (a, b) => a[0] - b[0]
  )) {
    if (s > season) break;
    team = t;
  }
  return team;
}

function isSeasonWithinStint(stint: Stint, season: number): boolean {
  if (season < stint.startSeason) return false;
  if (stint.endSeason !== null && season >= stint.endSeason) return false;
  return true;
}

export function computeKeeperCost(baseCost: number, keeperYear: number): number {
  if (keeperYear <= 0) return baseCost;
  return baseCost + (keeperYear - 1) * KEEPER_COST_INCREMENT_PER_YEAR;
}

/** Find the stint active for a given season (or null if none). */
function findStintForSeason(stints: Stint[], season: number): Stint | null {
  // Later stints take precedence in case of overlapping/erroneous data.
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

  if (keeperYear === 0) {
    return {
      season,
      stintIndex: stint.index,
      teamId,
      keeperYear: 0,
      cost: stint.rawCost,
      yearsRemaining: MAX_CONSECUTIVE_KEEPER_YEARS,
      status: "ACQUISITION_SEASON",
      acquisitionMethod: stint.method,
      acquisitionSeason: stint.startSeason,
    };
  }

  if (keeperYear > MAX_CONSECUTIVE_KEEPER_YEARS) {
    return {
      season,
      stintIndex: stint.index,
      teamId,
      keeperYear,
      cost: null,
      yearsRemaining: 0,
      status: "FORCED_BACK",
      acquisitionMethod: stint.method,
      acquisitionSeason: stint.startSeason,
    };
  }

  return {
    season,
    stintIndex: stint.index,
    teamId,
    keeperYear,
    cost: computeKeeperCost(stint.baseCost, keeperYear),
    yearsRemaining: MAX_CONSECUTIVE_KEEPER_YEARS - keeperYear,
    status: "KEPT",
    acquisitionMethod: stint.method,
    acquisitionSeason: stint.startSeason,
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
      stint.endSeason !== null ? stint.endSeason - 1 : presentSeason;
    for (let season = stint.startSeason; season <= lastSeason; season++) {
      timeline.push(keeperInfoForStintSeason(stint, season));
    }
  }

  return timeline;
}

export { KEEPER_SLOT_COUNT, MAX_CONSECUTIVE_KEEPER_YEARS };
