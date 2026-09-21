"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

interface YahooLeagueOption {
  key: string;
  name: string;
  season: string;
}

export function YahooControls({
  connected,
  selectedLeagueKey,
}: {
  connected: boolean;
  selectedLeagueKey: string | null;
}) {
  const [leagues, setLeagues] = useState<YahooLeagueOption[] | null>(null);
  const [loadingLeagues, setLoadingLeagues] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<string | null>(null);
  const router = useRouter();

  useEffect(() => {
    if (connected && !selectedLeagueKey) {
      setLoadingLeagues(true);
      fetch("/api/yahoo/leagues")
        .then((r) => r.json())
        .then((data) => setLeagues(data.leagues ?? []))
        .finally(() => setLoadingLeagues(false));
    }
  }, [connected, selectedLeagueKey]);

  async function selectLeague(key: string, season: string) {
    await fetch("/api/yahoo/select-league", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ leagueKey: key, gameKey: `mlb.${season}` }),
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
    return (
      <div className="space-y-2">
        <p className="text-sm text-muted">Connected. Pick the Claw & Antler League from your Yahoo leagues:</p>
        {loadingLeagues && <p className="text-sm text-muted">Loading your leagues…</p>}
        {leagues && leagues.length === 0 && (
          <p className="text-sm text-muted">No MLB fantasy leagues found on this Yahoo account.</p>
        )}
        <ul className="space-y-1.5">
          {leagues?.map((l) => (
            <li key={l.key}>
              <button
                onClick={() => selectLeague(l.key, l.season)}
                className="rounded-md border border-border px-3 py-1.5 text-sm hover:border-antler-dim"
              >
                {l.name} ({l.season})
              </button>
            </li>
          ))}
        </ul>
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
