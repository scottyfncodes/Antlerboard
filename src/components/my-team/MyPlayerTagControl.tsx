"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { PLAYER_TAG_LABEL } from "@/lib/format";
import { MANAGER_SELECTABLE_TAGS } from "@/lib/player-tags";

export function MyPlayerTagControl({
  playerId,
  currentTag,
}: {
  playerId: string;
  currentTag: string | null;
}) {
  const [value, setValue] = useState(currentTag ?? "");
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  function apply(next: string) {
    setValue(next);
    startTransition(async () => {
      await fetch("/api/my-team/tags", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ playerId, tag: next || null }),
      });
      router.refresh();
    });
  }

  return (
    <select
      value={value}
      disabled={isPending}
      onChange={(e) => apply(e.target.value)}
      className="rounded-md border border-border bg-surface px-2 py-1 text-xs disabled:opacity-50"
    >
      <option value="">No tag</option>
      {MANAGER_SELECTABLE_TAGS.map((t) => (
        <option key={t} value={t}>
          {PLAYER_TAG_LABEL[t]}
        </option>
      ))}
    </select>
  );
}
