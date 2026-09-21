-- CreateEnum
CREATE TYPE "FypdImportBatchStatus" AS ENUM ('PENDING_REVIEW', 'CONFIRMED', 'DISCARDED');

-- AlterTable
ALTER TABLE "Manager" ADD COLUMN     "active" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "TeamSeasonRecord" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "seasonYear" INTEGER NOT NULL,
    "teamName" TEXT NOT NULL,
    "managerId" TEXT NOT NULL,
    "finish" TEXT,
    "sourceNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TeamSeasonRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HistoricalTrade" (
    "id" TEXT NOT NULL,
    "leagueId" TEXT NOT NULL,
    "seasonYear" INTEGER,
    "tradeDate" TIMESTAMP(3),
    "teamAName" TEXT NOT NULL,
    "teamAId" TEXT,
    "teamAPlayersRaw" TEXT,
    "teamADropsRaw" TEXT,
    "teamBName" TEXT NOT NULL,
    "teamBId" TEXT,
    "teamBPlayersRaw" TEXT,
    "teamBDropsRaw" TEXT,
    "sourceRef" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HistoricalTrade_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HistoricalPropBet" (
    "id" TEXT NOT NULL,
    "leagueId" TEXT NOT NULL,
    "seasonYear" INTEGER,
    "teamAName" TEXT NOT NULL,
    "teamAId" TEXT,
    "teamBName" TEXT NOT NULL,
    "teamBId" TEXT,
    "amount" DOUBLE PRECISION,
    "description" TEXT NOT NULL,
    "sourceRef" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HistoricalPropBet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FypdImportBatch" (
    "id" TEXT NOT NULL,
    "leagueId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "sourceSheet" TEXT NOT NULL,
    "rawPicks" JSONB NOT NULL,
    "seasonYear" INTEGER,
    "status" "FypdImportBatchStatus" NOT NULL DEFAULT 'PENDING_REVIEW',
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmedAt" TIMESTAMP(3),

    CONSTRAINT "FypdImportBatch_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TeamSeasonRecord_teamId_seasonYear_key" ON "TeamSeasonRecord"("teamId", "seasonYear");

-- AddForeignKey
ALTER TABLE "TeamSeasonRecord" ADD CONSTRAINT "TeamSeasonRecord_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamSeasonRecord" ADD CONSTRAINT "TeamSeasonRecord_managerId_fkey" FOREIGN KEY ("managerId") REFERENCES "Manager"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HistoricalTrade" ADD CONSTRAINT "HistoricalTrade_leagueId_fkey" FOREIGN KEY ("leagueId") REFERENCES "League"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HistoricalPropBet" ADD CONSTRAINT "HistoricalPropBet_leagueId_fkey" FOREIGN KEY ("leagueId") REFERENCES "League"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FypdImportBatch" ADD CONSTRAINT "FypdImportBatch_leagueId_fkey" FOREIGN KEY ("leagueId") REFERENCES "League"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

