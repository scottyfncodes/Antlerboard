/**
 * Brute-force protection for PIN login. A 4-digit PIN only has 10,000
 * possible values, so the real defense has to be online rate limiting, not
 * the hash. Buckets are keyed by a hash of the caller's IP rather than by
 * manager - the whole point of a PIN-only login is that a failed attempt
 * doesn't reveal which manager it was aimed at, so attempts can't be
 * tracked per-manager without defeating that.
 *
 * Backed by the `LoginAttempt` table (not in-memory) because Vercel
 * functions are stateless/multi-instance - an in-process counter would
 * reset on every cold start and wouldn't be shared across instances.
 */

import { createHash } from "crypto";
import { prisma } from "@/lib/db";

const RESET_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Escalating lockout: more failures in a row cost more time, capped at 30 minutes. */
const LOCK_STAGES: Array<{ afterFailures: number; lockSeconds: number }> = [
  { afterFailures: 3, lockSeconds: 30 },
  { afterFailures: 5, lockSeconds: 120 },
  { afterFailures: 7, lockSeconds: 600 },
  { afterFailures: 10, lockSeconds: 1800 },
];

function lockSecondsFor(failCount: number): number {
  let seconds = 0;
  for (const stage of LOCK_STAGES) {
    if (failCount >= stage.afterFailures) seconds = stage.lockSeconds;
  }
  return seconds;
}

/** Derives a stable bucket key from an IP without storing the raw address. */
export function rateLimitKeyForIp(ip: string): string {
  return createHash("sha256").update(ip).digest("hex");
}

export interface RateLimitStatus {
  locked: boolean;
  retryAfterSeconds?: number;
}

export async function checkRateLimit(key: string): Promise<RateLimitStatus> {
  const row = await prisma.loginAttempt.findUnique({ where: { key } });
  if (!row?.lockedUntil) return { locked: false };

  const remainingMs = row.lockedUntil.getTime() - Date.now();
  if (remainingMs <= 0) return { locked: false };
  return { locked: true, retryAfterSeconds: Math.ceil(remainingMs / 1000) };
}

export async function recordFailedAttempt(key: string): Promise<RateLimitStatus> {
  const existing = await prisma.loginAttempt.findUnique({ where: { key } });
  const now = Date.now();
  const isStale = !!existing && now - existing.updatedAt.getTime() > RESET_WINDOW_MS;
  const failCount = (existing && !isStale ? existing.failCount : 0) + 1;

  const lockSeconds = lockSecondsFor(failCount);
  const lockedUntil = lockSeconds > 0 ? new Date(now + lockSeconds * 1000) : null;

  await prisma.loginAttempt.upsert({
    where: { key },
    create: { key, failCount, lockedUntil },
    update: { failCount, lockedUntil },
  });

  return lockedUntil ? { locked: true, retryAfterSeconds: lockSeconds } : { locked: false };
}

export async function recordSuccessfulAttempt(key: string): Promise<void> {
  await prisma.loginAttempt.upsert({
    where: { key },
    create: { key, failCount: 0, lockedUntil: null },
    update: { failCount: 0, lockedUntil: null },
  });
}
