import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export async function POST(req: Request) {
  const { endpoint } = await req.json();
  if (!endpoint) return NextResponse.json({ error: "Missing endpoint" }, { status: 400 });
  await prisma.pushSubscription.deleteMany({ where: { endpoint } });
  return NextResponse.json({ ok: true });
}
