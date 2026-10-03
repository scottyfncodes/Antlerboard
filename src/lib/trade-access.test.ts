import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { prisma } from "./db";
import { makeLeagueWithSeason, makeManagerAndTeam, makePlayer, resetDatabase } from "./test-helpers";
import {
  canPerformTradeAction,
  isTradeParty,
  offerActionDenial,
  resolveTradeAction,
  visibleOffersWhere,
  visibleTradesWhere,
} from "./trade-access";

const viewer = (id: string, ...teamIds: string[]) => ({ id, teams: teamIds.map((t) => ({ id: t })) });
/** A proposed by mgrA; B and (optionally) C are the other sides. */
const trade = (status = "PROPOSED", extra: { teamId: string; response: string }[] = []) => ({
  proposerId: "mgrA",
  status,
  participants: [
    { teamId: "teamA", isProposer: true, response: "ACCEPTED" },
    { teamId: "teamB", isProposer: false, response: "PENDING" },
    ...extra.map((e) => ({ ...e, isProposer: false })),
  ],
});
const offer = (status = "PENDING") => ({ sendingTeamId: "teamA", receivingTeamId: "teamB", sendingManagerId: "mgrA", status });

describe("resolveTradeAction", () => {
  it("lets only the other sides respond, acting as their own team", () => {
    expect(resolveTradeAction(trade(), viewer("mgrB", "teamB"), "accept")).toEqual({ teamId: "teamB" });
    expect(resolveTradeAction(trade(), viewer("mgrB", "teamB"), "reject")).toEqual({ teamId: "teamB" });
    expect(resolveTradeAction(trade(), viewer("mgrB", "teamB"), "counter")).toEqual({ teamId: "teamB" });
    expect(resolveTradeAction(trade(), viewer("mgrA", "teamA"), "accept").denial?.status).toBe(403);
  });

  it("lets only the proposer withdraw", () => {
    expect(resolveTradeAction(trade(), viewer("mgrA", "teamA"), "withdraw").denial).toBeUndefined();
    expect(resolveTradeAction(trade(), viewer("mgrB", "teamB"), "withdraw").denial?.status).toBe(403);
  });

  it("treats outsiders - including the commissioner - as if the trade doesn't exist", () => {
    const commissioner = viewer("commish", "teamZ");
    for (const action of ["accept", "reject", "counter", "withdraw"] as const) {
      expect(resolveTradeAction(trade(), commissioner, action).denial).toEqual({ status: 404, error: "Trade not found" });
    }
  });

  it("refuses to act on a trade that is no longer open", () => {
    for (const status of ["ACCEPTED", "REJECTED", "WITHDRAWN", "COUNTERED"]) {
      expect(resolveTradeAction(trade(status), viewer("mgrB", "teamB"), "accept").denial?.status).toBe(409);
    }
  });

  it("in a three-team trade, a team that already accepted can't accept again but can still back out", () => {
    const t = trade("PROPOSED", [{ teamId: "teamC", response: "ACCEPTED" }]);
    expect(resolveTradeAction(t, viewer("mgrC", "teamC"), "accept").denial?.status).toBe(409);
    expect(resolveTradeAction(t, viewer("mgrC", "teamC"), "reject")).toEqual({ teamId: "teamC" });
    expect(canPerformTradeAction(t, viewer("mgrB", "teamB"), "accept")).toBe(true);
    expect(canPerformTradeAction(t, null, "accept")).toBe(false);
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
  it("covers every team in the deal and nobody else", () => {
    const t = trade("PROPOSED", [{ teamId: "teamC", response: "PENDING" }]);
    expect(isTradeParty(t, null)).toBe(false);
    expect(isTradeParty(t, viewer("commish", "teamZ"))).toBe(false);
    expect(isTradeParty(t, viewer("mgrB", "teamB"))).toBe(true);
    expect(isTradeParty(t, viewer("mgrC", "teamC"))).toBe(true);
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
          proposerId: a.manager.id,
          status,
          participants: {
            create: [
              { teamId: a.team.id, isProposer: true, response: "ACCEPTED" },
              { teamId: b.team.id, response: status === "ACCEPTED" ? "ACCEPTED" : "PENDING" },
            ],
          },
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
