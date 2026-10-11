"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { DiscoveredLeague, LeagueDiagnostic } from "@/app/api/yahoo/leagues/route";
import type { LinkableTeam, YahooTeamLinkRow } from "@/app/api/yahoo/teams/route";
import type { SyncSectionResult } from "@/lib/yahoo/sync";

export function YahooControls({
  connected,
  selectedLeagueKey,
}: {
  connected: boolean;
  selectedLeagueKey: string | null;
}) {
  const [leagues, setLeagues] = useState<DiscoveredLeague[] | null>(null);
  const [diagnostic, setDiagnostic] = useState<LeagueDiagnostic | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadingLeagues, setLoadingLeagues] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<{ summary: string; failed: boolean; sections: SyncSectionResult[] } | null>(
    null
  );
  const router = useRouter();

  useEffect(() => {
    if (connected && !selectedLeagueKey) {
      setLoadingLeagues(true);
      fetch("/api/yahoo/leagues")
        .then((r) => r.json())
        .then((data) => {
          setLeagues(data.leagues ?? []);
          setDiagnostic(data.diagnostic ?? null);
          setLoadError(data.error ?? null);
        })
        .finally(() => setLoadingLeagues(false));
    }
  }, [connected, selectedLeagueKey]);

  async function selectLeague(league: DiscoveredLeague) {
    await fetch("/api/yahoo/select-league", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ leagueKey: league.key, gameKey: league.gameKey }),
    });
    router.refresh();
  }

  async function syncNow() {
    setSyncing(true);
    setSyncResult(null);
    try {
      const res = await fetch("/api/yahoo/sync", { method: "POST" });
      // A timed-out or crashed function returns an HTML error page, not JSON.
      const data = await res.json().catch(() => ({ error: `Sync request failed (HTTP ${res.status})` }));
      setSyncResult(
        data.status && data.sections
          ? {
              summary: `${data.status} — ${data.totalRecordsUpdated ?? 0} records updated`,
              failed: data.status !== "SUCCESS",
              sections: data.sections,
            }
          : { summary: data.error ?? "Sync failed", failed: true, sections: [] }
      );
    } catch {
      setSyncResult({ summary: "Couldn't reach Antlerboard to run the sync - check your connection.", failed: true, sections: [] });
    } finally {
      setSyncing(false);
      router.refresh();
    }
  }

  async function disconnect() {
    await fetch("/api/yahoo/disconnect", { method: "POST" });
    router.refresh();
  }

  if (!connected) {
    return (
      <a
        href="/api/yahoo/authorize"
        className="inline-block rounded-md bg-antler px-4 py-2 text-sm font-medium text-[#1a1305] hover:bg-antler-strong"
      >
        Connect Yahoo
      </a>
    );
  }

  if (!selectedLeagueKey) {
    const sorted = leagues
      ? [...leagues].sort((a, b) => Number(b.isLikelyClawAndAntler) - Number(a.isLikelyClawAndAntler))
      : null;

    return (
      <div className="space-y-2">
        <p className="text-sm text-muted">Connected. Pick the Claw & Antler League from your Yahoo leagues:</p>
        {loadingLeagues && <p className="text-sm text-muted">Loading your leagues…</p>}
        {diagnostic?.reason === "app_not_authorized" ? (
          <div className="rounded-md border border-yellow/40 bg-yellow/10 px-3 py-2 text-sm text-yellow">
            <p>{diagnostic.message}</p>
            {diagnostic.helpUrl && (
              <a href={diagnostic.helpUrl} target="_blank" rel="noopener noreferrer" className="mt-1 inline-block underline">
                Open Yahoo&apos;s confirmation form
              </a>
            )}
          </div>
        ) : (
          <>
            {loadError && <p className="text-sm text-red">Couldn&apos;t load leagues: {loadError}</p>}
            {diagnostic && <p className="text-sm text-muted">{diagnostic.message}</p>}
          </>
        )}
        <ul className="space-y-1.5">
          {sorted?.map((l) => (
            <li key={l.key}>
              <button
                onClick={() => selectLeague(l)}
                className={`w-full rounded-md border px-3 py-2 text-left text-sm hover:border-antler-dim ${
                  l.isLikelyClawAndAntler ? "border-antler bg-antler/10" : "border-border"
                }`}
              >
                <div className="flex items-center gap-2">
                  <span className="font-medium">{l.name}</span>
                  {l.isLikelyClawAndAntler && (
                    <span className="rounded-md border border-antler-dim px-1.5 py-0.5 text-xs text-antler">
                      Likely match
                    </span>
                  )}
                </div>
                <div className="mt-0.5 text-xs text-muted">
                  {l.season ? `${l.season} season` : "Unknown season"}
                  {l.numTeams !== null ? ` · ${l.numTeams} teams` : ""}
                  {l.draftStatus ? ` · ${l.draftStatus.replace("_", " ")}` : ""}
                  {l.scoringType ? ` · ${l.scoringType} scoring` : ""}
                  {" · "}
                  {l.key}
                </div>
              </button>
            </li>
          ))}
        </ul>
        <button onClick={disconnect} className="rounded-md border border-border px-3 py-1.5 text-sm text-muted hover:text-foreground">
          Disconnect
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <button
          onClick={syncNow}
          disabled={syncing}
          className="rounded-md bg-antler px-3 py-2 text-sm font-medium text-[#1a1305] hover:bg-antler-strong disabled:opacity-50"
        >
          {syncing ? "Syncing…" : "Sync Now"}
        </button>
        <button onClick={disconnect} className="rounded-md border border-border px-3 py-2 text-sm text-muted hover:text-foreground">
          Disconnect
        </button>
      </div>
      {syncResult && (
        <div className="text-sm">
          <p className={syncResult.failed ? "text-red" : "text-muted"}>{syncResult.summary}</p>
          {syncResult.sections.length > 0 && (
            <ul className="mt-1 space-y-0.5 text-xs text-muted">
              {syncResult.sections.map((s) => (
                <li key={s.section}>
                  {s.section}: {s.recordsUpdated} updated
                  {s.error && <span className="text-red"> — {s.error}</span>}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      <TeamLinker />
    </div>
  );
}

/**
 * Links each Yahoo team to the Antlerboard team (and keeper history) it
 * really is. The sync only writes names/standings/rosters for linked teams,
 * so this runs before the first sync on a league imported from history.
 */
function TeamLinker() {
  const [yahooTeams, setYahooTeams] = useState<YahooTeamLinkRow[] | null>(null);
  const [antlerboardTeams, setAntlerboardTeams] = useState<LinkableTeam[]>([]);
  const [choices, setChoices] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    fetch("/api/yahoo/teams")
      .then((r) => r.json().catch(() => ({ error: `HTTP ${r.status}` })))
      .then((data) => {
        if (data.error) {
          setError(data.error);
          return;
        }
        setYahooTeams(data.yahooTeams);
        setAntlerboardTeams(data.antlerboardTeams);
        setChoices(
          Object.fromEntries(
            (data.yahooTeams as YahooTeamLinkRow[]).map((t) => [t.key, t.linkedTeamId ?? t.suggestedTeamId ?? ""])
          )
        );
      })
      .catch(() => setError("Couldn't load Yahoo teams."));
  }, []);

  async function save() {
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      const res = await fetch("/api/yahoo/teams", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          links: Object.entries(choices).map(([yahooTeamKey, teamId]) => ({ yahooTeamKey, teamId: teamId || null })),
        }),
      });
      const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      if (data.error) setError(data.error);
      else {
        setSaved(true);
        setYahooTeams((rows) => rows?.map((r) => ({ ...r, linkedTeamId: choices[r.key] || null })) ?? null);
      }
    } catch {
      setError("Couldn't save team links.");
    } finally {
      setSaving(false);
    }
  }

  if (error && !yahooTeams) return <p className="text-sm text-red">Couldn&apos;t load Yahoo teams: {error}</p>;
  if (!yahooTeams) return <p className="text-sm text-muted">Loading Yahoo teams…</p>;

  const chosen = Object.values(choices).filter(Boolean);
  const duplicate = chosen.length !== new Set(chosen).size;
  const linkedCount = yahooTeams.filter((t) => t.linkedTeamId).length;

  return (
    <div className="mt-4 space-y-2 border-t border-border pt-3">
      <h3 className="font-medium text-sm">Team links</h3>
      <p className="text-xs text-muted">
        {linkedCount} of {yahooTeams.length} Yahoo teams linked. The sync only updates linked teams, so each Yahoo team
        keeps its Antlerboard keeper history.
      </p>
      <ul className="space-y-1.5">
        {yahooTeams.map((t) => (
          <li key={t.key} className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <span>
              {t.name}
              {t.managerNicknames.length > 0 && <span className="text-xs text-muted"> · {t.managerNicknames.join(", ")}</span>}
            </span>
            <select
              value={choices[t.key] ?? ""}
              onChange={(e) => setChoices((c) => ({ ...c, [t.key]: e.target.value }))}
              className="rounded-md border border-border bg-transparent px-2 py-1 text-sm"
            >
              <option value="">Not linked</option>
              {antlerboardTeams.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} ({a.managerName})
                </option>
              ))}
            </select>
          </li>
        ))}
      </ul>
      {duplicate && <p className="text-xs text-red">An Antlerboard team is picked for more than one Yahoo team.</p>}
      {error && <p className="text-xs text-red">{error}</p>}
      {saved && <p className="text-xs text-muted">Team links saved.</p>}
      <button
        onClick={save}
        disabled={saving || duplicate}
        className="rounded-md border border-border px-3 py-1.5 text-sm hover:border-antler-dim disabled:opacity-50"
      >
        {saving ? "Saving…" : "Save team links"}
      </button>
    </div>
  );
}
