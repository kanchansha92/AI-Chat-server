-- BASELINE OF PRE-EXISTING DRIFT (see MIGRATION-BASELINE.md)
--
-- The live database was changed with `prisma db push` / by hand after
-- 20260723093718_add_social_auth. Nothing on disk described those changes, so
-- `prisma migrate` could not run against it without offering a reset.
--
-- This file records exactly what the live database already contains. Every
-- statement is written to be idempotent (IF NOT EXISTS / DO blocks), so it is
-- safe whether it is applied to a fresh database (where it creates everything)
-- or marked as already applied on the live one:
--
--   npx prisma migrate resolve --applied 20260905000000_baseline_drift
--
-- NOTE for hand editing: keep every comment free of semicolons.

-- CreateEnum
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ReportReason') THEN
    CREATE TYPE "ReportReason" AS ENUM ('IMPERSONATION', 'SEXUAL', 'VIOLENCE', 'PRETENDED_HUMAN', 'OTHER');
  END IF;
END $$;

-- AlterTable
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "deletionScheduledAt" TIMESTAMP(3),
ADD COLUMN IF NOT EXISTS "roleplayTrialEndsAt" TIMESTAMP(3),
ADD COLUMN IF NOT EXISTS "trialEndingNoticeSentAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Character" ADD COLUMN IF NOT EXISTS "avatar" TEXT;

-- AlterTable
ALTER TABLE "ChatMessage" ADD COLUMN IF NOT EXISTS "attachments" JSONB,
ADD COLUMN IF NOT EXISTS "blockedReason" TEXT,
ADD COLUMN IF NOT EXISTS "imageAlt" TEXT,
ADD COLUMN IF NOT EXISTS "imageUrl" TEXT;

-- AlterTable
ALTER TABLE "Memory" ADD COLUMN IF NOT EXISTS "sourceGroupMessageId" TEXT,
ADD COLUMN IF NOT EXISTS "sourceMessageId" TEXT;

-- AlterTable
ALTER TABLE "Group" ADD COLUMN IF NOT EXISTS "turnCursor" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "GroupMember" ADD COLUMN IF NOT EXISTS "colourOverride" TEXT,
ADD COLUMN IF NOT EXISTS "nameOverride" TEXT,
ADD COLUMN IF NOT EXISTS "quickLineOverride" TEXT,
ADD COLUMN IF NOT EXISTS "tonesOverride" JSONB;

-- AlterTable
ALTER TABLE "GroupMessage" ADD COLUMN IF NOT EXISTS "attachments" JSONB,
ADD COLUMN IF NOT EXISTS "blockedReason" TEXT,
ADD COLUMN IF NOT EXISTS "imageAlt" TEXT,
ADD COLUMN IF NOT EXISTS "imageUrl" TEXT,
ADD COLUMN IF NOT EXISTS "userId" TEXT NOT NULL;

-- CreateTable
CREATE TABLE IF NOT EXISTS "MessageReport" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "messageId" TEXT,
    "groupMessageId" TEXT,
    "characterId" TEXT,
    "reason" "ReportReason" NOT NULL,
    "note" TEXT,
    "reportedText" TEXT NOT NULL,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MessageReport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "MessageReport_reviewedAt_createdAt_idx" ON "MessageReport"("reviewedAt", "createdAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "MessageReport_characterId_createdAt_idx" ON "MessageReport"("characterId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "MessageReport_userId_messageId_key" ON "MessageReport"("userId", "messageId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "MessageReport_userId_groupMessageId_key" ON "MessageReport"("userId", "groupMessageId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Memory_sourceMessageId_idx" ON "Memory"("sourceMessageId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Memory_sourceGroupMessageId_idx" ON "Memory"("sourceGroupMessageId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "GroupMessage_userId_sender_createdAt_idx" ON "GroupMessage"("userId", "sender", "createdAt");

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'MessageReport_userId_fkey') THEN
    ALTER TABLE "MessageReport" ADD CONSTRAINT "MessageReport_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'MessageReport_messageId_fkey') THEN
    ALTER TABLE "MessageReport" ADD CONSTRAINT "MessageReport_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "ChatMessage"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'MessageReport_groupMessageId_fkey') THEN
    ALTER TABLE "MessageReport" ADD CONSTRAINT "MessageReport_groupMessageId_fkey" FOREIGN KEY ("groupMessageId") REFERENCES "GroupMessage"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'MessageReport_characterId_fkey') THEN
    ALTER TABLE "MessageReport" ADD CONSTRAINT "MessageReport_characterId_fkey" FOREIGN KEY ("characterId") REFERENCES "Character"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Memory_sourceMessageId_fkey') THEN
    ALTER TABLE "Memory" ADD CONSTRAINT "Memory_sourceMessageId_fkey" FOREIGN KEY ("sourceMessageId") REFERENCES "ChatMessage"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Memory_sourceGroupMessageId_fkey') THEN
    ALTER TABLE "Memory" ADD CONSTRAINT "Memory_sourceGroupMessageId_fkey" FOREIGN KEY ("sourceGroupMessageId") REFERENCES "GroupMessage"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'GroupMessage_userId_fkey') THEN
    ALTER TABLE "GroupMessage" ADD CONSTRAINT "GroupMessage_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

