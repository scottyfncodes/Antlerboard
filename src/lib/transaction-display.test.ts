import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { prisma } from "@/lib/db";
import { makeLeagueWithSeason, resetDatabase } from "@/lib/test-helpers";
import { describePlayerMove, describeTransaction, INCOMPLETE_TRANSACTION_WHERE, isTransactionComplete, type DisplayTransaction } from "./transaction-display";

const teams = new Map([
  ["t1", "Ranger Thingz"],
  ["t2", "Dallas Eagles"],
]);

const base: DisplayTransaction = {
  type: "DROP",
  notes: null,
  yahooTransactionId: null,
  yahooType: null,
  yahooStatus: null,
  faabBid: null,
  dateUnavailable: false,
  yahooDetailIssues: [],
  sourceRef: null,
  players: [],
  teams: [],
};
const link = (playerId: string, name: string, action: string | null, from: string | null, to: string | null) => ({
  playerId,
  action,
  sourceTeamId: from,
  destinationTeamId: to,
  player: { name },
});

describe("describeTransaction", () => {
  it("never presents a row synced before detailed ingestion as an ordinary add", () => {
    const d = describeTransaction({ ...base, type: "FREE_AGENT_ADD", yahooTransactionId: "469.l.8891.tr.9", notes: "Synced from Yahoo (add/drop)" }, teams);
    expect(d).toMatchObject({ label: "Yahoo transaction", iconKey: "INCOMPLETE", complete: false, moves: [] });
    expect(d.notes[0]).toContain('Yahoo reported "add/drop"');
    expect(d.summary).toBe("Yahoo add/drop - details missing");
    expect(d.summary).not.toContain("Added");
  });

  it("describes a complete add/drop with both players, the team and the FAAB bid", () => {
    const d = describeTransaction(
      {
        ...base,
        type: "WAIVER_ADD",
        yahooTransactionId: "469.l.8891.tr.3",
        yahooType: "add/drop",
        yahooStatus: "successful",
        faabBid: 7,
        players: [link("p2", "Juan Soto", "drop", "t1", null), link("p1", "Aaron Judge", "add", null, "t1")],
        teams: [{ teamId: "t1", role: "FROM" }, { teamId: "t1", role: "TO" }],
      },
      teams
    );
    expect(d.complete).toBe(true);
    expect(d.label).toBe("Waiver add");
    expect(d.moves.map((m) => [m.verb, m.name, m.teamName])).toEqual([
      ["Added", "Aaron Judge", "Ranger Thingz"],
      ["Dropped", "Juan Soto", "Ranger Thingz"],
    ]);
    expect(d.notes).toEqual(["$7 FAAB"]);
    expect(d.summary).toBe("Waiver add - Aaron Judge (Ranger Thingz), dropped Juan Soto (Ranger Thingz) · $7 FAAB");
  });

  it("marks a detailed row with unresolved teams or players as incomplete", () => {
    const d = describeTransaction(
      { ...base, type: "FREE_AGENT_ADD", yahooTransactionId: "k", yahooType: "add", players: [link("p1", "Aaron Judge", "add", null, null)], yahooDetailIssues: ["Yahoo team x isn't linked"] },
      teams
    );
    expect(d).toMatchObject({ complete: false, iconKey: "INCOMPLETE" });
    expect(d.notes).toContain("Incomplete - some teams or players couldn't be matched");
  });

  it("shows a non-successful Yahoo status and an unavailable date", () => {
    const d = describeTransaction({ ...base, type: "TRADE", yahooTransactionId: "k", yahooType: "trade", yahooStatus: "pending", dateUnavailable: true, players: [link("p1", "A", "trade", "t1", "t2")] }, teams);
    expect(d.notes).toEqual(["Yahoo status: pending", "Date unavailable from Yahoo"]);
  });

  it("treats a commissioner move as complete even though Yahoo sends no players", () => {
    const d = describeTransaction({ ...base, type: "COMMISSIONER_MOVE", yahooTransactionId: "k", yahooType: "commish" }, teams);
    expect(d).toMatchObject({ complete: true, label: "Commissioner move" });
  });

  it("labels the import's inferred 'not kept' releases without changing their stored date", () => {
    const d = describeTransaction({ ...base, sourceRef: "league-history:not kept into 2026", players: [link("p1", "Will Smith", null, null, null)], teams: [{ teamId: "t1", role: "FROM" }] }, teams);
    expect(d).toMatchObject({ label: "Not kept", iconKey: "RELEASE", complete: true });
    expect(d.notes).toContain("Released at season's end (not a dated transaction)");
  });

  it("describes imported historical drops and live trades as before", () => {
    const drop = describeTransaction({ ...base, sourceRef: "league-history:yahoo:458.l.2049.tr.9", players: [link("p1", "Will Smith", null, null, null)], teams: [{ teamId: "t1", role: "FROM" }] }, teams);
    expect(drop).toMatchObject({ label: "Dropped", complete: true, teamNames: ["Ranger Thingz"] });
    const trade = describeTransaction({ ...base, type: "TRADE", notes: "Traded from Ranger Thingz to Dallas Eagles", players: [link("p1", "A", null, null, null)] }, teams);
    expect(trade.notes).toEqual(["Traded from Ranger Thingz to Dallas Eagles"]);
  });
});

describe("describePlayerMove", () => {
  const t = { type: "WAIVER_ADD" as const, notes: null, yahooTransactionId: "k", yahooType: "add/drop", yahooStatus: "successful", faabBid: 7, sourceRef: null };
  it("says what happened to this player in an add/drop", () => {
    expect(describePlayerMove({ action: "add" }, t)).toBe("Added (Waiver add, $7 FAAB)");
    expect(describePlayerMove({ action: "drop" }, t)).toBe("Dropped (Waiver add)");
  });
  it("keeps the old wording for rows without Yahoo detail", () => {
    expect(describePlayerMove({ action: null }, { ...t, type: "DROP", faabBid: null, yahooType: null, notes: null })).toBe("Dropped");
    expect(describePlayerMove({ action: null }, { ...t, sourceRef: "league-history:not kept into 2024" })).toBe("Not kept - released at season's end");
  });
});

describe("INCOMPLETE_TRANSACTION_WHERE", () => {
  beforeEach(resetDatabase);
  afterAll(resetDatabase);

  it("counts exactly the rows isTransactionComplete calls incomplete", async () => {
    const { league, season } = await makeLeagueWithSeason(2026);
    const player = await prisma.player.create({ data: { leagueId: league.id, name: "A", positions: [] } });
    const mk = (data: Record<string, unknown>, withPlayer = false) =>
      prisma.transaction.create({ data: { seasonId: season.id, seasonYear: 2026, type: "DROP", ...data, ...(withPlayer ? { players: { create: { playerId: player.id } } } : {}) } });
    await mk({ yahooTransactionId: "legacy" });
    await mk({ yahooTransactionId: "no-players", yahooType: "drop" });
    await mk({ yahooTransactionId: "issues", yahooType: "drop", yahooDetailIssues: ["x"] }, true);
    await mk({ yahooTransactionId: "complete", yahooType: "drop" }, true);
    await mk({ yahooTransactionId: "commish", yahooType: "commish", type: "COMMISSIONER_MOVE" });
    await mk({ sourceRef: "league-history:not kept into 2026" }, true);
    await mk({}, false);

    const rows = await prisma.transaction.findMany({ include: { players: true } });
    const expected = rows.filter((r) => !isTransactionComplete(r)).map((r) => r.yahooTransactionId).sort();
    const counted = (await prisma.transaction.findMany({ where: INCOMPLETE_TRANSACTION_WHERE })).map((r) => r.yahooTransactionId).sort();
    expect(counted).toEqual(expected);
    expect(counted).toEqual(["issues", "legacy", "no-players"]);
  });
});
