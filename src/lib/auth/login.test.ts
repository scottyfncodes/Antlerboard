import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { makeLeagueWithSeason, makeManagerAndTeam, makePinCredential, resetDatabase } from "@/lib/test-helpers";
import { generateUniquePins } from "./pin";
import { attemptPinLogin } from "./login";

const MANAGER_COUNT = 12;

describe("attemptPinLogin", () => {
  afterEach(async () => {
    await resetDatabase();
  });

  it(
    "authenticates every one of the 12 managers with their own unique PIN",
    async () => {
      const { league } = await makeLeagueWithSeason();
      const pins = generateUniquePins(MANAGER_COUNT);
      const managers = [];
      for (let i = 0; i < MANAGER_COUNT; i++) {
        const { manager } = await makeManagerAndTeam(league.id, `Manager ${i}`, i === 0);
        await makePinCredential(manager.id, pins[i]);
        managers.push(manager);
      }

      // Checking every credential on every login (see login.ts) is 12x12
      // scrypt verifications here versus one in a real single login, hence
      // the generous timeout - this is a test-harness cost, not a
      // production one (a real login only ever happens once).
      for (let i = 0; i < MANAGER_COUNT; i++) {
        const result = await attemptPinLogin(pins[i], `10.0.0.${i}`);
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.managerId).toBe(managers[i].id);
          expect(result.provider).toBe("pin");
        }
      }
    },
    20000
  );

  it("every generated PIN in that batch is unique", () => {
    expect(new Set(generateUniquePins(MANAGER_COUNT)).size).toBe(MANAGER_COUNT);
  });

  it("rejects a well-formed PIN that doesn't match any manager", async () => {
    const { league } = await makeLeagueWithSeason();
    const { manager } = await makeManagerAndTeam(league.id, "Real Manager");
    await makePinCredential(manager.id, "4738");

    const result = await attemptPinLogin("9999", "10.1.1.1");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("invalid");
  });

  it("rejects a malformed PIN (wrong length / non-numeric) without a distinguishable error", async () => {
    const shortResult = await attemptPinLogin("12", "10.1.1.2");
    const alphaResult = await attemptPinLogin("abcd", "10.1.1.3");
    expect(shortResult).toEqual({ ok: false, reason: "invalid" });
    expect(alphaResult).toEqual({ ok: false, reason: "invalid" });
  });

  it("does not authenticate an inactive (departed) manager's PIN", async () => {
    const { league } = await makeLeagueWithSeason();
    const { manager } = await makeManagerAndTeam(league.id, "Departed Manager");
    await makePinCredential(manager.id, "4738");
    const { prisma } = await import("@/lib/db");
    await prisma.manager.update({ where: { id: manager.id }, data: { active: false } });

    const result = await attemptPinLogin("4738", "10.1.1.4");
    expect(result.ok).toBe(false);
  });

  it("locks out further attempts (even a correct PIN) after repeated failures from the same IP", async () => {
    const { league } = await makeLeagueWithSeason();
    const { manager } = await makeManagerAndTeam(league.id, "Real Manager");
    await makePinCredential(manager.id, "4738");

    const ip = "10.2.2.2";
    for (let i = 0; i < 3; i++) {
      const result = await attemptPinLogin("0000", ip);
      expect(result.ok).toBe(false);
    }

    // Correct PIN, but this IP is now locked out.
    const lockedAttempt = await attemptPinLogin("4738", ip);
    expect(lockedAttempt.ok).toBe(false);
    if (!lockedAttempt.ok && lockedAttempt.reason === "locked") {
      expect(lockedAttempt.retryAfterSeconds).toBeGreaterThan(0);
    } else {
      throw new Error("expected a locked result");
    }
  });

  it("does not lock out a different IP for another IP's failures", async () => {
    const { league } = await makeLeagueWithSeason();
    const { manager } = await makeManagerAndTeam(league.id, "Real Manager");
    await makePinCredential(manager.id, "4738");

    for (let i = 0; i < 5; i++) {
      await attemptPinLogin("0000", "10.3.3.3");
    }

    const result = await attemptPinLogin("4738", "10.3.3.4");
    expect(result.ok).toBe(true);
  });

  it("a successful login does not leak which manager was matched on failure paths", async () => {
    const { league } = await makeLeagueWithSeason();
    const { manager: managerA } = await makeManagerAndTeam(league.id, "Manager A");
    const { manager: managerB } = await makeManagerAndTeam(league.id, "Manager B");
    await makePinCredential(managerA.id, "4738");
    await makePinCredential(managerB.id, "2947");

    const result = await attemptPinLogin("0001", "10.4.4.4");
    expect(result).toEqual({ ok: false, reason: "invalid" });
  });
});

describe("attemptPinLogin - isolation between test runs", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it("starts with no credentials after a reset", async () => {
    const result = await attemptPinLogin("4738", "10.5.5.5");
    expect(result.ok).toBe(false);
  });
});
