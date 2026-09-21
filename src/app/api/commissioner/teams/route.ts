import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireCommissioner } from "@/lib/current-manager";

export async function GET() {
  const teams = await prisma.team.findMany({ include: { manager: true }, orderBy: { name: "asc" } });
  return NextResponse.json({ teams });
}

export async function PATCH(req: Request) {
  const commissioner = await requireCommissioner();
  if (!commissioner) return NextResponse.json({ error: "Commissioner access required" }, { status: 403 });

  const { teamId, name, managerId } = await req.json();
  const before = await prisma.team.findUnique({ where: { id: teamId } });

  const team = await prisma.team.update({
    where: { id: teamId },
    data: { ...(name ? { name } : {}), ...(managerId ? { managerId } : {}) },
  });

  await prisma.auditLogEntry.create({
    data: {
      actorName: commissioner.name,
      action: "EDIT_TEAM",
      entityType: "Team",
      entityId: teamId,
      before: before as object,
      after: team as object,
    },
  });

  return NextResponse.json({ team });
}
