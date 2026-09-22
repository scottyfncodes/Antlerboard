"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { TriangleAlert, Copy, Check, KeyRound, RefreshCw, RotateCcw } from "lucide-react";
import type { ManagerRole } from "@/lib/auth/types";

interface ManagerRow {
  id: string;
  name: string;
  role: ManagerRole;
  hasPin: boolean;
}

interface GeneratedRow {
  managerId: string;
  name: string;
  role: ManagerRole;
  pin: string;
  status: "generated" | "reset";
}

type PendingAction = { type: "generate" } | { type: "reset-all" } | { type: "reset-one"; managerName: string };

async function callPinsApi(body: { action: string; managerName?: string }) {
  const res = await fetch("/api/commissioner/pins", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Something went wrong.");
  return data.rows as GeneratedRow[];
}

export function ManagerPinsPanel({ managers }: { managers: ManagerRow[] }) {
  const router = useRouter();
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<GeneratedRow[] | null>(null);
  const [selectedManager, setSelectedManager] = useState(managers[0]?.name ?? "");
  const [copied, setCopied] = useState<string | null>(null);

  const missingCount = managers.filter((m) => !m.hasPin).length;

  async function confirmAction(action: PendingAction) {
    setSubmitting(true);
    setError(null);
    setResult(null);
    try {
      const rows = await callPinsApi(
        action.type === "reset-one"
          ? { action: "reset-one", managerName: action.managerName }
          : { action: action.type }
      );
      if (rows.length === 0) {
        setError("Every manager already has a PIN. Use Reset All or reset one manager below to change any.");
      } else {
        setResult(rows);
      }
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setSubmitting(false);
      setPending(null);
    }
  }

  async function copy(key: string, text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      setTimeout(() => setCopied((c) => (c === key ? null : c)), 1500);
    } catch {
      setError("Couldn't copy automatically - select and copy the PIN by hand.");
    }
  }

  function copyAllText(rows: GeneratedRow[]): string {
    const lines = rows.map((r) => `${r.name}: ${r.pin}`);
    return ["Antlerboard manager PINs - distribute privately:", "", ...lines].join("\n");
  }

  return (
    <div className="space-y-6">
      <div className="rounded-xl border border-border bg-surface p-4">
        <p className="text-sm text-muted">
          {missingCount === 0
            ? "Every active manager has a PIN."
            : `${missingCount} of ${managers.length} managers don't have a PIN yet.`}
        </p>
      </div>

      {error && (
        <div className="rounded-xl border border-red/40 bg-red/10 px-4 py-3 text-sm text-red">{error}</div>
      )}

      {/* Generate */}
      <ActionSection
        icon={<KeyRound className="h-5 w-5" strokeWidth={2.25} />}
        title="Generate PINs"
        description="Creates a PIN for any manager who doesn't have one yet. Managers who already have a PIN keep it."
        pending={pending?.type === "generate"}
        submitting={submitting}
        confirmLabel="Yes, generate PINs"
        confirmDescription="This creates new PINs for managers without one. Nothing changes for anyone who already has a PIN."
        onStart={() => setPending({ type: "generate" })}
        onCancel={() => setPending(null)}
        onConfirm={() => confirmAction({ type: "generate" })}
        buttonLabel="Generate PINs"
      />

      {/* Reset all */}
      <ActionSection
        icon={<RefreshCw className="h-5 w-5" strokeWidth={2.25} />}
        title="Reset All PINs"
        description="Replaces every manager's PIN, including the commissioner's. Old PINs stop working immediately."
        pending={pending?.type === "reset-all"}
        submitting={submitting}
        confirmLabel="Yes, reset every PIN"
        confirmDescription="This replaces EVERY manager's PIN right now, including yours. Anyone signed in stays signed in, but their old PIN won't work again - you'll need to redistribute all 12. This can't be undone."
        destructive
        onStart={() => setPending({ type: "reset-all" })}
        onCancel={() => setPending(null)}
        onConfirm={() => confirmAction({ type: "reset-all" })}
        buttonLabel="Reset All PINs"
      />

      {/* Reset one */}
      <div className="rounded-xl border border-border bg-surface p-4 space-y-3">
        <div className="flex items-center gap-2">
          <RotateCcw className="h-5 w-5 text-antler" strokeWidth={2.25} />
          <p className="font-display text-base">Reset One Manager&apos;s PIN</p>
        </div>
        <p className="text-sm text-muted">Use this when someone forgets their PIN. Only their PIN changes.</p>
        <select
          value={selectedManager}
          onChange={(e) => setSelectedManager(e.target.value)}
          disabled={submitting}
          className="w-full rounded-lg border border-border bg-surface-raised px-3 py-3 text-base"
        >
          {managers.map((m) => (
            <option key={m.id} value={m.name}>
              {m.name} {m.role === "commissioner" ? "(Commissioner)" : ""} {m.hasPin ? "" : "- no PIN yet"}
            </option>
          ))}
        </select>
        {pending?.type === "reset-one" ? (
          <ConfirmPanel
            description={`This replaces ${selectedManager}'s PIN right now. Their old PIN won't work again.`}
            confirmLabel={`Yes, reset ${selectedManager}'s PIN`}
            submitting={submitting}
            onCancel={() => setPending(null)}
            onConfirm={() => confirmAction({ type: "reset-one", managerName: selectedManager })}
          />
        ) : (
          <button
            onClick={() => setPending({ type: "reset-one", managerName: selectedManager })}
            disabled={submitting || !selectedManager}
            className="w-full rounded-lg bg-antler px-4 py-3 text-base font-medium text-[#1a1305] disabled:opacity-50"
          >
            Reset {selectedManager || "manager"}&apos;s PIN
          </button>
        )}
      </div>

      {/* Result */}
      {result && (
        <div className="rounded-xl border border-antler-dim bg-surface p-4 space-y-4">
          <div className="flex items-start gap-2 rounded-lg border border-yellow/40 bg-yellow/10 px-3 py-2.5 text-sm text-yellow">
            <TriangleAlert className="h-5 w-5 shrink-0" strokeWidth={2.25} />
            <p>
              Distribute these PINs privately, one at a time. They won&apos;t be shown again once you leave or
              refresh this page.
            </p>
          </div>

          <button
            onClick={() => copy("all", copyAllText(result))}
            className="w-full flex items-center justify-center gap-2 rounded-lg border border-border bg-surface-raised px-4 py-3 text-base font-medium hover:border-antler-dim"
          >
            {copied === "all" ? <Check className="h-5 w-5" strokeWidth={2.5} /> : <Copy className="h-5 w-5" strokeWidth={2.25} />}
            {copied === "all" ? "Copied all" : "Copy All"}
          </button>

          <ul className="space-y-2">
            {result.map((row) => (
              <li
                key={row.managerId}
                className="flex items-center justify-between gap-3 rounded-lg border border-border bg-surface-raised px-4 py-3"
              >
                <div className="min-w-0">
                  <p className="font-medium truncate">
                    {row.name} {row.role === "commissioner" && <span className="text-xs text-muted">(Commissioner)</span>}
                  </p>
                  <p className="font-mono text-2xl tracking-widest tabular-nums">{row.pin}</p>
                </div>
                <button
                  onClick={() => copy(row.managerId, row.pin)}
                  aria-label={`Copy ${row.name}'s PIN`}
                  className="shrink-0 flex items-center gap-1.5 rounded-lg border border-border px-3 py-2.5 text-sm font-medium hover:border-antler-dim"
                >
                  {copied === row.managerId ? (
                    <Check className="h-5 w-5" strokeWidth={2.5} />
                  ) : (
                    <Copy className="h-5 w-5" strokeWidth={2.25} />
                  )}
                  {copied === row.managerId ? "Copied" : "Copy"}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function ActionSection({
  icon,
  title,
  description,
  pending,
  submitting,
  confirmLabel,
  confirmDescription,
  destructive,
  onStart,
  onCancel,
  onConfirm,
  buttonLabel,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  pending: boolean;
  submitting: boolean;
  confirmLabel: string;
  confirmDescription: string;
  destructive?: boolean;
  onStart: () => void;
  onCancel: () => void;
  onConfirm: () => void;
  buttonLabel: string;
}) {
  return (
    <div className="rounded-xl border border-border bg-surface p-4 space-y-3">
      <div className="flex items-center gap-2">
        <span className={destructive ? "text-red" : "text-antler"}>{icon}</span>
        <p className="font-display text-base">{title}</p>
      </div>
      <p className="text-sm text-muted">{description}</p>
      {pending ? (
        <ConfirmPanel
          description={confirmDescription}
          confirmLabel={confirmLabel}
          submitting={submitting}
          destructive={destructive}
          onCancel={onCancel}
          onConfirm={onConfirm}
        />
      ) : (
        <button
          onClick={onStart}
          disabled={submitting}
          className={
            destructive
              ? "w-full rounded-lg border border-red/50 px-4 py-3 text-base font-medium text-red disabled:opacity-50"
              : "w-full rounded-lg bg-antler px-4 py-3 text-base font-medium text-[#1a1305] disabled:opacity-50"
          }
        >
          {buttonLabel}
        </button>
      )}
    </div>
  );
}

function ConfirmPanel({
  description,
  confirmLabel,
  submitting,
  destructive,
  onCancel,
  onConfirm,
}: {
  description: string;
  confirmLabel: string;
  submitting: boolean;
  destructive?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="rounded-lg border border-dashed border-border bg-surface-raised p-3 space-y-3">
      <p className="text-sm">{description}</p>
      <div className="grid grid-cols-2 gap-2">
        <button
          onClick={onCancel}
          disabled={submitting}
          className="rounded-lg border border-border px-4 py-3 text-base font-medium disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          onClick={onConfirm}
          disabled={submitting}
          className={
            destructive
              ? "rounded-lg bg-red px-4 py-3 text-base font-medium text-white disabled:opacity-50"
              : "rounded-lg bg-antler px-4 py-3 text-base font-medium text-[#1a1305] disabled:opacity-50"
          }
        >
          {submitting ? "Working..." : confirmLabel}
        </button>
      </div>
    </div>
  );
}
