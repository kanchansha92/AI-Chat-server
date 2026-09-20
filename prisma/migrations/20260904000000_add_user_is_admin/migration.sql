-- Admin authorization moves off the (unverified, user-editable) email
-- allowlist and onto a server-owned column. Grant it with:
--   node scripts/grant-admin.js you@example.com
ALTER TABLE "User" ADD COLUMN "isAdmin" BOOLEAN NOT NULL DEFAULT false;
