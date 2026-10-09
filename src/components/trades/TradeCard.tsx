import { Check, Clock, X } from "lucide-react";
import clsx from "clsx";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { TradeActions } from "./TradeActions";
import { canPerformTradeAction, isTradeParty, type TradeViewer } from "@/lib/trade-access";
import { timeAgo } from "@/lib/format";

interface CardTrade {
  id: string;
  status: string;
  notes: string | null;
  createdAt: Date;
  proposerId: string;
  proposer: { name: string };
  participants: { teamId: string; isProposer: boolean; response: string; team: { name: string } }[];
  assets: {
    id: string;
    fromTeamId: string;
    toTeamId: string;
    assetType: string;
    draftPickDescription: string | null;
    player: { name: string } | null;
  }[];
}

const RESPONSE_CHIP = {
  ACCEPTED: { icon: Check, label: "Accepted", tone: "text-green border-green/40 bg-green/10" },
  PENDING: { icon: Clock, label: "Waiting", tone: "text-muted border-border bg-surface-raised" },
  REJECTED: { icon: X, label: "Rejected", tone: "text-red border-red/40 bg-red/10" },
} as const;

/**
 * One trade, 2-4 teams: each team's response, then what each team gets.
 * Laid out per receiving team ("Buck Wild gets ...") because that's how
 * managers read a multi-team deal - "A ↔ B" stops making sense at three.
 */
export function TradeCard({ trade, viewer }: { trade: CardTrade; viewer: TradeViewer | null }) {
  const name = new Map(trade.participants.map((p) => [p.teamId, p.team.name]));
  const ordered = [...trade.participants].sort((a, b) => Number(b.isProposer) - Number(a.isProposer));
  const multi = trade.participants.length > 2;
  const open = trade.status === "PROPOSED";

  return (
    <Card className="space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs text-muted">
            {multi && <span className="font-semibold text-antler-strong">{trade.participants.length}-team trade · </span>}
            Proposed by {trade.proposer.name} · {timeAgo(trade.createdAt)}
          </p>
        </div>
        <Badge variant={trade.status === "ACCEPTED" ? "green" : trade.status === "REJECTED" ? "red" : "default"}>{trade.status}</Badge>
      </div>

      <ul className="space-y-2">
        {ordered.map((p) => {
          const incoming = trade.assets.filter((a) => a.toTeamId === p.teamId);
          const chip = RESPONSE_CHIP[p.response as keyof typeof RESPONSE_CHIP] ?? RESPONSE_CHIP.PENDING;
          return (
            <li key={p.teamId} className="rounded-lg border border-border bg-surface-raised/50 px-3 py-2">
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-sm font-semibold">{p.team.name}</span>
                {open && (
                  <span className={clsx("inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium", chip.tone)}>
                    <chip.icon className="h-3 w-3" strokeWidth={3} />
                    {p.isProposer ? "Proposed" : chip.label}
                  </span>
                )}
              </div>
              <p className="mt-0.5 text-sm text-muted">
                {incoming.length === 0 ? (
                  "Gets nothing"
                ) : (
                  <>
                    Gets{" "}
                    {incoming.map((a, i) => (
                      <span key={a.id}>
                        {i > 0 && ", "}
                        <span className="text-foreground">{a.player?.name ?? a.draftPickDescription}</span>
                        {multi && <span> (from {name.get(a.fromTeamId)})</span>}
                      </span>
                    ))}
                  </>
                )}
              </p>
            </li>
          );
        })}
      </ul>

      {trade.notes && isTradeParty(trade, viewer) && <p className="text-sm text-muted italic">&ldquo;{trade.notes}&rdquo;</p>}

      {open && (
        <TradeActions
          tradeId={trade.id}
          canAccept={canPerformTradeAction(trade, viewer, "accept")}
          canReject={canPerformTradeAction(trade, viewer, "reject")}
          canCounter={canPerformTradeAction(trade, viewer, "counter")}
          canWithdraw={canPerformTradeAction(trade, viewer, "withdraw")}
        />
      )}
    </Card>
  );
}
