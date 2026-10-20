import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { Prisma } from "@prisma/client";
import { prisma } from "../db";
import { makeLeagueWithSeason, resetDatabase } from "../test-helpers";

// runYahooSync talks to Yahoo; here it only records a SyncLog the way the
// real one does, so these tests cover what the schedule decides and records.
vi.mock("./sync", () => ({ runYahooSync: vi.fn() }));
import { runYahooSync } from "./sync";
import { runScheduledYahooSync, SCHEDULED_SYNC_ACTION, waitForDatabase } from "./scheduled-sync";
const mockedSync = vi.mocked(runYahooSync);

beforeEach(async () => {
  await resetDatabase();
  mockedSync.mockReset();
});
afterAll(resetDatabase);

async function connection(o: { lastSyncAttemptAt?: Date | null; yahooLeagueKey?: string | null } = {}) {
  const { league } = await makeLeagueWithSeason(2026);
  const conn = await prisma.yahooConnection.create({
    data: {
      leagueId: league.id,
      accessToken: "fake",
      yahooLeagueKey: o.yahooLeagueKey === undefined ? "469.l.8891" : o.yahooLeagueKey,
      yahooGameKey: "469",
      lastSyncAttemptAt: o.lastSyncAttemptAt ?? null,
      syncIntervalMinutes: 180,
    },
  });
  return { league, conn };
}

async function auditEntries() {
  const rows = await prisma.auditLogEntry.findMany({ where: { action: SCHEDULED_SYNC_ACTION } });
  return rows.map((r) => ({ actorName: r.actorName, after: r.after as { eligibleConnections: number; results: Record<string, unknown>[] } }));
}

describe("scheduled Yahoo sync evidence", () => {
  it("records a run even when no connection is eligible", async () => {
    await connection({ yahooLeagueKey: null });
    expect(await runScheduledYahooSync()).toEqual([]);
    expect(mockedSync).not.toHaveBeenCalled();
    const [entry, ...rest] = await auditEntries();
    expect(rest).toEqual([]);
    expect(entry).toMatchObject({ actorName: "Vercel Cron", after: { eligibleConnections: 0, results: [] } });
  });

  it("syncs a due connection and names the SyncLog the run created", async () => {
    const { league, conn } = await connection({ lastSyncAttemptAt: new Date(Date.now() - 20 * 3_600_000) });
    mockedSync.mockImplementation(async () => {
      const log = await prisma.syncLog.create({ data: { connectionId: conn.id, status: "SUCCESS", finishedAt: new Date() } });
      return { status: "SUCCESS", sections: [], totalRecordsUpdated: 437, syncLogId: log.id };
    });
    const [result] = await runScheduledYahooSync();
    const log = await prisma.syncLog.findFirstOrThrow();
    expect(result).toEqual({ leagueId: league.id, outcome: "synced", status: "SUCCESS", syncLogId: log.id, totalRecordsUpdated: 437 });
    expect((await auditEntries())[0].after.results).toEqual([result]);
  });

  it("skips (and records the skip) when the last attempt is within the interval", async () => {
    const now = new Date("2026-10-15T12:05:00Z");
    await connection({ lastSyncAttemptAt: new Date("2026-10-15T10:00:00Z") });
    const [result] = await runScheduledYahooSync(now);
    expect(mockedSync).not.toHaveBeenCalled();
    expect(result).toMatchObject({ outcome: "skipped", minutesSinceLastAttempt: 125 });
    expect((await auditEntries())[0].after.results[0]).toMatchObject({ outcome: "skipped" });
  });

  it("keeps the existing interval rule: due only once more than the interval has passed", async () => {
    const last = new Date("2026-10-15T09:00:00Z");
    await connection({ lastSyncAttemptAt: last });
    mockedSync.mockResolvedValue({ status: "SUCCESS", sections: [], totalRecordsUpdated: 0 });
    expect((await runScheduledYahooSync(new Date(last.getTime() + 180 * 60_000)))[0].outcome).toBe("skipped");
    expect((await runScheduledYahooSync(new Date(last.getTime() + 180 * 60_000 + 1)))[0].outcome).toBe("synced");
  });

  it("records a failed run with its error", async () => {
    await connection();
    mockedSync.mockRejectedValue(new Error("Yahoo token refresh failed"));
    const [result] = await runScheduledYahooSync();
    expect(result).toEqual({ leagueId: expect.any(String), outcome: "failed", error: "Yahoo token refresh failed" });
    expect((await auditEntries())[0].after.results[0]).toMatchObject({ outcome: "failed" });
  });
});

describe("waitForDatabase", () => {
  const coldStart = () => new Prisma.PrismaClientInitializationError("Timed out fetching a new connection", "5.22.0");

  it("waits out a slow database start instead of failing the day's sync", async () => {
    const spy = vi.spyOn(prisma, "$queryRaw").mockRejectedValueOnce(coldStart()).mockRejectedValueOnce(coldStart());
    await expect(waitForDatabase(4, 0)).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalledTimes(3);
    spy.mockRestore();
  });

  it("gives up after the last attempt", async () => {
    const spy = vi.spyOn(prisma, "$queryRaw").mockRejectedValue(coldStart());
    await expect(waitForDatabase(3, 0)).rejects.toBeInstanceOf(Prisma.PrismaClientInitializationError);
    expect(spy).toHaveBeenCalledTimes(3);
    spy.mockRestore();
  });

  it("doesn't retry other errors", async () => {
    const spy = vi.spyOn(prisma, "$queryRaw").mockRejectedValue(new Error("syntax"));
    await expect(waitForDatabase(4, 0)).rejects.toThrow("syntax");
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});
