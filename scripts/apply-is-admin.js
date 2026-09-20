#!/usr/bin/env node
/**
 * Add User.isAdmin to a database whose migration history has drifted.
 *
 * WHY THIS EXISTS
 * ---------------
 * `prisma migrate dev` refuses to run here. The database contains work that no
 * migration file describes (MessageReport, Group.turnCursor, the attachment and
 * image columns, the member overrides, the trial and deletion columns) - it was
 * applied with `prisma db push` or by hand. Prisma cannot reconcile that, so it
 * offers `migrate reset`, which DROPS THE DATABASE. Never run that here.
 *
 * This applies the one column the admin fix needs, idempotently, and leaves
 * everything else alone. Afterwards, tell Prisma the migration is already
 * applied so it is never run twice:
 *
 *   node scripts/apply-is-admin.js
 *   npx prisma migrate resolve --applied 20260904000000_add_user_is_admin
 *   npx prisma generate
 *
 * That unblocks you. It does NOT fix the drift - `migrate dev` will complain
 * again the next time you change the schema. The real fix is to baseline the
 * history against the live database once; see the note this script prints.
 */

require('dotenv').config();
const prisma = require('../lib/prisma');

async function columnExists() {
  const rows = await prisma.$queryRaw`
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'User'
      AND column_name = 'isAdmin'
  `;
  return Array.isArray(rows) && rows.length > 0;
}

async function main() {
  if (await columnExists()) {
    console.log('User."isAdmin" already exists - nothing to do.');
  } else {
    // IF NOT EXISTS keeps this safe to run twice; the check above is only so
    // the script can say which of the two happened.
    await prisma.$executeRawUnsafe(
      'ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "isAdmin" BOOLEAN NOT NULL DEFAULT false'
    );
    console.log('Added User."isAdmin" (BOOLEAN NOT NULL DEFAULT false).');
  }

  const [{ count }] = await prisma.$queryRaw`
    SELECT COUNT(*)::int AS count FROM "User" WHERE "isAdmin" = true
  `;
  console.log(`Admins right now: ${count}`);

  console.log('');
  console.log('Next:');
  console.log('  npx prisma migrate resolve --applied 20260904000000_add_user_is_admin');
  console.log('  npx prisma generate');
  console.log('  node scripts/grant-admin.js --seed-from-env');
  console.log('');
  console.log('Then restart the server. Until `prisma generate` has run, the');
  console.log('Prisma client does not know about isAdmin and every /api/admin');
  console.log('request will fail.');
  console.log('');
  console.log('Note: your migration history is still behind the database. That');
  console.log('is worth fixing before you deploy anywhere - a fresh environment');
  console.log('built from these migrations would be missing months of schema.');
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
