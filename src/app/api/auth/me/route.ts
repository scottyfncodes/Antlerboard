import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { SESSION_COOKIE_NAME, verifySessionToken } from "@/lib/auth/session";

export async function GET(req: NextRequest) {
  const token = req.cookies.get(SESSION_COOKIE_NAME)?.value;
  const session = await verifySessionToken(token);
  if (!session) return NextResponse.json({ authenticated: false });

  const manager = await prisma.manager.findUnique({ where: { id: session.managerId } });
  if (!manager || !manager.active) return NextResponse.json({ authenticated: false });

  return NextResponse.json({
    authenticated: true,
    manager: { id: manager.id, name: manager.name, role: manager.isCommissioner ? "commissioner" : "manager" },
    provider: session.provider,
  });
}
