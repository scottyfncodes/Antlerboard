"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { DiscoveredLeague } from "@/app/api/yahoo/leagues/route";

interface LeagueDiagnostic {
  queried: string;
  gamesFound: number;
  message: string;
}

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
  const [syncResult, setSyncResult] = useState<string | null>(null);
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
    const res = await fetch("/api/yahoo/sync", { method: "POST" });
    const data = await res.json();
    setSyncing(false);
    setSyncResult(
      data.status
        ? `${data.status} — ${data.totalRecordsUpdated ?? 0} records updated`
        : data.error ?? "Sync failed"
    );
    router.refresh();
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
        {loadError && <p className="text-sm text-red">Couldn&apos;t load leagues: {loadError}</p>}
        {leagues && leagues.length === 0 && diagnostic && (
          <p className="text-sm text-muted">{diagnostic.message}</p>
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
      {syncResult && <p className="text-sm text-muted">{syncResult}</p>}
    </div>
  );
}
