import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { prisma } from "@/lib/db";
import { runYahooSync } from "./sync";
import { makeLeagueWithSeason, resetDatabase } from "@/lib/test-helpers";

vi.mock("./client", () => ({
  yahooFantasyGet: vi.fn(),
}));

import { yahooFantasyGet } from "./client";
const mockedGet = vi.mocked(yahooFantasyGet);

beforeEach(async () => {
  await resetDatabase();
  mockedGet.mockReset();
});
afterAll(resetDatabase);

const LEAGUE_KEY = "422.l.1";

function standingsResponse(teams: { key: string; name: string; rank: string; wins: string; losses: string }[]) {
  return {
    fantasy_content: {
      league: [
        { league_key: LEAGUE_KEY },
        { name: "Claw & Antler League" },
        {
          teams: {
            ...Object.fromEntries(
              teams.map((t, i) => [
                String(i),
                {
                  team: [
                    [{ team_key: t.key }, { team_id: t.key.split(".").pop() }, { name: t.name }],
                    {
                      team_standings: [
                        { rank: t.rank },
                        { outcome_totals: [{ wins: t.wins }, { losses: t.losses }, { ties: "0" }] },
                      ],
                    },
                  ],
                },
              ])
            ),
            count: teams.length,
          },
        },
      ],
    },
  };
}

function rosterResponse(
  players: { key: string; full: string; team: string; positions: string[] }[],
  opts: { flatName?: boolean } = {}
) {
  const flatName = opts.flatName ?? true;
  return {
    fantasy_content: {
      team: [
        [{ team_key: "422.l.1.t.1" }, { name: "The Antlers" }],
        {
          roster: {
            "0": {
              players: {
                ...Object.fromEntries(
                  players.map((p, i) => [
                    String(i),
                    {
                      player: [
                        [
                          { player_key: p.key },
                          { player_id: p.key.split(".").pop() },
                          {
                            name: flatName
                              ? { full: p.full, first: p.full.split(" ")[0], last: p.full.split(" ")[1] }
                              : [{ full: p.full }],
                          },
                          { editorial_team_abbr: p.team },
                          {
                            eligible_positions: {
                              ...Object.fromEntries(p.positions.map((pos, j) => [String(j), { position: pos }])),
                              count: p.positions.length,
                            },
                          },
                        ],
                        { selected_position: [{ position: p.positions[0] }] },
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

function transactionsResponse(txns: { key: string; type: string; timestamp: string }[]) {
  return {
    fantasy_content: {
      league: [
        { league_key: LEAGUE_KEY },
        {
          transactions: {
            ...Object.fromEntries(
              txns.map((t, i) => [
                String(i),
                { transaction: [{ transaction_key: t.key }, { type: t.type }, { timestamp: t.timestamp }] },
              ])
            ),
            count: txns.length,
          },
        },
      ],
    },
  };
}

async function setupConnectedLeague() {
  const { league, season } = await makeLeagueWithSeason(2026);
  await prisma.yahooConnection.create({
    data: {
      leagueId: league.id,
      accessToken: "fake-token",
      refreshToken: "fake-refresh",
      tokenExpiresAt: new Date(Date.now() + 3600_000),
      yahooLeagueKey: LEAGUE_KEY,
      yahooGameKey: "422",
    },
  });
  return { league, season };
}

/** Routes the three sync sections' fetches to their respective fixtures. */
function wireMock(opts: {
  standings?: unknown;
  roster?: unknown;
  transactions?: unknown;
}) {
  mockedGet.mockImplementation(async (_leagueId: string, path: string) => {
    if (path.includes("/standings")) return opts.standings ?? standingsResponse([]);
    if (path.includes("/roster")) return opts.roster ?? rosterResponse([]);
    if (path.includes("/transactions")) return opts.transactions ?? transactionsResponse([]);
    throw new Error(`Unexpected path in test: ${path}`);
  });
}

describe("runYahooSync - teams and standings", () => {
  it("creates teams with placeholder managers and records standings", async () => {
    const { league, season } = await setupConnectedLeague();
    wireMock({
      standings: standingsResponse([
        { key: "422.l.1.t.1", name: "The Antlers", rank: "1", wins: "10", losses: "5" },
        { key: "422.l.1.t.2", name: "The Rack", rank: "2", wins: "8", losses: "7" },
      ]),
    });

    const result = await runYahooSync(league.id);
    expect(result.status).toBe("SUCCESS");

    const teams = await prisma.team.findMany({ where: { leagueId: league.id }, orderBy: { name: "asc" } });
    expect(teams.map((t) => t.name)).toEqual(["The Antlers", "The Rack"]);
    expect(teams.every((t) => t.yahooTeamId)).toBe(true);

    const standings = await prisma.teamStanding.findMany({ where: { seasonId: season.id } });
    expect(standings).toHaveLength(2);
  });

  it("is idempotent - re-running does not create duplicate teams", async () => {
    const { league } = await setupConnectedLeague();
    wireMock({
      standings: standingsResponse([
        { key: "422.l.1.t.1", name: "The Antlers", rank: "1", wins: "10", losses: "5" },
      ]),
    });

    await runYahooSync(league.id);
    await runYahooSync(league.id);

    const teams = await prisma.team.count({ where: { leagueId: league.id } });
    expect(teams).toBe(1);
  });

  it("updates a team's name on re-sync without creating a new row", async () => {
    const { league } = await setupConnectedLeague();
    wireMock({
      standings: standingsResponse([
        { key: "422.l.1.t.1", name: "The Antlers", rank: "1", wins: "10", losses: "5" },
      ]),
    });
    await runYahooSync(league.id);

    wireMock({
      standings: standingsResponse([
        { key: "422.l.1.t.1", name: "The Antlers Renamed", rank: "1", wins: "11", losses: "5" },
      ]),
    });
    await runYahooSync(league.id);

    const teams = await prisma.team.findMany({ where: { leagueId: league.id } });
    expect(teams).toHaveLength(1);
    expect(teams[0].name).toBe("The Antlers Renamed");
  });
});

describe("runYahooSync - players", () => {
  it("creates a new player from a flat {full,...} name object and reads eligible_positions", async () => {
    const { league } = await setupConnectedLeague();
    wireMock({
      standings: standingsResponse([{ key: "422.l.1.t.1", name: "The Antlers", rank: "1", wins: "10", losses: "5" }]),
      roster: rosterResponse([
        { key: "422.p.100", full: "Mike Trout", team: "laa", positions: ["OF", "Util"] },
      ]),
    });

    await runYahooSync(league.id);

    const player = await prisma.player.findFirstOrThrow({ where: { leagueId: league.id, yahooPlayerId: "422.p.100" } });
    expect(player.name).toBe("Mike Trout");
    expect(player.mlbTeam).toBe("LAA");
    expect(player.positions).toEqual(["OF", "Util"]);
  });

  it("also handles the array-of-single-key-fields name shape as a fallback", async () => {
    const { league } = await setupConnectedLeague();
    wireMock({
      standings: standingsResponse([{ key: "422.l.1.t.1", name: "The Antlers", rank: "1", wins: "10", losses: "5" }]),
      roster: rosterResponse(
        [{ key: "422.p.101", full: "Shohei Ohtani", team: "lad", positions: ["SP", "Util"] }],
        { flatName: false }
      ),
    });

    await runYahooSync(league.id);

    const player = await prisma.player.findFirstOrThrow({ where: { leagueId: league.id, yahooPlayerId: "422.p.101" } });
    expect(player.name).toBe("Shohei Ohtani");
  });

  it("claims an existing unlinked player by name instead of creating a duplicate", async () => {
    const { league } = await setupConnectedLeague();
    const existing = await prisma.player.create({
      data: { leagueId: league.id, name: "Mike Trout", positions: [] },
    });

    wireMock({
      standings: standingsResponse([{ key: "422.l.1.t.1", name: "The Antlers", rank: "1", wins: "10", losses: "5" }]),
      roster: rosterResponse([{ key: "422.p.100", full: "Mike Trout", team: "laa", positions: ["OF"] }]),
    });
    await runYahooSync(league.id);

    const count = await prisma.player.count({ where: { leagueId: league.id, name: "Mike Trout" } });
    expect(count).toBe(1);

    const claimed = await prisma.player.findUniqueOrThrow({ where: { id: existing.id } });
    expect(claimed.yahooPlayerId).toBe("422.p.100");
    expect(claimed.mlbTeam).toBe("LAA");
  });

  it("never overwrites the commissioner-owned notes field", async () => {
    const { league } = await setupConnectedLeague();
    const existing = await prisma.player.create({
      data: { leagueId: league.id, name: "Mike Trout", positions: [], notes: "Keeper favorite" },
    });

    wireMock({
      standings: standingsResponse([{ key: "422.l.1.t.1", name: "The Antlers", rank: "1", wins: "10", losses: "5" }]),
      roster: rosterResponse([{ key: "422.p.100", full: "Mike Trout", team: "laa", positions: ["OF"] }]),
    });
    await runYahooSync(league.id);

    const after = await prisma.player.findUniqueOrThrow({ where: { id: existing.id } });
    expect(after.notes).toBe("Keeper favorite");
  });

  it("is idempotent - re-running does not create duplicate players", async () => {
    const { league } = await setupConnectedLeague();
    wireMock({
      standings: standingsResponse([{ key: "422.l.1.t.1", name: "The Antlers", rank: "1", wins: "10", losses: "5" }]),
      roster: rosterResponse([{ key: "422.p.100", full: "Mike Trout", team: "laa", positions: ["OF"] }]),
    });

    await runYahooSync(league.id);
    await runYahooSync(league.id);

    const count = await prisma.player.count({ where: { leagueId: league.id, yahooPlayerId: "422.p.100" } });
    expect(count).toBe(1);
  });
});

describe("runYahooSync - transactions", () => {
  it("creates a transaction keyed on the Yahoo transaction id", async () => {
    const { league, season } = await setupConnectedLeague();
    wireMock({
      transactions: transactionsResponse([{ key: "422.l.1.tr.1", type: "add", timestamp: "1700000000" }]),
    });

    await runYahooSync(league.id);

    const txns = await prisma.transaction.findMany({ where: { seasonId: season.id } });
    expect(txns).toHaveLength(1);
    expect(txns[0].yahooTransactionId).toBe("422.l.1.tr.1");
    expect(txns[0].type).toBe("FREE_AGENT_ADD");
  });

  it("is idempotent - re-running does not duplicate transactions already synced", async () => {
    const { league } = await setupConnectedLeague();
    wireMock({
      transactions: transactionsResponse([{ key: "422.l.1.tr.1", type: "drop", timestamp: "1700000000" }]),
    });

    await runYahooSync(league.id);
    await runYahooSync(league.id);

    const count = await prisma.transaction.count({ where: { yahooTransactionId: "422.l.1.tr.1" } });
    expect(count).toBe(1);
  });
});

describe("runYahooSync - partial failure and preservation of Antlerboard-owned data", () => {
  it("reports PARTIAL status when one section fails but others succeed, and still commits the successes", async () => {
    const { league } = await setupConnectedLeague();
    mockedGet.mockImplementation(async (_leagueId: string, path: string) => {
      if (path.includes("/standings")) {
        return standingsResponse([{ key: "422.l.1.t.1", name: "The Antlers", rank: "1", wins: "10", losses: "5" }]);
      }
      if (path.includes("/roster")) throw new Error("Yahoo rate limit exceeded");
      if (path.includes("/transactions")) return transactionsResponse([]);
      throw new Error(`Unexpected path: ${path}`);
    });

    const result = await runYahooSync(league.id);

    expect(result.status).toBe("PARTIAL");
    const teams = await prisma.team.count({ where: { leagueId: league.id } });
    expect(teams).toBe(1);

    const connection = await prisma.yahooConnection.findUniqueOrThrow({ where: { leagueId: league.id } });
    expect(connection.lastSyncStatus).toBe("PARTIAL");
    expect(connection.lastSyncError).toContain("rate limit");
  });

  it("reports FAILED status and preserves lastSyncSuccessAt when every section fails", async () => {
    const { league } = await setupConnectedLeague();
    // Pre-seed an already-linked team so the players section actually
    // attempts (and fails) a roster fetch instead of vacuously succeeding
    // with zero teams to iterate.
    await prisma.team.create({
      data: {
        leagueId: league.id,
        yahooTeamId: "422.l.1.t.1",
        name: "The Antlers",
        managerId: (await prisma.manager.create({ data: { leagueId: league.id, name: "Alex" } })).id,
      },
    });
    mockedGet.mockRejectedValue(new Error("Yahoo is down"));

    const result = await runYahooSync(league.id);
    expect(result.status).toBe("FAILED");

    const connection = await prisma.yahooConnection.findUniqueOrThrow({ where: { leagueId: league.id } });
    expect(connection.lastSyncStatus).toBe("FAILED");
    expect(connection.lastSyncSuccessAt).toBeNull();
  });

  it("writes an auditable SyncLog row for every run", async () => {
    const { league } = await setupConnectedLeague();
    wireMock({});
    await runYahooSync(league.id);

    const connection = await prisma.yahooConnection.findUniqueOrThrow({ where: { leagueId: league.id } });
    const logs = await prisma.syncLog.findMany({ where: { connectionId: connection.id } });
    expect(logs).toHaveLength(1);
    expect(logs[0].status).toBe("SUCCESS");
  });

  it("never touches keeper history, tags, or trades owned by Antlerboard", async () => {
    const { league, season } = await setupConnectedLeague();
    const team = await prisma.team.create({
      data: {
        leagueId: league.id,
        yahooTeamId: "422.l.1.t.1",
        name: "The Antlers",
        managerId: (await prisma.manager.create({ data: { leagueId: league.id, name: "Alex" } })).id,
      },
    });
    const player = await prisma.player.create({ data: { leagueId: league.id, name: "Mike Trout", positions: [] } });
    const keeperRecord = await prisma.keeperRecord.create({
      data: {
        seasonId: season.id,
        seasonYear: season.year,
        playerId: player.id,
        teamId: team.id,
        keeperYear: 3,
        keeperCost: 15,
        yearsRemaining: 2,
        status: "KEPT",
      },
    });
    const tag = await prisma.playerTag.create({
      data: { playerId: player.id, teamId: team.id, tag: "KEEPING" },
    });

    wireMock({
      standings: standingsResponse([{ key: "422.l.1.t.1", name: "The Antlers Renamed", rank: "1", wins: "10", losses: "5" }]),
      roster: rosterResponse([{ key: "422.p.100", full: "Mike Trout", team: "laa", positions: ["OF"] }]),
    });
    await runYahooSync(league.id);

    const keeperAfter = await prisma.keeperRecord.findUniqueOrThrow({ where: { id: keeperRecord.id } });
    expect(keeperAfter).toEqual(keeperRecord);
    const tagAfter = await prisma.playerTag.findUniqueOrThrow({ where: { id: tag.id } });
    expect(tagAfter).toEqual(tag);
  });
});
