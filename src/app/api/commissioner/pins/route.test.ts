import { describe, it, expect, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { POST as pinsRoute } from "./route";
import { makeLeagueWithSeason, makeManagerAndTeam, makePinCredential, resetDatabase } from "@/lib/test-helpers";
import { createSessionToken, SESSION_COOKIE_NAME } from "@/lib/auth/session";
import { verifyPin } from "@/lib/auth/pin";
import { prisma } from "@/lib/db";

function req(body: unknown, token?: string): NextRequest {
  const headers = new Headers({ "content-type": "application/json" });
  if (token) headers.set("cookie", `${SESSION_COOKIE_NAME}=${token}`);
  return new NextRequest("https://antlerboard.example/api/commissioner/pins", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

describe("POST /api/commissioner/pins", () => {
  afterEach(async () => {
    await resetDatabase();
  });

  it("rejects an unauthenticated request", async () => {
    const res = await pinsRoute(req({ action: "generate" }));
    expect(res.status).toBe(403);
  });

  it("rejects a regular (non-commissioner) manager", async () => {
    const { league } = await makeLeagueWithSeason();
    const { manager } = await makeManagerAndTeam(league.id, "Regular Manager", false);
    const token = await createSessionToken(manager.id, "pin");

    const res = await pinsRoute(req({ action: "generate" }, token));
    expect(res.status).toBe(403);

    // And confirms it didn't do anything.
    const credentials = await prisma.managerCredential.findMany();
    expect(credentials).toHaveLength(0);
  });

  it("rejects a tampered session cookie the same as no session", async () => {
    const { league } = await makeLeagueWithSeason();
    const { manager } = await makeManagerAndTeam(league.id, "The Commissioner", true);
    const token = await createSessionToken(manager.id, "pin");
    const tampered = token.slice(0, -2) + "zz";

    const res = await pinsRoute(req({ action: "generate" }, tampered));
    expect(res.status).toBe(403);
  });

  it("lets the commissioner generate PINs for managers without one", async () => {
    const { league } = await makeLeagueWithSeason();
    const { manager: commissioner } = await makeManagerAndTeam(league.id, "The Commissioner", true);
    await makeManagerAndTeam(league.id, "Aaron");
    const token = await createSessionToken(commissioner.id, "pin");

    const res = await pinsRoute(req({ action: "generate" }, token));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.rows).toHaveLength(2);
    expect(new Set(body.rows.map((r: { pin: string }) => r.pin)).size).toBe(2);

    // Recorded in the audit log without any PIN in it.
    const entries = await prisma.auditLogEntry.findMany({ where: { action: "GENERATE_PINS" } });
    expect(entries).toHaveLength(1);
    expect(JSON.stringify(entries[0])).not.toMatch(new RegExp(body.rows.map((r: { pin: string }) => r.pin).join("|")));
  });

  it("reset-all replaces every existing PIN", async () => {
    const { league } = await makeLeagueWithSeason();
    const { manager: commissioner } = await makeManagerAndTeam(league.id, "The Commissioner", true);
    await makePinCredential(commissioner.id, "0640");
    const token = await createSessionToken(commissioner.id, "pin");

    const res = await pinsRoute(req({ action: "reset-all" }, token));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0].status).toBe("reset");

    const credential = await prisma.managerCredential.findUniqueOrThrow({
      where: { managerId_provider: { managerId: commissioner.id, provider: "pin" } },
    });
    expect(verifyPin("0640", credential.secretHash)).toBe(false);
  });

  it("reset-one replaces a single named manager's PIN", async () => {
    const { league } = await makeLeagueWithSeason();
    const { manager: commissioner } = await makeManagerAndTeam(league.id, "The Commissioner", true);
    const { manager: aaron } = await makeManagerAndTeam(league.id, "Aaron");
    await makePinCredential(aaron.id, "4738");
    const token = await createSessionToken(commissioner.id, "pin");

    const res = await pinsRoute(req({ action: "reset-one", managerName: "Aaron" }, token));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0].name).toBe("Aaron");
  });

  it("rejects reset-one with no managerName", async () => {
    const { league } = await makeLeagueWithSeason();
    const { manager: commissioner } = await makeManagerAndTeam(league.id, "The Commissioner", true);
    const token = await createSessionToken(commissioner.id, "pin");

    const res = await pinsRoute(req({ action: "reset-one" }, token));
    expect(res.status).toBe(400);
  });

  it("rejects an unknown action", async () => {
    const { league } = await makeLeagueWithSeason();
    const { manager: commissioner } = await makeManagerAndTeam(league.id, "The Commissioner", true);
    const token = await createSessionToken(commissioner.id, "pin");

    const res = await pinsRoute(req({ action: "wipe-everything" }, token));
    expect(res.status).toBe(400);
  });

  it("never logs a plaintext PIN to the console", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      const { league } = await makeLeagueWithSeason();
      const { manager: commissioner } = await makeManagerAndTeam(league.id, "The Commissioner", true);
      const token = await createSessionToken(commissioner.id, "pin");

      const res = await pinsRoute(req({ action: "generate" }, token));
      const body = await res.json();
      const pins: string[] = body.rows.map((r: { pin: string }) => r.pin);

      const allLoggedText = [...logSpy.mock.calls, ...errorSpy.mock.calls, ...warnSpy.mock.calls]
        .flat()
        .map((v) => JSON.stringify(v))
        .join("\n");

      for (const pin of pins) {
        expect(allLoggedText).not.toContain(pin);
      }
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });
});
