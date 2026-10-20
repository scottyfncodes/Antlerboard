"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { sendJson } from "@/lib/call-api";

export function FypdSelectionControls({
  draftId,
  selectionId,
  isDpud,
  callUpExercised,
}: {
  draftId: string;
  selectionId: string;
  isDpud: boolean;
  callUpExercised: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function act(body: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    const res = await sendJson(`/api/fypd/${draftId}/action`, body);
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    router.refresh();
  }

  if (callUpExercised) {
    return <span className="text-xs text-muted">Called up</span>;
  }

  // pointer-coarse: taller hit area on touch screens without changing the desktop look.
  return (
    <div className="space-y-1">
      <div className="flex gap-2">
        <button
          onClick={() => act({ action: "dpud", selectionId, isDpud: !isDpud })}
          disabled={busy}
          className="text-xs text-antler hover:text-antler-strong disabled:opacity-50 pointer-coarse:min-h-10 pointer-coarse:px-2"
        >
          {isDpud ? "Clear DPUD" : "Mark DPUD"}
        </button>
        <button
          onClick={() => act({ action: "callup", selectionId })}
          disabled={busy}
          className="text-xs text-muted hover:text-foreground disabled:opacity-50 pointer-coarse:min-h-10 pointer-coarse:px-2"
        >
          Mark Called Up
        </button>
      </div>
      {error && <p className="text-xs text-red">{error}</p>}
    </div>
  );
}
