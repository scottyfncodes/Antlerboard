/**
 * Antlerboard is a small private-league tool, not a multi-tenant SaaS - see
 * spec section 42 (do not overbuild). Rather than a full auth system, each
 * browser remembers which manager it's acting as via a signed-free cookie
 * (there is nothing secret to protect beyond "don't let just anyone flip
 * the commissioner switch", which the /commissioner routes guard
 * separately). This is a deliberate, documented limitation - see the final
 * audit report - not an oversight.
 */

import { cookies } from "next/headers";
import { prisma } from "./db";

const COOKIE_NAME = "antlerboard_manager_id";

export async function getCurrentManager() {
  const cookieStore = await cookies();
  const managerId = cookieStore.get(COOKIE_NAME)?.value;

  if (managerId) {
    const manager = await prisma.manager.findUnique({
      where: { id: managerId },
      include: { teams: true },
    });
    if (manager) return manager;
  }

  // Default to the commissioner so a fresh browser always has someone
  // "logged in" for demo purposes.
  const commissioner = await prisma.manager.findFirst({
    where: { isCommissioner: true },
    include: { teams: true },
  });
  return commissioner;
}

export async function requireCommissioner() {
  const manager = await getCurrentManager();
  if (!manager?.isCommissioner) return null;
  return manager;
}

export { COOKIE_NAME as MANAGER_COOKIE_NAME };
