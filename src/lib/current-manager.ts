/**
 * The authenticated-manager guard used by every Server Component page and,
 * indirectly, every commissioner-only API route (see requireCommissioner()).
 *
 * Each of the 12 C&A managers authenticates with their own 4-digit PIN (see
 * src/lib/auth/*) and gets a signed session cookie identifying them - see
 * src/middleware.ts, which is what actually keeps a logged-out browser off
 * every page in the first place. This module is the second, independent
 * check: even if middleware were ever bypassed or misconfigured, no
 * commissioner-only action executes without requireCommissioner() itself
 * loading the manager's row fresh from the database and checking
 * isCommissioner - the tab being hidden in the nav is not the security
 * boundary.
 *
 * `tokenOverride` exists only so tests can exercise this exact
 * authorization logic (real DB row, real signed token, real role check)
 * without needing a full Next.js request context - next/headers' cookies()
 * only works inside one. Every real caller omits it and gets the cookie
 * from the current request as normal.
 */

import { cookies } from "next/headers";
import { prisma } from "./db";
import { SESSION_COOKIE_NAME, verifySessionToken } from "./auth/session";

export async function getCurrentManager(tokenOverride?: string | null) {
  const token = tokenOverride !== undefined ? tokenOverride : (await cookies()).get(SESSION_COOKIE_NAME)?.value;
  const session = await verifySessionToken(token);
  if (!session) return null;

  const manager = await prisma.manager.findUnique({
    where: { id: session.managerId },
    include: { teams: true },
  });
  if (!manager || !manager.active) return null;
  return manager;
}

export async function requireCommissioner(tokenOverride?: string | null) {
  const manager = await getCurrentManager(tokenOverride);
  if (!manager?.isCommissioner) return null;
  return manager;
}
