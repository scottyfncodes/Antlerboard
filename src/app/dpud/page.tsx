import { prisma } from "@/lib/db";
import type { Prisma } from "@prisma/client";
import { getCurrentManager } from "@/lib/current-manager";
import { PageHeader } from "@/components/ui/PageHeader";
import { Card, EmptyState } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { CreateDpudForm } from "@/components/dpud/CreateDpudForm";
import { DpudOptInButton } from "@/components/dpud/DpudOptInButton";
import { DpudResolveForm } from "@/components/dpud/DpudResolveForm";
import { formatDate } from "@/lib/format";
import Link from "next/link";

export const dynamic = "force-dynamic";

export default async function DpudPage() {
  const manager = await getCurrentManager();
  const bets = await prisma.dpudBet.findMany({
    orderBy: { createdAt: "desc" },
    include: {
      creator: true,
      players: { include: { player: true } },
      participants: { include: { manager: true } },
    },
  });

  const open = bets.filter((b) => b.status === "OPEN");
  const active = bets.filter((b) => b.status === "ACTIVE");
  const complete = bets.filter((b) => b.status === "COMPLETE" || b.status === "CANCELLED");

  return (
    <div className="space-y-8">
      <PageHeader
        title="DPUD"
        subtitle="Dumb Prop, Ultimate Deal — the league's own prop-bet marketplace. Not a sportsbook, just C&A being C&A."
        actions={<CreateDpudForm />}
      />

      <BetSection title="Active" bets={active} manager={manager} />
      <BetSection title="Open — Needs Opt-Ins" bets={open} manager={manager} />
      <BetSection title="Completed & Cancelled" bets={complete} manager={manager} isHistory />
    </div>
  );
}

type BetWithRelations = Prisma.DpudBetGetPayload<{
  include: {
    creator: true;
    players: { include: { player: true } };
    participants: { include: { manager: true } };
  };
}>;

function BetSection({
  title,
  bets,
  manager,
  isHistory,
}: {
  title: string;
  bets: BetWithRelations[];
  manager: { id: string; isCommissioner: boolean } | null | undefined;
  isHistory?: boolean;
}) {
  return (
    <section>
      <h2 className="font-display text-lg mb-3">{title}</h2>
      {bets.length === 0 ? (
        <EmptyState title="Nothing here yet" />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {bets.map((bet) => {
            const alreadyIn = !!manager && bet.participants.some((p) => p.managerId === manager.id);
            const canManage = !!manager && (manager.id === bet.creatorId || manager.isCommissioner);
            return (
              <Card key={bet.id}>
                <div className="flex items-start justify-between gap-2">
                  <p className="font-medium">{bet.title}</p>
                  <Badge variant={bet.status === "COMPLETE" ? "green" : bet.status === "CANCELLED" ? "default" : bet.status === "ACTIVE" ? "blue" : "default"}>
                    {bet.status}
                  </Badge>
                </div>
                <p className="text-sm text-muted mt-1">{bet.description}</p>
                <p className="text-xs text-muted mt-1">{bet.statCondition}</p>
                {bet.players.length > 0 && (
                  <p className="text-xs text-antler-strong mt-1">
                    {bet.players.map((p) => (
                      <Link key={p.id} href={`/players/${p.playerId}`} className="hover:underline mr-2">
                        {p.player.name}
                      </Link>
                    ))}
                  </p>
                )}
                <p className="text-xs text-muted mt-2">
                  {formatDate(bet.startDate)} &rarr; {formatDate(bet.endDate)} · by {bet.creator.name}
                </p>
                {bet.stakes && <p className="text-xs text-muted mt-1">Stakes: {bet.stakes}</p>}
                <p className="text-xs text-muted mt-1">{bet.participants.length} participant(s)</p>
                {bet.result && <p className="text-sm mt-2 text-antler-strong">{bet.result}</p>}

                {!isHistory && (
                  <div className="mt-3 flex items-center justify-between">
                    <DpudOptInButton betId={bet.id} alreadyIn={alreadyIn} />
                    {canManage && (
                      <DpudResolveForm
                        betId={bet.id}
                        participants={bet.participants.map((p) => ({ id: p.id, managerName: p.manager.name }))}
                      />
                    )}
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      )}
    </section>
  );
}
