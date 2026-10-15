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

const FILES = ["report", "season.json", "transactions.csv", "draft.csv"] as const;
type ExportFile = (typeof FILES)[number];

/**
 * Read-only Yahoo history recovery (see src/lib/yahoo/history-export.ts and
 * docs/yahoo-history-export.md). Commissioner only.
 *
 *   ?file=report                      every reachable season: what Yahoo has, what's missing, and a
 *                                     comparison with the transactions Antlerboard already stores
 *   ?file=season.json&season=2024     one season: settings, teams, priced draft results, raw transactions
 *   ?file=transactions.csv&season=…   that season in the league-history import's Yahoo export format
 *   ?file=draft.csv&season=…          that season's draft results with player names and prices
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
  const season = seasonParam ? Number(seasonParam) : undefined;
  if (file !== "report" && (season === undefined || !Number.isInteger(season))) {
    return NextResponse.json({ error: "season=YYYY is required for season downloads" }, { status: 400 });
  }

  const league = await prisma.league.findFirst({ include: { yahooConnection: true } });
  const startLeagueKey = league?.yahooConnection?.yahooLeagueKey;
  if (!league || !startLeagueKey) return NextResponse.json({ error: "No Yahoo league is selected." }, { status: 400 });

  const get = (path: string) => yahooFantasyGet(league.id, path, { allowRefresh: false });
  // Token problems fail every request: stop and say so rather than report every season as refused.
  const isFatal = (err: unknown) => err instanceof YahooTokenUnavailableError || (err instanceof YahooApiError && err.status === 401);

  try {
    if (file === "report") {
      const history = await exportLeagueHistory(get, startLeagueKey, { firstSeasonYear: LEAGUE_FIRST_SEASON_YEAR, resolveDraftPlayers: false, isFatal });
      return NextResponse.json(buildRecoveryReport(history, await storedTransactionKeys(history.seasons.map((s) => s.leagueKey))));
    }

    const history = await exportLeagueHistory(get, startLeagueKey, { firstSeasonYear: LEAGUE_FIRST_SEASON_YEAR, onlySeason: season, isFatal });
    const target = history.seasons.find((s) => s.seasonYear === season);
    if (!target) {
      return NextResponse.json({ error: `Season ${season} isn't reachable: ${history.discovery.stoppedBecause}`, seasons: history.seasons.map((s) => ({ seasonYear: s.seasonYear, leagueKey: s.leagueKey, errors: s.errors })) }, { status: 404 });
    }
    const base = `antlerboard-yahoo-${season}`;
    if (file === "season.json") return download(JSON.stringify(target, null, 1), `${base}.json`, "application/json");
    if (file === "transactions.csv") return download(transactionsCsv([target]), `${base}-transactions.csv`, "text/csv");
    return download(draftCsv(target), `${base}-draft.csv`, "text/csv");
  } catch (err) {
    if (err instanceof YahooTokenUnavailableError) return NextResponse.json({ error: err.message }, { status: 409 });
    if (err instanceof YahooApiError && err.status === 401) {
      return NextResponse.json({ error: "Yahoo rejected the stored access token. Run this again shortly after the daily sync or a Sync Now." }, { status: 409 });
    }
    return NextResponse.json({ error: err instanceof Error ? err.message : "Yahoo export failed." }, { status: 502 });
  }
}

function download(body: string, filename: string, type: string) {
  return new NextResponse(body, { headers: { "Content-Type": `${type}; charset=utf-8`, "Content-Disposition": `attachment; filename="${filename}"` } });
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
