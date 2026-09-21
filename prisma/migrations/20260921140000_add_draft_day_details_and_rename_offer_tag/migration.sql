-- Rename the PlayerTagType enum value in place (RENAME VALUE, not
-- drop-and-recreate) so existing PlayerTag rows tagged MAKE_ME_AN_OFFER in
-- production keep their meaning under the new name instead of failing the
-- migration or losing data.
ALTER TYPE "PlayerTagType" RENAME VALUE 'MAKE_ME_AN_OFFER' TO 'OPEN_TO_DISCUSS';

-- CreateTable
CREATE TABLE "DraftDayDetails" (
    "id" TEXT NOT NULL,
    "seasonId" TEXT NOT NULL,
    "draftTime" TEXT,
    "venue" TEXT,
    "format" TEXT,
    "auctionBudget" INTEGER,
    "nominationOrderNotes" TEXT,
    "rulesNotes" TEXT,
    "commissionerNotes" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DraftDayDetails_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DraftDayDetails_seasonId_key" ON "DraftDayDetails"("seasonId");

-- AddForeignKey
ALTER TABLE "DraftDayDetails" ADD CONSTRAINT "DraftDayDetails_seasonId_fkey" FOREIGN KEY ("seasonId") REFERENCES "Season"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
