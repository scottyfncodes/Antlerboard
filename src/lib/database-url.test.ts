import { execFileSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveDatabaseUrl } from "./database-url";

// Placeholder connection strings - never real credentials.
const INTEGRATION = "postgresql://u:p@ep-integration-pooler.example.test/neondb";
const INTEGRATION_DIRECT = "postgresql://u:p@ep-integration.example.test/neondb";
const MANUAL = "postgresql://u:p@other.example.test/otherdb";

/** What scripts/db-env.sh leaves in DATABASE_URL for `prisma migrate deploy`. */
function buildMigrationUrl(env: Record<string, string>): string {
  const script = path.resolve(__dirname, "../../scripts/db-env.sh");
  return execFileSync("bash", ["-c", `. "${script}" 2>/dev/null; printf %s "\${DATABASE_URL:-}"`], {
    env: { PATH: process.env.PATH, ...env } as unknown as NodeJS.ProcessEnv,
    encoding: "utf8",
  });
}

describe("resolveDatabaseUrl", () => {
  it("prefers the Neon integration URL when a hand-set DATABASE_URL also exists", () => {
    // Production had both; the runtime used DATABASE_URL while the build
    // migrated the integration database, so every page hit P2022.
    expect(resolveDatabaseUrl({ DATABASE_URL: MANUAL, DATABASE_URL_POSTGRES_PRISMA_URL: INTEGRATION })).toBe(
      INTEGRATION
    );
  });

  it("falls back to DATABASE_URL when the integration isn't connected", () => {
    expect(resolveDatabaseUrl({ DATABASE_URL: MANUAL })).toBe(MANUAL);
  });

  it("returns undefined when nothing is configured", () => {
    expect(resolveDatabaseUrl({})).toBeUndefined();
  });

  it.each([
    ["both set", { DATABASE_URL: MANUAL, DATABASE_URL_POSTGRES_PRISMA_URL: INTEGRATION }],
    ["both set, with a non-pooling URL", {
      DATABASE_URL: MANUAL,
      DATABASE_URL_POSTGRES_PRISMA_URL: INTEGRATION,
      DATABASE_URL_POSTGRES_URL_NON_POOLING: INTEGRATION_DIRECT,
    }],
    ["integration only", { DATABASE_URL_POSTGRES_PRISMA_URL: INTEGRATION }],
    ["DATABASE_URL only", { DATABASE_URL: MANUAL }],
  ])("matches the database the build migrates (%s)", (_label, env) => {
    expect(resolveDatabaseUrl(env)).toBe(buildMigrationUrl(env));
  });
});
