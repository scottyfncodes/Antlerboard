/**
 * Brute-force protection for PIN login. A 4-digit PIN only has 10,000
 * possible values, so the real defense has to be online rate limiting, not
 * the hash. Buckets are keyed by a hash of the caller's IP rather than by
 * manager - the whole point of a PIN-only login is that a failed attempt
 * doesn't reveal which manager it was aimed at, so attempts can't be
 * tracked per-manager without defeating that. A second, league-wide bucket
 * caps failures across all IPs, so rotating addresses doesn't buy an
 * attacker a fresh budget each time.
 *
 * Backed by the `LoginAttempt` table (not in-memory) because Vercel
 * functions are stateless/multi-instance - an in-process counter would
 * reset on every cold start and wouldn't be shared across instances.
 *
 * Every update locks the bucket's row inside a transaction, so
 * a burst of concurrent attempts is counted one by one: each attempt is
 * reserved (counted as a failure) before the PIN is checked, and refused if
 * the bucket was already locked when it arrived.
 */

import { createHash } from "crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";

type LockStage = { afterFailures: number; lockSeconds: number };

/** Escalating lockout per IP: more failures in a row cost more time, capped at 30 minutes. */
const IP_STAGES: LockStage[] = [
  { afterFailures: 3, lockSeconds: 30 },
  { afterFailures: 5, lockSeconds: 120 },
  { afterFailures: 7, lockSeconds: 600 },
  { afterFailures: 10, lockSeconds: 1800 },
];

/**
 * League-wide: a handful of managers mistyping never gets near these, but a
 * distributed guesser does. Once tripped, nobody can sign in until it
 * lapses - for a private league, a pause beats a takeover.
 */
const GLOBAL_STAGES: LockStage[] = [
  { afterFailures: 20, lockSeconds: 300 },
  { afterFailures: 40, lockSeconds: 1800 },
  { afterFailures: 60, lockSeconds: 6 * 3600 },
];

export const GLOBAL_RATE_LIMIT_KEY = "global:all-ips";

/** Failures older than this (since the bucket's last attempt) start the count over. */
const RESET_WINDOW_SECONDS = 24 * 60 * 60;

function stagesFor(key: string): LockStage[] {
  return key === GLOBAL_RATE_LIMIT_KEY ? GLOBAL_STAGES : IP_STAGES;
}

function lockSecondsSql(failCount: Prisma.Sql, stages: LockStage[]): Prisma.Sql {
  const cases = [...stages].reverse().map((s) => Prisma.sql`WHEN ${failCount} >= ${s.afterFailures} THEN ${s.lockSeconds}`);
  return Prisma.sql`(CASE ${Prisma.join(cases, " ")} ELSE 0 END)`;
}

/** Derives a stable bucket key from an IP without storing the raw address. */
export function rateLimitKeyForIp(ip: string): string {
  return createHash("sha256").update(ip).digest("hex");
}

export interface RateLimitStatus {
  locked: boolean;
  retryAfterSeconds?: number;
}

function statusFrom(lockedUntil: Date | null): RateLimitStatus {
  if (!lockedUntil) return { locked: false };
  const remainingMs = lockedUntil.getTime() - Date.now();
  if (remainingMs <= 0) return { locked: false };
  return { locked: true, retryAfterSeconds: Math.ceil(remainingMs / 1000) };
}

export async function checkRateLimit(key: string): Promise<RateLimitStatus> {
  const row = await prisma.loginAttempt.findUnique({ where: { key } });
  return statusFrom(row?.lockedUntil ?? null);
}

/**
 * Counts one failure for the bucket in a single statement and applies the
 * stage's lock. Returns the bucket's lock as it was before this failure
 * (whether the attempt should have been refused) and after it.
 */
async function countFailure(key: string): Promise<{ before: RateLimitStatus; after: RateLimitStatus }> {
  const now = Prisma.sql`(now() AT TIME ZONE 'utc')`;
  const newCount = Prisma.sql`(CASE WHEN "LoginAttempt"."updatedAt" < ${now} - make_interval(secs => ${RESET_WINDOW_SECONDS}) THEN 1 ELSE "LoginAttempt"."failCount" + 1 END)`;
  const lock = lockSecondsSql(newCount, stagesFor(key));
  // The row lock taken by the first statement makes concurrent attempts on
  // the same bucket queue up, so each one sees the lock its predecessors set.
  // Create the bucket if it's new, then lock its row: concurrent attempts on
  // the same bucket queue up behind that lock, so each one sees the lock
  // its predecessors set - including the very first burst on a new bucket.
  const [previous, updated] = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`
      INSERT INTO "LoginAttempt" (id, key, "failCount", "lockedUntil", "updatedAt")
      VALUES (gen_random_uuid()::text, ${key}, 0, NULL, ${now})
      ON CONFLICT (key) DO NOTHING`;
    const before = await tx.$queryRaw<Array<{ lockedUntil: Date | null }>>`
      SELECT "lockedUntil" FROM "LoginAttempt" WHERE key = ${key} FOR UPDATE`;
    const after = await tx.$queryRaw<Array<{ lockedUntil: Date | null }>>`
      UPDATE "LoginAttempt" SET
        "failCount" = ${newCount},
        "lockedUntil" = GREATEST(
          CASE WHEN "LoginAttempt"."lockedUntil" > ${now} THEN "LoginAttempt"."lockedUntil" END,
          CASE WHEN ${lock} > 0 THEN ${now} + make_interval(secs => ${lock}) END),
        "updatedAt" = ${now}
      WHERE key = ${key}
      RETURNING "lockedUntil"`;
    return [before[0]?.lockedUntil ?? null, after[0]?.lockedUntil ?? null] as const;
  }, { maxWait: 10_000, timeout: 10_000 });
  return { before: statusFrom(previous), after: statusFrom(updated) };
}

export async function recordFailedAttempt(key: string): Promise<RateLimitStatus> {
  return (await countFailure(key)).after;
}

/**
 * Reserves one login attempt against both the caller's IP bucket and the
 * league-wide bucket, counting it as a failure up front. `locked` means a
 * lock was already in force when it arrived: refuse it without checking the
 * PIN. On a correct PIN, call recordSuccessfulAttempt to give it back.
 */
export async function reserveAttempt(ipKey: string): Promise<RateLimitStatus> {
  const ip = await countFailure(ipKey);
  const global = await countFailure(GLOBAL_RATE_LIMIT_KEY);
  const blocked = [ip.before, global.before].filter((s) => s.locked);
  if (blocked.length === 0) return { locked: false };
  return { locked: true, retryAfterSeconds: Math.max(...blocked.map((s) => s.retryAfterSeconds ?? 30)) };
}

/** The lock a reserved attempt that turned out wrong has now earned, if any. */
export async function lockAfterFailure(ipKey: string): Promise<RateLimitStatus> {
  const [ip, global] = await Promise.all([checkRateLimit(ipKey), checkRateLimit(GLOBAL_RATE_LIMIT_KEY)]);
  const locked = [ip, global].filter((s) => s.locked);
  if (locked.length === 0) return { locked: false };
  return { locked: true, retryAfterSeconds: Math.max(...locked.map((s) => s.retryAfterSeconds ?? 30)) };
}

/** A correct PIN: clears the IP bucket and takes back the reserved league-wide failure. */
export async function recordSuccessfulAttempt(key: string): Promise<void> {
  await prisma.loginAttempt.upsert({
    where: { key },
    create: { key, failCount: 0, lockedUntil: null },
    update: { failCount: 0, lockedUntil: null },
  });
  await prisma.$executeRaw`
    UPDATE "LoginAttempt" SET "failCount" = GREATEST("failCount" - 1, 0) WHERE key = ${GLOBAL_RATE_LIMIT_KEY}`;
}
