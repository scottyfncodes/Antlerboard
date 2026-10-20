"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { sendJson } from "@/lib/call-api";

type ConfirmableAction = "accept" | "reject" | "withdraw";

const CONFIRM_COPY: Record<ConfirmableAction, { prompt: string; label: string }> = {
  accept: { prompt: "Accept this trade?", label: "Yes, accept" },
  reject: { prompt: "Reject this trade?", label: "Yes, reject" },
  withdraw: { prompt: "Withdraw this trade?", label: "Yes, withdraw" },
};

// Taller on touch screens so the buttons are comfortable to tap on a phone.
const TAP = "pointer-coarse:min-h-10 pointer-coarse:px-3";

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
  const [confirming, setConfirming] = useState<ConfirmableAction | null>(null);

  async function act(action: ConfirmableAction) {
    setBusy(true);
    setError(null);
    const res = await sendJson(`/api/trades/${tradeId}/action`, { action });
    setBusy(false);
    setConfirming(null);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    router.refresh();
  }

  if (!canAccept && !canReject && !canCounter && !canWithdraw) return null;

  if (confirming) {
    const copy = CONFIRM_COPY[confirming];
    return (
      <div className="flex flex-col items-end gap-1">
        <div className="flex flex-wrap items-center justify-end gap-2">
          <span className="text-xs">{copy.prompt}</span>
          <button
            disabled={busy}
            onClick={() => act(confirming)}
            className={`rounded-md border px-2.5 py-1 text-xs font-medium disabled:opacity-50 ${TAP} ${
              confirming === "accept"
                ? "bg-green/20 border-green/40 text-green hover:bg-green/30"
                : "bg-red/10 border-red/30 text-red hover:bg-red/20"
            }`}
          >
            {busy ? "Working…" : copy.label}
          </button>
          <button
            disabled={busy}
            onClick={() => setConfirming(null)}
            className={`rounded-md border border-border px-2.5 py-1 text-xs text-muted hover:text-foreground disabled:opacity-50 ${TAP}`}
          >
            No
          </button>
        </div>
        {error && <p className="text-xs text-red">{error}</p>}
      </div>
    );
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex flex-wrap justify-end gap-2">
        {canAccept && (
          <button
            disabled={busy}
            onClick={() => setConfirming("accept")}
            className={`rounded-md bg-green/20 border border-green/40 text-green px-2.5 py-1 text-xs font-medium hover:bg-green/30 disabled:opacity-50 ${TAP}`}
          >
            Accept
          </button>
        )}
        {canCounter && (
          <Link
            href={`/trades/new?counter=${tradeId}`}
            className={`inline-flex items-center rounded-md border border-border px-2.5 py-1 text-xs hover:border-antler-dim ${TAP}`}
          >
            Counter
          </Link>
        )}
        {canReject && (
          <button
            disabled={busy}
            onClick={() => setConfirming("reject")}
            className={`rounded-md bg-red/10 border border-red/30 text-red px-2.5 py-1 text-xs hover:bg-red/20 disabled:opacity-50 ${TAP}`}
          >
            Reject
          </button>
        )}
        {canWithdraw && (
          <button
            disabled={busy}
            onClick={() => setConfirming("withdraw")}
            className={`rounded-md border border-border px-2.5 py-1 text-xs text-muted hover:text-foreground disabled:opacity-50 ${TAP}`}
          >
            Withdraw
          </button>
        )}
      </div>
      {error && <p className="text-xs text-red">{error}</p>}
    </div>
  );
}
