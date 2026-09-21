import { describe, it, expect, afterEach } from "vitest";
import { prisma } from "@/lib/db";
import { makeLeagueWithSeason, makeManagerAndTeam, resetDatabase } from "@/lib/test-helpers";
import { createSessionToken } from "@/lib/auth/session";
import { getCurrentManager, requireCommissioner } from "@/lib/current-manager";

/**
 * These are the exact functions every page and every commissioner-only API
 * route relies on for authorization - see the comment atop current-manager.ts.
 * Proving a manager token is rejected by requireCommissioner() here is
 * equivalent to proving it everywhere that guard is used.
 */
describe("getCurrentManager / requireCommissioner", () => {
  afterEach(async () => {
    await resetDatabase();
  });

  it("returns null with no session token (no more auto-login fallback)", async () => {
    // `null` simulates "checked cookies, found nothing" - the real no-args
    // form reads next/headers' cookies() directly, which only resolves
    // inside an actual Next.js request and isn't reachable from a plain
    // unit test (same limitation this module always had).
    expect(await getCurrentManager(null)).toBeNull();
  });

  it("resolves a valid manager session to that manager's row", async () => {
    const { league } = await makeLeagueWithSeason();
    const { manager } = await makeManagerAndTeam(league.id, "Regular Manager");
    const token = await createSessionToken(manager.id, "pin");

    const resolved = await getCurrentManager(token);
    expect(resolved?.id).toBe(manager.id);
  });

  it("rejects a tampered token", async () => {
    const { league } = await makeLeagueWithSeason();
    const { manager } = await makeManagerAndTeam(league.id, "Regular Manager");
    const token = await createSessionToken(manager.id, "pin");
    const tampered = token.slice(0, -2) + "zz";

    expect(await getCurrentManager(tampered)).toBeNull();
  });

  it("rejects a token for a manager who no longer exists", async () => {
    const token = await createSessionToken("nonexistent-manager-id", "pin");
    expect(await getCurrentManager(token)).toBeNull();
  });

  it("rejects a session for a manager who has since been deactivated", async () => {
    const { league } = await makeLeagueWithSeason();
    const { manager } = await makeManagerAndTeam(league.id, "Departing Manager");
    const token = await createSessionToken(manager.id, "pin");

    await prisma.manager.update({ where: { id: manager.id }, data: { active: false } });

    expect(await getCurrentManager(token)).toBeNull();
  });

  it("requireCommissioner rejects a regular manager", async () => {
    const { league } = await makeLeagueWithSeason();
    const { manager } = await makeManagerAndTeam(league.id, "Regular Manager", false);
    const token = await createSessionToken(manager.id, "pin");

    expect(await requireCommissioner(token)).toBeNull();
  });

  it("requireCommissioner accepts the commissioner", async () => {
    const { league } = await makeLeagueWithSeason();
    const { manager } = await makeManagerAndTeam(league.id, "The Commissioner", true);
    const token = await createSessionToken(manager.id, "pin");

    const resolved = await requireCommissioner(token);
    expect(resolved?.id).toBe(manager.id);
  });

  it("requireCommissioner rejects an unauthenticated request", async () => {
    expect(await requireCommissioner(null)).toBeNull();
  });
});
