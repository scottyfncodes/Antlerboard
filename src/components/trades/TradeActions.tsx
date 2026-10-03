"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

export function TradeActions({
  tradeId,
  canAccept,
  canReject,
  canCounter,
  canWithdraw,
}: {
  tradeId: string;
  canAccept: boolean;
  canReject: boolean;
  canCounter: boolean;
  canWithdraw: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function act(action: "accept" | "reject" | "withdraw") {
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/trades/${tradeId}/action`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    });
    setBusy(false);
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setError(data.error ?? "Something went wrong.");
    }
    router.refresh();
  }

  if (!canAccept && !canReject && !canCounter && !canWithdraw) return null;

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex flex-wrap justify-end gap-2">
        {canAccept && (
          <button
            disabled={busy}
            onClick={() => act("accept")}
            className="rounded-md bg-green/20 border border-green/40 text-green px-2.5 py-1 text-xs font-medium hover:bg-green/30"
          >
            Accept
          </button>
        )}
        {canCounter && (
          <Link
            href={`/trades/new?counter=${tradeId}`}
            className="rounded-md border border-border px-2.5 py-1 text-xs hover:border-antler-dim"
          >
            Counter
          </Link>
        )}
        {canReject && (
          <button
            disabled={busy}
            onClick={() => act("reject")}
            className="rounded-md bg-red/10 border border-red/30 text-red px-2.5 py-1 text-xs hover:bg-red/20"
          >
            Reject
          </button>
        )}
        {canWithdraw && (
          <button
            disabled={busy}
            onClick={() => act("withdraw")}
            className="rounded-md border border-border px-2.5 py-1 text-xs text-muted hover:text-foreground"
          >
            Withdraw
          </button>
        )}
      </div>
      {error && <p className="text-xs text-red">{error}</p>}
    </div>
  );
}
