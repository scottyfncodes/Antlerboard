"use client";

import { useRouter } from "next/navigation";

export function MarkAllReadButton() {
  const router = useRouter();
  return (
    <button
      onClick={async () => {
        await fetch("/api/notifications", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ markAllRead: true }),
        });
        router.refresh();
      }}
      className="rounded-md border border-border px-3 py-1.5 text-sm text-muted hover:text-foreground hover:border-antler-dim"
    >
      Mark all read
    </button>
  );
}
