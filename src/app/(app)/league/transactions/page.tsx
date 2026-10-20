import Link from "next/link";
import { ArrowLeftRight, CircleHelp, Gavel, LogOut, Minus, Plus, ShieldCheck, Wrench } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { prisma } from "@/lib/db";
import { LeagueHeader } from "@/components/league/LeagueHeader";
import { EmptyState } from "@/components/ui/Card";
import { formatDate, timeAgo } from "@/lib/format";
import { describeTransaction, INCOMPLETE_TRANSACTION_WHERE } from "@/lib/transaction-display";

export const dynamic = "force-dynamic";

const ICONS: Record<string, { icon: LucideIcon; tone: string }> = {
  DRAFT: { icon: Gavel, tone: "text-antler-strong bg-antler-dim/30" },
  WAIVER_ADD: { icon: Plus, tone: "text-green bg-green/15" },
  FREE_AGENT_ADD: { icon: Plus, tone: "text-green bg-green/15" },
  DROP: { icon: Minus, tone: "text-red bg-red/15" },
  TRADE: { icon: ArrowLeftRight, tone: "text-blue bg-blue/15" },
  KEEPER_DECLARED: { icon: ShieldCheck, tone: "text-antler-strong bg-antler-dim/30" },
  COMMISSIONER_CORRECTION: { icon: Wrench, tone: "text-muted bg-surface-raised" },
  RELEASE: { icon: LogOut, tone: "text-muted bg-surface-raised" },
  INCOMPLETE: { icon: CircleHelp, tone: "text-muted bg-surface-raised" },
};

/** How many rows the log shows at first, and how many more "Show more" adds. */
const PAGE_SIZE = 75;

/** Yahoo-style league transaction log: newest first, icon per move type. */
export default async function TransactionsPage({ searchParams }: { searchParams?: Promise<{ limit?: string }> }) {
  const requested = Number((await searchParams)?.limit);
  const limit = Number.isInteger(requested) && requested > PAGE_SIZE ? requested : PAGE_SIZE;
  const [transactions, teams, incompleteTotal, total] = await Promise.all([
    prisma.transaction.findMany({
      orderBy: { date: "desc" },
      take: limit,
      include: { players: { include: { player: true } }, teams: true },
    }),
    prisma.team.findMany({ select: { id: true, name: true } }),
    prisma.transaction.count({ where: INCOMPLETE_TRANSACTION_WHERE }),
    prisma.transaction.count(),
  ]);
  const teamName = new Map(teams.map((t) => [t.id, t.name]));
  const described = transactions.map((t) => ({ t, d: describeTransaction(t, teamName) }));
  const incompleteShown = described.filter(({ d }) => !d.complete).length;

  return (
    <div className="space-y-4">
      <LeagueHeader active="transactions" />
      {incompleteTotal > 0 && (
        <p role="status" className="rounded-xl border border-border bg-surface-raised px-3 py-2.5 text-xs text-muted">
          {incompleteShown > 0 ? `${incompleteShown} of the ${transactions.length} transactions below` : `${incompleteTotal} league transaction${incompleteTotal === 1 ? "" : "s"}`} came
          from Yahoo without full team and player details ({incompleteTotal} in all). They&apos;re listed as incomplete until the commissioner recovers them from
          Yahoo - treat them as unconfirmed.
        </p>
      )}
      {transactions.length === 0 ? (
        <EmptyState title="No transactions yet" subtitle="Adds, drops and trades show up here as they sync from Yahoo." />
      ) : (
        <ul className="rounded-xl border border-border bg-surface divide-y divide-border overflow-hidden">
          {described.map(({ t, d }) => {
            const meta = ICONS[d.iconKey] ?? ICONS.COMMISSIONER_CORRECTION;
            return (
              <li key={t.id} className="flex items-start gap-3 px-3 py-3" data-complete={d.complete}>
                <span className={`mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${meta.tone}`}>
                  <meta.icon className="h-4 w-4" strokeWidth={2.5} />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm">
                    <span className="font-semibold">{d.label}</span>
                    {!d.complete && <span className="ml-1.5 rounded bg-surface-raised px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted">Incomplete</span>}
                    {d.moves.length > 0 && <span className="text-muted"> · </span>}
                    {d.moves.map((m, i) => (
                      <span key={m.playerId}>
                        {i > 0 && ", "}
                        {m.verb && (d.moves.length > 1 || m.verb === "Traded") && <span className="text-muted">{m.verb.toLowerCase()} </span>}
                        <Link href={`/players/${m.playerId}`} className="hover:text-antler-strong">
                          {m.name}
                        </Link>
                        {d.moves.length > 1 && m.teamName && <span className="text-muted"> ({m.teamName})</span>}
                      </span>
                    ))}
                  </p>
                  {(d.teamNames.length > 0 || d.notes.length > 0) && (
                    <p className="mt-0.5 text-xs text-muted">{[d.teamNames.join(" ↔ "), ...d.notes].filter(Boolean).join(" · ")}</p>
                  )}
                </div>
                <time className="shrink-0 text-xs text-muted" title={t.dateUnavailable ? "Date unavailable from Yahoo" : formatDate(t.date)}>
                  {t.dateUnavailable ? "date unknown" : timeAgo(t.date)}
                </time>
              </li>
            );
          })}
        </ul>
      )}
      {transactions.length > 0 && (
        <div className="flex items-center justify-between gap-3 text-xs text-muted">
          <p>
            Showing {transactions.length} of {total}
          </p>
          {transactions.length < total && (
            <Link href={`/league/transactions?limit=${limit + PAGE_SIZE}`} scroll={false} className="font-semibold text-antler hover:text-antler-strong">
              Show more
            </Link>
          )}
        </div>
      )}
    </div>
  );
}
