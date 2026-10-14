import { describe, it, expect, beforeEach, afterAll, afterEach, vi } from "vitest";
import { makeLeagueWithSeason, resetDatabase } from "@/lib/test-helpers";

vi.mock("@/lib/yahoo/sync", () => ({ runYahooSync: vi.fn() }));
vi.mock("@/lib/current-manager", () => ({ requireCommissioner: vi.fn() }));

import { runYahooSync } from "@/lib/yahoo/sync";
import { requireCommissioner } from "@/lib/current-manager";
import { POST } from "./route";

const mockedSync = vi.mocked(runYahooSync);
const mockedRequireCommissioner = vi.mocked(requireCommissioner);

const YAHOO_ENV = ["YAHOO_CLIENT_ID", "YAHOO_CLIENT_SECRET", "YAHOO_REDIRECT_URI"] as const;
const savedEnv = Object.fromEntries(YAHOO_ENV.map((k) => [k, process.env[k]]));

beforeEach(async () => {
  await resetDatabase();
  mockedSync.mockReset();
  mockedRequireCommissioner.mockReset();
  mockedRequireCommissioner.mockResolvedValue({ id: "commish" } as Awaited<ReturnType<typeof requireCommissioner>>);
  for (const k of YAHOO_ENV) process.env[k] = "test-value";
});
afterEach(() => {
  for (const k of YAHOO_ENV) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});
afterAll(resetDatabase);

describe("POST /api/yahoo/sync", () => {
  it("refuses to sync where Yahoo isn't configured (e.g. a Preview deployment sharing the production database)", async () => {
    await makeLeagueWithSeason();
    delete process.env.YAHOO_CLIENT_SECRET;

    const res = await POST();

    expect(res.status).toBe(503);
    expect((await res.json()).error).toContain("isn't configured in this environment");
    expect(mockedSync).not.toHaveBeenCalled();
  });

  it("runs the sync where Yahoo is configured", async () => {
    await makeLeagueWithSeason();
    mockedSync.mockResolvedValueOnce({ status: "SUCCESS", sections: [], totalRecordsUpdated: 0 });

    const res = await POST();

    expect(res.status).toBe(200);
    expect(mockedSync).toHaveBeenCalledOnce();
  });

  it("refuses a non-commissioner", async () => {
    mockedRequireCommissioner.mockResolvedValueOnce(null);
    expect((await POST()).status).toBe(403);
    expect(mockedSync).not.toHaveBeenCalled();
  });
});
