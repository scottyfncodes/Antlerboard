import { prisma } from "@/lib/db";
import { CURRENT_SEASON_YEAR } from "@/lib/config";
import { PageHeader } from "@/components/ui/PageHeader";
import { Card, EmptyState } from "@/components/ui/Card";
import { Badge, PlayerTagBadge } from "@/components/ui/Badge";
import { KeeperYearBadge } from "@/components/keepers/KeeperYearBadge";
import { formatCost, timeAgo, PLAYER_TAG_LABEL } from "@/lib/format";
import Link from "next/link";
import { notFound } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function TeamDetailPage({ params }: { params: Promise<{ teamId: string }> }) {
  const { teamId } = await params;

  const team = await prisma.team.findUnique({
    where: { id: teamId },
    include: { manager: true, standings: { where: { season: { year: CURRENT_SEASON_YEAR } } } },
  });
  if (!team) notFound();

  const [roster, tags, transactions, trades, draftHistory] = await Promise.all([
    prisma.keeperRecord.findMany({
      where: { seasonYear: CURRENT_SEASON_YEAR, teamId },
      include: { player: true },
      orderBy: [{ keeperYear: "desc" }],
    }),
    prisma.playerTag.findMany({ where: { teamId }, include: { player: true } }),
    prisma.transaction.findMany({
      where: { teams: { some: { teamId } } },
      orderBy: { date: "desc" },
      take: 10,
      include: { players: { include: { player: true } } },
    }),
    prisma.trade.findMany({
      where: { OR: [{ teamAId: teamId }, { teamBId: teamId }] },
      orderBy: { updatedAt: "desc" },
      include: { teamA: true, teamB: true },
    }),
    prisma.draftPick.findMany({
      where: { teamId },
      orderBy: [{ seasonYear: "desc" }, { overallPick: "asc" }],
      include: { player: true },
      take: 20,
    }),
  ]);

  const tagByPlayer = new Map(tags.map((t) => [t.playerId, t]));

  const positionBreakdown = new Map<string, number>();
  for (const r of roster) {
    for (const pos of r.player.positions) {
      positionBreakdown.set(pos, (positionBreakdown.get(pos) ?? 0) + 1);
    }
  }

  const keeperSlots = roster.filter((r) => r.keeperYear >= 1);
  const standing = team.standings[0];

  return (
    <div className="space-y-6">
      <PageHeader
        title={team.name}
        subtitle={`Managed by ${team.manager.name}${standing ? ` · ${standing.wins}-${standing.losses}${standing.ties ? `-${standing.ties}` : ""}` : ""}`}
      />

      <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Card>
          <p className="text-xs text-muted">Rostered</p>
          <p className="font-display text-2xl mt-1 tabular">{roster.length}</p>
        </Card>
        <Card>
          <p className="text-xs text-muted">Keeper Slots Used</p>
          <p className="font-display text-2xl mt-1 tabular">{keeperSlots.length}/10</p>
        </Card>
        <Card>
          <p className="text-xs text-muted">In Year 4-5</p>
          <p className="font-display text-2xl mt-1 tabular">
            {roster.filter((r) => r.keeperYear >= 4 && r.keeperYear <= 5).length}
          </p>
        </Card>
        <Card>
          <p className="text-xs text-muted">Positions</p>
          <p className="text-sm mt-1">
            {[...positionBreakdown.entries()].map(([pos, n]) => `${pos} ${n}`).join(" · ") || "—"}
          </p>
        </Card>
      </section>

      <section>
        <h2 className="font-display text-lg mb-3">Roster</h2>
        {roster.length === 0 ? (
          <EmptyState title="No players rostered" />
        ) : (
          <div className="rounded-xl border border-border overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-surface-raised text-left text-xs text-muted">
                  <th className="px-2 py-2 font-medium">Player</th>
                  <th className="px-2 py-2 font-medium hide-xs">Positions</th>
                  <th className="px-2 py-2 font-medium">Cost</th>
                  <th className="px-2 py-2 font-medium">Keeper Year</th>
                  <th className="px-2 py-2 font-medium hide-xs">Tag</th>
                </tr>
              </thead>
              <tbody>
                {roster.map((r) => {
                  const tag = tagByPlayer.get(r.playerId);
                  return (
                    <tr key={r.id} className="border-t border-border">
                      <td className="px-2 py-2">
                        <Link href={`/players/${r.playerId}`} className="hover:text-antler-strong font-medium">
                          {r.player.name}
                        </Link>
                        <span className="text-muted ml-1 text-xs hide-xs">{r.player.mlbTeam}</span>
                      </td>
                      <td className="px-2 py-2 hide-xs text-muted">{r.player.positions.join("/")}</td>
                      <td className="px-2 py-2 tabular">{formatCost(r.keeperCost)}</td>
                      <td className="px-2 py-2">
                        <KeeperYearBadge keeperYear={r.keeperYear} status={r.status} />
                      </td>
                      <td className="px-2 py-2 hide-xs">
                        {tag && <PlayerTagBadge tag={tag.tag} label={PLAYER_TAG_LABEL[tag.tag]} />}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card>
          <h2 className="font-display text-lg mb-3">Recent Transactions</h2>
          {transactions.length === 0 ? (
            <p className="text-sm text-muted">Nothing logged yet.</p>
          ) : (
            <ul className="space-y-2 text-sm">
              {transactions.map((t) => (
                <li key={t.id} className="flex items-center justify-between">
                  <span className="truncate">{t.notes ?? `${t.type} — ${t.players.map((p) => p.player.name).join(", ")}`}</span>
                  <span className="text-xs text-muted whitespace-nowrap ml-2">{timeAgo(t.date)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card>
          <h2 className="font-display text-lg mb-3">Trade History</h2>
          {trades.length === 0 ? (
            <p className="text-sm text-muted">No trades yet.</p>
          ) : (
            <ul className="space-y-2 text-sm">
              {trades.map((t) => (
                <li key={t.id} className="flex items-center justify-between">
                  <span>
                    {t.teamA.name} &harr; {t.teamB.name}
                  </span>
                  <Badge variant={t.status === "ACCEPTED" ? "green" : "default"}>{t.status}</Badge>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </section>

      <section>
        <h2 className="font-display text-lg mb-3">Draft History</h2>
        {draftHistory.length === 0 ? (
          <p className="text-sm text-muted">No draft picks recorded.</p>
        ) : (
          <div className="rounded-xl border border-border overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-surface-raised text-left text-xs text-muted">
                  <th className="px-2 py-2 font-medium">Season</th>
                  <th className="px-2 py-2 font-medium">Nom.</th>
                  <th className="px-2 py-2 font-medium">Player</th>
                  <th className="px-2 py-2 font-medium">Cost</th>
                </tr>
              </thead>
              <tbody>
                {draftHistory.map((d) => (
                  <tr key={d.id} className="border-t border-border">
                    <td className="px-2 py-2 tabular">{d.seasonYear}</td>
                    <td className="px-2 py-2 tabular text-muted">
                      {d.round}.{String(d.pick).padStart(2, "0")}
                    </td>
                    <td className="px-2 py-2">
                      {d.player ? (
                        <Link href={`/players/${d.playerId}`} className="hover:text-antler-strong">
                          {d.player.name}
                        </Link>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="px-2 py-2 tabular">{formatCost(d.cost)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
