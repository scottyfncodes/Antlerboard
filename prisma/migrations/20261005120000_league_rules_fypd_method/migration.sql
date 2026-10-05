-- Confirmed C&A rules (Oct 2026): keeper cost follows a fixed ladder
-- (+1/+3/+5/+7/+9) rather than a configurable linear increment, the
-- league has 12 teams, and an FYPD call-up is its own acquisition method.

-- AlterEnum
ALTER TYPE "AcquisitionMethod" ADD VALUE 'FYPD';

-- AlterTable
ALTER TABLE "LeagueSettings" DROP COLUMN "keeperCostIncrementPerYear",
ALTER COLUMN "teamCount" SET DEFAULT 12;

-- AlterTable: import provenance so a re-run can refresh its own rows
ALTER TABLE "Acquisition" ADD COLUMN "sourceRef" TEXT;
ALTER TABLE "Transaction" ADD COLUMN "sourceRef" TEXT;
ALTER TABLE "DraftPick" ADD COLUMN "sourceRef" TEXT;

-- CreateIndex
CREATE INDEX "Acquisition_sourceRef_idx" ON "Acquisition"("sourceRef");
CREATE INDEX "Transaction_sourceRef_idx" ON "Transaction"("sourceRef");
CREATE INDEX "DraftPick_sourceRef_idx" ON "DraftPick"("sourceRef");

-- Keeper records: one row per stint, with the team that declared the keeper
-- kept separately from the team holding the player after in-season trades.
ALTER TABLE "Acquisition" ADD COLUMN "preseason" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "KeeperRecord" ADD COLUMN "startTeamId" TEXT;
DROP INDEX "KeeperRecord_seasonId_playerId_key";
CREATE UNIQUE INDEX "KeeperRecord_seasonId_playerId_stintIndex_key" ON "KeeperRecord"("seasonId", "playerId", "stintIndex");
CREATE INDEX "KeeperRecord_startTeamId_idx" ON "KeeperRecord"("startTeamId");
CREATE INDEX "KeeperRecord_playerId_idx" ON "KeeperRecord"("playerId");
ALTER TABLE "KeeperRecord" ADD CONSTRAINT "KeeperRecord_startTeamId_fkey" FOREIGN KEY ("startTeamId") REFERENCES "Team"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
