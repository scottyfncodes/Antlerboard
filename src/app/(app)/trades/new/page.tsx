import { prisma } from "@/lib/db";
import { CURRENT_SEASON_YEAR } from "@/lib/config";
import { PageHeader } from "@/components/ui/PageHeader";
import { EmptyState } from "@/components/ui/Card";
import { ProposeTradeForm, type TradeDraft } from "@/components/trades/ProposeTradeForm";
import { getCurrentManager } from "@/lib/current-manager";
import { resolveTradeAction } from "@/lib/trade-access";
import type { TradeAssetInput } from "@/lib/trade-proposal";

export const dynamic = "force-dynamic";

export default async function NewTradePage({ searchParams }: { searchParams: Promise<{ counter?: string }> }) {
  const [manager, sp] = await Promise.all([getCurrentManager(), searchParams]);
  const ownTeamIds = manager?.teams.map((t) => t.id) ?? [];
  if (!manager || ownTeamIds.length === 0) {
    return (
      <div className="space-y-4 max-w-2xl">
        <PageHeader title="Propose a Trade" />
        <EmptyState title="You don't have a team to trade from" subtitle="Trades are proposed between your team and other managers'." />
      </div>
    );
  }

  // ?counter=<id> pre-fills the form from a trade you're allowed to counter.
  // Anything else (not yours, already closed) quietly falls back to a blank form.
  let initial: TradeDraft | undefined;
  let counterOfTradeId: string | undefined;
  let counterTeamId: string | undefined;
  if (sp.counter) {
    const original = await prisma.trade.findUnique({ where: { id: sp.counter }, include: { participants: true, assets: true } });
    const access = original ? resolveTradeAction(original, manager, "counter") : null;
    if (original && access && !access.denial) {
      counterOfTradeId = original.id;
      counterTeamId = access.teamId;
      initial = {
        teamIds: [access.teamId, ...original.participants.map((p) => p.teamId).filter((id) => id !== access.teamId)],
        assets: original.assets.map(
          (a): TradeAssetInput => ({
            fromTeamId: a.fromTeamId,
            toTeamId: a.toTeamId,
            assetType: a.assetType,
            playerId: a.playerId ?? undefined,
            draftPickDescription: a.draftPickDescription ?? undefined,
          })
        ),
      };
    }
  }

  const teams = await prisma.team.findMany({
    where: { active: true },
    orderBy: { name: "asc" },
    include: {
      keeperRecords: {
        where: { seasonYear: CURRENT_SEASON_YEAR, status: { not: "DROPPED" } },
        include: { player: true },
        orderBy: { player: { name: "asc" } },
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
      <PageHeader
        title={counterOfTradeId ? "Counter-Offer" : "Propose a Trade"}
        subtitle={
          counterOfTradeId
            ? "Adjust the deal and send it back. The original proposal is closed once your counter goes out."
            : "Trade with one team, or add up to three for a multi-team deal. You'll still make the moves in Yahoo."
        }
      />
      <ProposeTradeForm
        teams={teamOptions}
        ownTeamIds={counterTeamId ? [counterTeamId] : ownTeamIds}
        defaultTeamId={ownTeamIds[0]}
        initial={initial}
        counterOfTradeId={counterOfTradeId}
      />
    </div>
  );
}
