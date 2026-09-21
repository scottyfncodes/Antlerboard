"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function CreateFypdDraftForm({
  bottomFourTeams,
  nextYear,
}: {
  bottomFourTeams: { id: string; name: string; rank: number }[];
  nextYear: number;
}) {
  const router = useRouter();
  const [year, setYear] = useState(String(nextYear));
  const [rounds, setRounds] = useState("10");
  const [ninthBrigadeTeamId, setNinthBrigadeTeamId] = useState(bottomFourTeams[0]?.id ?? "");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create() {
    setCreating(true);
    setError(null);
    const res = await fetch("/api/fypd/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ year: Number(year), rounds: Number(rounds), ninthBrigadeTeamId }),
    });
    const data = await res.json();
    setCreating(false);
    if (!res.ok) {
      setError(data.error ?? "Could not create the draft.");
      return;
    }
    router.refresh();
  }

  if (bottomFourTeams.length === 0) {
    return (
      <p className="text-sm text-muted">
        No prior-season standings found yet - the FYPD order can&apos;t be computed until last season&apos;s final
        standings are recorded.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-3">
        <label className="text-xs text-muted">
          Draft Year
          <input
            value={year}
            onChange={(e) => setYear(e.target.value)}
            className="mt-1 block w-24 rounded-md border border-border bg-surface px-2 py-1.5 text-sm"
          />
        </label>
        <label className="text-xs text-muted">
          Rounds
          <input
            value={rounds}
            onChange={(e) => setRounds(e.target.value)}
            className="mt-1 block w-20 rounded-md border border-border bg-surface px-2 py-1.5 text-sm"
          />
        </label>
        <label className="text-xs text-muted">
          9th Brigade
          <select
            value={ninthBrigadeTeamId}
            onChange={(e) => setNinthBrigadeTeamId(e.target.value)}
            className="mt-1 block rounded-md border border-border bg-surface px-2 py-1.5 text-sm"
          >
            {bottomFourTeams.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name} ({t.rank} place)
              </option>
            ))}
          </select>
        </label>
      </div>
      <button
        onClick={create}
        disabled={creating}
        className="rounded-md bg-antler px-3 py-2 text-sm font-medium text-[#1a1305] hover:bg-antler-strong disabled:opacity-50"
      >
        {creating ? "Creating…" : "Create FYPD Draft"}
      </button>
      {error && <p className="text-sm text-red">{error}</p>}
    </div>
  );
}
