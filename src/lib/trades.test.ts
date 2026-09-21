import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { prisma } from "./db";
import { acceptTrade, rejectTrade, withdrawTrade, counterTrade } from "./trades";
import { makeLeagueWithSeason, makeManagerAndTeam, makePlayer, resetDatabase } from "./test-helpers";

beforeEach(resetDatabase);
afterAll(resetDatabase);

async function makeProposedTrade() {
  const { league, season } = await makeLeagueWithSeason();
  const { manager: managerA, team: teamA } = await makeManagerAndTeam(league.id, "Alex");
  const { manager: managerB, team: teamB } = await makeManagerAndTeam(league.id, "Blair");
  const player = await makePlayer(league.id, "Traded Player");

  // A player must already be rostered (via an initial draft/waiver/free
  // agent acquisition) before a trade can move them - this mirrors how
  // real rosters are built up in the seed data.
  await prisma.acquisition.create({
    data: {
      seasonId: season.id,
      seasonYear: season.year,
      playerId: player.id,
      teamId: teamA.id,
      method: "DRAFT",
      cost: 10,
    },
  });

  const trade = await prisma.trade.create({
    data: {
      seasonId: season.id,
      seasonYear: season.year,
      teamAId: teamA.id,
      teamBId: teamB.id,
      proposerId: managerA.id,
      status: "PROPOSED",
      assets: {
        create: [{ fromTeamId: teamA.id, toTeamId: teamB.id, assetType: "PLAYER", playerId: player.id }],
      },
    },
  });

  return { trade, managerA, managerB, teamA, teamB, player, season };
}

describe("trade lifecycle", () => {
  it("accepting a trade moves the player and marks the trade ACCEPTED", async () => {
    const { trade, teamB, player } = await makeProposedTrade();

    await acceptTrade(trade.id);

    const updated = await prisma.trade.findUniqueOrThrow({ where: { id: trade.id } });
    expect(updated.status).toBe("ACCEPTED");

    const acquisition = await prisma.acquisition.findFirst({ where: { playerId: player.id, method: "TRADE" } });
    expect(acquisition?.teamId).toBe(teamB.id);

    const keeperRecord = await prisma.keeperRecord.findFirst({ where: { playerId: player.id } });
    expect(keeperRecord?.teamId).toBe(teamB.id);
  });

  it("rejecting a trade sets status to REJECTED without moving any players", async () => {
    const { trade, player } = await makeProposedTrade();
    await rejectTrade(trade.id);

    const updated = await prisma.trade.findUniqueOrThrow({ where: { id: trade.id } });
    expect(updated.status).toBe("REJECTED");

    const tradeAcquisitions = await prisma.acquisition.count({ where: { playerId: player.id, method: "TRADE" } });
    expect(tradeAcquisitions).toBe(0);
  });

  it("withdrawing a trade sets status to WITHDRAWN", async () => {
    const { trade } = await makeProposedTrade();
    await withdrawTrade(trade.id);
    const updated = await prisma.trade.findUniqueOrThrow({ where: { id: trade.id } });
    expect(updated.status).toBe("WITHDRAWN");
  });

  it("countering a trade marks the original COUNTERED and creates a linked proposal", async () => {
    const { trade, managerB, teamA, teamB } = await makeProposedTrade();
    const counter = await counterTrade(trade.id, managerB.id, [
      { fromTeamId: teamB.id, toTeamId: teamA.id, assetType: "PLAYER" },
    ]);

    const original = await prisma.trade.findUniqueOrThrow({ where: { id: trade.id } });
    expect(original.status).toBe("COUNTERED");
    expect(counter.status).toBe("PROPOSED");
    expect(counter.parentTradeId).toBe(trade.id);
    expect(counter.proposerId).toBe(managerB.id);
  });
});
