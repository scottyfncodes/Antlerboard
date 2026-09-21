import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { prisma } from "./db";
import { acceptOffer, rejectOffer, withdrawOffer } from "./offers";
import { makeLeagueWithSeason, makeManagerAndTeam, makePlayer, resetDatabase } from "./test-helpers";

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

describe("Make Me an Offer lifecycle", () => {
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
