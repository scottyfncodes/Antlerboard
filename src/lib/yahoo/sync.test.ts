import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { prisma } from "@/lib/db";
import { runYahooSync } from "./sync";
import { makeLeagueWithSeason, makeManagerAndTeam, resetDatabase } from "@/lib/test-helpers";

vi.mock("./client", () => ({
  yahooFantasyGet: vi.fn(),
}));

import { yahooFantasyGet } from "./client";
import { YahooApiError } from "./errors";
const mockedGet = vi.mocked(yahooFantasyGet);

beforeEach(async () => {
  await resetDatabase();
  mockedGet.mockReset();
});
afterAll(resetDatabase);

const LEAGUE_KEY = "422.l.1";

/**
 * Mirrors Yahoo's real /league/{key}/standings shape: the team list sits at
 * league[1].standings[0].teams, and each team is
 * [meta fields, {team_points}, {team_standings}] - team_standings is NOT the
 * second element.
 */
function standingsResponse(
  teams: { key: string; name: string; rank: string; wins: string; losses: string; nickname?: string }[],
  opts: { season?: string } = {}
) {
  return {
    fantasy_content: {
      league: [
        { league_key: LEAGUE_KEY, name: "Claw & Antler League", season: opts.season ?? "2026" },
        {
          standings: [
            {
              teams: {
                ...Object.fromEntries(
                  teams.map((t, i) => [
                    String(i),
                    {
                      team: [
                        [
                          { team_key: t.key },
                          { team_id: t.key.split(".").pop() },
                          { name: t.name },
                          [],
                          { managers: [{ manager: { manager_id: String(i + 1), nickname: t.nickname ?? "--" } }] },
                        ],
                        { team_points: { coverage_type: "season", season: "2026", total: "0" } },
                        {
                          team_standings: {
                            rank: t.rank,
                            outcome_totals: { wins: t.wins, losses: t.losses, ties: "0", percentage: ".500" },
                          },
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
        { league_key: LEAGUE_KEY, season: "2026" },
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
    expect(result.syncLogId).toBe((await prisma.syncLog.findFirstOrThrow({ where: { status: "SUCCESS" } })).id);

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

describe("runYahooSync - linking existing Antlerboard teams", () => {
  async function existingTeam(leagueId: string, name: string, managerName: string) {
    const manager = await prisma.manager.create({ data: { leagueId, name: managerName } });
    return prisma.team.create({ data: { leagueId, name, managerId: manager.id } });
  }

  it("links an unlinked Antlerboard team on an exact name match instead of creating a duplicate", async () => {
    const { league, season } = await setupConnectedLeague();
    const existing = await existingTeam(league.id, "The Antlers", "Alex");
    wireMock({
      standings: standingsResponse([{ key: "422.l.1.t.1", name: "the antlers", rank: "3", wins: "9", losses: "6" }]),
    });

    const result = await runYahooSync(league.id);
    expect(result.status).toBe("SUCCESS");

    const teams = await prisma.team.findMany({ where: { leagueId: league.id } });
    expect(teams).toHaveLength(1);
    expect(teams[0].id).toBe(existing.id);
    expect(teams[0].yahooTeamId).toBe("422.l.1.t.1");
    expect(teams[0].managerId).toBe(existing.managerId);
    expect(await prisma.manager.count({ where: { leagueId: league.id } })).toBe(1);

    const standing = await prisma.teamStanding.findUniqueOrThrow({
      where: { seasonId_teamId: { seasonId: season.id, teamId: existing.id } },
    });
    expect(standing).toMatchObject({ rank: 3, wins: 9, losses: 6 });
  });

  it("leaves unmatched Yahoo teams unlinked (no placeholder teams) while Antlerboard teams await linking", async () => {
    const { league } = await setupConnectedLeague();
    await existingTeam(league.id, "Moose Tracks", "Alex");
    wireMock({
      standings: standingsResponse([{ key: "422.l.1.t.1", name: "Yahoo Name Differs", rank: "1", wins: "1", losses: "0" }]),
    });

    const result = await runYahooSync(league.id);

    const teams = await prisma.team.findMany({ where: { leagueId: league.id } });
    expect(teams.map((t) => t.name)).toEqual(["Moose Tracks"]);
    expect(teams[0].yahooTeamId).toBeNull();
    expect(await prisma.manager.count({ where: { leagueId: league.id, name: { startsWith: "Unassigned" } } })).toBe(0);

    const section = result.sections.find((s) => s.section === "teams+standings")!;
    expect(section.error).toContain("Yahoo Name Differs");
    expect(section.error).toContain("Commissioner > Yahoo");
    expect(result.status).toBe("PARTIAL");
  });

  it("updates a linked team's name from Yahoo and keeps its id and manager", async () => {
    const { league } = await setupConnectedLeague();
    const existing = await existingTeam(league.id, "Old Name", "Alex");
    await prisma.team.update({ where: { id: existing.id }, data: { yahooTeamId: "422.l.1.t.1" } });
    wireMock({
      standings: standingsResponse([{ key: "422.l.1.t.1", name: "New Name", rank: "1", wins: "1", losses: "0" }]),
    });

    await runYahooSync(league.id);

    const after = await prisma.team.findUniqueOrThrow({ where: { id: existing.id } });
    expect(after.name).toBe("New Name");
    expect(after.managerId).toBe(existing.managerId);
  });

  it("records standings against the Yahoo league's own season, not a newer offseason row", async () => {
    const { league, season } = await setupConnectedLeague();
    const nextSeason = await prisma.season.create({ data: { leagueId: league.id, year: 2027, status: "UPCOMING" } });
    wireMock({
      standings: standingsResponse([{ key: "422.l.1.t.1", name: "The Antlers", rank: "1", wins: "10", losses: "5" }], {
        season: "2026",
      }),
      transactions: transactionsResponse([{ key: "422.l.1.tr.9", type: "add", timestamp: "1700000000" }]),
    });

    await runYahooSync(league.id);

    expect(await prisma.teamStanding.count({ where: { seasonId: season.id } })).toBe(1);
    expect(await prisma.teamStanding.count({ where: { seasonId: nextSeason.id } })).toBe(0);
    const tx = await prisma.transaction.findUniqueOrThrow({ where: { yahooTransactionId: "422.l.1.tr.9" } });
    expect(tx.seasonId).toBe(season.id);
  });

  it("reports an error rather than a silent success when Yahoo returns no teams", async () => {
    const { league } = await setupConnectedLeague();
    wireMock({ standings: standingsResponse([]) });

    const result = await runYahooSync(league.id);

    const section = result.sections.find((s) => s.section === "teams+standings")!;
    expect(section.error).toContain("no teams");
    expect(result.status).not.toBe("SUCCESS");
  });

  // Synthetic malformed entries (no team_key anywhere) - not a claimed Yahoo
  // shape, just entries readYahooTeam can't read.
  function withUnreadableTeams(response: ReturnType<typeof standingsResponse>, count: number) {
    const teams = (response.fantasy_content.league[1] as { standings: { teams: Record<string, unknown> }[] })
      .standings[0].teams;
    const existing = Number(teams.count);
    for (let i = 0; i < count; i++) teams[String(existing + i)] = { team: [[{ name: `Unreadable ${i}` }]] };
    teams.count = existing + count;
    return response;
  }

  it("fails the teams step - never SUCCESS - when Yahoo sends team entries but none can be read", async () => {
    const { league } = await setupConnectedLeague();
    await makeManagerAndTeam(league.id, "Alex");
    wireMock({ standings: withUnreadableTeams(standingsResponse([]), 12) });

    const result = await runYahooSync(league.id);

    const section = result.sections.find((s) => s.section === "teams+standings")!;
    expect(section.error).toBe("Yahoo returned 12 team entries for league 422.l.1 but none could be read");
    expect(result.status).not.toBe("SUCCESS");
    const log = await prisma.syncLog.findFirstOrThrow();
    expect(log.status).not.toBe("SUCCESS");
    expect(await prisma.team.count({ where: { yahooTeamId: { not: null } } })).toBe(0);
  });

  it("still syncs the readable teams and reports how many entries it skipped", async () => {
    const { league } = await setupConnectedLeague();
    wireMock({
      standings: withUnreadableTeams(
        standingsResponse([{ key: "422.l.1.t.1", name: "The Antlers", rank: "1", wins: "10", losses: "5" }]),
        2
      ),
    });

    const result = await runYahooSync(league.id);

    const section = result.sections.find((s) => s.section === "teams+standings")!;
    expect(section.error).toContain("2 of 3 Yahoo team entries could not be read");
    expect(result.status).toBe("PARTIAL");
    expect(await prisma.team.count({ where: { yahooTeamId: "422.l.1.t.1" } })).toBe(1);
  });
});

describe("runYahooSync - season safety", () => {
  it("writes no transactions or standings when Antlerboard has no season matching Yahoo's", async () => {
    // Mirrors production: Yahoo says 2026, Antlerboard only has 2022.
    const { league } = await makeLeagueWithSeason(2022);
    const oldSeason = await prisma.season.findFirstOrThrow({ where: { leagueId: league.id } });
    await prisma.yahooConnection.create({
      data: { leagueId: league.id, accessToken: "fake-token", yahooLeagueKey: LEAGUE_KEY, yahooGameKey: "422" },
    });
    wireMock({
      standings: standingsResponse([{ key: "422.l.1.t.1", name: "The Antlers", rank: "1", wins: "10", losses: "5" }], {
        season: "2026",
      }),
      transactions: transactionsResponse([{ key: "422.l.1.tr.1", type: "add", timestamp: "1700000000" }]),
    });

    const result = await runYahooSync(league.id);

    expect(await prisma.transaction.count()).toBe(0);
    expect(await prisma.teamStanding.count({ where: { seasonId: oldSeason.id } })).toBe(0);
    const tx = result.sections.find((s) => s.section === "transactions")!;
    expect(tx.error).toBe("No transactions imported: No 2026 season exists in Antlerboard - create it before syncing");
    const teams = result.sections.find((s) => s.section === "teams+standings")!;
    expect(teams.error).toContain("Standings not recorded: No 2026 season exists in Antlerboard");
    expect(result.status).not.toBe("SUCCESS");
  });

  it("leaves transactions already filed under another season untouched", async () => {
    const { league } = await makeLeagueWithSeason(2022);
    const oldSeason = await prisma.season.findFirstOrThrow({ where: { leagueId: league.id } });
    await prisma.transaction.create({
      data: { seasonId: oldSeason.id, seasonYear: 2022, type: "DROP", yahooTransactionId: "422.l.1.tr.7" },
    });
    await prisma.yahooConnection.create({
      data: { leagueId: league.id, accessToken: "fake-token", yahooLeagueKey: LEAGUE_KEY, yahooGameKey: "422" },
    });
    wireMock({ transactions: transactionsResponse([{ key: "422.l.1.tr.8", type: "add", timestamp: "1700000000" }]) });

    await runYahooSync(league.id);

    const rows = await prisma.transaction.findMany();
    expect(rows.map((r) => [r.yahooTransactionId, r.seasonId])).toEqual([["422.l.1.tr.7", oldSeason.id]]);
  });

  it("writes no transactions when Yahoo doesn't say which season the league is", async () => {
    const { league } = await setupConnectedLeague();
    const noSeason = transactionsResponse([{ key: "422.l.1.tr.1", type: "add", timestamp: "1700000000" }]);
    delete (noSeason.fantasy_content.league[0] as { season?: string }).season;
    wireMock({ transactions: noSeason });

    const result = await runYahooSync(league.id);

    expect(await prisma.transaction.count()).toBe(0);
    expect(result.sections.find((s) => s.section === "transactions")!.error).toContain(
      "Yahoo didn't report which season this league is"
    );
  });
});

describe("runYahooSync - Yahoo API errors", () => {
  it("labels each failed section and explains Yahoo's app-not-authorized 403", async () => {
    const { league } = await setupConnectedLeague();
    // A linked team so the players section really requests (and fails) a roster.
    const manager = await prisma.manager.create({ data: { leagueId: league.id, name: "Alex" } });
    await prisma.team.create({
      data: { leagueId: league.id, yahooTeamId: "422.l.1.t.1", name: "The Antlers", managerId: manager.id },
    });
    mockedGet.mockRejectedValue(
      new YahooApiError(403, "/league/422.l.1/standings", "This application is not authorized to perform this action.")
    );

    const result = await runYahooSync(league.id);

    expect(result.status).toBe("FAILED");
    expect(result.sections.map((s) => s.section)).toEqual(["teams+standings", "players", "transactions"]);
    const teamsSection = result.sections[0];
    expect(teamsSection.error).toContain("hasn't enabled Fantasy Sports API access");

    const connection = await prisma.yahooConnection.findUniqueOrThrow({ where: { leagueId: league.id } });
    expect(connection.lastSyncError).toContain("hasn't enabled Fantasy Sports API access");
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
    wireMock({
      standings: standingsResponse([{ key: "422.l.1.t.1", name: "The Antlers", rank: "1", wins: "10", losses: "5" }]),
    });
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
