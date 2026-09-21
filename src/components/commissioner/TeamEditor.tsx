"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

interface TeamRow {
  id: string;
  name: string;
  manager: { id: string; name: string };
}

export function TeamEditor({ teams, managers }: { teams: TeamRow[]; managers: { id: string; name: string }[] }) {
  const router = useRouter();
  const [busyId, setBusyId] = useState<string | null>(null);

  async function save(teamId: string, name: string, managerId: string) {
    setBusyId(teamId);
    await fetch("/api/commissioner/teams", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ teamId, name, managerId }),
    });
    setBusyId(null);
    router.refresh();
  }

  return (
    <div className="rounded-xl border border-border overflow-hidden overflow-x-auto">
      <table className="w-full text-sm min-w-[480px]">
        <thead>
          <tr className="bg-surface-raised text-left text-xs text-muted">
            <th className="px-3 py-2 font-medium">Team Name</th>
            <th className="px-3 py-2 font-medium">Manager</th>
            <th className="px-3 py-2 font-medium"></th>
          </tr>
        </thead>
        <tbody>
          {teams.map((t) => (
            <TeamRowEditor key={t.id} team={t} managers={managers} busy={busyId === t.id} onSave={save} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TeamRowEditor({
  team,
  managers,
  busy,
  onSave,
}: {
  team: TeamRow;
  managers: { id: string; name: string }[];
  busy: boolean;
  onSave: (id: string, name: string, managerId: string) => void;
}) {
  const [name, setName] = useState(team.name);
  const [managerId, setManagerId] = useState(team.manager.id);

  return (
    <tr className="border-t border-border">
      <td className="px-3 py-2">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="rounded-md border border-border bg-surface px-2 py-1 text-sm w-full"
        />
      </td>
      <td className="px-3 py-2">
        <select
          value={managerId}
          onChange={(e) => setManagerId(e.target.value)}
          className="rounded-md border border-border bg-surface px-2 py-1 text-sm"
        >
          {managers.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
      </td>
      <td className="px-3 py-2">
        <button
          disabled={busy}
          onClick={() => onSave(team.id, name, managerId)}
          className="rounded-md border border-border px-2 py-1 text-xs hover:border-antler-dim"
        >
          Save
        </button>
      </td>
    </tr>
  );
}
