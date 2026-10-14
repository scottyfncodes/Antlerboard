/**
 * Player Costs - the read model behind /players/costs. Pure and DB-free
 * (see player-costs-data.ts for the queries) so every "is this a real
 * price?" rule is unit tested directly.
 *
 * The four cost facts are deliberately kept apart - they are not
 * interchangeable:
 * - Auction price: DraftPick.cost, the winning bid at that season's live
 *   auction (keeper-slot rows excluded - those aren't auction buys).
 * - Acquisition cost + method: Acquisition.cost, what a stint started at
 *   (auction, FAAB bid, free call-up), or nothing for a trade, which
 *   carries the existing price.
 * - Keeper cost: KeeperRecord.keeperCost, what keeping the player counted
 *   against the team's budget that season.
 * - Keeper year: KeeperRecord.keeperYear.
 *
 * Acquisition.cost is a non-null column defaulting to 0, and the league-
 * history import writes 0 where its source had no price (flagging that in
 * `notes`) or back-solves a price from a later keeper cost. Neither is a
 * real recorded price, so both read as Unavailable here - never as $0.
 *
 * Nothing here ever borrows a value across seasons or from the current
 * roster: a row only shows facts recorded for the season being viewed.
 */

import type { AcquisitionMethod, KeeperStatus } from "@prisma/client";

export type CostValue =
  | { status: "recorded"; amount: number; note?: string }
  | { status: "unavailable"; reason: string }
  /** No price applies by design (a trade carries the existing cost). */
  | { status: "not-applicable"; reason: string };

export const UNAVAILABLE = "Unavailable";

export const ACQUISITION_METHOD_LABEL: Record<AcquisitionMethod, string> = {
  DRAFT: "Auction",
  WAIVER: "Waiver (FAAB)",
  FREE_AGENT: "Free agent",
  FYPD: "FYPD call-up",
  TRADE: "Trade",
};

export const KEEPER_STATUS_LABEL: Record<KeeperStatus, string> = {
  KEPT: "Kept",
  FORCED_BACK: "Forced back",
  DROPPED: "Stint ended",
  NEEDS_DECISION: "Needs decision",
};

interface TeamRef {
  id: string;
  name: string;
}

export interface AcquisitionInput {
  id: string;
  seasonYear: number;
  method: AcquisitionMethod;
  cost: number;
  notes: string | null;
  sourceRef: string | null;
  date: Date;
  team: TeamRef;
}

export interface AuctionPickInput {
  id: string;
  seasonYear: number;
  overallPick: number;
  cost: number | null;
  isKeeperSlot: boolean;
  team: TeamRef;
}

export interface KeeperRecordInput {
  id: string;
  seasonYear: number;
  keeperYear: number;
  keeperCost: number;
  yearsRemaining: number;
  status: KeeperStatus;
  stintIndex: number;
  commissionerOverride: boolean;
  team: TeamRef;
  startTeam: TeamRef | null;
}

export interface PlayerInput {
  id: string;
  name: string;
  mlbTeam: string | null;
  positions: string[];
}

export type CurrentStatus =
  | { kind: "team"; team: TeamRef }
  | { kind: "free-agent" }
  /** No roster sync has run for the current season, so we can't say. */
  | { kind: "unknown" };

/** Phrases the league-history import writes into `notes` when a cost isn't a real recorded price. */
const MISSING_PRICE_NOTE = /recorded as 0|had no salary|had no cost/i;
const INFERRED_PRICE_NOTE = /origin assumed|treated as acquired in|priced to match/i;

export function classifyAcquisitionCost(a: Pick<AcquisitionInput, "method" | "cost" | "notes" | "sourceRef">): CostValue {
  if (a.method === "TRADE") {
    return { status: "not-applicable", reason: "Trades carry the player's existing cost." };
  }
  const notes = a.notes ?? "";
  if (MISSING_PRICE_NOTE.test(notes)) {
    return { status: "unavailable", reason: "The source had no price for this acquisition." };
  }
  if (INFERRED_PRICE_NOTE.test(notes)) {
    return { status: "unavailable", reason: "No recorded price - the import estimated it from a later keeper cost." };
  }
  if (!Number.isFinite(a.cost) || a.cost < 0) {
    return { status: "unavailable", reason: "The stored price isn't a valid amount." };
  }
  if (a.method === "FYPD") {
    return { status: "recorded", amount: a.cost, note: "Free call-up - the keeper clock starts at an assumed $4." };
  }
  // Season-end roster sheets leave a blank price as 0 with no flag, so a $0
  // from one can't be told apart from a missing price.
  if (a.cost === 0 && a.sourceRef?.includes("/eoy")) {
    return { status: "unavailable", reason: "The season-end roster sheet showed $0 or no price." };
  }
  return { status: "recorded", amount: a.cost };
}

export function classifyAuctionCost(cost: number | null): CostValue {
  if (cost === null || !Number.isFinite(cost) || cost < 0) {
    return { status: "unavailable", reason: "No winning price is recorded for this auction pick." };
  }
  return { status: "recorded", amount: cost };
}

export function classifyKeeperCost(cost: number | null | undefined): CostValue {
  if (cost === null || cost === undefined || !Number.isFinite(cost) || cost < 0) {
    return { status: "unavailable", reason: "No keeper cost is recorded." };
  }
  return { status: "recorded", amount: cost };
}

export function costLabel(value: CostValue): string {
  if (value.status === "recorded") return `$${value.amount.toFixed(value.amount % 1 === 0 ? 0 : 2)}`;
  if (value.status === "not-applicable") return "Carried";
  return UNAVAILABLE;
}

export interface PlayerCostRow {
  player: PlayerInput;
  season: number;
  currentStatus: CurrentStatus;
  /** Every team a recorded fact places the player on in this season. */
  seasonTeams: TeamRef[];
  auction: { key: string; overallPick: number; team: TeamRef; cost: CostValue }[];
  acquisitions: { key: string; method: AcquisitionMethod; methodLabel: string; team: TeamRef; date: Date; cost: CostValue }[];
  keeper: {
    key: string;
    keeperYear: number;
    yearsRemaining: number;
    status: KeeperStatus;
    statusLabel: string;
    commissionerOverride: boolean;
    team: TeamRef;
    cost: CostValue;
  } | null;
  flags: string[];
  hasRecordedCost: boolean;
}

export interface BuildPlayerCostRowsInput {
  season: number;
  players: PlayerInput[];
  auctionPicks: (AuctionPickInput & { playerId: string })[];
  acquisitions: (AcquisitionInput & { playerId: string })[];
  keeperRecords: (KeeperRecordInput & { playerId: string })[];
  /** Current-season roster spots (player -> team). Only consulted for "Now" status. */
  currentRoster: { playerId: string; team: TeamRef }[];
  /** Whether a roster sync has stored any current-season roster at all. */
  currentRosterSynced: boolean;
  /** Current-season roster spots also place a player on a team when viewing the current season. */
  isCurrentSeason: boolean;
}

function groupBy<T extends { playerId: string }>(items: T[]): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const i of items) {
    if (!m.has(i.playerId)) m.set(i.playerId, []);
    m.get(i.playerId)!.push(i);
  }
  return m;
}

export function buildPlayerCostRows(input: BuildPlayerCostRowsInput): PlayerCostRow[] {
  // Season separation is enforced here as well as in the query, so a
  // caller that passes a wider dataset can't leak another season's costs.
  const inSeason = <T extends { seasonYear: number }>(xs: T[]) => xs.filter((x) => x.seasonYear === input.season);
  const picksBy = groupBy(inSeason(input.auctionPicks).filter((p) => !p.isKeeperSlot));
  const acqBy = groupBy(inSeason(input.acquisitions));
  const keepersBy = groupBy(inSeason(input.keeperRecords));
  const rosterBy = new Map(input.currentRoster.map((r) => [r.playerId, r.team]));

  const rows = input.players.map((player): PlayerCostRow => {
    const flags: string[] = [];
    const picks = [...(picksBy.get(player.id) ?? [])].sort((a, b) => a.overallPick - b.overallPick);
    const acqs = [...(acqBy.get(player.id) ?? [])].sort((a, b) => a.date.getTime() - b.date.getTime());
    // Latest stint is the one that's live for the season (see KeeperRecord.stintIndex).
    const keepers = [...(keepersBy.get(player.id) ?? [])].sort((a, b) => b.stintIndex - a.stintIndex);
    const keeper = keepers[0] ?? null;

    if (picks.length > 1) flags.push(`${picks.length} auction records for this player in ${input.season} - check the source data.`);

    const rosterTeam = rosterBy.get(player.id);
    const currentStatus: CurrentStatus = rosterTeam
      ? { kind: "team", team: rosterTeam }
      : input.currentRosterSynced
        ? { kind: "free-agent" }
        : { kind: "unknown" };

    const teams = new Map<string, TeamRef>();
    const addTeam = (t: TeamRef | null | undefined) => t && teams.set(t.id, t);
    if (keeper) {
      addTeam(keeper.startTeam);
      addTeam(keeper.team);
    }
    picks.forEach((p) => addTeam(p.team));
    acqs.forEach((a) => addTeam(a.team));
    if (input.isCurrentSeason) addTeam(rosterTeam);

    const auction = picks.map((p) => ({ key: p.id, overallPick: p.overallPick, team: p.team, cost: classifyAuctionCost(p.cost) }));
    const acquisitions = acqs.map((a) => ({
      key: a.id,
      method: a.method,
      methodLabel: ACQUISITION_METHOD_LABEL[a.method],
      team: a.team,
      date: a.date,
      cost: classifyAcquisitionCost(a),
    }));
    const keeperRow = keeper
      ? {
          key: keeper.id,
          keeperYear: keeper.keeperYear,
          yearsRemaining: keeper.yearsRemaining,
          status: keeper.status,
          statusLabel: KEEPER_STATUS_LABEL[keeper.status],
          commissionerOverride: keeper.commissionerOverride,
          team: keeper.startTeam ?? keeper.team,
          cost: classifyKeeperCost(keeper.keeperCost),
        }
      : null;

    const hasRecordedCost =
      auction.some((a) => a.cost.status === "recorded") ||
      acquisitions.some((a) => a.cost.status === "recorded") ||
      keeperRow?.cost.status === "recorded";

    return {
      player,
      season: input.season,
      currentStatus,
      seasonTeams: [...teams.values()],
      auction,
      acquisitions,
      keeper: keeperRow,
      flags,
      hasRecordedCost,
    };
  });

  return rows.sort((a, b) => a.player.name.localeCompare(b.player.name));
}

export interface PlayerCostFilters {
  teamId?: string;
  position?: string;
  q?: string;
  /** "recorded": at least one real price; "missing": none at all. */
  cost?: "recorded" | "missing";
}

export function filterPlayerCostRows(rows: PlayerCostRow[], f: PlayerCostFilters): PlayerCostRow[] {
  const q = f.q?.trim().toLowerCase();
  return rows.filter((r) => {
    if (f.teamId && !r.seasonTeams.some((t) => t.id === f.teamId)) return false;
    if (f.position && !r.player.positions.includes(f.position)) return false;
    if (q && !`${r.player.name} ${r.player.mlbTeam ?? ""}`.toLowerCase().includes(q)) return false;
    if (f.cost === "recorded" && !r.hasRecordedCost) return false;
    if (f.cost === "missing" && r.hasRecordedCost) return false;
    return true;
  });
}

export const COST_PAGE_SIZE = 50;

export function paginate<T>(items: T[], page: number, size = COST_PAGE_SIZE) {
  const pageCount = Math.max(1, Math.ceil(items.length / size));
  const current = Math.min(Math.max(1, Number.isFinite(page) ? Math.floor(page) : 1), pageCount);
  return { items: items.slice((current - 1) * size, current * size), page: current, pageCount, total: items.length };
}
