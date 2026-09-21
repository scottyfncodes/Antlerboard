import { prisma } from "@/lib/db";
import { getCurrentManager } from "@/lib/current-manager";
import { CURRENT_SEASON_YEAR } from "@/lib/config";
import { Card, EmptyState } from "@/components/ui/Card";
import { Badge, DraftColorBadge, PlayerTagBadge } from "@/components/ui/Badge";
import { formatDate, formatDateTime, timeAgo, PLAYER_TAG_LABEL } from "@/lib/format";
import Link from "next/link";

export const dynamic = "force-dynamic";

export default async function BoardPage() {
  const manager = await getCurrentManager();

  const [season, standings, keeperDeadlineSeason, recentTrades, recentTransactions, expiringKeepers, availablePlayers, recentPropBets, dpudCount, yahoo, unreadCount] =
    await Promise.all([
      prisma.season.findFirst({ where: { year: CURRENT_SEASON_YEAR }, include: { draftDayDetails: true } }),
      prisma.teamStanding.findMany({
        where: { season: { year: CURRENT_SEASON_YEAR } },
        orderBy: { rank: "asc" },
        include: { team: { include: { manager: true } } },
        take: 5,
      }),
      prisma.season.findFirst({ where: { year: CURRENT_SEASON_YEAR } }),
      prisma.trade.findMany({
        where: { status: { in: ["PROPOSED", "COUNTERED", "ACCEPTED"] } },
        orderBy: { updatedAt: "desc" },
        take: 4,
        include: { teamA: true, teamB: true },
      }),
      prisma.transaction.findMany({
        orderBy: { date: "desc" },
        take: 6,
        include: { players: { include: { player: true } }, teams: true },
      }),
      prisma.keeperRecord.findMany({
        where: { seasonYear: CURRENT_SEASON_YEAR, keeperYear: { gte: 4 } },
        orderBy: { keeperYear: "desc" },
        include: { player: true, team: true },
        take: 6,
      }),
      prisma.playerTag.findMany({
        where: { tag: "AVAILABLE" },
        orderBy: { updatedAt: "desc" },
        take: 5,
        include: { player: true, team: true },
      }),
      prisma.dpudBet.findMany({
        orderBy: { updatedAt: "desc" },
        take: 3,
        include: { participants: true },
      }),
      // The real DPUD (see /dpud) - FYPD-drafted players who'll show as
      // Yahoo-available but are already off-limits via C&A call-up rights.
      // Not to be confused with the dpudBet model above, which is the
      // league's prop-bet game (see /prop-bets - it used to be called
      // "DPUD" before that name got reused for this).
      prisma.fypdSelection.count({ where: { isDpud: true, callUpExercised: false } }),
      prisma.yahooConnection.findFirst(),
      manager
        ? prisma.notification.count({ where: { managerId: manager.id, read: false } })
        : Promise.resolve(0),
    ]);

  const myTeam = manager?.teams?.[0];

  return (
    <div className="space-y-8">
      <div className="flex items-start justify-between flex-wrap gap-4">
        <div>
          <p className="text-xs uppercase tracking-widest text-antler-strong font-medium">
            {season?.year} Season {season?.draftColor && `·`} {season?.draftColor && <DraftColorBadgeInline color={season.draftColor} />}
          </p>
          <h1 className="font-display text-3xl tracking-tight mt-1">The Board</h1>
          <p className="text-sm text-muted mt-1">
            What&apos;s happening in C&amp;A right now{myTeam ? ` — ${myTeam.name}` : ""}.
          </p>
        </div>
        {unreadCount > 0 && (
          <Link
            href="/notifications"
            className="rounded-full bg-antler-dim/30 border border-antler-dim px-3 py-1.5 text-sm text-antler-strong"
          >
            {unreadCount} unread notification{unreadCount === 1 ? "" : "s"}
          </Link>
        )}
      </div>

      <section className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card className="md:col-span-2">
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-display text-lg">Standings</h2>
            <Link href="/teams" className="text-xs text-antler hover:text-antler-strong">
              All teams &rarr;
            </Link>
          </div>
          {standings.length === 0 ? (
            <EmptyState
              title="No standings yet"
              subtitle="Connect Yahoo to pull in live standings, or wait for the season to get underway."
            />
          ) : (
            <ol className="space-y-1.5">
              {standings.map((s) => (
                <li key={s.id} className="flex items-center justify-between text-sm">
                  <span className="flex items-center gap-2">
                    <span className="w-5 text-muted tabular">{s.rank}</span>
                    <Link href={`/teams/${s.teamId}`} className="hover:text-antler-strong">
                      {s.team.name}
                    </Link>
                  </span>
                  <span className="tabular text-muted">
                    {s.wins}-{s.losses}
                    {s.ties ? `-${s.ties}` : ""}
                    {s.gamesBack ? ` · ${s.gamesBack} GB` : ""}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </Card>

        <Card>
          <h2 className="font-display text-lg mb-3">Yahoo Sync</h2>
          {yahoo ? (
            <div className="space-y-1.5 text-sm">
              <p>
                Status:{" "}
                <Badge variant={yahoo.lastSyncStatus === "SUCCESS" ? "green" : yahoo.lastSyncStatus === "FAILED" ? "red" : "default"}>
                  {yahoo.lastSyncStatus.replace("_", " ")}
                </Badge>
              </p>
              <p className="text-muted">
                Last success:{" "}
                {yahoo.lastSyncSuccessAt ? timeAgo(yahoo.lastSyncSuccessAt) : "never"}
              </p>
              <Link href="/commissioner/yahoo" className="inline-block mt-2 text-xs text-antler hover:text-antler-strong">
                Connect / manage Yahoo &rarr;
              </Link>
            </div>
          ) : (
            <p className="text-sm text-muted">Not configured.</p>
          )}
        </Card>
      </section>

      <section className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card>
          <h2 className="font-display text-lg mb-1">Keeper Declaration Deadline</h2>
          {keeperDeadlineSeason?.keeperDeadline ? (
            <>
              <p className="text-2xl font-display tabular">{formatDateTime(keeperDeadlineSeason.keeperDeadline)}</p>
              <p className="text-xs text-muted mt-1">
                Before the {keeperDeadlineSeason.year + 1} draft{keeperDeadlineSeason.draftDate && ` (${formatDate(keeperDeadlineSeason.draftDate)})`}.
              </p>
            </>
          ) : (
            <p className="text-sm text-muted">No deadline set for this season yet.</p>
          )}
          <Link href="/keepers" className="inline-block mt-3 text-xs text-antler hover:text-antler-strong">
            Open Keeper Board &rarr;
          </Link>
        </Card>

        <Card>
          <h2 className="font-display text-lg mb-1">Draft Day</h2>
          {season?.draftDate ? (
            <>
              <p className="text-2xl font-display tabular">{formatDate(season.draftDate)}</p>
              <p className="text-xs text-muted mt-1">
                {season.draftDayDetails?.draftTime && `${season.draftDayDetails.draftTime} · `}
                {season.draftDayDetails?.venue ?? "Live auction draft"}
              </p>
            </>
          ) : (
            <p className="text-sm text-muted">No draft date set for {CURRENT_SEASON_YEAR} yet.</p>
          )}
          <Link href={`/history/draft/${CURRENT_SEASON_YEAR}`} className="inline-block mt-3 text-xs text-antler hover:text-antler-strong">
            Draft Day Details &rarr;
          </Link>
        </Card>

        <Card className="md:col-span-2">
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-display text-lg">Approaching Keeper Expiration</h2>
            <Link href="/keepers?minYear=4" className="text-xs text-antler hover:text-antler-strong">
              See all &rarr;
            </Link>
          </div>
          {expiringKeepers.length === 0 ? (
            <p className="text-sm text-muted">No one is in year 4 or 5 right now.</p>
          ) : (
            <ul className="space-y-2">
              {expiringKeepers.map((k) => (
                <li key={k.id} className="flex items-center justify-between text-sm">
                  <span>
                    <Link href={`/players/${k.playerId}`} className="hover:text-antler-strong">
                      {k.player.name}
                    </Link>{" "}
                    <span className="text-muted">({k.team.name})</span>
                  </span>
                  <Badge variant={k.keeperYear >= 5 ? "red" : "yellow"}>
                    Year {k.keeperYear}/5 {k.keeperYear >= 5 ? "— FORCED BACK NEXT" : ""}
                  </Badge>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </section>

      <section className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card>
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-display text-lg">Recent Trade Activity</h2>
            <Link href="/trades" className="text-xs text-antler hover:text-antler-strong">
              Trade Center &rarr;
            </Link>
          </div>
          {recentTrades.length === 0 ? (
            <p className="text-sm text-muted">No trade activity yet.</p>
          ) : (
            <ul className="space-y-2">
              {recentTrades.map((t) => (
                <li key={t.id} className="text-sm flex items-center justify-between">
                  <span>
                    {t.teamA.name} &harr; {t.teamB.name}
                  </span>
                  <Badge variant={t.status === "ACCEPTED" ? "green" : "default"}>{t.status}</Badge>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card>
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-display text-lg">Recent Transactions</h2>
          </div>
          {recentTransactions.length === 0 ? (
            <p className="text-sm text-muted">Nothing logged yet.</p>
          ) : (
            <ul className="space-y-2">
              {recentTransactions.map((t) => (
                <li key={t.id} className="text-sm flex items-center justify-between">
                  <span className="truncate">
                    {t.notes ?? `${t.type} — ${t.players.map((p) => p.player.name).join(", ")}`}
                  </span>
                  <span className="text-xs text-muted whitespace-nowrap ml-2">{timeAgo(t.date)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card>
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-display text-lg">Prop Bet Activity</h2>
            <Link href="/prop-bets" className="text-xs text-antler hover:text-antler-strong">
              Prop Bets &rarr;
            </Link>
          </div>
          {recentPropBets.length === 0 ? (
            <p className="text-sm text-muted">No prop bets yet.</p>
          ) : (
            <ul className="space-y-2">
              {recentPropBets.map((b) => (
                <li key={b.id} className="text-sm flex items-center justify-between">
                  <span className="truncate">{b.title}</span>
                  <Badge variant={b.status === "COMPLETE" ? "green" : b.status === "ACTIVE" ? "blue" : "default"}>
                    {b.status} {b.status !== "COMPLETE" && `· ${b.participants.length}`}
                  </Badge>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </section>

      <section className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card className="md:col-span-2">
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-display text-lg">Newly Available</h2>
            <Link href="/players?tag=AVAILABLE" className="text-xs text-antler hover:text-antler-strong">
              Player Market &rarr;
            </Link>
          </div>
          {availablePlayers.length === 0 ? (
            <p className="text-sm text-muted">No one&apos;s been cut loose recently.</p>
          ) : (
            <ul className="space-y-2">
              {availablePlayers.map((t) => (
                <li key={t.id} className="text-sm flex items-center justify-between">
                  <Link href={`/players/${t.playerId}`} className="hover:text-antler-strong">
                    {t.player.name}
                  </Link>
                  <PlayerTagBadge tag={t.tag} label={PLAYER_TAG_LABEL[t.tag]} />
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card>
          <h2 className="font-display text-lg mb-1">DPUD</h2>
          <p className="text-2xl font-display tabular">{dpudCount}</p>
          <p className="text-xs text-muted mt-1">
            Yahoo-available, but already owned in C&amp;A via FYPD call-up rights.
          </p>
          <Link href="/dpud" className="inline-block mt-3 text-xs text-antler hover:text-antler-strong">
            Full list &rarr;
          </Link>
        </Card>
      </section>
    </div>
  );
}

function DraftColorBadgeInline({ color }: { color: string }) {
  return <DraftColorBadge color={color} />;
}
