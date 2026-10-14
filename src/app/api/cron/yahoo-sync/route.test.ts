import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { resetDatabase } from "@/lib/test-helpers";

vi.mock("@/lib/yahoo/sync", () => ({ runYahooSync: vi.fn() }));
import { GET } from "./route";

beforeEach(resetDatabase);
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
});
