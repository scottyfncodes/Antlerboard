"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

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

  async function act(body: Record<string, unknown>) {
    setBusy(true);
    await fetch(`/api/fypd/${draftId}/action`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    setBusy(false);
    router.refresh();
  }

  if (callUpExercised) {
    return <span className="text-xs text-muted">Called up</span>;
  }

  return (
    <div className="flex gap-2">
      <button
        onClick={() => act({ action: "dpud", selectionId, isDpud: !isDpud })}
        disabled={busy}
        className="text-xs text-antler hover:text-antler-strong disabled:opacity-50"
      >
        {isDpud ? "Clear DPUD" : "Mark DPUD"}
      </button>
      <button
        onClick={() => act({ action: "callup", selectionId })}
        disabled={busy}
        className="text-xs text-muted hover:text-foreground disabled:opacity-50"
      >
        Mark Called Up
      </button>
    </div>
  );
}
