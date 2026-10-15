import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import { prisma } from "@/lib/db";
import { makeLeagueWithSeason, resetDatabase } from "@/lib/test-helpers";
import { yahooFantasyGet, getValidAccessToken } from "./client";
import { YahooApiError, YahooAuthError } from "./errors";

const fetchMock = vi.fn();

beforeEach(async () => {
  await resetDatabase();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("YAHOO_CLIENT_ID", "test-client-id");
  vi.stubEnv("YAHOO_CLIENT_SECRET", "test-client-secret");
  vi.stubEnv("YAHOO_REDIRECT_URI", "https://example.test/api/yahoo/callback");
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});
afterAll(resetDatabase);

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

async function connectedLeague(opts: { expiresInMs?: number } = {}) {
  const { league } = await makeLeagueWithSeason(2026);
  await prisma.yahooConnection.create({
    data: {
      leagueId: league.id,
      accessToken: "old-access",
      refreshToken: "refresh-1",
      tokenExpiresAt: new Date(Date.now() + (opts.expiresInMs ?? 3600_000)),
    },
  });
  return league;
}

// Yahoo's 999 is outside the range the Response constructor accepts.
const denied = () => ({ ok: false, status: 999, text: async () => "Request denied", json: async () => ({}) });

/** Settles a promise that sleeps between retries, advancing fake time until it does. */
async function settleWithFakeTime<T>(promise: Promise<T>): Promise<T> {
  let done = false;
  promise.then(
    () => (done = true),
    () => (done = true)
  );
  while (!done) await vi.advanceTimersByTimeAsync(500);
  return promise;
}

const isTokenCall = (call: unknown[]) => String(call[0]).includes("get_token");

describe("yahooFantasyGet", () => {
  it("sends the stored access token as a Bearer header and asks for JSON", async () => {
    const league = await connectedLeague();
    fetchMock.mockResolvedValueOnce(json(200, { fantasy_content: {} }));

    await yahooFantasyGet(league.id, "/league/422.l.1/standings");

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://fantasysports.yahooapis.com/fantasy/v2/league/422.l.1/standings?format=json");
    expect((init as RequestInit).headers).toEqual({ Authorization: "Bearer old-access" });
  });

  it("refreshes an expired token before calling Yahoo and stores the new one", async () => {
    const league = await connectedLeague({ expiresInMs: -1000 });
    fetchMock
      .mockResolvedValueOnce(json(200, { access_token: "new-access", refresh_token: "refresh-2", expires_in: 3600 }))
      .mockResolvedValueOnce(json(200, { fantasy_content: {} }));

    await yahooFantasyGet(league.id, "/league/422.l.1/teams");

    expect(isTokenCall(fetchMock.mock.calls[0])).toBe(true);
    expect((fetchMock.mock.calls[1][1] as RequestInit).headers).toEqual({ Authorization: "Bearer new-access" });
    const connection = await prisma.yahooConnection.findUniqueOrThrow({ where: { leagueId: league.id } });
    expect(connection.accessToken).toBe("new-access");
    expect(connection.refreshToken).toBe("refresh-2");
    expect(connection.tokenExpiresAt!.getTime()).toBeGreaterThan(Date.now());
  });

  it("force-refreshes once and retries when Yahoo rejects a not-yet-expired token with 401", async () => {
    const league = await connectedLeague();
    fetchMock
      .mockResolvedValueOnce(json(401, { error: { description: "Please provide valid credentials." } }))
      .mockResolvedValueOnce(json(200, { access_token: "new-access", expires_in: 3600 }))
      .mockResolvedValueOnce(json(200, { fantasy_content: { ok: true } }));

    const data = await yahooFantasyGet(league.id, "/league/422.l.1/teams");

    expect(data).toEqual({ fantasy_content: { ok: true } });
    expect(isTokenCall(fetchMock.mock.calls[1])).toBe(true);
    // Yahoo didn't return a new refresh token - the old one is kept.
    const connection = await prisma.yahooConnection.findUniqueOrThrow({ where: { leagueId: league.id } });
    expect(connection.refreshToken).toBe("refresh-1");
  });

  it("does not loop on a second 401", async () => {
    const league = await connectedLeague();
    fetchMock
      .mockResolvedValueOnce(json(401, {}))
      .mockResolvedValueOnce(json(200, { access_token: "new-access", expires_in: 3600 }))
      .mockResolvedValueOnce(json(401, {}));

    await expect(yahooFantasyGet(league.id, "/x")).rejects.toMatchObject({ status: 401 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("throws a reconnect-worthy YahooAuthError when the refresh token is revoked", async () => {
    const league = await connectedLeague({ expiresInMs: -1000 });
    fetchMock.mockResolvedValueOnce(json(400, { error: "invalid_grant", error_description: "refresh token revoked" }));

    const err = (await yahooFantasyGet(league.id, "/x").catch((e: unknown) => e)) as YahooApiError;
    expect(err).toBeInstanceOf(YahooAuthError);
    expect(err.message).toContain("Connect Yahoo again");
    expect(err.message).not.toContain("refresh-1");
  });

  it("retries Yahoo's 999 rate limit with backoff, then succeeds", async () => {
    const league = await connectedLeague();
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    fetchMock
      .mockResolvedValueOnce(denied())
      .mockResolvedValueOnce(json(503, {}))
      .mockResolvedValueOnce(json(200, { fantasy_content: { ok: true } }));

    await expect(settleWithFakeTime(yahooFantasyGet(league.id, "/x"))).resolves.toEqual({ fantasy_content: { ok: true } });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("gives up after the retries are spent", async () => {
    const league = await connectedLeague();
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    fetchMock.mockImplementation(async () => denied());

    const err = (await settleWithFakeTime(yahooFantasyGet(league.id, "/x").catch((e: unknown) => e))) as YahooApiError;
    expect(err).toBeInstanceOf(YahooApiError);
    expect(err.status).toBe(999);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("fails immediately (no retry) on Yahoo's app-not-authorized 403", async () => {
    const league = await connectedLeague();
    fetchMock.mockResolvedValueOnce(
      json(403, { error: { description: "This application is not authorized to perform this action." } })
    );

    const err = (await yahooFantasyGet(league.id, "/x").catch((e: unknown) => e)) as YahooApiError;
    expect(err).toBeInstanceOf(YahooApiError);
    expect(err.isAppNotAuthorized).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refuses when Yahoo was never connected", async () => {
    const { league } = await makeLeagueWithSeason(2026);
    await expect(getValidAccessToken(league.id)).rejects.toThrow("not connected");
  });
});

describe("yahooFantasyGet - failed-response diagnostics", () => {
  const NOT_AUTHORIZED = "This application is not authorized to perform this action.";
  const loggedEvents = (spy: { mock: { calls: unknown[][] } }) =>
    spy.mock.calls.map((call) => String(call[0])).filter((line) => line.includes('"yahoo_api_error"'));

  it("logs one sanitized event for Yahoo's 403, without changing how the request fails", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubEnv("VERCEL_DEPLOYMENT_ID", "dpl_Test123");
    const league = await connectedLeague();
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { description: NOT_AUTHORIZED } }), {
        status: 403,
        headers: { "x-request-id": "yahoo-req-42", "set-cookie": "B=cookie-secret" },
      })
    );

    const err = (await yahooFantasyGet(league.id, "/users;use_login=1/games;game_keys=mlb/leagues").catch(
      (e: unknown) => e
    )) as YahooApiError;

    expect(err).toBeInstanceOf(YahooApiError);
    expect(err.isAppNotAuthorized).toBe(true);
    expect(err.message).toBe(
      `Yahoo API request failed (403): /users;use_login=1/games;game_keys=mlb/leagues - ${NOT_AUTHORIZED}`
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const lines = loggedEvents(spy);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({
      event: "yahoo_api_error",
      status: 403,
      path: "/users;use_login=1/games;game_keys=mlb/leagues",
      attempt: 0,
      deployment: "dpl_Test123",
      message: NOT_AUTHORIZED,
      requestIds: { "x-request-id": "yahoo-req-42" },
    });
    spy.mockRestore();
  });

  it("never lets the access token, refresh token, client secret or cookies into the log", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const league = await connectedLeague({ expiresInMs: -1000 });
    fetchMock
      .mockResolvedValueOnce(json(200, { access_token: "fresh-access-token", refresh_token: "fresh-refresh-token", expires_in: 3600 }))
      .mockResolvedValueOnce(
        new Response(
          // A body or header echoing the credentials back must not reach the log either.
          JSON.stringify({ error: { description: "denied token=fresh-access-token secret=test-client-secret" } }),
          { status: 403, headers: { "set-cookie": "T=cookie-secret", "x-request-id": "fresh-access-token" } }
        )
      );

    await yahooFantasyGet(league.id, "/league/458.l.12345/standings?code=oauth-code&state=oauth-state").catch(() => {});

    const output = spy.mock.calls.map((call) => call.map(String).join(" ")).join("\n");
    for (const secret of [
      "fresh-access-token",
      "old-access",
      "fresh-refresh-token",
      "refresh-1",
      "test-client-secret",
      "cookie-secret",
      "oauth-code",
      "oauth-state",
      "12345",
    ]) {
      expect(output).not.toContain(secret);
    }
    const event = JSON.parse(loggedEvents(spy)[0]);
    expect(event.path).toBe("/league/{key}/standings");
    expect(event.message).toBe("denied token=[redacted] secret=[redacted]");
    expect(event.requestIds).toEqual({ "x-request-id": "[redacted]" });
    spy.mockRestore();
  });

  it("logs each failed attempt once and keeps the existing retry count when Yahoo sends no headers", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const league = await connectedLeague();
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    fetchMock.mockImplementation(async () => denied());

    const err = (await settleWithFakeTime(yahooFantasyGet(league.id, "/x").catch((e: unknown) => e))) as YahooApiError;

    expect(err.status).toBe(999);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const events = loggedEvents(spy).map((line) => JSON.parse(line));
    expect(events.map((e) => e.attempt)).toEqual([0, 1, 2]);
    expect(events[0]).toMatchObject({ status: 999, message: "Request denied", requestIds: {}, headerNames: [] });
    spy.mockRestore();
  });

  it("logs nothing when Yahoo answers successfully", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const league = await connectedLeague();
    fetchMock.mockResolvedValueOnce(json(200, { fantasy_content: {} }));

    await yahooFantasyGet(league.id, "/x");

    expect(loggedEvents(spy)).toHaveLength(0);
    spy.mockRestore();
  });
});

describe("missingYahooEnvVars", () => {
  it("is empty when all three are set", async () => {
    const { missingYahooEnvVars, isYahooConfigured } = await import("./client");
    expect(missingYahooEnvVars()).toEqual([]);
    expect(isYahooConfigured()).toBe(true);
  });

  it("names unset and whitespace-only vars without revealing values", async () => {
    vi.stubEnv("YAHOO_CLIENT_ID", "   ");
    vi.stubEnv("YAHOO_REDIRECT_URI", "");
    const { missingYahooEnvVars, isYahooConfigured } = await import("./client");
    expect(missingYahooEnvVars()).toEqual(["YAHOO_CLIENT_ID", "YAHOO_REDIRECT_URI"]);
    expect(isYahooConfigured()).toBe(false);
  });
});

describe("yahooFantasyGet with allowRefresh: false (read-only tools)", () => {
  it("uses the stored token while it's valid, without touching the token endpoint", async () => {
    const league = await connectedLeague();
    fetchMock.mockResolvedValueOnce(json(200, { fantasy_content: { ok: true } }));
    await expect(yahooFantasyGet(league.id, "/league/469.l.1/settings", { allowRefresh: false })).resolves.toEqual({ fantasy_content: { ok: true } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain("fantasysports.yahooapis.com");
  });

  it("refuses an expired token without refreshing it or writing anything", async () => {
    const league = await connectedLeague({ expiresInMs: -60_000 });
    const before = await prisma.yahooConnection.findFirstOrThrow();
    await expect(yahooFantasyGet(league.id, "/league/469.l.1/settings", { allowRefresh: false })).rejects.toThrow(/expired.*doesn't refresh/);
    expect(fetchMock).not.toHaveBeenCalled();
    const after = await prisma.yahooConnection.findFirstOrThrow();
    expect(after.updatedAt).toEqual(before.updatedAt);
    expect(after.accessToken).toBe("old-access");
  });

  it("fails on a 401 instead of refreshing", async () => {
    const league = await connectedLeague();
    fetchMock.mockResolvedValueOnce(json(401, { error: { description: "token rejected" } }));
    await expect(yahooFantasyGet(league.id, "/league/469.l.1/settings", { allowRefresh: false })).rejects.toBeInstanceOf(YahooApiError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((await prisma.yahooConnection.findFirstOrThrow()).accessToken).toBe("old-access");
  });
});
