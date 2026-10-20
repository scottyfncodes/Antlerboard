"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { callApi } from "@/lib/call-api";

export function DpudOptInButton({ betId, alreadyIn }: { betId: string; alreadyIn: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (alreadyIn) {
    return <span className="text-xs text-green">You&apos;re in</span>;
  }

  return (
    <div className="space-y-1">
      <button
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError(null);
          const res = await callApi(`/api/dpud/${betId}/opt-in`, { method: "POST" });
          setBusy(false);
          if (!res.ok) {
            setError(res.error);
            return;
          }
          router.refresh();
        }}
        className="rounded-md bg-antler px-2.5 py-1 text-xs font-medium text-[#1a1305] hover:bg-antler-strong disabled:opacity-50 pointer-coarse:min-h-10 pointer-coarse:px-3"
      >
        {busy ? "Opting in…" : "Opt In"}
      </button>
      {error && <p className="text-xs text-red">{error}</p>}
    </div>
  );
}
