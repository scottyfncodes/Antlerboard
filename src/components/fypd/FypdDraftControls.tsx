"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function FypdDraftControls({ draftId, status }: { draftId: string; status: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function act(action: string) {
    setBusy(true);
    await fetch(`/api/fypd/${draftId}/action`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    });
    setBusy(false);
    router.refresh();
  }

  return (
    <div className="flex gap-2">
      {status === "SETUP" && (
        <button onClick={() => act("start")} disabled={busy} className="rounded-md bg-antler px-3 py-1.5 text-sm font-medium text-[#1a1305] hover:bg-antler-strong disabled:opacity-50">
          Start Draft
        </button>
      )}
      {status === "IN_PROGRESS" && (
        <button onClick={() => act("pause")} disabled={busy} className="rounded-md border border-border px-3 py-1.5 text-sm hover:border-antler-dim disabled:opacity-50">
          Pause
        </button>
      )}
      {status === "PAUSED" && (
        <button onClick={() => act("resume")} disabled={busy} className="rounded-md bg-antler px-3 py-1.5 text-sm font-medium text-[#1a1305] hover:bg-antler-strong disabled:opacity-50">
          Resume
        </button>
      )}
      {(status === "IN_PROGRESS" || status === "PAUSED") && (
        <button onClick={() => act("undo")} disabled={busy} className="rounded-md border border-border px-3 py-1.5 text-sm text-muted hover:text-foreground disabled:opacity-50">
          Undo Last Pick
        </button>
      )}
    </div>
  );
}

export function FypdMakeSelection({
  draftId,
  availablePlayers,
}: {
  draftId: string;
  availablePlayers: { id: string; name: string; mlbDraftYear: number | null; mlbOrganization: string | null }[];
}) {
  const router = useRouter();
  const [playerId, setPlayerId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showNewPlayer, setShowNewPlayer] = useState(false);
  const [newPlayer, setNewPlayer] = useState({ name: "", mlbDraftYear: "", mlbDraftRound: "", mlbDraftOverallPick: "", mlbOrganization: "" });

  async function select() {
    if (!playerId) return;
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/fypd/${draftId}/action`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "select", playerId }),
    });
    const data = await res.json();
    setBusy(false);
    if (!res.ok) {
      setError(data.error ?? "Could not make that selection.");
      return;
    }
    setPlayerId("");
    router.refresh();
  }

  async function addProspectAndSelect() {
    setBusy(true);
    setError(null);
    const res = await fetch("/api/fypd/players", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(newPlayer),
    });
    const data = await res.json();
    if (!res.ok) {
      setBusy(false);
      setError(data.error ?? "Could not add that prospect.");
      return;
    }
    const selectRes = await fetch(`/api/fypd/${draftId}/action`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "select", playerId: data.player.id }),
    });
    setBusy(false);
    if (!selectRes.ok) {
      const selectData = await selectRes.json();
      setError(selectData.error ?? "Prospect added, but the pick failed.");
      return;
    }
    setShowNewPlayer(false);
    setNewPlayer({ name: "", mlbDraftYear: "", mlbDraftRound: "", mlbDraftOverallPick: "", mlbOrganization: "" });
    router.refresh();
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2 items-center">
        <select
          value={playerId}
          onChange={(e) => setPlayerId(e.target.value)}
          className="rounded-md border border-border bg-surface px-2 py-1.5 text-sm min-w-[220px]"
        >
          <option value="">Select a player…</option>
          {availablePlayers.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
              {p.mlbDraftYear ? ` (${p.mlbDraftYear} MLB draft${p.mlbOrganization ? `, ${p.mlbOrganization}` : ""})` : ""}
            </option>
          ))}
        </select>
        <button
          onClick={select}
          disabled={busy || !playerId}
          className="rounded-md bg-antler px-3 py-1.5 text-sm font-medium text-[#1a1305] hover:bg-antler-strong disabled:opacity-50"
        >
          Make Pick
        </button>
        <button
          onClick={() => setShowNewPlayer((v) => !v)}
          className="text-xs text-antler hover:text-antler-strong"
        >
          + New Prospect
        </button>
      </div>

      {showNewPlayer && (
        <div className="rounded-lg border border-border p-3 space-y-2 max-w-md">
          <p className="text-xs text-muted">
            Add a player not yet in the system (e.g. before the historical FYPD spreadsheet is imported).
          </p>
          <input
            placeholder="Name"
            value={newPlayer.name}
            onChange={(e) => setNewPlayer((p) => ({ ...p, name: e.target.value }))}
            className="w-full rounded-md border border-border bg-surface px-2 py-1.5 text-sm"
          />
          <div className="grid grid-cols-3 gap-2">
            <input
              placeholder="Draft Year"
              value={newPlayer.mlbDraftYear}
              onChange={(e) => setNewPlayer((p) => ({ ...p, mlbDraftYear: e.target.value }))}
              className="rounded-md border border-border bg-surface px-2 py-1.5 text-sm"
            />
            <input
              placeholder="Round"
              value={newPlayer.mlbDraftRound}
              onChange={(e) => setNewPlayer((p) => ({ ...p, mlbDraftRound: e.target.value }))}
              className="rounded-md border border-border bg-surface px-2 py-1.5 text-sm"
            />
            <input
              placeholder="Overall Pick"
              value={newPlayer.mlbDraftOverallPick}
              onChange={(e) => setNewPlayer((p) => ({ ...p, mlbDraftOverallPick: e.target.value }))}
              className="rounded-md border border-border bg-surface px-2 py-1.5 text-sm"
            />
          </div>
          <input
            placeholder="MLB Organization"
            value={newPlayer.mlbOrganization}
            onChange={(e) => setNewPlayer((p) => ({ ...p, mlbOrganization: e.target.value }))}
            className="w-full rounded-md border border-border bg-surface px-2 py-1.5 text-sm"
          />
          <button
            onClick={addProspectAndSelect}
            disabled={busy || !newPlayer.name}
            className="rounded-md bg-antler px-3 py-1.5 text-sm font-medium text-[#1a1305] hover:bg-antler-strong disabled:opacity-50"
          >
            Add &amp; Draft
          </button>
        </div>
      )}
      {error && <p className="text-sm text-red">{error}</p>}
    </div>
  );
}
