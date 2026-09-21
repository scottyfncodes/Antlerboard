import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { prisma } from "../db";
import { makeLeagueWithSeason, makeManagerAndTeam, resetDatabase } from "../test-helpers";
import { resolveTeamIdByManagerAndYear, resolveTeamIdByCurrentManagerName } from "./team-identity-resolution";

beforeEach(resetDatabase);
afterAll(resetDatabase);

describe("resolveTeamIdByManagerAndYear", () => {
  it("resolves via TeamSeasonRecord for the exact season, not the manager's current team", async () => {
    const { league } = await makeLeagueWithSeason(2025);
    const { manager, team } = await makeManagerAndTeam(league.id, "Aaron");
    await prisma.teamSeasonRecord.create({
      data: { teamId: team.id, seasonYear: 2023, teamName: "Old Name Co.", managerId: manager.id },
    });

    const resolved = await resolveTeamIdByManagerAndYear(prisma, league.id, "Aaron", 2023);
    expect(resolved).toBe(team.id);
  });

  it("returns null when the manager has no record for that exact season", async () => {
    const { league } = await makeLeagueWithSeason(2025);
    const { manager, team } = await makeManagerAndTeam(league.id, "Drew");
    await prisma.teamSeasonRecord.create({
      data: { teamId: team.id, seasonYear: 2022, teamName: "Whatever", managerId: manager.id },
    });

    expect(await resolveTeamIdByManagerAndYear(prisma, league.id, "Drew", 2023)).toBeNull();
  });

  it("matches names with whitespace differences (\"Matty J\" vs \"MattyJ\")", async () => {
    const { league } = await makeLeagueWithSeason(2024);
    const { manager, team } = await makeManagerAndTeam(league.id, "MattyJ");
    await prisma.teamSeasonRecord.create({
      data: { teamId: team.id, seasonYear: 2024, teamName: "The Dead Drifters", managerId: manager.id },
    });

    expect(await resolveTeamIdByManagerAndYear(prisma, league.id, "Matty J", 2024)).toBe(team.id);
  });

  it("returns null for an unknown manager name rather than guessing", async () => {
    const { league } = await makeLeagueWithSeason(2024);
    await makeManagerAndTeam(league.id, "Aaron");

    expect(await resolveTeamIdByManagerAndYear(prisma, league.id, "Nobody", 2024)).toBeNull();
  });

  it("returns null when the season year is null", async () => {
    const { league } = await makeLeagueWithSeason(2024);
    await makeManagerAndTeam(league.id, "Aaron");

    expect(await resolveTeamIdByManagerAndYear(prisma, league.id, "Aaron", null)).toBeNull();
  });

  it("returns null when the manager name is null", async () => {
    const { league } = await makeLeagueWithSeason(2024);
    expect(await resolveTeamIdByManagerAndYear(prisma, league.id, null, 2024)).toBeNull();
  });
});

describe("resolveTeamIdByCurrentManagerName", () => {
  it("resolves to the manager's current team regardless of any season history", async () => {
    const { league } = await makeLeagueWithSeason(2025);
    const { team } = await makeManagerAndTeam(league.id, "Neel");
    // No TeamSeasonRecord at all for this manager - current-team
    // resolution shouldn't need one.
    expect(await resolveTeamIdByCurrentManagerName(prisma, league.id, "Neel")).toBe(team.id);
  });

  it("matches names with whitespace differences", async () => {
    const { league } = await makeLeagueWithSeason(2024);
    const { team } = await makeManagerAndTeam(league.id, "MattyJ");
    expect(await resolveTeamIdByCurrentManagerName(prisma, league.id, "Matty J")).toBe(team.id);
  });

  it("returns null for an unknown manager name", async () => {
    const { league } = await makeLeagueWithSeason(2024);
    await makeManagerAndTeam(league.id, "Aaron");
    expect(await resolveTeamIdByCurrentManagerName(prisma, league.id, "Nobody")).toBeNull();
  });

  it("returns null when the manager name is null", async () => {
    const { league } = await makeLeagueWithSeason(2024);
    expect(await resolveTeamIdByCurrentManagerName(prisma, league.id, null)).toBeNull();
  });

  it("returns null for a manager with no team of their own (a departed predecessor)", async () => {
    const { league } = await makeLeagueWithSeason(2024);
    await prisma.manager.create({ data: { leagueId: league.id, name: "Josh", active: false } });
    expect(await resolveTeamIdByCurrentManagerName(prisma, league.id, "Josh")).toBeNull();
  });
});
