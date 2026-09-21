"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

interface SeasonRow {
  id: string;
  year: number;
  status: string;
  keeperDeadline: string | null;
  draftDate: string | null;
}

export function SeasonEditor({ seasons }: { seasons: SeasonRow[] }) {
  const router = useRouter();
  const [busyId, setBusyId] = useState<string | null>(null);

  async function save(seasonId: string, keeperDeadline: string, draftDate: string) {
    setBusyId(seasonId);
    await fetch("/api/commissioner/seasons", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ seasonId, keeperDeadline, draftDate }),
    });
    setBusyId(null);
    router.refresh();
  }

  return (
    <div className="rounded-xl border border-border overflow-hidden overflow-x-auto">
      <table className="w-full text-sm min-w-[520px]">
        <thead>
          <tr className="bg-surface-raised text-left text-xs text-muted">
            <th className="px-3 py-2 font-medium">Season</th>
            <th className="px-3 py-2 font-medium">Status</th>
            <th className="px-3 py-2 font-medium">Keeper Deadline</th>
            <th className="px-3 py-2 font-medium">Draft Date</th>
            <th className="px-3 py-2 font-medium"></th>
          </tr>
        </thead>
        <tbody>
          {seasons.map((s) => (
            <SeasonRowEditor key={s.id} season={s} busy={busyId === s.id} onSave={save} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SeasonRowEditor({
  season,
  busy,
  onSave,
}: {
  season: SeasonRow;
  busy: boolean;
  onSave: (id: string, keeperDeadline: string, draftDate: string) => void;
}) {
  const [keeperDeadline, setKeeperDeadline] = useState(season.keeperDeadline?.slice(0, 10) ?? "");
  const [draftDate, setDraftDate] = useState(season.draftDate?.slice(0, 10) ?? "");

  return (
    <tr className="border-t border-border">
      <td className="px-3 py-2 tabular">{season.year}</td>
      <td className="px-3 py-2 text-muted">{season.status}</td>
      <td className="px-3 py-2">
        <input
          type="date"
          value={keeperDeadline}
          onChange={(e) => setKeeperDeadline(e.target.value)}
          className="rounded-md border border-border bg-surface px-2 py-1 text-xs"
        />
      </td>
      <td className="px-3 py-2">
        <input
          type="date"
          value={draftDate}
          onChange={(e) => setDraftDate(e.target.value)}
          className="rounded-md border border-border bg-surface px-2 py-1 text-xs"
        />
      </td>
      <td className="px-3 py-2">
        <button
          disabled={busy}
          onClick={() => onSave(season.id, keeperDeadline, draftDate)}
          className="rounded-md border border-border px-2 py-1 text-xs hover:border-antler-dim"
        >
          Save
        </button>
      </td>
    </tr>
  );
}
