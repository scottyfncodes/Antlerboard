import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { prisma } from "./db";
import { acceptOffer, rejectOffer, withdrawOffer, offerProposalProblem } from "./offers";
import { makeLeagueWithSeason, makeManagerAndTeam, makePlayer, resetDatabase } from "./test-helpers";
import { recomputeKeeperRecordsForPlayer } from "./keeper-sync";

beforeEach(resetDatabase);
afterAll(resetDatabase);

async function makePendingOffer() {
  const { league, season } = await makeLeagueWithSeason();
  const { manager: sendingManager, team: sendingTeam } = await makeManagerAndTeam(league.id, "Alex");
  const { team: receivingTeam } = await makeManagerAndTeam(league.id, "Blair");
  const targetPlayer = await makePlayer(league.id, "Wanted Player");
  const offeredPlayer = await makePlayer(league.id, "Offered Player");

  await prisma.acquisition.createMany({
    data: [
      { seasonId: season.id, seasonYear: season.year, playerId: targetPlayer.id, teamId: receivingTeam.id, method: "DRAFT", cost: 20 },
      { seasonId: season.id, seasonYear: season.year, playerId: offeredPlayer.id, teamId: sendingTeam.id, method: "DRAFT", cost: 5 },
    ],
  });
  await recomputeKeeperRecordsForPlayer(targetPlayer.id, season.year);
  await recomputeKeeperRecordsForPlayer(offeredPlayer.id, season.year);

  const offer = await prisma.offer.create({
    data: {
      targetPlayerId: targetPlayer.id,
      sendingTeamId: sendingTeam.id,
      sendingManagerId: sendingManager.id,
      receivingTeamId: receivingTeam.id,
      playersOffered: [offeredPlayer.id],
      playersRequested: [targetPlayer.id],
      status: "PENDING",
    },
  });

  return { offer, sendingTeam, receivingTeam, targetPlayer, offeredPlayer };
}

describe("Trade offer lifecycle", () => {
  it("accepting an offer swaps the players between teams", async () => {
    const { offer, sendingTeam, receivingTeam, targetPlayer, offeredPlayer } = await makePendingOffer();

    await acceptOffer(offer.id);

    const updated = await prisma.offer.findUniqueOrThrow({ where: { id: offer.id } });
    expect(updated.status).toBe("ACCEPTED");

    const targetKeeper = await prisma.keeperRecord.findFirst({ where: { playerId: targetPlayer.id } });
    const offeredKeeper = await prisma.keeperRecord.findFirst({ where: { playerId: offeredPlayer.id } });
    expect(targetKeeper?.teamId).toBe(sendingTeam.id);
    expect(offeredKeeper?.teamId).toBe(receivingTeam.id);
  });

  it("rejecting an offer leaves rosters untouched", async () => {
    const { offer, targetPlayer } = await makePendingOffer();
    await rejectOffer(offer.id);

    const updated = await prisma.offer.findUniqueOrThrow({ where: { id: offer.id } });
    expect(updated.status).toBe("REJECTED");

    const tradeAcquisitions = await prisma.acquisition.count({ where: { playerId: targetPlayer.id, method: "TRADE" } });
    expect(tradeAcquisitions).toBe(0);
  });

  it("withdrawing an offer sets status to WITHDRAWN", async () => {
    const { offer } = await makePendingOffer();
    await withdrawOffer(offer.id);
    const updated = await prisma.offer.findUniqueOrThrow({ where: { id: offer.id } });
    expect(updated.status).toBe("WITHDRAWN");
  });
});

describe("offer roster checks", () => {
  it("refuses to accept an offer that requests a third team's player", async () => {
    const { offer, sendingTeam } = await makePendingOffer();
    const season = await prisma.season.findFirstOrThrow();
    const { team: third } = await makeManagerAndTeam(season.leagueId, "Casey");
    const star = await makePlayer(season.leagueId, "Casey's Star");
    await prisma.acquisition.create({
      data: { seasonId: season.id, seasonYear: season.year, playerId: star.id, teamId: third.id, method: "DRAFT", cost: 30 },
    });
    await recomputeKeeperRecordsForPlayer(star.id, season.year);
    await prisma.offer.update({ where: { id: offer.id }, data: { playersRequested: [star.id] } });

    await expect(acceptOffer(offer.id)).rejects.toThrow("no longer on");
    expect((await prisma.offer.findUniqueOrThrow({ where: { id: offer.id } })).status).toBe("PENDING");
    const holder = await prisma.keeperRecord.findFirstOrThrow({ where: { playerId: star.id, status: { not: "DROPPED" } } });
    expect(holder.teamId).toBe(third.id);
    expect(holder.teamId).not.toBe(sendingTeam.id);
  });

  it("lets only one of two simultaneous accepts go through", async () => {
    const { offer, targetPlayer, offeredPlayer } = await makePendingOffer();
    const results = await Promise.allSettled([acceptOffer(offer.id), acceptOffer(offer.id)]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const p of [targetPlayer, offeredPlayer]) {
      expect(await prisma.acquisition.count({ where: { playerId: p.id, method: "TRADE" } })).toBe(1);
    }
  });

  it("can't reject or withdraw an offer that was already accepted", async () => {
    const { offer } = await makePendingOffer();
    await acceptOffer(offer.id);
    await expect(rejectOffer(offer.id)).rejects.toThrow("no longer open");
    await expect(withdrawOffer(offer.id)).rejects.toThrow("no longer open");
    expect((await prisma.offer.findUniqueOrThrow({ where: { id: offer.id } })).status).toBe("ACCEPTED");
  });

  it("validates a new offer's players against both rosters", async () => {
    const { sendingTeam, receivingTeam, targetPlayer, offeredPlayer } = await makePendingOffer();
    const base = { sendingTeamId: sendingTeam.id, receivingTeamId: receivingTeam.id, targetPlayerId: targetPlayer.id };

    expect(await offerProposalProblem({ ...base, playersOffered: [offeredPlayer.id], playersRequested: [targetPlayer.id] })).toBeNull();
    // Swapped: offering a player you don't have, requesting one they don't have.
    expect(await offerProposalProblem({ ...base, playersOffered: [targetPlayer.id], playersRequested: [] })).toMatch("isn't on your roster");
    expect(await offerProposalProblem({ ...base, playersOffered: [], playersRequested: [offeredPlayer.id] })).toMatch("isn't on that team's roster");
    expect(await offerProposalProblem({ ...base, receivingTeamId: "no-such-team", playersOffered: [], playersRequested: [] })).toMatch("active team");
  });
});
