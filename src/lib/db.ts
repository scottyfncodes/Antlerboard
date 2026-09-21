import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

/**
 * Vercel's Postgres/Neon marketplace integration only ever creates
 * *sensitive* environment variables (write-only - never readable back
 * through the Management API, by design), and it names them with
 * whatever prefix was chosen when the storage was connected rather than
 * the literal `DATABASE_URL` our schema declares. `DATABASE_URL` itself is
 * genuinely absent from the runtime in that case, so we fall back to the
 * pooled connection string the integration actually provides. Local dev
 * and any other provider that sets `DATABASE_URL` directly are unaffected.
 */
const datasourceUrl =
  process.env.DATABASE_URL || process.env.DATABASE_URL_POSTGRES_PRISMA_URL;

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    datasourceUrl,
    log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
