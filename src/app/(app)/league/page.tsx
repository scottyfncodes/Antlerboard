import Link from "next/link";
import { prisma } from "@/lib/db";
import { CURRENT_SEASON_YEAR } from "@/lib/config";
import { getCurrentManager } from "@/lib/current-manager";
import { LeagueHeader } from "@/components/league/LeagueHeader";
import { EmptyState } from "@/components/ui/Card";
import { Avatar } from "@/components/ui/Avatar";
import clsx from "clsx";

export const dynamic = "force-dynamic";

export default async function StandingsPage() {
  const [manager, standings] = await Promise.all([
    getCurrentManager(),
    prisma.teamStanding.findMany({
      where: { season: { year: CURRENT_SEASON_YEAR } },
      orderBy: [{ rank: "asc" }, { wins: "desc" }],
      include: { team: { include: { manager: true } } },
    }),
  ]);
  const myTeamIds = new Set(manager?.teams?.map((t) => t.id) ?? []);

  return (
    <div className="space-y-4">
      <LeagueHeader active="standings" />
      {standings.length === 0 ? (
        <EmptyState
          title="No standings yet"
          subtitle="Standings fill in from Yahoo once the season is underway and the league is connected."
        />
      ) : (
        <div className="rounded-xl border border-border bg-surface overflow-hidden">
          <table className="w-full table-fixed text-sm">
            <thead>
              <tr className="bg-surface-raised text-[11px] font-semibold uppercase tracking-wider text-muted">
                <th className="w-9 pl-3 py-2 text-left">#</th>
                <th className="px-1 py-2 text-left">Team</th>
                <th className="w-[4.75rem] px-1 py-2 text-right">W-L-T</th>
                <th className="w-12 pr-3 py-2 text-right">GB</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {standings.map((s, i) => {
                const mine = myTeamIds.has(s.teamId);
                return (
                  <tr key={s.id} className={clsx(mine && "bg-antler-dim/15")}>
                    <td className="pl-3 py-2.5 tabular text-muted">{s.rank ?? i + 1}</td>
                    <td className="px-1 py-2.5">
                      <Link href={`/teams/${s.teamId}`} className="flex items-center gap-2.5 min-w-0">
                        <Avatar name={s.team.name} imageUrl={s.team.logoUrl} shape="rounded" />
                        <span className="min-w-0">
                          <span className={clsx("block truncate font-semibold", mine && "text-antler-strong")}>{s.team.name}</span>
                          <span className="block truncate text-xs text-muted">{s.team.manager.name}</span>
                        </span>
                      </Link>
                    </td>
                    <td className="px-1 py-2.5 text-right tabular font-semibold whitespace-nowrap">
                      {s.wins}-{s.losses}-{s.ties}
                    </td>
                    <td className="pr-3 py-2.5 text-right tabular text-muted">{s.gamesBack ? s.gamesBack : "—"}</td>
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
