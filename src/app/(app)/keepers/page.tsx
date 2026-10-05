import { prisma } from "@/lib/db";
import { AUCTION_BUDGET, CURRENT_SEASON_YEAR, KEEPER_SLOT_COUNT } from "@/lib/config";
import { PageHeader } from "@/components/ui/PageHeader";
import { EmptyState } from "@/components/ui/Card";
import { KeeperYearBadge } from "@/components/keepers/KeeperYearBadge";
import { KeeperFilters } from "@/components/keepers/KeeperFilters";
import { formatCost } from "@/lib/format";
import Link from "next/link";
import clsx from "clsx";
import type { Prisma } from "@prisma/client";

export const dynamic = "force-dynamic";

/**
 * The Keeper Board answers "who did each team keep going into this season,
 * and at what cost" - so rows group by the team that declared the keeper
 * (startTeam), with a note when the player has since been traded or
 * dropped. The live roster view is the team page.
 */
export default async function KeeperBoardPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const sp = await searchParams;
  const season = sp.season ? Number(sp.season) : CURRENT_SEASON_YEAR;
  const [teams, seasonYears] = await Promise.all([
    prisma.team.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } }),
    prisma.keeperRecord.findMany({ distinct: ["seasonYear"], select: { seasonYear: true }, orderBy: { seasonYear: "desc" } }),
  ]);

  const where: Prisma.KeeperRecordWhereInput = {
    seasonYear: season,
    keeperYear: { gte: sp.minYear ? Number(sp.minYear) : 1 },
  };
  if (sp.team) where.OR = [{ startTeamId: sp.team }, { startTeamId: null, teamId: sp.team }];
  if (sp.status) where.status = sp.status as never;

  const orderBy: Prisma.KeeperRecordOrderByWithRelationInput[] =
    sp.sort === "cost"
      ? [{ keeperCost: "desc" }]
      : sp.sort === "yearsRemaining"
        ? [{ yearsRemaining: "asc" }]
        : sp.sort === "player"
          ? [{ player: { name: "asc" } }]
          : [{ startTeam: { name: "asc" } }, { keeperYear: "desc" }, { keeperCost: "desc" }];

  const records = await prisma.keeperRecord.findMany({
    where,
    orderBy,
    include: { player: true, team: true, startTeam: true },
  });

  const grouped = new Map<string, typeof records>();
  for (const r of records) {
    const key = r.startTeamId ?? r.teamId;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(r);
  }

  const flatView = !!(sp.sort === "cost" || sp.sort === "yearsRemaining" || sp.sort === "player");

  return (
    <div className="space-y-4">
      <PageHeader
        title={season === CURRENT_SEASON_YEAR ? "Keeper Board" : `${season} Keeper Board`}
        subtitle={`Every keeper each team declared going into ${season}, with the cost it counted against their $${AUCTION_BUDGET}. Year 4 and Year 5 are flagged so nobody gets surprised.`}
        actions={
          seasonYears.length > 1 ? (
            <div className="flex gap-1.5 flex-wrap">
              {seasonYears.map((s) => (
                <Link
                  key={s.seasonYear}
                  href={`/keepers?season=${s.seasonYear}`}
                  className={clsx(
                    "rounded-full px-2.5 py-1 text-xs border",
                    s.seasonYear === season ? "bg-antler border-antler text-[#1a1305] font-medium" : "border-border text-muted hover:text-foreground"
                  )}
                >
                  {s.seasonYear}
                </Link>
              ))}
            </div>
          ) : undefined
        }
      />
      <KeeperFilters teams={teams} />

      {records.length === 0 ? (
        <EmptyState title="No keepers match those filters" />
      ) : flatView ? (
        <KeeperTable records={records} showTeam />
      ) : (
        <div className="space-y-6">
          {[...grouped.entries()].map(([teamId, teamRecords]) => {
            const team = teamRecords[0].startTeam ?? teamRecords[0].team;
            const total = teamRecords.reduce((sum, r) => sum + r.keeperCost, 0);
            return (
              <section key={teamId}>
                <h2 className="font-display text-lg mb-2 flex items-baseline gap-2 flex-wrap">
                  <Link href={`/teams/${team.id}`} className="hover:text-antler-strong">
                    {team.name}
                  </Link>
                  <span className="text-sm text-muted font-sans">
                    {teamRecords.length}/{KEEPER_SLOT_COUNT} · {formatCost(total)} in keepers · {formatCost(AUCTION_BUDGET - total)} left for the auction
                  </span>
                </h2>
                <KeeperTable records={teamRecords} />
              </section>
            );
          })}
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
    commissionerOverride: boolean;
    playerId: string;
    teamId: string;
    startTeamId: string | null;
    player: { name: string; mlbTeam: string | null };
    team: { id: string; name: string };
    startTeam: { id: string; name: string } | null;
  }[];
  showTeam?: boolean;
}) {
  return (
    <div className="rounded-xl border border-border overflow-hidden">
      <table className="w-full text-sm">
        <thead>
          <tr className="bg-surface-raised text-left text-xs text-muted">
            <th className="px-2 py-2 font-medium">Player</th>
            {showTeam && <th className="px-2 py-2 font-medium hide-xs">Kept by</th>}
            <th className="px-2 py-2 font-medium">Cost</th>
            <th className="px-2 py-2 font-medium">Keeper Year</th>
          </tr>
        </thead>
        <tbody>
          {records.map((r) => {
            const keptBy = r.startTeam ?? r.team;
            const movedTo = r.startTeamId && r.startTeamId !== r.teamId ? r.team : null;
            return (
              <tr
                key={r.id}
                className={clsx(
                  "border-t border-border",
                  r.keeperYear >= 5 && "bg-red/5",
                  r.keeperYear === 4 && "bg-yellow/5",
                  r.status === "DROPPED" && "opacity-70"
                )}
              >
                <td className="px-2 py-2">
                  <Link href={`/players/${r.playerId}`} className="hover:text-antler-strong font-medium">
                    {r.player.name}
                  </Link>
                  <span className="text-muted ml-1 text-xs hide-xs">{r.player.mlbTeam}</span>
                  {movedTo && (
                    <span className="text-muted ml-1 text-xs">
                      · now with{" "}
                      <Link href={`/teams/${movedTo.id}`} className="hover:text-antler-strong">
                        {movedTo.name}
                      </Link>
                    </span>
                  )}
                  {r.status === "DROPPED" && <span className="text-muted ml-1 text-xs">· dropped</span>}
                </td>
                {showTeam && (
                  <td className="px-2 py-2 hide-xs">
                    <Link href={`/teams/${keptBy.id}`} className="hover:text-antler-strong text-muted">
                      {keptBy.name}
                    </Link>
                  </td>
                )}
                <td className="px-2 py-2 tabular" title={r.commissionerOverride ? "Recorded by the commissioner; differs from the ladder" : undefined}>
                  {formatCost(r.keeperCost)}
                  {r.commissionerOverride && <span className="text-muted text-xs ml-0.5">*</span>}
                </td>
                <td className="px-2 py-2">
                  <KeeperYearBadge keeperYear={r.keeperYear} status={r.status} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
