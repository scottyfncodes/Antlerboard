/**
 * Structured, sanitized logging for failed Yahoo Fantasy API responses.
 *
 * Yahoo's app-not-authorized 403 leaves no trace anywhere except the
 * commissioner's screen, so there is nothing to hand Yahoo support or to
 * compare against the Client ID Yahoo approved. This module builds one log
 * event per failed response from an explicit allowlist of fields. It never
 * sees the request headers, so the Authorization header and tokens can't
 * reach it, and everything taken from the response is filtered before it is
 * logged.
 */

import { createHash } from "crypto";

export const YAHOO_API_ERROR_EVENT = "yahoo_api_error";

const MAX_MESSAGE_LENGTH = 300;
const MAX_PATH_LENGTH = 200;
const MAX_HEADER_NAMES = 40;

/** Response headers whose values may be logged - request/correlation IDs only. */
export const LOGGED_RESPONSE_HEADERS = [
  "x-request-id",
  "x-yahoo-request-id",
  "x-yahoo-rid",
  "y-rid",
  "x-correlation-id",
  "request-id",
  "x-amzn-requestid",
  "x-amz-cf-id",
] as const;

/** What a request ID looks like. Anything else is logged as "[unexpected]", not as-is. */
const HEADER_VALUE_PATTERN = /^[A-Za-z0-9._:=+/-]{1,128}$/;
const HEADER_NAME_PATTERN = /^[a-z0-9-]{1,64}$/;

const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;

/**
 * The Fantasy API path with its query string dropped and the league, team,
 * player and user identifiers in it replaced with placeholders, e.g.
 * `/league/458.l.12345/standings` -> `/league/{key}/standings`.
 */
export function sanitizeYahooPath(path: string): string {
  const withoutQuery = path.split(/[?#]/)[0];
  const redacted = withoutQuery
    // game.l.league[.t.team] / game.p.player keys
    .replace(/\d+\.[a-z]\.\d+(?:\.[a-z]\.\d+)*/gi, "{key}")
    // matrix params that name a user or resource directly
    .replace(/;(guid|league_keys|team_keys|player_keys)=[^/;]*/gi, ";$1={redacted}");
  return redacted.replace(/[^A-Za-z0-9_/;=,.{}-]/g, "?").slice(0, MAX_PATH_LENGTH);
}

/**
 * Credentials whose exact values must never be logged: whatever the caller
 * passes (the access token it just sent) plus the configured client secret.
 * Very short values are skipped so a placeholder can't redact ordinary words.
 */
function secretValues(extra: readonly (string | null | undefined)[] = []): string[] {
  return [...extra, process.env.YAHOO_CLIENT_SECRET].filter((v): v is string => !!v && v.length >= 6);
}

function redactSecrets(text: string, secrets: readonly string[]): string {
  return secrets.reduce((out, secret) => out.split(secret).join("[redacted]"), text);
}

/**
 * Yahoo's own error description with known credentials and anything
 * token-shaped redacted, control characters stripped, and the result capped
 * at 300 characters.
 */
export function sanitizeYahooMessage(
  message: string | null | undefined,
  knownSecrets: readonly (string | null | undefined)[] = []
): string | null {
  if (!message) return null;
  const cleaned = redactSecrets(message, secretValues(knownSecrets))
    .replace(CONTROL_CHARS, " ")
    .replace(/\b(Bearer|Basic)\s+\S+/gi, "$1 [redacted]")
    // long opaque runs (tokens, secrets, base64 blobs) never belong in a log
    .replace(/[A-Za-z0-9._~+/=-]{32,}/g, "[redacted]")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned ? cleaned.slice(0, MAX_MESSAGE_LENGTH) : null;
}

/** Allowlisted request-ID header values, plus the names (never values) of every header Yahoo sent. */
export function pickYahooResponseHeaders(
  headers: Headers | null | undefined,
  knownSecrets: readonly (string | null | undefined)[] = []
): {
  requestIds: Record<string, string>;
  headerNames: string[];
} {
  const requestIds: Record<string, string> = {};
  const headerNames: string[] = [];
  if (!headers || typeof headers.forEach !== "function") return { requestIds, headerNames };

  headers.forEach((_value, name) => {
    const lower = name.toLowerCase();
    if (HEADER_NAME_PATTERN.test(lower) && headerNames.length < MAX_HEADER_NAMES) headerNames.push(lower);
  });
  for (const name of LOGGED_RESPONSE_HEADERS) {
    const raw = headers.get(name);
    if (raw === null) continue;
    const value = raw.replace(CONTROL_CHARS, "").trim();
    if (secretValues(knownSecrets).some((secret) => value.includes(secret))) requestIds[name] = "[redacted]";
    else requestIds[name] = HEADER_VALUE_PATTERN.test(value) ? value : "[unexpected]";
  }
  return { requestIds, headerNames: headerNames.sort() };
}

export interface YahooClientIdFingerprint {
  tail: string;
  sha256: string;
  surroundingWhitespace: boolean;
}

/**
 * Identifies which Client ID this deployment sends, without logging it.
 *
 * `sha256` is the first 12 hex characters of the SHA-256 of YAHOO_CLIENT_ID
 * exactly as client.ts sends it to Yahoo (untrimmed), so it describes the
 * value Yahoo actually receives. `surroundingWhitespace` flags a value with
 * leading/trailing whitespace - Yahoo receives that whitespace too, and the
 * hash then won't match a cleanly pasted copy of the same ID.
 *
 * `tail` is the last six visible characters. Yahoo Client IDs end in a
 * base64-encoded `...&sv=0&x=NN` suffix, so most of those six characters are
 * the same for every app - the tail is a quick visual check, not proof.
 * The Client ID itself is public (it's in Yahoo's login URL); the secret is
 * never read here. IDs too short to be real Yahoo Client IDs get no tail, so
 * a misconfigured short value is never logged whole.
 */
export function yahooClientIdFingerprint(): YahooClientIdFingerprint | null {
  const raw = process.env.YAHOO_CLIENT_ID;
  const visible = raw?.trim();
  if (!raw || !visible) return null;
  return {
    tail: visible.length > 12 ? visible.slice(-6) : "[short]",
    sha256: createHash("sha256").update(raw).digest("hex").slice(0, 12),
    surroundingWhitespace: raw !== visible,
  };
}

/** The Vercel deployment serving this request, when Vercel exposes it. */
function deploymentId(): string | null {
  const id = process.env.VERCEL_DEPLOYMENT_ID || process.env.VERCEL_URL;
  return id && /^[A-Za-z0-9_.-]{1,128}$/.test(id) ? id : null;
}

export interface YahooApiErrorEvent {
  event: typeof YAHOO_API_ERROR_EVENT;
  at: string;
  status: number;
  path: string;
  attempt: number;
  deployment: string | null;
  message: string | null;
  clientId: YahooClientIdFingerprint | null;
  requestIds: Record<string, string>;
  headerNames: string[];
}

export function buildYahooApiErrorEvent(input: {
  status: number;
  path: string;
  attempt: number;
  description: string | null;
  headers: Headers | null | undefined;
  /** Credentials used for this request (the access token), redacted wherever they appear. */
  knownSecrets?: readonly (string | null | undefined)[];
}): YahooApiErrorEvent {
  const { requestIds, headerNames } = pickYahooResponseHeaders(input.headers, input.knownSecrets);
  return {
    event: YAHOO_API_ERROR_EVENT,
    at: new Date().toISOString(),
    status: input.status,
    path: sanitizeYahooPath(input.path),
    attempt: input.attempt,
    deployment: deploymentId(),
    message: sanitizeYahooMessage(input.description, input.knownSecrets),
    clientId: yahooClientIdFingerprint(),
    requestIds,
    headerNames,
  };
}

/** Logs one failed Yahoo response. Never throws - diagnostics must not change how a request fails. */
export function logYahooApiError(input: Parameters<typeof buildYahooApiErrorEvent>[0]): void {
  try {
    console.error(JSON.stringify(buildYahooApiErrorEvent(input)));
  } catch {
    // logging is best-effort
  }
}
