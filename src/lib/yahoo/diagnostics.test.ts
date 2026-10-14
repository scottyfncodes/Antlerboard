import { describe, it, expect, afterEach, vi } from "vitest";
import { createHash } from "crypto";
import {
  buildYahooApiErrorEvent,
  logYahooApiError,
  pickYahooResponseHeaders,
  sanitizeYahooMessage,
  sanitizeYahooPath,
  yahooClientIdFingerprint,
} from "./diagnostics";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const CLIENT_ID = "dj0yJmk9ZGJ4d3lxV1lMNUJTJmQ9WVdrOVYwdEZTRVZOTkhvbWNHbzlNQT09JnM9Y29uc3VtZXJzZWNyZXQmc3Y9MCZ4PTFm";

describe("sanitizeYahooPath", () => {
  it("keeps the league-discovery path as-is", () => {
    expect(sanitizeYahooPath("/users;use_login=1/games;game_keys=mlb/leagues")).toBe(
      "/users;use_login=1/games;game_keys=mlb/leagues"
    );
  });

  it("replaces league, team and player keys with placeholders", () => {
    expect(sanitizeYahooPath("/league/458.l.12345/standings")).toBe("/league/{key}/standings");
    expect(sanitizeYahooPath("/team/458.l.12345.t.7/roster")).toBe("/team/{key}/roster");
    expect(sanitizeYahooPath("/player/458.p.9876")).toBe("/player/{key}");
  });

  it("drops query strings and fragments, including OAuth code and state", () => {
    expect(sanitizeYahooPath("/league/458.l.1/transactions?code=abc123&state=deadbeef#x")).toBe(
      "/league/{key}/transactions"
    );
  });

  it("redacts user guids and key lists in matrix params", () => {
    expect(sanitizeYahooPath("/users;guid=ABCDEF123/games;game_keys=mlb")).toBe(
      "/users;guid={redacted}/games;game_keys=mlb"
    );
    expect(sanitizeYahooPath("/leagues;league_keys=458.l.1,458.l.2")).toBe("/leagues;league_keys={redacted}");
  });

  it("replaces unexpected characters and caps the length", () => {
    expect(sanitizeYahooPath("/league/a b\n<script>")).toBe("/league/a?b??script?");
    expect(sanitizeYahooPath("/" + "a".repeat(500)).length).toBe(200);
  });
});

describe("sanitizeYahooMessage", () => {
  it("keeps Yahoo's app-not-authorized description intact", () => {
    expect(sanitizeYahooMessage("This application is not authorized to perform this action.")).toBe(
      "This application is not authorized to perform this action."
    );
  });

  it("returns null for an empty or missing message", () => {
    expect(sanitizeYahooMessage(null)).toBeNull();
    expect(sanitizeYahooMessage("  \n ")).toBeNull();
  });

  it("strips control characters so a message can't forge extra log lines", () => {
    expect(sanitizeYahooMessage("denied\r\n{\"event\":\"fake\"}\u0000\u2028end")).toBe('denied {"event":"fake"} end');
  });

  it("redacts bearer credentials and long token-like strings", () => {
    const out = sanitizeYahooMessage(
      "bad Authorization: Bearer abc.def-ghi token=AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcdef done"
    );
    expect(out).toBe("bad Authorization: Bearer [redacted] [redacted] done");
  });

  it("redacts the exact access token and client secret even when they are short", () => {
    vi.stubEnv("YAHOO_CLIENT_SECRET", "shortsecret");
    expect(sanitizeYahooMessage("echo tok123456 and shortsecret", ["tok123456"])).toBe(
      "echo [redacted] and [redacted]"
    );
  });

  it("caps the message at 300 characters", () => {
    expect(sanitizeYahooMessage("word ".repeat(200))!.length).toBe(300);
  });
});

describe("pickYahooResponseHeaders", () => {
  it("logs only allowlisted request-ID values, plus the names of every header", () => {
    const headers = new Headers({
      "x-request-id": "abc-123",
      "y-rid": "5d8f1:9e",
      "set-cookie": "B=secret-cookie-value",
      "content-type": "application/json",
    });
    const { requestIds, headerNames } = pickYahooResponseHeaders(headers);
    expect(requestIds).toEqual({ "x-request-id": "abc-123", "y-rid": "5d8f1:9e" });
    expect(headerNames).toEqual(["content-type", "set-cookie", "x-request-id", "y-rid"]);
    expect(JSON.stringify({ requestIds, headerNames })).not.toContain("secret-cookie-value");
  });

  it("returns nothing when the response has no headers at all", () => {
    expect(pickYahooResponseHeaders(undefined)).toEqual({ requestIds: {}, headerNames: [] });
    expect(pickYahooResponseHeaders(new Headers())).toEqual({ requestIds: {}, headerNames: [] });
  });

  it("redacts a request-ID header that carries a known credential", () => {
    const headers = new Headers({ "x-request-id": "tok123456" });
    expect(pickYahooResponseHeaders(headers, ["tok123456"]).requestIds).toEqual({ "x-request-id": "[redacted]" });
  });

  it("marks unexpected request-ID values instead of logging them", () => {
    const headers = new Headers({
      "x-request-id": "has spaces and <html>",
      "x-correlation-id": "x".repeat(200),
    });
    expect(pickYahooResponseHeaders(headers).requestIds).toEqual({
      "x-request-id": "[unexpected]",
      "x-correlation-id": "[unexpected]",
    });
  });
});

describe("yahooClientIdFingerprint", () => {
  it("gives the last six characters and a SHA-256 prefix, never the whole ID", () => {
    vi.stubEnv("YAHOO_CLIENT_ID", CLIENT_ID);
    const fingerprint = yahooClientIdFingerprint();
    expect(fingerprint).toEqual({
      tail: CLIENT_ID.slice(-6),
      sha256: createHash("sha256").update(CLIENT_ID).digest("hex").slice(0, 12),
      surroundingWhitespace: false,
    });
    expect(JSON.stringify(fingerprint)).not.toContain(CLIENT_ID.slice(0, 20));
  });

  it("is null when no Client ID is configured", () => {
    vi.stubEnv("YAHOO_CLIENT_ID", "");
    expect(yahooClientIdFingerprint()).toBeNull();
    vi.stubEnv("YAHOO_CLIENT_ID", "  \n");
    expect(yahooClientIdFingerprint()).toBeNull();
  });

  it("hashes the exact value sent to Yahoo and flags surrounding whitespace", () => {
    vi.stubEnv("YAHOO_CLIENT_ID", `${CLIENT_ID}\n`);
    const fingerprint = yahooClientIdFingerprint()!;
    expect(fingerprint.surroundingWhitespace).toBe(true);
    expect(fingerprint.tail).toBe(CLIENT_ID.slice(-6));
    // Differs from a cleanly pasted copy - which is the point: Yahoo gets the newline too.
    expect(fingerprint.sha256).toBe(createHash("sha256").update(`${CLIENT_ID}\n`).digest("hex").slice(0, 12));
    expect(fingerprint.sha256).not.toBe(createHash("sha256").update(CLIENT_ID).digest("hex").slice(0, 12));
  });

  it("matches the Client ID that buildAuthorizationUrl sends", async () => {
    vi.stubEnv("YAHOO_CLIENT_ID", CLIENT_ID);
    vi.stubEnv("YAHOO_REDIRECT_URI", "https://example.test/api/yahoo/callback");
    const { buildAuthorizationUrl } = await import("./client");
    const sent = new URL(buildAuthorizationUrl("state")).searchParams.get("client_id")!;
    expect(yahooClientIdFingerprint()!.sha256).toBe(createHash("sha256").update(sent).digest("hex").slice(0, 12));
  });

  it("does not show the tail of an implausibly short Client ID", () => {
    vi.stubEnv("YAHOO_CLIENT_ID", "short-id");
    expect(yahooClientIdFingerprint()!.tail).toBe("[short]");
  });
});

describe("buildYahooApiErrorEvent / logYahooApiError", () => {
  it("builds the full event for Yahoo's app-not-authorized 403", () => {
    vi.stubEnv("YAHOO_CLIENT_ID", CLIENT_ID);
    vi.stubEnv("VERCEL_DEPLOYMENT_ID", "dpl_TestDeployment123");
    const event = buildYahooApiErrorEvent({
      status: 403,
      path: "/users;use_login=1/games;game_keys=mlb/leagues",
      attempt: 0,
      description: "This application is not authorized to perform this action.",
      headers: new Headers({ "x-request-id": "req-1" }),
    });
    expect(event).toMatchObject({
      event: "yahoo_api_error",
      status: 403,
      path: "/users;use_login=1/games;game_keys=mlb/leagues",
      attempt: 0,
      deployment: "dpl_TestDeployment123",
      message: "This application is not authorized to perform this action.",
      clientId: { tail: CLIENT_ID.slice(-6) },
      requestIds: { "x-request-id": "req-1" },
    });
    expect(new Date(event.at).toISOString()).toBe(event.at);
  });

  it("falls back to VERCEL_URL and then to null for the deployment", () => {
    vi.stubEnv("VERCEL_DEPLOYMENT_ID", "");
    vi.stubEnv("VERCEL_URL", "antlerboard-abc123-nocodo.vercel.app");
    const base = { status: 500, path: "/x", attempt: 0, description: null, headers: undefined };
    expect(buildYahooApiErrorEvent(base).deployment).toBe("antlerboard-abc123-nocodo.vercel.app");
    vi.stubEnv("VERCEL_URL", "");
    expect(buildYahooApiErrorEvent(base).deployment).toBeNull();
  });

  it("writes exactly one JSON line and never the client secret", () => {
    vi.stubEnv("YAHOO_CLIENT_ID", CLIENT_ID);
    vi.stubEnv("YAHOO_CLIENT_SECRET", "super-secret-value-0123456789");
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    logYahooApiError({ status: 403, path: "/league/458.l.1/teams", attempt: 0, description: "nope", headers: undefined });
    expect(spy).toHaveBeenCalledTimes(1);
    const line = String(spy.mock.calls[0][0]);
    expect(line).not.toContain("\n");
    expect(JSON.parse(line).event).toBe("yahoo_api_error");
    expect(line).not.toContain("super-secret-value");
    expect(line).not.toContain(CLIENT_ID);
  });

  it("never throws, even if logging itself fails", () => {
    vi.spyOn(console, "error").mockImplementation(() => {
      throw new Error("log sink down");
    });
    expect(() =>
      logYahooApiError({ status: 403, path: "/x", attempt: 0, description: null, headers: undefined })
    ).not.toThrow();
  });
});
