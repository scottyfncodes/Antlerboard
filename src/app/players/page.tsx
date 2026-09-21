import { prisma } from "@/lib/db";
import { CURRENT_SEASON_YEAR } from "@/lib/config";
import { PageHeader } from "@/components/ui/PageHeader";
import { EmptyState } from "@/components/ui/Card";
import { PlayerFilters } from "@/components/players/PlayerFilters";
import { KeeperYearBadge } from "@/components/keepers/KeeperYearBadge";
import { PlayerTagBadge } from "@/components/ui/Badge";
import { formatCost, PLAYER_TAG_LABEL } from "@/lib/format";
import Link from "next/link";
import type { Prisma, PlayerTagType } from "@prisma/client";

export const dynamic = "force-dynamic";

const POSITIONS = ["C", "1B", "2B", "3B", "SS", "OF", "SP", "RP"];

export default async function PlayerMarketPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const sp = await searchParams;
  const teams = await prisma.team.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } });

  const keeperWhere: Prisma.KeeperRecordWhereInput = { seasonYear: CURRENT_SEASON_YEAR };
  if (sp.team) keeperWhere.teamId = sp.team;
  if (sp.yearsRemaining) keeperWhere.yearsRemaining = Number(sp.yearsRemaining);

  const playerWhere: Prisma.PlayerWhereInput = {
    keeperRecords: { some: keeperWhere },
  };
  if (sp.q) playerWhere.name = { contains: sp.q, mode: "insensitive" };
  if (sp.position) playerWhere.positions = { has: sp.position };
  if (sp.tag) {
    playerWhere.tags = { some: { tag: sp.tag as PlayerTagType } };
  }

  const players = await prisma.player.findMany({
    where: playerWhere,
    include: {
      keeperRecords: { where: keeperWhere, include: { team: true } },
      tags: true,
    },
    take: 200,
  });

  let rows = players
    .map((p) => ({ player: p, record: p.keeperRecords[0] }))
    .filter((r) => r.record);

  if (sp.sort === "cost") {
    rows = rows.sort((a, b) => b.record!.keeperCost - a.record!.keeperCost);
  } else if (sp.sort === "yearsRemaining") {
    rows = rows.sort((a, b) => a.record!.yearsRemaining - b.record!.yearsRemaining);
  } else {
    rows = rows.sort((a, b) => a.player.name.localeCompare(b.player.name));
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="Player Market"
        subtitle="Everyone rostered in C&A - who's keeping, who's on the table, and what they'd cost you."
      />
      <PlayerFilters teams={teams} positions={POSITIONS} />

      {rows.length === 0 ? (
        <EmptyState title="No players match those filters" />
      ) : (
        <div className="rounded-xl border border-border overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-surface-raised text-left text-xs text-muted">
                <th className="px-2 py-2 font-medium">Player</th>
                <th className="px-2 py-2 font-medium hide-xs">Team</th>
                <th className="px-2 py-2 font-medium hide-xs">Pos</th>
                <th className="px-2 py-2 font-medium">Cost</th>
                <th className="px-2 py-2 font-medium">Keeper Year</th>
                <th className="px-2 py-2 font-medium hide-xs">Years Left</th>
                <th className="px-2 py-2 font-medium">Tag</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ player, record }) => {
                const tag = player.tags.find((t) => t.teamId === record!.teamId);
                return (
                  <tr key={player.id} className="border-t border-border">
                    <td className="px-2 py-2">
                      <Link href={`/players/${player.id}`} className="hover:text-antler-strong font-medium">
                        {player.name}
                      </Link>
                      <span className="text-muted ml-1 text-xs hide-xs">{player.mlbTeam}</span>
                    </td>
                    <td className="px-2 py-2 hide-xs">
                      <Link href={`/teams/${record!.teamId}`} className="text-muted hover:text-antler-strong">
                        {record!.team.name}
                      </Link>
                    </td>
                    <td className="px-2 py-2 hide-xs text-muted">{player.positions.join("/")}</td>
                    <td className="px-2 py-2 tabular">{formatCost(record!.keeperCost)}</td>
                    <td className="px-2 py-2">
                      <KeeperYearBadge keeperYear={record!.keeperYear} status={record!.status} />
                    </td>
                    <td className="px-2 py-2 hide-xs tabular">{record!.yearsRemaining}</td>
                    <td className="px-2 py-2">
                      {tag && <PlayerTagBadge tag={tag.tag} label={PLAYER_TAG_LABEL[tag.tag]} />}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
