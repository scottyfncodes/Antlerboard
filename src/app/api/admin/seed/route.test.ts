import { describe, it, expect, afterEach, vi } from "vitest";
vi.mock("@/lib/db-seed", () => ({ runSeed: vi.fn() }));
import { runSeed } from "@/lib/db-seed";
import { POST } from "./route";

const call = (secret?: string) =>
  POST(new Request("https://antlerboard.example/api/admin/seed", {
    method: "POST",
    headers: secret ? { authorization: `Bearer ${secret}` } : {},
  }));

describe("POST /api/admin/seed", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.mocked(runSeed).mockReset();
  });

  it("needs the cron secret", async () => {
    vi.stubEnv("CRON_SECRET", "s3cret");
    expect((await call("wrong")).status).toBe(401);
    expect((await call()).status).toBe(401);
    expect(runSeed).not.toHaveBeenCalled();
  });

  it.each(["production", "preview"])("never wipes a deployed (%s) database, even with the secret", async (env) => {
    vi.stubEnv("CRON_SECRET", "s3cret");
    vi.stubEnv("VERCEL_ENV", env);
    expect((await call("s3cret")).status).toBe(403);
    expect(runSeed).not.toHaveBeenCalled();
  });

  it("seeds a local database with the secret", async () => {
    vi.stubEnv("CRON_SECRET", "s3cret");
    vi.stubEnv("VERCEL_ENV", "");
    expect((await call("s3cret")).status).toBe(200);
    expect(runSeed).toHaveBeenCalledOnce();
  });
});
