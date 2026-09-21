"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function DpudOptInButton({ betId, alreadyIn }: { betId: string; alreadyIn: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  if (alreadyIn) {
    return <span className="text-xs text-green">You&apos;re in</span>;
  }

  return (
    <button
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        await fetch(`/api/dpud/${betId}/opt-in`, { method: "POST" });
        setBusy(false);
        router.refresh();
      }}
      className="rounded-md bg-antler px-2.5 py-1 text-xs font-medium text-[#1a1305] hover:bg-antler-strong disabled:opacity-50"
    >
      {busy ? "Opting in…" : "Opt In"}
    </button>
  );
}
