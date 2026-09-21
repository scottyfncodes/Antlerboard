import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireCommissioner } from "@/lib/current-manager";

export async function PATCH(req: Request) {
  const commissioner = await requireCommissioner();
  if (!commissioner) return NextResponse.json({ error: "Commissioner access required" }, { status: 403 });

  const { seasonId, draftTime, venue, format, auctionBudget, nominationOrderNotes, rulesNotes, commissionerNotes } =
    await req.json();

  const before = await prisma.draftDayDetails.findUnique({ where: { seasonId } });

  const details = await prisma.draftDayDetails.upsert({
    where: { seasonId },
    create: {
      seasonId,
      draftTime: draftTime || null,
      venue: venue || null,
      format: format || null,
      auctionBudget: auctionBudget ? Number(auctionBudget) : null,
      nominationOrderNotes: nominationOrderNotes || null,
      rulesNotes: rulesNotes || null,
      commissionerNotes: commissionerNotes || null,
    },
    update: {
      draftTime: draftTime || null,
      venue: venue || null,
      format: format || null,
      auctionBudget: auctionBudget ? Number(auctionBudget) : null,
      nominationOrderNotes: nominationOrderNotes || null,
      rulesNotes: rulesNotes || null,
      commissionerNotes: commissionerNotes || null,
    },
  });

  await prisma.auditLogEntry.create({
    data: {
      actorName: commissioner.name,
      action: "EDIT_DRAFT_DAY_DETAILS",
      entityType: "DraftDayDetails",
      entityId: details.id,
      before: (before as object) ?? undefined,
      after: details as object,
    },
  });

  return NextResponse.json({ details });
}
