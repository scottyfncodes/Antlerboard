-- Yahoo roster membership: one current team per player per season.
-- Additive only - no existing table, row, or constraint is changed.
-- CreateTable
CREATE TABLE "RosterSpot" (
    "id" TEXT NOT NULL,
    "seasonId" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "yahooPlayerKey" TEXT NOT NULL,
    "selectedPosition" TEXT,
    "onTeamSince" TIMESTAMP(3) NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "lastSyncLogId" TEXT,

    CONSTRAINT "RosterSpot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RosterSpot_teamId_seasonId_idx" ON "RosterSpot"("teamId", "seasonId");

-- CreateIndex
CREATE UNIQUE INDEX "RosterSpot_seasonId_playerId_key" ON "RosterSpot"("seasonId", "playerId");

-- AddForeignKey
ALTER TABLE "RosterSpot" ADD CONSTRAINT "RosterSpot_seasonId_fkey" FOREIGN KEY ("seasonId") REFERENCES "Season"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RosterSpot" ADD CONSTRAINT "RosterSpot_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RosterSpot" ADD CONSTRAINT "RosterSpot_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "Player"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

