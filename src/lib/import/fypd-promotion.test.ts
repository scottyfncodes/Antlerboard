import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { prisma } from "../db";
import { makeLeagueWithSeason, makeManagerAndTeam, resetDatabase } from "../test-helpers";
import { promoteFypdBatch } from "./fypd-promotion";

beforeEach(resetDatabase);
afterAll(resetDatabase);

/** Seeds a manager + team + a TeamSeasonRecord tying them together for a season - what the main historical import writes before any FYPD promotion runs. */
async function makeRosteredManager(leagueId: string, name: string, seasonYear: number) {
  const { manager, team } = await makeManagerAndTeam(leagueId, name);
  await prisma.teamSeasonRecord.create({
    data: { teamId: team.id, seasonYear, teamName: `${name}'s Team`, managerId: manager.id },
  });
  return { manager, team };
}

describe("promoteFypdBatch", () => {
  it("creates a FypdDraft, resolves teams by manager name, and writes FypdSelection rows", async () => {
    const { league } = await makeLeagueWithSeason(2025);
    const teams: Record<string, string> = {};
    for (const name of ["Aaron", "Andrew", "Ed"]) {
      const { team } = await makeRosteredManager(league.id, name, 2025);
      teams[name] = team.id;
    }
    const batch = await prisma.fypdImportBatch.create({
      data: {
        leagueId: league.id,
        label: "Table 1",
        sourceSheet: "FYPD",
        seasonYear: 2025,
        status: "PENDING_REVIEW",
        rawPicks: [
          { overallPickInSource: 1, teamNameRaw: "Aaron", playerName: "Prospect One", positionRaw: "SS", extra: {} },
          { overallPickInSource: 2, teamNameRaw: "Andrew", playerName: "Prospect Two", positionRaw: "RHP", extra: {} },
          { overallPickInSource: 3, teamNameRaw: "Ed", playerName: "Prospect Three", positionRaw: null, extra: {} },
        ],
      },
    });

    const result = await promoteFypdBatch(prisma, batch.id);

    expect(result.picksPromoted).toBe(3);
    expect(result.playersCreated).toBe(3);
    expect(result.skipped).toEqual([]);

    const selections = await prisma.fypdSelection.findMany({ where: { draftId: result.draftId }, orderBy: { overallPick: "asc" } });
    expect(selections).toHaveLength(3);
    expect(selections[0]).toMatchObject({ round: 1, pickInRound: 1, overallPick: 1, teamId: teams.Aaron });

    const player = await prisma.player.findFirst({ where: { name: "Prospect One" } });
    expect(player?.positions).toEqual(["SS"]);
    expect(player?.mlbDraftYear).toBe(2024); // the 2025 FYPD drafts the 2024 MLB class

    const updatedBatch = await prisma.fypdImportBatch.findUniqueOrThrow({ where: { id: batch.id } });
    expect(updatedBatch.status).toBe("CONFIRMED");
    expect(updatedBatch.confirmedAt).not.toBeNull();
  });

  it("keeps an existing player's Yahoo positions and gives a new prospect none when the sheet has no position", async () => {
    const { league } = await makeLeagueWithSeason(2025);
    await makeRosteredManager(league.id, "Andrew", 2025);
    await makeRosteredManager(league.id, "Ed", 2025);
    await prisma.player.create({ data: { leagueId: league.id, name: "Travis Bazzana", yahooPlayerId: "469.p.64311", positions: ["2B", "Util"] } });
    const batch = await prisma.fypdImportBatch.create({
      data: {
        leagueId: league.id,
        label: "Table 2 (cols R-Y)",
        sourceSheet: "FYPD",
        seasonYear: 2025,
        status: "PENDING_REVIEW",
        rawPicks: [
          { overallPickInSource: 1, teamNameRaw: "Andrew", playerName: "Travis Bazzana", positionRaw: null, extra: {} },
          { overallPickInSource: 2, teamNameRaw: "Ed", playerName: "PJ Morlando", positionRaw: null, extra: {} },
        ],
      },
    });

    await promoteFypdBatch(prisma, batch.id);
    const bazzana = await prisma.player.findFirstOrThrow({ where: { name: "Travis Bazzana" } });
    const morlando = await prisma.player.findFirstOrThrow({ where: { name: "PJ Morlando" } });
    expect(bazzana.positions).toEqual(["2B", "Util"]);
    expect(bazzana.yahooPlayerId).toBe("469.p.64311");
    expect(morlando.positions).toEqual([]);
  });

  it("records the round-1 draft order from the source's own pick sequence", async () => {
    const { league } = await makeLeagueWithSeason(2024);
    const names = ["Aaron", "Andrew", "Ed", "Hugo", "Jorge", "Kurt", "MattyJ", "Michael", "Neel", "Scott", "Tyler", "Zach"];
    const teamIds: string[] = [];
    for (const name of names) {
      const { team } = await makeRosteredManager(league.id, name, 2024);
      teamIds.push(team.id);
    }
    const picks = names.map((name, i) => ({
      overallPickInSource: i + 1,
      teamNameRaw: name,
      playerName: `Player ${i + 1}`,
      positionRaw: null,
      extra: {},
    }));
    const batch = await prisma.fypdImportBatch.create({
      data: { leagueId: league.id, label: "Table 2", sourceSheet: "FYPD", seasonYear: 2024, status: "PENDING_REVIEW", rawPicks: picks },
    });

    const result = await promoteFypdBatch(prisma, batch.id);
    const orderSlots = await prisma.fypdDraftOrderSlot.findMany({ where: { draftId: result.draftId }, orderBy: { slot: "asc" } });
    expect(orderSlots.map((s) => s.teamId)).toEqual(teamIds);
  });

  it("skips a pick whose manager name doesn't resolve to a team-season record for that year, without guessing", async () => {
    const { league } = await makeLeagueWithSeason(2025);
    await makeRosteredManager(league.id, "Aaron", 2025);
    const batch = await prisma.fypdImportBatch.create({
      data: {
        leagueId: league.id,
        label: "Table 1",
        sourceSheet: "FYPD",
        seasonYear: 2025,
        status: "PENDING_REVIEW",
        rawPicks: [
          { overallPickInSource: 1, teamNameRaw: "Aaron", playerName: "Real Pick", positionRaw: null, extra: {} },
          { overallPickInSource: 2, teamNameRaw: "Ghost", playerName: "Unresolvable Pick", positionRaw: null, extra: {} },
        ],
      },
    });

    const result = await promoteFypdBatch(prisma, batch.id);
    expect(result.picksPromoted).toBe(1);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].playerName).toBe("Unresolvable Pick");
    expect(result.skipped[0].reason).toMatch(/no current manager\/team found named "ghost"/i);
  });

  it("resolves by the manager's CURRENT team, not who ran it the year of the pick", async () => {
    // Mirrors the real bug found against the actual workbook: Neel took
    // over that franchise in 2025, but the 2024 FYPD sheet already lists
    // "Neel" for that franchise's picks (the sheet always shows the
    // current owner) - a season-scoped TeamSeasonRecord lookup for 2024
    // would incorrectly find nothing for Neel and skip a valid pick.
    const { league } = await makeLeagueWithSeason(2025);
    const { manager, team } = await makeManagerAndTeam(league.id, "Neel");
    await prisma.teamSeasonRecord.create({
      data: { teamId: team.id, seasonYear: 2025, teamName: "Big Fat Panda", managerId: manager.id },
    });
    // No TeamSeasonRecord for 2024 at all - that year belonged to a
    // predecessor this test doesn't need to model.
    const batch = await prisma.fypdImportBatch.create({
      data: {
        leagueId: league.id,
        label: "Table 2",
        sourceSheet: "FYPD",
        seasonYear: 2024,
        status: "PENDING_REVIEW",
        rawPicks: [{ overallPickInSource: 4, teamNameRaw: "Neel", playerName: "Nick Kurtz", positionRaw: "1B", extra: {} }],
      },
    });

    const result = await promoteFypdBatch(prisma, batch.id);
    expect(result.skipped).toEqual([]);
    expect(result.picksPromoted).toBe(1);
    const selection = await prisma.fypdSelection.findFirst({ where: { draftId: result.draftId } });
    expect(selection?.teamId).toBe(team.id);
  });

  it("matches a manager name across a whitespace quirk (\"Matty J\" vs \"MattyJ\")", async () => {
    const { league } = await makeLeagueWithSeason(2024);
    const { team } = await makeRosteredManager(league.id, "MattyJ", 2024);
    const batch = await prisma.fypdImportBatch.create({
      data: {
        leagueId: league.id,
        label: "Table 2",
        sourceSheet: "FYPD",
        seasonYear: 2024,
        status: "PENDING_REVIEW",
        rawPicks: [{ overallPickInSource: 1, teamNameRaw: "Matty J", playerName: "Some Prospect", positionRaw: null, extra: {} }],
      },
    });

    const result = await promoteFypdBatch(prisma, batch.id);
    expect(result.picksPromoted).toBe(1);
    const selection = await prisma.fypdSelection.findFirst({ where: { draftId: result.draftId } });
    expect(selection?.teamId).toBe(team.id);
  });

  it("refuses to promote a batch that's already been promoted or discarded", async () => {
    const { league } = await makeLeagueWithSeason(2025);
    const batch = await prisma.fypdImportBatch.create({
      data: { leagueId: league.id, label: "Table 1", sourceSheet: "FYPD", seasonYear: 2025, status: "CONFIRMED", rawPicks: [] },
    });
    await expect(promoteFypdBatch(prisma, batch.id)).rejects.toThrow(/not PENDING_REVIEW/);
  });

  it("refuses to promote a batch whose season year hasn't been confirmed", async () => {
    const { league } = await makeLeagueWithSeason(2025);
    const batch = await prisma.fypdImportBatch.create({
      data: { leagueId: league.id, label: "Table 1", sourceSheet: "FYPD", seasonYear: null, status: "PENDING_REVIEW", rawPicks: [] },
    });
    await expect(promoteFypdBatch(prisma, batch.id)).rejects.toThrow(/season year/i);
  });

  it("refuses a batch that would overwrite a stored draft's picks with different players, writing nothing", async () => {
    // The production hazard: a copy of the 2024 draft labelled 2025.
    const { league } = await makeLeagueWithSeason(2025);
    const { team } = await makeRosteredManager(league.id, "Ed", 2025);
    const anderson = await prisma.player.create({ data: { leagueId: league.id, name: "Kade Anderson" } });
    const draft = await prisma.fypdDraft.create({ data: { leagueId: league.id, year: 2025, rounds: 5, status: "COMPLETE" } });
    await prisma.fypdSelection.create({ data: { draftId: draft.id, round: 1, pickInRound: 1, overallPick: 1, teamId: team.id, playerId: anderson.id } });
    const batch = await prisma.fypdImportBatch.create({
      data: {
        leagueId: league.id,
        label: "Table 1 (cols A-D)",
        sourceSheet: "FYPD",
        seasonYear: 2025,
        status: "PENDING_REVIEW",
        rawPicks: [{ overallPickInSource: 1, teamNameRaw: "Ed", playerName: "Konnor Griffin", positionRaw: "SS", extra: {} }],
      },
    });

    await expect(prisma.$transaction((tx) => promoteFypdBatch(tx, batch.id))).rejects.toThrow(/different player at 1 of them.*Konnor Griffin vs\. stored Kade Anderson/);
    const sel = await prisma.fypdSelection.findFirstOrThrow({ where: { draftId: draft.id }, include: { player: true } });
    expect(sel.player.name).toBe("Kade Anderson");
    expect((await prisma.fypdImportBatch.findUniqueOrThrow({ where: { id: batch.id } })).status).toBe("PENDING_REVIEW");
    expect(await prisma.player.count({ where: { name: "Konnor Griffin" } })).toBe(0);
  });

  it("still allows re-promoting the same picks into an existing draft", async () => {
    const { league } = await makeLeagueWithSeason(2025);
    const { team } = await makeRosteredManager(league.id, "Ed", 2025);
    const anderson = await prisma.player.create({ data: { leagueId: league.id, name: "Kade Anderson" } });
    const draft = await prisma.fypdDraft.create({ data: { leagueId: league.id, year: 2025, rounds: 5, status: "COMPLETE" } });
    await prisma.fypdSelection.create({ data: { draftId: draft.id, round: 1, pickInRound: 1, overallPick: 1, teamId: team.id, playerId: anderson.id } });
    const batch = await prisma.fypdImportBatch.create({
      data: {
        leagueId: league.id,
        label: "Table 1",
        sourceSheet: "FYPD",
        seasonYear: 2025,
        status: "PENDING_REVIEW",
        rawPicks: [{ overallPickInSource: 1, teamNameRaw: "Ed", playerName: "kade anderson ", positionRaw: null, extra: {} }],
      },
    });
    const result = await promoteFypdBatch(prisma, batch.id);
    expect(result.picksPromoted).toBe(1);
  });

  it("never hands a pick to a same-named veteran: skips it for a manual link, and counts only players it created", async () => {
    const { league } = await makeLeagueWithSeason(2025);
    const { team } = await makeRosteredManager(league.id, "Aaron", 2025);
    const lastSeason = await prisma.season.create({ data: { leagueId: league.id, year: 2024 } });
    const veteran = await prisma.player.create({ data: { leagueId: league.id, name: "Max Muncy" } });
    await prisma.acquisition.create({
      data: { seasonId: lastSeason.id, seasonYear: 2024, playerId: veteran.id, teamId: team.id, method: "DRAFT", cost: 12 },
    });
    await makeRosteredManager(league.id, "Bob", 2025);
    await makeRosteredManager(league.id, "Cal", 2025);
    const existingProspect = await prisma.player.create({ data: { leagueId: league.id, name: "Known Prospect" } });
    const batch = await prisma.fypdImportBatch.create({
      data: {
        leagueId: league.id, label: "T", sourceSheet: "FYPD", seasonYear: 2025, status: "PENDING_REVIEW",
        rawPicks: [
          { overallPickInSource: 1, teamNameRaw: "Aaron", playerName: "Max Muncy", positionRaw: "SS", extra: {} },
          { overallPickInSource: 2, teamNameRaw: "Bob", playerName: "Known Prospect", positionRaw: null, extra: {} },
          { overallPickInSource: 3, teamNameRaw: "Cal", playerName: "Brand New", positionRaw: null, extra: {} },
        ],
      },
    });

    const result = await promoteFypdBatch(prisma, batch.id);

    expect(result.skipped.map((s) => s.playerName)).toEqual(["Max Muncy"]);
    expect(result.picksPromoted).toBe(2);
    expect(result.playersCreated).toBe(1);
    const selections = await prisma.fypdSelection.findMany({ orderBy: { overallPick: "asc" } });
    expect(selections.map((x) => x.playerId)).not.toContain(veteran.id);
    expect(selections[0].playerId).toBe(existingProspect.id);
  });
});
