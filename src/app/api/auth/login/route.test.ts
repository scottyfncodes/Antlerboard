import { describe, it, expect, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { POST as login } from "./route";
import { makeLeagueWithSeason, makeManagerAndTeam, makePinCredential, resetDatabase } from "@/lib/test-helpers";
import { SESSION_COOKIE_NAME, verifySessionToken } from "@/lib/auth/session";

function loginRequest(pin: unknown, ip: string): NextRequest {
  return new NextRequest("https://antlerboard.example/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify({ pin }),
  });
}

describe("POST /api/auth/login", () => {
  afterEach(async () => {
    await resetDatabase();
  });

  it("logs in with a correct PIN and sets a valid session cookie", async () => {
    const { league } = await makeLeagueWithSeason();
    const { manager } = await makeManagerAndTeam(league.id, "Real Manager");
    await makePinCredential(manager.id, "4738");

    const res = await login(loginRequest("4738", "20.0.0.1"));
    expect(res.status).toBe(200);

    const cookie = res.cookies.get(SESSION_COOKIE_NAME)?.value;
    expect(cookie).toBeTruthy();
    const session = await verifySessionToken(cookie);
    expect(session?.managerId).toBe(manager.id);

    const body = await res.json();
    expect(body.manager.id).toBe(manager.id);
    expect(body.manager.role).toBe("manager");
  });

  it("reports the commissioner's role correctly", async () => {
    const { league } = await makeLeagueWithSeason();
    const { manager } = await makeManagerAndTeam(league.id, "The Commish", true);
    await makePinCredential(manager.id, "9271");

    const res = await login(loginRequest("9271", "20.0.0.2"));
    const body = await res.json();
    expect(body.manager.role).toBe("commissioner");
  });

  it("rejects an incorrect PIN with a generic 401 and no session cookie", async () => {
    const { league } = await makeLeagueWithSeason();
    const { manager } = await makeManagerAndTeam(league.id, "Real Manager");
    await makePinCredential(manager.id, "4738");

    const res = await login(loginRequest("0000", "20.0.0.3"));
    expect(res.status).toBe(401);
    expect(res.cookies.get(SESSION_COOKIE_NAME)?.value ?? "").toBeFalsy();
    const body = await res.json();
    expect(body.error).not.toMatch(/manager|hash|database|prisma|scrypt/i);
  });

  it("rejects a malformed request body", async () => {
    const req = new NextRequest("https://antlerboard.example/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    });
    const res = await login(req);
    expect(res.status).toBe(400);
  });

  it("locks out after repeated failures and includes a Retry-After header", async () => {
    const { league } = await makeLeagueWithSeason();
    const { manager } = await makeManagerAndTeam(league.id, "Real Manager");
    await makePinCredential(manager.id, "4738");

    const ip = "20.0.0.4";
    for (let i = 0; i < 3; i++) {
      await login(loginRequest("0000", ip));
    }
    const res = await login(loginRequest("4738", ip));
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("Retry-After"))).toBeGreaterThan(0);
  });
});
