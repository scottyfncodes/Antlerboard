import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { prisma } from "@/lib/db";
import { CURRENT_SEASON_YEAR } from "@/lib/config";
import { getCurrentManager } from "@/lib/current-manager";
import { LeagueHeader } from "@/components/league/LeagueHeader";
import { Avatar } from "@/components/ui/Avatar";
import { ordinal } from "@/lib/positions";
import clsx from "clsx";

export const dynamic = "force-dynamic";

export default async function TeamsPage() {
  const [manager, teams] = await Promise.all([
    getCurrentManager(),
    prisma.team.findMany({
      include: {
        manager: true,
        standings: { where: { season: { year: CURRENT_SEASON_YEAR } } },
        keeperRecords: { where: { seasonYear: CURRENT_SEASON_YEAR }, select: { keeperYear: true } },
      },
      orderBy: { name: "asc" },
    }),
  ]);
  const myTeamIds = new Set(manager?.teams?.map((t) => t.id) ?? []);

  const byRank = [...teams].sort((a, b) => (a.standings[0]?.rank ?? 999) - (b.standings[0]?.rank ?? 999));

  return (
    <div className="space-y-4">
      <LeagueHeader active="teams" />
      <ul className="rounded-xl border border-border bg-surface divide-y divide-border overflow-hidden">
        {byRank.map((team) => {
          const standing = team.standings[0];
          const keepers = team.keeperRecords.filter((r) => r.keeperYear >= 1).length;
          const mine = myTeamIds.has(team.id);
          return (
            <li key={team.id}>
              <Link
                href={`/teams/${team.id}`}
                className={clsx("flex items-center gap-3 px-3 py-3 hover:bg-surface-raised", mine && "bg-antler-dim/15")}
              >
                <Avatar name={team.name} imageUrl={team.logoUrl} size="md" shape="rounded" />
                <div className="min-w-0 flex-1">
                  <p className={clsx("truncate font-semibold", mine && "text-antler-strong")}>{team.name}</p>
                  <p className="truncate text-xs text-muted">
                    {team.manager.name} · {keepers}/10 keepers
                  </p>
                </div>
                <div className="shrink-0 text-right">
                  {standing ? (
                    <>
                      <p className="text-sm font-semibold tabular">
                        {standing.wins}-{standing.losses}
                        {standing.ties ? `-${standing.ties}` : ""}
                      </p>
                      {standing.rank && <p className="text-xs text-muted">{ordinal(standing.rank)}</p>}
                    </>
                  ) : (
                    <p className="text-xs text-muted">No record</p>
                  )}
                </div>
                <ChevronRight className="h-4 w-4 shrink-0 text-muted" />
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
