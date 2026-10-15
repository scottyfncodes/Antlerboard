/**
 * Yahoo Fantasy Sports OAuth2 + REST client.
 *
 * Every call here is server-side only (route handlers / cron / server
 * components) - `YAHOO_CLIENT_SECRET` and stored access/refresh tokens
 * never reach the browser. See src/lib/yahoo/sync.ts for how the responses
 * get merged into Antlerboard's database.
 *
 * Yahoo's Fantasy API returns XML by default; every request below appends
 * `?format=json` so responses can be parsed directly.
 */

import { prisma } from "@/lib/db";
import { YahooApiError, YahooAuthError, parseYahooErrorDescription } from "./errors";
import { logYahooApiError } from "./diagnostics";

const AUTH_BASE = "https://api.login.yahoo.com/oauth2/request_auth";
const TOKEN_URL = "https://api.login.yahoo.com/oauth2/get_token";
export const FANTASY_API_BASE = "https://fantasysports.yahooapis.com/fantasy/v2";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var ${name} - configure Yahoo OAuth before connecting.`);
  return value;
}

const YAHOO_ENV_VARS = ["YAHOO_CLIENT_ID", "YAHOO_CLIENT_SECRET", "YAHOO_REDIRECT_URI"] as const;

/** Names (never values) of the Yahoo env vars that are unset or blank here. */
export function missingYahooEnvVars(): string[] {
  return YAHOO_ENV_VARS.filter((name) => !process.env[name]?.trim());
}

export function isYahooConfigured(): boolean {
  return missingYahooEnvVars().length === 0;
}

export function buildAuthorizationUrl(state: string): string {
  const clientId = requireEnv("YAHOO_CLIENT_ID");
  const redirectUri = requireEnv("YAHOO_REDIRECT_URI");
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    language: "en-us",
    state,
  });
  return `${AUTH_BASE}?${params.toString()}`;
}

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
  xoauth_yahoo_guid?: string;
}

function basicAuthHeader(): string {
  const clientId = requireEnv("YAHOO_CLIENT_ID");
  const clientSecret = requireEnv("YAHOO_CLIENT_SECRET");
  return "Basic " + Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
}

export async function exchangeCodeForToken(code: string): Promise<TokenResponse> {
  const redirectUri = requireEnv("YAHOO_REDIRECT_URI");
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: basicAuthHeader(),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
      code,
    }),
  });
  if (!res.ok) {
    const description = parseYahooErrorDescription(await res.text().catch(() => ""));
    throw new Error(`Yahoo token exchange failed: ${res.status}${description ? ` ${description}` : ""}`);
  }
  return res.json();
}

export async function refreshAccessToken(refreshToken: string): Promise<TokenResponse> {
  const redirectUri = requireEnv("YAHOO_REDIRECT_URI");
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: basicAuthHeader(),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      redirect_uri: redirectUri,
      refresh_token: refreshToken,
    }),
  });
  if (!res.ok) {
    const description = parseYahooErrorDescription(await res.text().catch(() => ""));
    // 400/401 from the token endpoint means the refresh token itself is no
    // good (invalid_grant) - retrying won't help, a reconnect will.
    if (res.status === 400 || res.status === 401) throw new YahooAuthError(res.status, description);
    throw new Error(`Yahoo token refresh failed: ${res.status}${description ? ` ${description}` : ""}`);
  }
  return res.json();
}

/**
 * Returns a valid access token for the league's Yahoo connection,
 * transparently refreshing it if it's expired or about to expire.
 */
export async function getValidAccessToken(leagueId: string, opts: { forceRefresh?: boolean } = {}): Promise<string> {
  const connection = await prisma.yahooConnection.findUnique({ where: { leagueId } });
  if (!connection?.accessToken || !connection.refreshToken) {
    throw new Error("Yahoo is not connected for this league yet.");
  }

  const expiresSoon =
    !connection.tokenExpiresAt || connection.tokenExpiresAt.getTime() - Date.now() < 60_000;

  if (!expiresSoon && !opts.forceRefresh) return connection.accessToken;

  const refreshed = await refreshAccessToken(connection.refreshToken);
  await prisma.yahooConnection.update({
    where: { leagueId },
    data: {
      accessToken: refreshed.access_token,
      refreshToken: refreshed.refresh_token || connection.refreshToken,
      tokenExpiresAt: new Date(Date.now() + refreshed.expires_in * 1000),
    },
  });
  return refreshed.access_token;
}

/** The stored token is missing or expired and refreshing it wasn't allowed. */
export class YahooTokenUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "YahooTokenUnavailableError";
  }
}

/** The stored access token if it's still valid for at least 30 seconds - never refreshes, never writes. */
async function getStoredAccessToken(leagueId: string): Promise<string> {
  const connection = await prisma.yahooConnection.findUnique({ where: { leagueId }, select: { accessToken: true, tokenExpiresAt: true } });
  if (!connection?.accessToken) throw new YahooTokenUnavailableError("Yahoo is not connected for this league yet.");
  if (!connection.tokenExpiresAt || connection.tokenExpiresAt.getTime() - Date.now() < 30_000) {
    throw new YahooTokenUnavailableError(
      "The stored Yahoo access token has expired, and this read-only tool doesn't refresh it (refreshing writes new tokens to the database). " +
        "Run it within about an hour of the daily Yahoo sync, or after a commissioner's Sync Now."
    );
  }
  return connection.accessToken;
}

const RETRY_DELAYS_MS = [1_000, 3_000];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Authenticated GET against the Yahoo Fantasy API, returning parsed JSON.
 *
 * A 401 gets one forced token refresh and a retry (Yahoo can expire a token
 * before its stated expires_in). Rate limits (999/429) and 5xx get up to two
 * backed-off retries. Anything else - including the 403 Yahoo sends when the
 * app's Client ID isn't approved for the Fantasy API - fails immediately as a
 * YahooApiError carrying Yahoo's own description. Every failed response is
 * also logged once, sanitized, by logYahooApiError (see ./diagnostics).
 *
 * `allowRefresh: false` never refreshes the token - it uses the stored
 * access token while it's valid and otherwise throws YahooTokenUnavailable.
 * That path writes nothing to the database (refreshing writes the new
 * tokens), for strictly read-only tools like the history export.
 */
export async function yahooFantasyGet(leagueId: string, path: string, opts: { allowRefresh?: boolean } = {}): Promise<unknown> {
  const separator = path.includes("?") ? "&" : "?";
  const url = `${FANTASY_API_BASE}${path}${separator}format=json`;
  const allowRefresh = opts.allowRefresh ?? true;

  let accessToken = allowRefresh ? await getValidAccessToken(leagueId) : await getStoredAccessToken(leagueId);
  // Without refresh there's nothing to retry a 401 with.
  let refreshedAfter401 = !allowRefresh;

  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (res.ok) return res.json();

    const body = await res.text().catch(() => "");
    const error = new YahooApiError(res.status, path, parseYahooErrorDescription(body));
    logYahooApiError({
      status: res.status,
      path,
      attempt,
      description: error.description,
      headers: res.headers,
      knownSecrets: [accessToken],
    });

    if (res.status === 401 && !refreshedAfter401) {
      refreshedAfter401 = true;
      accessToken = await getValidAccessToken(leagueId, { forceRefresh: true });
      continue;
    }
    if (error.isRetryable && attempt < RETRY_DELAYS_MS.length) {
      await sleep(RETRY_DELAYS_MS[attempt]);
      continue;
    }
    throw error;
  }
}
