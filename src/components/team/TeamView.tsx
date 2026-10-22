import Link from "next/link";
import { prisma } from "@/lib/db";
import { AUCTION_BUDGET, CURRENT_SEASON_YEAR, KEEPER_SLOT_COUNT } from "@/lib/config";
import { Card, EmptyState } from "@/components/ui/Card";
import { Badge, PlayerTagBadge } from "@/components/ui/Badge";
import { SubTabs } from "@/components/ui/SubTabs";
import { TapReason } from "@/components/ui/TapReason";
import { PlayerRow, PlayerSection } from "@/components/players/PlayerRow";
import { MyPlayerTagControl } from "@/components/my-team/MyPlayerTagControl";
import { TeamHeader } from "./TeamHeader";
import { groupHittersAndPitchers } from "@/lib/positions";
import { loadTeamRosterCosts, shapeAuctionPick } from "@/lib/keeper-cost-views";
import { auctionNumberHeader } from "@/lib/draft-history";
import { loadTeamDraftPicks } from "@/lib/draft-history-data";
import { costDisplay } from "@/lib/player-costs";
import { visibleTradesWhere, type TradeViewer } from "@/lib/trade-access";
import { tradeTitle } from "@/lib/trades";
import { describeTransaction } from "@/lib/transaction-display";
import { formatCost, formatDateTime, statusLabel, timeAgo, PLAYER_TAG_LABEL } from "@/lib/format";

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
  const [team, season, { roster, declaredCount, budget }, tags] = await Promise.all([
    prisma.team.findUnique({
      where: { id: teamId },
      include: { manager: true, standings: { where: { season: { year: CURRENT_SEASON_YEAR } } } },
    }),
    prisma.season.findFirst({ where: { year: CURRENT_SEASON_YEAR } }),
    // The Yahoo roster when the sync has recorded one for this season,
    // otherwise the live keeper stints (see getTeamRoster) - each with its
    // checked keeper cost - plus the keeper slots the team declared.
    loadTeamRosterCosts(teamId, CURRENT_SEASON_YEAR),
    prisma.playerTag.findMany({ where: { teamId } }),
  ]);
  if (!team) return null;

  const tagByPlayer = new Map(tags.map((t) => [t.playerId, t]));
  const rows = roster.rows;
  const expiring = rows.filter((r) => (r.keeper?.keeperYear ?? 0) >= 4);
  const { hitters, pitchers } = groupHittersAndPitchers(rows, (r) => r.player.positions);

  const tabs = [
    { key: "roster", label: "Roster" },
    { key: "activity", label: "Activity" },
    { key: "draft", label: "Draft" },
  ].map((t) => ({ href: t.key === "roster" ? basePath : `${basePath}?tab=${t.key}`, label: t.label, active: tab === t.key }));

  const renderRow = (r: (typeof rows)[number]) => {
    const tag = tagByPlayer.get(r.player.id);
    // Keeper cost and clock only where a keeper record exists - a Yahoo
    // roster player without one has no keeper history to show yet.
    return (
      <PlayerRow
        key={r.key}
        player={r.player}
        cost={r.cost}
        keeperYear={r.keeper?.keeperYear}
        keeperStatus={r.keeper?.status}
        meta={r.selectedPosition ? `Slot ${r.selectedPosition}` : undefined}
        trailing={
          isMine ? (
            <MyPlayerTagControl playerId={r.player.id} currentTag={tag?.tag ?? null} />
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
          { label: "Roster", value: String(rows.length) },
          { label: "Keepers", value: `${declaredCount}/${KEEPER_SLOT_COUNT}` },
          { label: "Yr 4–5", value: String(expiring.length), tone: expiring.length > 0 ? "warn" : undefined },
          budget.budgetLeft === null
            ? {
                label: "Budget left",
                value: "–",
                tone: "muted",
                title: `${budget.unconfirmed} keeper cost${budget.unconfirmed === 1 ? "" : "s"} unconfirmed - the budget left can't be worked out yet.`,
              }
            : { label: "Budget left", value: formatCost(budget.budgetLeft) },
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
          {roster.source === "yahoo" && roster.lastSyncedAt && (
            <p className="text-xs text-muted">Yahoo roster · synced {timeAgo(roster.lastSyncedAt)}</p>
          )}
          {budget.budgetLeft === null && (
            <p className="text-xs text-muted">
              Budget left unknown: {budget.unconfirmed} keeper cost{budget.unconfirmed === 1 ? "" : "s"} unconfirmed ({formatCost(budget.confirmedTotal)} confirmed of {formatCost(AUCTION_BUDGET)}).
            </p>
          )}
          {rows.length === 0 ? (
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
  const [transactions, trades, teams] = await Promise.all([
    prisma.transaction.findMany({
      where: { teams: { some: { teamId } } },
      orderBy: { date: "desc" },
      take: 20,
      include: { players: { include: { player: true } }, teams: true },
    }),
    prisma.trade.findMany({
      // Another team's open negotiations are private to them - only show
      // the ones this viewer is allowed to see (accepted, or their own).
      where: { AND: [{ participants: { some: { teamId } } }, visibleTradesWhere(viewer)] },
      orderBy: { updatedAt: "desc" },
      include: { participants: { include: { team: true } } },
    }),
    prisma.team.findMany({ select: { id: true, name: true } }),
  ]);
  const teamNames = new Map(teams.map((t) => [t.id, t.name]));

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
                <span className="min-w-0 truncate">{describeTransaction(t, teamNames).summary}</span>
                <span className="shrink-0 text-xs text-muted">{t.dateUnavailable ? "date unknown" : timeAgo(t.date)}</span>
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
                  <Badge variant={t.status === "ACCEPTED" ? "green" : "default"}>{statusLabel(t.status)}</Badge>
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
  const picks = await loadTeamDraftPicks(teamId);
  if (picks.length === 0) return <EmptyState title="No draft picks recorded" />;

  const bySeason = new Map<number, typeof picks>();
  for (const p of picks) bySeason.set(p.seasonYear, [...(bySeason.get(p.seasonYear) ?? []), p]);

  return (
    <div className="space-y-4">
      {[...bySeason.entries()].map(([year, rows]) => {
        // Imported numbers may be workbook row order, not nominations - each
        // row says which, and the header only says "Nom." when all are.
        const shaped = rows.map((d) => ({ d, pick: shapeAuctionPick(d) }));
        return (
          <PlayerSection key={year} title={`${year} Auction`} count={rows.length} right={<span>{auctionNumberHeader(shaped.map((x) => x.pick.order))} · Cost</span>}>
            {shaped.map(({ d, pick }) => {
              const cost = costDisplay(pick.cost);
              return (
                <div key={d.id} className="flex items-center justify-between gap-3 px-3 py-2.5 text-sm">
                  {d.player ? (
                    <Link href={`/players/${d.playerId}`} className="min-w-0 truncate font-semibold hover:text-antler-strong">
                      {d.player.name}
                    </Link>
                  ) : (
                    <span className="text-muted">–</span>
                  )}
                  <span className="shrink-0 tabular text-muted">
                    <span title={pick.number.title}>{pick.isKeeperSlot ? "Keeper slot" : pick.number.text}</span> ·{" "}
                    {cost.confirmed ? (
                      <span title={cost.title} className="font-semibold text-foreground">
                        {cost.text}
                      </span>
                    ) : (
                      <TapReason reason={cost.title} className="text-xs">
                        {cost.text}
                      </TapReason>
                    )}
                  </span>
                </div>
              );
            })}
          </PlayerSection>
        );
      })}
    </div>
  );
}
