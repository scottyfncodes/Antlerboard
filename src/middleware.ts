/**
 * App-wide login gate. Antlerboard is shared with the whole league behind
 * one URL, so unlike the old "pick a manager from a dropdown" flow, every
 * page and API route now requires a real signed-in session before it's
 * reachable at all.
 *
 * This only checks that the session cookie is present and its signature/
 * expiry are valid - it deliberately does not touch the database (Prisma
 * doesn't run on the Edge runtime middleware executes in) and it does not
 * decide role-based access. That's intentional: this is the outer "are you
 * logged in at all" gate, not the security boundary for commissioner-only
 * actions. Every commissioner-only page and API route independently loads
 * the manager's current row and checks isCommissioner itself (see
 * requireCommissioner() in src/lib/current-manager.ts) - so even if this
 * middleware were ever bypassed, removed, or misconfigured, commissioner
 * actions still can't be reached by a manager who isn't one.
 */

import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE_NAME, verifySessionToken } from "@/lib/auth/session";

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|favicon-32.png|apple-icon.png|icon.svg|icon-192.png|icon-512.png|manifest.webmanifest|sw.js).*)",
  ],
};

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const token = req.cookies.get(SESSION_COOKIE_NAME)?.value;
  const session = await verifySessionToken(token);

  // The login/logout endpoints must stay reachable while logged out (and
  // logout must stay reachable while logged in).
  if (pathname.startsWith("/api/auth/")) {
    return NextResponse.next();
  }

  // Vercel Cron and the one-off admin seed route authenticate with their
  // own CRON_SECRET bearer token (checked independently inside each route)
  // rather than a manager session - Vercel's scheduler and a commissioner
  // curling the seed endpoint directly never carry a browser session
  // cookie, so gating these on one here would just lock the machinery out.
  if (pathname.startsWith("/api/cron/") || pathname.startsWith("/api/admin/")) {
    return NextResponse.next();
  }

  if (pathname === "/login") {
    if (session) return NextResponse.redirect(new URL("/", req.url));
    return NextResponse.next();
  }

  if (session) {
    return NextResponse.next();
  }

  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  const loginUrl = new URL("/login", req.url);
  loginUrl.searchParams.set("next", pathname);
  return NextResponse.redirect(loginUrl);
}
