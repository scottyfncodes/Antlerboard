/**
 * Bridges the pure keeper-engine functions to the database: reads a
 * player's Acquisition/Transaction history, runs it through the engine,
 * and materializes the result into KeeperRecord rows so the Keeper Board
 * and history views can query cheaply instead of recomputing on every
 * request.
 *
 * Call `recomputeKeeperRecordsForPlayer` any time a player's
 * acquisition/drop/trade history changes (draft, waiver add, drop, trade,
 * import, commissioner correction).
 */

import { prisma } from "./db";
import {
  getContinuousKeeperHistory,
  type PlayerHistoryEvent,
  type StintStartMethod,
  type KeeperRecordStatus,
} from "./keeper-engine";
import type { KeeperStatus as PrismaKeeperStatus, Prisma, PrismaClient } from "@prisma/client";

type Db = PrismaClient | Prisma.TransactionClient;

export async function getPlayerHistoryEvents(
  playerId: string,
  db: Db = prisma
): Promise<PlayerHistoryEvent[]> {
  const [acquisitions, drops] = await Promise.all([
    db.acquisition.findMany({
      where: { playerId },
      orderBy: [{ seasonYear: "asc" }, { date: "asc" }],
    }),
    db.transaction.findMany({
      where: { type: "DROP", players: { some: { playerId } } },
      orderBy: [{ seasonYear: "asc" }, { date: "asc" }],
    }),
  ]);

  const events: PlayerHistoryEvent[] = [];

  for (const a of acquisitions) {
    if (a.method === "TRADE") {
      events.push({ type: "TRADED", season: a.seasonYear, teamId: a.teamId, date: a.date });
    } else {
      events.push({
        type: "ACQUIRED",
        season: a.seasonYear,
        method: a.method as StintStartMethod,
        cost: a.cost,
        teamId: a.teamId,
        date: a.date,
      });
    }
  }

  for (const d of drops) {
    events.push({ type: "DROPPED", season: d.seasonYear, date: d.date });
  }

  return events;
}

function mapStatus(status: KeeperRecordStatus): PrismaKeeperStatus {
  if (status === "FORCED_BACK") return "FORCED_BACK";
  return "KEPT";
}

/**
 * Rebuilds a player's KeeperRecord rows from their event history. Rows a
 * commissioner has marked as an override are left exactly as they are;
 * rows for seasons the history no longer covers (e.g. after a drop was
 * recorded) are removed so stale "still kept" rows don't linger.
 */
export async function recomputeKeeperRecordsForPlayer(
  playerId: string,
  throughSeason: number,
  db: Db = prisma
): Promise<void> {
  const events = await getPlayerHistoryEvents(playerId, db);
  const timeline = events.length === 0 ? [] : getContinuousKeeperHistory(events, throughSeason);
  const coveredSeasons = [...new Set(timeline.map((t) => t.season))];

  await db.keeperRecord.deleteMany({
    where: { playerId, commissionerOverride: false, seasonYear: { notIn: coveredSeasons } },
  });
  if (timeline.length === 0) return;

  const seasons = await db.season.findMany({ where: { year: { in: coveredSeasons } } });
  const seasonByYear = new Map(seasons.map((s) => [s.year, s]));
  const overridden = new Set(
    (await db.keeperRecord.findMany({ where: { playerId, commissionerOverride: true }, select: { seasonYear: true } })).map(
      (r) => r.seasonYear
    )
  );

  // Timeline order is stint order, so when two stints touch the same
  // season (dropped and re-added within a year) the later stint's row is
  // the one that lands.
  for (const info of timeline) {
    const season = seasonByYear.get(info.season);
    if (!season || overridden.has(info.season)) continue;

    const data = {
      teamId: info.teamId,
      keeperYear: info.keeperYear,
      keeperCost: info.cost ?? 0,
      yearsRemaining: info.yearsRemaining ?? 0,
      status: mapStatus(info.status),
      stintIndex: info.stintIndex,
    };
    await db.keeperRecord.upsert({
      where: { seasonId_playerId: { seasonId: season.id, playerId } },
      create: { seasonId: season.id, seasonYear: info.season, playerId, ...data },
      update: data,
    });
  }
}

export async function recomputeAllKeeperRecords(throughSeason: number, db: Db = prisma): Promise<void> {
  const players = await db.player.findMany({ select: { id: true } });
  for (const p of players) {
    await recomputeKeeperRecordsForPlayer(p.id, throughSeason, db);
  }
}
