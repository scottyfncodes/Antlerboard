-- CreateEnum
CREATE TYPE "FypdDraftStatus" AS ENUM ('SETUP', 'IN_PROGRESS', 'PAUSED', 'COMPLETE');

-- AlterTable
ALTER TABLE "Player" ADD COLUMN     "mlbDraftOverallPick" INTEGER,
ADD COLUMN     "mlbDraftRound" INTEGER,
ADD COLUMN     "mlbDraftYear" INTEGER,
ADD COLUMN     "mlbOrganization" TEXT;

-- CreateTable
CREATE TABLE "FypdDraft" (
    "id" TEXT NOT NULL,
    "leagueId" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "rounds" INTEGER NOT NULL DEFAULT 1,
    "status" "FypdDraftStatus" NOT NULL DEFAULT 'SETUP',
    "currentOverallPick" INTEGER NOT NULL DEFAULT 1,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FypdDraft_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FypdDraftOrderSlot" (
    "id" TEXT NOT NULL,
    "draftId" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "slot" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,

    CONSTRAINT "FypdDraftOrderSlot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FypdSelection" (
    "id" TEXT NOT NULL,
    "draftId" TEXT NOT NULL,
    "round" INTEGER NOT NULL,
    "pickInRound" INTEGER NOT NULL,
    "overallPick" INTEGER NOT NULL,
    "teamId" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "callUpYear" INTEGER,
    "callUpExercised" BOOLEAN NOT NULL DEFAULT false,
    "callUpExercisedAt" TIMESTAMP(3),
    "isDpud" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FypdSelection_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "FypdDraft_leagueId_year_key" ON "FypdDraft"("leagueId", "year");

-- CreateIndex
CREATE UNIQUE INDEX "FypdDraftOrderSlot_draftId_teamId_key" ON "FypdDraftOrderSlot"("draftId", "teamId");

-- CreateIndex
CREATE UNIQUE INDEX "FypdDraftOrderSlot_draftId_slot_key" ON "FypdDraftOrderSlot"("draftId", "slot");

-- CreateIndex
CREATE INDEX "FypdSelection_teamId_idx" ON "FypdSelection"("teamId");

-- CreateIndex
CREATE UNIQUE INDEX "FypdSelection_draftId_overallPick_key" ON "FypdSelection"("draftId", "overallPick");

-- CreateIndex
CREATE UNIQUE INDEX "FypdSelection_draftId_playerId_key" ON "FypdSelection"("draftId", "playerId");

-- AddForeignKey
ALTER TABLE "FypdDraft" ADD CONSTRAINT "FypdDraft_leagueId_fkey" FOREIGN KEY ("leagueId") REFERENCES "League"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FypdDraftOrderSlot" ADD CONSTRAINT "FypdDraftOrderSlot_draftId_fkey" FOREIGN KEY ("draftId") REFERENCES "FypdDraft"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FypdDraftOrderSlot" ADD CONSTRAINT "FypdDraftOrderSlot_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FypdSelection" ADD CONSTRAINT "FypdSelection_draftId_fkey" FOREIGN KEY ("draftId") REFERENCES "FypdDraft"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FypdSelection" ADD CONSTRAINT "FypdSelection_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FypdSelection" ADD CONSTRAINT "FypdSelection_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "Player"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

