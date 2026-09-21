/**
 * Centralized Claw & Antler League configuration.
 *
 * These are code-level defaults. A commissioner can override the numeric
 * knobs at runtime via the `LeagueSettings` database row (see
 * src/lib/league-settings.ts) without a redeploy - this module is the
 * fallback/seed source of truth and the single place new constants belong.
 */

export const LEAGUE_NAME = "Claw & Antler League";
export const LEAGUE_ABBREVIATION = "C&A";
export const APP_NAME = "Antlerboard";

/** Number of players each team may keep across a season transition. */
export const KEEPER_SLOT_COUNT = 10;

/**
 * Maximum number of *consecutive* seasons a player may be kept before being
 * forced back into the draft pool. The acquisition season itself does not
 * count as a keeper year - see src/lib/keeper-engine.ts.
 */
export const MAX_CONSECUTIVE_KEEPER_YEARS = 5;

/**
 * How keeper cost increases for each additional consecutive keeper year
 * beyond the first. The league's historical data does not unambiguously
 * fix an exact progression formula, so this is intentionally a single
 * configurable knob (linear increment) rather than a guessed formula.
 * A commissioner can adjust this constant (or override per-player via
 * commissioner mode) if C&A's actual convention turns out to differ.
 */
export const KEEPER_COST_INCREMENT_PER_YEAR = 1;

export const DEFAULT_TEAM_COUNT = 10;

/** The five-color draft cycle, in cycle order. */
export const DRAFT_COLOR_CYCLE = ["RED", "ORANGE", "YELLOW", "GREEN", "BLUE"] as const;
export type DraftColorName = (typeof DRAFT_COLOR_CYCLE)[number];

/**
 * Anchor point for the draft-color cycle: 2021 is documented as RED. All
 * other seasons are computed relative to this anchor by
 * src/lib/draft-color-engine.ts, skipping any season listed below.
 */
export const DRAFT_COLOR_ANCHOR_YEAR = 2021;
export const DRAFT_COLOR_ANCHOR_COLOR: DraftColorName = "RED";

/**
 * Seasons that do not advance the five-color cycle at all (the color
 * sequence "pauses" - the season simply has no draft color). 2020 predates
 * the color system entirely (it began in 2021, per the league's confirmed
 * history), not just a paused year within it - listing it here (rather than
 * backward-extrapolating from the 2021 = RED anchor) is what keeps it from
 * resolving to a color it never actually had.
 */
export const DRAFT_COLOR_SKIPPED_SEASONS: number[] = [2020, 2027];

/**
 * Explicit historical overrides, keyed by season year. Takes precedence
 * over the computed cycle value.
 */
export const DRAFT_COLOR_OVERRIDES: Record<number, DraftColorName> = {};

export const CURRENT_SEASON_YEAR = 2026;
