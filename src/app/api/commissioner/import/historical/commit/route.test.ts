import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { prisma } from "@/lib/db";
import { makeLeagueWithSeason, makeManagerAndTeam, resetDatabase } from "@/lib/test-helpers";
import type { ParsedPropBet, ParsedTrade } from "@/lib/import/types";

vi.mock("@/lib/current-manager", () => ({ requireCommissioner: vi.fn(), getCurrentManager: vi.fn() }));
import { requireCommissioner, getCurrentManager } from "@/lib/current-manager";
import { POST } from "./route";

beforeEach(async () => {
  await resetDatabase();
  vi.mocked(requireCommissioner).mockReset();
});
afterAll(resetDatabase);

async function setup() {
  const { league } = await makeLeagueWithSeason(2026);
  const { manager } = await makeManagerAndTeam(league.id, "Scott", true);
  vi.mocked(requireCommissioner).mockResolvedValue(manager as never);
  vi.mocked(getCurrentManager).mockResolvedValue(manager as never);
  return { league };
}

const trade = (row: number, over: Partial<ParsedTrade> = {}): ParsedTrade => ({
  seasonYear: 2025,
  tradeDate: "2025-11-28T00:00:00.000Z",
  teamAName: "Ranger Thingz",
  teamAPlayersRaw: "J.Soto",
  teamADropsRaw: null,
  teamBName: "Dallas Eagles",
  teamBPlayersRaw: "M.Betts",
  teamBDropsRaw: null,
  sourceRef: `Trade Log row ${row}`,
  flags: [],
  ...over,
});

const bet = (row: number, over: Partial<ParsedPropBet> = {}): ParsedPropBet => ({
  seasonYear: 2025,
  teamAName: "Scott",
  teamBName: "Ed",
  amount: 20,
  description: "Judge outhomers Ohtani",
  sourceRef: `Prop Bets row ${row}`,
  flags: [],
  ...over,
});

const body = (trades: ParsedTrade[], propBets: ParsedPropBet[]) => ({ teamSeasons: [], trades, propBets, draftDayEvents: [], fypdSections: [] });

const post = async (b: unknown) => {
  const res = await POST(new Request("https://antlerboard.test/api/commissioner/import/historical/commit", { method: "POST", body: JSON.stringify(b) }));
  return { status: res.status, body: await res.json() };
};

describe("POST /api/commissioner/import/historical/commit - trades and prop bets", () => {
  it("writes each trade and prop bet on the first run", async () => {
    await setup();
    const r = await post(body([trade(1), trade(2, { teamAPlayersRaw: "A.Judge" })], [bet(1), bet(2, { amount: 50 })]));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ tradesWritten: 2, tradesSkipped: 0, propBetsWritten: 2, propBetsSkipped: 0 });
    expect(await prisma.historicalTrade.count()).toBe(2);
    expect(await prisma.historicalPropBet.count()).toBe(2);
  });

  it("does not duplicate anything when the same workbook is imported again", async () => {
    await setup();
    const b = body([trade(1), trade(2, { teamAPlayersRaw: "A.Judge", tradeDate: null })], [bet(1), bet(2, { amount: null, seasonYear: null })]);
    await post(b);
    const again = await post(b);
    expect(again.body).toMatchObject({ tradesWritten: 0, tradesSkipped: 2, propBetsWritten: 0, propBetsSkipped: 2 });
    expect(await prisma.historicalTrade.count()).toBe(2);
    expect(await prisma.historicalPropBet.count()).toBe(2);
  });

  it("still skips a trade whose team links were filled in after the first import", async () => {
    const { league } = await setup();
    await post(body([trade(1)], []));
    const team = await prisma.team.findFirstOrThrow({ where: { leagueId: league.id } });
    await prisma.historicalTrade.updateMany({ data: { teamAId: team.id, teamBId: team.id } });
    const again = await post(body([trade(1)], []));
    expect(again.body).toMatchObject({ tradesWritten: 0, tradesSkipped: 1 });
    expect(await prisma.historicalTrade.count()).toBe(1);
  });

  it("adds a trade or prop bet that changed in the workbook, keeping the old row", async () => {
    await setup();
    await post(body([trade(1)], [bet(1)]));
    const r = await post(body([trade(1, { teamBPlayersRaw: "M.Betts, F.Freeman" })], [bet(1, { amount: 25 })]));
    expect(r.body).toMatchObject({ tradesWritten: 1, tradesSkipped: 0, propBetsWritten: 1, propBetsSkipped: 0 });
    expect(await prisma.historicalTrade.count()).toBe(2);
    expect(await prisma.historicalPropBet.count()).toBe(2);
  });

  it("treats a field missing from the request like an empty one, not as a wildcard", async () => {
    await setup();
    await post(body([trade(1, { teamADropsRaw: "B.Bunt" })], []));
    const withoutDrops = trade(1) as Partial<ParsedTrade>;
    delete withoutDrops.teamADropsRaw;
    const r = await post(body([withoutDrops as ParsedTrade], []));
    expect(r.body).toMatchObject({ tradesWritten: 1, tradesSkipped: 0 });
    expect(await prisma.historicalTrade.count()).toBe(2);
  });
});
