"use client";

import { useState } from "react";
import { parseCsv, guessMapping, IMPORT_FIELDS, type ImportFieldKey } from "@/lib/csv/parse";

interface CheckedRow {
  playerName?: string;
  mlbTeam?: string;
  positions?: string;
  teamName?: string;
  season?: string;
  method?: string;
  cost?: string;
  draftRound?: string;
  draftPick?: string;
  parsed: { playerName?: string; teamName?: string; season: number; method?: string; cost: number };
  teamId?: string;
  existingPlayerId?: string;
  errors: string[];
  conflict?: string;
  force?: boolean;
  exclude?: boolean;
}

type Step = "upload" | "map" | "review" | "done";

export function ImportWizard() {
  const [step, setStep] = useState<Step>("upload");
  const [headers, setHeaders] = useState<string[]>([]);
  const [rawRows, setRawRows] = useState<string[][]>([]);
  const [mapping, setMapping] = useState<Partial<Record<ImportFieldKey, number>>>({});
  const [checkedRows, setCheckedRows] = useState<CheckedRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [summary, setSummary] = useState<{ imported: number; skipped: number } | null>(null);

  function onFile(file: File) {
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result ?? "");
      const parsed = parseCsv(text);
      if (parsed.length === 0) return;
      const [head, ...rest] = parsed;
      setHeaders(head);
      setRawRows(rest);
      setMapping(guessMapping(head));
      setStep("map");
    };
    reader.readAsText(file);
  }

  async function runCheck() {
    setBusy(true);
    const rows = rawRows.map((r) => {
      const obj: Record<string, string> = {};
      for (const field of IMPORT_FIELDS) {
        const idx = mapping[field.key];
        if (idx !== undefined) obj[field.key] = r[idx] ?? "";
      }
      return obj;
    });

    const res = await fetch("/api/commissioner/import/check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rows }),
    });
    const data = await res.json();
    setCheckedRows(data.rows.map((r: CheckedRow) => ({ ...r, force: false, exclude: r.errors.length > 0 })));
    setBusy(false);
    setStep("review");
  }

  async function commit() {
    setBusy(true);
    const rows = checkedRows.filter((r) => !r.exclude);
    const res = await fetch("/api/commissioner/import/commit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        rows: rows.map((r) => ({
          teamId: r.teamId,
          season: r.parsed.season,
          method: r.parsed.method,
          cost: r.parsed.cost,
          playerName: r.parsed.playerName,
          mlbTeam: r.mlbTeam,
          positions: r.positions,
          draftRound: r.draftRound,
          draftPick: r.draftPick,
          existingPlayerId: r.existingPlayerId,
          conflict: r.conflict,
          force: r.force,
        })),
      }),
    });
    const data = await res.json();
    setSummary(data);
    setBusy(false);
    setStep("done");
  }

  if (step === "upload") {
    return (
      <div className="rounded-xl border border-dashed border-border p-8 text-center">
        <p className="text-sm text-muted mb-3">
          Upload a CSV of acquisition/keeper history — one row per player-season (draft, waiver, or free agent
          pickup).
        </p>
        <input
          type="file"
          accept=".csv,text/csv"
          onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])}
          className="text-sm"
        />
      </div>
    );
  }

  if (step === "map") {
    return (
      <div className="space-y-4">
        <p className="text-sm text-muted">
          Map your columns to Antlerboard fields. {rawRows.length} rows detected.
        </p>
        <div className="rounded-xl border border-border overflow-hidden">
          <table className="w-full text-sm">
            <tbody>
              {IMPORT_FIELDS.map((field) => (
                <tr key={field.key} className="border-t border-border first:border-0">
                  <td className="px-3 py-2 font-medium">
                    {field.label}
                    {field.required && <span className="text-red ml-1">*</span>}
                  </td>
                  <td className="px-3 py-2">
                    <select
                      value={mapping[field.key] ?? ""}
                      onChange={(e) =>
                        setMapping((prev) => ({
                          ...prev,
                          [field.key]: e.target.value === "" ? undefined : Number(e.target.value),
                        }))
                      }
                      className="rounded-md border border-border bg-surface px-2 py-1 text-sm"
                    >
                      <option value="">Not mapped</option>
                      {headers.map((h, i) => (
                        <option key={i} value={i}>
                          {h}
                        </option>
                      ))}
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <button
          disabled={busy || IMPORT_FIELDS.some((f) => f.required && mapping[f.key] === undefined)}
          onClick={runCheck}
          className="rounded-md bg-antler px-3 py-2 text-sm font-medium text-[#1a1305] disabled:opacity-50"
        >
          {busy ? "Checking…" : "Preview & Validate"}
        </button>
      </div>
    );
  }

  if (step === "review") {
    const errorCount = checkedRows.filter((r) => r.errors.length > 0).length;
    const conflictCount = checkedRows.filter((r) => r.conflict).length;
    const includedCount = checkedRows.filter((r) => !r.exclude).length;

    return (
      <div className="space-y-4">
        <p className="text-sm text-muted">
          {checkedRows.length} rows — {errorCount} with errors, {conflictCount} conflicts,{" "}
          {includedCount} will be imported.
        </p>
        <div className="rounded-xl border border-border overflow-x-auto max-h-[28rem] overflow-y-auto">
          <table className="w-full text-xs min-w-[720px]">
            <thead className="sticky top-0 bg-surface-raised">
              <tr className="text-left text-muted">
                <th className="px-2 py-2">Include</th>
                <th className="px-2 py-2">Player</th>
                <th className="px-2 py-2">Team</th>
                <th className="px-2 py-2">Season</th>
                <th className="px-2 py-2">Method</th>
                <th className="px-2 py-2">Cost</th>
                <th className="px-2 py-2">Issue</th>
              </tr>
            </thead>
            <tbody>
              {checkedRows.map((row, i) => (
                <tr
                  key={i}
                  className={`border-t border-border ${row.errors.length > 0 ? "bg-red/5" : row.conflict ? "bg-yellow/5" : ""}`}
                >
                  <td className="px-2 py-1.5">
                    <input
                      type="checkbox"
                      checked={!row.exclude}
                      disabled={row.errors.length > 0}
                      onChange={() =>
                        setCheckedRows((prev) =>
                          prev.map((r, idx) => (idx === i ? { ...r, exclude: !r.exclude } : r))
                        )
                      }
                    />
                  </td>
                  <td className="px-2 py-1.5">{row.parsed.playerName}</td>
                  <td className="px-2 py-1.5">{row.parsed.teamName}</td>
                  <td className="px-2 py-1.5 tabular">{row.parsed.season}</td>
                  <td className="px-2 py-1.5">{row.parsed.method}</td>
                  <td className="px-2 py-1.5 tabular">{row.parsed.cost}</td>
                  <td className="px-2 py-1.5">
                    {row.errors.length > 0 && <span className="text-red">{row.errors.join("; ")}</span>}
                    {row.conflict && !row.errors.length && (
                      <label className="flex items-center gap-1 text-yellow">
                        <input
                          type="checkbox"
                          checked={!!row.force}
                          onChange={() =>
                            setCheckedRows((prev) =>
                              prev.map((r, idx) => (idx === i ? { ...r, force: !r.force, exclude: r.force } : r))
                            )
                          }
                        />
                        {row.conflict} — import anyway
                      </label>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <button
          disabled={busy || includedCount === 0}
          onClick={commit}
          className="rounded-md bg-antler px-3 py-2 text-sm font-medium text-[#1a1305] disabled:opacity-50"
        >
          {busy ? "Importing…" : `Import ${includedCount} rows`}
        </button>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-green/40 bg-green/10 p-6 text-sm">
      <p className="font-medium text-green">Import complete.</p>
      <p className="text-muted mt-1">
        {summary?.imported} rows imported, {summary?.skipped} skipped.
      </p>
    </div>
  );
}
