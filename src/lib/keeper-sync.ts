/**
 * Bridges the pure keeper-engine functions to the database: reads a
 * player's Acquisition/Transaction history, runs it through the engine,
 * and materializes the result into KeeperRecord rows so the Keeper Board
 * and history views can query cheaply instead of recomputing on every
 * request.
 *
 * One KeeperRecord per player per season per stint. `teamId` is the team
 * holding the player at the end of the season (after in-season trades),
 * `startTeamId` the team that kept or acquired them going into it, and a
 * status of DROPPED marks a row whose stint ended during that season.
 *
 * Call `recomputeKeeperRecordsForPlayer` any time a player's
 * acquisition/drop/trade history changes (draft, waiver add, drop, trade,
 * import, commissioner correction).
 */

import { prisma } from "./db";
import {
  getContinuousKeeperHistory,
  type KeeperYearInfo,
  type PlayerHistoryEvent,
  type StintStartMethod,
} from "./keeper-engine";
import type { KeeperStatus as PrismaKeeperStatus, Prisma, PrismaClient } from "@prisma/client";

type Db = PrismaClient | Prisma.TransactionClient;

type AcquisitionRow = { playerId: string; method: string; seasonYear: number; teamId: string; cost: number; date: Date; preseason: boolean };
type DropRow = { seasonYear: number; date: Date };

function toEvents(acquisitions: AcquisitionRow[], drops: DropRow[]): PlayerHistoryEvent[] {
  const events: PlayerHistoryEvent[] = [];
  for (const a of acquisitions) {
    if (a.method === "TRADE") {
      events.push({ type: "TRADED", season: a.seasonYear, teamId: a.teamId, date: a.date, preseason: a.preseason });
    } else {
      events.push({ type: "ACQUIRED", season: a.seasonYear, method: a.method as StintStartMethod, cost: a.cost, teamId: a.teamId, date: a.date });
    }
  }
  for (const d of drops) events.push({ type: "DROPPED", season: d.seasonYear, date: d.date });
  return events;
}

export async function getPlayerHistoryEvents(playerId: string, db: Db = prisma): Promise<PlayerHistoryEvent[]> {
  const [acquisitions, drops] = await Promise.all([
    db.acquisition.findMany({ where: { playerId }, orderBy: [{ seasonYear: "asc" }, { date: "asc" }] }),
    db.transaction.findMany({ where: { type: "DROP", players: { some: { playerId } } }, orderBy: [{ seasonYear: "asc" }, { date: "asc" }] }),
  ]);
  return toEvents(acquisitions, drops);
}

function mapStatus(info: KeeperYearInfo): PrismaKeeperStatus {
  if (info.status === "FORCED_BACK") return "FORCED_BACK";
  if (info.droppedThisSeason) return "DROPPED";
  return "KEPT";
}

type RecordRow = {
  seasonId: string;
  seasonYear: number;
  playerId: string;
  teamId: string;
  startTeamId: string;
  keeperYear: number;
  keeperCost: number;
  yearsRemaining: number;
  status: PrismaKeeperStatus;
  stintIndex: number;
};

function rowsForPlayer(playerId: string, events: PlayerHistoryEvent[], throughSeason: number, seasonIdByYear: Map<number, string>, overridden: Set<string>): RecordRow[] {
  const rows: RecordRow[] = [];
  if (events.length === 0) return rows;
  for (const info of getContinuousKeeperHistory(events, throughSeason)) {
    const seasonId = seasonIdByYear.get(info.season);
    if (!seasonId || overridden.has(`${playerId}|${info.season}|${info.stintIndex}`)) continue;
    rows.push({
      seasonId,
      seasonYear: info.season,
      playerId,
      teamId: info.teamId,
      startTeamId: info.teamIdAtStart,
      keeperYear: info.keeperYear,
      keeperCost: info.cost ?? 0,
      yearsRemaining: info.yearsRemaining ?? 0,
      status: mapStatus(info),
      stintIndex: info.stintIndex,
    });
  }
  return rows;
}

/**
 * Rebuilds a player's KeeperRecord rows from their event history. Rows a
 * commissioner has marked as an override are left exactly as they are;
 * everything else is rewritten, so stale rows (e.g. after a drop was
 * recorded) never linger.
 */
export async function recomputeKeeperRecordsForPlayer(playerId: string, throughSeason: number, db: Db = prisma): Promise<void> {
  await rebuildKeeperRecordsBulk([playerId], throughSeason, db);
}

/**
 * Reads every acquisition and drop for the given players in two queries,
 * runs the engine in memory, and rewrites their KeeperRecord rows with a
 * handful of bulk statements - the import path, and the single-player
 * path above.
 */
export async function rebuildKeeperRecordsBulk(playerIds: string[], throughSeason: number, db: Db = prisma): Promise<{ recordsWritten: number }> {
  if (playerIds.length === 0) return { recordsWritten: 0 };

  const [acquisitions, drops, seasons, overrides] = await Promise.all([
    db.acquisition.findMany({ where: { playerId: { in: playerIds } }, orderBy: [{ seasonYear: "asc" }, { date: "asc" }] }),
    db.transaction.findMany({
      where: { type: "DROP", players: { some: { playerId: { in: playerIds } } } },
      include: { players: { select: { playerId: true } } },
      orderBy: [{ seasonYear: "asc" }, { date: "asc" }],
    }),
    db.season.findMany({ select: { id: true, year: true } }),
    db.keeperRecord.findMany({ where: { playerId: { in: playerIds }, commissionerOverride: true }, select: { playerId: true, seasonYear: true, stintIndex: true } }),
  ]);
  const seasonIdByYear = new Map(seasons.map((s) => [s.year, s.id]));
  const overridden = new Set(overrides.map((o) => `${o.playerId}|${o.seasonYear}|${o.stintIndex}`));
  const wanted = new Set(playerIds);

  const acqByPlayer = new Map<string, AcquisitionRow[]>();
  for (const a of acquisitions) {
    if (!acqByPlayer.has(a.playerId)) acqByPlayer.set(a.playerId, []);
    acqByPlayer.get(a.playerId)!.push(a);
  }
  const dropsByPlayer = new Map<string, DropRow[]>();
  for (const d of drops) {
    for (const p of d.players) {
      if (!wanted.has(p.playerId)) continue;
      if (!dropsByPlayer.has(p.playerId)) dropsByPlayer.set(p.playerId, []);
      dropsByPlayer.get(p.playerId)!.push({ seasonYear: d.seasonYear, date: d.date });
    }
  }

  const rows: RecordRow[] = [];
  for (const playerId of playerIds) {
    const events = toEvents(acqByPlayer.get(playerId) ?? [], dropsByPlayer.get(playerId) ?? []);
    rows.push(...rowsForPlayer(playerId, events, throughSeason, seasonIdByYear, overridden));
  }

  await db.keeperRecord.deleteMany({ where: { playerId: { in: playerIds }, commissionerOverride: false } });
  for (let i = 0; i < rows.length; i += 1000) {
    await db.keeperRecord.createMany({ data: rows.slice(i, i + 1000) });
  }
  return { recordsWritten: rows.length };
}

export async function recomputeAllKeeperRecords(throughSeason: number, db: Db = prisma): Promise<void> {
  const players = await db.player.findMany({ select: { id: true } });
  await rebuildKeeperRecordsBulk(
    players.map((p) => p.id),
    throughSeason,
    db
  );
}
