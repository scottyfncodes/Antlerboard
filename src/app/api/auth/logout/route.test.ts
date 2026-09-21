import { describe, it, expect } from "vitest";
import { POST as logout } from "./route";
import { SESSION_COOKIE_NAME } from "@/lib/auth/session";

describe("POST /api/auth/logout", () => {
  it("clears the session cookie", async () => {
    const res = await logout();
    const cookie = res.cookies.get(SESSION_COOKIE_NAME);
    expect(cookie?.value).toBe("");
  });

  it("responds ok even with no prior session", async () => {
    const res = await logout();
    const body = await res.json();
    expect(body.ok).toBe(true);
  });
});
