-- Session revocation. Every JWT carries this value as `tv`; bumping the column
-- invalidates every token issued before the bump.
--   node scripts/apply-token-version.js
--   npx prisma migrate resolve --applied 20260904020000_add_user_token_version
ALTER TABLE "User" ADD COLUMN "tokenVersion" INTEGER NOT NULL DEFAULT 0;
