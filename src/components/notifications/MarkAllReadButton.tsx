"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { sendJson } from "@/lib/call-api";

export function MarkAllReadButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="space-y-1">
      <button
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError(null);
          const res = await sendJson("/api/notifications", { markAllRead: true });
          setBusy(false);
          if (!res.ok) {
            setError(res.error);
            return;
          }
          router.refresh();
        }}
        className="rounded-md border border-border px-3 py-1.5 text-sm text-muted hover:text-foreground hover:border-antler-dim disabled:opacity-50"
      >
        Mark all read
      </button>
      {error && <p className="text-xs text-red">{error}</p>}
    </div>
  );
}
