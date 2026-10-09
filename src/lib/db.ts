import { PrismaClient } from "@prisma/client";
import { resolveDatabaseUrl } from "@/lib/database-url";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

/**
 * Vercel's Postgres/Neon marketplace integration only ever creates
 * *sensitive* environment variables (write-only - never readable back
 * through the Management API, by design), and it names them with
 * whatever prefix was chosen when the storage was connected rather than
 * the literal `DATABASE_URL` our schema declares. The integration's pooled
 * URL wins when present - the same precedence the build uses for
 * `prisma migrate deploy` (see src/lib/database-url.ts). Local dev and any
 * other provider that sets `DATABASE_URL` directly are unaffected.
 */
const datasourceUrl = resolveDatabaseUrl();

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    datasourceUrl,
    log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
