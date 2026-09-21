"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function DpudResolveForm({
  betId,
  participants,
}: {
  betId: string;
  participants: { id: string; managerName: string }[];
}) {
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState("");
  const [winnerParticipantId, setWinnerParticipantId] = useState("");
  const [busy, setBusy] = useState(false);
  const router = useRouter();

  async function resolve() {
    setBusy(true);
    await fetch(`/api/dpud/${betId}/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ result, winnerParticipantId: winnerParticipantId || undefined }),
    });
    setBusy(false);
    setOpen(false);
    router.refresh();
  }

  async function cancel() {
    setBusy(true);
    await fetch(`/api/dpud/${betId}/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cancel: true }),
    });
    setBusy(false);
    router.refresh();
  }

  if (!open) {
    return (
      <div className="flex gap-2">
        <button onClick={() => setOpen(true)} className="rounded-md border border-border px-2.5 py-1 text-xs hover:border-antler-dim">
          Resolve
        </button>
        <button onClick={cancel} className="rounded-md border border-border px-2.5 py-1 text-xs text-muted hover:text-foreground">
          Cancel Bet
        </button>
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
        <button disabled={busy} onClick={resolve} className="rounded-md bg-antler px-2.5 py-1 text-xs font-medium text-[#1a1305]">
          Save Result
        </button>
        <button onClick={() => setOpen(false)} className="text-xs text-muted">
          Cancel
        </button>
      </div>
    </div>
  );
}
