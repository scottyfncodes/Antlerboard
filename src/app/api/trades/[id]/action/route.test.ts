import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { prisma } from "@/lib/db";
import { makeLeagueWithSeason, makeManagerAndTeam, makePlayer, resetDatabase } from "@/lib/test-helpers";
import { recomputeKeeperRecordsForPlayer } from "@/lib/keeper-sync";

vi.mock("@/lib/current-manager", () => ({ getCurrentManager: vi.fn() }));

import { getCurrentManager } from "@/lib/current-manager";
import { POST } from "./route";

const mockedCurrent = vi.mocked(getCurrentManager);

beforeEach(async () => {
  await resetDatabase();
  mockedCurrent.mockReset();
});
afterAll(resetDatabase);

async function setup() {
  const { league, season } = await makeLeagueWithSeason();
  const a = await makeManagerAndTeam(league.id, "Alex");
  const b = await makeManagerAndTeam(league.id, "Blair");
  const commish = await makeManagerAndTeam(league.id, "Commish", true);
  const player = await makePlayer(league.id, "Traded Player");
  await prisma.acquisition.create({
    data: { seasonId: season.id, seasonYear: season.year, playerId: player.id, teamId: a.team.id, method: "DRAFT", cost: 5 },
  });
  await recomputeKeeperRecordsForPlayer(player.id, season.year);
  const trade = await prisma.trade.create({
    data: {
      seasonId: season.id,
      seasonYear: season.year,
      proposerId: a.manager.id,
      status: "PROPOSED",
      participants: {
        create: [
          { teamId: a.team.id, isProposer: true, response: "ACCEPTED" },
          { teamId: b.team.id, response: "PENDING" },
        ],
      },
      assets: { create: [{ fromTeamId: a.team.id, toTeamId: b.team.id, assetType: "PLAYER", playerId: player.id }] },
    },
  });
  return { a, b, commish, trade };
}

function actAs(m: { manager: { id: string }; team: { id: string } }) {
  mockedCurrent.mockResolvedValue({ ...m.manager, teams: [m.team] } as unknown as Awaited<ReturnType<typeof getCurrentManager>>);
}

async function call(tradeId: string, action: string) {
  const res = await POST(new Request("http://x", { method: "POST", body: JSON.stringify({ action }) }), {
    params: Promise.resolve({ id: tradeId }),
  });
  return { status: res.status, body: await res.json() };
}

describe("POST /api/trades/[id]/action", () => {
  it("won't let the commissioner accept a trade between two other teams", async () => {
    const { commish, trade } = await setup();
    actAs(commish);
    expect((await call(trade.id, "accept")).status).toBe(404);
    expect((await prisma.trade.findUniqueOrThrow({ where: { id: trade.id } })).status).toBe("PROPOSED");
    expect(await prisma.acquisition.count({ where: { method: "TRADE" } })).toBe(0);
  });

  it("won't let the proposer accept their own trade", async () => {
    const { a, trade } = await setup();
    actAs(a);
    expect((await call(trade.id, "accept")).status).toBe(403);
  });

  it("lets the other team accept, then refuses a second accept", async () => {
    const { b, trade } = await setup();
    actAs(b);
    expect((await call(trade.id, "accept")).status).toBe(200);
    expect((await call(trade.id, "accept")).status).toBe(409);
    expect(await prisma.acquisition.count({ where: { method: "TRADE" } })).toBe(1);
  });

  it("rejects requests with no signed-in manager", async () => {
    const { trade } = await setup();
    mockedCurrent.mockResolvedValue(null);
    expect((await call(trade.id, "accept")).status).toBe(401);
  });
});
