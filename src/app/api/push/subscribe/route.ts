import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getCurrentManager } from "@/lib/current-manager";

export async function POST(req: Request) {
  const manager = await getCurrentManager();
  if (!manager) return NextResponse.json({ error: "No current manager" }, { status: 400 });

  const subscription = await req.json();
  const endpoint: string = subscription.endpoint;
  const p256dh: string = subscription.keys?.p256dh;
  const auth: string = subscription.keys?.auth;

  if (!endpoint || !p256dh || !auth) {
    return NextResponse.json({ error: "Invalid subscription" }, { status: 400 });
  }

  await prisma.pushSubscription.upsert({
    where: { endpoint },
    create: { managerId: manager.id, endpoint, p256dh, auth },
    update: { managerId: manager.id, p256dh, auth },
  });

  return NextResponse.json({ ok: true });
}
