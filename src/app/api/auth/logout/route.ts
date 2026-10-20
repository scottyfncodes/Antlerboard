import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE_NAME } from "@/lib/auth/session";

function clearSession(res: NextResponse) {
  res.cookies.set(SESSION_COOKIE_NAME, "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 0,
    path: "/",
  });
  return res;
}

export async function POST() {
  return clearSession(NextResponse.json({ ok: true }));
}

/** Where the app sends a browser whose session no longer resolves: clear it and sign in again. */
export async function GET(req: NextRequest) {
  return clearSession(NextResponse.redirect(new URL("/login", req.url)));
}
