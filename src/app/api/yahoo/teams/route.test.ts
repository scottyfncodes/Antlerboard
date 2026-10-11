import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { prisma } from "@/lib/db";
import { makeLeagueWithSeason, makeManagerAndTeam, resetDatabase } from "@/lib/test-helpers";

vi.mock("@/lib/yahoo/client", () => ({ yahooFantasyGet: vi.fn() }));
vi.mock("@/lib/current-manager", () => ({ requireCommissioner: vi.fn() }));

import { yahooFantasyGet } from "@/lib/yahoo/client";
import { requireCommissioner } from "@/lib/current-manager";
import { GET, POST } from "./route";

const mockedGet = vi.mocked(yahooFantasyGet);
const mockedRequireCommissioner = vi.mocked(requireCommissioner);

beforeEach(async () => {
  await resetDatabase();
  mockedGet.mockReset();
  mockedRequireCommissioner.mockReset();
  mockedRequireCommissioner.mockResolvedValue({ id: "commish" } as Awaited<ReturnType<typeof requireCommissioner>>);
});
afterAll(resetDatabase);

/** Yahoo's /league/{key}/teams shape: league[1].teams, each team [meta fields]. */
function teamsResponse(teams: { key: string; name: string; nickname: string }[]) {
  return {
    fantasy_content: {
      league: [
        { league_key: "422.l.1", season: "2026" },
        {
          teams: {
            ...Object.fromEntries(
              teams.map((t, i) => [
                String(i),
                { team: [[{ team_key: t.key }, { name: t.name }, [], { managers: [{ manager: { nickname: t.nickname } }] }]] },
              ])
            ),
            count: teams.length,
          },
        },
      ],
    },
  };
}

async function setup() {
  const { league } = await makeLeagueWithSeason();
  await prisma.yahooConnection.create({
    data: { leagueId: league.id, accessToken: "a", refreshToken: "r", yahooLeagueKey: "422.l.1" },
  });
  const alex = await makeManagerAndTeam(league.id, "Alex"); // team "Alex's Team"
  const blake = await makeManagerAndTeam(league.id, "Blake");
  return { league, alex, blake };
}

const post = (body: unknown) =>
  POST(new Request("https://antlerboard.test/api/yahoo/teams", { method: "POST", body: JSON.stringify(body) }));

describe("GET /api/yahoo/teams", () => {
  it("lists Yahoo teams with suggested links by team name, then manager nickname", async () => {
    const { alex, blake } = await setup();
    mockedGet.mockResolvedValueOnce(
      teamsResponse([
        { key: "422.l.1.t.1", name: "Alex's Team", nickname: "someone" },
        { key: "422.l.1.t.2", name: "Different Name", nickname: "blake" },
        { key: "422.l.1.t.3", name: "Nobody", nickname: "zed" },
      ])
    );

    const data = await (await GET()).json();

    expect(mockedGet.mock.calls[0][1]).toBe("/league/422.l.1/teams");
    expect(data.yahooTeams.map((t: { suggestedTeamId: string | null }) => t.suggestedTeamId)).toEqual([
      alex.team.id,
      blake.team.id,
      null,
    ]);
    expect(data.antlerboardTeams).toHaveLength(2);
  });

  it("reports Yahoo failures instead of crashing", async () => {
    await setup();
    mockedGet.mockRejectedValueOnce(new Error("Yahoo API request failed (403)"));
    const res = await GET();
    expect(res.status).toBe(502);
    expect((await res.json()).error).toContain("403");
  });

  it("refuses a non-commissioner", async () => {
    mockedRequireCommissioner.mockResolvedValueOnce(null);
    expect((await GET()).status).toBe(403);
  });
});

describe("POST /api/yahoo/teams", () => {
  it("links teams without creating or deleting any team or manager", async () => {
    const { league, alex, blake } = await setup();

    const res = await post({
      links: [
        { yahooTeamKey: "422.l.1.t.1", teamId: alex.team.id },
        { yahooTeamKey: "422.l.1.t.2", teamId: blake.team.id },
      ],
    });

    expect(res.status).toBe(200);
    const teams = await prisma.team.findMany({ where: { leagueId: league.id }, orderBy: { name: "asc" } });
    expect(teams.map((t) => t.yahooTeamId)).toEqual(["422.l.1.t.1", "422.l.1.t.2"]);
    expect(await prisma.manager.count()).toBe(2);
  });

  it("moves a Yahoo key to a different team and can unlink", async () => {
    const { alex, blake } = await setup();
    await post({ links: [{ yahooTeamKey: "422.l.1.t.1", teamId: alex.team.id }] });

    await post({ links: [{ yahooTeamKey: "422.l.1.t.1", teamId: blake.team.id }] });
    expect((await prisma.team.findUniqueOrThrow({ where: { id: alex.team.id } })).yahooTeamId).toBeNull();
    expect((await prisma.team.findUniqueOrThrow({ where: { id: blake.team.id } })).yahooTeamId).toBe("422.l.1.t.1");

    await post({ links: [{ yahooTeamKey: "422.l.1.t.1", teamId: null }] });
    expect((await prisma.team.findUniqueOrThrow({ where: { id: blake.team.id } })).yahooTeamId).toBeNull();
  });

  it("rejects linking one Antlerboard team to two Yahoo teams", async () => {
    const { alex } = await setup();
    const res = await post({
      links: [
        { yahooTeamKey: "422.l.1.t.1", teamId: alex.team.id },
        { yahooTeamKey: "422.l.1.t.2", teamId: alex.team.id },
      ],
    });
    expect(res.status).toBe(400);
  });

  it("rejects a team from another league", async () => {
    await setup();
    const other = await prisma.league.create({ data: { name: "Other", abbreviation: "OT", currentSeasonYear: 2026 } });
    const outsider = await makeManagerAndTeam(other.id, "Outsider");
    const res = await post({ links: [{ yahooTeamKey: "422.l.1.t.1", teamId: outsider.team.id }] });
    expect(res.status).toBe(400);
    expect((await prisma.team.findUniqueOrThrow({ where: { id: outsider.team.id } })).yahooTeamId).toBeNull();
  });

  it("rejects malformed bodies and non-commissioners", async () => {
    await setup();
    expect((await post({ links: "nope" })).status).toBe(400);
    mockedRequireCommissioner.mockResolvedValueOnce(null);
    expect((await post({ links: [] })).status).toBe(403);
  });
});
