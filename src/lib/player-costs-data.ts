/**
 * Database reads for /players/costs. Read-only - nothing here writes.
 * Every query is scoped to one season; the shaping and the rules for what
 * counts as a real price live in player-costs.ts.
 */

import { prisma } from "./db";
import { buildPlayerCostRows, type PlayerCostRow } from "./player-costs";

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

  const players = await prisma.player.findMany({
    where: { leagueId, id: { in: [...playerIds] } },
    select: { id: true, name: true, mlbTeam: true, positions: true },
  });

  return buildPlayerCostRows({
    season,
    players,
    auctionPicks: auctionPicks.map((p) => ({ ...p, playerId: p.playerId! })),
    acquisitions,
    keeperRecords,
    currentRoster,
    currentRosterSynced: currentRoster.length > 0,
    isCurrentSeason,
  });
}
