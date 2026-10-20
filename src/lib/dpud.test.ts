import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { prisma } from "./db";
import { optIntoBet, resolveBet, cancelBet } from "./dpud";
import { makeLeagueWithSeason, makeManagerAndTeam, makePlayer, resetDatabase } from "./test-helpers";

beforeEach(resetDatabase);
afterAll(resetDatabase);

async function makeOpenBet() {
  const { league, season } = await makeLeagueWithSeason();
  const { manager: creator } = await makeManagerAndTeam(league.id, "Creator");
  const { manager: participant } = await makeManagerAndTeam(league.id, "Participant");
  const player = await makePlayer(league.id, "Prop Player");

  const bet = await prisma.dpudBet.create({
    data: {
      seasonId: season.id,
      seasonYear: season.year,
      creatorId: creator.id,
      title: "Test bet",
      description: "desc",
      statCondition: "HR >= 10",
      startDate: new Date(),
      endDate: new Date(Date.now() + 86400000),
      status: "OPEN",
      players: { create: [{ playerId: player.id }] },
    },
  });

  return { bet, creator, participant };
}

describe("DPUD lifecycle", () => {
  it("starts as OPEN and moves to ACTIVE on the first opt-in", async () => {
    const { bet, participant } = await makeOpenBet();
    await optIntoBet(bet.id, participant.id);

    const updated = await prisma.dpudBet.findUniqueOrThrow({ where: { id: bet.id } });
    expect(updated.status).toBe("ACTIVE");

    const participants = await prisma.dpudParticipant.findMany({ where: { betId: bet.id } });
    expect(participants).toHaveLength(1);
    expect(participants[0].managerId).toBe(participant.id);
  });

  it("opting in twice does not create duplicate participant rows", async () => {
    const { bet, participant } = await makeOpenBet();
    await optIntoBet(bet.id, participant.id);
    await optIntoBet(bet.id, participant.id);

    const participants = await prisma.dpudParticipant.count({ where: { betId: bet.id } });
    expect(participants).toBe(1);
  });

  it("resolving a bet records the result and marks it COMPLETE", async () => {
    const { bet, participant } = await makeOpenBet();
    await optIntoBet(bet.id, participant.id);
    const p = await prisma.dpudParticipant.findFirstOrThrow({ where: { betId: bet.id } });

    await resolveBet(bet.id, "Player hit 12 home runs", p.id);

    const updated = await prisma.dpudBet.findUniqueOrThrow({ where: { id: bet.id } });
    expect(updated.status).toBe("COMPLETE");
    expect(updated.result).toBe("Player hit 12 home runs");
    expect(updated.winnerParticipantId).toBe(p.id);
  });

  it("cancelling a bet sets status to CANCELLED", async () => {
    const { bet } = await makeOpenBet();
    await cancelBet(bet.id);
    const updated = await prisma.dpudBet.findUniqueOrThrow({ where: { id: bet.id } });
    expect(updated.status).toBe("CANCELLED");
  });

  it("refuses to re-open a settled bet: no opt-in, re-resolve or cancel after it's complete", async () => {
    const { bet, participant, creator } = await makeOpenBet();
    await optIntoBet(bet.id, participant.id);
    await resolveBet(bet.id, "Done", undefined);
    await expect(optIntoBet(bet.id, creator.id)).rejects.toMatchObject({ status: 409 });
    await expect(resolveBet(bet.id, "Changed", undefined)).rejects.toMatchObject({ status: 409 });
    await expect(cancelBet(bet.id)).rejects.toMatchObject({ status: 409 });
    expect((await prisma.dpudBet.findUniqueOrThrow({ where: { id: bet.id } })).result).toBe("Done");
  });

  it("needs a result, and a winner who is actually in the bet", async () => {
    const { bet, participant } = await makeOpenBet();
    await optIntoBet(bet.id, participant.id);
    await expect(resolveBet(bet.id, "  ", undefined)).rejects.toMatchObject({ status: 400 });
    await expect(resolveBet(bet.id, "Done", "someone-else")).rejects.toMatchObject({ status: 400 });
    expect((await prisma.dpudBet.findUniqueOrThrow({ where: { id: bet.id } })).status).toBe("ACTIVE");
  });
});
