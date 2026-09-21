import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getCurrentManager } from "@/lib/current-manager";

export async function GET() {
  const manager = await getCurrentManager();
  if (!manager) return NextResponse.json({ notifications: [], unreadCount: 0 });

  const [notifications, unreadCount] = await Promise.all([
    prisma.notification.findMany({
      where: { managerId: manager.id },
      orderBy: { createdAt: "desc" },
      take: 50,
    }),
    prisma.notification.count({ where: { managerId: manager.id, read: false } }),
  ]);

  return NextResponse.json({ notifications, unreadCount });
}

export async function POST(req: Request) {
  const manager = await getCurrentManager();
  if (!manager) return NextResponse.json({ error: "No current manager" }, { status: 400 });

  const body = await req.json().catch(() => ({}));

  if (body.markAllRead) {
    await prisma.notification.updateMany({
      where: { managerId: manager.id, read: false },
      data: { read: true },
    });
    return NextResponse.json({ ok: true });
  }

  if (body.id) {
    await prisma.notification.update({
      where: { id: body.id },
      data: { read: true },
    });
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: "Nothing to do" }, { status: 400 });
}
