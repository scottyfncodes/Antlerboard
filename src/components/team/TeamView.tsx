import Link from "next/link";
import { prisma } from "@/lib/db";
import { AUCTION_BUDGET, CURRENT_SEASON_YEAR, KEEPER_SLOT_COUNT } from "@/lib/config";
import { Card, EmptyState } from "@/components/ui/Card";
import { Badge, PlayerTagBadge } from "@/components/ui/Badge";
import { SubTabs } from "@/components/ui/SubTabs";
import { PlayerRow, PlayerSection } from "@/components/players/PlayerRow";
import { MyPlayerTagControl } from "@/components/my-team/MyPlayerTagControl";
import { TeamHeader } from "./TeamHeader";
import { groupHittersAndPitchers } from "@/lib/positions";
import { visibleTradesWhere, type TradeViewer } from "@/lib/trade-access";
import { tradeTitle } from "@/lib/trades";
import { formatCost, formatDateTime, timeAgo, PLAYER_TAG_LABEL } from "@/lib/format";

export const TEAM_TABS = ["roster", "activity", "draft"] as const;
export type TeamTab = (typeof TEAM_TABS)[number];

export function parseTeamTab(raw: string | undefined): TeamTab {
  return (TEAM_TABS as readonly string[]).includes(raw ?? "") ? (raw as TeamTab) : "roster";
}

/**
 * The one team screen behind both /my-team and /teams/[id], laid out like
 * the Yahoo app's team page: masthead, Roster / Activity / Draft tabs, and
 * a roster split into Hitters and Pitchers. `isMine` swaps tag badges for
 * the tag picker and adds the keeper-deadline / attention callouts.
 */
export async function TeamView({
  teamId,
  tab,
  basePath,
  isMine,
  viewer,
}: {
  teamId: string;
  tab: TeamTab;
  basePath: string;
  isMine: boolean;
  viewer: TradeViewer | null;
}) {
  const [team, season, roster, keeperSlotsDeclared, tags] = await Promise.all([
    prisma.team.findUnique({
      where: { id: teamId },
      include: { manager: true, standings: { where: { season: { year: CURRENT_SEASON_YEAR } } } },
    }),
    prisma.season.findFirst({ where: { year: CURRENT_SEASON_YEAR } }),
    prisma.keeperRecord.findMany({
      // A stint that ended during the season (DROPPED) is history, not roster.
      where: { seasonYear: CURRENT_SEASON_YEAR, teamId, status: { not: "DROPPED" } },
      include: { player: true },
      orderBy: [{ keeperYear: "desc" }, { stintIndex: "desc" }, { keeperCost: "desc" }, { player: { name: "asc" } }],
    }),
    // Keeper slots are what this team declared at the deadline, whether or
    // not the player has since been traded away.
    prisma.keeperRecord.findMany({
      where: { seasonYear: CURRENT_SEASON_YEAR, startTeamId: teamId, keeperYear: { gte: 1 } },
      select: { keeperCost: true },
    }),
    prisma.playerTag.findMany({ where: { teamId } }),
  ]);
  if (!team) return null;

  const tagByPlayer = new Map(tags.map((t) => [t.playerId, t]));
  const expiring = roster.filter((r) => r.keeperYear >= 4);
  const keeperCostDeclared = keeperSlotsDeclared.reduce((sum, r) => sum + r.keeperCost, 0);
  const { hitters, pitchers } = groupHittersAndPitchers(roster, (r) => r.player.positions);

  const tabs = [
    { key: "roster", label: "Roster" },
    { key: "activity", label: "Activity" },
    { key: "draft", label: "Draft" },
  ].map((t) => ({ href: t.key === "roster" ? basePath : `${basePath}?tab=${t.key}`, label: t.label, active: tab === t.key }));

  const renderRow = (r: (typeof roster)[number]) => {
    const tag = tagByPlayer.get(r.playerId);
    return (
      <PlayerRow
        key={r.id}
        player={r.player}
        cost={r.keeperCost}
        keeperYear={r.keeperYear}
        keeperStatus={r.status}
        trailing={
          isMine ? (
            <MyPlayerTagControl playerId={r.playerId} currentTag={tag?.tag ?? null} />
          ) : (
            tag && <PlayerTagBadge tag={tag.tag} label={PLAYER_TAG_LABEL[tag.tag]} />
          )
        }
      />
    );
  };

  return (
    <div className="space-y-4">
      <TeamHeader
        team={team}
        standing={team.standings[0]}
        eyebrow={isMine ? "My Team" : undefined}
        stats={[
          { label: "Roster", value: String(roster.length) },
          { label: "Keepers", value: `${keeperSlotsDeclared.length}/${KEEPER_SLOT_COUNT}` },
          { label: "Yr 4–5", value: String(expiring.length), tone: expiring.length > 0 ? "warn" : undefined },
          { label: "Budget left", value: formatCost(AUCTION_BUDGET - keeperCostDeclared) },
        ]}
      />

      <SubTabs tabs={tabs} />

      {tab === "roster" && (
        <div className="space-y-4">
          {isMine && season?.keeperDeadline && (
            <div className="flex items-center justify-between gap-3 rounded-xl border border-antler-dim bg-antler-dim/15 px-3 py-2.5 text-sm">
              <span className="text-muted">Keeper deadline</span>
              <span className="font-semibold text-antler-strong">{formatDateTime(season.keeperDeadline)}</span>
            </div>
          )}
          {roster.length === 0 ? (
            <EmptyState title="No players rostered yet" />
          ) : (
            <>
              {hitters.length > 0 && (
                <PlayerSection title="Hitters" count={hitters.length} right={<span>Cost · Clock</span>}>
                  {hitters.map(renderRow)}
                </PlayerSection>
              )}
              {pitchers.length > 0 && (
                <PlayerSection title="Pitchers" count={pitchers.length} right={<span>Cost · Clock</span>}>
                  {pitchers.map(renderRow)}
                </PlayerSection>
              )}
            </>
          )}
        </div>
      )}

      {tab === "activity" && <TeamActivity teamId={teamId} viewer={viewer} />}
      {tab === "draft" && <TeamDraft teamId={teamId} />}
    </div>
  );
}

async function TeamActivity({ teamId, viewer }: { teamId: string; viewer: TradeViewer | null }) {
  const [transactions, trades] = await Promise.all([
    prisma.transaction.findMany({
      where: { teams: { some: { teamId } } },
      orderBy: { date: "desc" },
      take: 20,
      include: { players: { include: { player: true } } },
    }),
    prisma.trade.findMany({
      // Another team's open negotiations are private to them - only show
      // the ones this viewer is allowed to see (accepted, or their own).
      where: { AND: [{ participants: { some: { teamId } } }, visibleTradesWhere(viewer)] },
      orderBy: { updatedAt: "desc" },
      include: { participants: { include: { team: true } } },
    }),
  ]);

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      <Card className="p-0 overflow-hidden">
        <h2 className="bg-surface-raised px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-muted">Transactions</h2>
        {transactions.length === 0 ? (
          <p className="px-3 py-4 text-sm text-muted">Nothing logged yet.</p>
        ) : (
          <ul className="divide-y divide-border text-sm">
            {transactions.map((t) => (
              <li key={t.id} className="flex items-center justify-between gap-3 px-3 py-2.5">
                <span className="min-w-0 truncate">{t.notes ?? `${t.type} — ${t.players.map((p) => p.player.name).join(", ")}`}</span>
                <span className="shrink-0 text-xs text-muted">{timeAgo(t.date)}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card className="p-0 overflow-hidden">
        <h2 className="bg-surface-raised px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-muted">Trades</h2>
        {trades.length === 0 ? (
          <p className="px-3 py-4 text-sm text-muted">No trades yet.</p>
        ) : (
          <ul className="divide-y divide-border text-sm">
            {trades.map((t) => (
              <li key={t.id}>
                <Link href="/trades" className="flex items-center justify-between gap-3 px-3 py-2.5 hover:bg-surface-raised">
                  <span className="min-w-0 truncate">
                    {tradeTitle(t.participants)}
                  </span>
                  <Badge variant={t.status === "ACCEPTED" ? "green" : "default"}>{t.status}</Badge>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

async function TeamDraft({ teamId }: { teamId: string }) {
  const picks = await prisma.draftPick.findMany({
    where: { teamId },
    orderBy: [{ seasonYear: "desc" }, { overallPick: "asc" }],
    include: { player: true },
    take: 40,
  });
  if (picks.length === 0) return <EmptyState title="No draft picks recorded" />;

  const bySeason = new Map<number, typeof picks>();
  for (const p of picks) bySeason.set(p.seasonYear, [...(bySeason.get(p.seasonYear) ?? []), p]);

  return (
    <div className="space-y-4">
      {[...bySeason.entries()].map(([year, rows]) => (
        <PlayerSection key={year} title={`${year} Auction`} count={rows.length} right={<span>Nom. · Cost</span>}>
          {rows.map((d) => (
            <div key={d.id} className="flex items-center justify-between gap-3 px-3 py-2.5 text-sm">
              {d.player ? (
                <Link href={`/players/${d.playerId}`} className="min-w-0 truncate font-semibold hover:text-antler-strong">
                  {d.player.name}
                </Link>
              ) : (
                <span className="text-muted">—</span>
              )}
              <span className="shrink-0 tabular text-muted">
                {d.round}.{String(d.pick).padStart(2, "0")} · <span className="font-semibold text-foreground">{formatCost(d.cost)}</span>
              </span>
            </div>
          ))}
        </PlayerSection>
      ))}
    </div>
  );
}
