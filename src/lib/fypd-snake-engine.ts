/**
 * C&A FYPD snake-draft turn engine. Pure and DB-free (see
 * src/lib/fypd-order-engine.ts for how the round-1 order itself is
 * computed) so it's cheap to test every round-direction edge case
 * directly.
 *
 * Odd rounds go in order (slot 1 -> slot N); even rounds reverse
 * (slot N -> slot 1) - e.g. for a 12-team order: Round 1 picks 1->12,
 * Round 2 picks 12->1, Round 3 picks 1->12, and so on.
 */

export interface SnakeSlot {
  round: number;
  /** 1-based position within the round. */
  pickInRound: number;
  /** 1-based position across the whole draft. */
  overallPick: number;
  /** 0-based index into the round-1 order array. */
  orderIndex: number;
}

export function getSnakeSlot(overallPick: number, teamCount: number): SnakeSlot {
  if (overallPick < 1) throw new Error("overallPick must be 1 or greater.");
  if (teamCount < 1) throw new Error("teamCount must be 1 or greater.");

  const round = Math.floor((overallPick - 1) / teamCount) + 1;
  const pickInRound = ((overallPick - 1) % teamCount) + 1;
  const reversed = round % 2 === 0;
  const orderIndex = reversed ? teamCount - pickInRound : pickInRound - 1;

  return { round, pickInRound, overallPick, orderIndex };
}

/** The team (by round-1 order slot) on the clock for a given overall pick. */
export function getTeamOnClock(order: string[], overallPick: number): string {
  const { orderIndex } = getSnakeSlot(overallPick, order.length);
  return order[orderIndex];
}

/** Builds the full pick-by-pick sequence for a draft of `rounds` rounds. */
export function buildSnakeSequence(
  order: string[],
  rounds: number
): { overallPick: number; round: number; pickInRound: number; teamId: string }[] {
  const totalPicks = order.length * rounds;
  const sequence = [];
  for (let overallPick = 1; overallPick <= totalPicks; overallPick++) {
    const slot = getSnakeSlot(overallPick, order.length);
    sequence.push({
      overallPick,
      round: slot.round,
      pickInRound: slot.pickInRound,
      teamId: order[slot.orderIndex],
    });
  }
  return sequence;
}
