import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { makeLeagueWithSeason, resetDatabase } from "@/lib/test-helpers";

vi.mock("@/lib/yahoo/client", () => ({
  yahooFantasyGet: vi.fn(),
}));

import { yahooFantasyGet } from "@/lib/yahoo/client";
import { GET } from "./route";

const mockedGet = vi.mocked(yahooFantasyGet);

beforeEach(async () => {
  await resetDatabase();
  mockedGet.mockReset();
});
afterAll(resetDatabase);

/** Builds a single Yahoo `league` node's field array (the flat, no-subresource shape). */
function leagueNode(fields: Record<string, string | number>) {
  return { league: Object.entries(fields).map(([k, v]) => ({ [k]: v })) };
}

/** Builds the full `/users;use_login=1/games;game_keys=mlb/leagues` response shape. */
function leaguesResponse(games: { gameFields: Record<string, string>; leagues: Record<string, string | number>[] }[]) {
  return {
    fantasy_content: {
      users: {
        "0": {
          user: [
            [{ guid: "yahoo-user-guid" }],
            {
              games: {
                ...Object.fromEntries(
                  games.map((g, i) => [
                    String(i),
                    {
                      game: [
                        Object.entries(g.gameFields).map(([k, v]) => ({ [k]: v })),
                        {
                          leagues: {
                            ...Object.fromEntries(g.leagues.map((l, j) => [String(j), leagueNode(l)])),
                            count: g.leagues.length,
                          },
                        },
                      ],
                    },
                  ])
                ),
                count: games.length,
              },
            },
          ],
        },
        count: 1,
      },
    },
  };
}

const MLB_GAME_FIELDS = { game_key: "431", game_id: "431", name: "Baseball", code: "mlb", season: "2026" };

describe("GET /api/yahoo/leagues", () => {
  it("returns full metadata for every discovered league", async () => {
    await makeLeagueWithSeason();
    mockedGet.mockResolvedValue(
      leaguesResponse([
        {
          gameFields: MLB_GAME_FIELDS,
          leagues: [
            {
              league_key: "431.l.12345",
              league_id: "12345",
              name: "Claw & Antler League",
              season: "2026",
              num_teams: "10",
              draft_status: "postdraft",
              scoring_type: "head",
              league_type: "private",
              url: "https://baseball.fantasysports.yahoo.com/league/clawandantler",
            },
          ],
        },
      ])
    );

    const res = await GET();
    const body = await res.json();

    expect(body.leagues).toHaveLength(1);
    expect(body.leagues[0]).toEqual({
      key: "431.l.12345",
      leagueId: "12345",
      name: "Claw & Antler League",
      season: "2026",
      gameKey: "431",
      gameId: "431",
      gameCode: "mlb",
      numTeams: 10,
      draftStatus: "postdraft",
      isFinished: null,
      scoringType: "head",
      leagueType: "private",
      url: "https://baseball.fantasysports.yahoo.com/league/clawandantler",
      isLikelyClawAndAntler: true,
    });
    expect(body.likelyMatchKey).toBe("431.l.12345");
    expect(body.diagnostic).toBeNull();
  });

  it("identifies the Claw & Antler league among several other leagues", async () => {
    await makeLeagueWithSeason();
    mockedGet.mockResolvedValue(
      leaguesResponse([
        {
          gameFields: MLB_GAME_FIELDS,
          leagues: [
            { league_key: "431.l.1", name: "Dynasty Diamond League", season: "2026", num_teams: "12" },
            { league_key: "431.l.2", name: "Claw & Antler League", season: "2026", num_teams: "10" },
            { league_key: "431.l.3", name: "Office Pool", season: "2026", num_teams: "8" },
          ],
        },
      ])
    );

    const res = await GET();
    const body = await res.json();

    expect(body.leagues).toHaveLength(3);
    expect(body.likelyMatchKey).toBe("431.l.2");
    const flagged = body.leagues.filter((l: { isLikelyClawAndAntler: boolean }) => l.isLikelyClawAndAntler);
    expect(flagged).toHaveLength(1);
    expect(flagged[0].key).toBe("431.l.2");
  });

  it("reports a diagnostic (not an error) when the account has a current game but no leagues", async () => {
    await makeLeagueWithSeason();
    mockedGet.mockResolvedValue(leaguesResponse([{ gameFields: MLB_GAME_FIELDS, leagues: [] }]));

    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.leagues).toEqual([]);
    expect(body.likelyMatchKey).toBeNull();
    expect(body.diagnostic).toMatchObject({ gamesFound: 1 });
    expect(body.diagnostic.message).toMatch(/isn't a member of any leagues/);
  });

  it("reports a diagnostic when Yahoo returns no current-season MLB game at all", async () => {
    await makeLeagueWithSeason();
    mockedGet.mockResolvedValue(leaguesResponse([]));

    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.leagues).toEqual([]);
    expect(body.diagnostic).toMatchObject({ gamesFound: 0 });
    expect(body.diagnostic.message).toMatch(/didn't return a current MLB fantasy game/);
  });

  it("degrades gracefully (200, not 500) when the Yahoo request itself fails", async () => {
    await makeLeagueWithSeason();
    mockedGet.mockRejectedValue(new Error("Yahoo API request failed (401): unauthorized"));

    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.leagues).toEqual([]);
    expect(body.error).toMatch(/unauthorized/);
  });

  it("never includes token or credential data in the response", async () => {
    await makeLeagueWithSeason();
    mockedGet.mockResolvedValue(
      leaguesResponse([
        {
          gameFields: MLB_GAME_FIELDS,
          leagues: [{ league_key: "431.l.2", name: "Claw & Antler League", season: "2026" }],
        },
      ])
    );

    const res = await GET();
    const text = await res.text();
    expect(text).not.toMatch(/access_token|refresh_token|client_secret/i);
  });

  it("returns 500 when no league is configured at all", async () => {
    const res = await GET();
    expect(res.status).toBe(500);
  });
});
