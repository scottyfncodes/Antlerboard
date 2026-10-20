"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { sendJson } from "@/lib/call-api";

// Taller on touch screens so the buttons are comfortable to tap on a phone.
const TAP = "pointer-coarse:min-h-10 pointer-coarse:px-3";

export function DpudResolveForm({
  betId,
  participants,
}: {
  betId: string;
  participants: { id: string; managerName: string }[];
}) {
  const [open, setOpen] = useState(false);
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const [result, setResult] = useState("");
  const [winnerParticipantId, setWinnerParticipantId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  async function resolve() {
    setBusy(true);
    setError(null);
    const res = await sendJson(`/api/dpud/${betId}/resolve`, {
      result,
      winnerParticipantId: winnerParticipantId || undefined,
    });
    setBusy(false);
    if (!res.ok) {
      // Keep the form open with what they typed so they can fix and retry.
      setError(res.error);
      return;
    }
    setOpen(false);
    router.refresh();
  }

  async function cancel() {
    setBusy(true);
    setError(null);
    const res = await sendJson(`/api/dpud/${betId}/resolve`, { cancel: true });
    setBusy(false);
    setConfirmingCancel(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    router.refresh();
  }

  if (!open && confirmingCancel) {
    return (
      <div className="space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs">Cancel this bet for everyone?</span>
          <button
            disabled={busy}
            onClick={cancel}
            className={`rounded-md bg-red/10 border border-red/30 text-red px-2.5 py-1 text-xs font-medium hover:bg-red/20 disabled:opacity-50 ${TAP}`}
          >
            {busy ? "Cancelling…" : "Yes, cancel bet"}
          </button>
          <button
            disabled={busy}
            onClick={() => setConfirmingCancel(false)}
            className={`rounded-md border border-border px-2.5 py-1 text-xs text-muted hover:text-foreground disabled:opacity-50 ${TAP}`}
          >
            No, keep it
          </button>
        </div>
        {error && <p className="text-xs text-red">{error}</p>}
      </div>
    );
  }

  if (!open) {
    return (
      <div className="space-y-1">
        <div className="flex gap-2">
          <button
            onClick={() => {
              setError(null);
              setOpen(true);
            }}
            className={`rounded-md border border-border px-2.5 py-1 text-xs hover:border-antler-dim ${TAP}`}
          >
            Resolve
          </button>
          <button
            onClick={() => {
              setError(null);
              setConfirmingCancel(true);
            }}
            className={`rounded-md border border-border px-2.5 py-1 text-xs text-muted hover:text-foreground ${TAP}`}
          >
            Cancel Bet
          </button>
        </div>
        {error && <p className="text-xs text-red">{error}</p>}
      </div>
    );
  }

  return (
    <div className="space-y-2 rounded-md border border-border p-3 bg-surface-raised">
      <textarea
        value={result}
        onChange={(e) => setResult(e.target.value)}
        placeholder="What happened?"
        rows={2}
        className="w-full rounded-md border border-border bg-surface px-2 py-1.5 text-xs"
      />
      <select
        value={winnerParticipantId}
        onChange={(e) => setWinnerParticipantId(e.target.value)}
        className="w-full rounded-md border border-border bg-surface px-2 py-1.5 text-xs"
      >
        <option value="">No winner recorded</option>
        {participants.map((p) => (
          <option key={p.id} value={p.id}>
            {p.managerName}
          </option>
        ))}
      </select>
      <div className="flex gap-2">
        <button
          disabled={busy}
          onClick={resolve}
          className={`rounded-md bg-antler px-2.5 py-1 text-xs font-medium text-[#1a1305] disabled:opacity-50 ${TAP}`}
        >
          {busy ? "Saving…" : "Save Result"}
        </button>
        <button
          disabled={busy}
          onClick={() => {
            setError(null);
            setOpen(false);
          }}
          className={`text-xs text-muted ${TAP}`}
        >
          Cancel
        </button>
      </div>
      {error && <p className="text-xs text-red">{error}</p>}
    </div>
  );
}
