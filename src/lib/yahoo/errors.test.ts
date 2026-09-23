import { describe, it, expect } from "vitest";
import { YahooApiError, parseYahooErrorDescription } from "./errors";

describe("parseYahooErrorDescription", () => {
  it("extracts the description from Yahoo's JSON error envelope", () => {
    const body = JSON.stringify({
      error: {
        "xml:lang": "en-us",
        "yahoo:uri": "/fantasy/v2/users;use_login=1/games;game_keys=mlb/leagues?format=json",
        description: "This application is not authorized to perform this action.",
        detail: "",
      },
    });
    expect(parseYahooErrorDescription(body)).toBe("This application is not authorized to perform this action.");
  });

  it("extracts the description from an XML error body", () => {
    const body = `<?xml version="1.0"?><error><description>Invalid league key</description></error>`;
    expect(parseYahooErrorDescription(body)).toBe("Invalid league key");
  });

  it("falls back to a truncated raw body for anything else", () => {
    expect(parseYahooErrorDescription("x".repeat(1000))).toHaveLength(300);
  });

  it("returns null for an empty body", () => {
    expect(parseYahooErrorDescription("")).toBeNull();
  });
});

describe("YahooApiError.isAppNotAuthorized", () => {
  it("is true only for a 403 with Yahoo's app-not-authorized description", () => {
    expect(new YahooApiError(403, "/x", "This application is not authorized to perform this action.").isAppNotAuthorized).toBe(true);
    expect(new YahooApiError(403, "/x", "Forbidden").isAppNotAuthorized).toBe(false);
    expect(new YahooApiError(401, "/x", "This application is not authorized to perform this action.").isAppNotAuthorized).toBe(false);
    expect(new YahooApiError(403, "/x", null).isAppNotAuthorized).toBe(false);
  });

  it("keeps the status, path and description in the message", () => {
    expect(new YahooApiError(403, "/league/1", "Nope").message).toBe("Yahoo API request failed (403): /league/1 - Nope");
  });
});
