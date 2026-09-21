-- CreateTable
CREATE TABLE "ManagerCredential" (
    "id" TEXT NOT NULL,
    "managerId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "secretHash" TEXT,
    "providerUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ManagerCredential_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LoginAttempt" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "failCount" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LoginAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ManagerCredential_provider_idx" ON "ManagerCredential"("provider");

-- CreateIndex
CREATE UNIQUE INDEX "ManagerCredential_managerId_provider_key" ON "ManagerCredential"("managerId", "provider");

-- CreateIndex
CREATE UNIQUE INDEX "LoginAttempt_key_key" ON "LoginAttempt"("key");

-- AddForeignKey
ALTER TABLE "ManagerCredential" ADD CONSTRAINT "ManagerCredential_managerId_fkey" FOREIGN KEY ("managerId") REFERENCES "Manager"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
