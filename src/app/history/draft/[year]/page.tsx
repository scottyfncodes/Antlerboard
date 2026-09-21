import { prisma } from "@/lib/db";
import { PageHeader } from "@/components/ui/PageHeader";
import { EmptyState } from "@/components/ui/Card";
import { DraftColorBadge } from "@/components/ui/Badge";
import { getDraftColor } from "@/lib/draft-color-engine";
import { formatCost } from "@/lib/format";
import Link from "next/link";

export const dynamic = "force-dynamic";

export default async function DraftBoardPage({ params }: { params: Promise<{ year: string }> }) {
  const { year: yearParam } = await params;
  const year = Number(yearParam);
  const colorResult = getDraftColor(year);

  const picks = await prisma.draftPick.findMany({
    where: { seasonYear: year },
    orderBy: { overallPick: "asc" },
    include: { team: true, player: true },
  });

  return (
    <div className="space-y-4">
      <PageHeader
        title={`${year} Draft Board`}
        subtitle={colorResult.skipped ? "Draft color cycle skipped this season." : undefined}
        actions={<DraftColorBadge color={colorResult.color} />}
      />
      <div className="flex gap-2 text-sm">
        <Link href={`/history/draft/${year - 1}`} className="text-antler hover:text-antler-strong">
          &larr; {year - 1}
        </Link>
        <Link href="/history" className="text-muted hover:text-foreground">
          All Seasons
        </Link>
        <Link href={`/history/draft/${year + 1}`} className="text-antler hover:text-antler-strong">
          {year + 1} &rarr;
        </Link>
      </div>

      {picks.length === 0 ? (
        <EmptyState title="No draft picks recorded for this season" />
      ) : (
        <div className="rounded-xl border border-border overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-surface-raised text-left text-xs text-muted">
                <th className="px-2 py-2 font-medium">Pick</th>
                <th className="px-2 py-2 font-medium hide-xs">Team</th>
                <th className="px-2 py-2 font-medium">Player</th>
                <th className="px-2 py-2 font-medium">Cost</th>
              </tr>
            </thead>
            <tbody>
              {picks.map((p) => (
                <tr key={p.id} className="border-t border-border">
                  <td className="px-2 py-2 tabular text-muted">
                    {p.round}.{String(p.pick).padStart(2, "0")}
                    <span className="text-xs hide-xs"> (#{p.overallPick})</span>
                  </td>
                  <td className="px-2 py-2 hide-xs">
                    <Link href={`/teams/${p.teamId}`} className="hover:text-antler-strong">
                      {p.team.name}
                    </Link>
                  </td>
                  <td className="px-2 py-2">
                    {p.player ? (
                      <Link href={`/players/${p.playerId}`} className="hover:text-antler-strong">
                        {p.player.name}
                      </Link>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="px-2 py-2 tabular">{formatCost(p.cost)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
