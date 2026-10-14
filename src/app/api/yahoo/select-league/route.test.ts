import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { prisma } from "@/lib/db";
import { makeLeagueWithSeason, resetDatabase } from "@/lib/test-helpers";

vi.mock("@/lib/current-manager", () => ({
  requireCommissioner: vi.fn(),
  getCurrentManager: vi.fn().mockResolvedValue({ name: "Scott" }),
}));
import { requireCommissioner } from "@/lib/current-manager";
import { POST } from "./route";
const mockedRequire = vi.mocked(requireCommissioner);

beforeEach(async () => {
  await resetDatabase();
  mockedRequire.mockReset();
});
afterAll(resetDatabase);

const post = (body: unknown) => POST(new Request("http://localhost/api/yahoo/select-league", { method: "POST", body: JSON.stringify(body) }));

describe("POST /api/yahoo/select-league", () => {
  it("records which league was selected and when, without any token", async () => {
    mockedRequire.mockResolvedValue({ id: "c" } as Awaited<ReturnType<typeof requireCommissioner>>);
    const { league } = await makeLeagueWithSeason(2026);
    await prisma.yahooConnection.create({ data: { leagueId: league.id, accessToken: "tok-should-not-appear" } });

    expect((await post({ leagueKey: "469.l.8891", gameKey: "469" })).status).toBe(200);

    const entry = await prisma.auditLogEntry.findFirstOrThrow({ where: { action: "YAHOO_LEAGUE_SELECTED" } });
    expect(entry).toMatchObject({ actorName: "Scott", entityType: "YahooConnection" });
    expect(entry.before).toEqual({ yahooLeagueKey: null, yahooGameKey: null });
    expect(entry.after).toEqual({ yahooLeagueKey: "469.l.8891", yahooGameKey: "469" });
    expect(JSON.stringify(entry)).not.toContain("tok-should-not-appear");
  });

  it("records nothing for a non-commissioner", async () => {
    mockedRequire.mockResolvedValue(null as Awaited<ReturnType<typeof requireCommissioner>>);
    expect((await post({ leagueKey: "x", gameKey: "y" })).status).toBe(403);
    expect(await prisma.auditLogEntry.count()).toBe(0);
  });
});
