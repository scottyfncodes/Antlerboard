import { describe, it, expect, afterEach, vi } from "vitest";
import { makeLeagueWithSeason, makeManagerAndTeam, resetDatabase } from "@/lib/test-helpers";
import { prisma } from "@/lib/db";

// requireCommissioner() reads next/headers' cookies(), which needs a real
// request context - stub it so the route's validation can be exercised directly.
const commissionerMock = vi.hoisted(() => ({ current: null as null | { id: string; name: string } }));
vi.mock("@/lib/current-manager", () => ({
  requireCommissioner: async () => commissionerMock.current,
}));

import { PATCH } from "./route";

function req(body: unknown): Request {
  return new Request("https://antlerboard.example/api/commissioner/draft-day-details", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function setup() {
  const { league, season } = await makeLeagueWithSeason();
  const { manager } = await makeManagerAndTeam(league.id, "The Commissioner", true);
  commissionerMock.current = { id: manager.id, name: manager.name };
  return { season };
}

describe("PATCH /api/commissioner/draft-day-details", () => {
  afterEach(async () => {
    commissionerMock.current = null;
    await prisma.draftDayDetails.deleteMany();
    await resetDatabase();
  });

  it("rejects a non-commissioner", async () => {
    const res = await PATCH(req({ seasonId: "x" }));
    expect(res.status).toBe(403);
  });

  it.each(["abc", "26O", "-5", "12.5", "1e3"])("returns 400 for a non-numeric budget (%s)", async (auctionBudget) => {
    const { season } = await setup();
    const res = await PATCH(req({ seasonId: season.id, auctionBudget }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/auction budget/i);
    expect(await prisma.draftDayDetails.count()).toBe(0);
  });

  it("returns 400 for a missing seasonId or malformed body", async () => {
    await setup();
    expect((await PATCH(req({ auctionBudget: "260" }))).status).toBe(400);
    expect((await PATCH(req("not json"))).status).toBe(400);
  });

  it("saves a valid budget and treats blank as no budget", async () => {
    const { season } = await setup();
    let res = await PATCH(req({ seasonId: season.id, auctionBudget: " 260 ", venue: "Zoom" }));
    expect(res.status).toBe(200);
    expect((await res.json()).details).toMatchObject({ auctionBudget: 260, venue: "Zoom" });

    res = await PATCH(req({ seasonId: season.id, auctionBudget: "" }));
    expect(res.status).toBe(200);
    expect((await res.json()).details.auctionBudget).toBeNull();
  });
});
