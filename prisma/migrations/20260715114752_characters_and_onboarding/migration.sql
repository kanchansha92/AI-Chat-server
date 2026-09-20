-- CreateEnum
CREATE TYPE "Intent" AS ENUM ('COMPANY', 'ROLEPLAY', 'JOURNAL', 'LOOKING');

-- CreateEnum
CREATE TYPE "BuilderMode" AS ENUM ('QUICK', 'DEEP');

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "intent" "Intent";

-- CreateTable
CREATE TABLE "Character" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "colour" TEXT NOT NULL DEFAULT '#a8b08c',
    "quickLine" TEXT NOT NULL DEFAULT '',
    "tones" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "mode" "BuilderMode" NOT NULL DEFAULT 'QUICK',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Character_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CharacterSource" (
    "id" TEXT NOT NULL,
    "characterId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "storedPath" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CharacterSource_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Character_userId_updatedAt_idx" ON "Character"("userId", "updatedAt");

-- AddForeignKey
ALTER TABLE "Character" ADD CONSTRAINT "Character_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CharacterSource" ADD CONSTRAINT "CharacterSource_characterId_fkey" FOREIGN KEY ("characterId") REFERENCES "Character"("id") ON DELETE CASCADE ON UPDATE CASCADE;
