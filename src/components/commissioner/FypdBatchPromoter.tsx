"use client";

import { useState } from "react";

export interface PendingFypdBatch {
  id: string;
  label: string;
  sourceSheet: string;
  seasonYear: number | null;
  pickCount: number;
  notes: string | null;
}

interface PromotionResult {
  draftId: string;
  seasonYear: number;
  picksPromoted: number;
  playersCreated: number;
  skipped: { overallPickInSource: number | null; teamNameRaw: string | null; playerName: string | null; reason: string }[];
}

export function FypdBatchPromoter({ initialBatches }: { initialBatches: PendingFypdBatch[] }) {
  const [batches, setBatches] = useState(initialBatches);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, PromotionResult>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});

  async function promote(batchId: string) {
    setBusyId(batchId);
    setErrors((e) => ({ ...e, [batchId]: "" }));
    const res = await fetch("/api/commissioner/import/historical/fypd/promote", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ batchId }),
    });
    const data = await res.json();
    setBusyId(null);
    if (!res.ok) {
      setErrors((e) => ({ ...e, [batchId]: data.error ?? "Promotion failed." }));
      return;
    }
    setResults((r) => ({ ...r, [batchId]: data }));
    setBatches((bs) => bs.filter((b) => b.id !== batchId));
  }

  if (batches.length === 0 && Object.keys(results).length === 0) return null;

  return (
    <section className="space-y-3">
      <h2 className="font-display text-lg">Staged FYPD drafts</h2>
      <p className="text-sm text-muted">
        Picks parsed from the workbook, waiting to become a live draft. Promoting resolves each pick&apos;s team by
        manager name (the sheet never uses team names) and creates the players, so this only needs to run once per
        batch.
      </p>
      <div className="space-y-2">
        {batches.map((b) => (
          <div key={b.id} className="rounded-xl border border-border bg-surface p-4 flex items-center justify-between gap-4 flex-wrap">
            <div>
              <p className="font-medium">
                {b.label} <span className="text-muted font-normal">- {b.sourceSheet}</span>
              </p>
              <p className="text-sm text-muted">
                {b.seasonYear ?? "unconfirmed year"} - {b.pickCount} picks
                {b.notes ? ` - ${b.notes}` : ""}
              </p>
            </div>
            <button
              disabled={busyId === b.id}
              onClick={() => promote(b.id)}
              className="rounded-md bg-antler px-3 py-2 text-sm font-medium text-[#1a1305] hover:bg-antler-strong disabled:opacity-50"
            >
              {busyId === b.id ? "Promoting…" : "Promote to live draft"}
            </button>
            {errors[b.id] && <p className="text-sm text-red w-full">{errors[b.id]}</p>}
          </div>
        ))}
      </div>

      {Object.entries(results).map(([batchId, result]) => (
        <div key={batchId} className="rounded-xl border border-green/40 bg-green/10 p-4 text-sm space-y-1">
          <p className="font-medium text-green">
            {result.seasonYear} FYPD promoted: {result.picksPromoted} picks, {result.playersCreated} players created.
          </p>
          {result.skipped.length > 0 && (
            <div className="text-muted">
              <p>{result.skipped.length} pick(s) skipped, not guessed:</p>
              <ul className="list-disc list-inside">
                {result.skipped.map((s, i) => (
                  <li key={i}>
                    Pick {s.overallPickInSource ?? "?"} ({s.teamNameRaw ?? "?"} / {s.playerName ?? "?"}): {s.reason}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      ))}
    </section>
  );
}
