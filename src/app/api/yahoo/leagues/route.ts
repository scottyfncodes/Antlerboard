import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { yahooFantasyGet } from "@/lib/yahoo/client";
import { toArray, mergeMeta, fantasyContent } from "@/lib/yahoo/parse";
import { isLikelyClawAndAntler } from "@/lib/yahoo/league-match";
import { YahooApiError } from "@/lib/yahoo/errors";
import { requireCommissioner } from "@/lib/current-manager";

export interface DiscoveredLeague {
  key: string;
  leagueId: string | null;
  name: string;
  season: string;
  gameKey: string | null;
  gameId: string | null;
  gameCode: string | null;
  numTeams: number | null;
  draftStatus: string | null;
  isFinished: boolean | null;
  scoringType: string | null;
  leagueType: string | null;
  url: string | null;
  isLikelyClawAndAntler: boolean;
}

export interface LeagueDiagnostic {
  reason: "no_game" | "no_leagues" | "app_not_authorized" | "request_failed";
  queried: string;
  gamesFound: number;
  message: string;
  helpUrl?: string;
}

const YAHOO_APP_CONFIRMATION_URL = "https://sports.yahoo.com/developer/application-confirmation/";

// `mlb` is Yahoo's alias for "the current MLB fantasy game" - it resolves
// server-side to whichever game_key is live right now, so this always asks
// for the current season without us having to know/guess the numeric id.
const QUERY_PATH = "/users;use_login=1/games;game_keys=mlb/leagues";

/**
 * Lists the logged-in Yahoo user's current-season MLB fantasy leagues so the
 * commissioner can identify and select the Claw & Antler League. Discovery
 * only - this never selects a league or touches sync; see
 * /api/yahoo/select-league for that.
 *
 * Degrades gracefully in every non-happy-path case (no games, no leagues, or
 * the Yahoo request itself failing) rather than treating any of them as a
 * 500 - see the `diagnostic` field on the response.
 */
export async function GET() {
  if (!(await requireCommissioner())) {
    return NextResponse.json({ error: "Commissioner access required" }, { status: 403 });
  }

  const league = await prisma.league.findFirst();
  if (!league) return NextResponse.json({ error: "No league configured" }, { status: 500 });

  try {
    const data = await yahooFantasyGet(league.id, QUERY_PATH);

    const users = toArray(fantasyContent(data).users);
    const userNode = users[0] as { user?: unknown } | undefined;
    const games = toArray(mergeMeta(userNode?.user).games ?? (userNode?.user as unknown[] | undefined)?.[1]);

    const leagues: DiscoveredLeague[] = [];
    let gamesFound = 0;

    for (const gameEntry of games) {
      const gameNode = (gameEntry as { game?: unknown })?.game;
      if (!gameNode) continue;
      gamesFound++;

      const gameNodeEntries = toArray(gameNode);
      const leaguesContainer = gameNodeEntries.find(
        (n) => n && typeof n === "object" && "leagues" in (n as object)
      ) as { leagues?: unknown } | undefined;
      // Everything in the game node besides the {leagues: ...} container is
      // the game's own meta (game_key, game_id, code, season, ...).
      const gameMeta = mergeMeta(gameNodeEntries.filter((n) => n !== leaguesContainer));

      for (const leagueEntry of toArray(leaguesContainer?.leagues)) {
        const meta = mergeMeta((leagueEntry as { league?: unknown })?.league);
        if (!meta.league_key) continue;

        const name = String(meta.name ?? "Unnamed League");

        leagues.push({
          key: String(meta.league_key),
          leagueId: meta.league_id !== undefined ? String(meta.league_id) : null,
          name,
          season: String(meta.season ?? gameMeta.season ?? ""),
          gameKey: gameMeta.game_key ? String(gameMeta.game_key) : null,
          gameId: gameMeta.game_id !== undefined ? String(gameMeta.game_id) : null,
          // Yahoo's own field for this is `code` (e.g. "mlb"); `game_code`
          // is kept as a defensive fallback in case a response ever nests
          // it differently rather than assuming one exact shape.
          gameCode: gameMeta.code ? String(gameMeta.code) : gameMeta.game_code ? String(gameMeta.game_code) : null,
          numTeams: meta.num_teams !== undefined ? Number(meta.num_teams) : null,
          draftStatus: meta.draft_status ? String(meta.draft_status) : null,
          isFinished: meta.is_finished !== undefined ? meta.is_finished === "1" || meta.is_finished === 1 : null,
          scoringType: meta.scoring_type ? String(meta.scoring_type) : null,
          leagueType: meta.league_type ? String(meta.league_type) : null,
          url: meta.url ? String(meta.url) : null,
          isLikelyClawAndAntler: isLikelyClawAndAntler(name),
        });
      }
    }

    const likelyMatchKey = leagues.find((l) => l.isLikelyClawAndAntler)?.key ?? null;

    let diagnostic: LeagueDiagnostic | null = null;
    if (leagues.length === 0) {
      diagnostic =
        gamesFound === 0
          ? {
              reason: "no_game",
              queried: QUERY_PATH,
              gamesFound,
              message:
                "Yahoo didn't return a current MLB fantasy game for this account - this Yahoo login may not have an active MLB fantasy season.",
            }
          : {
              reason: "no_leagues",
              queried: QUERY_PATH,
              gamesFound,
              message:
                "Yahoo found the current MLB season, but this account isn't a member of any leagues in it. Make sure you're logged into the Yahoo account that's actually in the Claw & Antler League.",
            };
    }

    return NextResponse.json({ leagues, likelyMatchKey, diagnostic });
  } catch (err) {
    const diagnostic: LeagueDiagnostic =
      err instanceof YahooApiError && err.isAppNotAuthorized
        ? {
            reason: "app_not_authorized",
            queried: QUERY_PATH,
            gamesFound: 0,
            message:
              "Yahoo login worked, but Yahoo hasn't enabled Fantasy Sports API access for this app's Client ID yet. Submit the app's Client ID on Yahoo's Fantasy API confirmation form, then Disconnect and Connect Yahoo again once Yahoo confirms.",
            helpUrl: YAHOO_APP_CONFIRMATION_URL,
          }
        : {
            reason: "request_failed",
            queried: QUERY_PATH,
            gamesFound: 0,
            message: "The request to Yahoo's Fantasy API failed - see error for detail.",
          };

    return NextResponse.json(
      {
        leagues: [],
        likelyMatchKey: null,
        diagnostic,
        error: err instanceof Error ? err.message : "Failed to load Yahoo leagues",
      },
      { status: 200 }
    );
  }
}
