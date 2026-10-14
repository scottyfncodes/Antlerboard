import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";

/**
 * Read side of Yahoo roster membership (RosterSpot), kept apart from keeper
 * history: a roster row says who is on a team now, a KeeperRecord says what
 * that player costs to keep. The team page shows both side by side.
 */

/**
 * A team's roster for a season. When the Yahoo sync has recorded any roster
 * for that season, the team's RosterSpot rows are the roster, each joined to
 * its keeper record when one exists. Seasons the sync never covered fall
 * back to the keeper-history view (live keeper stints), so pre-Yahoo
 * seasons still show what they always did.
 */
export async function getTeamRoster(teamId: string, seasonYear: number) {
  const season = await prisma.season.findFirst({
    where: { year: seasonYear, league: { teams: { some: { id: teamId } } } },
  });
  const keeperRows = await prisma.keeperRecord.findMany({
    // A stint that ended during the season (DROPPED) is history, not roster.
    where: { seasonYear, teamId, status: { not: "DROPPED" } },
    include: { player: true },
    orderBy: [{ keeperYear: "desc" }, { stintIndex: "desc" }, { keeperCost: "desc" }, { player: { name: "asc" } }],
  });

  const hasYahooRosters = season ? (await prisma.rosterSpot.count({ where: { seasonId: season.id } })) > 0 : false;
  if (!season || !hasYahooRosters) {
    return {
      source: "keepers" as const,
      lastSyncedAt: null,
      rows: keeperRows.map((k) => ({ key: k.id, player: k.player, keeper: k, selectedPosition: null as string | null })),
    };
  }

  const spots = await prisma.rosterSpot.findMany({
    where: { seasonId: season.id, teamId },
    include: { player: true },
    orderBy: { player: { name: "asc" } },
  });
  // Keeper facts for these players this season, wherever the keeper stint
  // currently points - the roster row, not the keeper row, decides the team.
  const keepers = await prisma.keeperRecord.findMany({
    where: { seasonId: season.id, playerId: { in: spots.map((s) => s.playerId) }, status: { not: "DROPPED" } },
    orderBy: { stintIndex: "desc" },
  });
  const keeperByPlayer = new Map<string, (typeof keepers)[number]>();
  for (const k of keepers) if (!keeperByPlayer.has(k.playerId)) keeperByPlayer.set(k.playerId, k);

  return {
    source: "yahoo" as const,
    lastSyncedAt: spots.reduce<Date | null>((latest, s) => (!latest || s.lastSeenAt > latest ? s.lastSeenAt : latest), null),
    rows: spots.map((s) => ({
      key: s.id,
      player: s.player,
      keeper: keeperByPlayer.get(s.playerId) ?? null,
      selectedPosition: s.selectedPosition,
    })),
  };
}

/**
 * A player's current team for a season. With Yahoo rosters recorded for the
 * season, the roster row decides - no row means a free agent. Without them,
 * the live keeper stint decides, as it did before the roster sync existed.
 */
export async function getCurrentTeamForPlayer(playerId: string, seasonYear: number) {
  const player = await prisma.player.findUnique({ where: { id: playerId }, select: { leagueId: true } });
  if (!player) return { status: "unrostered" as const, team: null };
  const season = await prisma.season.findFirst({ where: { leagueId: player.leagueId, year: seasonYear } });

  if (season && (await prisma.rosterSpot.count({ where: { seasonId: season.id } })) > 0) {
    const spot = await prisma.rosterSpot.findUnique({
      where: { seasonId_playerId: { seasonId: season.id, playerId } },
      include: { team: true },
    });
    return spot
      ? { status: "rostered" as const, team: spot.team, source: "yahoo" as const }
      : { status: "free_agent" as const, team: null, source: "yahoo" as const };
  }

  const keeper = await prisma.keeperRecord.findFirst({
    where: { playerId, seasonYear, status: { not: "DROPPED" } },
    include: { team: true },
    orderBy: { stintIndex: "desc" },
  });
  return keeper
    ? { status: "rostered" as const, team: keeper.team, source: "keepers" as const }
    : { status: "unrostered" as const, team: null, source: "keepers" as const };
}

type Db = Prisma.TransactionClient | typeof prisma;

/**
 * Who holds each player right now, for deciding what a team can trade.
 *
 * With a Yahoo roster snapshot recorded for the season (RosterSpot rows),
 * the snapshot decides - adjusted for deals agreed in Antlerboard since that
 * snapshot was taken: a TRADE acquisition created after the season's latest
 * roster sync means the move was agreed here (a trade or an accepted offer)
 * but isn't in Yahoo yet, so its receiving team holds the player. The next
 * sync moves the snapshot past it, and Yahoo's roster decides again.
 *
 * Without a Yahoo snapshot for the season, the live keeper stint decides, as
 * before rosters were synced - and a player with more than one live stint is
 * ambiguous, so he has no holder.
 *
 * Players with no holder (free agents, unknown ids, ambiguous stints) are
 * absent from the map. Run inside a deal's transaction, after taking the
 * players' locks, so a deal that just committed is visible here.
 */
export async function getCurrentHolders(
  db: Db,
  leagueId: string,
  seasonYear: number,
  playerIds?: string[]
): Promise<Map<string, string>> {
  const holders = new Map<string, string>();
  const season = await db.season.findFirst({ where: { leagueId, year: seasonYear }, select: { id: true } });
  if (!season) return holders;
  const playerFilter = playerIds ? { playerId: { in: playerIds } } : {};

  const snapshot = await db.rosterSpot.aggregate({ where: { seasonId: season.id }, _max: { lastSeenAt: true } });
  const snapshotAt = snapshot._max.lastSeenAt;

  if (snapshotAt) {
    const [spots, agreedSince] = await Promise.all([
      db.rosterSpot.findMany({ where: { seasonId: season.id, ...playerFilter }, select: { playerId: true, teamId: true } }),
      db.acquisition.findMany({
        where: { seasonId: season.id, method: "TRADE", createdAt: { gt: snapshotAt }, ...playerFilter },
        select: { playerId: true, teamId: true },
        orderBy: { createdAt: "asc" },
      }),
    ]);
    for (const s of spots) holders.set(s.playerId, s.teamId);
    for (const a of agreedSince) holders.set(a.playerId, a.teamId); // latest agreed move wins
    return holders;
  }

  const live = await db.keeperRecord.findMany({
    where: { seasonId: season.id, status: { not: "DROPPED" }, ...playerFilter },
    select: { playerId: true, teamId: true },
  });
  const stints = new Map<string, string[]>();
  for (const k of live) stints.set(k.playerId, [...(stints.get(k.playerId) ?? []), k.teamId]);
  for (const [playerId, teams] of stints) if (teams.length === 1) holders.set(playerId, teams[0]);
  return holders;
}

/**
 * What the trade form offers: each active team in the league with the
 * players it can trade right now. Holdings come from getCurrentHolders - the
 * same rule the trade and offer guards enforce - so the form never lists a
 * player the guard would refuse, or hides one it would accept. (Listing only
 * live keeper records left every roster empty once Yahoo rosters were synced
 * without keeper records.)
 */
export async function getTradeRosters(leagueId: string, seasonYear: number) {
  const [teams, holders] = await Promise.all([
    prisma.team.findMany({ where: { leagueId, active: true }, orderBy: { name: "asc" } }),
    getCurrentHolders(prisma, leagueId, seasonYear),
  ]);
  const players = await prisma.player.findMany({
    where: { id: { in: [...holders.keys()] } },
    select: { id: true, name: true, mlbTeam: true },
    orderBy: { name: "asc" },
  });
  return teams.map((t) => ({
    id: t.id,
    name: t.name,
    roster: players.filter((p) => holders.get(p.id) === t.id),
  }));
}
