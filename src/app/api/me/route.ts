import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getCurrentManager, MANAGER_COOKIE_NAME } from "@/lib/current-manager";

export async function GET() {
  const manager = await getCurrentManager();
  const allManagers = await prisma.manager.findMany({
    include: { teams: true },
    orderBy: { name: "asc" },
  });
  return NextResponse.json({ current: manager, managers: allManagers });
}

export async function POST(req: NextRequest) {
  const { managerId } = await req.json();
  const manager = await prisma.manager.findUnique({ where: { id: managerId } });
  if (!manager) {
    return NextResponse.json({ error: "Unknown manager" }, { status: 404 });
  }
  const res = NextResponse.json({ ok: true });
  res.cookies.set(MANAGER_COOKIE_NAME, managerId, {
    httpOnly: true,
    sameSite: "lax",
    maxAge: 60 * 60 * 24 * 365,
  });
  return res;
}
