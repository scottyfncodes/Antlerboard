import { describe, it, expect, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { GET as me } from "./route";
import { makeLeagueWithSeason, makeManagerAndTeam, resetDatabase } from "@/lib/test-helpers";
import { createSessionToken, SESSION_COOKIE_NAME } from "@/lib/auth/session";

function meRequest(cookieValue?: string): NextRequest {
  const headers = new Headers();
  if (cookieValue) headers.set("cookie", `${SESSION_COOKIE_NAME}=${cookieValue}`);
  return new NextRequest("https://antlerboard.example/api/auth/me", { headers });
}

describe("GET /api/auth/me", () => {
  afterEach(async () => {
    await resetDatabase();
  });

  it("reports unauthenticated with no session", async () => {
    const res = await me(meRequest());
    const body = await res.json();
    expect(body.authenticated).toBe(false);
  });

  it("reports the current manager and role when authenticated", async () => {
    const { league } = await makeLeagueWithSeason();
    const { manager } = await makeManagerAndTeam(league.id, "Real Manager", true);
    const token = await createSessionToken(manager.id, "pin");

    const res = await me(meRequest(token));
    const body = await res.json();
    expect(body.authenticated).toBe(true);
    expect(body.manager.id).toBe(manager.id);
    expect(body.manager.role).toBe("commissioner");
  });

  it("never includes a PIN hash or credential data in the response", async () => {
    const { league } = await makeLeagueWithSeason();
    const { manager } = await makeManagerAndTeam(league.id, "Real Manager");
    const token = await createSessionToken(manager.id, "pin");

    const res = await me(meRequest(token));
    const text = await res.text();
    expect(text).not.toMatch(/scrypt/);
  });
});
