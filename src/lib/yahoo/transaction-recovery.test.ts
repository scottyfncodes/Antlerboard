import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { prisma } from "@/lib/db";
import { makeLeagueWithSeason, resetDatabase } from "@/lib/test-helpers";
import { applyRecoveryPlan, buildRecoveryPlan, RecoveryRefused } from "./transaction-recovery";
import { syncLeagueTransactions } from "./transactions";
import { LK, teamKey, txKey, yPlayer, yTx, meta, pagedYahoo, freeAgentAdd, waiverAdd, dropTo, tradeMove } from "./yahoo-transaction-fixtures";

beforeEach(resetDatabase);
afterAll(resetDatabase);

/**
 * Production's situation in miniature: rows the first sync stored with only a
 * key, a type label and a date (yahooType null, no links), next to a Yahoo
 * that has the full records.
 */
async function legacyLeague() {
  const { league, season } = await makeLeagueWithSeason(2026);
  const team = async (n: number, name: string) => {
    const m = await prisma.manager.create({ data: { leagueId: league.id, name: `M${n}` } });
    return prisma.team.create({ data: { leagueId: league.id, name, managerId: m.id, yahooTeamId: teamKey(n) } });
  };
  const t1 = await team(1, "Ranger Thingz");
  const t2 = await team(2, "Dallas Eagles");
  const judge = await prisma.player.create({ data: { leagueId: league.id, name: "Aaron Judge", yahooPlayerId: "469.p.100", positions: ["OF"] } });
  const legacy = async (n: number, type: "FREE_AGENT_ADD" | "DROP" | "TRADE", label: string) =>
    prisma.transaction.create({
      data: { seasonId: season.id, seasonYear: 2026, type, yahooTransactionId: txKey(n), notes: `Synced from Yahoo (${label})`, date: new Date((1_774_000_000 + n * 60) * 1000) },
    });
  await legacy(2, "FREE_AGENT_ADD", "commish");
  await legacy(3, "FREE_AGENT_ADD", "add/drop");
  await legacy(4, "DROP", "drop");
  await legacy(5, "TRADE", "trade");
  await legacy(6, "FREE_AGENT_ADD", "add"); // its team isn't linked in Antlerboard
  await legacy(7, "DROP", "drop"); // not in Yahoo's log
  await legacy(10, "FREE_AGENT_ADD", "add"); // a second add of the same new player as #3's drop

  const yahoo = [
    yTx(meta(2, "commish")),
    yTx(meta(3, "add/drop", { faab_bid: "4" }), [yPlayer(100, "Aaron Judge", waiverAdd(1)), yPlayer(555, "New Guy", dropTo(1))]),
    yTx(meta(4, "drop"), [yPlayer(100, "Aaron Judge", dropTo(1))]),
    yTx(meta(5, "trade", { trader_team_key: teamKey(1), tradee_team_key: teamKey(2) }), [yPlayer(100, "Aaron Judge", tradeMove(2, 1)), yPlayer(555, "New Guy", tradeMove(1, 2))]),
    yTx(meta(6, "add"), [yPlayer(100, "Aaron Judge", freeAgentAdd(9))]),
    yTx(meta(9, "drop"), [yPlayer(100, "Aaron Judge", dropTo(1))]), // in Yahoo, not stored at all
    yTx(meta(10, "add"), [yPlayer(555, "New Guy", freeAgentAdd(2))]),
  ];
  return { league, season, t1, t2, judge, yahoo };
}

const input = (leagueId: string, entries: unknown[], opts: Parameters<typeof pagedYahoo>[1] = {}) => ({ leagueId, leagueKey: LK, seasonYear: 2026, get: pagedYahoo(entries, opts).get });

async function snapshot() {
  return {
    transactions: await prisma.transaction.findMany({ orderBy: { yahooTransactionId: "asc" }, include: { players: true, teams: true } }),
    players: await prisma.player.findMany({ orderBy: { name: "asc" } }),
    audit: await prisma.auditLogEntry.count(),
  };
}

describe("buildRecoveryPlan (dry run)", () => {
  it("proposes each legacy record's type, teams and players, and writes nothing", async () => {
    const { league, t1, t2, judge, yahoo } = await legacyLeague();
    const before = await snapshot();

    const report = await buildRecoveryPlan(input(league.id, yahoo));

    expect(await snapshot()).toEqual(before);
    expect(report).toMatchObject({ mode: "dry-run", targets: 7, yahoo: { transactionsRead: 7, complete: true } });
    expect(report.summary).toEqual({ ready: 5, unresolved: 1, unsupported: 0, malformed: 0, missing_in_yahoo: 1, not_checked: 0 });
    expect(report.proposedTypes).toEqual({ COMMISSIONER_MOVE: 1, WAIVER_ADD: 1, DROP: 1, TRADE: 1, FREE_AGENT_ADD: 2 });
    expect(report.onlyInYahoo).toEqual([txKey(9)]);
    expect(report.playersToCreate).toEqual([{ yahooPlayerId: "555", name: "New Guy" }]);
    expect(report.fingerprint).toMatch(/^[0-9a-f]{64}$/);

    const byKey = new Map(report.records.map((r) => [r.yahooTransactionId, r]));
    const addDrop = byKey.get(txKey(3))!;
    expect(addDrop).toMatchObject({ status: "ready", current: { type: "FREE_AGENT_ADD", notes: "Synced from Yahoo (add/drop)" }, proposed: { type: "WAIVER_ADD", yahooType: "add/drop", faabBid: 4, dateUnavailable: false } });
    expect(addDrop.proposed!.players).toEqual([
      { name: "Aaron Judge", yahooPlayerKey: "469.p.100", yahooPlayerId: "100", playerId: judge.id, createsPlayer: false, action: "add", from: "waivers", to: "Ranger Thingz" },
      { name: "New Guy", yahooPlayerKey: "469.p.555", yahooPlayerId: "555", playerId: null, createsPlayer: true, action: "drop", from: "Ranger Thingz", to: "waivers" },
    ]);
    expect(byKey.get(txKey(5))!.proposed!.teams.map((t) => t.teamId).sort()).toEqual([t1.id, t1.id, t2.id, t2.id].sort());
    expect(byKey.get(txKey(2))!.proposed).toMatchObject({ type: "COMMISSIONER_MOVE", players: [], teams: [] });
    expect(byKey.get(txKey(6))).toMatchObject({ status: "unresolved", issues: [`Yahoo team ${teamKey(9)} (Aaron Judge's destination) isn't linked to an Antlerboard team.`] });
    expect(byKey.get(txKey(7))).toMatchObject({ status: "missing_in_yahoo", proposed: null });
  });

  it("says 'not checked', never 'missing', when Yahoo's log wasn't read to the end", async () => {
    const { league, yahoo } = await legacyLeague();
    const report = await buildRecoveryPlan({ ...input(league.id, yahoo), get: pagedYahoo(yahoo.slice(0, 3)).get });
    expect(report.yahoo.complete).toBe(true);
    const partial = await buildRecoveryPlan(input(league.id, [...yahoo, ...Array.from({ length: 30 }, (_, i) => yTx(meta(200 + i, "commish")))], { failOnStart: 25 }));
    expect(partial.yahoo.complete).toBe(false);
    expect(partial.records.find((r) => r.yahooTransactionId === txKey(7))!.status).toBe("not_checked");
  });

  it("refuses when Yahoo's league isn't the season asked for", async () => {
    const { league, yahoo } = await legacyLeague();
    await expect(buildRecoveryPlan(input(league.id, yahoo, { season: "2025" }))).rejects.toBeInstanceOf(RecoveryRefused);
  });

  it("marks unsupported Yahoo types and leaves them out of the plan", async () => {
    const { league, yahoo } = await legacyLeague();
    const report = await buildRecoveryPlan(input(league.id, yahoo.map((t, i) => (i === 0 ? yTx(meta(2, "keeper")) : t))));
    expect(report.records.find((r) => r.yahooTransactionId === txKey(2))).toMatchObject({ status: "unsupported", proposed: null });
  });
});

describe("applyRecoveryPlan (the separate write step)", () => {
  it("refuses a fingerprint that doesn't match the current plan, and writes nothing", async () => {
    const { league, yahoo } = await legacyLeague();
    const before = await snapshot();
    await expect(applyRecoveryPlan({ ...input(league.id, yahoo), expectedFingerprint: "0".repeat(64), actorName: "Scott" })).rejects.toBeInstanceOf(RecoveryRefused);
    expect(await snapshot()).toEqual(before);
  });

  it("refuses when Yahoo changed after the reviewed dry run", async () => {
    const { league, yahoo } = await legacyLeague();
    const { fingerprint } = await buildRecoveryPlan(input(league.id, yahoo));
    const changed = yahoo.map((t, i) => (i === 1 ? yTx(meta(3, "add/drop", { faab_bid: "40" }), [yPlayer(100, "Aaron Judge", waiverAdd(1)), yPlayer(555, "New Guy", dropTo(1))]) : t));
    await expect(applyRecoveryPlan({ ...input(league.id, changed), expectedFingerprint: fingerprint, actorName: "Scott" })).rejects.toThrow("changed since the dry run");
  });

  it("writes only the ready records, through the sync's own upsert, and is safe to re-run", async () => {
    const { league, t1, judge, yahoo } = await legacyLeague();
    const { fingerprint } = await buildRecoveryPlan(input(league.id, yahoo));

    const result = await applyRecoveryPlan({ ...input(league.id, yahoo), expectedFingerprint: fingerprint, actorName: "Scott" });

    expect(result).toMatchObject({ written: 5, playersCreated: 1, skipped: [], failed: [], notReady: { unresolved: 1, missing_in_yahoo: 1 } });
    const newGuy = await prisma.player.findMany({ where: { name: "New Guy" } });
    expect(newGuy).toHaveLength(1);

    const addDrop = await prisma.transaction.findUniqueOrThrow({ where: { yahooTransactionId: txKey(3) }, include: { players: true, teams: true } });
    expect(addDrop).toMatchObject({ type: "WAIVER_ADD", yahooType: "add/drop", faabBid: 4, yahooDetailIssues: [], notes: "Synced from Yahoo (add/drop)" });
    expect(addDrop.players.map((p) => [p.playerId, p.action]).sort()).toEqual([[judge.id, "add"], [newGuy[0].id, "drop"]].sort());
    expect(addDrop.teams.map((t) => t.teamId)).toEqual([t1.id, t1.id]);

    // Unresolved and missing rows are exactly as they were.
    for (const n of [6, 7]) {
      const row = await prisma.transaction.findUniqueOrThrow({ where: { yahooTransactionId: txKey(n) }, include: { players: true } });
      expect(row.yahooType).toBeNull();
      expect(row.players).toEqual([]);
    }
    // Recovery only fills in rows; it never adds Yahoo-only ones (the daily sync does).
    expect(await prisma.transaction.findUnique({ where: { yahooTransactionId: txKey(9) } })).toBeNull();
    expect(await prisma.transaction.count()).toBe(7);

    const audit = await prisma.auditLogEntry.findFirstOrThrow({ where: { action: "YAHOO_TRANSACTION_RECOVERY" } });
    expect(audit).toMatchObject({ actorName: "Scott", entityType: "Transaction" });

    // Re-run: the dry run finds only the two unresolved rows, and applying writes nothing new.
    const again = await buildRecoveryPlan(input(league.id, yahoo));
    expect(again.targets).toBe(2);
    expect(again.summary.ready).toBe(0);
    const before = await snapshot();
    const second = await applyRecoveryPlan({ ...input(league.id, yahoo), expectedFingerprint: again.fingerprint, actorName: "Scott" });
    expect(second.written).toBe(0);
    expect((await snapshot()).transactions).toEqual(before.transactions);
  });

  it("leaves recovered rows to the daily sync afterwards, without duplicates", async () => {
    const { league, yahoo } = await legacyLeague();
    const { fingerprint } = await buildRecoveryPlan(input(league.id, yahoo));
    await applyRecoveryPlan({ ...input(league.id, yahoo), expectedFingerprint: fingerprint, actorName: "Scott" });

    const report = await syncLeagueTransactions(league.id, LK, pagedYahoo(yahoo).get);
    expect(report.counts).toMatchObject({ unchanged: 5, created: 1, legacyAwaitingRecovery: 1, playersCreated: 0 });
    expect(await prisma.transaction.count()).toBe(8);
    expect(await prisma.player.count({ where: { name: "New Guy" } })).toBe(1);
  });
});
