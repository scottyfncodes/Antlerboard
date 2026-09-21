"use client";

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

  function update(key: string, value: string) {
    const next = new URLSearchParams(params.toString());
    if (value) next.set(key, value);
    else next.delete(key);
    router.push(`${pathname}?${next.toString()}`);
  }

  return (
    <div className="flex flex-wrap gap-2 items-center">
      <input
        defaultValue={params.get("q") ?? ""}
        onChange={(e) => update("q", e.target.value)}
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
        <button onClick={() => router.push(pathname)} className="text-xs text-muted hover:text-foreground underline">
          Clear filters
        </button>
      )}
    </div>
  );
}
