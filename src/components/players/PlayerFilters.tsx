"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams, usePathname } from "next/navigation";

export function PlayerFilters({
  teams,
  positions,
}: {
  teams: { id: string; name: string }[];
  positions: string[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [q, setQ] = useState(params.get("q") ?? "");
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  function update(key: string, value: string, { replace = false } = {}) {
    const next = new URLSearchParams(params.toString());
    if (value) next.set(key, value);
    else next.delete(key);
    const url = `${pathname}?${next.toString()}`;
    if (replace) router.replace(url, { scroll: false });
    else router.push(url);
  }

  useEffect(() => () => {
    if (debounce.current) clearTimeout(debounce.current);
  }, []);

  // Typing settles before the URL changes, and replaces the history entry
  // rather than adding one per letter (same as UrlFilterBar).
  function onSearch(value: string) {
    setQ(value);
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(() => update("q", value.trim(), { replace: true }), 300);
  }

  function clear() {
    if (debounce.current) clearTimeout(debounce.current);
    setQ("");
    router.push(pathname);
  }

  return (
    <div className="flex flex-wrap gap-2 items-center">
      <input
        value={q}
        onChange={(e) => onSearch(e.target.value)}
        placeholder="Filter by name…"
        className="rounded-md border border-border bg-surface px-2 py-1.5 text-sm w-40"
      />

      <select
        className="rounded-md border border-border bg-surface px-2 py-1.5 text-sm"
        value={params.get("team") ?? ""}
        onChange={(e) => update("team", e.target.value)}
      >
        <option value="">All Teams</option>
        {teams.map((t) => (
          <option key={t.id} value={t.id}>
            {t.name}
          </option>
        ))}
      </select>

      <select
        className="rounded-md border border-border bg-surface px-2 py-1.5 text-sm"
        value={params.get("position") ?? ""}
        onChange={(e) => update("position", e.target.value)}
      >
        <option value="">All Positions</option>
        {positions.map((p) => (
          <option key={p} value={p}>
            {p}
          </option>
        ))}
      </select>

      <select
        className="rounded-md border border-border bg-surface px-2 py-1.5 text-sm"
        value={params.get("tag") ?? ""}
        onChange={(e) => update("tag", e.target.value)}
      >
        <option value="">Any Tag</option>
        <option value="KEEPING">Keeping</option>
        <option value="ON_THE_TABLE">On the Table</option>
        <option value="OPEN_TO_DISCUSS">Open to Discuss</option>
        <option value="AVAILABLE">Available</option>
        <option value="NEEDS_DECISION">Needs Decision</option>
        <option value="FORCED_BACK">Forced Back</option>
      </select>

      <select
        className="rounded-md border border-border bg-surface px-2 py-1.5 text-sm"
        value={params.get("yearsRemaining") ?? ""}
        onChange={(e) => update("yearsRemaining", e.target.value)}
      >
        <option value="">Any Years Remaining</option>
        <option value="0">0 (final year)</option>
        <option value="1">1</option>
        <option value="2">2</option>
        <option value="3">3</option>
        <option value="4">4</option>
      </select>

      <select
        className="rounded-md border border-border bg-surface px-2 py-1.5 text-sm"
        value={params.get("sort") ?? ""}
        onChange={(e) => update("sort", e.target.value)}
      >
        <option value="">Sort: Player</option>
        <option value="cost">Sort: Keeper Cost</option>
        <option value="yearsRemaining">Sort: Years Remaining</option>
      </select>

      {[...params.keys()].length > 0 && (
        <button onClick={clear}className="text-xs text-muted hover:text-foreground underline">
          Clear filters
        </button>
      )}
    </div>
  );
}
