/**
 * C&A FYPD (First-Year Player Draft) draft-order engine.
 *
 * This is NOT ordinary reverse standings. C&A is a 12-team league where the
 * top 8 make the playoffs and the bottom 4 do not. The bottom four compete
 * for "9th Brigade," a specific distinction that gets the first FYPD pick -
 * how a team becomes 9th Brigade is a real-world C&A mechanism this engine
 * doesn't know about and doesn't try to derive, so it's supplied as an
 * explicit input (e.g. set by the commissioner) rather than computed from
 * standings alone.
 *
 * The documented order (see project spec):
 *   1.  9th Brigade
 *   2.  10th place
 *   3.  11th place
 *   4.  12th place
 *   5.  8th place
 *   6.  7th place
 *   7.  6th place
 *   8.  5th place
 *   9.  4th place
 *   10. 3rd place
 *   11. 2nd place
 *   12. 1st place
 *
 * i.e. after 9th Brigade, the *remaining* bottom-four teams draft in
 * straight standings order (worse finish drafts later within this group),
 * then the eight playoff teams draft in reverse standings order (worst
 * playoff finish picks first). This is driven by rank data, not hardcoded
 * team names or years, so it works for any season without a redeploy.
 */

export interface StandingInput {
  teamId: string;
  /** 1 = best regular-season finish, 12 = worst. */
  rank: number;
}

export interface FypdOrderSlot {
  /** 1-based draft order position - slot 1 picks first in round 1. */
  slot: number;
  teamId: string;
  /** Human-readable justification, shown to managers so the order is never a mystery. */
  reason: string;
}

function ordinal(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

const PLAYOFF_TEAM_COUNT = 8;
const TOTAL_TEAM_COUNT = 12;

export function computeFypdDraftOrder(
  standings: StandingInput[],
  ninthBrigadeTeamId: string
): FypdOrderSlot[] {
  if (standings.length !== TOTAL_TEAM_COUNT) {
    throw new Error(
      `C&A's FYPD order rule requires exactly ${TOTAL_TEAM_COUNT} teams' standings, got ${standings.length}.`
    );
  }

  const byRank = new Map<number, string>();
  for (const s of standings) {
    if (byRank.has(s.rank)) {
      throw new Error(`Duplicate standings rank ${s.rank}.`);
    }
    byRank.set(s.rank, s.teamId);
  }
  for (let r = 1; r <= TOTAL_TEAM_COUNT; r++) {
    if (!byRank.has(r)) throw new Error(`Missing standings rank ${r}.`);
  }

  const bottomFourRanks = [9, 10, 11, 12];
  const bottomFourTeamIds = new Set(bottomFourRanks.map((r) => byRank.get(r)!));
  if (!bottomFourTeamIds.has(ninthBrigadeTeamId)) {
    throw new Error("9th Brigade must be one of the four non-playoff teams (ranks 9-12).");
  }

  const order: FypdOrderSlot[] = [{ slot: 1, teamId: ninthBrigadeTeamId, reason: "9th Brigade" }];

  const remainingBottomFour = bottomFourRanks.filter((r) => byRank.get(r) !== ninthBrigadeTeamId);
  for (const rank of remainingBottomFour) {
    order.push({ slot: order.length + 1, teamId: byRank.get(rank)!, reason: `${ordinal(rank)} place` });
  }

  for (let rank = PLAYOFF_TEAM_COUNT; rank >= 1; rank--) {
    order.push({
      slot: order.length + 1,
      teamId: byRank.get(rank)!,
      reason: `Reverse standings - ${ordinal(rank)} place`,
    });
  }

  return order;
}
