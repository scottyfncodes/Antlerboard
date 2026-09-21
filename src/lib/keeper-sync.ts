/**
 * Bridges the pure keeper-engine functions to the database: reads a
 * player's Acquisition/Transaction history, runs it through the engine,
 * and materializes the result into KeeperRecord rows so the Keeper Board
 * and history views can query cheaply instead of recomputing on every
 * request.
 *
 * Call `recomputeKeeperRecordsForPlayer` any time a player's
 * acquisition/drop/trade history changes (draft, waiver add, drop, trade,
 * CSV import, commissioner correction).
 */

import { prisma } from "./db";
import {
  getContinuousKeeperHistory,
  type PlayerHistoryEvent,
  type StintStartMethod,
  type KeeperRecordStatus,
} from "./keeper-engine";
import type { KeeperStatus as PrismaKeeperStatus } from "@prisma/client";

export async function getPlayerHistoryEvents(
  playerId: string
): Promise<PlayerHistoryEvent[]> {
  const [acquisitions, drops] = await Promise.all([
    prisma.acquisition.findMany({
      where: { playerId },
      orderBy: { seasonYear: "asc" },
    }),
    prisma.transaction.findMany({
      where: { type: "DROP", players: { some: { playerId } } },
      orderBy: { seasonYear: "asc" },
    }),
  ]);

  const events: PlayerHistoryEvent[] = [];

  for (const a of acquisitions) {
    if (a.method === "TRADE") {
      events.push({ type: "TRADED", season: a.seasonYear, teamId: a.teamId });
    } else {
      events.push({
        type: "ACQUIRED",
        season: a.seasonYear,
        method: a.method as StintStartMethod,
        cost: a.cost,
        teamId: a.teamId,
      });
    }
  }

  for (const d of drops) {
    events.push({ type: "DROPPED", season: d.seasonYear });
  }

  return events;
}

function mapStatus(status: KeeperRecordStatus): PrismaKeeperStatus {
  if (status === "FORCED_BACK") return "FORCED_BACK";
  return "KEPT";
}

export async function recomputeKeeperRecordsForPlayer(
  playerId: string,
  throughSeason: number
): Promise<void> {
  const events = await getPlayerHistoryEvents(playerId);
  if (events.length === 0) return;

  const timeline = getContinuousKeeperHistory(events, throughSeason);
  const seasons = await prisma.season.findMany({
    where: { year: { in: timeline.map((t) => t.season) } },
  });
  const seasonByYear = new Map(seasons.map((s) => [s.year, s]));

  for (const info of timeline) {
    const season = seasonByYear.get(info.season);
    if (!season) continue;

    await prisma.keeperRecord.upsert({
      where: { seasonId_playerId: { seasonId: season.id, playerId } },
      create: {
        seasonId: season.id,
        seasonYear: info.season,
        playerId,
        teamId: info.teamId,
        keeperYear: info.keeperYear,
        keeperCost: info.cost ?? 0,
        yearsRemaining: info.yearsRemaining ?? 0,
        status: mapStatus(info.status),
        stintIndex: info.stintIndex,
      },
      update: {
        teamId: info.teamId,
        keeperYear: info.keeperYear,
        keeperCost: info.cost ?? 0,
        yearsRemaining: info.yearsRemaining ?? 0,
        status: mapStatus(info.status),
        stintIndex: info.stintIndex,
      },
    });
  }
}

export async function recomputeAllKeeperRecords(throughSeason: number): Promise<void> {
  const players = await prisma.player.findMany({ select: { id: true } });
  for (const p of players) {
    await recomputeKeeperRecordsForPlayer(p.id, throughSeason);
  }
}
