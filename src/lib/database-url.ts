/**
 * Which connection string the app talks to at runtime.
 *
 * This must stay in lockstep with scripts/db-env.sh, which picks the
 * database `prisma migrate deploy` runs against during the build. When a
 * Vercel project has both the Neon integration's
 * DATABASE_URL_POSTGRES_PRISMA_URL and a hand-set DATABASE_URL, the build
 * migrates the integration database - so the runtime has to query that same
 * database, or the generated client expects columns the runtime database
 * doesn't have (P2022 "column does not exist" on every page).
 *
 * Local dev and any provider that only sets DATABASE_URL are unaffected.
 */
export function resolveDatabaseUrl(env: Record<string, string | undefined> = process.env): string | undefined {
  return env.DATABASE_URL_POSTGRES_PRISMA_URL || env.DATABASE_URL || undefined;
}
