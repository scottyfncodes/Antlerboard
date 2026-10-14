/**
 * Draft History - the read model behind /history/drafts. Pure and DB-free
 * (see draft-history-data.ts for the queries) so every completeness and
 * original-slot rule is unit tested directly.
 *
 * Two separate draft systems live here and are never blended:
 * - The live AUCTION (DraftPick): nomination order + winning price. There
 *   is no slot ownership to trade, and the league never records how many
 *   players an auction "should" have, so its total can't be verified -
 *   only gaps in the recorded nomination numbers can be detected.
 * - The FYPD snake draft (FypdDraft/FypdDraftOrderSlot/FypdSelection):
 *   expected picks = order slots x rounds, so completeness is exact.
 *
 * Completeness is always computed from the picks actually stored, never
 * from Season.status or FypdDraft.status - both can say COMPLETE over a
 * partial dataset (2025's FYPD does: 53 of 60 picks).
 */

import { getSnakeSlot } from "./fypd-snake-engine";
import { readProvenance } from "./import/provenance";

/**
 * Where an auction pick's number came from:
 *  source   the auction file's own pick/nomination column
 *  entered  entered in Antlerboard (no import provenance)
 *  sheet    workbook row order - the real nomination order isn't recorded
 *  unknown  an older import row with no order tag - treated like sheet
 */
export type NominationOrder = "source" | "entered" | "sheet" | "unknown";

export function nominationOrderOf(sourceRef: string | null | undefined): NominationOrder {
  const tagged = readProvenance(sourceRef).order;
  if (tagged) return tagged;
  return sourceRef ? "unknown" : "entered";
}

export function isInferredOrder(o: NominationOrder): boolean {
  return o === "sheet" || o === "unknown";
}

export type DraftKind = "auction" | "fypd";

export type Completeness =
  /** No picks stored at all. */
  | { status: "none"; recorded: 0; expected: number | null; note: string }
  /** Every expected pick is stored. */
  | { status: "complete"; recorded: number; expected: number; note: string }
  /** Fewer picks than expected, or gaps in the stored numbering. */
  | { status: "incomplete"; recorded: number; expected: number | null; missing: number | null; note: string }
  /** Picks are stored with no detectable gaps, but no expected total exists to check against. */
  | { status: "unverified"; recorded: number; expected: null; note: string };

export interface TeamRef {
  id: string;
  name: string;
}

export interface PlayerRef {
  id: string;
  name: string;
  mlbTeam: string | null;
  positions: string[];
}

/** Why an original slot is or isn't shown - surfaced in the UI as a tooltip/note. */
export type OriginalSlot =
  | { status: "known"; team: TeamRef; differsFromSelector: boolean }
  | { status: "unknown"; reason: string }
  | { status: "not-applicable"; reason: string };

export interface DraftHistoryPick {
  key: string;
  overallPick: number;
  round: number;
  pickInRound: number;
  team: TeamRef;
  player: PlayerRef | null;
  /** Auction price; always null for FYPD (it has no price). */
  cost: number | null;
  isKeeperSlot: boolean;
  originalSlot: OriginalSlot;
  /** Auction only: where `overallPick` came from. FYPD picks are always "source". */
  order: NominationOrder;
  flags: string[];
}

export interface DraftHistory {
  kind: DraftKind;
  year: number;
  completeness: Completeness;
  picks: DraftHistoryPick[];
  /** Draft-level data-quality notes (shown above the pick list). */
  notes: string[];
}

// ---------------------------------------------------------------------------
// Auction
// ---------------------------------------------------------------------------

export interface AuctionPickInput {
  id: string;
  round: number;
  pick: number;
  overallPick: number;
  cost: number | null;
  isKeeperSlot: boolean;
  team: TeamRef;
  player: PlayerRef | null;
  sourceRef?: string | null;
}

export function buildAuctionHistory(year: number, rawPicks: AuctionPickInput[]): DraftHistory {
  const picks = [...rawPicks].sort((a, b) => a.overallPick - b.overallPick);
  const notes: string[] = [];

  const playerSeen = new Map<string, number>();
  for (const p of picks) if (p.player) playerSeen.set(p.player.id, (playerSeen.get(p.player.id) ?? 0) + 1);

  const out: DraftHistoryPick[] = picks.map((p) => {
    const flags: string[] = [];
    if (!p.player) flags.push("No player recorded for this pick.");
    if (p.cost === null) flags.push("Price not recorded.");
    if (p.player && (playerSeen.get(p.player.id) ?? 0) > 1) flags.push("This player appears more than once in this auction.");
    return {
      key: p.id,
      overallPick: p.overallPick,
      round: p.round,
      pickInRound: p.pick,
      team: p.team,
      player: p.player,
      cost: p.cost,
      isKeeperSlot: p.isKeeperSlot,
      originalSlot: { status: "not-applicable", reason: "Auction - there are no draft slots to own or trade." },
      order: nominationOrderOf(p.sourceRef),
      flags,
    };
  });

  const duplicates = [...playerSeen.values()].filter((n) => n > 1).length;
  if (duplicates > 0) notes.push(`${duplicates} player${duplicates === 1 ? "" : "s"} recorded more than once - check the source data.`);
  const unpriced = picks.filter((p) => p.cost === null).length;
  if (unpriced > 0) notes.push(`${unpriced} pick${unpriced === 1 ? " has" : "s have"} no recorded price.`);
  const inferred = out.filter((p) => isInferredOrder(p.order)).length;
  if (inferred > 0) {
    notes.push(
      `${inferred === out.length ? "All" : inferred} pick${inferred === 1 ? " is" : "s are"} numbered by workbook row order - the real nomination order isn't recorded, so those numbers are row numbers, not nominations.`
    );
  }

  return { kind: "auction", year, completeness: auctionCompleteness(out), picks: out, notes };
}

export function auctionCompleteness(picks: { overallPick: number; order?: NominationOrder }[]): Completeness {
  if (picks.length === 0) {
    return { status: "none", recorded: 0, expected: null, note: "No auction results are stored for this season." };
  }
  // Row-order numbering is sequential by construction, so a gap check on it
  // would prove nothing.
  if (picks.some((p) => p.order && isInferredOrder(p.order))) {
    return {
      status: "unverified",
      recorded: picks.length,
      expected: null,
      note: "The real nomination order isn't recorded for this auction, and the league doesn't record how many players it should have, so neither order nor total can be verified.",
    };
  }
  const numbers = new Set(picks.map((p) => p.overallPick));
  const max = Math.max(...numbers);
  const gaps = max - numbers.size;
  if (gaps > 0) {
    return {
      status: "incomplete",
      recorded: picks.length,
      expected: null,
      missing: gaps,
      note: `${gaps} nomination number${gaps === 1 ? " is" : "s are"} missing between #1 and #${max}.`,
    };
  }
  return {
    status: "unverified",
    recorded: picks.length,
    expected: null,
    note: "No gaps in the recorded nominations, but the league doesn't record how many players each auction should have, so the total can't be verified.",
  };
}

// ---------------------------------------------------------------------------
// FYPD
// ---------------------------------------------------------------------------

export interface FypdOrderSlotInput {
  slot: number;
  team: TeamRef;
}

export interface FypdSelectionInput {
  id: string;
  round: number;
  pickInRound: number;
  overallPick: number;
  team: TeamRef;
  player: PlayerRef | null;
  notes: string | null;
}

export interface FypdDraftInput {
  year: number;
  rounds: number;
  order: FypdOrderSlotInput[];
  selections: FypdSelectionInput[];
}

/** The round-1 order as team ids, or null (with why) when it can't drive the snake logic. */
export function validateFypdOrder(order: FypdOrderSlotInput[]): { teams: TeamRef[] } | { teams: null; reason: string } {
  if (order.length === 0) return { teams: null, reason: "No draft order is stored for this FYPD." };
  const sorted = [...order].sort((a, b) => a.slot - b.slot);
  const contiguous = sorted.every((s, i) => s.slot === i + 1);
  if (!contiguous) return { teams: null, reason: "The stored draft order has missing or duplicate slots." };
  if (new Set(sorted.map((s) => s.team.id)).size !== sorted.length) {
    return { teams: null, reason: "The stored draft order lists a team more than once." };
  }
  return { teams: sorted.map((s) => s.team) };
}

export function buildFypdHistory(draft: FypdDraftInput): DraftHistory {
  const notes: string[] = [];
  const order = validateFypdOrder(draft.order);
  const teamCount = order.teams?.length ?? 0;
  const expected = order.teams && draft.rounds > 0 ? teamCount * draft.rounds : null;

  // Defensive de-duplication: the database forbids two selections at one
  // overall pick, but the read model must never double-count if a bad
  // import ever slips through.
  const byPick = new Map<number, FypdSelectionInput[]>();
  for (const s of draft.selections) {
    if (!byPick.has(s.overallPick)) byPick.set(s.overallPick, []);
    byPick.get(s.overallPick)!.push(s);
  }
  const sorted = [...draft.selections].sort((a, b) => a.overallPick - b.overallPick || a.id.localeCompare(b.id));
  const distinctRecorded = byPick.size;
  const duplicatePicks = [...byPick.values()].filter((v) => v.length > 1).length;
  if (duplicatePicks > 0) notes.push(`${duplicatePicks} overall pick number${duplicatePicks === 1 ? " is" : "s are"} recorded more than once.`);

  const completeness = fypdCompleteness(distinctRecorded, expected, [...byPick.keys()], order.teams ? null : order.reason);
  const isComplete = completeness.status === "complete";

  // Original slots come from the stored round-1 order run through the snake
  // engine - but only where the stored pick number can be trusted to mean
  // that slot. In a complete draft every number is accounted for, so it
  // always can (a different selector there means the pick changed hands).
  // In an incomplete draft, skipped picks may have been renumbered (2025's
  // were: every pick after #38 is shifted), so a mismatch is ambiguous -
  // trust stops at the first gap or first selector/slot mismatch.
  let trustHorizon = Infinity;
  if (order.teams && !isComplete) {
    for (let n = 1; n <= (expected ?? 0); n++) {
      const sels = byPick.get(n);
      if (!sels) {
        trustHorizon = n;
        break;
      }
      const owner = order.teams[getSnakeSlot(n, teamCount).orderIndex];
      if (sels.some((s) => s.team.id !== owner.id)) {
        trustHorizon = n;
        break;
      }
    }
    if (trustHorizon !== Infinity && distinctRecorded > 0) {
      const through = trustHorizon > 1 ? `Original slots are shown only through pick #${trustHorizon - 1}. ` : "";
      notes.push(
        `${through}From #${trustHorizon} on, the recorded pick numbers no longer line up with the snake order - most likely because skipped picks were renumbered - so the original slot is unknown.`
      );
    }
  }

  const picks: DraftHistoryPick[] = sorted.map((s) => {
    const flags: string[] = [];
    if (!s.player) flags.push("No player recorded for this pick.");
    if ((byPick.get(s.overallPick)?.length ?? 0) > 1) flags.push("Another selection shares this pick number.");
    if (s.notes) flags.push(s.notes);
    return {
      key: s.id,
      overallPick: s.overallPick,
      round: s.round,
      pickInRound: s.pickInRound,
      team: s.team,
      player: s.player,
      cost: null,
      isKeeperSlot: false,
      order: "source",
      originalSlot: originalSlotFor(s, order, teamCount, expected, trustHorizon, (byPick.get(s.overallPick)?.length ?? 0) > 1),
      flags,
    };
  });

  return { kind: "fypd", year: draft.year, completeness, picks, notes };
}

function originalSlotFor(
  s: FypdSelectionInput,
  order: ReturnType<typeof validateFypdOrder>,
  teamCount: number,
  expected: number | null,
  trustHorizon: number,
  duplicated: boolean
): OriginalSlot {
  if (!order.teams) return { status: "unknown", reason: order.reason };
  if (expected === null || s.overallPick < 1 || s.overallPick > expected) {
    return { status: "unknown", reason: "This pick number is outside the draft's stored order." };
  }
  if (duplicated) return { status: "unknown", reason: "Another selection shares this pick number." };
  const slot = getSnakeSlot(s.overallPick, teamCount);
  if (slot.round !== s.round || slot.pickInRound !== s.pickInRound) {
    return { status: "unknown", reason: "The stored round/pick don't match this overall pick number." };
  }
  if (s.overallPick >= trustHorizon) {
    return { status: "unknown", reason: "Pick numbering can't be trusted past the first gap or mismatch in this incomplete draft." };
  }
  const team = order.teams[slot.orderIndex];
  return { status: "known", team, differsFromSelector: team.id !== s.team.id };
}

export function fypdCompleteness(
  recorded: number,
  expected: number | null,
  pickNumbers: number[],
  orderProblem: string | null
): Completeness {
  if (recorded === 0) {
    return { status: "none", recorded: 0, expected, note: "No FYPD selections are stored for this draft." };
  }
  if (expected === null) {
    return {
      status: "incomplete",
      recorded,
      expected: null,
      missing: null,
      note: `${orderProblem ?? "No draft order is stored."} The expected number of picks can't be calculated.`,
    };
  }
  const outOfRange = pickNumbers.filter((n) => n < 1 || n > expected).length;
  const inRange = recorded - outOfRange;
  if (inRange === expected && outOfRange === 0) {
    return { status: "complete", recorded, expected, note: `All ${expected} picks are recorded.` };
  }
  const missing = expected - inRange;
  const parts = [`${recorded} of ${expected} picks recorded.`];
  if (missing > 0) parts.push(`${missing} slot${missing === 1 ? " has" : "s have"} no recorded selection (passed, or missing from the source).`);
  if (outOfRange > 0) parts.push(`${outOfRange} pick${outOfRange === 1 ? " is" : "s are"} numbered beyond the draft's ${expected} slots.`);
  return { status: "incomplete", recorded, expected, missing: Math.max(missing, 0), note: parts.join(" ") };
}

// ---------------------------------------------------------------------------
// Filtering + labels
// ---------------------------------------------------------------------------

export function filterDraftPicks(picks: DraftHistoryPick[], filters: { teamId?: string; q?: string }): DraftHistoryPick[] {
  const q = filters.q?.trim().toLowerCase();
  return picks.filter((p) => {
    if (filters.teamId) {
      const matchesSelector = p.team.id === filters.teamId;
      const matchesOriginal = p.originalSlot.status === "known" && p.originalSlot.team.id === filters.teamId;
      if (!matchesSelector && !matchesOriginal) return false;
    }
    if (q) {
      const hay = [p.player?.name, p.player?.mlbTeam, p.team.name, ...(p.player?.positions ?? [])].filter(Boolean).join(" ").toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

export const COMPLETENESS_LABEL: Record<Completeness["status"], string> = {
  none: "No data",
  complete: "Complete",
  incomplete: "Incomplete",
  unverified: "Total unverified",
};
