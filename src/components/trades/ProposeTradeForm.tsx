"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";

interface RosterPlayer {
  id: string;
  name: string;
  mlbTeam: string | null;
}

interface TeamOption {
  id: string;
  name: string;
  roster: RosterPlayer[];
}

export function ProposeTradeForm({ teams, defaultTeamId }: { teams: TeamOption[]; defaultTeamId?: string }) {
  const router = useRouter();
  const [teamAId, setTeamAId] = useState(defaultTeamId ?? teams[0]?.id ?? "");
  const [teamBId, setTeamBId] = useState(teams.find((t) => t.id !== defaultTeamId)?.id ?? teams[1]?.id ?? "");
  const [fromA, setFromA] = useState<string[]>([]);
  const [fromB, setFromB] = useState<string[]>([]);
  const [pickFromA, setPickFromA] = useState("");
  const [pickFromB, setPickFromB] = useState("");
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const teamA = teams.find((t) => t.id === teamAId);
  const teamB = teams.find((t) => t.id === teamBId);
  const otherTeams = useMemo(() => teams.filter((t) => t.id !== teamAId), [teams, teamAId]);

  function toggle(list: string[], setList: (v: string[]) => void, id: string) {
    setList(list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);
  }

  async function submit() {
    setSubmitting(true);
    setError(null);
    const assets = [
      ...fromA.map((playerId) => ({ fromTeamId: teamAId, toTeamId: teamBId, assetType: "PLAYER", playerId })),
      ...fromB.map((playerId) => ({ fromTeamId: teamBId, toTeamId: teamAId, assetType: "PLAYER", playerId })),
      ...(pickFromA
        ? [{ fromTeamId: teamAId, toTeamId: teamBId, assetType: "DRAFT_PICK", draftPickDescription: pickFromA }]
        : []),
      ...(pickFromB
        ? [{ fromTeamId: teamBId, toTeamId: teamAId, assetType: "DRAFT_PICK", draftPickDescription: pickFromB }]
        : []),
    ];

    const res = await fetch("/api/trades", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ teamAId, teamBId, notes, assets }),
    });
    setSubmitting(false);
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setError(data.error ?? "Something went wrong.");
      return;
    }
    router.push("/trades");
    router.refresh();
  }

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <label className="text-xs text-muted">Your Team</label>
          <select
            value={teamAId}
            onChange={(e) => {
              setTeamAId(e.target.value);
              setFromA([]);
            }}
            className="mt-1 w-full rounded-md border border-border bg-surface px-2 py-1.5 text-sm"
          >
            {teams.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
          <RosterPicker roster={teamA?.roster ?? []} selected={fromA} onToggle={(id) => toggle(fromA, setFromA, id)} />
          <input
            value={pickFromA}
            onChange={(e) => setPickFromA(e.target.value)}
            placeholder="Draft pick to include (optional), e.g. 2027 3rd round"
            className="mt-2 w-full rounded-md border border-border bg-surface px-2 py-1.5 text-xs"
          />
        </div>

        <div>
          <label className="text-xs text-muted">Trading With</label>
          <select
            value={teamBId}
            onChange={(e) => {
              setTeamBId(e.target.value);
              setFromB([]);
            }}
            className="mt-1 w-full rounded-md border border-border bg-surface px-2 py-1.5 text-sm"
          >
            {otherTeams.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
          <RosterPicker roster={teamB?.roster ?? []} selected={fromB} onToggle={(id) => toggle(fromB, setFromB, id)} />
          <input
            value={pickFromB}
            onChange={(e) => setPickFromB(e.target.value)}
            placeholder="Draft pick to include (optional), e.g. 2027 5th round"
            className="mt-2 w-full rounded-md border border-border bg-surface px-2 py-1.5 text-xs"
          />
        </div>
      </div>

      <div>
        <label className="text-xs text-muted">Notes</label>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={2}
          className="mt-1 w-full rounded-md border border-border bg-surface px-2 py-1.5 text-sm"
          placeholder="Anything the other manager should know…"
        />
      </div>

      {error && <p className="text-sm text-red">{error}</p>}

      <button
        onClick={submit}
        disabled={submitting || (fromA.length === 0 && fromB.length === 0 && !pickFromA && !pickFromB)}
        className="rounded-md bg-antler px-4 py-2 text-sm font-medium text-[#1a1305] hover:bg-antler-strong disabled:opacity-50"
      >
        {submitting ? "Sending…" : "Send Proposal"}
      </button>
    </div>
  );
}

function RosterPicker({
  roster,
  selected,
  onToggle,
}: {
  roster: RosterPlayer[];
  selected: string[];
  onToggle: (id: string) => void;
}) {
  return (
    <div className="mt-2 max-h-56 overflow-y-auto rounded-md border border-border">
      {roster.map((p) => (
        <label key={p.id} className="flex items-center gap-2 px-2 py-1.5 text-sm border-b border-border last:border-0 hover:bg-surface-raised">
          <input type="checkbox" checked={selected.includes(p.id)} onChange={() => onToggle(p.id)} className="accent-[#c9a15a]" />
          <span>{p.name}</span>
          <span className="text-xs text-muted ml-auto">{p.mlbTeam}</span>
        </label>
      ))}
      {roster.length === 0 && <p className="px-2 py-2 text-xs text-muted">No players rostered.</p>}
    </div>
  );
}
