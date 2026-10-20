import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireCommissioner } from "@/lib/current-manager";

/**
 * Blank means "no budget set" (null). Anything else must be a whole,
 * non-negative dollar amount - returns undefined for invalid input so the
 * route can answer 400 instead of letting Prisma throw a 500 on NaN.
 */
function parseAuctionBudget(raw: unknown): number | null | undefined {
  if (raw === null || raw === undefined) return null;
  const text = String(raw).trim();
  if (text === "") return null;
  if (!/^\d+$/.test(text)) return undefined;
  const n = Number(text);
  return Number.isSafeInteger(n) && n <= 2_147_483_647 ? n : undefined;
}

export async function PATCH(req: Request) {
  const commissioner = await requireCommissioner();
  if (!commissioner) return NextResponse.json({ error: "Commissioner access required" }, { status: 403 });

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }
  const { seasonId, draftTime, venue, format, nominationOrderNotes, rulesNotes, commissionerNotes } = body;
  if (typeof seasonId !== "string" || !seasonId) {
    return NextResponse.json({ error: "seasonId is required" }, { status: 400 });
  }
  const auctionBudget = parseAuctionBudget(body.auctionBudget);
  if (auctionBudget === undefined) {
    return NextResponse.json(
      { error: "Auction budget must be a whole dollar amount (e.g. 260), or left blank" },
      { status: 400 }
    );
  }

  const before = await prisma.draftDayDetails.findUnique({ where: { seasonId } });

  const details = await prisma.draftDayDetails.upsert({
    where: { seasonId },
    create: {
      seasonId,
      draftTime: draftTime || null,
      venue: venue || null,
      format: format || null,
      auctionBudget,
      nominationOrderNotes: nominationOrderNotes || null,
      rulesNotes: rulesNotes || null,
      commissionerNotes: commissionerNotes || null,
    },
    update: {
      draftTime: draftTime || null,
      venue: venue || null,
      format: format || null,
      auctionBudget,
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
