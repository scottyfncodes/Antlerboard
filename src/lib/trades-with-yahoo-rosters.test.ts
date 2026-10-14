import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { prisma } from "./db";
import { acceptTrade, createTrade, TradeActionError } from "./trades";
import { acceptOffer, offerProposalProblem, OfferActionError } from "./offers";
import { getCurrentHolders } from "./rosters";
import { makeLeagueWithSeason, makeManagerAndTeam, makePlayer, resetDatabase } from "./test-helpers";
import { recomputeKeeperRecordsForPlayer } from "./keeper-sync";
import { CURRENT_SEASON_YEAR } from "./config";

beforeEach(resetDatabase);
afterAll(resetDatabase);

/**
 * Production's shape since the first roster sync: a 2026 season whose rosters
 * come from Yahoo (RosterSpot rows), Yahoo-linked teams and players, and NO
 * keeper records or acquisitions for 2026.
 */
const HOUR = 3_600_000;
async function yahooLeague() {
  const { league, season } = await makeLeagueWithSeason(CURRENT_SEASON_YEAR);
  const syncedAt = new Date(Date.now() - HOUR); // the last Sync Now
  const teams = [];
  for (const [i, name] of ["Andrew", "Scott", "Hugo"].entries()) {
    const t = await makeManagerAndTeam(league.id, name);
    await prisma.team.update({ where: { id: t.team.id }, data: { yahooTeamId: `469.l.8891.t.${i + 1}` } });
    teams.push(t);
  }
  let n = 0;
  const rostered = async (name: string, teamId: string) => {
    const player = await makePlayer(league.id, name);
    const key = `469.p.${1000 + ++n}`;
    await prisma.player.update({ where: { id: player.id }, data: { yahooPlayerId: key } });
    await prisma.rosterSpot.create({
      data: { seasonId: season.id, teamId, playerId: player.id, yahooPlayerKey: key, selectedPosition: "BN", onTeamSince: syncedAt, lastSeenAt: syncedAt },
    });
    return player;
  };
  const [andrew, scott, hugo] = teams;
  return { league, season, andrew, scott, hugo, rostered, syncedAt };
}

const twoTeam = (proposer: { manager: { id: string }; team: { id: string } }, other: { team: { id: string } }, assets: object[]) =>
  createTrade({
    proposerId: proposer.manager.id,
    proposingTeamId: proposer.team.id,
    teamIds: [proposer.team.id, other.team.id],
    assets: assets as Parameters<typeof createTrade>[0]["assets"],
  });
const player = (from: string, to: string, playerId: string) => ({ fromTeamId: from, toTeamId: to, assetType: "PLAYER", playerId });

describe("trades against Yahoo rosters with no 2026 keeper records (production shape)", () => {
  it("proposes and executes a valid trade - no keeper record needed", async () => {
    const { season, andrew, scott, rostered } = await yahooLeague();
    const kurtz = await rostered("Nick Kurtz", andrew.team.id);
    const judge = await rostered("Aaron Judge", scott.team.id);
    expect(await prisma.keeperRecord.count()).toBe(0);

    const trade = await twoTeam(andrew, scott, [player(andrew.team.id, scott.team.id, kurtz.id), player(scott.team.id, andrew.team.id, judge.id)]);
    expect(await acceptTrade(trade.id, scott.team.id)).toBe(true);

    const acqs = await prisma.acquisition.findMany({ where: { method: "TRADE" }, orderBy: { teamId: "asc" } });
    expect(acqs.map((a) => [a.playerId, a.teamId, a.seasonId]).sort()).toEqual(
      [[kurtz.id, scott.team.id, season.id], [judge.id, andrew.team.id, season.id]].sort()
    );
    // The Yahoo roster rows belong to the sync and are untouched...
    expect((await prisma.rosterSpot.findFirstOrThrow({ where: { playerId: kurtz.id } })).teamId).toBe(andrew.team.id);
    // ...but the agreed move is reflected until the next sync.
    const holders = await getCurrentHolders(prisma, season.leagueId, CURRENT_SEASON_YEAR);
    expect(holders.get(kurtz.id)).toBe(scott.team.id);
    expect(holders.get(judge.id)).toBe(andrew.team.id);
  });

  it("won't move the same player twice: a second open deal fails once the first executes", async () => {
    const { andrew, scott, hugo, rostered } = await yahooLeague();
    const kurtz = await rostered("Nick Kurtz", andrew.team.id);
    const first = await twoTeam(andrew, scott, [player(andrew.team.id, scott.team.id, kurtz.id)]);
    const second = await twoTeam(andrew, hugo, [player(andrew.team.id, hugo.team.id, kurtz.id)]);

    expect(await acceptTrade(first.id, scott.team.id)).toBe(true);
    await expect(acceptTrade(second.id, hugo.team.id)).rejects.toThrow("no longer on");
    // And Andrew can't propose him again before Yahoo catches up.
    await expect(twoTeam(andrew, hugo, [player(andrew.team.id, hugo.team.id, kurtz.id)])).rejects.toThrow("isn't on");
    expect(await prisma.acquisition.count({ where: { playerId: kurtz.id } })).toBe(1);
  });

  it("serializes concurrent accepts of two deals for the same player - exactly one goes through", async () => {
    const { andrew, scott, hugo, rostered } = await yahooLeague();
    const kurtz = await rostered("Nick Kurtz", andrew.team.id);
    const first = await twoTeam(andrew, scott, [player(andrew.team.id, scott.team.id, kurtz.id)]);
    const second = await twoTeam(andrew, hugo, [player(andrew.team.id, hugo.team.id, kurtz.id)]);

    const results = await Promise.allSettled([acceptTrade(first.id, scott.team.id), acceptTrade(second.id, hugo.team.id)]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await prisma.acquisition.count({ where: { playerId: kurtz.id, method: "TRADE" } })).toBe(1);
  });

  it("lets Yahoo decide again after the next sync - whether or not the move was made there", async () => {
    const { season, andrew, scott, hugo, rostered } = await yahooLeague();
    const kurtz = await rostered("Nick Kurtz", andrew.team.id);
    const trade = await twoTeam(andrew, scott, [player(andrew.team.id, scott.team.id, kurtz.id)]);
    await acceptTrade(trade.id, scott.team.id);

    // Next sync: Yahoo made the move.
    await prisma.rosterSpot.updateMany({ where: { playerId: kurtz.id }, data: { teamId: scott.team.id, lastSeenAt: new Date() } });
    expect((await getCurrentHolders(prisma, season.leagueId, CURRENT_SEASON_YEAR)).get(kurtz.id)).toBe(scott.team.id);
    // Scott can now trade him on.
    await expect(twoTeam(scott, hugo, [player(scott.team.id, hugo.team.id, kurtz.id)])).resolves.toBeTruthy();

    // A later sync where Yahoo shows him back on Andrew: Yahoo wins.
    await prisma.rosterSpot.updateMany({ where: { playerId: kurtz.id }, data: { teamId: andrew.team.id, lastSeenAt: new Date(Date.now() + 1000) } });
    expect((await getCurrentHolders(prisma, season.leagueId, CURRENT_SEASON_YEAR)).get(kurtz.id)).toBe(andrew.team.id);
  });

  it("refuses free agents, another team's player, and unknown player ids", async () => {
    const { league, andrew, scott, rostered } = await yahooLeague();
    const freeAgent = await makePlayer(league.id, "Free Agent"); // no roster spot
    const judge = await rostered("Aaron Judge", scott.team.id);

    await expect(twoTeam(andrew, scott, [player(andrew.team.id, scott.team.id, freeAgent.id)])).rejects.toThrow("isn't on");
    await expect(twoTeam(andrew, scott, [player(andrew.team.id, scott.team.id, judge.id)])).rejects.toThrow("isn't on");
    await expect(twoTeam(andrew, scott, [player(andrew.team.id, scott.team.id, "no-such-player")])).rejects.toThrow("isn't on");
    expect(await prisma.trade.count()).toBe(0);
  });

  it("refuses a trade with a team from another league, even when each side offers its own players", async () => {
    const { andrew, rostered } = await yahooLeague();
    const kurtz = await rostered("Nick Kurtz", andrew.team.id);
    const other = await makeLeagueWithSeason(CURRENT_SEASON_YEAR);
    const stranger = await makeManagerAndTeam(other.league.id, "Stranger");
    const strangerPlayer = await makePlayer(other.league.id, "Their Guy");
    await prisma.rosterSpot.create({
      data: { seasonId: other.season.id, teamId: stranger.team.id, playerId: strangerPlayer.id, yahooPlayerKey: "1.p.1", onTeamSince: new Date(), lastSeenAt: new Date() },
    });

    await expect(
      twoTeam(andrew, stranger, [player(andrew.team.id, stranger.team.id, kurtz.id), player(stranger.team.id, andrew.team.id, strangerPlayer.id)])
    ).rejects.toThrow("same league");
    expect(await prisma.trade.count()).toBe(0);
  });

  it("refuses moving another league's player even if the sending team names it", async () => {
    const { andrew, scott } = await yahooLeague();
    const other = await makeLeagueWithSeason(CURRENT_SEASON_YEAR);
    const stranger = await makeManagerAndTeam(other.league.id, "Stranger");
    const theirs = await makePlayer(other.league.id, "Their Guy");
    await prisma.rosterSpot.create({
      data: { seasonId: other.season.id, teamId: stranger.team.id, playerId: theirs.id, yahooPlayerKey: "1.p.2", onTeamSince: new Date(), lastSeenAt: new Date() },
    });

    await expect(twoTeam(andrew, scott, [player(andrew.team.id, scott.team.id, theirs.id)])).rejects.toThrow(TradeActionError);
  });
});

describe("offers against Yahoo rosters with no 2026 keeper records (production shape)", () => {
  async function pendingOffer() {
    const ctx = await yahooLeague();
    const target = await ctx.rostered("Aaron Judge", ctx.scott.team.id);
    const offered = await ctx.rostered("Nick Kurtz", ctx.andrew.team.id);
    const proposal = { sendingTeamId: ctx.andrew.team.id, receivingTeamId: ctx.scott.team.id, targetPlayerId: target.id, playersOffered: [offered.id], playersRequested: [target.id] };
    const offer = await prisma.offer.create({ data: { ...proposal, sendingManagerId: ctx.andrew.manager.id, status: "PENDING" } });
    return { ...ctx, target, offered, proposal, offer };
  }

  it("validates and accepts a valid offer - no keeper record needed", async () => {
    const { proposal, offer, andrew, scott, target, offered } = await pendingOffer();
    expect(await offerProposalProblem(proposal)).toBeNull();

    await acceptOffer(offer.id);

    const acqs = await prisma.acquisition.findMany({ where: { method: "TRADE" } });
    expect(acqs.map((a) => [a.playerId, a.teamId]).sort()).toEqual([[target.id, andrew.team.id], [offered.id, scott.team.id]].sort());
  });

  it("refuses a second offer for a player already moved by an accepted one", async () => {
    const { offer, andrew, scott, hugo, offered } = await pendingOffer();
    const second = await prisma.offer.create({
      data: { sendingTeamId: andrew.team.id, sendingManagerId: andrew.manager.id, receivingTeamId: hugo.team.id, playersOffered: [offered.id], playersRequested: [], status: "PENDING" },
    });

    await acceptOffer(offer.id);

    await expect(acceptOffer(second.id)).rejects.toThrow(OfferActionError);
    expect(await prisma.acquisition.count({ where: { playerId: offered.id } })).toBe(1);
    expect((await prisma.acquisition.findFirstOrThrow({ where: { playerId: offered.id } })).teamId).toBe(scott.team.id);
  });

  it("rejects offers for players not on the right roster, and offers to another league's team", async () => {
    const { proposal, league, andrew } = await pendingOffer();
    const freeAgent = await makePlayer(league.id, "Free Agent");
    expect(await offerProposalProblem({ ...proposal, playersRequested: [freeAgent.id], targetPlayerId: null })).toContain("isn't on that team's roster");
    expect(await offerProposalProblem({ ...proposal, playersOffered: [freeAgent.id] })).toContain("isn't on your roster");

    const other = await makeLeagueWithSeason(CURRENT_SEASON_YEAR);
    const stranger = await makeManagerAndTeam(other.league.id, "Stranger");
    expect(
      await offerProposalProblem({ sendingTeamId: andrew.team.id, receivingTeamId: stranger.team.id, playersOffered: [], playersRequested: [] })
    ).toBe("That team isn't an active team in the league");
  });
});

describe("getCurrentHolders without Yahoo rosters (keeper fallback)", () => {
  it("uses the one live keeper stint, and treats more than one as no holder", async () => {
    const { league, season } = await makeLeagueWithSeason(CURRENT_SEASON_YEAR);
    const a = await makeManagerAndTeam(league.id, "Alex");
    const b = await makeManagerAndTeam(league.id, "Blair");
    const single = await makePlayer(league.id, "Single Stint");
    await prisma.acquisition.create({ data: { seasonId: season.id, seasonYear: season.year, playerId: single.id, teamId: a.team.id, method: "DRAFT", cost: 5 } });
    await recomputeKeeperRecordsForPlayer(single.id, season.year);
    const doubled = await makePlayer(league.id, "Two Live Stints");
    for (const [i, teamId] of [a.team.id, b.team.id].entries()) {
      await prisma.keeperRecord.create({
        data: { seasonId: season.id, seasonYear: season.year, playerId: doubled.id, teamId, keeperYear: 0, keeperCost: 1, yearsRemaining: 5, status: "KEPT", stintIndex: i },
      });
    }

    const holders = await getCurrentHolders(prisma, league.id, CURRENT_SEASON_YEAR);

    expect(holders.get(single.id)).toBe(a.team.id);
    expect(holders.has(doubled.id)).toBe(false);
  });
});
