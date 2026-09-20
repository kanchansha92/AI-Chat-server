-- CreateTable
CREATE TABLE "JournalThread" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "aboutRealPerson" BOOLEAN NOT NULL DEFAULT false,
    "colour" TEXT NOT NULL DEFAULT '#a8b08c',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "JournalThread_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JournalEntry" (
    "id" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "title" TEXT NOT NULL DEFAULT '',
    "body" TEXT NOT NULL DEFAULT '',
    "reflection" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "JournalEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "JournalThread_userId_updatedAt_idx" ON "JournalThread"("userId", "updatedAt");

-- CreateIndex
CREATE INDEX "JournalEntry_threadId_createdAt_idx" ON "JournalEntry"("threadId", "createdAt");

-- AddForeignKey
ALTER TABLE "JournalThread" ADD CONSTRAINT "JournalThread_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalEntry" ADD CONSTRAINT "JournalEntry_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "JournalThread"("id") ON DELETE CASCADE ON UPDATE CASCADE;
