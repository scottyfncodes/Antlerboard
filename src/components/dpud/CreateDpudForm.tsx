"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { sendJson } from "@/lib/call-api";

export function CreateDpudForm() {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [statCondition, setStatCondition] = useState("");
  const [stakes, setStakes] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  async function submit() {
    setBusy(true);
    setError(null);
    const res = await sendJson("/api/dpud", { title, description, statCondition, stakes, startDate, endDate });
    setBusy(false);
    if (!res.ok) {
      // Leave the form open and filled in so nothing has to be retyped.
      setError(res.error);
      return;
    }
    setOpen(false);
    setTitle("");
    setDescription("");
    setStatCondition("");
    setStakes("");
    router.refresh();
  }

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className="rounded-md bg-antler px-3 py-2 text-sm font-medium text-[#1a1305] hover:bg-antler-strong">
        New Prop Bet
      </button>
    );
  }

  return (
    <div className="rounded-xl border border-border bg-surface-raised p-4 space-y-2 w-full md:max-w-md">
      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Title"
        className="w-full rounded-md border border-border bg-surface px-2 py-1.5 text-sm"
      />
      <textarea
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="Description"
        rows={2}
        className="w-full rounded-md border border-border bg-surface px-2 py-1.5 text-sm"
      />
      <input
        value={statCondition}
        onChange={(e) => setStatCondition(e.target.value)}
        placeholder="Stat / condition (e.g. HR >= 35)"
        className="w-full rounded-md border border-border bg-surface px-2 py-1.5 text-sm"
      />
      <input
        value={stakes}
        onChange={(e) => setStakes(e.target.value)}
        placeholder="Stakes (optional)"
        className="w-full rounded-md border border-border bg-surface px-2 py-1.5 text-sm"
      />
      <div className="flex gap-2">
        <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} className="w-1/2 rounded-md border border-border bg-surface px-2 py-1.5 text-sm" />
        <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} className="w-1/2 rounded-md border border-border bg-surface px-2 py-1.5 text-sm" />
      </div>
      <div className="flex gap-2">
        <button
          disabled={busy || !title || !description || !statCondition || !startDate || !endDate}
          onClick={submit}
          className="rounded-md bg-antler px-3 py-1.5 text-sm font-medium text-[#1a1305] disabled:opacity-50"
        >
          {busy ? "Posting…" : "Post Bet"}
        </button>
        <button onClick={() => setOpen(false)} className="text-sm text-muted">
          Cancel
        </button>
      </div>
      {error && <p className="text-sm text-red">{error}</p>}
    </div>
  );
}
