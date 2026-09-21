import { prisma } from "@/lib/db";
import { CURRENT_SEASON_YEAR } from "@/lib/config";
import { PageHeader } from "@/components/ui/PageHeader";
import { ProposeTradeForm } from "@/components/trades/ProposeTradeForm";
import { getCurrentManager } from "@/lib/current-manager";

export const dynamic = "force-dynamic";

export default async function NewTradePage() {
  const manager = await getCurrentManager();
  const teams = await prisma.team.findMany({
    orderBy: { name: "asc" },
    include: {
      keeperRecords: {
        where: { seasonYear: CURRENT_SEASON_YEAR },
        include: { player: true },
      },
    },
  });

  const teamOptions = teams.map((t) => ({
    id: t.id,
    name: t.name,
    roster: t.keeperRecords.map((r) => ({ id: r.player.id, name: r.player.name, mlbTeam: r.player.mlbTeam })),
  }));

  return (
    <div className="space-y-4 max-w-2xl">
      <PageHeader title="Propose a Trade" subtitle="Antlerboard records the C&A-side agreement. You'll still need to make the moves in Yahoo." />
      <ProposeTradeForm teams={teamOptions} defaultTeamId={manager?.teams?.[0]?.id} />
    </div>
  );
}
