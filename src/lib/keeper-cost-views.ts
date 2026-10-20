/**
 * Read models for the dense views that show a keeper cost or an auction
 * number - the team page, Players › Market, search and the per-year draft
 * board. Read-only. Every cost goes through classifyKeeperCost (via
 * loadKeeperCostValues) and every auction number through
 * nominationOrderOf, so these views follow the same rules as Player Costs
 * and Draft History: a cost calculated from a missing or guessed price
 * reads Unavailable, a forced-back player reads None, and a workbook row
 * number reads "Row", never a nomination.
 */

import type { Prisma } from "@prisma/client";
import { prisma } from "./db";
import { AUCTION_BUDGET } from "./config";
import { getTeamRoster } from "./rosters";
import { declaredKeeperWhere } from "./keeper-slots";
import { loadKeeperCostValues } from "./player-costs-data";
import { classifyAuctionCost, compareCostDesc, summarizeKeeperBudget, type CostValue } from "./player-costs";
import { auctionNumberHeader, auctionNumberLabel, nominationOrderOf, type NominationOrder } from "./draft-history";

const keeperCostFields = {
  id: true,
  playerId: true,
  seasonYear: true,
  keeperYear: true,
  keeperCost: true,
  stintIndex: true,
  status: true,
  commissionerOverride: true,
} as const;

/**
 * The team page's roster, each row with its checked keeper cost, plus the
 * keeper slots the team declared and what they leave of the auction budget.
 */
export async function loadTeamRosterCosts(teamId: string, seasonYear: number) {
  const [roster, declared] = await Promise.all([
    getTeamRoster(teamId, seasonYear),
    // Keeper slots are what this team declared at the deadline, whether or
    // not the player has since been traded away or dropped (see keeper-slots).
    prisma.keeperRecord.findMany({ where: declaredKeeperWhere(seasonYear, teamId), select: keeperCostFields }),
  ]);
  const records = new Map<string, (typeof declared)[number]>();
  for (const r of declared) records.set(r.id, r);
  for (const row of roster.rows) if (row.keeper) records.set(row.keeper.id, row.keeper);
  const costs = await loadKeeperCostValues([...records.values()]);

  return {
    roster: {
      ...roster,
      rows: roster.rows.map((r) => ({ ...r, cost: r.keeper ? costs.get(r.keeper.id) : undefined })),
    },
    declaredCount: declared.length,
    budget: summarizeKeeperBudget(
      declared.map((r) => costs.get(r.id)),
      AUCTION_BUDGET
    ),
  };
}

export interface MarketFilters {
  seasonYear: number;
  team?: string;
  yearsRemaining?: number;
  q?: string;
  position?: string;
  tag?: Prisma.PlayerWhereInput["tags"];
  sort?: string;
}

/** Players › Market rows: each rostered keeper with its checked cost, sorted. */
export async function loadMarketRows(f: MarketFilters) {
  const keeperWhere: Prisma.KeeperRecordWhereInput = { seasonYear: f.seasonYear, status: { not: "DROPPED" } };
  if (f.team) keeperWhere.teamId = f.team;
  if (f.yearsRemaining !== undefined) keeperWhere.yearsRemaining = f.yearsRemaining;

  const playerWhere: Prisma.PlayerWhereInput = { keeperRecords: { some: keeperWhere } };
  if (f.q) playerWhere.name = { contains: f.q, mode: "insensitive" };
  if (f.position) playerWhere.positions = { has: f.position };
  if (f.tag) playerWhere.tags = f.tag;

  const players = await prisma.player.findMany({
    where: playerWhere,
    include: {
      keeperRecords: { where: keeperWhere, include: { team: true }, orderBy: { stintIndex: "desc" } },
      tags: true,
    },
    take: 200,
  });

  const withRecord = players.flatMap((p) => (p.keeperRecords[0] ? [{ player: p, record: p.keeperRecords[0] }] : []));
  const costs = await loadKeeperCostValues(withRecord.map((r) => r.record));
  const rows = withRecord.map((r) => ({ ...r, cost: costs.get(r.record.id) }));

  if (f.sort === "cost") rows.sort((a, b) => compareCostDesc(a.cost, b.cost) || a.player.name.localeCompare(b.player.name));
  else if (f.sort === "yearsRemaining") rows.sort((a, b) => a.record.yearsRemaining - b.record.yearsRemaining);
  else rows.sort((a, b) => a.player.name.localeCompare(b.player.name));
  return rows;
}

export interface AuctionPickRow {
  id: string;
  overallPick: number;
  order: NominationOrder;
  number: { text: string; title: string; inferred: boolean };
  cost: CostValue;
  isKeeperSlot: boolean;
}

/** Labels one stored auction pick: its number by provenance, its price checked. */
export function shapeAuctionPick(p: { id: string; overallPick: number; sourceRef: string | null; cost: number | null; isKeeperSlot: boolean }): AuctionPickRow {
  const order = nominationOrderOf(p.sourceRef);
  return {
    id: p.id,
    overallPick: p.overallPick,
    order,
    number: auctionNumberLabel(p.overallPick, order),
    cost: classifyAuctionCost(p.cost),
    isKeeperSlot: p.isKeeperSlot,
  };
}

/** The per-year draft board (/history/draft/[year]). */
export async function loadDraftBoard(year: number) {
  const picks = await prisma.draftPick.findMany({
    where: { seasonYear: year },
    orderBy: { overallPick: "asc" },
    include: { team: true, player: true },
  });
  const rows = picks.map((p) => ({ ...shapeAuctionPick(p), team: p.team, player: p.player, playerId: p.playerId }));
  return { rows, header: auctionNumberHeader(rows.map((r) => r.order)), inferredCount: rows.filter((r) => r.number.inferred).length };
}
