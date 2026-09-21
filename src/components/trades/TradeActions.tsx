"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function TradeActions({
  tradeId,
  canRespond,
  canWithdraw,
}: {
  tradeId: string;
  canRespond: boolean;
  canWithdraw: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function act(action: string) {
    setBusy(true);
    await fetch(`/api/trades/${tradeId}/action`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    });
    setBusy(false);
    router.refresh();
  }

  return (
    <div className="flex gap-2">
      {canRespond && (
        <>
          <button
            disabled={busy}
            onClick={() => act("accept")}
            className="rounded-md bg-green/20 border border-green/40 text-green px-2.5 py-1 text-xs font-medium hover:bg-green/30"
          >
            Accept
          </button>
          <button
            disabled={busy}
            onClick={() => act("counter")}
            className="rounded-md border border-border px-2.5 py-1 text-xs hover:border-antler-dim"
          >
            Counter
          </button>
          <button
            disabled={busy}
            onClick={() => act("reject")}
            className="rounded-md bg-red/10 border border-red/30 text-red px-2.5 py-1 text-xs hover:bg-red/20"
          >
            Reject
          </button>
        </>
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
  );
}
