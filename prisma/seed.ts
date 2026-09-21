/**
 * CLI entry point for local/manual seeding. The actual seed logic lives in
 * src/lib/db-seed.ts so it can also be invoked from the protected
 * /api/admin/seed route for databases this process can't reach directly.
 */

import { runSeed } from "../src/lib/db-seed";
import { prisma } from "../src/lib/db";

runSeed()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
