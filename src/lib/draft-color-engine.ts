/**
 * C&A draft-color engine.
 *
 * The league cycles through five colors (Red -> Orange -> Yellow -> Green ->
 * Blue -> Red -> ...) once per season, anchored at 2021 = Red. A season can
 * be explicitly *skipped*, in which case it has no color and - critically -
 * does not consume a step in the cycle, so the season after a skip resumes
 * exactly where the cycle left off.
 *
 * Example (matches the league's documented history):
 *   2021 Red, 2022 Orange, 2023 Yellow, 2024 Green, 2025 Blue,
 *   2026 Red, 2027 SKIPPED, 2028 Orange (not Green - 2027 didn't advance it)
 */

import {
  DRAFT_COLOR_CYCLE,
  DRAFT_COLOR_ANCHOR_YEAR,
  DRAFT_COLOR_ANCHOR_COLOR,
  DRAFT_COLOR_SKIPPED_SEASONS,
  DRAFT_COLOR_OVERRIDES,
  type DraftColorName,
} from "./config";

export interface DraftColorEngineOptions {
  anchorYear?: number;
  anchorColor?: DraftColorName;
  cycle?: readonly DraftColorName[];
  skippedSeasons?: number[];
  overrides?: Record<number, DraftColorName>;
}

export interface DraftColorResult {
  year: number;
  skipped: boolean;
  color: DraftColorName | null;
  overridden: boolean;
}

function resolveOptions(options?: DraftColorEngineOptions) {
  return {
    anchorYear: options?.anchorYear ?? DRAFT_COLOR_ANCHOR_YEAR,
    anchorColor: options?.anchorColor ?? DRAFT_COLOR_ANCHOR_COLOR,
    cycle: options?.cycle ?? DRAFT_COLOR_CYCLE,
    skippedSeasons: new Set(options?.skippedSeasons ?? DRAFT_COLOR_SKIPPED_SEASONS),
    overrides: options?.overrides ?? DRAFT_COLOR_OVERRIDES,
  };
}

/**
 * Number of cycle-advancing (non-skipped) seasons strictly between
 * `anchorYear` and `year`, signed by direction. Used to compute how many
 * steps around the 5-color cycle separate `year` from the anchor.
 */
function stepsFromAnchor(
  year: number,
  anchorYear: number,
  skippedSeasons: Set<number>
): number {
  if (year === anchorYear) return 0;

  let steps = 0;
  if (year > anchorYear) {
    for (let y = anchorYear; y < year; y++) {
      if (!skippedSeasons.has(y)) steps++;
    }
    return steps;
  }

  for (let y = year; y < anchorYear; y++) {
    if (!skippedSeasons.has(y)) steps++;
  }
  return -steps;
}

export function getDraftColor(
  year: number,
  options?: DraftColorEngineOptions
): DraftColorResult {
  const { anchorYear, anchorColor, cycle, skippedSeasons, overrides } =
    resolveOptions(options);

  if (skippedSeasons.has(year)) {
    return { year, skipped: true, color: null, overridden: false };
  }

  if (overrides[year] !== undefined) {
    return { year, skipped: false, color: overrides[year], overridden: true };
  }

  const anchorIndex = cycle.indexOf(anchorColor);
  const steps = stepsFromAnchor(year, anchorYear, skippedSeasons);
  const cycleLength = cycle.length;
  const index = ((anchorIndex + steps) % cycleLength + cycleLength) % cycleLength;

  return { year, skipped: false, color: cycle[index], overridden: false };
}

/** Convenience for rendering a range of seasons, e.g. a History page. */
export function getDraftColorRange(
  startYear: number,
  endYear: number,
  options?: DraftColorEngineOptions
): DraftColorResult[] {
  const results: DraftColorResult[] = [];
  for (let y = startYear; y <= endYear; y++) {
    results.push(getDraftColor(y, options));
  }
  return results;
}

export function nextCycleColor(
  color: DraftColorName,
  cycle: readonly DraftColorName[] = DRAFT_COLOR_CYCLE
): DraftColorName {
  const index = cycle.indexOf(color);
  return cycle[(index + 1) % cycle.length];
}
