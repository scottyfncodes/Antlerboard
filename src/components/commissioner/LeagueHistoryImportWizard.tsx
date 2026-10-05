"use client";

import { useMemo, useState } from "react";
import type { LeagueHistoryPreview, KeeperCheck, CheckStatus } from "@/lib/import/league-history-builder";

interface Preview extends LeagueHistoryPreview {
  sources: {
    managerSheets: string[];
    auctionRows: number;
    yahooTransactions: number;
    yahooFlags: string[];
    franchisesWithTeams: string[];
  };
}

interface CommitResult {
  managersCreated: number;
  teamsCreated: number;
  playersCreated: number;
  playersMatched: number;
  acquisitionsWritten: number;
  dropsWritten: number;
  draftPicksWritten: number;
  keeperRecordsWritten: number;
  overridesApplied: number;
  historicalTradesResolved: number;
  previousImportRowsRemoved: number;
}

type Step = "upload" | "review" | "done";

const STATUS_LABEL: Record<CheckStatus, string> = {
  match: "matches the rule",
  mismatch: "differs from the rule",
  unmatched: "name not found",
  "not-computed": "no cost to compare",
};

export function LeagueHistoryImportWizard() {
  const [step, setStep] = useState<Step>("upload");
  const [files, setFiles] = useState<{ workbook?: File; auction?: File; yahoo?: File }>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [applyRecorded, setApplyRecorded] = useState(true);
  const [result, setResult] = useState<CommitResult | null>(null);
  const [seasonFilter, setSeasonFilter] = useState<number | "all">("all");

  const mismatches = useMemo(
    () => (preview?.keeperChecks ?? []).filter((c) => c.status === "mismatch" && (seasonFilter === "all" || c.season === seasonFilter)),
    [preview, seasonFilter]
  );
  const flagGroups = useMemo(() => {
    const groups = new Map<string, number>();
    for (const e of preview?.events ?? []) {
      for (const f of e.flags) {
        const key = f.replace(/\b(19|20)\d{2}\b/g, "YYYY").replace(/\b(Aaron|Andrew|Ed|Hugo|Jorge|Kurt|MattyJ|Michael|Neel|Scott|Tyler|Zach)\b/g, "a team").slice(0, 110);
        groups.set(key, (groups.get(key) ?? 0) + 1);
      }
    }
    return [...groups.entries()].sort((a, b) => b[1] - a[1]);
  }, [preview]);

  async function check() {
    if (!files.workbook || !files.auction || !files.yahoo) {
      setError("Pick all three files first.");
      return;
    }
    setBusy(true);
    setError(null);
    const fd = new FormData();
    fd.append("workbook", files.workbook);
    fd.append("auction", files.auction);
    fd.append("yahoo", files.yahoo);
    const res = await fetch("/api/commissioner/import/league-history/check", { method: "POST", body: fd });
    const data = await res.json();
    setBusy(false);
    if (!res.ok) {
      setError(data.error ?? "Could not build the preview.");
      return;
    }
    setPreview(data);
    setStep("review");
  }

  async function commit() {
    if (!preview) return;
    setBusy(true);
    setError(null);
    const res = await fetch("/api/commissioner/import/league-history/commit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...preview, applyRecordedKeeperCosts: applyRecorded }),
    });
    const data = await res.json();
    setBusy(false);
    if (!res.ok) {
      setError(data.error ?? "Import failed.");
      return;
    }
    setResult(data);
    setStep("done");
  }

  if (step === "upload") {
    return (
      <div className="rounded-xl border border-dashed border-border p-6 space-y-4">
        <p className="text-sm text-muted">
          Rebuilds every player&apos;s keeper history from three files. The keeper engine runs over the result and
          every place its number disagrees with the workbook is listed before anything is written.
        </p>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-sm">
          <FileField label="Master workbook (.xlsx)" hint="Official_Keeper_Costs - manager sheets, Off Season Trades, FYPD" accept=".xlsx" onChange={(f) => setFiles((s) => ({ ...s, workbook: f }))} />
          <FileField label="Auction history (.xlsx)" hint="Auctions_AllSeasons + Keepers_AllSeasons" accept=".xlsx" onChange={(f) => setFiles((s) => ({ ...s, auction: f }))} />
          <FileField label="Yahoo transactions (.csv)" hint="season, league_key, transaction_raw" accept=".csv" onChange={(f) => setFiles((s) => ({ ...s, yahoo: f }))} />
        </div>
        <button
          disabled={busy}
          onClick={check}
          className="rounded-md bg-antler px-3 py-2 text-sm font-medium text-[#1a1305] hover:bg-antler-strong disabled:opacity-50"
        >
          {busy ? "Building preview…" : "Build preview"}
        </button>
        {error && <p className="text-sm text-red">{error}</p>}
      </div>
    );
  }

  if (step === "review" && preview) {
    const kc = preview.summary.keeperChecks;
    const total = kc.match + kc.mismatch + kc.unmatched + kc["not-computed"];
    return (
      <div className="space-y-6">
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          <Stat label="Players" value={preview.summary.players} />
          <Stat label="Events" value={preview.summary.events} note={`${preview.summary.flaggedEvents} flagged`} />
          <Stat label="Draft picks" value={preview.summary.draftPicks} />
          <Stat label="Keeper costs matching the rule" value={kc.match} note={`of ${total}`} />
          <Stat label="Recorded costs that differ" value={kc.mismatch} warn={kc.mismatch > 0} />
        </div>

        <section className="rounded-xl border border-border bg-surface p-4 text-sm space-y-1.5">
          <p>
            <span className="font-medium">Sources:</span> {preview.sources.managerSheets.length} manager sheets, {preview.sources.auctionRows} auction rows,{" "}
            {preview.sources.yahooTransactions} Yahoo transactions. Seasons {preview.summary.seasons[0]}–{preview.summary.seasons.at(-1)}.
          </p>
          {preview.flags.map((f) => (
            <p key={f} className="text-muted">
              {f}
            </p>
          ))}
          {preview.sources.yahooFlags.slice(0, 5).map((f) => (
            <p key={f} className="text-yellow">
              {f}
            </p>
          ))}
          {preview.unresolvedTeams.length > 0 && (
            <p className="text-red">
              Team names that couldn&apos;t be resolved: {preview.unresolvedTeams.map((u) => `${u.name} (${u.source}, ×${u.count})`).join("; ")}
            </p>
          )}
        </section>

        <section>
          <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
            <h3 className="font-display text-lg">Recorded keeper costs that differ from the rule</h3>
            <div className="flex gap-1.5 flex-wrap">
              <FilterButton active={seasonFilter === "all"} onClick={() => setSeasonFilter("all")}>
                All
              </FilterButton>
              {preview.summary.seasons.map((s) => (
                <FilterButton key={s} active={seasonFilter === s} onClick={() => setSeasonFilter(s)}>
                  {s}
                </FilterButton>
              ))}
            </div>
          </div>
          <p className="text-sm text-muted mb-2">
            These are the only places the workbook and the +1/+3/+5/+7/+9 ladder disagree. With the box below checked, the
            workbook&apos;s number is kept for that season as a flagged commissioner override and the engine takes over from
            the following season.
          </p>
          {mismatches.length === 0 ? (
            <p className="text-sm text-muted">None.</p>
          ) : (
            <MismatchTable rows={mismatches} />
          )}
        </section>

        <section className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="rounded-xl border border-border bg-surface p-4">
            <h3 className="font-medium text-sm mb-2">Names that couldn&apos;t be matched ({preview.unmatchedPlayers.length})</h3>
            <p className="text-xs text-muted mb-2">
              Rows skipped because no player on that roster matched. Usually nicknames (&ldquo;CES&rdquo;), last-name-only trade
              entries, or a name typo. Fix in the workbook and re-run, or leave as is.
            </p>
            <ul className="text-xs space-y-0.5 max-h-56 overflow-y-auto">
              {preview.unmatchedPlayers.map((u) => (
                <li key={`${u.name}|${u.source}`}>
                  <span className="font-medium">{u.name}</span> <span className="text-muted">– {u.source}</span>
                </li>
              ))}
            </ul>
          </div>
          <div className="rounded-xl border border-border bg-surface p-4">
            <h3 className="font-medium text-sm mb-2">Assumptions the import had to make</h3>
            <p className="text-xs text-muted mb-2">Every flagged event is written with its note attached, so it can be found and corrected later.</p>
            <ul className="text-xs space-y-0.5 max-h-56 overflow-y-auto">
              {flagGroups.map(([text, n]) => (
                <li key={text}>
                  <span className="tabular font-medium">{n}×</span> <span className="text-muted">{text}</span>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <div className="rounded-xl border border-border p-4">
          <label className="flex items-start gap-2.5 text-sm cursor-pointer">
            <input type="checkbox" checked={applyRecorded} onChange={(e) => setApplyRecorded(e.target.checked)} className="mt-0.5" />
            <span>
              <span className="font-medium">Keep the workbook&apos;s recorded cost where it differs</span>{" "}
              <span className="text-muted">
                ({kc.mismatch} player-seasons). Recommended: the app should show what the league actually charged. Uncheck to
                let the ladder win everywhere.
              </span>
            </span>
          </label>
        </div>

        {error && <p className="text-sm text-red">{error}</p>}
        <div className="flex gap-2">
          <button onClick={() => setStep("upload")} className="rounded-md border border-border px-3 py-2 text-sm text-muted hover:text-foreground">
            Back
          </button>
          <button
            disabled={busy}
            onClick={commit}
            className="rounded-md bg-antler px-3 py-2 text-sm font-medium text-[#1a1305] hover:bg-antler-strong disabled:opacity-50"
          >
            {busy ? "Writing history…" : "Confirm & Commit"}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-green/40 bg-green/10 p-6 text-sm space-y-1.5">
      <p className="font-medium text-green">League history imported.</p>
      <p className="text-muted">
        {result?.playersCreated} players created, {result?.playersMatched} matched to existing records.
      </p>
      <p className="text-muted">
        {result?.acquisitionsWritten} acquisitions and trades, {result?.dropsWritten} drops, {result?.draftPicksWritten} draft picks.
      </p>
      <p className="text-muted">
        {result?.keeperRecordsWritten} keeper records rebuilt, {result?.overridesApplied} kept at the workbook&apos;s recorded cost.
      </p>
      {!!result?.historicalTradesResolved && <p className="text-muted">{result.historicalTradesResolved} trade-log entries linked to teams.</p>}
      {!!result?.previousImportRowsRemoved && <p className="text-muted">{result.previousImportRowsRemoved} rows from a previous run replaced.</p>}
    </div>
  );
}

function MismatchTable({ rows }: { rows: KeeperCheck[] }) {
  return (
    <div className="rounded-xl border border-border overflow-x-auto max-h-80 overflow-y-auto">
      <table className="w-full text-xs min-w-[520px]">
        <thead className="sticky top-0 bg-surface-raised">
          <tr className="text-left text-muted">
            <th className="px-2 py-2">Season</th>
            <th className="px-2 py-2">Team</th>
            <th className="px-2 py-2">Player (as written)</th>
            <th className="px-2 py-2 text-right">Workbook</th>
            <th className="px-2 py-2 text-right">Rule</th>
            <th className="px-2 py-2">Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-t border-border">
              <td className="px-2 py-1.5 tabular">{r.season}</td>
              <td className="px-2 py-1.5">{r.franchise}</td>
              <td className="px-2 py-1.5">{r.rawName}</td>
              <td className="px-2 py-1.5 tabular text-right">{r.recordedCost ?? "—"}</td>
              <td className="px-2 py-1.5 tabular text-right">{r.computedCost ?? "—"}</td>
              <td className="px-2 py-1.5 text-muted">{STATUS_LABEL[r.status]}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function FileField({ label, hint, accept, onChange }: { label: string; hint: string; accept: string; onChange: (f: File) => void }) {
  return (
    <label className="rounded-lg border border-border bg-surface p-3 block">
      <span className="font-medium block">{label}</span>
      <span className="text-xs text-muted block mb-2">{hint}</span>
      <input type="file" accept={accept} className="text-xs" onChange={(e) => e.target.files?.[0] && onChange(e.target.files[0])} />
    </label>
  );
}

function Stat({ label, value, note, warn }: { label: string; value: number; note?: string; warn?: boolean }) {
  return (
    <div className="rounded-xl border border-border bg-surface p-3">
      <p className={`font-display text-xl tabular ${warn ? "text-yellow" : ""}`}>{value}</p>
      <p className="text-xs text-muted mt-0.5">
        {label}
        {note ? ` · ${note}` : ""}
      </p>
    </div>
  );
}

function FilterButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`rounded-full px-2.5 py-1 text-xs border ${active ? "bg-antler border-antler text-[#1a1305] font-medium" : "border-border text-muted hover:text-foreground"}`}
    >
      {children}
    </button>
  );
}
