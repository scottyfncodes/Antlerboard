import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "../..");

/**
 * Preview and Production deployments share one database. On Oct 3 a preview
 * build of an unmerged branch ran `prisma migrate deploy`, dropped
 * Trade.teamAId/teamBId from the live database, and production crashed.
 * These tests keep that from happening again.
 */
describe("scripts/build.sh only migrates on production builds", () => {
  // Stub `npx` and `next` so the script runs without a database or a build.
  const stubDir = mkdtempSync(path.join(tmpdir(), "build-sh-"));
  const log = path.join(stubDir, "calls.log");
  for (const bin of ["npx", "next"]) {
    const file = path.join(stubDir, bin);
    writeFileSync(file, `#!/usr/bin/env bash\necho "${bin} $*" >> "${log}"\n`);
    chmodSync(file, 0o755);
  }
  afterAll(() => rmSync(stubDir, { recursive: true, force: true }));

  function runBuild(extraEnv: Record<string, string>): string[] {
    writeFileSync(log, "");
    const env = { PATH: `${stubDir}:${process.env.PATH}`, ...extraEnv };
    execFileSync("bash", [path.join(ROOT, "scripts/build.sh")], { env: env as unknown as NodeJS.ProcessEnv, stdio: "pipe" });
    return readFileSync(log, "utf8").trim().split("\n");
  }

  it.each(["preview", "development"])("skips migrations on a %s build", (vercelEnv) => {
    expect(runBuild({ VERCEL: "1", VERCEL_ENV: vercelEnv })).toEqual(["next build"]);
  });

  // Fail closed: if Vercel's system env vars aren't exposed to the build, a
  // preview must not be mistaken for production.
  it("skips migrations on a preview build where VERCEL_ENV is missing", () => {
    expect(runBuild({ VERCEL: "1" })).toEqual(["next build"]);
  });

  it("skips migrations when no Vercel env vars are present at all", () => {
    expect(runBuild({})).toEqual(["next build"]);
  });

  it.each(["", "Production", "staging", " production"])("skips migrations for an unexpected VERCEL_ENV %j", (vercelEnv) => {
    expect(runBuild({ VERCEL: "1", VERCEL_ENV: vercelEnv })).toEqual(["next build"]);
  });

  it("migrates before building on a production build", () => {
    expect(runBuild({ VERCEL: "1", VERCEL_ENV: "production" })).toEqual(["npx prisma migrate deploy", "next build"]);
  });
});

/**
 * Every migration below is already applied to the production database.
 * Prisma records each one's SHA-256; editing an applied file (or renaming or
 * deleting it) desyncs the code from the database without running any SQL.
 * New migrations get added here; existing entries never change.
 */
const APPLIED_MIGRATIONS: Record<string, string> = {
  "20260921131243_init": "42d77ce9c2ba8d609c6451d5015343f45b646d22dda417b5ee2eee2e26776600",
  "20260921140000_add_draft_day_details_and_rename_offer_tag": "2b9025a6143e0bd6c02c50f8c2c12206e1c12f4b4533e97fc8f5073f54be321b",
  "20260921150000_add_fypd_system": "3f3afdccd818987abf98500327705ea433b7ddc5cead03ef7258783f29def91c",
  "20260921160000_add_historical_import_models": "825fd56a83d9fd9a1151dec90d7585fe9a255b7a33200c2003c6aa0a6b5156ce",
  "20260921200503_add_manager_auth": "a5d4887b7b9db68fc0e693fd71bcb76af1cb4bffb4fa8140a702ec7471243282",
  // Applied Oct 3 by the claude/yahoo-style-ux preview build (commit d2425f6).
  "20261003120000_multi_team_trades": "a6e63a139be502d38d15e47c45e8c8b9057a9486efc17815844953e385fd868a",
  "20261005120000_league_rules_fypd_method": "24c545b09aefbd547c499cfde695aad9bf9b79b79ee9463a4fa9bbbbdb339967",
};

describe("applied migrations are immutable", () => {
  const dir = path.join(ROOT, "prisma/migrations");

  it.each(Object.entries(APPLIED_MIGRATIONS))("%s is unchanged", (name, sha256) => {
    const sql = readFileSync(path.join(dir, name, "migration.sql"));
    expect(createHash("sha256").update(sql).digest("hex")).toBe(sha256);
  });

  it("has no migration older than the newest applied one that isn't listed", () => {
    const newestApplied = Object.keys(APPLIED_MIGRATIONS).sort().at(-1)!;
    const onDisk = readdirSync(dir).filter((f) => /^\d{14}_/.test(f));
    const unlisted = onDisk.filter((f) => !(f in APPLIED_MIGRATIONS) && f < newestApplied);
    expect(unlisted).toEqual([]);
  });
});
