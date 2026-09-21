import { prisma } from "@/lib/db";
import { PageHeader } from "@/components/ui/PageHeader";
import { Card, EmptyState } from "@/components/ui/Card";
import { DraftColorBadge } from "@/components/ui/Badge";
import { getDraftColorRange } from "@/lib/draft-color-engine";
import { getPlayerHistoryEvents } from "@/lib/keeper-sync";
import { buildStints } from "@/lib/keeper-engine";
import { formatDate } from "@/lib/format";
import Link from "next/link";

export const dynamic = "force-dynamic";

export default async function HistoryPage() {
  const [seasons, dpudHistory, multiAcqPlayers] = await Promise.all([
    prisma.season.findMany({
      orderBy: { year: "desc" },
      include: { champion: { include: { manager: true } } },
    }),
    prisma.dpudBet.findMany({
      where: { status: "COMPLETE" },
      orderBy: { updatedAt: "desc" },
      include: { creator: true },
    }),
    prisma.player.findMany({
      where: { acquisitions: { some: {} } },
      include: { acquisitions: { orderBy: { seasonYear: "asc" } } },
    }),
  ]);

  const colorRange = getDraftColorRange(2020, 2028);
  const champions = seasons.filter((s) => s.champion);

  // Players with more than one non-trade acquisition have restarted their
  // keeper clock at least once - either via a drop or a forced redraft.
  const milestonePlayers: { playerId: string; name: string; transitions: { fromSeason: number; toSeason: number; reason: string }[] }[] = [];

  for (const player of multiAcqPlayers) {
    const startingAcqs = player.acquisitions.filter((a) => a.method !== "TRADE");
    if (startingAcqs.length < 2) continue;

    const events = await getPlayerHistoryEvents(player.id);
    const stints = buildStints(events);
    const drops = await prisma.transaction.findMany({
      where: { type: "DROP", players: { some: { playerId: player.id } } },
    });
    const dropSeasons = new Set(drops.map((d) => d.seasonYear));

    const transitions = [];
    for (let i = 1; i < stints.length; i++) {
      const prev = stints[i - 1];
      const curr = stints[i];
      const reason = dropSeasons.has(curr.startSeason)
        ? "Dropped and later re-added"
        : "Forced back after 5 consecutive keeper years";
      transitions.push({
        fromSeason: prev.startSeason,
        toSeason: curr.startSeason,
        reason,
      });
    }
    if (transitions.length > 0) {
      milestonePlayers.push({ playerId: player.id, name: player.name, transitions });
    }
  }

  return (
    <div className="space-y-8">
      <PageHeader title="C&A History" subtitle="The permanent archive: champions, drafts, and keeper milestones." />

      <section>
        <h2 className="font-display text-lg mb-3">Champions</h2>
        {champions.length === 0 ? (
          <EmptyState title="No champions recorded yet" />
        ) : (
          <ol className="space-y-1.5">
            {champions.map((s) => (
              <li key={s.id} className="flex items-center justify-between text-sm rounded-lg border border-border bg-surface px-3 py-2">
                <span className="tabular w-14 text-muted">{s.year}</span>
                <Link href={`/teams/${s.championTeamId}`} className="flex-1 hover:text-antler-strong font-medium">
                  {s.champion?.name}
                </Link>
                <span className="text-muted text-xs">{s.champion?.manager.name}</span>
              </li>
            ))}
          </ol>
        )}
      </section>

      <section>
        <h2 className="font-display text-lg mb-3">Draft Color Cycle</h2>
        <p className="text-sm text-muted mb-3">
          Red &rarr; Orange &rarr; Yellow &rarr; Green &rarr; Blue, anchored at 2021 = Red. A skipped season pauses
          the cycle instead of advancing it.
        </p>
        <div className="flex flex-wrap gap-2">
          {colorRange.map((c) => (
            <Link
              key={c.year}
              href={`/history/draft/${c.year}`}
              className="flex flex-col items-center gap-1 rounded-lg border border-border bg-surface px-3 py-2 hover:border-antler-dim"
            >
              <span className="text-xs text-muted">{c.year}</span>
              <DraftColorBadge color={c.color} />
            </Link>
          ))}
        </div>
      </section>

      <section>
        <h2 className="font-display text-lg mb-3">Keeper Milestones</h2>
        {milestonePlayers.length === 0 ? (
          <EmptyState title="No resets or forced redrafts recorded yet" />
        ) : (
          <div className="space-y-3">
            {milestonePlayers.map((p) => (
              <Card key={p.playerId}>
                <Link href={`/players/${p.playerId}`} className="font-medium hover:text-antler-strong">
                  {p.name}
                </Link>
                <ul className="mt-1 text-sm text-muted space-y-0.5">
                  {p.transitions.map((t, i) => (
                    <li key={i}>
                      {t.reason} ({t.fromSeason} &rarr; {t.toSeason})
                    </li>
                  ))}
                </ul>
              </Card>
            ))}
          </div>
        )}
      </section>

      <section>
        <h2 className="font-display text-lg mb-3">DPUD Results Archive</h2>
        {dpudHistory.length === 0 ? (
          <EmptyState title="No resolved bets yet" />
        ) : (
          <ul className="divide-y divide-border rounded-xl border border-border overflow-hidden">
            {dpudHistory.map((b) => (
              <li key={b.id} className="px-4 py-3 text-sm flex items-center justify-between">
                <span>
                  {b.title} <span className="text-muted">by {b.creator.name}</span>
                </span>
                <span className="text-xs text-muted">{formatDate(b.endDate)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
