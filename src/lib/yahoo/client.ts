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
import { YahooApiError, parseYahooErrorDescription } from "./errors";

const AUTH_BASE = "https://api.login.yahoo.com/oauth2/request_auth";
const TOKEN_URL = "https://api.login.yahoo.com/oauth2/get_token";
export const FANTASY_API_BASE = "https://fantasysports.yahooapis.com/fantasy/v2";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var ${name} - configure Yahoo OAuth before connecting.`);
  return value;
}

export function isYahooConfigured(): boolean {
  return !!(process.env.YAHOO_CLIENT_ID && process.env.YAHOO_CLIENT_SECRET && process.env.YAHOO_REDIRECT_URI);
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
    throw new Error(`Yahoo token exchange failed: ${res.status} ${await res.text()}`);
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
    throw new Error(`Yahoo token refresh failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

/**
 * Returns a valid access token for the league's Yahoo connection,
 * transparently refreshing it if it's expired or about to expire.
 */
export async function getValidAccessToken(leagueId: string): Promise<string> {
  const connection = await prisma.yahooConnection.findUnique({ where: { leagueId } });
  if (!connection?.accessToken || !connection.refreshToken) {
    throw new Error("Yahoo is not connected for this league yet.");
  }

  const expiresSoon =
    !connection.tokenExpiresAt || connection.tokenExpiresAt.getTime() - Date.now() < 60_000;

  if (!expiresSoon) return connection.accessToken;

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

/** Authenticated GET against the Yahoo Fantasy API, returning parsed JSON. */
export async function yahooFantasyGet(leagueId: string, path: string): Promise<unknown> {
  const accessToken = await getValidAccessToken(leagueId);
  const separator = path.includes("?") ? "&" : "?";
  const url = `${FANTASY_API_BASE}${path}${separator}format=json`;

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new YahooApiError(res.status, path, parseYahooErrorDescription(body));
  }
  return res.json();
}
