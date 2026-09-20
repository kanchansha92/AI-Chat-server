-- Content features gated by plan: character activation and public sharing,
-- premium/model audit columns on messages, memory scope and pinning, user
-- long-term memory, stories, style profiles, personas, journal attachments.
-- Additive only, every column has a default or is nullable.
-- Comments here must not contain semicolons.

-- CreateEnum
CREATE TYPE "MemoryScope" AS ENUM ('SESSION', 'STORY', 'LONG_TERM');

-- CreateEnum
CREATE TYPE "JournalAttachmentKind" AS ENUM ('PHOTO', 'DOCUMENT');

-- AlterTable
ALTER TABLE "Character" ADD COLUMN     "isActive" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "isPublic" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "publicSlug" TEXT;

-- AlterTable
ALTER TABLE "ChatMessage" ADD COLUMN     "creditCost" DECIMAL(10,2),
ADD COLUMN     "isPremium" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "modelId" TEXT,
ADD COLUMN     "personaId" TEXT,
ADD COLUMN     "storyId" TEXT;

-- AlterTable
ALTER TABLE "Memory" ADD COLUMN     "pinned" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "scope" "MemoryScope" NOT NULL DEFAULT 'STORY';

-- AlterTable
ALTER TABLE "GroupMessage" ADD COLUMN     "creditCost" DECIMAL(10,2),
ADD COLUMN     "isPremium" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "modelId" TEXT,
ADD COLUMN     "personaId" TEXT;

-- CreateTable
CREATE TABLE "Persona" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Persona_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserMemory" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "fact" TEXT NOT NULL,
    "factKey" TEXT NOT NULL,
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserMemory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Story" (
    "id" TEXT NOT NULL,
    "characterId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Story_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StyleProfile" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "notes" TEXT NOT NULL DEFAULT '',
    "samples" JSONB,
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StyleProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JournalAttachment" (
    "id" TEXT NOT NULL,
    "entryId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" "JournalAttachmentKind" NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "storedPath" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JournalAttachment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Persona_userId_updatedAt_idx" ON "Persona"("userId", "updatedAt");

-- CreateIndex
CREATE INDEX "UserMemory_userId_pinned_createdAt_idx" ON "UserMemory"("userId", "pinned", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "UserMemory_userId_factKey_key" ON "UserMemory"("userId", "factKey");

-- CreateIndex
CREATE INDEX "Story_characterId_updatedAt_idx" ON "Story"("characterId", "updatedAt");

-- CreateIndex
CREATE INDEX "StyleProfile_userId_updatedAt_idx" ON "StyleProfile"("userId", "updatedAt");

-- CreateIndex
CREATE INDEX "JournalAttachment_entryId_idx" ON "JournalAttachment"("entryId");

-- CreateIndex
CREATE INDEX "JournalAttachment_userId_idx" ON "JournalAttachment"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Character_publicSlug_key" ON "Character"("publicSlug");

-- CreateIndex
CREATE INDEX "Character_userId_isActive_idx" ON "Character"("userId", "isActive");

-- CreateIndex
CREATE INDEX "ChatMessage_storyId_createdAt_idx" ON "ChatMessage"("storyId", "createdAt");

-- CreateIndex
CREATE INDEX "Memory_scope_learnedAt_idx" ON "Memory"("scope", "learnedAt");

-- AddForeignKey
ALTER TABLE "ChatMessage" ADD CONSTRAINT "ChatMessage_storyId_fkey" FOREIGN KEY ("storyId") REFERENCES "Story"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Persona" ADD CONSTRAINT "Persona_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserMemory" ADD CONSTRAINT "UserMemory_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Story" ADD CONSTRAINT "Story_characterId_fkey" FOREIGN KEY ("characterId") REFERENCES "Character"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StyleProfile" ADD CONSTRAINT "StyleProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalAttachment" ADD CONSTRAINT "JournalAttachment_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "JournalEntry"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalAttachment" ADD CONSTRAINT "JournalAttachment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
