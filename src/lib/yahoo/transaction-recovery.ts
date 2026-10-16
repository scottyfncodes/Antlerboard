/**
 * Recovery for Yahoo transactions synced before detailed ingestion.
 *
 * The first sync (2026-10-14) stored 907 transactions with only a key, a
 * type label and a date: no players, no teams, add/drops recorded as adds,
 * commissioner moves as free-agent adds. Those rows have `yahooType` null.
 * The daily sync deliberately leaves them alone; this is the only path that
 * fills them in, and it has two separate steps:
 *
 *   1. buildRecoveryPlan - the dry run. Re-reads the season's whole log from
 *      Yahoo, and for every legacy row proposes its type, status, date,
 *      FAAB, teams and players with exactly the parse/resolve code the sync
 *      uses. Writes nothing. Each record is `ready`, or says why not.
 *   2. applyRecoveryPlan - the write. Rebuilds the plan from a fresh Yahoo
 *      read, refuses unless its fingerprint equals the one the commissioner
 *      reviewed, then writes only the `ready` records, each in its own
 *      database transaction, through applyTransactionPlan. Re-running it
 *      finds nothing left to do (recovered rows are no longer legacy).
 *
 * Unresolved, ambiguous, unsupported or missing records are reported and
 * never written. Nothing is deleted; nothing is moved between seasons.
 */

import { createHash } from "crypto";
import { prisma } from "@/lib/db";
import {
  applyTransactionPlan,
  diffTransaction,
  fetchLeagueTransactions,
  loadResolveContext,
  parseYahooTransaction,
  rememberCreatedPlayers,
  resolveTransaction,
  transactionKeyOf,
  type TransactionPlan,
  type YahooGet,
} from "./transactions";

/** The literal an apply request must carry, so it can't be sent by accident. */
export const APPLY_CONFIRMATION = "APPLY_YAHOO_TRANSACTION_RECOVERY";

export type RecoveryStatus =
  /** Fully resolved; the apply step would write it. */
  | "ready"
  /** Read from Yahoo, but a team or player couldn't be matched, or Yahoo's own record is incomplete. */
  | "unresolved"
  /** Yahoo's type (or an add's source) can't be mapped - left as is. */
  | "unsupported"
  /** Yahoo's entry couldn't be read. */
  | "malformed"
  /** Yahoo's complete log doesn't contain this key. */
  | "missing_in_yahoo"
  /** The log wasn't read to the end, so this key's absence proves nothing. */
  | "not_checked";

export interface RecoveryRecord {
  yahooTransactionId: string;
  status: RecoveryStatus;
  current: { type: string; date: string; notes: string | null; seasonYear: number };
  /** What would be written. Null unless Yahoo's entry could be parsed. */
  proposed: {
    type: string;
    yahooType: string;
    yahooStatus: string | null;
    date: string | null;
    dateUnavailable: boolean;
    faabBid: number | null;
    teams: { teamId: string; teamName: string | null; role: string }[];
    players: {
      name: string;
      yahooPlayerKey: string | null;
      yahooPlayerId: string;
      playerId: string | null;
      /** True when no Antlerboard player has this Yahoo id and one would be created. */
      createsPlayer: boolean;
      action: string;
      from: string | null;
      to: string | null;
    }[];
  } | null;
  issues: string[];
}

export interface RecoveryReport {
  mode: "dry-run";
  leagueKey: string;
  seasonYear: number;
  generatedAt: string;
  yahoo: { pages: number; transactionsRead: number; entriesWithoutKey: number; complete: boolean; incompleteReason: string | null };
  /** Rows recovery is for: Yahoo-synced, in this season, with no detail yet. */
  targets: number;
  summary: Record<RecoveryStatus, number>;
  proposedTypes: Record<string, number>;
  /** Yahoo players with no Antlerboard player; applying creates them, Yahoo-linked. */
  playersToCreate: { yahooPlayerId: string; name: string }[];
  /** Keys in Yahoo's log that Antlerboard doesn't store at all - the daily sync adds them, not recovery. */
  onlyInYahoo: string[];
  /** Hash of the ready records' proposals; the apply step must be given this exact value. */
  fingerprint: string;
  records: RecoveryRecord[];
}

export interface RecoveryInput {
  leagueId: string;
  leagueKey: string;
  seasonYear: number;
  get: YahooGet;
  delayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

interface BuiltPlan {
  report: RecoveryReport;
  plans: Map<string, TransactionPlan>;
}

function emptySummary(): Record<RecoveryStatus, number> {
  return { ready: 0, unresolved: 0, unsupported: 0, malformed: 0, missing_in_yahoo: 0, not_checked: 0 };
}

function fingerprintOf(records: RecoveryRecord[]): string {
  const ready = records.filter((r) => r.status === "ready").map((r) => ({ id: r.yahooTransactionId, proposed: r.proposed }));
  return createHash("sha256").update(JSON.stringify(ready)).digest("hex");
}

async function build(input: RecoveryInput): Promise<BuiltPlan> {
  const { leagueId, leagueKey, seasonYear } = input;
  const season = await prisma.season.findUnique({ where: { leagueId_year: { leagueId, year: seasonYear } } });
  if (!season) throw new RecoveryRefused(`No ${seasonYear} season exists in Antlerboard.`);

  const targets = await prisma.transaction.findMany({
    where: { seasonId: season.id, yahooType: null, yahooTransactionId: { startsWith: `${leagueKey}.tr.` } },
    include: { players: true, teams: true },
    orderBy: { date: "asc" },
  });

  const fetched = await fetchLeagueTransactions(input.get, leagueKey, { delayMs: input.delayMs, sleep: input.sleep });
  const yahooSeason = Number(fetched.leagueMeta.season);
  if (yahooSeason !== seasonYear) {
    throw new RecoveryRefused(`Yahoo league ${leagueKey} reports season ${String(fetched.leagueMeta.season ?? "(none)")}, not ${seasonYear}. Nothing was compared.`);
  }

  const ctx = await loadResolveContext(prisma, leagueId, season);
  const teamNames = new Map((await prisma.team.findMany({ where: { leagueId }, select: { id: true, name: true } })).map((t) => [t.id, t.name]));
  const rawByKey = new Map<string, unknown>();
  for (const e of fetched.entries) rawByKey.set(transactionKeyOf(e)!, e);

  const records: RecoveryRecord[] = [];
  const plans = new Map<string, TransactionPlan>();
  const proposedTypes: Record<string, number> = {};
  const toCreate = new Map<string, string>();

  for (const row of targets) {
    const key = row.yahooTransactionId!;
    const current = { type: row.type, date: row.date.toISOString(), notes: row.notes, seasonYear: row.seasonYear };
    const raw = rawByKey.get(key);
    if (raw === undefined) {
      records.push({
        yahooTransactionId: key,
        status: fetched.complete ? "missing_in_yahoo" : "not_checked",
        current,
        proposed: null,
        issues: [fetched.complete ? "Not in Yahoo's transaction log." : `Yahoo's log wasn't read to the end (${fetched.incompleteReason}).`],
      });
      continue;
    }
    const parsed = parseYahooTransaction(raw);
    if (!parsed.ok) {
      records.push({ yahooTransactionId: key, status: parsed.kind === "unsupported" ? "unsupported" : "malformed", current, proposed: null, issues: [parsed.reason] });
      continue;
    }
    const plan = resolveTransaction(ctx, parsed.tx);
    const diff = diffTransaction(row, plan, { allowLegacy: true });
    const issues = diff.issues;
    const status: RecoveryStatus = diff.outcome === "season_conflict" || issues.length > 0 ? "unresolved" : "ready";
    if (status === "ready") plans.set(key, plan);
    proposedTypes[plan.type] = (proposedTypes[plan.type] ?? 0) + 1;
    for (const p of plan.players) if (p.createPlayer) toCreate.set(p.canonicalId, p.name);

    records.push({
      yahooTransactionId: key,
      status,
      current,
      proposed: {
        type: plan.type,
        yahooType: plan.yahooType,
        yahooStatus: plan.status,
        date: plan.date,
        dateUnavailable: plan.date === null,
        faabBid: plan.faabBid,
        teams: plan.teams.map((t) => ({ ...t, teamName: teamNames.get(t.teamId) ?? null })),
        players: plan.players.map((p) => ({
          name: p.name,
          yahooPlayerKey: p.yahooPlayerKey,
          yahooPlayerId: p.canonicalId,
          playerId: p.playerId,
          createsPlayer: p.createPlayer,
          action: p.action,
          from: p.sourceTeamId ? (teamNames.get(p.sourceTeamId) ?? p.sourceTeamId) : p.sourceType,
          to: p.destinationTeamId ? (teamNames.get(p.destinationTeamId) ?? p.destinationTeamId) : p.destinationType,
        })),
      },
      issues,
    });
  }

  const stored = new Set((await prisma.transaction.findMany({ where: { yahooTransactionId: { startsWith: `${leagueKey}.tr.` } }, select: { yahooTransactionId: true } })).map((r) => r.yahooTransactionId!));
  const onlyInYahoo = [...rawByKey.keys()].filter((k) => !stored.has(k));

  const summary = emptySummary();
  for (const r of records) summary[r.status]++;

  return {
    plans,
    report: {
      mode: "dry-run",
      leagueKey,
      seasonYear,
      generatedAt: new Date().toISOString(),
      yahoo: { pages: fetched.pages, transactionsRead: fetched.entries.length, entriesWithoutKey: fetched.entriesWithoutKey, complete: fetched.complete, incompleteReason: fetched.incompleteReason },
      targets: targets.length,
      summary,
      proposedTypes,
      playersToCreate: [...toCreate].map(([yahooPlayerId, name]) => ({ yahooPlayerId, name })),
      onlyInYahoo,
      fingerprint: fingerprintOf(records),
      records,
    },
  };
}

/** The recovery can't run as asked; nothing was read or written past the point named. */
export class RecoveryRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecoveryRefused";
  }
}

/** The dry run. Reads Yahoo and the database; writes nothing. */
export async function buildRecoveryPlan(input: RecoveryInput): Promise<RecoveryReport> {
  return (await build(input)).report;
}

export interface RecoveryApplyResult {
  mode: "apply";
  leagueKey: string;
  seasonYear: number;
  fingerprint: string;
  written: number;
  playersCreated: number;
  /** Records skipped because they were no longer legacy or changed under us. */
  skipped: { yahooTransactionId: string; reason: string }[];
  failed: { yahooTransactionId: string; error: string }[];
  /** Records the dry run didn't mark ready - untouched. */
  notReady: Record<Exclude<RecoveryStatus, "ready">, number>;
}

/**
 * The write. Rebuilds the plan from a fresh Yahoo read; if anything a
 * `ready` record would write differs from what the commissioner reviewed
 * (`expectedFingerprint`), it refuses and writes nothing. Otherwise each
 * ready record is written in its own database transaction.
 */
export async function applyRecoveryPlan(input: RecoveryInput & { expectedFingerprint: string; actorName: string }): Promise<RecoveryApplyResult> {
  const { report, plans } = await build(input);
  if (report.fingerprint !== input.expectedFingerprint) {
    throw new RecoveryRefused(
      "The recovery plan has changed since the dry run you reviewed (Yahoo or Antlerboard data moved). Nothing was written - run the dry run again and review it."
    );
  }
  if (!report.yahoo.complete) {
    throw new RecoveryRefused(`Yahoo's log wasn't read to the end (${report.yahoo.incompleteReason}). Nothing was written - try again later.`);
  }

  const season = await prisma.season.findUniqueOrThrow({ where: { leagueId_year: { leagueId: input.leagueId, year: input.seasonYear } } });
  const ctx = await loadResolveContext(prisma, input.leagueId, season);
  const result: RecoveryApplyResult = {
    mode: "apply",
    leagueKey: input.leagueKey,
    seasonYear: input.seasonYear,
    fingerprint: report.fingerprint,
    written: 0,
    playersCreated: 0,
    skipped: [],
    failed: [],
    notReady: { unresolved: 0, unsupported: 0, malformed: 0, missing_in_yahoo: 0, not_checked: 0 },
  };
  for (const r of report.records) if (r.status !== "ready") result.notReady[r.status]++;

  for (const [key, reviewed] of plans) {
    try {
      const outcome = await prisma.$transaction(async (tx) => {
        const row = await tx.transaction.findUnique({ where: { yahooTransactionId: key }, select: { yahooType: true } });
        if (!row || row.yahooType !== null) return { skip: "No longer a legacy row - already recovered or synced." };
        // Re-resolve against players created earlier in this run so one
        // Yahoo player never becomes two Antlerboard players.
        const plan: TransactionPlan = {
          ...reviewed,
          players: reviewed.players.map((p) => {
            const known = p.createPlayer ? ctx.playersByYahooId.get(p.canonicalId) : undefined;
            return known?.length === 1 ? { ...p, playerId: known[0], createPlayer: false } : p;
          }),
        };
        return { applied: await applyTransactionPlan(tx, input.leagueId, plan, { allowLegacy: true }) };
      });
      if ("skip" in outcome) {
        result.skipped.push({ yahooTransactionId: key, reason: outcome.skip! });
        continue;
      }
      rememberCreatedPlayers(ctx, outcome.applied.createdPlayers);
      result.playersCreated += outcome.applied.createdPlayers.length;
      result.written++;
    } catch (err) {
      result.failed.push({ yahooTransactionId: key, error: err instanceof Error ? err.message : "Unknown error" });
    }
  }

  await prisma.auditLogEntry.create({
    data: {
      actorName: input.actorName,
      action: "YAHOO_TRANSACTION_RECOVERY",
      entityType: "Transaction",
      isHistoricalCorrection: true,
      before: { leagueKey: input.leagueKey, seasonYear: input.seasonYear, targets: report.targets, summary: report.summary },
      after: {
        fingerprint: report.fingerprint,
        written: result.written,
        playersCreated: result.playersCreated,
        skipped: result.skipped.length,
        failed: result.failed.length,
        notReady: result.notReady,
      },
    },
  });
  return result;
}
