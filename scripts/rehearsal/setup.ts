// The rehearsal runs only against a local copy (seed-replica.ts) - never a
// shared or production database, whatever else is in the environment.
const url = process.env.REHEARSAL_DATABASE_URL ?? "";
if (!/@(localhost|127\.0\.0\.1)(:\d+)?\//.test(url)) {
  throw new Error("REHEARSAL_DATABASE_URL must point at a local database.");
}
process.env.DATABASE_URL = url;
process.env.DIRECT_URL = url;
process.env.AUTH_SECRET = "rehearsal-only-secret-not-production-0123456789";
for (const k of Object.keys(process.env)) if (k.startsWith("YAHOO_")) delete process.env[k];
