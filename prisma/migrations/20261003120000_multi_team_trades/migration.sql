-- Multi-team trades: replace Trade.teamAId/teamBId with a TradeParticipant
-- row per team. Existing two-team trades are backfilled before the old
-- columns are dropped, so no trade history is lost.

-- CreateEnum
CREATE TYPE "TradeResponse" AS ENUM ('PENDING', 'ACCEPTED', 'REJECTED');

-- CreateTable
CREATE TABLE "TradeParticipant" (
    "id" TEXT NOT NULL,
    "tradeId" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "isProposer" BOOLEAN NOT NULL DEFAULT false,
    "response" "TradeResponse" NOT NULL DEFAULT 'PENDING',
    "respondedAt" TIMESTAMP(3),

    CONSTRAINT "TradeParticipant_pkey" PRIMARY KEY ("id")
);

-- Backfill. The proposing side is the team the proposer manages; if the
-- proposer managed neither team (possible before trade creation was
-- restricted to your own team), Team A is treated as the proposing side.
WITH sides AS (
    SELECT
        t."id" AS "tradeId",
        t."status",
        t."updatedAt",
        t."teamAId",
        t."teamBId",
        (ta."managerId" = t."proposerId" OR tb."managerId" <> t."proposerId") AS "aProposed"
    FROM "Trade" t
    JOIN "Team" ta ON ta."id" = t."teamAId"
    JOIN "Team" tb ON tb."id" = t."teamBId"
),
rows AS (
    SELECT "tradeId", "status", "updatedAt", "teamAId" AS "teamId", "aProposed" AS "isProposer" FROM sides
    UNION ALL
    SELECT "tradeId", "status", "updatedAt", "teamBId" AS "teamId", NOT "aProposed" AS "isProposer" FROM sides
)
INSERT INTO "TradeParticipant" ("id", "tradeId", "teamId", "isProposer", "response", "respondedAt")
SELECT
    gen_random_uuid()::text,
    "tradeId",
    "teamId",
    "isProposer",
    CASE
        WHEN "isProposer" OR "status" = 'ACCEPTED' THEN 'ACCEPTED'::"TradeResponse"
        WHEN "status" = 'REJECTED' THEN 'REJECTED'::"TradeResponse"
        ELSE 'PENDING'::"TradeResponse"
    END,
    CASE WHEN NOT "isProposer" AND "status" IN ('ACCEPTED', 'REJECTED') THEN "updatedAt" END
FROM rows;

-- CreateIndex
CREATE INDEX "TradeParticipant_teamId_idx" ON "TradeParticipant"("teamId");

-- CreateIndex
CREATE UNIQUE INDEX "TradeParticipant_tradeId_teamId_key" ON "TradeParticipant"("tradeId", "teamId");

-- AddForeignKey
ALTER TABLE "TradeParticipant" ADD CONSTRAINT "TradeParticipant_tradeId_fkey" FOREIGN KEY ("tradeId") REFERENCES "Trade"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TradeParticipant" ADD CONSTRAINT "TradeParticipant_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- DropForeignKey
ALTER TABLE "Trade" DROP CONSTRAINT "Trade_teamAId_fkey";

-- DropForeignKey
ALTER TABLE "Trade" DROP CONSTRAINT "Trade_teamBId_fkey";

-- AlterTable
ALTER TABLE "Trade" DROP COLUMN "teamAId",
DROP COLUMN "teamBId";
