import { describe, it, expect, afterEach, vi } from "vitest";
import { isAuthorizedCronRequest } from "./cron-auth";

const req = (authorization?: string) => ({ headers: { get: (n: string) => (n === "authorization" ? authorization ?? null : null) } });

afterEach(() => vi.unstubAllEnvs());

describe("cron request auth", () => {
  it("accepts Vercel's Bearer header when it matches CRON_SECRET", () => {
    vi.stubEnv("CRON_SECRET", "s3cret");
    expect(isAuthorizedCronRequest(req("Bearer s3cret"))).toBe(true);
  });

  it("rejects a missing or wrong header", () => {
    vi.stubEnv("CRON_SECRET", "s3cret");
    expect(isAuthorizedCronRequest(req())).toBe(false);
    expect(isAuthorizedCronRequest(req("Bearer nope"))).toBe(false);
    expect(isAuthorizedCronRequest(req("s3cret"))).toBe(false);
  });

  it("fails closed when CRON_SECRET isn't configured", () => {
    vi.stubEnv("CRON_SECRET", "");
    expect(isAuthorizedCronRequest(req())).toBe(false);
    expect(isAuthorizedCronRequest(req("Bearer "))).toBe(false);
    expect(isAuthorizedCronRequest(req("Bearer undefined"))).toBe(false);
  });
});
