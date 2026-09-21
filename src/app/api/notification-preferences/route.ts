import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getCurrentManager } from "@/lib/current-manager";
import { ensureDefaultPreferences } from "@/lib/notifications";

export async function GET() {
  const manager = await getCurrentManager();
  if (!manager) return NextResponse.json({ preferences: [] });

  await ensureDefaultPreferences(manager.id);
  const preferences = await prisma.notificationPreference.findMany({
    where: { managerId: manager.id },
    orderBy: [{ type: "asc" }, { channel: "asc" }],
  });
  return NextResponse.json({ preferences });
}

export async function PATCH(req: Request) {
  const manager = await getCurrentManager();
  if (!manager) return NextResponse.json({ error: "No current manager" }, { status: 400 });

  const { type, channel, enabled } = await req.json();
  const pref = await prisma.notificationPreference.upsert({
    where: { managerId_type_channel: { managerId: manager.id, type, channel } },
    create: { managerId: manager.id, type, channel, enabled },
    update: { enabled },
  });
  return NextResponse.json({ preference: pref });
}
