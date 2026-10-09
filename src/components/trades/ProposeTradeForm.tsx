"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Plus, X } from "lucide-react";
import { MAX_TRADE_TEAMS, tradeProposalProblem, type TradeAssetInput } from "@/lib/trade-proposal";

interface RosterPlayer {
  id: string;
  name: string;
  mlbTeam: string | null;
}

export interface TeamOption {
  id: string;
  name: string;
  roster: RosterPlayer[];
}

export interface TradeDraft {
  teamIds: string[];
  assets: TradeAssetInput[];
  notes?: string;
}

/**
 * Builds a 2-4 team trade. Each team in the deal gets a "sends" panel:
 * tick the players it gives up (and type in any picks), and - once there
 * are three or more teams - choose which team each one goes to. Passing
 * `counterOfTradeId` + `initial` turns this into the counter-offer editor.
 */
export function ProposeTradeForm({
  teams,
  ownTeamIds,
  defaultTeamId,
  initial,
  counterOfTradeId,
}: {
  teams: TeamOption[];
  /** "Your Team" is limited to these - the API rejects trades you aren't part of. */
  ownTeamIds: string[];
  defaultTeamId?: string;
  initial?: TradeDraft;
  counterOfTradeId?: string;
}) {
  const router = useRouter();
  const ownTeams = useMemo(() => teams.filter((t) => ownTeamIds.includes(t.id)), [teams, ownTeamIds]);
  const firstOwn = initial?.teamIds.find((id) => ownTeamIds.includes(id)) ?? defaultTeamId ?? ownTeams[0]?.id ?? "";

  const [myTeamId, setMyTeamId] = useState(firstOwn);
  const [partnerIds, setPartnerIds] = useState<string[]>(() => {
    if (initial) return initial.teamIds.filter((id) => id !== firstOwn);
    const other = teams.find((t) => t.id !== firstOwn);
    return other ? [other.id] : [];
  });
  const [assets, setAssets] = useState<TradeAssetInput[]>(initial?.assets ?? []);
  const [pickDrafts, setPickDrafts] = useState<Record<string, { description: string; toTeamId: string }>>({});
  const [notes, setNotes] = useState(initial?.notes ?? "");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const teamIds = [myTeamId, ...partnerIds];
  const teamById = useMemo(() => new Map(teams.map((t) => [t.id, t])), [teams]);
  const name = (id: string) => teamById.get(id)?.name ?? "Unknown team";
  const addableTeams = teams.filter((t) => !teamIds.includes(t.id));
  const problem = tradeProposalProblem({ proposingTeamId: myTeamId, teamIds, assets });

  // Removing a team from the deal drops everything moving to or from it.
  function dropTeamAssets(teamId: string) {
    setAssets((prev) => prev.filter((a) => a.fromTeamId !== teamId && a.toTeamId !== teamId));
  }

  function setPartner(index: number, teamId: string) {
    dropTeamAssets(partnerIds[index]);
    setPartnerIds((prev) => prev.map((id, i) => (i === index ? teamId : id)));
  }

  function removePartner(index: number) {
    dropTeamAssets(partnerIds[index]);
    setPartnerIds((prev) => prev.filter((_, i) => i !== index));
  }

  function changeMyTeam(teamId: string) {
    dropTeamAssets(myTeamId);
    setMyTeamId(teamId);
    setPartnerIds((prev) => prev.filter((id) => id !== teamId));
  }

  function defaultDestination(fromTeamId: string) {
    return teamIds.find((id) => id !== fromTeamId) ?? "";
  }

  function togglePlayer(fromTeamId: string, playerId: string) {
    setAssets((prev) =>
      prev.some((a) => a.playerId === playerId)
        ? prev.filter((a) => a.playerId !== playerId)
        : [...prev, { fromTeamId, toTeamId: defaultDestination(fromTeamId), assetType: "PLAYER", playerId }]
    );
  }

  function setDestination(asset: TradeAssetInput, toTeamId: string) {
    setAssets((prev) => prev.map((a) => (a === asset ? { ...a, toTeamId } : a)));
  }

  function addPick(fromTeamId: string) {
    const draft = pickDrafts[fromTeamId];
    const description = draft?.description.trim();
    if (!description) return;
    setAssets((prev) => [
      ...prev,
      {
        fromTeamId,
        toTeamId: draft.toTeamId && teamIds.includes(draft.toTeamId) ? draft.toTeamId : defaultDestination(fromTeamId),
        assetType: "DRAFT_PICK",
        draftPickDescription: description,
      },
    ]);
    setPickDrafts((prev) => ({ ...prev, [fromTeamId]: { description: "", toTeamId: draft.toTeamId } }));
  }

  async function submit() {
    if (problem) return setError(problem);
    setSubmitting(true);
    setError(null);
    const res = await fetch("/api/trades", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ teamIds, proposingTeamId: myTeamId, assets, notes, counterOfTradeId }),
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

  const multi = teamIds.length > 2;

  return (
    <div className="space-y-5">
      <div className="space-y-4">
        {teamIds.map((teamId, index) => {
          const team = teamById.get(teamId);
          const isMine = index === 0;
          const sending = assets.filter((a) => a.fromTeamId === teamId);
          const pickDraft = pickDrafts[teamId] ?? { description: "", toTeamId: "" };
          return (
            <section key={`${index}-${teamId}`} className="rounded-xl border border-border bg-surface">
              <header className="flex items-center gap-2 border-b border-border px-3 py-2">
                <span className="shrink-0 text-[11px] font-semibold uppercase tracking-wider text-muted">
                  {isMine ? "Your team" : `Team ${index + 1}`}
                </span>
                <select
                  value={teamId}
                  onChange={(e) => (isMine ? changeMyTeam(e.target.value) : setPartner(index - 1, e.target.value))}
                  className="min-w-0 flex-1 rounded-md border border-border bg-surface-raised px-2 py-1 text-sm font-semibold"
                >
                  {(isMine ? ownTeams : teams.filter((t) => t.id === teamId || !teamIds.includes(t.id))).map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
                {!isMine && teamIds.length > 2 && (
                  <button onClick={() => removePartner(index - 1)} aria-label={`Remove ${name(teamId)}`} className="p-1 text-muted hover:text-red">
                    <X className="h-4 w-4" />
                  </button>
                )}
              </header>

              <p className="px-3 pt-2 text-xs text-muted">{name(teamId)} sends:</p>
              <div className="mx-3 mt-1 max-h-56 overflow-y-auto rounded-md border border-border">
                {(team?.roster ?? []).map((p) => {
                  const asset = sending.find((a) => a.playerId === p.id);
                  return (
                    <div key={p.id} className="flex items-center gap-2 border-b border-border px-2 py-1.5 text-sm last:border-0">
                      <label className="flex min-w-0 flex-1 items-center gap-2">
                        <input type="checkbox" checked={!!asset} onChange={() => togglePlayer(teamId, p.id)} className="accent-[#c9a15a]" />
                        <span className="truncate">{p.name}</span>
                        <span className="text-xs text-muted">{p.mlbTeam}</span>
                      </label>
                      {asset && multi && (
                        <DestinationSelect
                          value={asset.toTeamId}
                          fromTeamId={teamId}
                          teamIds={teamIds}
                          name={name}
                          onChange={(to) => setDestination(asset, to)}
                        />
                      )}
                    </div>
                  );
                })}
                {(team?.roster.length ?? 0) === 0 && <p className="px-2 py-2 text-xs text-muted">No players rostered.</p>}
              </div>

              <ul className="mx-3 mt-2 space-y-1">
                {sending
                  .filter((a) => a.assetType === "DRAFT_PICK")
                  .map((a, i) => (
                    <li key={i} className="flex items-center gap-2 rounded-md bg-surface-raised px-2 py-1 text-sm">
                      <span className="min-w-0 flex-1 truncate">{a.draftPickDescription}</span>
                      {multi ? (
                        <DestinationSelect
                          value={a.toTeamId}
                          fromTeamId={teamId}
                          teamIds={teamIds}
                          name={name}
                          onChange={(to) => setDestination(a, to)}
                        />
                      ) : (
                        <span className="text-xs text-muted">to {name(a.toTeamId)}</span>
                      )}
                      <button
                        onClick={() => setAssets((prev) => prev.filter((x) => x !== a))}
                        aria-label="Remove pick"
                        className="text-muted hover:text-red"
                      >
                        <X className="h-4 w-4" />
                      </button>
                    </li>
                  ))}
              </ul>
              <div className="flex gap-2 p-3">
                <input
                  value={pickDraft.description}
                  onChange={(e) => setPickDrafts((prev) => ({ ...prev, [teamId]: { ...pickDraft, description: e.target.value } }))}
                  onKeyDown={(e) => e.key === "Enter" && addPick(teamId)}
                  placeholder="Add a draft pick, e.g. 2027 3rd round"
                  className="min-w-0 flex-1 rounded-md border border-border bg-surface px-2 py-1.5 text-xs"
                />
                {multi && (
                  <DestinationSelect
                    value={pickDraft.toTeamId || defaultDestination(teamId)}
                    fromTeamId={teamId}
                    teamIds={teamIds}
                    name={name}
                    onChange={(to) => setPickDrafts((prev) => ({ ...prev, [teamId]: { ...pickDraft, toTeamId: to } }))}
                  />
                )}
                <button
                  onClick={() => addPick(teamId)}
                  disabled={!pickDraft.description.trim()}
                  className="rounded-md border border-border px-2.5 text-xs hover:border-antler-dim disabled:opacity-40"
                >
                  Add
                </button>
              </div>
            </section>
          );
        })}

        {teamIds.length < MAX_TRADE_TEAMS && addableTeams.length > 0 && (
          <button
            onClick={() => setPartnerIds((prev) => [...prev, addableTeams[0].id])}
            className="flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-border py-3 text-sm text-muted hover:border-antler-dim hover:text-foreground"
          >
            <Plus className="h-4 w-4" /> Add another team ({teamIds.length}/{MAX_TRADE_TEAMS})
          </button>
        )}
      </div>

      {assets.length > 0 && (
        <div className="rounded-xl border border-border bg-surface p-3">
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted">Summary</p>
          <ul className="space-y-1.5 text-sm">
            {teamIds.map((id) => {
              const incoming = assets.filter((a) => a.toTeamId === id);
              return (
                <li key={id}>
                  <span className="font-semibold">{name(id)}</span> gets{" "}
                  <span className="text-muted">
                    {incoming.length === 0
                      ? "nothing yet"
                      : incoming
                          .map((a) => {
                            const label =
                              a.assetType === "PLAYER"
                                ? (teamById.get(a.fromTeamId)?.roster.find((p) => p.id === a.playerId)?.name ?? "a player")
                                : a.draftPickDescription;
                            return multi ? `${label} (from ${name(a.fromTeamId)})` : label;
                          })
                          .join(", ")}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      <div>
        <label className="text-xs text-muted">Notes</label>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={2}
          className="mt-1 w-full rounded-md border border-border bg-surface px-2 py-1.5 text-sm"
          placeholder={multi ? "Anything the other managers should know…" : "Anything the other manager should know…"}
        />
        <p className="mt-1 text-xs text-muted">
          Only the teams in this trade can see it.{multi ? " Every team has to accept before it goes through." : ""}
        </p>
      </div>

      {error && <p className="text-sm text-red">{error}</p>}

      <button
        onClick={submit}
        disabled={submitting || !!problem}
        className="rounded-md bg-antler px-4 py-2 text-sm font-medium text-[#1a1305] hover:bg-antler-strong disabled:opacity-50"
      >
        {submitting ? "Sending…" : counterOfTradeId ? "Send Counter-Offer" : "Send Proposal"}
      </button>
      {problem && assets.length > 0 && <p className="text-xs text-muted">{problem}</p>}
    </div>
  );
}

function DestinationSelect({
  value,
  fromTeamId,
  teamIds,
  name,
  onChange,
}: {
  value: string;
  fromTeamId: string;
  teamIds: string[];
  name: (id: string) => string;
  onChange: (teamId: string) => void;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      aria-label="Send to"
      className="max-w-[9rem] shrink-0 rounded-md border border-border bg-surface-raised px-1.5 py-0.5 text-[11px] text-muted"
    >
      {teamIds
        .filter((id) => id !== fromTeamId)
        .map((id) => (
          <option key={id} value={id}>
            to {name(id)}
          </option>
        ))}
    </select>
  );
}
