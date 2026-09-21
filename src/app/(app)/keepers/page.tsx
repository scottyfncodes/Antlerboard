import { prisma } from "@/lib/db";
import { CURRENT_SEASON_YEAR } from "@/lib/config";
import { PageHeader } from "@/components/ui/PageHeader";
import { EmptyState } from "@/components/ui/Card";
import { KeeperYearBadge } from "@/components/keepers/KeeperYearBadge";
import { KeeperFilters } from "@/components/keepers/KeeperFilters";
import { formatCost } from "@/lib/format";
import Link from "next/link";
import clsx from "clsx";
import type { Prisma } from "@prisma/client";

export const dynamic = "force-dynamic";

export default async function KeeperBoardPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const sp = await searchParams;
  const teams = await prisma.team.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } });

  const where: Prisma.KeeperRecordWhereInput = {
    seasonYear: CURRENT_SEASON_YEAR,
    keeperYear: { gte: sp.minYear ? Number(sp.minYear) : 1 },
  };
  if (sp.team) where.teamId = sp.team;
  if (sp.status) where.status = sp.status as never;

  const orderBy: Prisma.KeeperRecordOrderByWithRelationInput[] =
    sp.sort === "cost"
      ? [{ keeperCost: "desc" }]
      : sp.sort === "yearsRemaining"
        ? [{ yearsRemaining: "asc" }]
        : sp.sort === "player"
          ? [{ player: { name: "asc" } }]
          : [{ team: { name: "asc" } }, { keeperYear: "desc" }];

  const records = await prisma.keeperRecord.findMany({
    where,
    orderBy,
    include: { player: true, team: true },
  });

  const grouped = new Map<string, typeof records>();
  for (const r of records) {
    if (!grouped.has(r.teamId)) grouped.set(r.teamId, []);
    grouped.get(r.teamId)!.push(r);
  }

  const flatView = !!(sp.sort === "cost" || sp.sort === "yearsRemaining" || sp.sort === "player");

  return (
    <div className="space-y-4">
      <PageHeader
        title="Keeper Board"
        subtitle="All 10 keeper slots for every team. Year 4 and Year 5 are flagged so nobody gets surprised."
      />
      <KeeperFilters teams={teams} />

      {records.length === 0 ? (
        <EmptyState title="No keepers match those filters" />
      ) : flatView ? (
        <KeeperTable records={records} showTeam />
      ) : (
        <div className="space-y-6">
          {[...grouped.entries()].map(([teamId, teamRecords]) => (
            <section key={teamId}>
              <h2 className="font-display text-lg mb-2">
                <Link href={`/teams/${teamId}`} className="hover:text-antler-strong">
                  {teamRecords[0].team.name}
                </Link>{" "}
                <span className="text-sm text-muted font-sans">({teamRecords.length}/10)</span>
              </h2>
              <KeeperTable records={teamRecords} />
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

function KeeperTable({
  records,
  showTeam,
}: {
  records: {
    id: string;
    keeperYear: number;
    keeperCost: number;
    yearsRemaining: number;
    status: string;
    playerId: string;
    player: { name: string; mlbTeam: string | null };
    team: { id: string; name: string };
  }[];
  showTeam?: boolean;
}) {
  return (
    <div className="rounded-xl border border-border overflow-hidden">
      <table className="w-full text-sm">
        <thead>
          <tr className="bg-surface-raised text-left text-xs text-muted">
            <th className="px-2 py-2 font-medium">Player</th>
            {showTeam && <th className="px-2 py-2 font-medium hide-xs">Team</th>}
            <th className="px-2 py-2 font-medium">Cost</th>
            <th className="px-2 py-2 font-medium">Keeper Year</th>
          </tr>
        </thead>
        <tbody>
          {records.map((r) => (
            <tr
              key={r.id}
              className={clsx(
                "border-t border-border",
                r.keeperYear >= 5 && "bg-red/5",
                r.keeperYear === 4 && "bg-yellow/5"
              )}
            >
              <td className="px-2 py-2">
                <Link href={`/players/${r.playerId}`} className="hover:text-antler-strong font-medium">
                  {r.player.name}
                </Link>
                <span className="text-muted ml-1 text-xs hide-xs">{r.player.mlbTeam}</span>
              </td>
              {showTeam && (
                <td className="px-2 py-2 hide-xs">
                  <Link href={`/teams/${r.team.id}`} className="hover:text-antler-strong text-muted">
                    {r.team.name}
                  </Link>
                </td>
              )}
              <td className="px-2 py-2 tabular">{formatCost(r.keeperCost)}</td>
              <td className="px-2 py-2">
                <KeeperYearBadge keeperYear={r.keeperYear} status={r.status} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
