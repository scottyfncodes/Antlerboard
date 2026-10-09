import Link from "next/link";
import { ArrowLeftRight, Minus, Plus, ShieldCheck, Gavel, Wrench } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { prisma } from "@/lib/db";
import { LeagueHeader } from "@/components/league/LeagueHeader";
import { EmptyState } from "@/components/ui/Card";
import { formatDate, timeAgo } from "@/lib/format";

export const dynamic = "force-dynamic";

const TYPE_META: Record<string, { label: string; icon: LucideIcon; tone: string }> = {
  DRAFT: { label: "Drafted", icon: Gavel, tone: "text-antler-strong bg-antler-dim/30" },
  WAIVER_ADD: { label: "Waiver add", icon: Plus, tone: "text-green bg-green/15" },
  FREE_AGENT_ADD: { label: "Added", icon: Plus, tone: "text-green bg-green/15" },
  DROP: { label: "Dropped", icon: Minus, tone: "text-red bg-red/15" },
  TRADE: { label: "Trade", icon: ArrowLeftRight, tone: "text-blue bg-blue/15" },
  KEEPER_DECLARED: { label: "Kept", icon: ShieldCheck, tone: "text-antler-strong bg-antler-dim/30" },
  COMMISSIONER_CORRECTION: { label: "Correction", icon: Wrench, tone: "text-muted bg-surface-raised" },
};

/** Yahoo-style league transaction log: newest first, icon per move type. */
export default async function TransactionsPage() {
  const [transactions, teams] = await Promise.all([
    prisma.transaction.findMany({
      orderBy: { date: "desc" },
      take: 75,
      include: { players: { include: { player: true } }, teams: true },
    }),
    prisma.team.findMany({ select: { id: true, name: true } }),
  ]);
  const teamName = new Map(teams.map((t) => [t.id, t.name]));

  return (
    <div className="space-y-4">
      <LeagueHeader active="transactions" />
      {transactions.length === 0 ? (
        <EmptyState title="No transactions yet" subtitle="Adds, drops and trades show up here as they sync from Yahoo." />
      ) : (
        <ul className="rounded-xl border border-border bg-surface divide-y divide-border overflow-hidden">
          {transactions.map((t) => {
            const meta = TYPE_META[t.type] ?? TYPE_META.COMMISSIONER_CORRECTION;
            const teamsInvolved = [...new Set(t.teams.map((x) => teamName.get(x.teamId)).filter(Boolean))];
            return (
              <li key={t.id} className="flex items-start gap-3 px-3 py-3">
                <span className={`mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${meta.tone}`}>
                  <meta.icon className="h-4 w-4" strokeWidth={2.5} />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm">
                    <span className="font-semibold">{meta.label}</span>
                    {t.players.length > 0 && <span className="text-muted"> · </span>}
                    {t.players.map((p, i) => (
                      <span key={p.id}>
                        {i > 0 && ", "}
                        <Link href={`/players/${p.playerId}`} className="hover:text-antler-strong">
                          {p.player.name}
                        </Link>
                      </span>
                    ))}
                  </p>
                  {(teamsInvolved.length > 0 || t.notes) && (
                    <p className="mt-0.5 text-xs text-muted truncate">{[teamsInvolved.join(" ↔ "), t.notes].filter(Boolean).join(" · ")}</p>
                  )}
                </div>
                <time className="shrink-0 text-xs text-muted" title={formatDate(t.date)}>
                  {timeAgo(t.date)}
                </time>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
