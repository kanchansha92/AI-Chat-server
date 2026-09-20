#!/usr/bin/env node
/**
 * Add User.tokenVersion to a database whose migration history has drifted.
 *
 * Same situation and same remedy as scripts/apply-is-admin.js: `prisma migrate
 * dev` cannot run here because the database contains work no migration file
 * describes, and its only offer is `migrate reset`, which DROPS THE DATABASE.
 * Never run that against ember_db.
 *
 *   node scripts/apply-token-version.js
 *   npx prisma migrate resolve --applied 20260904020000_add_user_token_version
 *   npx prisma generate
 *
 * tokenVersion is what makes a session revocable: it is stamped into every JWT
 * as `tv` and compared on each request (middleware/authMiddleware.js). Bumping
 * it - which changing or resetting a password now does - invalidates every
 * token issued before the bump.
 *
 * Nobody is signed out by this. Existing tokens carry no `tv`, which reads as 0
 * and matches the column default.
 */

require('dotenv').config();
const prisma = require('../lib/prisma');

async function columnExists() {
  const rows = await prisma.$queryRaw`
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'User'
      AND column_name = 'tokenVersion'
  `;
  return Array.isArray(rows) && rows.length > 0;
}

async function main() {
  if (await columnExists()) {
    console.log('User."tokenVersion" already exists - nothing to do.');
  } else {
    await prisma.$executeRawUnsafe(
      'ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "tokenVersion" INTEGER NOT NULL DEFAULT 0'
    );
    console.log('Added User."tokenVersion" (INTEGER NOT NULL DEFAULT 0).');
  }

  console.log('');
  console.log('Next:');
  console.log('  npx prisma migrate resolve --applied 20260904020000_add_user_token_version');
  console.log('  npx prisma generate');
  console.log('');
  console.log('Then restart the server. Until `prisma generate` has run, the');
  console.log('client does not know about tokenVersion and EVERY authenticated');
  console.log('request will fail - authMiddleware selects it on each one.');
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
