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
 * The keeper cost ladder, confirmed by the commissioner and by the league's
 * own history (e.g. a $66 player kept at 67, 70, 75, 82): each consecutive
 * keeper year adds the next step to the player's base price. Base price is
 * the auction cost or the winning FAAB bid - there is no extra bump for a
 * waiver pickup. Year 1 = base + 1, year 2 = base + 4, year 3 = base + 9,
 * year 4 = base + 16, year 5 = base + 25. See keeperCostIncrement().
 */
export const KEEPER_COST_LADDER: readonly number[] = [1, 3, 5, 7, 9];

/** Cumulative increase over base price for a given keeper year (1-5). */
export function keeperCostIncrement(keeperYear: number): number {
  let total = 0;
  for (let y = 1; y <= keeperYear && y <= KEEPER_COST_LADDER.length; y++) {
    total += KEEPER_COST_LADDER[y - 1];
  }
  return total;
}

/**
 * FYPD (First-Year Player Draft) prospects are called up to the active
 * roster for $0, but their keeper clock starts at the call-up with an
 * assumed base of $4 - so the first year they're kept costs $5, then the
 * normal ladder applies. See src/lib/keeper-engine.ts.
 */
export const FYPD_CALL_UP_BASE_COST = 4;

export const DEFAULT_TEAM_COUNT = 12;

/** Live auction budget per team each season, before keeper costs come off. */
export const AUCTION_BUDGET = 300;

/** In-season FAAB (free agent acquisition budget) per team per season. */
export const FAAB_BUDGET = 200;
export const FAAB_MIN_BID = 1;
export const FAAB_PROCESSING_DAYS = ["Sunday", "Tuesday", "Thursday"] as const;

/** Roster limits: active spots plus separate IL and NA (minor-league) slots. */
export const ROSTER_ACTIVE_SLOTS = 27;
export const ROSTER_IL_SLOTS = 5;
export const ROSTER_NA_SLOTS = 4;

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

/**
 * First season the league's history is tracked at player level (the
 * master workbook's manager sheets, the auction file and the Yahoo
 * export all start here). Keepers carried into this season get a
 * synthetic prior-season origin on import - see league-history-builder.
 */
export const LEAGUE_FIRST_SEASON_YEAR = 2021;
