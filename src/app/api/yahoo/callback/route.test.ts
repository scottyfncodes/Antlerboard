import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { makeLeagueWithSeason, resetDatabase } from "@/lib/test-helpers";

vi.mock("@/lib/yahoo/client", () => ({ exchangeCodeForToken: vi.fn() }));
vi.mock("@/lib/current-manager", () => ({ requireCommissioner: vi.fn() }));

import { exchangeCodeForToken } from "@/lib/yahoo/client";
import { requireCommissioner } from "@/lib/current-manager";
import { GET } from "./route";

const mockedExchange = vi.mocked(exchangeCodeForToken);
const mockedRequireCommissioner = vi.mocked(requireCommissioner);

beforeEach(async () => {
  await resetDatabase();
  mockedExchange.mockReset();
  mockedRequireCommissioner.mockReset();
  mockedRequireCommissioner.mockResolvedValue({ id: "commish" } as Awaited<ReturnType<typeof requireCommissioner>>);
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterAll(resetDatabase);

function callback(params: Record<string, string>, stateCookie?: string) {
  const url = new URL("https://antlerboard.test/api/yahoo/callback");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const req = new NextRequest(url);
  if (stateCookie) req.cookies.set("yahoo_oauth_state", stateCookie);
  return GET(req);
}

const token = { access_token: "a1", refresh_token: "r1", expires_in: 3600, token_type: "bearer", xoauth_yahoo_guid: "G" };

describe("GET /api/yahoo/callback", () => {
  it("stores tokens and redirects with connected=1 on a valid code and state", async () => {
    const { league } = await makeLeagueWithSeason();
    mockedExchange.mockResolvedValueOnce(token);

    const res = await callback({ code: "c", state: "s1" }, "s1");

    expect(res.headers.get("location")).toContain("/commissioner/yahoo?connected=1");
    const conn = await prisma.yahooConnection.findUniqueOrThrow({ where: { leagueId: league.id } });
    expect(conn).toMatchObject({ accessToken: "a1", refreshToken: "r1", yahooGuid: "G" });
  });

  it("reconnecting updates tokens on the same connection and keeps the selected league", async () => {
    const { league } = await makeLeagueWithSeason();
    await prisma.yahooConnection.create({
      data: { leagueId: league.id, accessToken: "old", refreshToken: "old", yahooLeagueKey: "422.l.1" },
    });
    mockedExchange.mockResolvedValueOnce(token);

    await callback({ code: "c", state: "s1" }, "s1");

    const conns = await prisma.yahooConnection.findMany();
    expect(conns).toHaveLength(1);
    expect(conns[0]).toMatchObject({ accessToken: "a1", yahooLeagueKey: "422.l.1" });
  });

  it("rejects a mismatched state without exchanging the code", async () => {
    await makeLeagueWithSeason();
    const res = await callback({ code: "c", state: "attacker" }, "s1");
    expect(res.headers.get("location")).toContain("error=invalid_state");
    expect(mockedExchange).not.toHaveBeenCalled();
  });

  it("rejects a missing code", async () => {
    const res = await callback({ state: "s1" }, "s1");
    expect(res.headers.get("location")).toContain("error=missing_code");
  });

  it("reports a failed token exchange without storing anything", async () => {
    await makeLeagueWithSeason();
    mockedExchange.mockRejectedValueOnce(new Error("Yahoo token exchange failed: 400 invalid_grant"));

    const res = await callback({ code: "c", state: "s1" }, "s1");

    expect(res.headers.get("location")).toContain("error=token_exchange_failed");
    expect(await prisma.yahooConnection.count()).toBe(0);
  });

  it("refuses a non-commissioner", async () => {
    mockedRequireCommissioner.mockResolvedValueOnce(null);
    const res = await callback({ code: "c", state: "s1" }, "s1");
    expect(res.headers.get("location")).toContain("error=commissioner_required");
    expect(mockedExchange).not.toHaveBeenCalled();
  });
});
