/**
 * Signed, stateless session tokens.
 *
 * Built on Web Crypto (`crypto.subtle`) rather than Node's `crypto` module
 * so the exact same code runs in a Route Handler (Node runtime, where PIN
 * hashing also happens) and in `src/middleware.ts` (Edge runtime, which has
 * no Node crypto module but does have Web Crypto). That's what lets
 * middleware gate every request without needing a database round trip or an
 * experimental Node middleware runtime.
 *
 * A token is `<base64url(payload json)>.<base64url(hmac-sha256 signature)>`.
 * It is not encryption - the payload (managerId/provider/iat/exp) is legible
 * to anyone who reads the cookie - but it can't be forged or edited without
 * the server's AUTH_SECRET, which is all a session needs to guarantee.
 */

export interface SessionPayload {
  managerId: string;
  provider: string;
  iat: number;
  exp: number;
}

export const SESSION_COOKIE_NAME = "antlerboard_session";
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 180; // 180 days

function getSecret(): string {
  const secret = process.env.AUTH_SECRET;
  if (!secret) {
    throw new Error("AUTH_SECRET is not set - required to sign/verify session cookies.");
  }
  return secret;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlToBytes(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const withPadding = padded + "=".repeat((4 - (padded.length % 4)) % 4);
  const binary = atob(withPadding);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function importHmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

export async function createSessionToken(
  managerId: string,
  provider = "pin",
  maxAgeSeconds = SESSION_MAX_AGE_SECONDS
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const payload: SessionPayload = { managerId, provider, iat: now, exp: now + maxAgeSeconds };
  const payloadB64 = bytesToBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
  const key = await importHmacKey(getSecret());
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payloadB64));
  return `${payloadB64}.${bytesToBase64Url(new Uint8Array(signature))}`;
}

/** Verifies signature and expiry. Returns null for anything malformed, tampered, or expired. */
export async function verifySessionToken(token: string | undefined | null): Promise<SessionPayload | null> {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payloadB64, signatureB64] = parts;

  try {
    const key = await importHmacKey(getSecret());
    const valid = await crypto.subtle.verify(
      "HMAC",
      key,
      base64UrlToBytes(signatureB64) as BufferSource,
      new TextEncoder().encode(payloadB64)
    );
    if (!valid) return null;

    const payload = JSON.parse(new TextDecoder().decode(base64UrlToBytes(payloadB64))) as Partial<SessionPayload>;
    if (typeof payload.managerId !== "string" || !payload.managerId) return null;
    if (typeof payload.provider !== "string" || !payload.provider) return null;
    if (typeof payload.exp !== "number" || payload.exp < Math.floor(Date.now() / 1000)) return null;
    if (typeof payload.iat !== "number") return null;

    return payload as SessionPayload;
  } catch {
    return null;
  }
}
