import { prisma } from "@/lib/db";
import { CURRENT_SEASON_YEAR } from "@/lib/config";
import { PageHeader } from "@/components/ui/PageHeader";
import { EmptyState } from "@/components/ui/Card";
import { PlayerFilters } from "@/components/players/PlayerFilters";
import { PlayersTabs } from "@/components/players/PlayersTabs";
import { PlayerRow, PlayerSection } from "@/components/players/PlayerRow";
import { PlayerTagBadge } from "@/components/ui/Badge";
import { PLAYER_TAG_LABEL } from "@/lib/format";
import { loadMarketRows } from "@/lib/keeper-cost-views";
import type { PlayerTagType } from "@prisma/client";

export const dynamic = "force-dynamic";

const POSITIONS = ["C", "1B", "2B", "3B", "SS", "OF", "SP", "RP"];

export default async function PlayerMarketPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const sp = await searchParams;
  const teams = await prisma.team.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } });

  // Each row's keeper cost is checked against where it came from (see
  // loadMarketRows): an unconfirmed cost reads Unavailable, a forced-back
  // player None, and "sort by cost" ranks only confirmed amounts as numbers.
  const rows = await loadMarketRows({
    seasonYear: CURRENT_SEASON_YEAR,
    team: sp.team,
    yearsRemaining: sp.yearsRemaining ? Number(sp.yearsRemaining) : undefined,
    q: sp.q,
    position: sp.position,
    tag: sp.tag ? { some: { tag: sp.tag as PlayerTagType } } : undefined,
    sort: sp.sort,
  });

  return (
    <div className="space-y-4">
      <PageHeader
        title="Players"
        subtitle="Everyone rostered in C&A - who's keeping, who's on the table, and what they'd cost you."
      />
      <PlayersTabs active="market" />
      <PlayerFilters teams={teams} positions={POSITIONS} />

      {rows.length === 0 ? (
        <EmptyState title="No players match those filters" />
      ) : (
        <PlayerSection title="Rostered players" count={rows.length} right={<span>Cost · Clock</span>}>
          {rows.map(({ player, record, cost }) => {
            const tag = player.tags.find((t) => t.teamId === record.teamId);
            return (
              <PlayerRow
                key={player.id}
                player={player}
                meta={record.team.name}
                cost={cost}
                keeperYear={record.keeperYear}
                keeperStatus={record.status}
                trailing={tag && <PlayerTagBadge tag={tag.tag} label={PLAYER_TAG_LABEL[tag.tag]} />}
              />
            );
          })}
        </PlayerSection>
      )}
    </div>
  );
}
