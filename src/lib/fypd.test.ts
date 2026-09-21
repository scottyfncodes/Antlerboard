import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { prisma } from "./db";
import {
  createFypdDraft,
  startFypdDraft,
  makeFypdSelection,
  undoLastFypdSelection,
  exerciseFypdCallUp,
  FypdActionError,
} from "./fypd";
import { makeLeagueWithSeason, makeManagerAndTeam, makePlayer, resetDatabase } from "./test-helpers";

beforeEach(resetDatabase);
afterAll(resetDatabase);

async function makeTwelveTeamLeagueWithStandings(prevYear: number) {
  const { league, season: prevSeason } = await makeLeagueWithSeason(prevYear);
  const teams = [];
  for (let i = 1; i <= 12; i++) {
    const { team } = await makeManagerAndTeam(league.id, `Manager ${i}`);
    teams.push(team);
    await prisma.teamStanding.create({
      data: { seasonId: prevSeason.id, teamId: team.id, rank: i, wins: 20 - i, losses: i },
    });
  }
  // The draft year's own season must also exist for the draft to hang off of.
  await prisma.season.create({ data: { leagueId: league.id, year: prevYear + 1, status: "UPCOMING" } });
  return { league, teams }; // teams[0] = rank 1 (best) ... teams[11] = rank 12 (worst)
}

describe("createFypdDraft", () => {
  it("computes and persists the round-1 order from the previous season's standings", async () => {
    const { league, teams } = await makeTwelveTeamLeagueWithStandings(2026);
    const ninthBrigade = teams[11]; // rank 12
    const draft = await createFypdDraft(league.id, 2027, 2, ninthBrigade.id);

    const order = await prisma.fypdDraftOrderSlot.findMany({ where: { draftId: draft.id }, orderBy: { slot: "asc" } });
    expect(order).toHaveLength(12);
    expect(order[0]).toMatchObject({ teamId: ninthBrigade.id, reason: "9th Brigade" });
    expect(order[order.length - 1].teamId).toBe(teams[0].id); // 1st place drafts last
  });

  it("rejects when standings for the prior season are incomplete", async () => {
    const { league } = await makeLeagueWithSeason(2026);
    await prisma.season.create({ data: { leagueId: league.id, year: 2027, status: "UPCOMING" } });
    await expect(createFypdDraft(league.id, 2027, 2, "whatever")).rejects.toThrow(FypdActionError);
  });
});

describe("makeFypdSelection", () => {
  async function setupInProgressDraft() {
    const { league, teams } = await makeTwelveTeamLeagueWithStandings(2026);
    const draft = await createFypdDraft(league.id, 2027, 2, teams[11].id);
    await startFypdDraft(draft.id);
    const player1 = await makePlayer(league.id, "Prospect One");
    const player2 = await makePlayer(league.id, "Prospect Two");
    return { league, teams, draft, player1, player2 };
  }

  it("assigns the pick to the team on the clock per the snake order and advances the pointer", async () => {
    const { teams, draft, player1 } = await setupInProgressDraft();

    const selection = await makeFypdSelection(draft.id, player1.id);
    expect(selection.teamId).toBe(teams[11].id); // 9th Brigade picks first
    expect(selection.round).toBe(1);
    expect(selection.overallPick).toBe(1);

    const updated = await prisma.fypdDraft.findUniqueOrThrow({ where: { id: draft.id } });
    expect(updated.currentOverallPick).toBe(2);
  });

  it("rejects selecting a player who was already picked in this draft", async () => {
    const { draft, player1 } = await setupInProgressDraft();
    await makeFypdSelection(draft.id, player1.id);
    await expect(makeFypdSelection(draft.id, player1.id)).rejects.toThrow(/already been selected/);
  });

  it("rejects making a selection when the draft is not in progress", async () => {
    const { league, teams } = await makeTwelveTeamLeagueWithStandings(2026);
    const draft = await createFypdDraft(league.id, 2027, 2, teams[11].id);
    const player = await makePlayer(league.id, "Prospect");
    await expect(makeFypdSelection(draft.id, player.id)).rejects.toThrow(/not in progress|SETUP/i);
  });

  it("auto-completes the draft after the last pick of the last round", async () => {
    const { league, teams } = await makeTwelveTeamLeagueWithStandings(2026);
    const draft = await createFypdDraft(league.id, 2027, 1, teams[11].id); // 1 round = 12 total picks
    await startFypdDraft(draft.id);

    for (let i = 0; i < 12; i++) {
      const player = await makePlayer(league.id, `Prospect ${i}`);
      await makeFypdSelection(draft.id, player.id);
    }
    const lastDraftState = await prisma.fypdDraft.findUniqueOrThrow({ where: { id: draft.id } });
    expect(lastDraftState.status).toBe("COMPLETE");
    expect(lastDraftState.completedAt).not.toBeNull();
  });
});

describe("undoLastFypdSelection", () => {
  it("removes the most recent selection and rewinds the pick pointer", async () => {
    const { league, teams } = await makeTwelveTeamLeagueWithStandings(2026);
    const draft = await createFypdDraft(league.id, 2027, 2, teams[11].id);
    await startFypdDraft(draft.id);
    const player = await makePlayer(league.id, "Prospect");
    await makeFypdSelection(draft.id, player.id);

    await undoLastFypdSelection(draft.id);

    const count = await prisma.fypdSelection.count({ where: { draftId: draft.id } });
    expect(count).toBe(0);
    const updated = await prisma.fypdDraft.findUniqueOrThrow({ where: { id: draft.id } });
    expect(updated.currentOverallPick).toBe(1);
  });

  it("reopens a draft that had just auto-completed", async () => {
    const { league, teams } = await makeTwelveTeamLeagueWithStandings(2026);
    const draft = await createFypdDraft(league.id, 2027, 1, teams[11].id);
    await startFypdDraft(draft.id);
    for (let i = 0; i < 12; i++) {
      const player = await makePlayer(league.id, `Prospect ${i}`);
      await makeFypdSelection(draft.id, player.id);
    }

    await undoLastFypdSelection(draft.id);

    const updated = await prisma.fypdDraft.findUniqueOrThrow({ where: { id: draft.id } });
    expect(updated.status).toBe("IN_PROGRESS");
    expect(updated.currentOverallPick).toBe(12);
  });
});

describe("exerciseFypdCallUp", () => {
  it("marks the call-up exercised and clears DPUD status without deleting the historical selection", async () => {
    const { league, teams } = await makeTwelveTeamLeagueWithStandings(2026);
    const draft = await createFypdDraft(league.id, 2027, 1, teams[11].id);
    await startFypdDraft(draft.id);
    const player = await makePlayer(league.id, "Prospect");
    const selection = await makeFypdSelection(draft.id, player.id);
    await prisma.fypdSelection.update({ where: { id: selection.id }, data: { isDpud: true } });

    await exerciseFypdCallUp(selection.id);

    const after = await prisma.fypdSelection.findUniqueOrThrow({ where: { id: selection.id } });
    expect(after.callUpExercised).toBe(true);
    expect(after.callUpExercisedAt).not.toBeNull();
    expect(after.isDpud).toBe(false);
    expect(after.id).toBe(selection.id); // same row - never recreated/deleted
  });
});
