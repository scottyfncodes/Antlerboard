import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("@/lib/current-manager", () => ({ requireCommissioner: vi.fn() }));

import { requireCommissioner } from "@/lib/current-manager";
import { GET } from "./route";

const mockedRequireCommissioner = vi.mocked(requireCommissioner);
const SECRET = "super-secret-value-123";

beforeEach(() => {
  mockedRequireCommissioner.mockReset();
  mockedRequireCommissioner.mockResolvedValue({ id: "commish" } as Awaited<ReturnType<typeof requireCommissioner>>);
  vi.stubEnv("YAHOO_CLIENT_ID", "test-client-id");
  vi.stubEnv("YAHOO_CLIENT_SECRET", SECRET);
  vi.stubEnv("YAHOO_REDIRECT_URI", "https://antlerboard.test/api/yahoo/callback");
});
afterEach(() => vi.unstubAllEnvs());

describe("GET /api/yahoo/authorize", () => {
  it("names exactly the missing or blank Yahoo vars, and never their values", async () => {
    vi.stubEnv("YAHOO_CLIENT_ID", "   ");
    vi.stubEnv("YAHOO_REDIRECT_URI", "");

    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe(
      "Yahoo OAuth is not configured in this environment. Missing or blank: YAHOO_CLIENT_ID, YAHOO_REDIRECT_URI."
    );
    expect(JSON.stringify(body)).not.toContain(SECRET);
    expect(res.headers.get("location")).toBeNull();
  });

  it("redirects to Yahoo with the configured Client ID when all three are set", async () => {
    const res = await GET();
    const location = new URL(res.headers.get("location")!);

    expect(res.status).toBe(307);
    expect(location.origin + location.pathname).toBe("https://api.login.yahoo.com/oauth2/request_auth");
    expect(location.searchParams.get("client_id")).toBe("test-client-id");
    expect(location.toString()).not.toContain(SECRET);
    expect(res.cookies.get("yahoo_oauth_state")?.value).toMatch(/^[0-9a-f]{32}$/);
  });

  it("refuses a non-commissioner before looking at configuration", async () => {
    mockedRequireCommissioner.mockResolvedValueOnce(null);
    expect((await GET()).status).toBe(403);
  });
});
