import { createHash, timingSafeEqual } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireCommissioner } from "@/lib/current-manager";
import { isYahooConfigured, YahooTokenUnavailableError, yahooFantasyGet } from "@/lib/yahoo/client";
import { YahooApiError } from "@/lib/yahoo/errors";
import { MalformedYahooResponseError } from "@/lib/yahoo/transactions";
import { APPLY_CONFIRMATION, applyRecoveryPlan, buildRecoveryPlan, RecoveryRefused } from "@/lib/yahoo/transaction-recovery";

// A full season's log, paged at a polite pace (~40 pages for 2026).
export const maxDuration = 300;
/** Pause between Yahoo pages - the history export's pace, which Yahoo tolerates. */
const PAGE_DELAY_MS = 500;

const NO_STORE = { "Cache-Control": "private, no-store" };
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: NO_STORE });

/**
 * Recovery for Yahoo transactions synced before detailed ingestion (see
 * src/lib/yahoo/transaction-recovery.ts and docs/yahoo-transaction-recovery.md).
 * Commissioner only, with one exception: the dry run also accepts the
 * dedicated RECOVERY_DRYRUN_TOKEN, so the scheduled read-only preflight
 * (docs/recovery-preflight-automation.md) can run it without a browser. That
 * token never authorizes the apply.
 *
 *   GET  ?season=2026[&leagueKey=469.l.8891]
 *        The dry run: a per-record proposal for every legacy row, and a
 *        fingerprint. Writes nothing - not even a token (never refreshes it).
 *        With the dry-run token, only the connected league (no leagueKey).
 *   POST {season, leagueKey?, fingerprint, confirm: "APPLY_YAHOO_TRANSACTION_RECOVERY"}
 *        The write: re-reads Yahoo, refuses unless the plan still matches the
 *        reviewed fingerprint, then writes only the ready records.
 *
 * leagueKey defaults to the connected Yahoo league. Both use the stored
 * access token only while it's valid (about an hour after the daily sync or
 * a Sync Now) and answer 409 otherwise.
 */
async function target(seasonParam: unknown, leagueKeyParam: unknown) {
  const season = Number(seasonParam);
  if (!Number.isInteger(season) || season < 2000) return { error: "season must be a year, e.g. season=2026" } as const;
  const league = await prisma.league.findFirst({ include: { yahooConnection: true } });
  const leagueKey = typeof leagueKeyParam === "string" && leagueKeyParam ? leagueKeyParam : league?.yahooConnection?.yahooLeagueKey;
  if (!league || !leagueKey) return { error: "No Yahoo league is selected." } as const;
  if (!/^\d+\.l\.\d+$/.test(leagueKey)) return { error: "leagueKey must look like 469.l.8891" } as const;
  return { league, season, leagueKey } as const;
}

function failure(err: unknown) {
  if (err instanceof RecoveryRefused || err instanceof YahooTokenUnavailableError) return json({ error: err.message }, 409);
  if (err instanceof YahooApiError && err.status === 401) return json({ error: "Yahoo rejected the stored access token. Run this within an hour of the daily sync or a Sync Now." }, 409);
  if (err instanceof YahooApiError || err instanceof MalformedYahooResponseError) return json({ error: err.message }, 502);
  console.error("Yahoo transaction recovery failed", err instanceof Error ? err.name : typeof err);
  return json({ error: "The recovery failed unexpectedly. Nothing further was attempted." }, 500);
}

/** Short tokens are refused outright, so a mis-set variable can't become a guessable credential. */
const DRY_RUN_TOKEN_MIN_LENGTH = 32;

/**
 * "none" without an Authorization header (the commissioner's session decides),
 * otherwise "valid" only for exactly `Bearer <RECOVERY_DRYRUN_TOKEN>`. Compared
 * as hashes in constant time.
 */
function dryRunTokenAuth(req: NextRequest): "none" | "valid" | "invalid" {
  const header = req.headers.get("authorization");
  if (header === null) return "none";
  const expected = process.env.RECOVERY_DRYRUN_TOKEN ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  if (expected.length < DRY_RUN_TOKEN_MIN_LENGTH || !presented) return "invalid";
  const digest = (s: string) => createHash("sha256").update(s).digest();
  return timingSafeEqual(digest(presented), digest(expected)) ? "valid" : "invalid";
}

export async function GET(req: NextRequest) {
  const tokenAuth = dryRunTokenAuth(req);
  if (tokenAuth === "invalid") return json({ error: "Invalid dry-run token" }, 401);
  if (tokenAuth === "none" && !(await requireCommissioner())) return json({ error: "Commissioner access required" }, 403);
  // Previews share the production database (and its stored token) but not
  // the Yahoo env vars; the dry run belongs to production like the apply.
  if (!isYahooConfigured()) return json({ error: "Yahoo isn't configured in this environment - run the recovery from the production site." }, 503);
  if (tokenAuth === "valid" && req.nextUrl.searchParams.has("leagueKey")) {
    return json({ error: "The dry-run token covers the connected league only." }, 400);
  }
  const t = await target(req.nextUrl.searchParams.get("season"), req.nextUrl.searchParams.get("leagueKey"));
  if ("error" in t) return json({ error: t.error }, 400);
  try {
    const report = await buildRecoveryPlan({
      leagueId: t.league.id,
      leagueKey: t.leagueKey,
      seasonYear: t.season,
      get: (path) => yahooFantasyGet(t.league.id, path, { allowRefresh: false }),
      delayMs: PAGE_DELAY_MS,
    });
    return json(report);
  } catch (err) {
    return failure(err);
  }
}

export async function POST(req: NextRequest) {
  const commissioner = await requireCommissioner();
  if (!commissioner) return json({ error: "Commissioner access required" }, 403);
  // Preview deployments share the production database but not the Yahoo
  // env vars: never write from one.
  if (!isYahooConfigured()) return json({ error: "Yahoo isn't configured in this environment - run the recovery from the production site." }, 503);

  const body = (await req.json().catch(() => null)) as { season?: unknown; leagueKey?: unknown; fingerprint?: unknown; confirm?: unknown } | null;
  if (body?.confirm !== APPLY_CONFIRMATION) {
    return json({ error: `Applying writes to the database. Send confirm: "${APPLY_CONFIRMATION}" with the fingerprint from a reviewed dry run.` }, 400);
  }
  if (typeof body.fingerprint !== "string" || !/^[0-9a-f]{64}$/.test(body.fingerprint)) {
    return json({ error: "fingerprint must be the 64-character value from the dry run you reviewed." }, 400);
  }
  const t = await target(body.season, body.leagueKey);
  if ("error" in t) return json({ error: t.error }, 400);
  try {
    const result = await applyRecoveryPlan({
      leagueId: t.league.id,
      leagueKey: t.leagueKey,
      seasonYear: t.season,
      get: (path) => yahooFantasyGet(t.league.id, path, { allowRefresh: false }),
      delayMs: PAGE_DELAY_MS,
      expectedFingerprint: body.fingerprint,
      actorName: commissioner.name,
    });
    return json(result);
  } catch (err) {
    return failure(err);
  }
}
