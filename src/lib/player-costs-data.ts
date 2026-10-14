/**
 * Database reads for /players/costs. Read-only - nothing here writes.
 * Every query is scoped to one season; the shaping and the rules for what
 * counts as a real price live in player-costs.ts.
 */

import { prisma } from "./db";
import { buildPlayerCostRows, classifyKeeperCost, findStintOrigin, type CostValue, type PlayerCostRow } from "./player-costs";
import type { KeeperStatus } from "@prisma/client";

const teamSelect = { id: true, name: true } as const;

/** Seasons with any recorded cost fact, plus the current season, newest first. */
export async function listCostSeasons(leagueId: string, currentSeasonYear: number): Promise<number[]> {
  const [picks, acqs, keepers] = await Promise.all([
    prisma.draftPick.findMany({ where: { season: { leagueId } }, distinct: ["seasonYear"], select: { seasonYear: true } }),
    prisma.acquisition.findMany({ where: { season: { leagueId } }, distinct: ["seasonYear"], select: { seasonYear: true } }),
    prisma.keeperRecord.findMany({ where: { season: { leagueId } }, distinct: ["seasonYear"], select: { seasonYear: true } }),
  ]);
  const years = new Set<number>([currentSeasonYear, ...picks, ...acqs, ...keepers].map((x) => (typeof x === "number" ? x : x.seasonYear)));
  return [...years].sort((a, b) => b - a);
}

export async function loadPlayerCostRows(leagueId: string, season: number, currentSeasonYear: number): Promise<PlayerCostRow[]> {
  const isCurrentSeason = season === currentSeasonYear;
  const [auctionPicks, acquisitions, keeperRecords, currentRoster] = await Promise.all([
    prisma.draftPick.findMany({
      where: { seasonYear: season, season: { leagueId }, playerId: { not: null } },
      select: { id: true, seasonYear: true, overallPick: true, cost: true, isKeeperSlot: true, playerId: true, team: { select: teamSelect } },
    }),
    prisma.acquisition.findMany({
      where: { seasonYear: season, season: { leagueId } },
      select: { id: true, seasonYear: true, method: true, cost: true, notes: true, sourceRef: true, date: true, playerId: true, team: { select: teamSelect } },
    }),
    prisma.keeperRecord.findMany({
      where: { seasonYear: season, season: { leagueId } },
      select: {
        id: true,
        seasonYear: true,
        keeperYear: true,
        keeperCost: true,
        yearsRemaining: true,
        status: true,
        stintIndex: true,
        commissionerOverride: true,
        playerId: true,
        team: { select: teamSelect },
        startTeam: { select: teamSelect },
      },
    }),
    prisma.rosterSpot.findMany({
      where: { season: { leagueId, year: currentSeasonYear } },
      select: { playerId: true, team: { select: teamSelect } },
    }),
  ]);

  const playerIds = new Set<string>([
    ...auctionPicks.map((p) => p.playerId!),
    ...acquisitions.map((a) => a.playerId),
    ...keeperRecords.map((k) => k.playerId),
    // The current season also lists everyone on a roster today, so a
    // rostered player with no cost on record shows up as Unavailable
    // rather than silently missing.
    ...(isCurrentSeason ? currentRoster.map((r) => r.playerId) : []),
  ]);

  const [players, originAcquisitions] = await Promise.all([
    prisma.player.findMany({
      where: { leagueId, id: { in: [...playerIds] } },
      select: { id: true, name: true, mlbTeam: true, positions: true },
    }),
    // Read only to trace where each keeper cost came from (never displayed):
    // a keeper record's stint started in an earlier season.
    prisma.acquisition.findMany({
      where: { playerId: { in: [...new Set(keeperRecords.map((k) => k.playerId))] }, method: { not: "TRADE" }, seasonYear: { lte: season }, season: { leagueId } },
      select: { id: true, seasonYear: true, method: true, cost: true, notes: true, sourceRef: true, date: true, playerId: true, team: { select: teamSelect } },
    }),
  ]);

  return buildPlayerCostRows({
    season,
    players,
    auctionPicks: auctionPicks.map((p) => ({ ...p, playerId: p.playerId! })),
    acquisitions,
    keeperRecords,
    originAcquisitions,
    currentRoster,
    currentRosterSynced: currentRoster.length > 0,
    isCurrentSeason,
  });
}

/**
 * Provenance-checked keeper costs for any set of KeeperRecords (see
 * classifyKeeperCost): one query for the stints' origin acquisitions.
 * Views that show a keeper cost use this so a cost calculated from a
 * missing or guessed price never reads as a real one.
 */
export async function loadKeeperCostValues(
  records: { id: string; playerId: string; seasonYear: number; keeperYear: number; keeperCost: number; stintIndex: number; status: KeeperStatus; commissionerOverride: boolean }[]
): Promise<Map<string, CostValue>> {
  const out = new Map<string, CostValue>();
  if (records.length === 0) return out;
  const acquisitions = await prisma.acquisition.findMany({
    where: { playerId: { in: [...new Set(records.map((r) => r.playerId))] }, method: { not: "TRADE" } },
    select: { seasonYear: true, method: true, cost: true, notes: true, sourceRef: true, date: true, playerId: true },
  });
  const byPlayer = new Map<string, typeof acquisitions>();
  for (const a of acquisitions) {
    if (!byPlayer.has(a.playerId)) byPlayer.set(a.playerId, []);
    byPlayer.get(a.playerId)!.push(a);
  }
  for (const r of records) out.set(r.id, classifyKeeperCost(r, findStintOrigin(byPlayer.get(r.playerId) ?? [], r)));
  return out;
}
