import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { prisma } from "./db";
import { makeLeagueWithSeason, makeManagerAndTeam, makePlayer, resetDatabase } from "./test-helpers";
import {
  isTradeParty,
  offerActionDenial,
  tradeActionDenial,
  visibleOffersWhere,
  visibleTradesWhere,
} from "./trade-access";

const viewer = (id: string, ...teamIds: string[]) => ({ id, teams: teamIds.map((t) => ({ id: t })) });
const trade = (status = "PROPOSED") => ({ teamAId: "teamA", teamBId: "teamB", proposerId: "mgrA", status });
const offer = (status = "PENDING") => ({ sendingTeamId: "teamA", receivingTeamId: "teamB", sendingManagerId: "mgrA", status });

describe("tradeActionDenial", () => {
  it("lets only the other side respond", () => {
    expect(tradeActionDenial(trade(), viewer("mgrB", "teamB"), "accept")).toBeNull();
    expect(tradeActionDenial(trade(), viewer("mgrB", "teamB"), "reject")).toBeNull();
    expect(tradeActionDenial(trade(), viewer("mgrB", "teamB"), "counter")).toBeNull();
    expect(tradeActionDenial(trade(), viewer("mgrA", "teamA"), "accept")?.status).toBe(403);
  });

  it("lets only the proposer withdraw", () => {
    expect(tradeActionDenial(trade(), viewer("mgrA", "teamA"), "withdraw")).toBeNull();
    expect(tradeActionDenial(trade(), viewer("mgrB", "teamB"), "withdraw")?.status).toBe(403);
  });

  it("treats outsiders - including the commissioner - as if the trade doesn't exist", () => {
    const commissioner = viewer("commish", "teamC");
    for (const action of ["accept", "reject", "counter", "withdraw"] as const) {
      expect(tradeActionDenial(trade(), commissioner, action)).toEqual({ status: 404, error: "Trade not found" });
    }
  });

  it("refuses to act on a trade that is no longer open", () => {
    for (const status of ["ACCEPTED", "REJECTED", "WITHDRAWN", "COUNTERED"]) {
      expect(tradeActionDenial(trade(status), viewer("mgrB", "teamB"), "accept")?.status).toBe(409);
    }
  });
});

describe("offerActionDenial", () => {
  it("lets the receiver respond and the sender withdraw, nobody else", () => {
    expect(offerActionDenial(offer(), viewer("mgrB", "teamB"), "accept")).toBeNull();
    expect(offerActionDenial(offer(), viewer("mgrA", "teamA"), "accept")?.status).toBe(403);
    expect(offerActionDenial(offer(), viewer("mgrA", "teamA"), "withdraw")).toBeNull();
    expect(offerActionDenial(offer(), viewer("mgrB", "teamB"), "withdraw")?.status).toBe(403);
    expect(offerActionDenial(offer(), viewer("commish", "teamC"), "accept")?.status).toBe(404);
    expect(offerActionDenial(offer("ACCEPTED"), viewer("mgrB", "teamB"), "accept")?.status).toBe(409);
  });
});

describe("isTradeParty", () => {
  it("is false for a missing viewer or an uninvolved team", () => {
    expect(isTradeParty(trade(), null)).toBe(false);
    expect(isTradeParty(trade(), viewer("commish", "teamC"))).toBe(false);
    expect(isTradeParty(trade(), viewer("mgrB", "teamB"))).toBe(true);
  });
});

describe("visibility filters against the database", () => {
  beforeEach(resetDatabase);
  afterAll(resetDatabase);

  async function setup() {
    const { league, season } = await makeLeagueWithSeason();
    const a = await makeManagerAndTeam(league.id, "Alex");
    const b = await makeManagerAndTeam(league.id, "Blair");
    const commish = await makeManagerAndTeam(league.id, "Commish", true);
    const player = await makePlayer(league.id, "Somebody");
    const mk = (status: "PROPOSED" | "COUNTERED" | "ACCEPTED" | "REJECTED" | "WITHDRAWN") =>
      prisma.trade.create({
        data: {
          seasonId: season.id,
          seasonYear: season.year,
          teamAId: a.team.id,
          teamBId: b.team.id,
          proposerId: a.manager.id,
          status,
          assets: { create: [{ fromTeamId: a.team.id, toTeamId: b.team.id, assetType: "PLAYER", playerId: player.id }] },
        },
      });
    const trades = {
      proposed: await mk("PROPOSED"),
      rejected: await mk("REJECTED"),
      accepted: await mk("ACCEPTED"),
    };
    const offerRow = (status: "PENDING" | "ACCEPTED") =>
      prisma.offer.create({
        data: { sendingTeamId: a.team.id, sendingManagerId: a.manager.id, receivingTeamId: b.team.id, status },
      });
    const offers = { pending: await offerRow("PENDING"), accepted: await offerRow("ACCEPTED") };
    const asViewer = (m: typeof a) => ({ id: m.manager.id, teams: [{ id: m.team.id }] });
    return { a: asViewer(a), b: asViewer(b), commish: asViewer(commish), trades, offers };
  }

  it("shows both sides every one of their trades", async () => {
    const { a, b, trades } = await setup();
    for (const v of [a, b]) {
      const ids = (await prisma.trade.findMany({ where: visibleTradesWhere(v) })).map((t) => t.id).sort();
      expect(ids).toEqual(Object.values(trades).map((t) => t.id).sort());
    }
  });

  it("shows the commissioner only accepted trades and offers, not open negotiations", async () => {
    const { commish, trades, offers } = await setup();
    const tradeIds = (await prisma.trade.findMany({ where: visibleTradesWhere(commish) })).map((t) => t.id);
    expect(tradeIds).toEqual([trades.accepted.id]);
    const offerIds = (await prisma.offer.findMany({ where: visibleOffersWhere(commish) })).map((o) => o.id);
    expect(offerIds).toEqual([offers.accepted.id]);
  });

  it("filters trade history reached through a player's trade assets", async () => {
    const { commish, trades } = await setup();
    const assets = await prisma.tradeAsset.findMany({ where: { trade: visibleTradesWhere(commish) } });
    expect(assets.map((x) => x.tradeId)).toEqual([trades.accepted.id]);
  });
});
