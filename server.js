require('dotenv').config();
const { assertEnvIsSafe } = require('./config/assertEnv');

// Fail fast on an unsafe configuration before anything listens.
assertEnvIsSafe();

const app = require('./app');
const PORT = process.env.PORT || 5000;

// ─── Start ───────────────────────────────────────────────────────────────────

async function start() {
  // Verify the database is actually reachable before declaring the server
  // "up" - a server that's listening but can't talk to its database will
  // otherwise fail confusingly on the first real request instead of at boot.
  const prisma = require('./lib/prisma');
  try {
    await prisma.$queryRaw`SELECT 1`;
    console.log('✔ database connected');
  } catch (err) {
    console.error('✘ could not connect to the database.');
    console.error('  DATABASE_URL:', process.env.DATABASE_URL ? '(set)' : '(missing)');
    console.error('  ' + (err && err.message ? err.message : err));
    process.exit(1);
  }

  const server = app.listen(PORT, () => {
    console.log(`privateaile api running on port ${PORT}`);
  });

  // Background sweeps (brief §12.4 trial-ending emails + §12.5 deletion purge).
  // Idempotent and best-effort; see lib/jobs.js.
  try {
    require('./lib/jobs').startJobs();
  } catch (err) {
    console.error('[jobs] failed to start:', err && err.message ? err.message : err);
  }

  async function shutdown(signal) {
    console.log(`\n${signal} received, shutting down...`);
    server.close(async () => {
      await prisma.$disconnect();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10000).unref();
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

start();
