"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { sendJson } from "@/lib/call-api";

// Taller on touch screens so the buttons are comfortable to tap on a phone.
const TAP = "pointer-coarse:min-h-10 pointer-coarse:px-3";

export function OfferActions({ offerId, canRespond, canWithdraw }: { offerId: string; canRespond: boolean; canWithdraw: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function act(action: string) {
    setBusy(true);
    setError(null);
    const res = await sendJson(`/api/offers/${offerId}/action`, { action });
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    router.refresh();
  }

  return (
    <div className="space-y-1">
      <div className="flex gap-2">
        {canRespond && (
          <>
            <button
              disabled={busy}
              onClick={() => act("accept")}
              className={`rounded-md bg-green/20 border border-green/40 text-green px-2.5 py-1 text-xs font-medium hover:bg-green/30 disabled:opacity-50 ${TAP}`}
            >
              Accept
            </button>
            <button
              disabled={busy}
              onClick={() => act("reject")}
              className={`rounded-md bg-red/10 border border-red/30 text-red px-2.5 py-1 text-xs hover:bg-red/20 disabled:opacity-50 ${TAP}`}
            >
              Reject
            </button>
          </>
        )}
        {canWithdraw && (
          <button
            disabled={busy}
            onClick={() => act("withdraw")}
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
