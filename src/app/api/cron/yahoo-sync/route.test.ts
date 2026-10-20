import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { resetDatabase } from "@/lib/test-helpers";

vi.mock("@/lib/yahoo/sync", () => ({ runYahooSync: vi.fn() }));
vi.mock("@/lib/recovery-preflight-dispatch", async (original) => ({
  ...(await original<typeof import("@/lib/recovery-preflight-dispatch")>()),
  dispatchRecoveryPreflight: vi.fn(),
}));
import { GET } from "./route";
import { runYahooSync } from "@/lib/yahoo/sync";
import { dispatchRecoveryPreflight } from "@/lib/recovery-preflight-dispatch";
import { makeLeagueWithSeason } from "@/lib/test-helpers";

beforeEach(async () => {
  await resetDatabase();
  vi.mocked(dispatchRecoveryPreflight).mockReset();
});
afterEach(() => vi.unstubAllEnvs());
afterAll(resetDatabase);

const get = (authorization?: string) =>
  GET(new NextRequest("http://localhost/api/cron/yahoo-sync", { headers: authorization ? { authorization } : {} }));

describe("GET /api/cron/yahoo-sync", () => {
  it("runs and leaves an audit record for Vercel's authenticated request", async () => {
    vi.stubEnv("CRON_SECRET", "s3cret");
    const res = await get("Bearer s3cret");
    expect(res.status).toBe(200);
    expect(await prisma.auditLogEntry.count({ where: { action: "YAHOO_SYNC_CRON" } })).toBe(1);
  });

  it("refuses a wrong secret without recording or syncing anything", async () => {
    vi.stubEnv("CRON_SECRET", "s3cret");
    expect((await get("Bearer wrong")).status).toBe(401);
    expect(await prisma.auditLogEntry.count()).toBe(0);
  });

  it("refuses every request when CRON_SECRET isn't configured", async () => {
    vi.stubEnv("CRON_SECRET", "");
    expect((await get()).status).toBe(401);
    expect((await get("Bearer undefined")).status).toBe(401);
    expect(await prisma.auditLogEntry.count()).toBe(0);
  });

  it("starts the recovery preflight once a league has synced, and records it", async () => {
    vi.stubEnv("CRON_SECRET", "s3cret");
    const { league } = await makeLeagueWithSeason(2026);
    await prisma.yahooConnection.create({
      data: { leagueId: league.id, accessToken: "fake", yahooLeagueKey: "469.l.8891", yahooGameKey: "469" },
    });
    vi.mocked(runYahooSync).mockResolvedValue({ status: "PARTIAL", sections: [], totalRecordsUpdated: 0 });
    vi.mocked(dispatchRecoveryPreflight).mockResolvedValue({ status: "sent", attempts: 1 });
    const res = await get("Bearer s3cret");
    expect((await res.json()).recoveryDispatch).toEqual({ status: "sent", attempts: 1 });
    expect(await prisma.auditLogEntry.count({ where: { action: "RECOVERY_PREFLIGHT_DISPATCH" } })).toBe(1);
  });

  it("doesn't start it when nothing synced", async () => {
    vi.stubEnv("CRON_SECRET", "s3cret");
    const res = await get("Bearer s3cret");
    expect((await res.json()).recoveryDispatch).toEqual({ status: "skipped", reason: "nothing synced" });
    expect(dispatchRecoveryPreflight).not.toHaveBeenCalled();
    expect(await prisma.auditLogEntry.count({ where: { action: "RECOVERY_PREFLIGHT_DISPATCH" } })).toBe(0);
  });
});
