import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { prisma } from "./db";
import { getTradeRosters } from "./rosters";
import { makeLeagueWithSeason, makeManagerAndTeam, makePlayer, resetDatabase } from "./test-helpers";
import { getCurrentManager } from "./current-manager";
import { createSessionToken } from "./auth/session";
import { recomputeKeeperRecordsForPlayer } from "./keeper-sync";
import { CURRENT_SEASON_YEAR } from "./config";

beforeEach(resetDatabase);
afterAll(resetDatabase);

/**
 * The trade form's rosters (Propose a Trade, /trades/new) in production's
 * shape: 2026 rosters synced from Yahoo into RosterSpot, and no 2026 keeper
 * records at all. The form used to list only live keeper records, so every
 * manager's roster - their own and everyone else's - read "No players
 * rostered."
 */
async function yahooLeague() {
  const { league, season } = await makeLeagueWithSeason(CURRENT_SEASON_YEAR);
  const syncedAt = new Date(Date.now() - 3_600_000);
  const andrew = await makeManagerAndTeam(league.id, "Andrew");
  const scott = await makeManagerAndTeam(league.id, "Scott", true);
  const rostered = async (name: string, teamId: string) => {
    const player = await makePlayer(league.id, name);
    await prisma.rosterSpot.create({
      data: { seasonId: season.id, teamId, playerId: player.id, yahooPlayerKey: `469.p.${player.id}`, onTeamSince: syncedAt, lastSeenAt: syncedAt },
    });
    return player;
  };
  return { league, season, andrew, scott, rostered };
}

const rosterNames = (teams: Awaited<ReturnType<typeof getTradeRosters>>, teamId: string) =>
  teams.find((t) => t.id === teamId)?.roster.map((p) => p.name);

describe("trade form rosters", () => {
  it("lists every team's Yahoo roster when there are no keeper records", async () => {
    const { league, andrew, scott, rostered } = await yahooLeague();
    await rostered("Nick Kurtz", andrew.team.id);
    await rostered("Bobby Witt Jr.", andrew.team.id);
    await rostered("Aaron Judge", scott.team.id);
    await makePlayer(league.id, "Free Agent"); // no roster spot
    expect(await prisma.keeperRecord.count()).toBe(0);

    const teams = await getTradeRosters(league.id, CURRENT_SEASON_YEAR);

    expect(rosterNames(teams, andrew.team.id)).toEqual(["Bobby Witt Jr.", "Nick Kurtz"]);
    expect(rosterNames(teams, scott.team.id)).toEqual(["Aaron Judge"]);
  });

  it("gives the logged-in manager their own team and roster", async () => {
    const { andrew, rostered } = await yahooLeague();
    await rostered("Nick Kurtz", andrew.team.id);

    // The page's path: session -> manager -> manager.leagueId -> rosters.
    const manager = await getCurrentManager(await createSessionToken(andrew.manager.id));
    expect(manager?.teams.map((t) => t.id)).toEqual([andrew.team.id]);
    const teams = await getTradeRosters(manager!.leagueId, CURRENT_SEASON_YEAR);

    expect(rosterNames(teams, andrew.team.id)).toEqual(["Nick Kurtz"]);
  });

  it("leaves out inactive teams and other leagues' teams and players", async () => {
    const { league, season, andrew, rostered } = await yahooLeague();
    await rostered("Nick Kurtz", andrew.team.id);
    const gone = await makeManagerAndTeam(league.id, "Gone");
    await prisma.team.update({ where: { id: gone.team.id }, data: { active: false } });

    const other = await makeLeagueWithSeason(CURRENT_SEASON_YEAR);
    const outsider = await makeManagerAndTeam(other.league.id, "Outsider");
    const theirs = await makePlayer(other.league.id, "Their Player");
    await prisma.rosterSpot.create({
      data: { seasonId: other.season.id, teamId: outsider.team.id, playerId: theirs.id, yahooPlayerKey: "469.p.other", onTeamSince: new Date(), lastSeenAt: new Date() },
    });

    const teams = await getTradeRosters(league.id, CURRENT_SEASON_YEAR);
    const ids = teams.map((t) => t.id);
    expect(ids).toContain(andrew.team.id);
    expect(ids).not.toContain(gone.team.id);
    expect(ids).not.toContain(outsider.team.id);
    expect(teams.flatMap((t) => t.roster.map((p) => p.name))).not.toContain("Their Player");
    expect(season.leagueId).toBe(league.id);
  });

  it("shows a player on his new team once a trade is agreed, before Yahoo catches up", async () => {
    const { league, season, andrew, scott, rostered } = await yahooLeague();
    const kurtz = await rostered("Nick Kurtz", andrew.team.id);
    await prisma.acquisition.create({
      data: { seasonId: season.id, seasonYear: CURRENT_SEASON_YEAR, playerId: kurtz.id, teamId: scott.team.id, method: "TRADE", cost: 0 },
    });

    const teams = await getTradeRosters(league.id, CURRENT_SEASON_YEAR);

    expect(rosterNames(teams, andrew.team.id)).toEqual([]);
    expect(rosterNames(teams, scott.team.id)).toEqual(["Nick Kurtz"]);
  });

  it("still uses keeper records for a season with no Yahoo rosters", async () => {
    const { league, season } = await makeLeagueWithSeason(CURRENT_SEASON_YEAR);
    const andrew = await makeManagerAndTeam(league.id, "Andrew");
    const kurtz = await makePlayer(league.id, "Nick Kurtz");
    await prisma.acquisition.create({
      data: { seasonId: season.id, seasonYear: CURRENT_SEASON_YEAR, playerId: kurtz.id, teamId: andrew.team.id, method: "DRAFT", cost: 10 },
    });
    await recomputeKeeperRecordsForPlayer(kurtz.id, CURRENT_SEASON_YEAR);

    const teams = await getTradeRosters(league.id, CURRENT_SEASON_YEAR);

    expect(rosterNames(teams, andrew.team.id)).toEqual(["Nick Kurtz"]);
  });
});
