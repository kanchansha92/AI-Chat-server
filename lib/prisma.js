const { PrismaClient } = require('@prisma/client');

// Default: the standard Prisma client (Rust query engine) exactly as before.
//
// PRISMA_DRIVER_ADAPTER=pg switches to the `pg` driver adapter, which lets the
// app and the test-suite run on Prisma's engine-free "client" build in
// environments where the query-engine binary cannot be downloaded (CI without
// access to binaries.prisma.sh). It is opt-in and never set in the shipped
// .env, so production behaviour is unchanged.
function buildClient() {
  if (process.env.PRISMA_DRIVER_ADAPTER === 'pg') {
    // Optional dev dependency - only required when the switch is on.
    // eslint-disable-next-line global-require
    const { PrismaPg } = require('@prisma/adapter-pg');
    const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
    return new PrismaClient({ adapter });
  }
  return new PrismaClient();
}

const prisma = buildClient();

module.exports = prisma;
