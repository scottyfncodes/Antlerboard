import { describe, it, expect } from "vitest";
import { generatePinExcluding, generateUniquePins, hashPin, isValidPinFormat, isWeakPin, verifyPin } from "./pin";

describe("pin hashing", () => {
  it("verifies a correct PIN against its hash", () => {
    const hash = hashPin("4738");
    expect(verifyPin("4738", hash)).toBe(true);
  });

  it("rejects an incorrect PIN", () => {
    const hash = hashPin("4738");
    expect(verifyPin("0000", hash)).toBe(false);
  });

  it("never stores the PIN in plaintext", () => {
    const hash = hashPin("4738");
    expect(hash).not.toContain("4738");
  });

  it("produces a different hash each time (random salt)", () => {
    expect(hashPin("4738")).not.toBe(hashPin("4738"));
  });

  it("rejects malformed stored hashes safely instead of throwing", () => {
    expect(verifyPin("4738", "not-a-real-hash")).toBe(false);
    expect(verifyPin("4738", null)).toBe(false);
    expect(verifyPin("4738", undefined)).toBe(false);
  });
});

describe("isValidPinFormat", () => {
  it("accepts exactly 4 digits", () => {
    expect(isValidPinFormat("0472")).toBe(true);
  });

  it("rejects non-4-digit or non-numeric input", () => {
    expect(isValidPinFormat("123")).toBe(false);
    expect(isValidPinFormat("12345")).toBe(false);
    expect(isValidPinFormat("12a4")).toBe(false);
    expect(isValidPinFormat(1234)).toBe(false);
    expect(isValidPinFormat(undefined)).toBe(false);
    expect(isValidPinFormat(null)).toBe(false);
  });
});

describe("isWeakPin", () => {
  it("flags repeated-digit PINs", () => {
    expect(isWeakPin("0000")).toBe(true);
    expect(isWeakPin("7777")).toBe(true);
  });

  it("flags ascending and descending sequential runs, including wraparound", () => {
    expect(isWeakPin("1234")).toBe(true);
    expect(isWeakPin("4321")).toBe(true);
    expect(isWeakPin("9012")).toBe(true);
    expect(isWeakPin("0987")).toBe(true);
  });

  it("flags common leaked PINs", () => {
    expect(isWeakPin("2000")).toBe(true);
    expect(isWeakPin("6969")).toBe(true);
  });

  it("does not flag a reasonably random PIN", () => {
    expect(isWeakPin("4738")).toBe(false);
    expect(isWeakPin("2947")).toBe(false);
  });
});

describe("generateUniquePins", () => {
  it("generates the requested count", () => {
    expect(generateUniquePins(12)).toHaveLength(12);
  });

  it("never generates a duplicate", () => {
    const pins = generateUniquePins(12);
    expect(new Set(pins).size).toBe(12);
  });

  it("never generates a weak/predictable PIN", () => {
    // Run a larger batch than we'll ever actually need to make a
    // false-negative in this assertion astronomically unlikely.
    const pins = generateUniquePins(50);
    for (const pin of pins) {
      expect(isWeakPin(pin)).toBe(false);
    }
  });

  it("every generated PIN is exactly 4 digits", () => {
    for (const pin of generateUniquePins(12)) {
      expect(pin).toMatch(/^\d{4}$/);
    }
  });
});

describe("generatePinExcluding", () => {
  it("never returns a PIN already in the excluded set", () => {
    const existing = generateUniquePins(11);
    const next = generatePinExcluding(existing);
    expect(existing).not.toContain(next);
    expect(isWeakPin(next)).toBe(false);
  });
});
