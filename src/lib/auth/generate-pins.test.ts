import { describe, it, expect, afterEach } from "vitest";
import { prisma } from "@/lib/db";
import { makeLeagueWithSeason, makeManagerAndTeam, makePinCredential, resetDatabase } from "@/lib/test-helpers";
import { verifyPin } from "./pin";
import { generatePins } from "./generate-pins";

describe("generatePins", () => {
  afterEach(async () => {
    await resetDatabase();
  });

  it("fails clearly when there are no active managers yet", async () => {
    const result = await generatePins();
    expect(result.ok).toBe(false);
  });

  it("generates a unique PIN for every active manager on first run", async () => {
    const { league } = await makeLeagueWithSeason();
    const names = ["Aaron", "Andrew", "Ed", "Hugo", "Jorge", "Kurt", "MattyJ", "Michael", "Neel", "Tyler", "Zach"];
    for (const name of names) await makeManagerAndTeam(league.id, name);
    await makeManagerAndTeam(league.id, "Scott", true);

    const result = await generatePins();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows).toHaveLength(12);
    expect(new Set(result.rows.map((r) => r.pin)).size).toBe(12);
    expect(result.rows.every((r) => r.status === "generated")).toBe(true);
    expect(result.rows.find((r) => r.name === "Scott")?.role).toBe("commissioner");
  });

  it("skips managers who already have a PIN on a plain generate", async () => {
    const { league } = await makeLeagueWithSeason();
    const { manager: aaron } = await makeManagerAndTeam(league.id, "Aaron");
    await makeManagerAndTeam(league.id, "Andrew");
    await makePinCredential(aaron.id, "4738");

    const result = await generatePins();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].name).toBe("Andrew");
    expect(result.rows[0].status).toBe("generated");
  });

  it("excludes inactive (departed) managers", async () => {
    const { league } = await makeLeagueWithSeason();
    const { manager: departed } = await makeManagerAndTeam(league.id, "Departed");
    await prisma.manager.update({ where: { id: departed.id }, data: { active: false } });
    await makeManagerAndTeam(league.id, "Active");

    const result = await generatePins();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].name).toBe("Active");
  });

  it("reset-all replaces every manager's PIN, including ones already set", async () => {
    const { league } = await makeLeagueWithSeason();
    const { manager: aaron } = await makeManagerAndTeam(league.id, "Aaron");
    await makeManagerAndTeam(league.id, "Andrew");
    await makePinCredential(aaron.id, "4738");

    const result = await generatePins({ resetAll: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows).toHaveLength(2);
    expect(result.rows.find((r) => r.name === "Aaron")?.status).toBe("reset");
    expect(result.rows.find((r) => r.name === "Andrew")?.status).toBe("generated");

    // Aaron's old PIN no longer verifies against the new stored hash.
    const credential = await prisma.managerCredential.findUniqueOrThrow({
      where: { managerId_provider: { managerId: aaron.id, provider: "pin" } },
    });
    expect(verifyPin("4738", credential.secretHash)).toBe(false);
    const newPin = result.rows.find((r) => r.name === "Aaron")!.pin;
    expect(verifyPin(newPin, credential.secretHash)).toBe(true);
  });

  it("reset-one replaces only the named manager's PIN", async () => {
    const { league } = await makeLeagueWithSeason();
    const { manager: aaron } = await makeManagerAndTeam(league.id, "Aaron");
    const { manager: andrew } = await makeManagerAndTeam(league.id, "Andrew");
    await makePinCredential(aaron.id, "4738");
    await makePinCredential(andrew.id, "2947");

    const result = await generatePins({ resetName: "Aaron" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].name).toBe("Aaron");
    expect(result.rows[0].status).toBe("reset");
    expect(result.rows[0].pin).not.toBe("4738");

    // Andrew's credential is untouched.
    const andrewCredential = await prisma.managerCredential.findUniqueOrThrow({
      where: { managerId_provider: { managerId: andrew.id, provider: "pin" } },
    });
    expect(verifyPin("2947", andrewCredential.secretHash)).toBe(true);
  });

  it("reset-one is case-insensitive and matches by exact name", async () => {
    const { league } = await makeLeagueWithSeason();
    await makeManagerAndTeam(league.id, "Aaron");

    const result = await generatePins({ resetName: "aaron" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows[0].name).toBe("Aaron");
  });

  it("reset-one fails clearly for an unknown manager name", async () => {
    const { league } = await makeLeagueWithSeason();
    await makeManagerAndTeam(league.id, "Aaron");

    const result = await generatePins({ resetName: "Nonexistent" });
    expect(result.ok).toBe(false);
  });

  it("never stores a plaintext PIN in the database", async () => {
    const { league } = await makeLeagueWithSeason();
    await makeManagerAndTeam(league.id, "Aaron");

    const result = await generatePins();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const credentials = await prisma.managerCredential.findMany();
    for (const credential of credentials) {
      expect(credential.secretHash).not.toContain(result.rows[0].pin);
    }
  });
});
