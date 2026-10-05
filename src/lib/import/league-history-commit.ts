/**
 * Writes a reviewed league-history preview (see league-history-builder.ts)
 * to the database. Every row this import creates carries a sourceRef
 * starting with SOURCE_PREFIX, so a re-run first removes its own previous
 * rows and never touches anything a commissioner entered by hand.
 *
 * Writes, in order: managers/teams for any franchise that doesn't exist
 * yet, seasons, players (matched by Yahoo id, then by name), acquisitions
 * (ACQUIRED and TRADED events), DROP transactions, draft picks, then a
 * bulk rebuild of KeeperRecord rows for every player touched. Finally,
 * where the workbook's recorded keeper cost disagrees with the computed
 * one, the recorded cost is kept as a flagged commissioner override - the
 * app should show what the league actually charged, and the engine owns
 * every projection from here forward.
 */

import { randomUUID } from "crypto";
import type { Prisma } from "@prisma/client";
import { rebuildKeeperRecordsBulk } from "../keeper-sync";
import type { FranchiseResolver } from "./team-aliases";
import type { LeagueHistoryPreview } from "./league-history-builder";

type Db = Prisma.TransactionClient;

export const SOURCE_PREFIX = "league-history:";

export interface CommitOptions {
  currentSeason: number;
  /** Keep the workbook's recorded keeper cost (as a flagged override) where it disagrees with the engine. */
  applyRecordedKeeperCosts: boolean;
  actorName: string | null;
  /** Used to backfill team ids on previously imported HistoricalTrade rows. */
  resolver?: FranchiseResolver;
}

export interface CommitResult {
  managersCreated: number;
  teamsCreated: number;
  playersCreated: number;
  playersMatched: number;
  acquisitionsWritten: number;
  dropsWritten: number;
  draftPicksWritten: number;
  keeperRecordsWritten: number;
  overridesApplied: number;
  historicalTradesResolved: number;
  previousImportRowsRemoved: number;
}

export async function commitLeagueHistory(db: Db, leagueId: string, preview: LeagueHistoryPreview, options: CommitOptions): Promise<CommitResult> {
  const result: CommitResult = {
    managersCreated: 0,
    teamsCreated: 0,
    playersCreated: 0,
    playersMatched: 0,
    acquisitionsWritten: 0,
    dropsWritten: 0,
    draftPicksWritten: 0,
    keeperRecordsWritten: 0,
    overridesApplied: 0,
    historicalTradesResolved: 0,
    previousImportRowsRemoved: 0,
  };

  // --- remove this import's previous rows (re-run safety) -----------------
  const prevTx = await db.transaction.findMany({ where: { sourceRef: { startsWith: SOURCE_PREFIX } }, select: { id: true } });
  if (prevTx.length > 0) {
    const ids = prevTx.map((t) => t.id);
    await db.transactionPlayer.deleteMany({ where: { transactionId: { in: ids } } });
    await db.transactionTeam.deleteMany({ where: { transactionId: { in: ids } } });
    await db.transaction.deleteMany({ where: { id: { in: ids } } });
  }
  const prevAcq = await db.acquisition.deleteMany({ where: { sourceRef: { startsWith: SOURCE_PREFIX } } });
  const prevPicks = await db.draftPick.deleteMany({ where: { sourceRef: { startsWith: SOURCE_PREFIX } } });
  result.previousImportRowsRemoved = prevTx.length + prevAcq.count + prevPicks.count;

  // --- franchises -> teams -------------------------------------------------
  const franchises = new Set<string>();
  for (const e of preview.events) if (e.franchise) franchises.add(e.franchise);
  for (const d of preview.draftPicks) franchises.add(d.franchise);
  const teamIdByFranchise = new Map<string, string>();
  for (const franchise of franchises) {
    let manager = await db.manager.findFirst({ where: { leagueId, name: franchise } });
    if (!manager) {
      manager = await db.manager.create({ data: { leagueId, name: franchise, active: true } });
      result.managersCreated++;
    }
    let team = await db.team.findFirst({ where: { leagueId, managerId: manager.id }, orderBy: { active: "desc" } });
    if (!team) {
      team = await db.team.create({ data: { leagueId, name: `${franchise}'s Team`, managerId: manager.id } });
      result.teamsCreated++;
    }
    teamIdByFranchise.set(franchise, team.id);
  }

  // --- seasons -------------------------------------------------------------
  // Every season from the earliest event through the current one, so a
  // keeper year with no event of its own (pure continuity) still has a
  // Season row for its KeeperRecord and any override.
  const eventYears = [...preview.events.map((e) => e.season), ...preview.draftPicks.map((d) => d.season)];
  const seasonYears = new Set<number>();
  if (eventYears.length > 0) {
    for (let y = Math.min(...eventYears); y <= Math.max(options.currentSeason, ...eventYears); y++) seasonYears.add(y);
  }
  const seasonIdByYear = new Map<number, string>();
  for (const year of seasonYears) {
    const season = await db.season.upsert({
      where: { leagueId_year: { leagueId, year } },
      create: { leagueId, year, status: year >= options.currentSeason ? "IN_PROGRESS" : "COMPLETE" },
      update: {},
    });
    seasonIdByYear.set(year, season.id);
  }

  // --- players -------------------------------------------------------------
  const playerIdByKey = new Map<string, string>();
  const existingByYahoo = new Map(
    (await db.player.findMany({ where: { leagueId, yahooPlayerId: { not: null } }, select: { id: true, yahooPlayerId: true } })).map((p) => [p.yahooPlayerId!, p.id])
  );
  const existingByName = new Map<string, string>();
  for (const p of await db.player.findMany({ where: { leagueId }, select: { id: true, name: true } })) {
    existingByName.set(p.name.toLowerCase(), p.id);
  }
  const toCreate: { id: string; leagueId: string; yahooPlayerId: string | null; name: string; mlbTeam: string | null; positions: string[] }[] = [];
  const claimedByYahoo = new Set<string>(); // existing rows already matched to a Yahoo id this run
  for (const p of preview.players) {
    // A player with a Yahoo id matches an existing row by that id, or by
    // name only when the existing row has no Yahoo id yet (a hand-entered
    // player being linked up). Two distinct Yahoo players who share a name
    // (there are a few) must never collapse into one row.
    const byYahoo = p.yahooPlayerId ? existingByYahoo.get(p.yahooPlayerId) : undefined;
    const byName = existingByName.get(p.name.toLowerCase());
    const existingId = byYahoo ?? (byName && !claimedByYahoo.has(byName) ? byName : undefined);
    if (existingId) {
      playerIdByKey.set(p.key, existingId);
      result.playersMatched++;
      if (p.yahooPlayerId && !byYahoo) {
        claimedByYahoo.add(existingId);
        await db.player.update({ where: { id: existingId }, data: { yahooPlayerId: p.yahooPlayerId } }).catch(() => undefined);
      }
      continue;
    }
    const id = randomUUID();
    toCreate.push({ id, leagueId, yahooPlayerId: p.yahooPlayerId, name: p.name, mlbTeam: p.mlbTeam, positions: p.positions });
    playerIdByKey.set(p.key, id);
    if (p.yahooPlayerId) claimedByYahoo.add(id);
    if (!existingByName.has(p.name.toLowerCase())) existingByName.set(p.name.toLowerCase(), id);
  }
  for (let i = 0; i < toCreate.length; i += 1000) {
    await db.player.createMany({ data: toCreate.slice(i, i + 1000) });
  }
  result.playersCreated = toCreate.length;

  // --- events -> acquisitions and drops ------------------------------------
  const acquisitions: Prisma.AcquisitionCreateManyInput[] = [];
  const transactions: Prisma.TransactionCreateManyInput[] = [];
  const transactionPlayers: Prisma.TransactionPlayerCreateManyInput[] = [];
  const transactionTeams: Prisma.TransactionTeamCreateManyInput[] = [];

  for (const e of preview.events) {
    const playerId = playerIdByKey.get(e.playerKey);
    const seasonId = seasonIdByYear.get(e.season);
    if (!playerId || !seasonId) continue;
    const notes = e.flags.length > 0 ? e.flags.join(" ") : null;
    const sourceRef = `${SOURCE_PREFIX}${e.sourceRef}`;
    if (e.kind === "DROPPED") {
      const teamId = teamIdByFranchise.get(e.franchise);
      const id = randomUUID();
      transactions.push({ id, seasonId, seasonYear: e.season, type: "DROP", date: new Date(e.date), notes, sourceRef, isHistoricalCorrection: false });
      transactionPlayers.push({ transactionId: id, playerId });
      if (teamId) transactionTeams.push({ transactionId: id, teamId, role: "FROM" });
      continue;
    }
    const teamId = teamIdByFranchise.get(e.franchise);
    if (!teamId) continue;
    acquisitions.push({
      seasonId,
      seasonYear: e.season,
      playerId,
      teamId,
      method: e.kind === "TRADED" ? "TRADE" : e.method ?? "WAIVER",
      cost: e.kind === "TRADED" ? 0 : e.cost ?? 0,
      preseason: e.kind === "TRADED" && !!e.preseason,
      date: new Date(e.date),
      notes,
      sourceRef,
    });
  }
  for (let i = 0; i < acquisitions.length; i += 1000) await db.acquisition.createMany({ data: acquisitions.slice(i, i + 1000) });
  for (let i = 0; i < transactions.length; i += 1000) await db.transaction.createMany({ data: transactions.slice(i, i + 1000) });
  for (let i = 0; i < transactionPlayers.length; i += 1000) await db.transactionPlayer.createMany({ data: transactionPlayers.slice(i, i + 1000) });
  for (let i = 0; i < transactionTeams.length; i += 1000) await db.transactionTeam.createMany({ data: transactionTeams.slice(i, i + 1000) });
  result.acquisitionsWritten = acquisitions.length;
  result.dropsWritten = transactions.length;

  // --- draft picks ---------------------------------------------------------
  const picks: Prisma.DraftPickCreateManyInput[] = [];
  for (const d of preview.draftPicks) {
    const playerId = playerIdByKey.get(d.playerKey);
    const seasonId = seasonIdByYear.get(d.season);
    const teamId = teamIdByFranchise.get(d.franchise);
    if (!playerId || !seasonId || !teamId) continue;
    picks.push({
      seasonId,
      seasonYear: d.season,
      round: 1,
      pick: d.overallPick,
      overallPick: d.overallPick,
      teamId,
      playerId,
      cost: d.cost,
      acquisitionType: "DRAFT",
      sourceRef: `${SOURCE_PREFIX}${d.sourceRef}`,
    });
  }
  for (let i = 0; i < picks.length; i += 1000) {
    const batch = await db.draftPick.createMany({ data: picks.slice(i, i + 1000), skipDuplicates: true });
    result.draftPicksWritten += batch.count;
  }

  // --- keeper records -------------------------------------------------------
  const touched = [...new Set(playerIdByKey.values())];
  // A run re-derives every keeper record for the players it covers, so
  // overrides from an earlier run (or hand edits made before the final
  // import) are cleared here and re-applied below from the workbook when
  // asked. Per-season hand corrections belong after the last import.
  await db.keeperRecord.deleteMany({ where: { playerId: { in: touched }, commissionerOverride: true } });
  const rebuilt = await rebuildKeeperRecordsBulk(touched, options.currentSeason, db);
  result.keeperRecordsWritten = rebuilt.recordsWritten;

  if (options.applyRecordedKeeperCosts) {
    for (const check of preview.keeperChecks) {
      if (check.status !== "mismatch" || !check.playerKey || check.recordedCost === null) continue;
      const playerId = playerIdByKey.get(check.playerKey);
      const seasonId = seasonIdByYear.get(check.season);
      if (!playerId || !seasonId) continue;
      // Only the keeper-year row for that season - a later same-season
      // stint (dropped and re-added) is a fresh acquisition, not a keeper.
      const updated = await db.keeperRecord.updateMany({
        where: { seasonId, playerId, keeperYear: { gte: 1 } },
        data: { keeperCost: check.recordedCost, commissionerOverride: true },
      });
      result.overridesApplied += updated.count;
    }
  }

  // --- backfill team ids on the trade log imported earlier -----------------
  if (options.resolver) {
    const trades = await db.historicalTrade.findMany({ where: { leagueId, OR: [{ teamAId: null }, { teamBId: null }] } });
    for (const t of trades) {
      const a = options.resolver.resolve(t.teamAName)?.managerSheetName;
      const b = options.resolver.resolve(t.teamBName)?.managerSheetName;
      const teamAId = a ? teamIdByFranchise.get(a) ?? null : null;
      const teamBId = b ? teamIdByFranchise.get(b) ?? null : null;
      if (teamAId || teamBId) {
        await db.historicalTrade.update({ where: { id: t.id }, data: { teamAId: t.teamAId ?? teamAId, teamBId: t.teamBId ?? teamBId } });
        result.historicalTradesResolved++;
      }
    }
  }

  await db.league.updateMany({ where: { id: leagueId, currentSeasonYear: null }, data: { currentSeasonYear: options.currentSeason } });

  await db.auditLogEntry.create({
    data: {
      actorName: options.actorName ?? "Unknown",
      action: "LEAGUE_HISTORY_IMPORT",
      entityType: "League",
      entityId: leagueId,
      isHistoricalCorrection: false,
      after: { ...result, summary: preview.summary } as unknown as Prisma.InputJsonValue,
    },
  });

  return result;
}
