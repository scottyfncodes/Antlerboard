-- Detailed Yahoo transaction ingestion. Additive only: new columns, each
-- nullable or with a default. No enum changes (so every row stays readable by
-- the previous build), and no existing row is changed.

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
