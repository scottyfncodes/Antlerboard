-- Confirmed C&A rules (Oct 2026): keeper cost follows a fixed ladder
-- (+1/+3/+5/+7/+9) rather than a configurable linear increment, the
-- league has 12 teams, and an FYPD call-up is its own acquisition method.

-- AlterEnum
ALTER TYPE "AcquisitionMethod" ADD VALUE 'FYPD';

-- AlterTable
ALTER TABLE "LeagueSettings" DROP COLUMN "keeperCostIncrementPerYear",
ALTER COLUMN "teamCount" SET DEFAULT 12;

-- AlterTable
ALTER TABLE "Acquisition" ADD COLUMN "sourceRef" TEXT;

-- CreateIndex
CREATE INDEX "Acquisition_sourceRef_idx" ON "Acquisition"("sourceRef");
