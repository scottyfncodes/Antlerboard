import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { yahooFantasyGet } from "@/lib/yahoo/client";
import { toArray, mergeMeta, fantasyContent } from "@/lib/yahoo/parse";

/**
 * Lists the logged-in Yahoo user's fantasy baseball leagues so the
 * commissioner can pick which one is the Claw & Antler League. Degrades
 * gracefully: if Yahoo returns nothing (or the account has no MLB leagues
 * this year), the caller just sees an empty list rather than a crash.
 */
export async function GET() {
  const league = await prisma.league.findFirst();
  if (!league) return NextResponse.json({ error: "No league configured" }, { status: 500 });

  try {
    const data = await yahooFantasyGet(league.id, "/users;use_login=1/games;game_keys=mlb/leagues");

    const users = toArray(fantasyContent(data).users);
    const userNode = users[0] as { user?: unknown } | undefined;
    const games = toArray(mergeMeta(userNode?.user).games ?? (userNode?.user as unknown[] | undefined)?.[1]);

    const leagues: { key: string; name: string; season: string }[] = [];
    for (const gameEntry of games) {
      const gameNode = (gameEntry as { game?: unknown })?.game;
      if (!gameNode) continue;
      const leaguesContainer = toArray(gameNode).find(
        (n) => n && typeof n === "object" && "leagues" in (n as object)
      ) as { leagues?: unknown } | undefined;

      for (const leagueEntry of toArray(leaguesContainer?.leagues)) {
        const meta = mergeMeta((leagueEntry as { league?: unknown })?.league);
        if (meta.league_key) {
          leagues.push({
            key: String(meta.league_key),
            name: String(meta.name ?? "Unnamed League"),
            season: String(meta.season ?? ""),
          });
        }
      }
    }

    return NextResponse.json({ leagues });
  } catch (err) {
    return NextResponse.json(
      { leagues: [], error: err instanceof Error ? err.message : "Failed to load Yahoo leagues" },
      { status: 200 }
    );
  }
}
