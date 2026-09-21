import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { POST as generatePinsRoute } from "./route";
import { makeLeagueWithSeason, makeManagerAndTeam, resetDatabase } from "@/lib/test-helpers";
import { verifyPin } from "@/lib/auth/pin";
import { prisma } from "@/lib/db";

function req(body: unknown, secret?: string): NextRequest {
  const headers = new Headers({ "content-type": "application/json" });
  if (secret) headers.set("authorization", `Bearer ${secret}`);
  return new NextRequest("https://antlerboard.example/api/admin/generate-pins", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

describe("POST /api/admin/generate-pins", () => {
  const originalSecret = process.env.CRON_SECRET;

  beforeEach(() => {
    process.env.CRON_SECRET = "test-cron-secret";
  });

  afterEach(async () => {
    process.env.CRON_SECRET = originalSecret;
    await resetDatabase();
  });

  it("rejects a request without the correct bearer secret", async () => {
    const res = await generatePinsRoute(req({}, "wrong-secret"));
    expect(res.status).toBe(401);
  });

  it("rejects a request with no secret at all", async () => {
    const res = await generatePinsRoute(req({}));
    expect(res.status).toBe(401);
  });

  it("generates PINs for active managers and hashes them before storing", async () => {
    const { league } = await makeLeagueWithSeason();
    await makeManagerAndTeam(league.id, "Aaron");
    await makeManagerAndTeam(league.id, "Scott", true);

    const res = await generatePinsRoute(req({}, "test-cron-secret"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.rows).toHaveLength(2);
    expect(new Set(body.rows.map((r: { pin: string }) => r.pin)).size).toBe(2);

    const credentials = await prisma.managerCredential.findMany({ where: { provider: "pin" } });
    expect(credentials).toHaveLength(2);
    // No plaintext PIN ever lands in the stored hash.
    for (const credential of credentials) {
      const matchingRow = body.rows.find((r: { pin: string }) => verifyPin(r.pin, credential.secretHash));
      expect(matchingRow).toBeTruthy();
      expect(credential.secretHash).not.toContain(matchingRow.pin);
    }
  });
});
