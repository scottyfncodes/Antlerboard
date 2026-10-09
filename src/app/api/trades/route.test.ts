import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { prisma } from "@/lib/db";
import { makeLeagueWithSeason, makeManagerAndTeam, resetDatabase } from "@/lib/test-helpers";

vi.mock("@/lib/current-manager", () => ({ getCurrentManager: vi.fn() }));

import { getCurrentManager } from "@/lib/current-manager";
import { GET as getTrades } from "./route";
import { GET as getOffers } from "../offers/route";

const mockedCurrent = vi.mocked(getCurrentManager);

beforeEach(async () => {
  await resetDatabase();
  mockedCurrent.mockReset();
});
afterAll(resetDatabase);

describe("trade and offer lists", () => {
  it("never include a manager's email", async () => {
    const { league, season } = await makeLeagueWithSeason();
    const a = await makeManagerAndTeam(league.id, "Alex");
    const b = await makeManagerAndTeam(league.id, "Blair");
    await prisma.manager.updateMany({ data: { email: null } });
    await prisma.manager.update({ where: { id: a.manager.id }, data: { email: "alex@example.test" } });
    await prisma.manager.update({ where: { id: b.manager.id }, data: { email: "blair@example.test" } });
    await prisma.trade.create({
      data: {
        seasonId: season.id,
        seasonYear: season.year,
        proposerId: a.manager.id,
        status: "ACCEPTED",
        participants: { create: [{ teamId: a.team.id, isProposer: true, response: "ACCEPTED" }, { teamId: b.team.id, response: "ACCEPTED" }] },
        assets: { create: [{ fromTeamId: a.team.id, toTeamId: b.team.id, assetType: "DRAFT_PICK", draftPickDescription: "2027 1st" }] },
      },
    });
    await prisma.offer.create({
      data: { sendingTeamId: a.team.id, sendingManagerId: a.manager.id, receivingTeamId: b.team.id, status: "ACCEPTED" },
    });
    mockedCurrent.mockResolvedValue({ ...b.manager, teams: [b.team] } as unknown as Awaited<ReturnType<typeof getCurrentManager>>);

    const trades = JSON.stringify(await (await getTrades()).json());
    const offers = JSON.stringify(await (await getOffers()).json());
    expect(trades).toContain("Alex");
    expect(trades).not.toContain("@example.test");
    expect(offers).not.toContain("@example.test");
  });
});
