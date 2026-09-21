import { prisma } from "@/lib/db";
import { CURRENT_SEASON_YEAR } from "@/lib/config";
import { CardLink } from "@/components/ui/Card";
import { PageHeader } from "@/components/ui/PageHeader";

export const dynamic = "force-dynamic";

export default async function TeamsPage() {
  const teams = await prisma.team.findMany({
    include: {
      manager: true,
      standings: { where: { season: { year: CURRENT_SEASON_YEAR } } },
      keeperRecords: { where: { seasonYear: CURRENT_SEASON_YEAR } },
    },
    orderBy: { name: "asc" },
  });

  const byRank = [...teams].sort((a, b) => {
    const ra = a.standings[0]?.rank ?? 999;
    const rb = b.standings[0]?.rank ?? 999;
    return ra - rb;
  });

  return (
    <div className="space-y-4">
      <PageHeader title="Teams" subtitle="Every roster in the Claw & Antler League." />
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {byRank.map((team) => {
          const standing = team.standings[0];
          return (
            <CardLink key={team.id} href={`/teams/${team.id}`}>
              <div className="flex items-center justify-between">
                <div>
                  <p className="font-display text-lg">{team.name}</p>
                  <p className="text-sm text-muted">{team.manager.name}</p>
                </div>
                <div className="text-right text-sm">
                  {standing ? (
                    <p className="tabular">
                      {standing.wins}-{standing.losses}
                      {standing.ties ? `-${standing.ties}` : ""}
                    </p>
                  ) : (
                    <p className="text-muted text-xs">No record yet</p>
                  )}
                  <p className="text-xs text-muted">{team.keeperRecords.length} rostered</p>
                </div>
              </div>
            </CardLink>
          );
        })}
      </div>
    </div>
  );
}
