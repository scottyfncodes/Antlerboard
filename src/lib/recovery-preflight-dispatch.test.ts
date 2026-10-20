import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import { prisma } from "./db";
import { resetDatabase } from "./test-helpers";
import { dispatchRecoveryPreflight, recordRecoveryDispatch, RECOVERY_DISPATCH_ACTION } from "./recovery-preflight-dispatch";

const TOKEN = "github_pat_test_value_never_logged";
const fetchMock = vi.fn();

beforeEach(async () => {
  await resetDatabase();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("VERCEL_ENV", "production");
  vi.stubEnv("GITHUB_RECOVERY_DISPATCH_TOKEN", TOKEN);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
afterAll(resetDatabase);

const reply = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), { status });

describe("dispatchRecoveryPreflight", () => {
  it("asks GitHub to run the preflight workflow on the production branch", async () => {
    fetchMock.mockResolvedValue(reply(204));
    expect(await dispatchRecoveryPreflight(0)).toEqual({ status: "sent", attempts: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      "https://api.github.com/repos/scottyfncodes/Antlerboard/actions/workflows/recovery-preflight.yml/dispatches"
    );
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(init.body)).toEqual({
      ref: "claude/antlerboard-fantasy-baseball-7b3vai",
      inputs: { mode: "preflight" },
    });
  });

  it("sends nothing outside Production or without the token", async () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    expect(await dispatchRecoveryPreflight(0)).toEqual({ status: "skipped", reason: "not Production" });
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("GITHUB_RECOVERY_DISPATCH_TOKEN", " ");
    expect(await dispatchRecoveryPreflight(0)).toMatchObject({ status: "skipped" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("retries once after a network error or a 5xx", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed")).mockResolvedValueOnce(reply(204));
    expect(await dispatchRecoveryPreflight(0)).toEqual({ status: "sent", attempts: 2 });

    fetchMock.mockReset();
    fetchMock.mockResolvedValue(reply(502));
    expect(await dispatchRecoveryPreflight(0)).toEqual({ status: "failed", attempts: 2, error: "HTTP 502" });
  });

  it("doesn't retry a refusal, and reports GitHub's reason without the token", async () => {
    fetchMock.mockResolvedValue(reply(403, { message: "Resource not accessible by personal access token" }));
    const result = await dispatchRecoveryPreflight(0);
    expect(result).toEqual({
      status: "failed",
      attempts: 1,
      error: "HTTP 403: Resource not accessible by personal access token",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });
});

describe("recordRecoveryDispatch", () => {
  it("leaves an audit entry the recovery's own checks don't count", async () => {
    await recordRecoveryDispatch({ status: "sent", attempts: 1 }, new Date("2026-10-21T12:01:10Z"));
    const entry = await prisma.auditLogEntry.findFirstOrThrow();
    expect(entry).toMatchObject({
      action: RECOVERY_DISPATCH_ACTION,
      actorName: "Vercel Cron",
      after: { at: "2026-10-21T12:01:10.000Z", status: "sent", attempts: 1 },
    });
    // The preflight's baseline counts YAHOO_TRANSACTION_RECOVERY% entries and
    // reads the latest YAHOO_SYNC_CRON one.
    expect(entry.action.startsWith("YAHOO_")).toBe(false);
  });
});
