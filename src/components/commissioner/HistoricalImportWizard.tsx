"use client";

import { useState } from "react";
import type {
  ResolvedTeamSeasonRecord,
  ParsedTrade,
  ParsedPropBet,
  ParsedDraftDayEvent,
  ParsedFypdSection,
} from "@/lib/import/types";

interface Preview {
  teamSeasons: ResolvedTeamSeasonRecord[];
  trades: ParsedTrade[];
  propBets: ParsedPropBet[];
  draftDayEvents: ParsedDraftDayEvent[];
  fypdSections: ParsedFypdSection[];
  summary: {
    totalTeamSeasons: number;
    uniqueManagers: number;
    confirmedHandoff: number;
    confirmedOriginal: number;
    inferredContinuous: number;
    unattributed: number;
    totalPropBets: number;
    unattributedPropBets: number;
    totalTrades: number;
    unattributedTrades: number;
    totalFypdPicks: number;
  };
}

interface CommitSummary {
  teamSeasonsWritten: number;
  tradesWritten: number;
  propBetsWritten: number;
  draftDaysWritten: number;
  fypdBatchesWritten: number;
  demoCleanup: { managersDeleted: number; teamsDeleted: number; playersDeleted: number; seasonsDeleted: number } | null;
  newCommissionerName: string | null;
}

type Step = "upload" | "review" | "done";

const ATTRIBUTION_LABEL: Record<string, string> = {
  confirmed_handoff: "Confirmed handoff",
  confirmed_original: "Confirmed original",
  inferred_continuous: "Inferred continuous",
  unattributed: "Unattributed",
};

const ATTRIBUTION_VARIANT: Record<string, string> = {
  confirmed_handoff: "bg-green/15 text-green border-green/40",
  confirmed_original: "bg-green/15 text-green border-green/40",
  inferred_continuous: "bg-yellow/15 text-yellow border-yellow/40",
  unattributed: "bg-red/15 text-red border-red/40",
};

export function HistoricalImportWizard() {
  const [step, setStep] = useState<Step>("upload");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [commitSummary, setCommitSummary] = useState<CommitSummary | null>(null);
  const [managerFilter, setManagerFilter] = useState("all");
  const [clearDemoData, setClearDemoData] = useState(true);

  async function onFile(file: File) {
    setBusy(true);
    setError(null);
    const fd = new FormData();
    fd.append("file", file);
    const res = await fetch("/api/commissioner/import/historical/check", { method: "POST", body: fd });
    const data = await res.json();
    setBusy(false);
    if (!res.ok) {
      setError(data.error ?? "Could not parse that file.");
      return;
    }
    setPreview(data);
    setStep("review");
  }

  async function commit() {
    if (!preview) return;
    setBusy(true);
    const res = await fetch("/api/commissioner/import/historical/commit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...preview, clearDemoData }),
    });
    const data = await res.json();
    setBusy(false);
    setCommitSummary(data);
    setStep("done");
  }

  if (step === "upload") {
    return (
      <div className="rounded-xl border border-dashed border-border p-8 text-center">
        <p className="text-sm text-muted mb-3">
          Upload the historical league workbook (.xlsx) - team-season history, trades, prop bets, draft weekends,
          and FYPD. Nothing is written until you review this preview and confirm.
        </p>
        <input
          type="file"
          accept=".xlsx"
          onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])}
          className="text-sm"
          disabled={busy}
        />
        {busy && <p className="text-sm text-muted mt-2">Reading workbook…</p>}
        {error && <p className="text-sm text-red mt-2">{error}</p>}
      </div>
    );
  }

  if (step === "review" && preview) {
    const managers = [...new Set(preview.teamSeasons.map((r) => r.managerSheetName))];
    const filtered = preview.teamSeasons.filter((r) => managerFilter === "all" || r.managerSheetName === managerFilter);

    return (
      <div className="space-y-6">
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          <Stat label="Team-seasons" value={preview.summary.totalTeamSeasons} />
          <Stat label="Franchises" value={preview.summary.uniqueManagers} />
          <Stat label="Confirmed handoffs" value={preview.summary.confirmedHandoff} />
          <Stat label="Inferred continuous" value={preview.summary.inferredContinuous} />
          <Stat label="Unattributed" value={preview.summary.unattributed} warn={preview.summary.unattributed > 0} />
        </div>

        <section>
          <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
            <h2 className="font-display text-lg">Team-season history</h2>
            <div className="flex gap-1.5 flex-wrap">
              <FilterButton active={managerFilter === "all"} onClick={() => setManagerFilter("all")}>
                All
              </FilterButton>
              {managers.map((m) => (
                <FilterButton key={m} active={managerFilter === m} onClick={() => setManagerFilter(m)}>
                  {m}
                </FilterButton>
              ))}
            </div>
          </div>
          <div className="rounded-xl border border-border overflow-x-auto max-h-96 overflow-y-auto">
            <table className="w-full text-xs min-w-[640px]">
              <thead className="sticky top-0 bg-surface-raised">
                <tr className="text-left text-muted">
                  <th className="px-2 py-2">Sheet</th>
                  <th className="px-2 py-2">Season</th>
                  <th className="px-2 py-2">Team name</th>
                  <th className="px-2 py-2">Ran by</th>
                  <th className="px-2 py-2">Finish</th>
                  <th className="px-2 py-2">Status</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((r, i) => (
                  <tr key={i} className="border-t border-border">
                    <td className="px-2 py-1.5">{r.managerSheetName}</td>
                    <td className="px-2 py-1.5 tabular">{r.seasonYear ?? "?"}</td>
                    <td className="px-2 py-1.5">{r.teamName}</td>
                    <td className="px-2 py-1.5">
                      {r.resolvedManagerName}
                      {r.resolvedManagerName !== r.managerSheetName && (
                        <span className="text-muted"> (predecessor)</span>
                      )}
                    </td>
                    <td className="px-2 py-1.5">{r.finish ?? "—"}</td>
                    <td className="px-2 py-1.5">
                      <span className={`inline-flex rounded-full border px-2 py-0.5 text-[10px] font-medium ${ATTRIBUTION_VARIANT[r.attribution]}`}>
                        {ATTRIBUTION_LABEL[r.attribution]}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <SummaryCard
            title="Trades"
            count={preview.summary.totalTrades}
            note={`${preview.summary.unattributedTrades} without a season year`}
          />
          <SummaryCard
            title="Prop bets"
            count={preview.summary.totalPropBets}
            note={`${preview.summary.unattributedPropBets} without a season year`}
          />
          <SummaryCard
            title="Draft weekends"
            count={preview.draftDayEvents.length}
            note={preview.draftDayEvents.map((d) => d.seasonYear ?? "?").join(", ") || "none found"}
          />
          <SummaryCard
            title="FYPD picks (staged, not yet a live draft)"
            count={preview.summary.totalFypdPicks}
            note={preview.fypdSections.map((s) => `${s.label}: ${s.seasonYear ?? "unconfirmed"}`).join(" · ")}
          />
        </section>

        <div className="rounded-xl border border-red/40 bg-red/10 p-4">
          <label className="flex items-start gap-2.5 text-sm cursor-pointer">
            <input
              type="checkbox"
              checked={clearDemoData}
              onChange={(e) => setClearDemoData(e.target.checked)}
              className="mt-0.5"
            />
            <span>
              <span className="font-medium text-foreground">Also remove Antlerboard&apos;s existing demo league</span>{" "}
              <span className="text-muted">
                - the 10 fictional teams/managers/players it ships with, plus anything else currently in this league
                (transactions, DPUD bets, notifications, etc). League config itself is kept. This only needs to
                happen once, on the import that replaces the demo data with your real history - leave it unchecked
                if you&apos;re re-running an import after the real data is already in place.
              </span>
            </span>
          </label>
        </div>

        <div className="flex gap-2">
          <button onClick={() => setStep("upload")} className="rounded-md border border-border px-3 py-2 text-sm text-muted hover:text-foreground">
            Back
          </button>
          <button
            disabled={busy}
            onClick={commit}
            className="rounded-md bg-antler px-3 py-2 text-sm font-medium text-[#1a1305] hover:bg-antler-strong disabled:opacity-50"
          >
            {busy ? "Committing…" : "Confirm & Commit"}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-green/40 bg-green/10 p-6 text-sm space-y-1.5">
      <p className="font-medium text-green">Import complete.</p>
      <p className="text-muted">{commitSummary?.teamSeasonsWritten} team-season records written.</p>
      <p className="text-muted">{commitSummary?.tradesWritten} historical trades, {commitSummary?.propBetsWritten} historical prop bets.</p>
      <p className="text-muted">{commitSummary?.draftDaysWritten} draft-day record(s), {commitSummary?.fypdBatchesWritten} FYPD batch(es) staged for review.</p>
      {commitSummary?.demoCleanup && (
        <p className="text-muted">
          Demo data removed: {commitSummary.demoCleanup.managersDeleted} managers, {commitSummary.demoCleanup.teamsDeleted} teams,{" "}
          {commitSummary.demoCleanup.playersDeleted} players, {commitSummary.demoCleanup.seasonsDeleted} seasons.
        </p>
      )}
      {commitSummary?.newCommissionerName && (
        <p className="text-muted">Commissioner access carried over to <strong>{commitSummary.newCommissionerName}</strong>.</p>
      )}
    </div>
  );
}

function Stat({ label, value, warn }: { label: string; value: number; warn?: boolean }) {
  return (
    <div className="rounded-xl border border-border bg-surface p-3">
      <p className={`font-display text-xl tabular ${warn ? "text-red" : ""}`}>{value}</p>
      <p className="text-xs text-muted mt-0.5">{label}</p>
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

function SummaryCard({ title, count, note }: { title: string; count: number; note: string }) {
  return (
    <div className="rounded-xl border border-border bg-surface p-4">
      <p className="text-sm font-medium">{title}</p>
      <p className="font-display text-2xl tabular mt-1">{count}</p>
      <p className="text-xs text-muted mt-1">{note}</p>
    </div>
  );
}
