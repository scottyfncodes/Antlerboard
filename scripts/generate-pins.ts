/**
 * Generates and stores PIN credentials for every C&A manager already in the
 * database, and prints the plaintext Manager -> PIN mapping to THIS
 * terminal only. Nothing here is written to a file, logged anywhere
 * persistent, or exposed through the app - this script, run with a real
 * DATABASE_URL, is the "protected commissioner/deployment mechanism" the
 * PIN list is meant to come from. Run it once, relay each PIN to its
 * manager individually and privately (text, DM, whatever - never a shared
 * doc), then close this terminal.
 *
 * If your DATABASE_URL only resolves from inside a Vercel deployment (some
 * providers' marketplace integrations work this way - see the comment on
 * src/app/api/admin/seed/route.ts), use the protected
 * POST /api/admin/generate-pins route instead, which runs this same logic
 * from inside the deployment and is gated by CRON_SECRET.
 *
 * Usage:
 *   npx tsx scripts/generate-pins.ts                  Generate for any manager who doesn't have a PIN yet.
 *   npx tsx scripts/generate-pins.ts --reset-all       Regenerate every manager's PIN (invalidates old ones).
 *   npx tsx scripts/generate-pins.ts --reset "Name"    Regenerate one manager's PIN by name (e.g. a forgotten PIN).
 */

import { prisma } from "../src/lib/db";
import { generatePins } from "../src/lib/auth/generate-pins";

async function main() {
  const args = process.argv.slice(2);
  const resetAll = args.includes("--reset-all");
  const resetIndex = args.indexOf("--reset");
  const resetName = resetIndex >= 0 ? args[resetIndex + 1] : undefined;

  const result = await generatePins({ resetAll, resetName });
  if (!result.ok) {
    console.error(result.error);
    process.exitCode = 1;
    return;
  }

  if (result.rows.length === 0) {
    console.log('Every manager already has a PIN. Pass --reset-all or --reset "Name" to regenerate one.');
    return;
  }

  console.log("\nDistribute each PIN privately and individually, then close this terminal:\n");
  console.table(result.rows);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
