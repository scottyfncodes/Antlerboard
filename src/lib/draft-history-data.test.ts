import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { prisma } from "./db";
import { makeLeagueWithSeason, makeManagerAndTeam, makePlayer, resetDatabase } from "./test-helpers";
import { listDraftSeasons, loadDraftHistory, loadTeamDraftPicks } from "./draft-history-data";
import { listCostSeasons, loadPlayerCostRows } from "./player-costs-data";

// Integration tests against the test database: the loaders' queries must
// scope to one season and one league, and must not trust status columns.

beforeEach(resetDatabase);
afterAll(resetDatabase);

async function setup() {
  const { league, season: s2026 } = await makeLeagueWithSeason(2026);
  const s2025 = await prisma.season.create({ data: { leagueId: league.id, year: 2025, status: "COMPLETE" } });
  const teams = [];
  for (let i = 0; i < 2; i++) teams.push((await makeManagerAndTeam(league.id, `M${i}`)).team);
  return { league, s2025, s2026, teams };
}

describe("draft history loaders", () => {
  it("returns no data for a season marked COMPLETE that has no picks stored", async () => {
    const { league } = await setup();
    const seasons = await listDraftSeasons(league.id);
    const s2025 = seasons.find((s) => s.year === 2025)!;
    expect(s2025.auction.status).toBe("none");
    expect(s2025.fypd).toBeNull();
    expect((await loadDraftHistory(league.id, 2025, "fypd")).completeness.status).toBe("none");
  });

  it("reports a COMPLETE-status FYPD with missing picks as incomplete", async () => {
    // A synthetic 2-pick draft, in a year with no confirmed final pick
    // (FYPD_CONFIRMED_FINAL_PICKS is tested separately below).
    const { league, teams } = await setup();
    const draft = await prisma.fypdDraft.create({ data: { leagueId: league.id, year: 2024, rounds: 2, status: "COMPLETE" } });
    await prisma.fypdDraftOrderSlot.createMany({
      data: teams.map((t, i) => ({ draftId: draft.id, teamId: t.id, slot: i + 1, reason: "test" })),
    });
    const p1 = await makePlayer(league.id, "Prospect One");
    const p2 = await makePlayer(league.id, "Prospect Two");
    await prisma.fypdSelection.createMany({
      data: [
        { draftId: draft.id, round: 1, pickInRound: 1, overallPick: 1, teamId: teams[0].id, playerId: p1.id },
        { draftId: draft.id, round: 1, pickInRound: 2, overallPick: 2, teamId: teams[1].id, playerId: p2.id },
      ],
    });
    const summary = (await listDraftSeasons(league.id)).find((s) => s.year === 2024)!;
    expect(summary.fypd).toMatchObject({ status: "incomplete", recorded: 2, expected: 4 });
    const h = await loadDraftHistory(league.id, 2024, "fypd");
    expect(h.picks.map((p) => p.originalSlot.status)).toEqual(["known", "known"]);
  });

  it("keeps each season's auction picks separate", async () => {
    const { league, s2025, s2026, teams } = await setup();
    const p = await makePlayer(league.id, "Slugger");
    await prisma.draftPick.create({ data: { seasonId: s2025.id, seasonYear: 2025, round: 1, pick: 1, overallPick: 1, teamId: teams[0].id, playerId: p.id, cost: 30 } });
    await prisma.draftPick.create({ data: { seasonId: s2026.id, seasonYear: 2026, round: 1, pick: 1, overallPick: 1, teamId: teams[1].id, playerId: p.id, cost: null } });
    const h25 = await loadDraftHistory(league.id, 2025, "auction");
    const h26 = await loadDraftHistory(league.id, 2026, "auction");
    expect(h25.picks.map((x) => x.cost)).toEqual([30]);
    expect(h26.picks.map((x) => x.cost)).toEqual([null]);
  });

  it("never returns another league's drafts", async () => {
    const { league } = await setup();
    const other = await prisma.league.create({ data: { name: "Other", abbreviation: "O" } });
    const otherSeason = await prisma.season.create({ data: { leagueId: other.id, year: 2026 } });
    const otherTeam = (await makeManagerAndTeam(other.id, "Outsider")).team;
    await prisma.draftPick.create({ data: { seasonId: otherSeason.id, seasonYear: 2026, round: 1, pick: 1, overallPick: 1, teamId: otherTeam.id, cost: 5 } });
    expect((await loadDraftHistory(league.id, 2026, "auction")).picks).toEqual([]);
  });
});

describe("player cost loaders", () => {
  it("shows rostered players with Unavailable costs when nothing is recorded", async () => {
    const { league, s2026, teams } = await setup();
    const p = await makePlayer(league.id, "Rostered Guy");
    await prisma.rosterSpot.create({
      data: { seasonId: s2026.id, teamId: teams[0].id, playerId: p.id, yahooPlayerKey: "469.p.1", onTeamSince: new Date(), lastSeenAt: new Date() },
    });
    const rows = await loadPlayerCostRows(league.id, 2026, 2026);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ hasRecordedCost: false, keeper: null, auction: [], acquisitions: [] });
    expect(rows[0].currentStatus).toMatchObject({ kind: "team" });
  });

  it("lists a past season only from that season's cost records, never today's roster", async () => {
    const { league, s2025, s2026, teams } = await setup();
    const kept = await makePlayer(league.id, "Kept In 2025");
    const rostered = await makePlayer(league.id, "Only Rostered Now");
    await prisma.rosterSpot.create({
      data: { seasonId: s2026.id, teamId: teams[1].id, playerId: rostered.id, yahooPlayerKey: "469.p.2", onTeamSince: new Date(), lastSeenAt: new Date() },
    });
    await prisma.keeperRecord.create({
      data: { seasonId: s2025.id, seasonYear: 2025, playerId: kept.id, teamId: teams[0].id, startTeamId: teams[0].id, keeperYear: 2, keeperCost: 14, yearsRemaining: 3, status: "KEPT" },
    });

    // No acquisition on record for the stint: the stored 14 can't be traced, so it isn't shown as a cost.
    let rows2025 = await loadPlayerCostRows(league.id, 2025, 2026);
    expect(rows2025.map((r) => r.player.name)).toEqual(["Kept In 2025"]);
    expect(rows2025[0].keeper).toMatchObject({ keeperYear: 2, cost: { status: "unavailable" } });

    // With the 2023 auction price on record it is a calculated cost.
    const s2023 = await prisma.season.create({ data: { leagueId: league.id, year: 2023, status: "COMPLETE" } });
    await prisma.acquisition.create({
      data: { seasonId: s2023.id, seasonYear: 2023, playerId: kept.id, teamId: teams[0].id, method: "DRAFT", cost: 10, sourceRef: "league-history:auction:x|price=recorded" },
    });
    rows2025 = await loadPlayerCostRows(league.id, 2025, 2026);
    expect(rows2025[0].keeper).toMatchObject({ keeperYear: 2, cost: { status: "recorded", amount: 14, basis: "calculated" } });
    // The 2023 acquisition is read for provenance only - it isn't a 2025 cost.
    expect(rows2025[0].acquisitions).toEqual([]);

    const rows2026 = await loadPlayerCostRows(league.id, 2026, 2026);
    expect(rows2026.map((r) => r.player.name)).toEqual(["Only Rostered Now"]);
    expect(await listCostSeasons(league.id, 2026)).toEqual([2026, 2025, 2023]);
  });

});

describe("commissioner-confirmed FYPD final pick", () => {
  it("uses the commissioner-confirmed final pick for the 2026 FYPD (FYPD_CONFIRMED_FINAL_PICKS)", async () => {
    const { league, teams } = await setup();
    const draft = await prisma.fypdDraft.create({ data: { leagueId: league.id, year: 2026, rounds: 30, status: "COMPLETE" } });
    await prisma.fypdDraftOrderSlot.createMany({ data: teams.map((t, i) => ({ draftId: draft.id, teamId: t.id, slot: i + 1, reason: "test" })) });
    for (let n = 1; n <= 53; n++) {
      const p = await makePlayer(league.id, `Prospect ${n}`);
      await prisma.fypdSelection.create({
        data: { draftId: draft.id, round: Math.ceil(n / 2), pickInRound: ((n - 1) % 2) + 1, overallPick: n, teamId: teams[(n - 1) % 2].id, playerId: p.id },
      });
    }
    const summary = (await listDraftSeasons(league.id)).find((s) => s.year === 2026)!;
    expect(summary.fypd).toMatchObject({ status: "complete", recorded: 53, expected: 53 });
    expect((await loadDraftHistory(league.id, 2026, "fypd")).completeness).toMatchObject({ status: "complete", expected: 53 });
  });

  it("applies only to the 2026 FYPD: a short 2025 FYPD is still incomplete", async () => {
    const { league, teams } = await setup();
    const draft = await prisma.fypdDraft.create({ data: { leagueId: league.id, year: 2025, rounds: 30, status: "COMPLETE" } });
    await prisma.fypdDraftOrderSlot.createMany({ data: teams.map((t, i) => ({ draftId: draft.id, teamId: t.id, slot: i + 1, reason: "test" })) });
    for (let n = 1; n <= 53; n++) {
      const p = await makePlayer(league.id, `Prospect ${n}`);
      await prisma.fypdSelection.create({
        data: { draftId: draft.id, round: Math.ceil(n / 2), pickInRound: ((n - 1) % 2) + 1, overallPick: n, teamId: teams[(n - 1) % 2].id, playerId: p.id },
      });
    }
    expect((await listDraftSeasons(league.id)).find((s) => s.year === 2025)!.fypd).toMatchObject({ status: "incomplete", recorded: 53, expected: 60 });
  });
});

// A team's auction picks per season in production (2021-2026: 115 in all).
const PICKS_PER_SEASON: Record<number, number> = { 2021: 22, 2022: 20, 2023: 20, 2024: 18, 2025: 18, 2026: 17 };

async function seedSixSeasons() {
  const { league, s2025, s2026, teams } = await setup();
  const seasonId: Record<number, string> = { 2025: s2025.id, 2026: s2026.id };
  for (const year of [2021, 2022, 2023, 2024]) {
    seasonId[year] = (await prisma.season.create({ data: { leagueId: league.id, year, status: "COMPLETE" } })).id;
  }
  for (const [y, n] of Object.entries(PICKS_PER_SEASON)) {
    const year = Number(y);
    const data = [];
    // teams[0] takes the odd overall picks, teams[1] the even ones.
    for (let i = 0; i < n * 2; i++) {
      data.push({ seasonId: seasonId[year], seasonYear: year, round: 1, pick: i + 1, overallPick: i + 1, teamId: teams[i % 2].id, cost: 1, sourceRef: `league-history:auction:${year}:${i + 1} order=source` });
    }
    await prisma.draftPick.createMany({ data });
  }
  return { league, teams };
}

describe("a team's Draft tab (loadTeamDraftPicks)", () => {
  // Root cause of "Draft history stops at 2024": the team Draft tab's query
  // took only the newest 40 picks, so a team with 115 picks showed 2026
  // (17) and 2025 (18) in full, then 5 of 2024's 18, and nothing earlier.
  it("returns every season's picks, 2026 back to 2021, not just the newest 40", async () => {
    const { teams } = await seedSixSeasons();
    const picks = await loadTeamDraftPicks(teams[0].id);
    expect(picks).toHaveLength(115);
    const perSeason: Record<number, number> = {};
    for (const p of picks) perSeason[p.seasonYear] = (perSeason[p.seasonYear] ?? 0) + 1;
    expect(perSeason).toEqual(PICKS_PER_SEASON);
  });

  it("keeps newest season first and nomination order within a season, for this team only", async () => {
    const { teams } = await seedSixSeasons();
    const picks = await loadTeamDraftPicks(teams[0].id);
    expect([...new Set(picks.map((p) => p.seasonYear))]).toEqual([2026, 2025, 2024, 2023, 2022, 2021]);
    const y2026 = picks.filter((p) => p.seasonYear === 2026).map((p) => p.overallPick);
    expect(y2026).toEqual([...y2026].sort((a, b) => a - b));
    expect(picks.every((p) => p.teamId === teams[0].id)).toBe(true);
  });
});

describe("Draft History seasons with 2025 and 2026 auctions", () => {
  it("lists the 2025 and 2026 auctions with their own pick counts, separate from the FYPD", async () => {
    const { league, teams } = await seedSixSeasons();
    const fypd = await prisma.fypdDraft.create({ data: { leagueId: league.id, year: 2025, rounds: 5, status: "COMPLETE", currentOverallPick: 2 } });
    const prospect = await makePlayer(league.id, "Konnor Griffin");
    await prisma.fypdSelection.create({ data: { draftId: fypd.id, overallPick: 1, round: 1, pickInRound: 1, teamId: teams[0].id, playerId: prospect.id } });

    const seasons = await listDraftSeasons(league.id);
    expect(seasons.map((s) => s.year)).toEqual([2026, 2025, 2024, 2023, 2022, 2021]);
    const byYear = new Map(seasons.map((s) => [s.year, s]));
    // Auction counts come from DraftPick only; the FYPD pick doesn't add to them.
    expect(byYear.get(2026)!.auction).toMatchObject({ recorded: 34 });
    expect(byYear.get(2025)!.auction).toMatchObject({ recorded: 36 });
    expect(byYear.get(2024)!.auction).toMatchObject({ recorded: 36 });
    expect(byYear.get(2025)!.fypd).not.toBeNull();
    expect(byYear.get(2026)!.fypd).toBeNull();

    const auction2026 = await loadDraftHistory(league.id, 2026, "auction");
    const fypd2025 = await loadDraftHistory(league.id, 2025, "fypd");
    expect(auction2026.picks).toHaveLength(34);
    expect(fypd2025.picks.map((p) => p.player?.name)).toEqual(["Konnor Griffin"]);
  });
});
