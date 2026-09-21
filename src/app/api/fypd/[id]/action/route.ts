import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireCommissioner } from "@/lib/current-manager";
import {
  startFypdDraft,
  pauseFypdDraft,
  resumeFypdDraft,
  makeFypdSelection,
  undoLastFypdSelection,
  exerciseFypdCallUp,
  setDpudStatus,
  FypdActionError,
} from "@/lib/fypd";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const commissioner = await requireCommissioner();
  if (!commissioner) return NextResponse.json({ error: "Commissioner access required" }, { status: 403 });

  const body = await req.json();
  const { action } = body;

  try {
    if (action === "start") {
      await startFypdDraft(id);
      return NextResponse.json({ ok: true });
    }
    if (action === "pause") {
      await pauseFypdDraft(id);
      return NextResponse.json({ ok: true });
    }
    if (action === "resume") {
      await resumeFypdDraft(id);
      return NextResponse.json({ ok: true });
    }
    if (action === "select") {
      if (!body.playerId) return NextResponse.json({ error: "playerId is required" }, { status: 400 });
      const selection = await makeFypdSelection(id, body.playerId);
      return NextResponse.json({ ok: true, selection });
    }
    if (action === "undo") {
      const before = await prisma.fypdSelection.findFirst({ where: { draftId: id }, orderBy: { overallPick: "desc" } });
      await undoLastFypdSelection(id);
      await prisma.auditLogEntry.create({
        data: {
          actorName: commissioner.name,
          action: "UNDO_FYPD_SELECTION",
          entityType: "FypdSelection",
          entityId: before?.id,
          isHistoricalCorrection: true,
          before: (before as object) ?? undefined,
        },
      });
      return NextResponse.json({ ok: true });
    }
    if (action === "callup") {
      if (!body.selectionId) return NextResponse.json({ error: "selectionId is required" }, { status: 400 });
      await exerciseFypdCallUp(body.selectionId);
      return NextResponse.json({ ok: true });
    }
    if (action === "dpud") {
      if (!body.selectionId) return NextResponse.json({ error: "selectionId is required" }, { status: 400 });
      await setDpudStatus(body.selectionId, !!body.isDpud);
      return NextResponse.json({ ok: true });
    }
    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (err) {
    if (err instanceof FypdActionError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    throw err;
  }
}
