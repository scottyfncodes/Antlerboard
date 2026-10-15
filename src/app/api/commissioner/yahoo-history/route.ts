import { gzipSync } from "zlib";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireCommissioner } from "@/lib/current-manager";
import { LEAGUE_FIRST_SEASON_YEAR } from "@/lib/config";
import { YahooTokenUnavailableError, yahooFantasyGet } from "@/lib/yahoo/client";
import { YahooApiError } from "@/lib/yahoo/errors";
import { buildRecoveryReport, draftCsv, exportLeagueHistory, transactionsCsv, type AntlerboardComparison } from "@/lib/yahoo/history-export";

// One season's draft lookups and paged transaction log, or the whole chain
// for the report, at a polite pace.
export const maxDuration = 300;
/** Stop starting Yahoo requests well before maxDuration, and report what's unread as not checked. */
const TIME_BUDGET_MS = 240_000;
/** Vercel rejects function responses over ~4.5 MB; stay clear of it. */
const MAX_RESPONSE_BYTES = 4_000_000;
/** Pause between Yahoo requests: Yahoo throttled the report at its 150 ms default after ~20 quick calls. */
const REQUEST_DELAY_MS = 500;

const FILES = ["report", "season.json", "transactions.csv", "draft.csv"] as const;
type ExportFile = (typeof FILES)[number];

/**
 * Read-only Yahoo history recovery (see src/lib/yahoo/history-export.ts and
 * docs/yahoo-history-export.md). Commissioner only.
 *
 *   ?file=report                      every reachable season: what Yahoo has, what's missing, and a
 *                                     comparison with the transactions Antlerboard already stores.
 *                                     The connected season's log isn't re-read (the daily sync keeps it).
 *   ?file=report&season=2024          the same report for one season only
 *   ?file=season.json&season=2024     one season: settings, teams, priced draft results, raw transactions
 *   ?file=transactions.csv&season=…   that season in the league-history import's Yahoo export format
 *                                     (&part=N when a season is too large for one response - the
 *                                     response says how many parts)
 *   ?file=draft.csv&season=…          that season's draft results with player names and prices
 *   ?file=draft.csv&season=all        every season before the connected one, in one CSV
 *   ?file=transactions.csv&season=all every season before the connected one, in one gzipped CSV
 *                                     (.csv.gz) - the league-history import's Yahoo file as-is
 *
 * Calls Yahoo with allowRefresh: false - it never refreshes the token, so it
 * writes nothing anywhere. It works while the stored token is valid (about
 * an hour after the daily sync or a Sync Now) and otherwise says so.
 */
export async function GET(req: NextRequest) {
  if (!(await requireCommissioner())) {
    return NextResponse.json({ error: "Commissioner access required" }, { status: 403 });
  }
  const params = req.nextUrl.searchParams;
  const file = (params.get("file") ?? "report") as ExportFile;
  if (!FILES.includes(file)) return NextResponse.json({ error: `file must be one of ${FILES.join(", ")}` }, { status: 400 });
  const seasonParam = params.get("season");
  const allSeasons = seasonParam === "all";
  if (allSeasons && file !== "draft.csv" && file !== "transactions.csv") {
    return NextResponse.json({ error: "season=all is for draft.csv and transactions.csv" }, { status: 400 });
  }
  const season = seasonParam && !allSeasons ? Number(seasonParam) : undefined;
  if (season !== undefined && !Number.isInteger(season)) return NextResponse.json({ error: "season must be a year, e.g. season=2024" }, { status: 400 });
  if (file !== "report" && season === undefined && !allSeasons) {
    return NextResponse.json({ error: "season=YYYY is required for season downloads" }, { status: 400 });
  }

  const league = await prisma.league.findFirst({ include: { yahooConnection: true } });
  const startLeagueKey = league?.yahooConnection?.yahooLeagueKey;
  if (!league || !startLeagueKey) return NextResponse.json({ error: "No Yahoo league is selected." }, { status: 400 });

  const get = (path: string) => yahooFantasyGet(league.id, path, { allowRefresh: false });
  const deadline = Date.now() + TIME_BUDGET_MS;
  // Token problems fail every request: stop and say so rather than report every season as refused.
  const isFatal = (err: unknown) => err instanceof YahooTokenUnavailableError || (err instanceof YahooApiError && err.status === 401);

  try {
    if (allSeasons) {
      const transactions = file === "transactions.csv";
      const history = await exportLeagueHistory(get, startLeagueKey, {
        firstSeasonYear: LEAGUE_FIRST_SEASON_YEAR,
        resolveDraftPlayers: !transactions,
        readTransactions: transactions,
        // The connected season is the sync's; it's passed through for its link only.
        include: ({ leagueKey }) => leagueKey !== startLeagueKey,
        isFatal,
        deadline,
        delayMs: REQUEST_DELAY_MS,
      });
      const seasons = history.seasons.filter((s) => s.leagueKey !== startLeagueKey).sort((a, b) => (a.seasonYear ?? 0) - (b.seasonYear ?? 0));
      const years = seasons.map((s) => s.seasonYear);
      const first = LEAGUE_FIRST_SEASON_YEAR;
      const contiguous = years.length > 0 && years.every((y, i) => y === first + i);
      const unreadable = seasons.filter((s) => s.incomplete || s.errors.length > 0);
      if (!contiguous || unreadable.length > 0) {
        // All or nothing: never a file that silently lacks a season or part of one.
        return json(
          {
            error: `Not every season from ${first} could be read completely (Yahoo rate limit, a temporary error, or the time limit). Nothing was downloaded - try again later.`,
            seasons: seasons.map((s) => ({ seasonYear: s.seasonYear, leagueKey: s.leagueKey, incomplete: s.incomplete, errors: s.errors })),
            stoppedBecause: history.discovery.stoppedBecause,
          },
          503
        );
      }
      const name = `antlerboard-yahoo-${first}-${years[years.length - 1]}`;
      if (!transactions) {
        const csv = seasons.map((s, i) => (i === 0 ? draftCsv(s) : draftCsv(s).split("\n").slice(1).join("\n"))).join("");
        return download(csv, `${name}-draft.csv`, "text/csv");
      }
      // ~4 MB as plain CSV for 2021-2025, over Vercel's limits for this
      // response and for the import upload; gzip brings it well under both.
      const gz = gzipSync(transactionsCsv(seasons), { level: 9 });
      if (gz.length > MAX_RESPONSE_BYTES) {
        return json({ error: "The combined transactions are too large for one download. Download each season with ?file=transactions.csv&season=YYYY." }, 413);
      }
      return new NextResponse(new Uint8Array(gz), {
        headers: { ...NO_STORE, "Content-Type": "application/gzip", "Content-Disposition": `attachment; filename="${name}-transactions.csv.gz"` },
      });
    }

    if (file === "report") {
      const history = await exportLeagueHistory(get, startLeagueKey, {
        firstSeasonYear: LEAGUE_FIRST_SEASON_YEAR,
        resolveDraftPlayers: false,
        onlySeason: season,
        isFatal,
        deadline,
        delayMs: REQUEST_DELAY_MS,
        skipTransactionsFor: [startLeagueKey],
      });
      return json(buildRecoveryReport(history, await storedTransactionKeys(history.seasons.map((s) => s.leagueKey))));
    }

    const history = await exportLeagueHistory(get, startLeagueKey, { firstSeasonYear: LEAGUE_FIRST_SEASON_YEAR, onlySeason: season, isFatal, deadline, delayMs: REQUEST_DELAY_MS });
    const target = history.seasons.find((s) => s.seasonYear === season);
    if (target?.incomplete) {
      // Never hand out a partial season as if it were the whole one.
      return json({ error: `Season ${season} couldn't be read completely (Yahoo rate limit, a temporary error, or the time limit). Nothing was downloaded or saved - try again later.` }, 503);
    }
    if (!target) {
      return json({ error: `Season ${season} isn't reachable: ${history.discovery.stoppedBecause}`, seasons: history.seasons.map((s) => ({ seasonYear: s.seasonYear, leagueKey: s.leagueKey, errors: s.errors })) }, 404);
    }
    const base = `antlerboard-yahoo-${season}`;
    if (file === "draft.csv") return download(draftCsv(target), `${base}-draft.csv`, "text/csv");
    if (file === "season.json") {
      const body = JSON.stringify(target);
      if (bytes(body) > MAX_RESPONSE_BYTES) {
        return json({ error: `Season ${season} is too large for one JSON download. Use ?file=transactions.csv&season=${season} (it splits into parts) and ?file=draft.csv&season=${season}.` }, 413);
      }
      return download(body, `${base}.json`, "application/json");
    }

    // transactions.csv: split into parts by transaction when one response would be too large.
    const whole = transactionsCsv([target]);
    // Aim parts at 80% of the limit so an uneven split by transaction still fits.
    const parts = bytes(whole) <= MAX_RESPONSE_BYTES ? 1 : Math.ceil(bytes(whole) / (MAX_RESPONSE_BYTES * 0.8));
    if (parts === 1) return download(whole, `${base}-transactions.csv`, "text/csv");
    const part = Number(params.get("part"));
    if (!Number.isInteger(part) || part < 1 || part > parts) {
      return json({ error: `Season ${season}'s transactions are too large for one download. Download all ${parts} parts: ${Array.from({ length: parts }, (_, i) => `?file=transactions.csv&season=${season}&part=${i + 1}`).join(" , ")}`, parts }, 413);
    }
    // Oldest first, so a transaction added between part downloads (a live
    // season) can only land in the last part, never shift the earlier ones.
    const ordered = [...target.transactionsRaw].sort((x, y) => txNumber(x) - txNumber(y));
    const size = Math.ceil(ordered.length / parts);
    const slice = { ...target, transactionsRaw: ordered.slice((part - 1) * size, part * size) };
    return download(transactionsCsv([slice]), `${base}-transactions-part${part}-of-${parts}.csv`, "text/csv");
  } catch (err) {
    if (err instanceof YahooTokenUnavailableError) return json({ error: err.message }, 409);
    if (err instanceof YahooApiError && err.status === 401) {
      return json({ error: "Yahoo rejected the stored access token. Run this again shortly after the daily sync or a Sync Now." }, 409);
    }
    if (err instanceof YahooApiError) return json({ error: err.message }, 502);
    // Anything else (e.g. a database error) may carry internal detail - log it, don't return it.
    console.error("Yahoo history export failed", err instanceof Error ? err.name : typeof err);
    return json({ error: "The Yahoo history export failed unexpectedly. Nothing was saved; try again." }, 500);
  }
}

const bytes = (s: string) => Buffer.byteLength(s, "utf8");

/** "469.l.8891.tr.123" -> 123, for a stable oldest-first order. */
const txNumber = (tx: unknown[]) => Number(String((tx[0] as { transaction_key?: unknown })?.transaction_key ?? "").split(".tr.")[1]) || 0;

/** Private league data: never cached by the browser or Vercel's edge. */
const NO_STORE = { "Cache-Control": "private, no-store" };

function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

function download(body: string, filename: string, type: string) {
  return new NextResponse(body, { headers: { ...NO_STORE, "Content-Type": `${type}; charset=utf-8`, "Content-Disposition": `attachment; filename="${filename}"` } });
}

/** Read-only: the Yahoo transaction keys Antlerboard already stores, per exported league. */
async function storedTransactionKeys(leagueKeys: string[]): Promise<AntlerboardComparison[]> {
  const out: AntlerboardComparison[] = [];
  for (const leagueKey of leagueKeys) {
    const rows = await prisma.transaction.findMany({ where: { yahooTransactionId: { startsWith: `${leagueKey}.tr.` } }, select: { yahooTransactionId: true, seasonYear: true } });
    if (rows.length === 0) continue;
    out.push({ leagueKey, seasonYear: rows[0].seasonYear, storedTransactionKeys: rows.map((r) => r.yahooTransactionId!) });
  }
  return out;
}
