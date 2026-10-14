/** The keeper facts a player search result carries (see /api/search). */
export interface SearchKeeperFacts {
  team: string | null;
  /** Set when the latest keeper record is from an earlier season. */
  keeperSeason: number | null;
  /** The checked keeper cost: "$12", or "Unavailable" / "None". */
  cost: { text: string; confirmed: boolean; title?: string } | null;
  keeperYear: number | null;
  yearsRemaining: number | null;
}

/**
 * "Team · $12 · Yr 2 · 3y left" for a search result, prefixed with the
 * season when the record isn't the current season's, so an old cost never
 * reads as today's. A missing cost reads Unavailable, never "$null".
 */
export function searchKeeperLine(p: SearchKeeperFacts): string {
  return [p.keeperSeason ? `${p.keeperSeason}: ${p.team}` : p.team, p.cost?.text ?? "Unavailable", `Yr ${p.keeperYear}`, `${p.yearsRemaining}y left`].join(" · ");
}
