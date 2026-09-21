/**
 * PIN hashing and generation for the "pin" auth provider.
 *
 * Uses Node's `crypto` module (scrypt, timing-safe compare, CSPRNG) - this
 * file must only be imported from Node-runtime code (Route Handlers, CLI
 * scripts), never from src/middleware.ts (Edge runtime, no Node crypto).
 *
 * scrypt is a deliberate choice over a fast hash (sha256) even though a
 * 4-digit PIN's tiny keyspace (10,000 combinations) means a stolen hash
 * offers little real protection either way - scrypt is what's available
 * without adding a bcrypt/argon2 dependency, and it costs nothing to use it
 * anyway. The PINs' actual protection is the online rate limiter in
 * rate-limit.ts, not the hash algorithm.
 */

import { randomBytes, randomInt, scryptSync, timingSafeEqual } from "crypto";

const SCRYPT_KEYLEN = 32;
const HASH_PREFIX = "scrypt";

export function hashPin(pin: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(pin, salt, SCRYPT_KEYLEN).toString("hex");
  return `${HASH_PREFIX}:${salt}:${hash}`;
}

export function verifyPin(pin: string, stored: string | null | undefined): boolean {
  if (!stored) return false;
  const parts = stored.split(":");
  if (parts.length !== 3 || parts[0] !== HASH_PREFIX) return false;
  const [, salt, hashHex] = parts;
  try {
    const expected = Buffer.from(hashHex, "hex");
    const actual = scryptSync(pin, salt, expected.length);
    if (actual.length !== expected.length) return false;
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

export function isValidPinFormat(pin: unknown): pin is string {
  return typeof pin === "string" && /^\d{4}$/.test(pin);
}

/**
 * Rejects PINs an attacker would try first: repeated digits, sequential
 * runs (ascending or descending, including the 9-to-0 wraparound), and the
 * handful of PINs that show up disproportionately often in leaked-PIN
 * frequency studies.
 */
export function isWeakPin(pin: string): boolean {
  if (!/^\d{4}$/.test(pin)) return true;
  if (/^(\d)\1{3}$/.test(pin)) return true;

  const digits = pin.split("").map(Number);
  const ascending = digits.every((d, i) => i === 0 || d === (digits[i - 1] + 1) % 10);
  const descending = digits.every((d, i) => i === 0 || d === (digits[i - 1] + 9) % 10);
  if (ascending || descending) return true;

  const commonWeakPins = new Set([
    "1234", "0000", "1111", "2222", "3333", "4444", "5555", "6666", "7777", "8888", "9999",
    "1212", "4321", "1004", "2000", "2001", "6969", "1313", "1010", "1122", "2580", "0852",
  ]);
  return commonWeakPins.has(pin);
}

function randomPinCandidate(): string {
  return randomInt(0, 10000).toString().padStart(4, "0");
}

/** Generates `count` unique, non-predictable 4-digit PINs using a CSPRNG. */
export function generateUniquePins(count: number): string[] {
  const pins = new Set<string>();
  while (pins.size < count) {
    const candidate = randomPinCandidate();
    if (isWeakPin(candidate)) continue;
    pins.add(candidate);
  }
  return [...pins];
}

/** Generates a single unique PIN not already present in `existing`. */
export function generatePinExcluding(existing: Iterable<string>): string {
  const taken = new Set(existing);
  let candidate = randomPinCandidate();
  while (isWeakPin(candidate) || taken.has(candidate)) {
    candidate = randomPinCandidate();
  }
  return candidate;
}
