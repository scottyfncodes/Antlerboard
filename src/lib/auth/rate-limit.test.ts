import { describe, it, expect, afterEach } from "vitest";
import { prisma } from "@/lib/db";
import { resetDatabase } from "@/lib/test-helpers";
import { checkRateLimit, rateLimitKeyForIp, recordFailedAttempt, recordSuccessfulAttempt } from "./rate-limit";

describe("rate-limit", () => {
  afterEach(async () => {
    await resetDatabase();
  });

  it("is not locked for a fresh key", async () => {
    const key = rateLimitKeyForIp("1.2.3.4");
    expect((await checkRateLimit(key)).locked).toBe(false);
  });

  it("derives a stable key from an IP without storing the raw address", () => {
    const key1 = rateLimitKeyForIp("5.6.7.8");
    const key2 = rateLimitKeyForIp("5.6.7.8");
    expect(key1).toBe(key2);
    expect(key1).not.toContain("5.6.7.8");
  });

  it("does not lock after just a couple of failures", async () => {
    const key = rateLimitKeyForIp("1.1.1.1");
    await recordFailedAttempt(key);
    const result = await recordFailedAttempt(key);
    expect(result.locked).toBe(false);
  });

  it("locks after repeated failures, with increasing lockout duration at each stage", async () => {
    const key = rateLimitKeyForIp("2.2.2.2");
    await recordFailedAttempt(key); // 1
    await recordFailedAttempt(key); // 2
    const third = await recordFailedAttempt(key); // 3 -> first lock stage
    expect(third.locked).toBe(true);
    const firstLockSeconds = third.retryAfterSeconds!;

    await recordFailedAttempt(key); // 4
    const fifth = await recordFailedAttempt(key); // 5 -> second (longer) lock stage
    expect(fifth.locked).toBe(true);
    expect(fifth.retryAfterSeconds!).toBeGreaterThan(firstLockSeconds);
  });

  it("reports locked with a positive retryAfterSeconds while within the lock window", async () => {
    const key = rateLimitKeyForIp("3.3.3.3");
    for (let i = 0; i < 3; i++) await recordFailedAttempt(key);
    const status = await checkRateLimit(key);
    expect(status.locked).toBe(true);
    expect(status.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("a successful attempt clears the lock and resets the failure count", async () => {
    const key = rateLimitKeyForIp("4.4.4.4");
    for (let i = 0; i < 3; i++) await recordFailedAttempt(key);
    expect((await checkRateLimit(key)).locked).toBe(true);

    await recordSuccessfulAttempt(key);
    expect((await checkRateLimit(key)).locked).toBe(false);

    const status = await recordFailedAttempt(key);
    expect(status.locked).toBe(false);
  });

  it("stops reporting locked once the lock window has passed", async () => {
    const key = rateLimitKeyForIp("9.9.9.9");
    for (let i = 0; i < 3; i++) await recordFailedAttempt(key);
    expect((await checkRateLimit(key)).locked).toBe(true);

    await prisma.loginAttempt.update({ where: { key }, data: { lockedUntil: new Date(Date.now() - 1000) } });

    expect((await checkRateLimit(key)).locked).toBe(false);
  });
});
