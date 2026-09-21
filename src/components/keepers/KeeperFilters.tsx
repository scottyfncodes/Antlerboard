"use client";

import { useRouter, useSearchParams, usePathname } from "next/navigation";

interface TeamOption {
  id: string;
  name: string;
}

export function KeeperFilters({ teams }: { teams: TeamOption[] }) {
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
        value={params.get("minYear") ?? ""}
        onChange={(e) => update("minYear", e.target.value)}
      >
        <option value="">Any Keeper Year</option>
        <option value="1">Year 1+</option>
        <option value="2">Year 2+</option>
        <option value="3">Year 3+</option>
        <option value="4">Year 4+</option>
        <option value="5">Year 5</option>
      </select>

      <select
        className="rounded-md border border-border bg-surface px-2 py-1.5 text-sm"
        value={params.get("status") ?? ""}
        onChange={(e) => update("status", e.target.value)}
      >
        <option value="">Any Status</option>
        <option value="KEPT">Kept</option>
        <option value="FORCED_BACK">Forced Back</option>
      </select>

      <select
        className="rounded-md border border-border bg-surface px-2 py-1.5 text-sm"
        value={params.get("sort") ?? "team"}
        onChange={(e) => update("sort", e.target.value)}
      >
        <option value="team">Sort: Team</option>
        <option value="cost">Sort: Cost</option>
        <option value="yearsRemaining">Sort: Years Remaining</option>
        <option value="player">Sort: Player</option>
      </select>

      {(params.get("team") || params.get("minYear") || params.get("status")) && (
        <button
          onClick={() => router.push(pathname)}
          className="text-xs text-muted hover:text-foreground underline"
        >
          Clear filters
        </button>
      )}
    </div>
  );
}
