#!/usr/bin/env node
/**
 * Grant or revoke admin access.
 *
 * Admin is a server-owned column (`User.isAdmin`) precisely so that it cannot
 * be set through the API - see middleware/requireAdmin.js. This script is the
 * intended way to change it, run from the machine that can reach the database.
 *
 *   node scripts/grant-admin.js you@example.com          # grant
 *   node scripts/grant-admin.js you@example.com --revoke # revoke
 *   node scripts/grant-admin.js --list                   # who has it
 *   node scripts/grant-admin.js --seed-from-env          # grant to ADMIN_EMAILS
 *
 * --seed-from-env is a one-off convenience for the migration off the old
 * ADMIN_EMAILS allowlist: it grants the flag to the accounts that already
 * exist for those addresses. Once you have run it, drop ADMIN_EMAILS from .env
 * so nobody mistakes it for a live gate.
 */

require('dotenv').config();
const prisma = require('../lib/prisma');
const { adminEmails } = require('../middleware/requireAdmin');

function usage() {
  console.log(
    [
      'Usage:',
      '  node scripts/grant-admin.js <email> [--revoke]',
      '  node scripts/grant-admin.js --list',
      '  node scripts/grant-admin.js --seed-from-env',
    ].join('\n')
  );
}

async function list() {
  const admins = await prisma.user.findMany({
    where: { isAdmin: true },
    select: { email: true, name: true },
    orderBy: { email: 'asc' },
  });
  if (admins.length === 0) {
    console.log('No admins. Grant one with: node scripts/grant-admin.js <email>');
    return;
  }
  console.log(`${admins.length} admin(s):`);
  for (const a of admins) console.log(`  ${a.email}  (${a.name})`);
}

async function setAdmin(rawEmail, isAdmin) {
  const email = String(rawEmail).trim().toLowerCase();
  const user = await prisma.user.findUnique({ where: { email }, select: { id: true, email: true } });
  if (!user) {
    console.error(`No account for ${email}. Sign up first, then run this again.`);
    return false;
  }
  await prisma.user.update({ where: { id: user.id }, data: { isAdmin } });
  console.log(`${isAdmin ? 'Granted' : 'Revoked'} admin: ${user.email}`);
  return true;
}

async function seedFromEnv() {
  const emails = adminEmails();
  if (emails.length === 0) {
    console.error('ADMIN_EMAILS is empty - nothing to seed.');
    return;
  }
  console.log(`Seeding admin from ADMIN_EMAILS (${emails.length} address(es))...`);
  let granted = 0;
  for (const email of emails) {
    if (await setAdmin(email, true)) granted += 1;
  }
  console.log(`Done: ${granted}/${emails.length} granted.`);
  if (granted < emails.length) {
    console.log('Addresses with no account were skipped - create them, then re-run.');
  }
  console.log('Now remove ADMIN_EMAILS from .env; it is no longer a gate.');
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    usage();
    return;
  }
  if (args.includes('--list')) return list();
  if (args.includes('--seed-from-env')) return seedFromEnv();

  const email = args.find((a) => !a.startsWith('--'));
  if (!email) {
    usage();
    process.exitCode = 1;
    return;
  }
  const ok = await setAdmin(email, !args.includes('--revoke'));
  if (!ok) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
