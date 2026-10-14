import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { prisma } from "@/lib/db";
import { runYahooSync } from "./sync";
import { makeLeagueWithSeason, makeManagerAndTeam, resetDatabase } from "@/lib/test-helpers";
import { getCurrentTeamForPlayer, getTeamRoster } from "@/lib/rosters";

vi.mock("./client", () => ({ yahooFantasyGet: vi.fn() }));

import { yahooFantasyGet } from "./client";
const mockedGet = vi.mocked(yahooFantasyGet);

beforeEach(async () => {
  await resetDatabase();
  mockedGet.mockReset();
});
afterAll(resetDatabase);

const LEAGUE_KEY = "422.l.1";
type P = { key: string; full: string; team?: string; positions?: string[]; slot?: string | null };

/** Same shapes as the fixtures in sync.test.ts. */
// Yahoo names match the Antlerboard teams, so the teams step renames nothing.
const YAHOO_NAMES: Record<string, string> = { "422.l.1.t.1": "Alex's Team", "422.l.1.t.2": "Blake's Team" };

function standings(teamKeys: string[], season = "2026") {
  return {
    fantasy_content: {
      league: [
        { league_key: LEAGUE_KEY, name: "Claw & Antler League", season },
        {
          standings: [
            {
              teams: {
                ...Object.fromEntries(
                  teamKeys.map((key, i) => [
                    String(i),
                    {
                      team: [
                        [{ team_key: key }, { team_id: key.split(".").pop() }, { name: YAHOO_NAMES[key] }],
                        { team_points: { total: "0" } },
                        { team_standings: { rank: String(i + 1), outcome_totals: { wins: "1", losses: "1", ties: "0" } } },
                      ],
                    },
                  ])
                ),
                count: teamKeys.length,
              },
            },
          ],
        },
      ],
    },
  };
}

function roster(players: (P | "unreadable")[]) {
  return {
    fantasy_content: {
      team: [
        [{ team_key: "x" }],
        {
          roster: {
            "0": {
              players: {
                ...Object.fromEntries(
                  players.map((p, i) => [
                    String(i),
                    p === "unreadable"
                      ? // Synthetic: an entry with no player_key - not a claimed Yahoo shape.
                        { player: [[{ player_id: "0" }]] }
                      : {
                          player: [
                            [
                              { player_key: p.key },
                              { name: { full: p.full } },
                              { editorial_team_abbr: p.team ?? "NYY" },
                              {
                                eligible_positions: {
                                  ...Object.fromEntries((p.positions ?? ["OF"]).map((pos, j) => [String(j), { position: pos }])),
                                  count: (p.positions ?? ["OF"]).length,
                                },
                              },
                            ],
                            ...(p.slot === null ? [] : [{ selected_position: [{ position: p.slot ?? (p.positions ?? ["OF"])[0] }] }]),
                          ],
                        },
                  ])
                ),
                count: players.length,
              },
            },
          },
        },
      ],
    },
  };
}

const emptyTx = { fantasy_content: { league: [{ league_key: LEAGUE_KEY, season: "2026" }, { transactions: { count: 0 } }] } };

/** League with two Yahoo-linked teams A (t.1) and B (t.2). */
async function setup(seasonYear = 2026) {
  const { league, season } = await makeLeagueWithSeason(seasonYear);
  const a = await makeManagerAndTeam(league.id, "Alex");
  const b = await makeManagerAndTeam(league.id, "Blake");
  await prisma.team.update({ where: { id: a.team.id }, data: { yahooTeamId: "422.l.1.t.1" } });
  await prisma.team.update({ where: { id: b.team.id }, data: { yahooTeamId: "422.l.1.t.2" } });
  await prisma.yahooConnection.create({
    data: { leagueId: league.id, accessToken: "fake-token", yahooLeagueKey: LEAGUE_KEY, yahooGameKey: "422" },
  });
  return { league, season, teamA: a.team, teamB: b.team };
}

/** Routes each team's roster request to its own response (or error). */
function wire(rosters: Record<string, unknown | Error>, opts: { season?: string } = {}) {
  mockedGet.mockImplementation(async (_l: string, path: string) => {
    if (path.includes("/standings")) return standings(["422.l.1.t.1", "422.l.1.t.2"], opts.season);
    if (path.includes("/transactions")) return emptyTx;
    const m = path.match(/\/team\/(.+)\/roster/);
    if (m) {
      const r = rosters[m[1]];
      if (r instanceof Error) throw r;
      return r ?? roster([]);
    }
    throw new Error(`Unexpected path in test: ${path}`);
  });
}

const spotsOf = async (teamId: string) =>
  (await prisma.rosterSpot.findMany({ where: { teamId }, include: { player: true } })).map((s) => s.player.name).sort();

const playersSection = (r: Awaited<ReturnType<typeof runYahooSync>>) => r.sections.find((s) => s.section === "players")!;

describe("roster sync - initial sync", () => {
  it("creates one spot per rostered player on the right team, season and lineup slot", async () => {
    const { league, season, teamA, teamB } = await setup();
    wire({
      "422.l.1.t.1": roster([{ key: "422.p.1", full: "Aaron Judge", positions: ["OF"], slot: "OF" }, { key: "422.p.2", full: "Gerrit Cole", positions: ["SP"], slot: "IL" }]),
      "422.l.1.t.2": roster([{ key: "422.p.3", full: "Mookie Betts", positions: ["SS"], slot: "BN" }]),
    });

    const result = await runYahooSync(league.id);

    expect(result.status).toBe("SUCCESS");
    expect(await spotsOf(teamA.id)).toEqual(["Aaron Judge", "Gerrit Cole"]);
    expect(await spotsOf(teamB.id)).toEqual(["Mookie Betts"]);
    const cole = await prisma.rosterSpot.findFirstOrThrow({ where: { yahooPlayerKey: "422.p.2" } });
    expect(cole.seasonId).toBe(season.id);
    expect(cole.selectedPosition).toBe("IL");
    expect((playersSection(result).detail as { rosters: { added: string[] }[] }).rosters[0].added).toEqual(["422.p.1", "422.p.2"]);
  });

  it("stores no lineup slot when Yahoo sends none, rather than guessing", async () => {
    const { league } = await setup();
    wire({ "422.l.1.t.1": roster([{ key: "422.p.1", full: "Aaron Judge", slot: null }]) });

    await runYahooSync(league.id);

    expect((await prisma.rosterSpot.findFirstOrThrow()).selectedPosition).toBeNull();
  });

  it("links an existing player by exact name only when exactly one unlinked player has it", async () => {
    const { league, teamA } = await setup();
    const existing = await prisma.player.create({ data: { leagueId: league.id, name: "Nick Kurtz", positions: ["1B"] } });
    wire({ "422.l.1.t.1": roster([{ key: "422.p.9", full: "Nick Kurtz", positions: ["1B"] }]) });

    await runYahooSync(league.id);

    expect((await prisma.player.findUniqueOrThrow({ where: { id: existing.id } })).yahooPlayerId).toBe("422.p.9");
    expect(await prisma.player.count()).toBe(1);
    expect((await prisma.rosterSpot.findFirstOrThrow()).playerId).toBe(existing.id);
    expect(await spotsOf(teamA.id)).toEqual(["Nick Kurtz"]);
  });

  it("does not backfill anything: a season with no sync has no roster spots", async () => {
    await setup();
    expect(await prisma.rosterSpot.count()).toBe(0);
  });
});

describe("roster sync - repeat sync", () => {
  it("is idempotent: the same rosters twice give the same spots, no duplicates", async () => {
    const { league, teamA } = await setup();
    wire({ "422.l.1.t.1": roster([{ key: "422.p.1", full: "Aaron Judge" }, { key: "422.p.2", full: "Gerrit Cole" }]) });

    await runYahooSync(league.id);
    const first = await prisma.rosterSpot.findMany({ orderBy: { yahooPlayerKey: "asc" } });
    const second = await runYahooSync(league.id);
    const after = await prisma.rosterSpot.findMany({ orderBy: { yahooPlayerKey: "asc" } });

    expect(await prisma.player.count()).toBe(2);
    expect(after.map((s) => [s.id, s.teamId, s.onTeamSince.getTime()])).toEqual(
      first.map((s) => [s.id, s.teamId, s.onTeamSince.getTime()])
    );
    expect(after[0].lastSeenAt.getTime()).toBeGreaterThanOrEqual(first[0].lastSeenAt.getTime());
    const changes = (playersSection(second).detail as { rosters: { added: string[]; unchanged: number }[] }).rosters[0];
    expect(changes.added).toEqual([]);
    expect(changes.unchanged).toBe(2);
    expect(await spotsOf(teamA.id)).toEqual(["Aaron Judge", "Gerrit Cole"]);
  });
});

describe("roster sync - trades and drops", () => {
  it("moves a traded player's spot to the new team (both processing orders) and resets onTeamSince", async () => {
    const { league, teamA, teamB } = await setup();
    // A (t.1) is processed before B (t.2).
    wire({ "422.l.1.t.1": roster([{ key: "422.p.1", full: "Aaron Judge" }]), "422.l.1.t.2": roster([{ key: "422.p.2", full: "Mookie Betts" }]) });
    await runYahooSync(league.id);
    const before = await prisma.rosterSpot.findFirstOrThrow({ where: { yahooPlayerKey: "422.p.1" } });

    // Judge A -> B: the old team is processed first.
    wire({ "422.l.1.t.1": roster([{ key: "422.p.9", full: "Filler One" }]), "422.l.1.t.2": roster([{ key: "422.p.1", full: "Aaron Judge" }, { key: "422.p.2", full: "Mookie Betts" }]) });
    await runYahooSync(league.id);
    expect(await spotsOf(teamA.id)).toEqual(["Filler One"]);
    expect(await spotsOf(teamB.id)).toEqual(["Aaron Judge", "Mookie Betts"]);

    // Betts B -> A: the new team is processed first.
    wire({ "422.l.1.t.1": roster([{ key: "422.p.9", full: "Filler One" }, { key: "422.p.2", full: "Mookie Betts" }]), "422.l.1.t.2": roster([{ key: "422.p.1", full: "Aaron Judge" }]) });
    const result = await runYahooSync(league.id);
    expect(await spotsOf(teamA.id)).toEqual(["Filler One", "Mookie Betts"]);
    expect(await spotsOf(teamB.id)).toEqual(["Aaron Judge"]);
    expect(result.status).toBe("SUCCESS");

    const judge = await prisma.rosterSpot.findFirstOrThrow({ where: { yahooPlayerKey: "422.p.1" } });
    expect(judge.id).toBe(before.id); // same row, moved - never duplicated
    expect(judge.onTeamSince.getTime()).toBeGreaterThan(before.onTeamSince.getTime());
    expect(await prisma.rosterSpot.count({ where: { yahooPlayerKey: "422.p.1" } })).toBe(1);
  });

  it("deletes a dropped player's spot and keeps the player, their transactions, keeper record and tags", async () => {
    const { league, season, teamA } = await setup();
    wire({ "422.l.1.t.1": roster([{ key: "422.p.1", full: "Aaron Judge" }, { key: "422.p.2", full: "Gerrit Cole" }]) });
    await runYahooSync(league.id);
    const cole = await prisma.player.findFirstOrThrow({ where: { yahooPlayerId: "422.p.2" } });
    const tx = await prisma.transaction.create({ data: { seasonId: season.id, seasonYear: 2026, type: "DROP", yahooTransactionId: "422.l.1.tr.5" } });
    const keeper = await prisma.keeperRecord.create({
      data: { seasonId: season.id, seasonYear: 2026, playerId: cole.id, teamId: teamA.id, keeperYear: 2, keeperCost: 10, yearsRemaining: 3, status: "KEPT" },
    });
    const tag = await prisma.playerTag.create({ data: { playerId: cole.id, teamId: teamA.id, tag: "KEEPING" } });

    wire({ "422.l.1.t.1": roster([{ key: "422.p.1", full: "Aaron Judge" }]) });
    const result = await runYahooSync(league.id);

    expect(await spotsOf(teamA.id)).toEqual(["Aaron Judge"]);
    expect((playersSection(result).detail as { rosters: { removed: string[] }[] }).rosters[0].removed).toEqual(["422.p.2"]);
    expect(await prisma.player.findUnique({ where: { id: cole.id } })).not.toBeNull();
    expect(await prisma.transaction.findUnique({ where: { id: tx.id } })).toEqual(tx);
    expect(await prisma.keeperRecord.findUnique({ where: { id: keeper.id } })).toMatchObject({ teamId: teamA.id, keeperCost: 10, status: "KEPT" });
    expect(await prisma.playerTag.findUnique({ where: { id: tag.id } })).toEqual(tag);
    expect(await getCurrentTeamForPlayer(cole.id, 2026)).toMatchObject({ status: "free_agent", team: null });
  });

  it("keeps a player listed on two rosters in one run on the first team and reports the conflict", async () => {
    const { league, teamA, teamB } = await setup();
    wire({ "422.l.1.t.1": roster([{ key: "422.p.1", full: "Aaron Judge" }]), "422.l.1.t.2": roster([{ key: "422.p.1", full: "Aaron Judge" }, { key: "422.p.2", full: "Mookie Betts" }]) });

    const result = await runYahooSync(league.id);

    expect(await spotsOf(teamA.id)).toEqual(["Aaron Judge"]);
    expect(await spotsOf(teamB.id)).toEqual(["Mookie Betts"]);
    expect(result.status).toBe("PARTIAL");
    expect(playersSection(result).error).toContain("appeared on two Yahoo rosters");
    expect((playersSection(result).detail as { conflicts: unknown[] }).conflicts).toEqual([
      { yahooPlayerId: "422.p.1", keptOn: teamA.name, alsoOn: teamB.name },
    ]);
  });
});

describe("roster sync - missing and ambiguous players", () => {
  it("never links an ambiguous name: creates a new Yahoo-linked player and reports it", async () => {
    const { league, teamA } = await setup();
    const one = await prisma.player.create({ data: { leagueId: league.id, name: "Will Smith", positions: ["C"] } });
    const two = await prisma.player.create({ data: { leagueId: league.id, name: "Will Smith", positions: ["RP"] } });
    wire({ "422.l.1.t.1": roster([{ key: "422.p.7", full: "Will Smith", positions: ["C"] }]) });

    const result = await runYahooSync(league.id);

    expect((await prisma.player.findUniqueOrThrow({ where: { id: one.id } })).yahooPlayerId).toBeNull();
    expect((await prisma.player.findUniqueOrThrow({ where: { id: two.id } })).yahooPlayerId).toBeNull();
    const created = await prisma.player.findFirstOrThrow({ where: { yahooPlayerId: "422.p.7" } });
    expect([one.id, two.id]).not.toContain(created.id);
    expect((await prisma.rosterSpot.findFirstOrThrow()).playerId).toBe(created.id);
    expect(await spotsOf(teamA.id)).toEqual(["Will Smith"]);
    expect(result.status).toBe("PARTIAL");
    expect(playersSection(result).error).toContain("matched more than one existing player");
    expect((playersSection(result).detail as { ambiguous: unknown[] }).ambiguous).toEqual([
      { name: "Will Smith", yahooPlayerId: "422.p.7", team: teamA.name },
    ]);
  });

  it("finds a player stored under another form of the same Yahoo id (import's bare id, or last season's key) instead of duplicating it", async () => {
    const { league, teamA } = await setup();
    const fromImport = await prisma.player.create({ data: { leagueId: league.id, name: "Juan Soto", yahooPlayerId: "5" } });
    const lastSeason = await prisma.player.create({ data: { leagueId: league.id, name: "Pete Alonso", yahooPlayerId: "421.p.6" } });
    wire({ "422.l.1.t.1": roster([{ key: "422.p.5", full: "Juan Soto" }, { key: "422.p.6", full: "Pete Alonso" }]) });

    const result = await runYahooSync(league.id);

    expect(result.status).toBe("SUCCESS");
    expect(await prisma.player.count({ where: { leagueId: league.id } })).toBe(2);
    expect((await prisma.player.findUniqueOrThrow({ where: { id: fromImport.id } })).yahooPlayerId).toBe("422.p.5");
    expect((await prisma.player.findUniqueOrThrow({ where: { id: lastSeason.id } })).yahooPlayerId).toBe("422.p.6");
    expect((await prisma.rosterSpot.findMany({ where: { teamId: teamA.id } })).map((s) => s.playerId).sort()).toEqual([fromImport.id, lastSeason.id].sort());
  });

  it("never picks between two players already stored under one Yahoo id - reports it instead", async () => {
    const { league } = await setup();
    const a = await prisma.player.create({ data: { leagueId: league.id, name: "Juan Soto", yahooPlayerId: "5" } });
    const b = await prisma.player.create({ data: { leagueId: league.id, name: "Juan Soto", yahooPlayerId: "421.p.5" } });
    wire({ "422.l.1.t.1": roster([{ key: "422.p.5", full: "Juan Soto" }]) });

    const result = await runYahooSync(league.id);

    expect((await prisma.player.findUniqueOrThrow({ where: { id: a.id } })).yahooPlayerId).toBe("5");
    expect((await prisma.player.findUniqueOrThrow({ where: { id: b.id } })).yahooPlayerId).toBe("421.p.5");
    expect(playersSection(result).error).toContain("matched more than one existing player");
  });

  it("does not report the same player as ambiguous again once linked", async () => {
    const { league } = await setup();
    await prisma.player.create({ data: { leagueId: league.id, name: "Will Smith" } });
    await prisma.player.create({ data: { leagueId: league.id, name: "Will Smith" } });
    wire({ "422.l.1.t.1": roster([{ key: "422.p.7", full: "Will Smith" }]) });
    await runYahooSync(league.id);

    const second = await runYahooSync(league.id);

    expect(second.status).toBe("SUCCESS");
    expect(await prisma.player.count({ where: { yahooPlayerId: "422.p.7" } })).toBe(1);
  });

  it("records no spots, but keeps player identity, when Antlerboard has no season matching Yahoo's", async () => {
    const { league } = await setup(2022);
    wire({ "422.l.1.t.1": roster([{ key: "422.p.1", full: "Aaron Judge" }]) }, { season: "2026" });

    const result = await runYahooSync(league.id);

    expect(await prisma.rosterSpot.count()).toBe(0);
    expect(await prisma.player.count({ where: { yahooPlayerId: "422.p.1" } })).toBe(1);
    expect(playersSection(result).error).toContain("Rosters not recorded: No 2026 season exists in Antlerboard");
    expect(result.status).not.toBe("SUCCESS");
  });
});

describe("roster sync - partial Yahoo failures never wipe a roster", () => {
  async function seeded() {
    const ctx = await setup();
    wire({
      "422.l.1.t.1": roster([{ key: "422.p.1", full: "Aaron Judge" }, { key: "422.p.2", full: "Gerrit Cole" }]),
      "422.l.1.t.2": roster([{ key: "422.p.3", full: "Mookie Betts" }]),
    });
    await runYahooSync(ctx.league.id);
    return ctx;
  }

  it("leaves a team's spots untouched when its roster request fails, and still syncs the others", async () => {
    const { league, teamA, teamB } = await seeded();
    wire({
      "422.l.1.t.1": new Error("Yahoo API request failed (500)"),
      "422.l.1.t.2": roster([{ key: "422.p.3", full: "Mookie Betts" }, { key: "422.p.4", full: "Freddie Freeman" }]),
    });

    const result = await runYahooSync(league.id);

    expect(await spotsOf(teamA.id)).toEqual(["Aaron Judge", "Gerrit Cole"]);
    expect(await spotsOf(teamB.id)).toEqual(["Freddie Freeman", "Mookie Betts"]);
    expect(result.status).toBe("PARTIAL");
    expect(playersSection(result).error).toContain(`${teamA.name}: Yahoo API request failed (500) - existing roster left unchanged`);
  });

  it("does not wipe a team when Yahoo returns an empty roster for it", async () => {
    const { league, teamA } = await seeded();
    wire({ "422.l.1.t.1": roster([]), "422.l.1.t.2": roster([{ key: "422.p.3", full: "Mookie Betts" }]) });

    const result = await runYahooSync(league.id);

    expect(await spotsOf(teamA.id)).toEqual(["Aaron Judge", "Gerrit Cole"]);
    expect(playersSection(result).error).toContain(`${teamA.name}: Yahoo returned an empty roster - existing 2 roster spot(s) left unchanged`);
    expect(result.status).toBe("PARTIAL");
  });

  it("does not wipe a team when none of its roster entries can be read", async () => {
    const { league, teamA } = await seeded();
    wire({ "422.l.1.t.1": roster(["unreadable", "unreadable"]), "422.l.1.t.2": roster([{ key: "422.p.3", full: "Mookie Betts" }]) });

    const result = await runYahooSync(league.id);

    expect(await spotsOf(teamA.id)).toEqual(["Aaron Judge", "Gerrit Cole"]);
    expect(playersSection(result).error).toContain(`${teamA.name}: none of 2 roster entries could be read`);
  });

  it("adds readable players but removes nobody when some entries can't be read", async () => {
    const { league, teamA } = await seeded();
    wire({
      "422.l.1.t.1": roster([{ key: "422.p.1", full: "Aaron Judge" }, "unreadable", { key: "422.p.5", full: "Juan Soto" }]),
      "422.l.1.t.2": roster([{ key: "422.p.3", full: "Mookie Betts" }]),
    });

    const result = await runYahooSync(league.id);

    // Cole wasn't listed, but one entry was unreadable - it may be him.
    expect(await spotsOf(teamA.id)).toEqual(["Aaron Judge", "Gerrit Cole", "Juan Soto"]);
    expect(playersSection(result).error).toContain(`${teamA.name}: 1 of 3 roster entries could not be read - no players removed`);
    expect(result.status).toBe("PARTIAL");
  });

  it("never changes standings ranks or existing transactions", async () => {
    const { league, season, teamA } = await seeded();
    const tx = await prisma.transaction.create({ data: { seasonId: season.id, seasonYear: 2026, type: "TRADE", yahooTransactionId: "422.l.1.tr.1" } });
    const standing = await prisma.teamStanding.findFirstOrThrow({ where: { teamId: teamA.id } });

    wire({ "422.l.1.t.1": new Error("boom"), "422.l.1.t.2": roster([]) });
    await runYahooSync(league.id);

    expect(await prisma.transaction.findUnique({ where: { id: tx.id } })).toEqual(tx);
    expect((await prisma.teamStanding.findUniqueOrThrow({ where: { id: standing.id } })).rank).toBe(standing.rank);
  });
});

describe("roster read side", () => {
  it("serves the Yahoo roster with keeper facts joined, and falls back to keeper stints for seasons with no sync", async () => {
    const { league, season, teamA } = await setup();
    const old = await prisma.player.create({ data: { leagueId: league.id, name: "Kept Guy" } });
    await prisma.keeperRecord.create({
      data: { seasonId: season.id, seasonYear: 2026, playerId: old.id, teamId: teamA.id, keeperYear: 3, keeperCost: 15, yearsRemaining: 2, status: "KEPT" },
    });

    const before = await getTeamRoster(teamA.id, 2026);
    expect(before.source).toBe("keepers");
    expect(before.rows.map((r) => r.player.name)).toEqual(["Kept Guy"]);
    expect(await getCurrentTeamForPlayer(old.id, 2026)).toMatchObject({ status: "rostered", source: "keepers" });

    wire({ "422.l.1.t.1": roster([{ key: "422.p.1", full: "Kept Guy" }, { key: "422.p.2", full: "New Guy", slot: "BN" }]) });
    await runYahooSync(league.id);

    const after = await getTeamRoster(teamA.id, 2026);
    expect(after.source).toBe("yahoo");
    expect(after.rows.map((r) => [r.player.name, r.keeper?.keeperCost ?? null, r.selectedPosition])).toEqual([
      ["Kept Guy", 15, "OF"],
      ["New Guy", null, "BN"],
    ]);
    expect(after.lastSyncedAt).not.toBeNull();
    expect(await getCurrentTeamForPlayer(old.id, 2026)).toMatchObject({ status: "rostered", source: "yahoo", team: { id: teamA.id } });
  });
});
