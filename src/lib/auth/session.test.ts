import { describe, it, expect } from "vitest";
import { createSessionToken, verifySessionToken } from "./session";

describe("session tokens", () => {
  it("round-trips a valid token", async () => {
    const token = await createSessionToken("manager-123", "pin");
    const payload = await verifySessionToken(token);
    expect(payload).not.toBeNull();
    expect(payload?.managerId).toBe("manager-123");
    expect(payload?.provider).toBe("pin");
  });

  it("rejects a missing token", async () => {
    expect(await verifySessionToken(undefined)).toBeNull();
    expect(await verifySessionToken(null)).toBeNull();
    expect(await verifySessionToken("")).toBeNull();
  });

  it("rejects a malformed token", async () => {
    expect(await verifySessionToken("not-a-token")).toBeNull();
    expect(await verifySessionToken("only.one.part.too.many")).toBeNull();
  });

  it("rejects a tampered payload (signature no longer matches)", async () => {
    const token = await createSessionToken("manager-123", "pin");
    const [payloadB64, signatureB64] = token.split(".");
    const tamperedPayload = payloadB64.slice(0, -1) + (payloadB64.slice(-1) === "A" ? "B" : "A");
    const tampered = `${tamperedPayload}.${signatureB64}`;
    expect(await verifySessionToken(tampered)).toBeNull();
  });

  it("rejects a tampered signature", async () => {
    const token = await createSessionToken("manager-123", "pin");
    const [payloadB64, signatureB64] = token.split(".");
    // Flip a bit in the decoded signature itself. Editing the last base64url
    // character is not enough: a 32-byte signature is 43 characters, and the
    // last one carries 2 padding bits, so swapping "A" <-> "B" there can
    // leave the decoded bytes - and so the signature - unchanged.
    const bytes = Buffer.from(signatureB64, "base64url");
    for (const index of [0, bytes.length - 1]) {
      const flipped = Buffer.from(bytes);
      flipped[index] ^= 0x01;
      expect(await verifySessionToken(`${payloadB64}.${flipped.toString("base64url")}`)).toBeNull();
    }
  });

  it("rejects an already-expired token", async () => {
    const token = await createSessionToken("manager-123", "pin", -10);
    expect(await verifySessionToken(token)).toBeNull();
  });

  it("accepts a token that has not yet expired", async () => {
    const token = await createSessionToken("manager-123", "pin", 60);
    expect(await verifySessionToken(token)).not.toBeNull();
  });
});
