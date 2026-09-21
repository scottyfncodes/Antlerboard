"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

interface SearchResults {
  players: { id: string; name: string; mlbTeam: string | null; team: string | null; keeperCost: number | null; keeperYear: number | null; yearsRemaining: number | null }[];
  teams: { id: string; name: string; manager: string }[];
  managers: { id: string; name: string; teamId: string | null; teamName: string | null }[];
  trades: { id: string; label: string; status: string }[];
  dpudBets: { id: string; title: string; status: string }[];
}

const EMPTY: SearchResults = { players: [], teams: [], managers: [], trades: [], dpudBets: [] };

export function SearchBox({ autoFocus }: { autoFocus?: boolean }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResults>(EMPTY);
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const router = useRouter();

  useEffect(() => {
    if (query.trim().length < 2) {
      setResults(EMPTY);
      return;
    }
    const controller = new AbortController();
    const t = setTimeout(() => {
      fetch(`/api/search?q=${encodeURIComponent(query)}`, { signal: controller.signal })
        .then((r) => r.json())
        .then(setResults)
        .catch(() => {});
    }, 200);
    return () => {
      clearTimeout(t);
      controller.abort();
    };
  }, [query]);

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  const hasResults =
    results.players.length ||
    results.teams.length ||
    results.managers.length ||
    results.trades.length ||
    results.dpudBets.length;

  return (
    <div ref={boxRef} className="relative">
      <input
        autoFocus={autoFocus}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        placeholder="Search players, teams, trades..."
        className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm placeholder:text-muted focus:outline-none focus:ring-1 focus:ring-antler"
      />
      {open && query.trim().length >= 2 && (
        <div className="absolute mt-1 w-full max-h-96 overflow-y-auto rounded-md border border-border bg-surface-raised shadow-xl z-50 text-sm">
          {!hasResults && <p className="p-3 text-muted">No matches for &ldquo;{query}&rdquo;.</p>}

          {results.players.length > 0 && (
            <SearchGroup title="Players">
              {results.players.map((p) => (
                <button
                  key={p.id}
                  className="flex w-full items-center justify-between px-3 py-2 hover:bg-surface text-left"
                  onClick={() => {
                    router.push(`/players/${p.id}`);
                    setOpen(false);
                  }}
                >
                  <span>
                    {p.name} <span className="text-muted">{p.mlbTeam}</span>
                  </span>
                  <span className="text-muted tabular text-xs">
                    {p.team ? `${p.team} · $${p.keeperCost} · Yr ${p.keeperYear} · ${p.yearsRemaining}y left` : "Unrostered"}
                  </span>
                </button>
              ))}
            </SearchGroup>
          )}

          {results.teams.length > 0 && (
            <SearchGroup title="Teams">
              {results.teams.map((t) => (
                <button
                  key={t.id}
                  className="flex w-full items-center justify-between px-3 py-2 hover:bg-surface text-left"
                  onClick={() => {
                    router.push(`/teams/${t.id}`);
                    setOpen(false);
                  }}
                >
                  <span>{t.name}</span>
                  <span className="text-muted text-xs">{t.manager}</span>
                </button>
              ))}
            </SearchGroup>
          )}

          {results.managers.length > 0 && (
            <SearchGroup title="Managers">
              {results.managers.map((m) => (
                <button
                  key={m.id}
                  className="flex w-full items-center justify-between px-3 py-2 hover:bg-surface text-left"
                  onClick={() => {
                    if (m.teamId) router.push(`/teams/${m.teamId}`);
                    setOpen(false);
                  }}
                >
                  <span>{m.name}</span>
                  <span className="text-muted text-xs">{m.teamName}</span>
                </button>
              ))}
            </SearchGroup>
          )}

          {results.trades.length > 0 && (
            <SearchGroup title="Trades">
              {results.trades.map((t) => (
                <button
                  key={t.id}
                  className="flex w-full items-center justify-between px-3 py-2 hover:bg-surface text-left"
                  onClick={() => {
                    router.push(`/trades`);
                    setOpen(false);
                  }}
                >
                  <span>{t.label}</span>
                  <span className="text-muted text-xs">{t.status}</span>
                </button>
              ))}
            </SearchGroup>
          )}

          {results.dpudBets.length > 0 && (
            <SearchGroup title="DPUD">
              {results.dpudBets.map((b) => (
                <button
                  key={b.id}
                  className="flex w-full items-center justify-between px-3 py-2 hover:bg-surface text-left"
                  onClick={() => {
                    router.push(`/dpud`);
                    setOpen(false);
                  }}
                >
                  <span>{b.title}</span>
                  <span className="text-muted text-xs">{b.status}</span>
                </button>
              ))}
            </SearchGroup>
          )}
        </div>
      )}
    </div>
  );
}

function SearchGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border-b border-border last:border-0">
      <p className="px-3 pt-2 text-[10px] font-semibold uppercase tracking-wide text-muted">{title}</p>
      {children}
    </div>
  );
}
