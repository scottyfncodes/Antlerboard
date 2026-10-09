const PITCHER_POSITIONS = new Set(["SP", "RP", "P"]);

/**
 * Yahoo-style roster grouping. A player only counts as a pitcher when every
 * listed position is a pitching one - two-way eligibility (e.g. "SP, Util")
 * stays with the hitters, matching where Yahoo slots them by default.
 */
export function isPitcher(positions: string[]): boolean {
  return positions.length > 0 && positions.every((p) => PITCHER_POSITIONS.has(p));
}

export function groupHittersAndPitchers<T>(items: T[], positionsOf: (item: T) => string[]) {
  const hitters: T[] = [];
  const pitchers: T[] = [];
  for (const item of items) (isPitcher(positionsOf(item)) ? pitchers : hitters).push(item);
  return { hitters, pitchers };
}

export function ordinal(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  return `${n}${({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th"}`;
}
