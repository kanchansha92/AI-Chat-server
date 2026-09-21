-- Voice: cached spoken replies (VoiceClip). One row per (message, variant)
-- holding the generated audio's location, the generation lease, and what an
-- in-flight attempt reserved, so a replay never calls the provider or charges
-- again and a crashed attempt can be settled. Additive only.
-- Comments here must not contain semicolons.

-- CreateEnum
CREATE TYPE "VoiceMessageKind" AS ENUM ('CHAT', 'GROUP');

-- CreateEnum
CREATE TYPE "VoiceClipStatus" AS ENUM ('PENDING', 'READY', 'FAILED');

-- CreateTable
CREATE TABLE "VoiceClip" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "messageKind" "VoiceMessageKind" NOT NULL,
    "messageId" TEXT NOT NULL,
    "variant" TEXT NOT NULL,
    "premium" BOOLEAN NOT NULL DEFAULT false,
    "status" "VoiceClipStatus" NOT NULL DEFAULT 'PENDING',
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "textHash" TEXT,
    "storedPath" TEXT,
    "mimeType" TEXT,
    "bytes" INTEGER,
    "seconds" INTEGER,
    "model" TEXT,
    "creditKey" TEXT,
    "lockedUntil" TIMESTAMP(3),
    "pendingSeconds" INTEGER,
    "pendingPeriodKey" TEXT,
    "pendingCreditKey" TEXT,
    "pendingMetered" BOOLEAN NOT NULL DEFAULT false,
    "lastUsedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "VoiceClip_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "VoiceClip_userId_idx" ON "VoiceClip"("userId");

-- CreateIndex
CREATE INDEX "VoiceClip_status_lockedUntil_idx" ON "VoiceClip"("status", "lockedUntil");

-- CreateIndex
CREATE INDEX "VoiceClip_lastUsedAt_idx" ON "VoiceClip"("lastUsedAt");

-- CreateIndex
CREATE UNIQUE INDEX "VoiceClip_messageKind_messageId_variant_key" ON "VoiceClip"("messageKind", "messageId", "variant");

-- AddForeignKey
ALTER TABLE "VoiceClip" ADD CONSTRAINT "VoiceClip_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
