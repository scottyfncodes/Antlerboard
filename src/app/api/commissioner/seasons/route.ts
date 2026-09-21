import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireCommissioner } from "@/lib/current-manager";

export async function GET() {
  const seasons = await prisma.season.findMany({ orderBy: { year: "desc" } });
  return NextResponse.json({ seasons });
}

export async function PATCH(req: Request) {
  const commissioner = await requireCommissioner();
  if (!commissioner) return NextResponse.json({ error: "Commissioner access required" }, { status: 403 });

  const { seasonId, keeperDeadline, draftDate, status } = await req.json();
  const before = await prisma.season.findUnique({ where: { id: seasonId } });

  const season = await prisma.season.update({
    where: { id: seasonId },
    data: {
      ...(keeperDeadline ? { keeperDeadline: new Date(keeperDeadline) } : {}),
      ...(draftDate ? { draftDate: new Date(draftDate) } : {}),
      ...(status ? { status } : {}),
    },
  });

  await prisma.auditLogEntry.create({
    data: {
      actorName: commissioner.name,
      action: "EDIT_SEASON",
      entityType: "Season",
      entityId: seasonId,
      isHistoricalCorrection: true,
      before: before as object,
      after: season as object,
    },
  });

  return NextResponse.json({ season });
}
