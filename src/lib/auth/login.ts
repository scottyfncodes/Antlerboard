/**
 * Orchestrates a PIN login attempt: rate limit -> format check -> credential
 * match -> outcome. Kept separate from the route handler so it's callable
 * directly from tests without needing a real HTTP request/response.
 */

import { prisma } from "@/lib/db";
import { isValidPinFormat, verifyPin } from "./pin";
import { lockAfterFailure, rateLimitKeyForIp, recordSuccessfulAttempt, reserveAttempt } from "./rate-limit";

export type LoginResult =
  | { ok: true; managerId: string; provider: string }
  | { ok: false; reason: "locked"; retryAfterSeconds: number }
  | { ok: false; reason: "invalid" };

export async function attemptPinLogin(pin: unknown, ip: string): Promise<LoginResult> {
  const key = rateLimitKeyForIp(ip);

  // Counted as a failure before the PIN is even looked at (and given back
  // on success), so concurrent attempts can't all slip in under one check.
  const status = await reserveAttempt(key);
  if (status.locked) {
    return { ok: false, reason: "locked", retryAfterSeconds: status.retryAfterSeconds ?? 30 };
  }

  if (!isValidPinFormat(pin)) {
    const failure = await lockAfterFailure(key);
    if (failure.locked) return { ok: false, reason: "locked", retryAfterSeconds: failure.retryAfterSeconds ?? 30 };
    return { ok: false, reason: "invalid" };
  }

  const credentials = await prisma.managerCredential.findMany({
    where: { provider: "pin" },
    include: { manager: true },
  });

  // Check every credential rather than returning on the first match, so a
  // real match's position in the list can't leak through response timing.
  let matchedManagerId: string | null = null;
  for (const credential of credentials) {
    const isMatch = verifyPin(pin, credential.secretHash);
    if (isMatch && credential.manager.active) {
      matchedManagerId = credential.managerId;
    }
  }

  if (!matchedManagerId) {
    const failure = await lockAfterFailure(key);
    if (failure.locked) return { ok: false, reason: "locked", retryAfterSeconds: failure.retryAfterSeconds ?? 30 };
    return { ok: false, reason: "invalid" };
  }

  await recordSuccessfulAttempt(key);
  return { ok: true, managerId: matchedManagerId, provider: "pin" };
}
