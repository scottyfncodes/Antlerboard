import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { prisma } from "./db";
import { acceptTrade, rejectTrade, withdrawTrade, counterTrade, createTrade, TradeActionError } from "./trades";
import { makeLeagueWithSeason, makeManagerAndTeam, makePlayer, resetDatabase } from "./test-helpers";

beforeEach(resetDatabase);
afterAll(resetDatabase);

async function rostered(seasonId: string, year: number, leagueId: string, name: string, teamId: string) {
  // A player must already be rostered (via an initial draft/waiver/free
  // agent acquisition) before a trade can move them - this mirrors how
  // real rosters are built up in the seed data.
  const player = await makePlayer(leagueId, name);
  await prisma.acquisition.create({
    data: { seasonId, seasonYear: year, playerId: player.id, teamId, method: "DRAFT", cost: 10 },
  });
  return player;
}

async function twoTeamTrade() {
  const { league, season } = await makeLeagueWithSeason();
  const a = await makeManagerAndTeam(league.id, "Alex");
  const b = await makeManagerAndTeam(league.id, "Blair");
  const player = await rostered(season.id, season.year, league.id, "Traded Player", a.team.id);
  const trade = await createTrade({
    proposerId: a.manager.id,
    proposingTeamId: a.team.id,
    teamIds: [a.team.id, b.team.id],
    assets: [{ fromTeamId: a.team.id, toTeamId: b.team.id, assetType: "PLAYER", playerId: player.id }],
  });
  return { trade, a, b, player };
}

async function threeTeamTrade() {
  const { league, season } = await makeLeagueWithSeason();
  const a = await makeManagerAndTeam(league.id, "Alex");
  const b = await makeManagerAndTeam(league.id, "Blair");
  const c = await makeManagerAndTeam(league.id, "Casey");
  const pa = await rostered(season.id, season.year, league.id, "A Player", a.team.id);
  const pb = await rostered(season.id, season.year, league.id, "B Player", b.team.id);
  const trade = await createTrade({
    proposerId: a.manager.id,
    proposingTeamId: a.team.id,
    teamIds: [a.team.id, b.team.id, c.team.id],
    assets: [
      { fromTeamId: a.team.id, toTeamId: b.team.id, assetType: "PLAYER", playerId: pa.id },
      { fromTeamId: b.team.id, toTeamId: c.team.id, assetType: "PLAYER", playerId: pb.id },
      { fromTeamId: c.team.id, toTeamId: a.team.id, assetType: "DRAFT_PICK", draftPickDescription: "2027 1st" },
    ],
  });
  return { trade, a, b, c, pa, pb };
}

const pickAsset = (from: string, to: string) => ({
  fromTeamId: from,
  toTeamId: to,
  assetType: "DRAFT_PICK" as const,
  draftPickDescription: "2027 3rd",
});

const status = async (id: string) => (await prisma.trade.findUniqueOrThrow({ where: { id } })).status;

describe("two-team trade lifecycle", () => {
  it("creates participants with the proposing side already accepted", async () => {
    const { trade, a, b } = await twoTeamTrade();
    const byTeam = new Map(trade.participants.map((p) => [p.teamId, p]));
    expect(byTeam.get(a.team.id)).toMatchObject({ isProposer: true, response: "ACCEPTED" });
    expect(byTeam.get(b.team.id)).toMatchObject({ isProposer: false, response: "PENDING" });
  });

  it("accepting moves the player and marks the trade ACCEPTED", async () => {
    const { trade, b, player } = await twoTeamTrade();
    expect(await acceptTrade(trade.id, b.team.id)).toBe(true);
    expect(await status(trade.id)).toBe("ACCEPTED");
    const acquisition = await prisma.acquisition.findFirst({ where: { playerId: player.id, method: "TRADE" } });
    expect(acquisition?.teamId).toBe(b.team.id);
    const keeperRecord = await prisma.keeperRecord.findFirst({ where: { playerId: player.id } });
    expect(keeperRecord?.teamId).toBe(b.team.id);
  });

  it("rejecting sets REJECTED without moving any players", async () => {
    const { trade, b, player } = await twoTeamTrade();
    await rejectTrade(trade.id, b.team.id);
    expect(await status(trade.id)).toBe("REJECTED");
    expect(await prisma.acquisition.count({ where: { playerId: player.id, method: "TRADE" } })).toBe(0);
  });

  it("withdrawing sets WITHDRAWN, and a closed trade can't be accepted", async () => {
    const { trade, b } = await twoTeamTrade();
    await withdrawTrade(trade.id);
    expect(await status(trade.id)).toBe("WITHDRAWN");
    await expect(acceptTrade(trade.id, b.team.id)).rejects.toBeInstanceOf(TradeActionError);
  });

  it("countering marks the original COUNTERED and creates a linked proposal from the counter team", async () => {
    const { trade, a, b, player } = await twoTeamTrade();
    const counter = await counterTrade(trade.id, {
      proposerId: b.manager.id,
      proposingTeamId: b.team.id,
      teamIds: [b.team.id, a.team.id],
      assets: [
        { fromTeamId: a.team.id, toTeamId: b.team.id, assetType: "PLAYER", playerId: player.id },
        { fromTeamId: b.team.id, toTeamId: a.team.id, assetType: "DRAFT_PICK", draftPickDescription: "2027 5th" },
      ],
    });
    expect(await status(trade.id)).toBe("COUNTERED");
    expect(counter.status).toBe("PROPOSED");
    expect(counter.parentTradeId).toBe(trade.id);
    expect(counter.proposerId).toBe(b.manager.id);
    expect(counter.participants.find((p) => p.isProposer)?.teamId).toBe(b.team.id);
  });
});

describe("three-team trade", () => {
  it("only executes once every team has accepted", async () => {
    const { trade, b, c, pa, pb } = await threeTeamTrade();

    expect(await acceptTrade(trade.id, b.team.id)).toBe(false);
    expect(await status(trade.id)).toBe("PROPOSED");
    expect(await prisma.acquisition.count({ where: { method: "TRADE" } })).toBe(0);

    expect(await acceptTrade(trade.id, c.team.id)).toBe(true);
    expect(await status(trade.id)).toBe("ACCEPTED");
    expect((await prisma.acquisition.findFirst({ where: { playerId: pa.id, method: "TRADE" } }))?.teamId).toBe(b.team.id);
    expect((await prisma.acquisition.findFirst({ where: { playerId: pb.id, method: "TRADE" } }))?.teamId).toBe(c.team.id);
  });

  it("is killed by any one rejection, even after another team accepted", async () => {
    const { trade, b, c } = await threeTeamTrade();
    await acceptTrade(trade.id, b.team.id);
    await rejectTrade(trade.id, c.team.id);
    expect(await status(trade.id)).toBe("REJECTED");
    await expect(acceptTrade(trade.id, b.team.id)).rejects.toBeInstanceOf(TradeActionError);
    expect(await prisma.acquisition.count({ where: { method: "TRADE" } })).toBe(0);
  });

  it("won't let a team accept twice", async () => {
    const { trade, b } = await threeTeamTrade();
    await acceptTrade(trade.id, b.team.id);
    await expect(acceptTrade(trade.id, b.team.id)).rejects.toThrow("already accepted");
  });

  it("notifies every other team on proposal", async () => {
    const { league } = await makeLeagueWithSeason();
    const [a, b, c] = await Promise.all(["Alex", "Blair", "Casey"].map((n) => makeManagerAndTeam(league.id, n)));
    // Notifications are opt-in per type; switch TRADE_PROPOSED on for everyone.
    await prisma.notificationPreference.createMany({
      data: [a, b, c].map((m) => ({ managerId: m.manager.id, type: "TRADE_PROPOSED" as const, channel: "IN_APP" as const, enabled: true })),
    });
    const trade = await createTrade({
      proposerId: a.manager.id,
      proposingTeamId: a.team.id,
      teamIds: [a.team.id, b.team.id, c.team.id],
      assets: [pickAsset(a.team.id, b.team.id), pickAsset(b.team.id, c.team.id)],
    });
    const notified = await prisma.notification.findMany({ where: { relatedEntityId: trade.id } });
    expect(notified.map((n) => n.managerId).sort()).toEqual([b.manager.id, c.manager.id].sort());
    expect(notified.some((n) => n.managerId === a.manager.id)).toBe(false);
  });
});

describe("overlapping proposals", () => {
  it("refuses to execute a trade whose player was already moved by another deal", async () => {
    const { trade, a, b, player } = await twoTeamTrade();
    const c = await makeManagerAndTeam((await prisma.team.findUniqueOrThrow({ where: { id: a.team.id } })).leagueId, "Casey");
    const second = await createTrade({
      proposerId: a.manager.id,
      proposingTeamId: a.team.id,
      teamIds: [a.team.id, c.team.id],
      assets: [{ fromTeamId: a.team.id, toTeamId: c.team.id, assetType: "PLAYER", playerId: player.id }],
    });

    await acceptTrade(trade.id, b.team.id);
    await expect(acceptTrade(second.id, c.team.id)).rejects.toThrow("no longer on");
    expect(await status(second.id)).toBe("PROPOSED");
    expect((await prisma.keeperRecord.findFirst({ where: { playerId: player.id } }))?.teamId).toBe(b.team.id);
  });

  it("ignores an earlier DROPPED stint on another team when checking the roster", async () => {
    // Since keeper records became one row per stint, a player dropped by one
    // team and picked up by another has a DROPPED row for the first stint.
    // Only the live stint decides who can trade him.
    const { trade, a, b, player } = await twoTeamTrade();
    const season = await prisma.season.findFirstOrThrow();
    const c = await makeManagerAndTeam(season.leagueId, "Casey");
    const base = { seasonId: season.id, seasonYear: season.year, playerId: player.id, keeperYear: 0, keeperCost: 10, yearsRemaining: 0 };
    await prisma.keeperRecord.createMany({
      data: [
        { ...base, teamId: c.team.id, startTeamId: c.team.id, status: "DROPPED", stintIndex: 0 },
        { ...base, teamId: a.team.id, startTeamId: a.team.id, status: "KEPT", stintIndex: 1 },
      ],
    });

    await acceptTrade(trade.id, b.team.id);
    expect(await status(trade.id)).toBe("ACCEPTED");
  });
});

describe("createTrade validation", () => {
  it("rejects a malformed proposal before writing anything", async () => {
    const { league } = await makeLeagueWithSeason();
    const a = await makeManagerAndTeam(league.id, "Alex");
    const b = await makeManagerAndTeam(league.id, "Blair");
    const c = await makeManagerAndTeam(league.id, "Casey");
    const p = await makePlayer(league.id, "P");
    await expect(
      createTrade({
        proposerId: a.manager.id,
        proposingTeamId: a.team.id,
        teamIds: [a.team.id, b.team.id, c.team.id],
        assets: [{ fromTeamId: a.team.id, toTeamId: b.team.id, assetType: "PLAYER", playerId: p.id }],
      })
    ).rejects.toThrow("Every team in the trade has to send or receive something");
    expect(await prisma.trade.count()).toBe(0);
  });
});
