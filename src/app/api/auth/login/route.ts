import { NextRequest, NextResponse } from "next/server";
import { attemptPinLogin } from "@/lib/auth/login";
import { createSessionToken, SESSION_COOKIE_NAME, SESSION_MAX_AGE_SECONDS } from "@/lib/auth/session";
import { prisma } from "@/lib/db";

function clientIp(req: NextRequest): string {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  return req.headers.get("x-real-ip") ?? "unknown";
}

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  const pin = typeof body === "object" && body !== null && "pin" in body ? (body as { pin: unknown }).pin : undefined;
  const result = await attemptPinLogin(pin, clientIp(req));

  if (!result.ok) {
    if (result.reason === "locked") {
      return NextResponse.json(
        { error: "Too many attempts. Please wait before trying again." },
        { status: 429, headers: { "Retry-After": String(result.retryAfterSeconds) } }
      );
    }
    // Deliberately identical to the locked-but-wrong-pin case above in every
    // way that matters to the client: no hint of which part was wrong, no
    // mention of manager identity, no stack trace or implementation detail.
    return NextResponse.json({ error: "Incorrect PIN." }, { status: 401 });
  }

  const manager = await prisma.manager.findUnique({ where: { id: result.managerId } });
  if (!manager) {
    return NextResponse.json({ error: "Incorrect PIN." }, { status: 401 });
  }

  const token = await createSessionToken(result.managerId, result.provider);
  const res = NextResponse.json({
    ok: true,
    manager: { id: manager.id, name: manager.name, role: manager.isCommissioner ? "commissioner" : "manager" },
  });
  res.cookies.set(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: SESSION_MAX_AGE_SECONDS,
    path: "/",
  });
  return res;
}
