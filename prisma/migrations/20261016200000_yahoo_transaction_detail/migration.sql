-- Detailed Yahoo transaction ingestion. Additive only: new nullable columns
-- and one new enum value. No existing row is changed.

-- AlterEnum
ALTER TYPE "TransactionType" ADD VALUE 'COMMISSIONER_MOVE';

-- AlterTable
ALTER TABLE "Transaction" ADD COLUMN     "yahooType" TEXT,
ADD COLUMN     "yahooStatus" TEXT,
ADD COLUMN     "faabBid" INTEGER,
ADD COLUMN     "dateUnavailable" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "yahooDetailIssues" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "yahooDetailSyncedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "TransactionPlayer" ADD COLUMN     "action" TEXT,
ADD COLUMN     "sourceType" TEXT,
ADD COLUMN     "destinationType" TEXT,
ADD COLUMN     "sourceTeamId" TEXT,
ADD COLUMN     "destinationTeamId" TEXT,
ADD COLUMN     "yahooPlayerKey" TEXT;
