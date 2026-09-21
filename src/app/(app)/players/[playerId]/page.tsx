import { prisma } from "@/lib/db";
import { CURRENT_SEASON_YEAR } from "@/lib/config";
import { PageHeader } from "@/components/ui/PageHeader";
import { Card, EmptyState } from "@/components/ui/Card";
import { Badge, PlayerTagBadge } from "@/components/ui/Badge";
import { KeeperYearBadge } from "@/components/keepers/KeeperYearBadge";
import { formatCost, formatDate, PLAYER_TAG_LABEL } from "@/lib/format";
import { getPlayerHistoryEvents } from "@/lib/keeper-sync";
import {
  getContinuousKeeperHistory,
  getForcedRedraftSeason,
  isKeeperEligible,
  didPlayerResetKeeperClock,
} from "@/lib/keeper-engine";
import Link from "next/link";
import { notFound } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function PlayerProfilePage({ params }: { params: Promise<{ playerId: string }> }) {
  const { playerId } = await params;

  const player = await prisma.player.findUnique({
    where: { id: playerId },
    include: {
      tags: { include: { team: true } },
      keeperRecords: {
        where: { seasonYear: CURRENT_SEASON_YEAR },
        include: { team: true },
      },
    },
  });
  if (!player) notFound();

  const [transactions, tradeAssets, draftPicks] = await Promise.all([
    prisma.transactionPlayer.findMany({
      where: { playerId },
      include: { transaction: { include: { teams: true } } },
      orderBy: { transaction: { date: "desc" } },
    }),
    prisma.tradeAsset.findMany({
      where: { playerId },
      include: { trade: { include: { teamA: true, teamB: true } } },
    }),
    prisma.draftPick.findMany({
      where: { playerId },
      include: { team: true },
      orderBy: { seasonYear: "desc" },
    }),
  ]);

  const events = await getPlayerHistoryEvents(playerId);
  const timeline = getContinuousKeeperHistory(events, CURRENT_SEASON_YEAR);
  const forcedRedraftSeason = getForcedRedraftSeason(events, CURRENT_SEASON_YEAR);
  const eligibleNow = isKeeperEligible(events, CURRENT_SEASON_YEAR);
  const resetOccurred = didPlayerResetKeeperClock(events);

  const currentRecord = player.keeperRecords[0];
  const teamIdForCurrentTag = currentRecord?.teamId;
  const currentTag = player.tags.find((t) => t.teamId === teamIdForCurrentTag);

  // Group timeline rows into stints for a clear visual break between them.
  const stints = new Map<number, typeof timeline>();
  for (const row of timeline) {
    if (!stints.has(row.stintIndex)) stints.set(row.stintIndex, []);
    stints.get(row.stintIndex)!.push(row);
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title={player.name}
        subtitle={`${player.mlbTeam ?? "Free Agent (MLB)"} · ${player.positions.join("/")}${player.yahooPlayerId ? ` · Yahoo ID ${player.yahooPlayerId}` : ""}`}
        actions={currentTag ? <PlayerTagBadge tag={currentTag.tag} label={PLAYER_TAG_LABEL[currentTag.tag]} /> : undefined}
      />

      <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Card>
          <p className="text-xs text-muted">Current Team</p>
          <p className="mt-1 font-medium">
            {currentRecord ? (
              <Link href={`/teams/${currentRecord.teamId}`} className="hover:text-antler-strong">
                {currentRecord.team.name}
              </Link>
            ) : (
              "Unrostered"
            )}
          </p>
        </Card>
        <Card>
          <p className="text-xs text-muted">Keeper Cost</p>
          <p className="mt-1 font-display text-xl tabular">{formatCost(currentRecord?.keeperCost)}</p>
        </Card>
        <Card>
          <p className="text-xs text-muted">Keeper Year</p>
          <div className="mt-1">
            {currentRecord ? (
              <KeeperYearBadge keeperYear={currentRecord.keeperYear} status={currentRecord.status} />
            ) : (
              "—"
            )}
          </div>
        </Card>
        <Card>
          <p className="text-xs text-muted">Forced Redraft Season</p>
          <p className="mt-1 font-display text-xl tabular">{forcedRedraftSeason ?? "—"}</p>
        </Card>
      </section>

      {resetOccurred && (
        <div className="rounded-lg border border-antler-dim bg-antler-dim/10 px-4 py-3 text-sm text-antler-strong">
          This player&apos;s keeper clock has been reset at least once (a drop wipes prior tenure). The
          timeline below shows full history, but only the most recent stint affects their current cost,
          keeper year, and forced-redraft season.
        </div>
      )}

      {!eligibleNow && currentRecord && (
        <div className="rounded-lg border border-red/40 bg-red/10 px-4 py-3 text-sm text-red">
          This player has exceeded the maximum consecutive keeper years and must return to the draft.
        </div>
      )}

      <section>
        <h2 className="font-display text-lg mb-3">Draft / Keeper Timeline</h2>
        <div className="space-y-6">
          {[...stints.entries()].map(([stintIndex, rows]) => (
            <div key={stintIndex} className="relative pl-6 border-l-2 border-border">
              {stintIndex > 0 && (
                <p className="text-xs text-red mb-2 -ml-6 pl-6 border-l-2 border-red -mt-2">
                  Dropped after previous stint — keeper clock reset
                </p>
              )}
              <ul className="space-y-2">
                {rows.map((row) => (
                  <li key={row.season} className="flex items-center gap-3 text-sm">
                    <span className="w-12 tabular text-muted">{row.season}</span>
                    <span className="flex-1">
                      {row.keeperYear === 0
                        ? `${row.acquisitionMethod === "DRAFT" ? "Drafted" : row.acquisitionMethod === "WAIVER" ? "Added off waivers" : "Signed as free agent"}`
                        : row.status === "FORCED_BACK"
                          ? "Forced back into the draft"
                          : `Kept — Year ${row.keeperYear}`}
                    </span>
                    <span className="tabular text-muted">{row.cost !== null ? formatCost(row.cost) : ""}</span>
                    {row.keeperYear >= 4 && row.status === "KEPT" && (
                      <Badge variant={row.keeperYear === 5 ? "red" : "yellow"}>Year {row.keeperYear}/5</Badge>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
          {stints.size === 0 && <p className="text-sm text-muted">No acquisition history recorded.</p>}
        </div>
      </section>

      <section className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card>
          <h2 className="font-display text-lg mb-3">Draft History</h2>
          {draftPicks.length === 0 ? (
            <p className="text-sm text-muted">Never drafted (waiver/free agent only).</p>
          ) : (
            <ul className="space-y-2 text-sm">
              {draftPicks.map((d) => (
                <li key={d.id} className="flex items-center justify-between">
                  <span>
                    {d.seasonYear} — Rd {d.round}, Pick {d.pick} ({d.team.name})
                  </span>
                  <span className="tabular text-muted">{formatCost(d.cost)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card>
          <h2 className="font-display text-lg mb-3">Trade History</h2>
          {tradeAssets.length === 0 ? (
            <p className="text-sm text-muted">Never traded.</p>
          ) : (
            <ul className="space-y-2 text-sm">
              {tradeAssets.map((a) => (
                <li key={a.id} className="flex items-center justify-between">
                  <span>
                    {a.trade.teamA.name} ↔ {a.trade.teamB.name}
                  </span>
                  <Badge variant={a.trade.status === "ACCEPTED" ? "green" : "default"}>{a.trade.status}</Badge>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </section>

      <section>
        <h2 className="font-display text-lg mb-3">Transaction History</h2>
        {transactions.length === 0 ? (
          <EmptyState title="No transactions recorded" />
        ) : (
          <ul className="divide-y divide-border rounded-xl border border-border overflow-hidden">
            {transactions.map((tp) => (
              <li key={tp.id} className="px-4 py-2.5 text-sm flex items-center justify-between">
                <span>{tp.transaction.notes ?? tp.transaction.type}</span>
                <span className="text-xs text-muted">{formatDate(tp.transaction.date)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {player.notes && (
        <Card>
          <h2 className="font-display text-lg mb-2">Notes</h2>
          <p className="text-sm text-muted">{player.notes}</p>
        </Card>
      )}
    </div>
  );
}
