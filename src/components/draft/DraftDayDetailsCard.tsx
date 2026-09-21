"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui/Card";
import { formatCost } from "@/lib/format";

interface Details {
  draftTime: string | null;
  venue: string | null;
  format: string | null;
  auctionBudget: number | null;
  nominationOrderNotes: string | null;
  rulesNotes: string | null;
  commissionerNotes: string | null;
}

export function DraftDayDetailsCard({
  seasonId,
  draftDate,
  details,
  canEdit,
}: {
  seasonId: string;
  draftDate: string | null;
  details: Details | null;
  canEdit: boolean;
}) {
  const [editing, setEditing] = useState(false);

  if (editing) {
    return <DraftDayDetailsEditor seasonId={seasonId} details={details} onDone={() => setEditing(false)} />;
  }

  const hasAnything =
    draftDate || details?.venue || details?.draftTime || details?.format || details?.auctionBudget ||
    details?.nominationOrderNotes || details?.rulesNotes || details?.commissionerNotes;

  return (
    <Card>
      <div className="flex items-center justify-between mb-2">
        <h2 className="font-display text-lg">Draft Day Details</h2>
        {canEdit && (
          <button onClick={() => setEditing(true)} className="text-xs text-antler hover:text-antler-strong">
            Edit
          </button>
        )}
      </div>
      {!hasAnything ? (
        <p className="text-sm text-muted">
          Nothing set for this draft yet.{canEdit ? " Click Edit to add the date, venue, budget, or house rules." : ""}
        </p>
      ) : (
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
          {draftDate && (
            <>
              <dt className="text-muted">Date</dt>
              <dd>{new Date(draftDate).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}</dd>
            </>
          )}
          {details?.draftTime && (
            <>
              <dt className="text-muted">Time</dt>
              <dd>{details.draftTime}</dd>
            </>
          )}
          {details?.venue && (
            <>
              <dt className="text-muted">Venue</dt>
              <dd>{details.venue}</dd>
            </>
          )}
          {details?.format && (
            <>
              <dt className="text-muted">Format</dt>
              <dd>{details.format}</dd>
            </>
          )}
          {details?.auctionBudget !== null && details?.auctionBudget !== undefined && (
            <>
              <dt className="text-muted">Auction Budget</dt>
              <dd>{formatCost(details.auctionBudget)} per team</dd>
            </>
          )}
          {details?.nominationOrderNotes && (
            <>
              <dt className="text-muted">Nomination Order</dt>
              <dd>{details.nominationOrderNotes}</dd>
            </>
          )}
          {details?.rulesNotes && (
            <>
              <dt className="text-muted">Rules</dt>
              <dd>{details.rulesNotes}</dd>
            </>
          )}
          {details?.commissionerNotes && (
            <>
              <dt className="text-muted">Commissioner Notes</dt>
              <dd>{details.commissionerNotes}</dd>
            </>
          )}
        </dl>
      )}
    </Card>
  );
}

function DraftDayDetailsEditor({
  seasonId,
  details,
  onDone,
}: {
  seasonId: string;
  details: Details | null;
  onDone: () => void;
}) {
  const router = useRouter();
  const [form, setForm] = useState({
    draftTime: details?.draftTime ?? "",
    venue: details?.venue ?? "",
    format: details?.format ?? "",
    auctionBudget: details?.auctionBudget?.toString() ?? "",
    nominationOrderNotes: details?.nominationOrderNotes ?? "",
    rulesNotes: details?.rulesNotes ?? "",
    commissionerNotes: details?.commissionerNotes ?? "",
  });
  const [saving, setSaving] = useState(false);

  function field(key: keyof typeof form, label: string, placeholder: string) {
    return (
      <label className="block text-xs text-muted">
        {label}
        <input
          value={form[key]}
          onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))}
          placeholder={placeholder}
          className="mt-1 w-full rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-foreground"
        />
      </label>
    );
  }

  async function save() {
    setSaving(true);
    await fetch("/api/commissioner/draft-day-details", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ seasonId, ...form }),
    });
    setSaving(false);
    onDone();
    router.refresh();
  }

  return (
    <Card>
      <h2 className="font-display text-lg mb-3">Draft Day Details</h2>
      <div className="space-y-2">
        {field("draftTime", "Time", "e.g. 7:00 PM ET")}
        {field("venue", "Venue", "e.g. Zoom, or someone's basement")}
        {field("format", "Format", "e.g. Live auction draft")}
        {field("auctionBudget", "Auction Budget (per team, $)", "e.g. 260")}
        {field("nominationOrderNotes", "Nomination Order", "e.g. Reverse standings order")}
        {field("rulesNotes", "Rules", "House rules specific to auction day")}
        {field("commissionerNotes", "Commissioner Notes", "Anything else worth flagging")}
      </div>
      <div className="flex gap-2 mt-3">
        <button
          disabled={saving}
          onClick={save}
          className="rounded-md bg-antler px-3 py-1.5 text-sm font-medium text-[#1a1305] hover:bg-antler-strong disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save"}
        </button>
        <button onClick={onDone} className="rounded-md border border-border px-3 py-1.5 text-sm text-muted hover:text-foreground">
          Cancel
        </button>
      </div>
    </Card>
  );
}
