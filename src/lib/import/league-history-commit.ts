/**
 * Writes a reviewed league-history preview (see league-history-builder.ts)
 * to the database. Every row this import creates carries a sourceRef
 * starting with SOURCE_PREFIX, so a re-run first removes its own previous
 * rows and never touches anything a commissioner entered by hand.
 *
 * Before writing anything it re-checks the preview against the database
 * as it is now (see checkLeagueHistoryAgainstDb): a Yahoo id stored on two
 * players, or any overlap with transactions the Yahoo sync already
 * recorded, throws LeagueHistoryConflictError and nothing is written.
 *
 * Writes, in order: managers/teams for any franchise that doesn't exist
 * yet, seasons, players (see player-identity.ts - an existing player's
 * Yahoo id is never changed), acquisitions
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
import { canonicalYahooPlayerId } from "../yahoo/player-id";
import { planPlayerIdentities, reviewNotes, type IdentityPlan, type IdentityReviewItem } from "./player-identity";
import { findTransactionConflicts, type SyncedTransactionState } from "./league-history-conflicts";
import { tagRef, type PriceProvenance } from "./provenance";

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

export class LeagueHistoryConflictError extends Error {
  constructor(readonly conflicts: string[]) {
    super(`Import stopped before writing anything: ${conflicts.join(" ")}`);
    this.name = "LeagueHistoryConflictError";
  }
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
  playersMatchedByYahooId: number;
  playersMatchedByName: number;
  /** Players kept separate because their identity couldn't be established confidently. */
  identityReview: IdentityReviewItem[];
}

export interface DbCheck {
  plan: IdentityPlan;
  synced: SyncedTransactionState;
  conflicts: string[];
}

/** Synced (Yahoo) transaction keys and seasons for this league. */
export async function loadSyncedTransactionState(db: Db, leagueId: string): Promise<SyncedTransactionState> {
  const rows = await db.transaction.findMany({
    where: { yahooTransactionId: { not: null }, season: { leagueId } },
    select: { yahooTransactionId: true, seasonYear: true },
  });
  return {
    yahooTransactionIds: rows.map((r) => r.yahooTransactionId!),
    seasons: [...new Set(rows.map((r) => r.seasonYear))].sort((a, b) => a - b),
  };
}

/**
 * Read-only: every decision and conflict the commit would hit, against the
 * database as it is now. The preview shows it; the commit re-runs it inside
 * its transaction and refuses to write on any conflict.
 */
export async function checkLeagueHistoryAgainstDb(db: Db, leagueId: string, preview: Pick<LeagueHistoryPreview, "players" | "events">): Promise<DbCheck> {
  const [existing, synced] = await Promise.all([
    db.player.findMany({ where: { leagueId }, select: { id: true, yahooPlayerId: true, name: true, positions: true, notes: true } }),
    loadSyncedTransactionState(db, leagueId),
  ]);
  const plan = planPlayerIdentities(preview.players, existing);
  return { plan, synced, conflicts: [...plan.conflicts, ...findTransactionConflicts(preview.events, synced)] };
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
    playersMatchedByYahooId: 0,
    playersMatchedByName: 0,
    identityReview: [],
  };

  // --- refuse before writing anything ---------------------------------------
  const { plan, conflicts } = await checkLeagueHistoryAgainstDb(db, leagueId, preview);
  if (conflicts.length > 0) throw new LeagueHistoryConflictError(conflicts);

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
  // Decided by planPlayerIdentities above. Matched players are used as they
  // are - their Yahoo id (the sync's full "469.p.N" key) is never rewritten,
  // which is what lets the next roster sync keep finding them. New players
  // store the canonical bare id, which the sync also matches.
  const playerIdByKey = new Map<string, string>();
  const toCreate: { id: string; leagueId: string; yahooPlayerId: string | null; name: string; mlbTeam: string | null; positions: string[]; notes: string | null }[] = [];
  const reviewByKey = new Map(plan.review.map((r) => [r.importKey, r]));
  for (const p of preview.players) {
    const decision = plan.decisions.get(p.key);
    if (decision?.kind === "existing") {
      playerIdByKey.set(p.key, decision.playerId);
      result.playersMatched++;
      continue;
    }
    const id = randomUUID();
    const review = reviewByKey.get(p.key);
    toCreate.push({
      id,
      leagueId,
      yahooPlayerId: canonicalYahooPlayerId(p.yahooPlayerId),
      name: p.name,
      mlbTeam: p.mlbTeam,
      positions: p.positions,
      notes: review ? reviewNotes(review) : null,
    });
    playerIdByKey.set(p.key, id);
  }
  for (let i = 0; i < toCreate.length; i += 1000) {
    await db.player.createMany({ data: toCreate.slice(i, i + 1000) });
  }
  result.playersCreated = toCreate.length;
  result.playersMatchedByYahooId = plan.counts.byYahooId;
  result.playersMatchedByName = plan.counts.byName;
  result.identityReview = plan.review;

  // --- events -> acquisitions and drops ------------------------------------
  const acquisitions: (Prisma.AcquisitionCreateManyInput & { id: string })[] = [];
  const acquisitionTags = new Map<string, { raw: string; price?: PriceProvenance; keeperRecorded: number[] }>();
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
    const id = randomUUID();
    acquisitionTags.set(id, { raw: sourceRef, price: e.kind === "TRADED" ? undefined : e.priceStatus, keeperRecorded: [] });
    acquisitions.push({
      id,
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

  // Seasons where the workbook's recorded keeper cost equals what the engine
  // computes are recorded costs, even when the stint's origin price was
  // inferred - noted on that origin acquisition (the latest non-trade
  // acquisition before the season) so readers can tell. Mismatches become
  // overrides below instead.
  for (const check of preview.keeperChecks) {
    if (check.status !== "match" || !check.playerKey || check.recordedCost === null) continue;
    const playerId = playerIdByKey.get(check.playerKey);
    const origin = acquisitions
      .filter((a) => a.playerId === playerId && a.method !== "TRADE" && a.seasonYear < check.season)
      .sort((a, b) => a.seasonYear - b.seasonYear || new Date(a.date!).getTime() - new Date(b.date!).getTime())
      .pop();
    if (origin) acquisitionTags.get(origin.id)!.keeperRecorded.push(check.season);
  }
  for (const a of acquisitions) {
    const t = acquisitionTags.get(a.id)!;
    a.sourceRef = tagRef(t.raw, { price: t.price, keeperRecorded: t.keeperRecorded });
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
      sourceRef: tagRef(`${SOURCE_PREFIX}${d.sourceRef}`, { order: d.order }),
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
