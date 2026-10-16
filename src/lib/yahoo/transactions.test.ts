import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { prisma } from "@/lib/db";
import { makeLeagueWithSeason, resetDatabase } from "@/lib/test-helpers";
import { parseYahooTransaction, syncLeagueTransactions, fetchLeagueTransactions, MalformedYahooResponseError } from "./transactions";
import { LK, teamKey, txKey, yPlayer, yTx, meta, yPage, pagedYahoo, freeAgentAdd, waiverAdd, dropTo, tradeMove } from "./yahoo-transaction-fixtures";

beforeEach(resetDatabase);
afterAll(resetDatabase);

const NOW = new Date("2026-10-16T12:00:00Z");

describe("parseYahooTransaction", () => {
  it("types a free-agent add, with the player's Yahoo ids and destination team key", () => {
    const r = parseYahooTransaction(yTx(meta(1, "add"), [yPlayer(100, "Aaron Judge", freeAgentAdd(1))]).transaction);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.tx).toMatchObject({ key: txKey(1), yahooType: "add", type: "FREE_AGENT_ADD", status: "successful", faabBid: null, issues: [] });
    expect(r.tx.timestamp?.toISOString()).toBe(new Date((1_774_000_000 + 60) * 1000).toISOString());
    expect(r.tx.players[0]).toMatchObject({ playerKey: "469.p.100", canonicalId: "100", name: "Aaron Judge", mlbTeam: "NYY", positions: ["OF", "Util"], action: "add", sourceType: "freeagents", destinationTeamKey: teamKey(1) });
  });

  it("types a waiver claim and keeps its FAAB bid", () => {
    const r = parseYahooTransaction(yTx(meta(2, "add", { faab_bid: "12" }), [yPlayer(100, "Aaron Judge", waiverAdd(1))]).transaction);
    expect(r.ok && r.tx).toMatchObject({ type: "WAIVER_ADD", faabBid: 12, issues: [] });
  });

  it("keeps both halves of an add/drop", () => {
    const r = parseYahooTransaction(yTx(meta(3, "add/drop"), [yPlayer(100, "Aaron Judge", waiverAdd(1)), yPlayer(200, "Juan Soto", dropTo(1))]).transaction);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.tx.type).toBe("WAIVER_ADD");
    expect(r.tx.players.map((p) => [p.name, p.action, p.sourceTeamKey, p.destinationTeamKey])).toEqual([
      ["Aaron Judge", "add", null, teamKey(1)],
      ["Juan Soto", "drop", teamKey(1), null],
    ]);
  });

  it("types a drop and a trade, keeping the trade's trader and tradee", () => {
    const drop = parseYahooTransaction(yTx(meta(4, "drop"), [yPlayer(200, "Juan Soto", dropTo(2))]).transaction);
    expect(drop.ok && drop.tx.type).toBe("DROP");
    const trade = parseYahooTransaction(
      yTx(meta(5, "trade", { trader_team_key: teamKey(1), tradee_team_key: teamKey(2) }), [yPlayer(100, "Aaron Judge", tradeMove(1, 2)), yPlayer(200, "Juan Soto", tradeMove(2, 1))]).transaction
    );
    expect(trade.ok && trade.tx).toMatchObject({ type: "TRADE", traderTeamKey: teamKey(1), tradeeTeamKey: teamKey(2), issues: [] });
  });

  it("types a commissioner move without players as COMMISSIONER_MOVE, never a free-agent add", () => {
    const r = parseYahooTransaction(yTx(meta(6, "commish")).transaction);
    expect(r.ok && r.tx).toMatchObject({ type: "COMMISSIONER_MOVE", players: [], issues: [] });
  });

  it("refuses unknown or missing types instead of calling them free-agent adds", () => {
    expect(parseYahooTransaction(yTx(meta(7, "keeper")).transaction)).toMatchObject({ ok: false, kind: "unsupported", key: txKey(7) });
    expect(parseYahooTransaction(yTx(meta(8, "")).transaction)).toMatchObject({ ok: false, kind: "unsupported" });
  });

  it("refuses an add whose source isn't waivers or free agents", () => {
    const td = { type: "add", destination_type: "team", destination_team_key: teamKey(1) };
    expect(parseYahooTransaction(yTx(meta(9, "add"), [yPlayer(100, "Aaron Judge", td)]).transaction)).toMatchObject({ ok: false, kind: "unsupported" });
  });

  it("refuses an add with no readable added player", () => {
    expect(parseYahooTransaction(yTx(meta(10, "add")).transaction)).toMatchObject({ ok: false, kind: "malformed" });
  });

  it("refuses a transaction without a key", () => {
    const { transaction_key: _omit, ...noKey } = meta(11, "drop");
    void _omit;
    expect(parseYahooTransaction(yTx(noKey).transaction)).toMatchObject({ ok: false, kind: "missing_key", key: null });
  });

  it("marks a missing timestamp, an unreadable FAAB bid and an unreadable player as issues - never filled in", () => {
    const r = parseYahooTransaction(
      yTx(meta(12, "add/drop", { timestamp: undefined, faab_bid: "a lot" }), [yPlayer(100, "Aaron Judge", freeAgentAdd(1)), yPlayer(300, "No Id", dropTo(1), { noId: true })]).transaction
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.tx.timestamp).toBeNull();
    expect(r.tx.faabBid).toBeNull();
    expect(r.tx.issues).toEqual([
      "Yahoo sent no usable timestamp.",
      `Yahoo's faab_bid "a lot" isn't a whole number - not recorded.`,
      "Unreadable player: a player with no Yahoo player id (No Id).",
      "Yahoo's add/drop has no dropped player.",
    ]);
  });

  it("reads transaction_data sent as an object as well as a one-element list", () => {
    const r = parseYahooTransaction(yTx(meta(13, "drop"), [yPlayer(200, "Juan Soto", dropTo(2), { tdAsObject: true })]).transaction);
    expect(r.ok && r.tx.players[0].sourceTeamKey).toBe(teamKey(2));
  });
});

describe("fetchLeagueTransactions - paging", () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => yTx(meta(n - i, "drop"), [yPlayer(1000 + i, `P ${i}`, dropTo(1))]));

  it("reads every page and stops on the first page that adds nothing", async () => {
    const yahoo = pagedYahoo(many(60));
    const r = await fetchLeagueTransactions(yahoo.get, LK);
    expect(r.entries).toHaveLength(60);
    expect(r).toMatchObject({ complete: true, pages: 4, entriesWithoutKey: 0 });
    expect(yahoo.calls).toEqual([0, 25, 50, 60].map((s) => `/league/${LK}/transactions;start=${s};count=25`));
  });

  it("is correct when Yahoo ignores paging and returns the whole log every time", async () => {
    const yahoo = pagedYahoo(many(40), { ignorePaging: true });
    const r = await fetchLeagueTransactions(yahoo.get, LK);
    expect(r.entries).toHaveLength(40);
    expect(r.complete).toBe(true);
    expect(yahoo.calls).toHaveLength(2);
  });

  it("returns what it read, marked incomplete, when a later page fails", async () => {
    const r = await fetchLeagueTransactions(pagedYahoo(many(60), { failOnStart: 25 }).get, LK);
    expect(r.entries).toHaveLength(25);
    expect(r.complete).toBe(false);
    expect(r.incompleteReason).toContain("Page 2 failed");
  });

  it("stops at the page cap and says the log may continue", async () => {
    const r = await fetchLeagueTransactions(pagedYahoo(many(60)).get, LK, { maxPages: 2 });
    expect(r).toMatchObject({ complete: false, incompleteReason: "Stopped after 2 pages - the log may continue." });
  });

  it("treats a first page with no transactions field as unreadable, not as an empty log", async () => {
    const get = async () => ({ fantasy_content: { league: [{ league_key: LK, season: "2026" }] } });
    await expect(fetchLeagueTransactions(get, LK)).rejects.toBeInstanceOf(MalformedYahooResponseError);
  });

  it("counts entries without a transaction_key once", async () => {
    const entries = [...many(3), { transaction: [{ type: "drop" }] }];
    const r = await fetchLeagueTransactions(pagedYahoo(entries, { ignorePaging: true }).get, LK);
    expect(r.entries).toHaveLength(3);
    expect(r.entriesWithoutKey).toBe(1);
  });
});

async function setup() {
  const { league, season } = await makeLeagueWithSeason(2026);
  const mk = async (n: number, name: string) => {
    const manager = await prisma.manager.create({ data: { leagueId: league.id, name: `Manager ${n}` } });
    return prisma.team.create({ data: { leagueId: league.id, name, managerId: manager.id, yahooTeamId: teamKey(n) } });
  };
  const t1 = await mk(1, "Ranger Thingz");
  const t2 = await mk(2, "Dallas Eagles");
  // One player under the roster sync's full key, one under the history import's bare id.
  const judge = await prisma.player.create({ data: { leagueId: league.id, name: "Aaron Judge", yahooPlayerId: "469.p.100", positions: ["OF"] } });
  const soto = await prisma.player.create({ data: { leagueId: league.id, name: "Juan Soto", yahooPlayerId: "200", positions: ["OF"] } });
  return { league, season, t1, t2, judge, soto };
}

const sync = (leagueId: string, entries: unknown[], opts: Parameters<typeof syncLeagueTransactions>[3] = {}) =>
  syncLeagueTransactions(leagueId, LK, pagedYahoo(entries).get, { now: NOW, ...opts });

async function tableCounts() {
  const [transactions, players, teams, people, acquisitions, keepers] = await Promise.all([
    prisma.transaction.count(),
    prisma.transactionPlayer.count(),
    prisma.transactionTeam.count(),
    prisma.player.count(),
    prisma.acquisition.count(),
    prisma.keeperRecord.count(),
  ]);
  return { transactions, players, teams, people, acquisitions, keepers };
}

describe("syncLeagueTransactions - writing", () => {
  it("writes an add/drop with both players, both directions, the FAAB bid and team links", async () => {
    const { league, season, t1, judge, soto } = await setup();
    const report = await sync(league.id, [yTx(meta(3, "add/drop", { faab_bid: "7" }), [yPlayer(100, "Aaron Judge", waiverAdd(1)), yPlayer(200, "Juan Soto", dropTo(1))])]);

    expect(report.problems).toEqual([]);
    expect(report.counts).toMatchObject({ read: 1, created: 1, incomplete: 0 });
    const tx = await prisma.transaction.findUniqueOrThrow({ where: { yahooTransactionId: txKey(3) }, include: { players: true, teams: true } });
    expect(tx).toMatchObject({ seasonId: season.id, seasonYear: 2026, type: "WAIVER_ADD", yahooType: "add/drop", yahooStatus: "successful", faabBid: 7, dateUnavailable: false, yahooDetailIssues: [], notes: null });
    expect(tx.date.toISOString()).toBe(new Date((1_774_000_000 + 180) * 1000).toISOString());
    expect(tx.players.map((p) => [p.playerId, p.action, p.sourceType, p.sourceTeamId, p.destinationTeamId]).sort()).toEqual(
      [
        [judge.id, "add", "waivers", null, t1.id],
        [soto.id, "drop", "team", t1.id, null],
      ].sort()
    );
    expect(tx.teams.map((t) => [t.teamId, t.role]).sort()).toEqual([[t1.id, "FROM"], [t1.id, "TO"]].sort());
  });

  it("writes a trade with both teams and every player's direction", async () => {
    const { league, t1, t2, judge, soto } = await setup();
    const report = await sync(league.id, [
      yTx(meta(5, "trade", { trader_team_key: teamKey(1), tradee_team_key: teamKey(2) }), [yPlayer(100, "Aaron Judge", tradeMove(1, 2)), yPlayer(200, "Juan Soto", tradeMove(2, 1))]),
    ]);
    expect(report.problems).toEqual([]);
    const tx = await prisma.transaction.findUniqueOrThrow({ where: { yahooTransactionId: txKey(5) }, include: { players: true, teams: true } });
    expect(tx.type).toBe("TRADE");
    expect(new Set(tx.teams.map((t) => t.teamId))).toEqual(new Set([t1.id, t2.id]));
    const byPlayer = new Map(tx.players.map((p) => [p.playerId, [p.sourceTeamId, p.destinationTeamId]]));
    expect(byPlayer.get(judge.id)).toEqual([t1.id, t2.id]);
    expect(byPlayer.get(soto.id)).toEqual([t2.id, t1.id]);
  });

  it("writes a commissioner move as COMMISSIONER_MOVE with no invented players", async () => {
    const { league } = await setup();
    const report = await sync(league.id, [yTx(meta(2, "commish"))]);
    expect(report.problems).toEqual([]);
    const tx = await prisma.transaction.findUniqueOrThrow({ where: { yahooTransactionId: txKey(2) }, include: { players: true } });
    expect(tx).toMatchObject({ type: "COMMISSIONER_MOVE", yahooType: "commish" });
    expect(tx.players).toEqual([]);
  });

  it("creates a Yahoo-linked player for a Yahoo id no player has, once, even across transactions", async () => {
    const { league } = await setup();
    await sync(league.id, [yTx(meta(7, "add"), [yPlayer(555, "New Guy", freeAgentAdd(1))]), yTx(meta(8, "drop"), [yPlayer(555, "New Guy", dropTo(1))])]);
    const created = await prisma.player.findMany({ where: { name: "New Guy" } });
    expect(created).toHaveLength(1);
    expect(created[0].yahooPlayerId).toBe("469.p.555");
    expect(await prisma.transactionPlayer.count({ where: { playerId: created[0].id } })).toBe(2);
  });

  it("never writes acquisitions or keeper records, and never touches imported history", async () => {
    const { league, season, t1, soto } = await setup();
    const history = await prisma.transaction.create({
      data: { seasonId: season.id, seasonYear: 2026, type: "DROP", sourceRef: "league-history:yahoo:458.l.2049.tr.9", players: { create: { playerId: soto.id } }, teams: { create: { teamId: t1.id, role: "FROM" } } },
    });
    await sync(league.id, [yTx(meta(1, "add"), [yPlayer(100, "Aaron Judge", freeAgentAdd(1))])]);
    expect(await prisma.acquisition.count()).toBe(0);
    expect(await prisma.keeperRecord.count()).toBe(0);
    const after = await prisma.transaction.findUniqueOrThrow({ where: { id: history.id }, include: { players: true, teams: true } });
    expect(after).toMatchObject({ type: "DROP", yahooType: null, sourceRef: history.sourceRef });
    expect(after.players).toHaveLength(1);
  });
});

describe("syncLeagueTransactions - what can't be resolved is reported, never guessed", () => {
  it("leaves an unknown team key unlinked and marks the row incomplete", async () => {
    const { league } = await setup();
    const report = await sync(league.id, [yTx(meta(1, "add"), [yPlayer(100, "Aaron Judge", freeAgentAdd(9))])]);
    expect(report.counts.incomplete).toBe(1);
    expect(report.problems.join(" ")).toContain("written without full team/player detail");
    const tx = await prisma.transaction.findUniqueOrThrow({ where: { yahooTransactionId: txKey(1) }, include: { teams: true, players: true } });
    expect(tx.teams).toEqual([]);
    expect(tx.players[0].destinationTeamId).toBeNull();
    expect(tx.yahooDetailIssues).toEqual([`Yahoo team ${teamKey(9)} (Aaron Judge's destination) isn't linked to an Antlerboard team.`]);
  });

  it("never matches a team by name when Yahoo gives no team key", async () => {
    const { league } = await setup();
    const td = { type: "add", source_type: "freeagents", destination_type: "team", destination_team_name: "Ranger Thingz" };
    await sync(league.id, [yTx(meta(1, "add"), [yPlayer(100, "Aaron Judge", td)])]);
    const tx = await prisma.transaction.findUniqueOrThrow({ where: { yahooTransactionId: txKey(1) }, include: { teams: true } });
    expect(tx.teams).toEqual([]);
    expect(tx.yahooDetailIssues).toEqual(["Yahoo gave no team key for Aaron Judge's destination."]);
  });

  it("doesn't link a Yahoo id two Antlerboard players share", async () => {
    const { league } = await setup();
    await prisma.player.create({ data: { leagueId: league.id, name: "Aaron Judge (dupe)", yahooPlayerId: "100", positions: [] } });
    await sync(league.id, [yTx(meta(1, "add"), [yPlayer(100, "Aaron Judge", freeAgentAdd(1))])]);
    const tx = await prisma.transaction.findUniqueOrThrow({ where: { yahooTransactionId: txKey(1) }, include: { players: true } });
    expect(tx.players).toEqual([]);
    expect(tx.yahooDetailIssues[0]).toContain("matches more than one Antlerboard player");
  });

  it("doesn't create a player next to an unlinked player of the same name", async () => {
    const { league } = await setup();
    await prisma.player.create({ data: { leagueId: league.id, name: "Bobby Witt Jr.", positions: [] } });
    await sync(league.id, [yTx(meta(1, "add"), [yPlayer(777, "Bobby Witt Jr.", freeAgentAdd(1))])]);
    expect(await prisma.player.count({ where: { name: "Bobby Witt Jr." } })).toBe(1);
    const tx = await prisma.transaction.findUniqueOrThrow({ where: { yahooTransactionId: txKey(1) } });
    expect(tx.yahooDetailIssues[0]).toContain("unlinked player(s) share the name");
  });

  it("flags a missing timestamp instead of presenting the sync time as the date", async () => {
    const { league } = await setup();
    const report = await sync(league.id, [yTx(meta(1, "drop", { timestamp: undefined }), [yPlayer(200, "Juan Soto", dropTo(1))])]);
    const tx = await prisma.transaction.findUniqueOrThrow({ where: { yahooTransactionId: txKey(1) } });
    expect(tx.dateUnavailable).toBe(true);
    expect(tx.date.toISOString()).toBe(NOW.toISOString());
    expect(report.counts.incomplete).toBe(1);
  });

  it("skips and counts unsupported, malformed and keyless transactions", async () => {
    const { league } = await setup();
    const report = await sync(league.id, [
      yTx(meta(1, "keeper")),
      yTx(meta(2, "add")),
      yTx(meta(3, "drop"), [yPlayer(200, "Juan Soto", dropTo(1))]),
      { transaction: [{ type: "drop" }] },
    ]);
    expect(report.counts).toMatchObject({ skippedUnsupported: 1, skippedMalformed: 1, skippedMissingKey: 1, created: 1 });
    expect(await prisma.transaction.count()).toBe(1);
    expect(report.problems).toHaveLength(3);
  });

  it("refuses to write when Yahoo's season isn't the one asked for", async () => {
    const { league } = await setup();
    await expect(sync(league.id, [yTx(meta(1, "commish"))], { expectedSeasonYear: 2025 })).rejects.toThrow("is the 2026 season, not 2025");
    expect(await prisma.transaction.count()).toBe(0);
  });
});

describe("syncLeagueTransactions - replay and updates", () => {
  const source = () => [
    yTx(meta(3, "add/drop", { faab_bid: "7" }), [yPlayer(100, "Aaron Judge", waiverAdd(1)), yPlayer(200, "Juan Soto", dropTo(1))]),
    yTx(meta(5, "trade", { trader_team_key: teamKey(1), tradee_team_key: teamKey(2) }), [yPlayer(100, "Aaron Judge", tradeMove(1, 2)), yPlayer(555, "New Guy", tradeMove(2, 1))]),
    yTx(meta(6, "commish")),
  ];

  it("replaying the same source changes nothing", async () => {
    const { league } = await setup();
    await sync(league.id, source());
    const before = await tableCounts();
    const snapshot = await prisma.transaction.findMany({ orderBy: { yahooTransactionId: "asc" }, include: { players: true, teams: true } });

    const report = await sync(league.id, source(), { now: new Date("2026-10-17T12:00:00Z") });

    expect(report.counts).toMatchObject({ created: 0, updated: 0, unchanged: 3, playersCreated: 0 });
    expect(await tableCounts()).toEqual(before);
    expect(await prisma.transaction.findMany({ orderBy: { yahooTransactionId: "asc" }, include: { players: true, teams: true } })).toEqual(snapshot);
  });

  it("updates a stored row when Yahoo changes its status or FAAB bid", async () => {
    const { league } = await setup();
    await sync(league.id, [yTx(meta(3, "add", { status: "pending", faab_bid: "5" }), [yPlayer(100, "Aaron Judge", waiverAdd(1))])]);
    const report = await sync(league.id, [yTx(meta(3, "add", { faab_bid: "9" }), [yPlayer(100, "Aaron Judge", waiverAdd(1))])]);
    expect(report.counts).toMatchObject({ updated: 1, created: 0 });
    const tx = await prisma.transaction.findUniqueOrThrow({ where: { yahooTransactionId: txKey(3) } });
    expect(tx).toMatchObject({ yahooStatus: "successful", faabBid: 9 });
    expect(await prisma.transaction.count()).toBe(1);
  });

  it("keeps - and flags - a stored link Yahoo no longer reports, never deleting it", async () => {
    const { league, soto } = await setup();
    await sync(league.id, [yTx(meta(3, "add/drop"), [yPlayer(100, "Aaron Judge", waiverAdd(1)), yPlayer(200, "Juan Soto", dropTo(1))])]);
    const report = await sync(league.id, [yTx(meta(3, "add/drop"), [yPlayer(100, "Aaron Judge", waiverAdd(1))])]);
    const tx = await prisma.transaction.findUniqueOrThrow({ where: { yahooTransactionId: txKey(3) }, include: { players: true } });
    expect(tx.players.map((p) => p.playerId)).toContain(soto.id);
    expect(tx.yahooDetailIssues).toContain(`Player link ${soto.id} is stored but not in Yahoo's current record - kept for review.`);
    expect(report.counts.incomplete).toBe(1);
  });

  it("leaves rows synced before detailed ingestion alone and reports them for recovery", async () => {
    const { league, season } = await setup();
    const legacy = await prisma.transaction.create({
      data: { seasonId: season.id, seasonYear: 2026, type: "FREE_AGENT_ADD", yahooTransactionId: txKey(3), notes: "Synced from Yahoo (add/drop)", date: new Date("2026-04-01T00:00:00Z") },
    });
    const report = await sync(league.id, [yTx(meta(3, "add/drop"), [yPlayer(100, "Aaron Judge", waiverAdd(1)), yPlayer(200, "Juan Soto", dropTo(1))])]);

    expect(report.counts).toMatchObject({ legacyAwaitingRecovery: 1, created: 0, updated: 0 });
    expect(report.problems.join(" ")).toContain("run the transaction recovery dry run");
    const after = await prisma.transaction.findUniqueOrThrow({ where: { id: legacy.id }, include: { players: true, teams: true } });
    expect(after).toMatchObject({ type: "FREE_AGENT_ADD", yahooType: null, notes: "Synced from Yahoo (add/drop)", date: legacy.date });
    expect(after.players).toEqual([]);
    expect(after.teams).toEqual([]);
  });

  it("never moves a stored row to another season", async () => {
    const { league } = await setup();
    const old = await prisma.season.create({ data: { leagueId: league.id, year: 2022, status: "COMPLETE" } });
    await prisma.transaction.create({ data: { seasonId: old.id, seasonYear: 2022, type: "DROP", yahooTransactionId: txKey(4), yahooType: "drop" } });
    const report = await sync(league.id, [yTx(meta(4, "drop"), [yPlayer(200, "Juan Soto", dropTo(1))])]);
    expect(report.counts.seasonConflicts).toBe(1);
    expect((await prisma.transaction.findUniqueOrThrow({ where: { yahooTransactionId: txKey(4) } })).seasonId).toBe(old.id);
  });

  it("writes what it read and reports the run incomplete when a page fails", async () => {
    const { league } = await setup();
    const entries = Array.from({ length: 30 }, (_, i) => yTx(meta(100 - i, "drop"), [yPlayer(200, "Juan Soto", dropTo(1))]));
    const report = await syncLeagueTransactions(league.id, LK, pagedYahoo(entries, { failOnStart: 25 }).get, { now: NOW });
    expect(report.complete).toBe(false);
    expect(report.counts.created).toBe(25);
    expect(report.problems[0]).toContain("Transaction log not read to the end");
  });
});

describe("yPage fixture", () => {
  it("matches the shape the sync reads", () => {
    expect(yPage([]).fantasy_content.league[1]).toEqual({ transactions: { count: 0 } });
  });
});
