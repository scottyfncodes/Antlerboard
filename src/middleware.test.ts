import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";
import { middleware } from "./middleware";
import { createSessionToken, SESSION_COOKIE_NAME } from "@/lib/auth/session";

function requestFor(path: string, cookie?: string): NextRequest {
  const headers = new Headers();
  if (cookie) headers.set("cookie", `${SESSION_COOKIE_NAME}=${cookie}`);
  return new NextRequest(`https://antlerboard.example${path}`, { headers });
}

function isRedirect(res: Response): boolean {
  return res.status >= 300 && res.status < 400 && !!res.headers.get("location");
}

describe("middleware (login gate)", () => {
  it("redirects an unauthenticated page request to /login", async () => {
    const res = await middleware(requestFor("/"));
    expect(isRedirect(res)).toBe(true);
    expect(res.headers.get("location")).toContain("/login");
  });

  it("preserves the original path as a ?next= param on redirect", async () => {
    const res = await middleware(requestFor("/commissioner"));
    const location = new URL(res.headers.get("location")!);
    expect(location.searchParams.get("next")).toBe("/commissioner");
  });

  it("returns 401 JSON for an unauthenticated API request instead of redirecting", async () => {
    const res = await middleware(requestFor("/api/trades"));
    expect(isRedirect(res)).toBe(false);
    expect(res.status).toBe(401);
  });

  it("allows an authenticated page request through", async () => {
    const token = await createSessionToken("manager-1", "pin");
    const res = await middleware(requestFor("/", token));
    expect(isRedirect(res)).toBe(false);
    expect(res.status).not.toBe(401);
  });

  it("always allows /api/auth/* through, even without a session", async () => {
    const res = await middleware(requestFor("/api/auth/login"));
    expect(isRedirect(res)).toBe(false);
    expect(res.status).not.toBe(401);
  });

  it("redirects an already-authenticated visit to /login back into the app", async () => {
    const token = await createSessionToken("manager-1", "pin");
    const res = await middleware(requestFor("/login", token));
    expect(isRedirect(res)).toBe(true);
    expect(res.headers.get("location")).not.toContain("/login");
  });

  it("lets an unauthenticated visitor reach /login", async () => {
    const res = await middleware(requestFor("/login"));
    expect(isRedirect(res)).toBe(false);
  });

  it("lets cron/admin routes through without a session - they check their own CRON_SECRET", async () => {
    const cronRes = await middleware(requestFor("/api/cron/notifications"));
    expect(isRedirect(cronRes)).toBe(false);
    expect(cronRes.status).not.toBe(401);

    const adminRes = await middleware(requestFor("/api/admin/seed"));
    expect(isRedirect(adminRes)).toBe(false);
    expect(adminRes.status).not.toBe(401);
  });

  it("rejects a tampered session cookie the same as no session at all", async () => {
    const token = await createSessionToken("manager-1", "pin");
    const tampered = token.slice(0, -2) + "zz";
    const res = await middleware(requestFor("/", tampered));
    expect(isRedirect(res)).toBe(true);
    expect(res.headers.get("location")).toContain("/login");
  });
});
