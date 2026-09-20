// LOCAL TOOLING ONLY (not part of the app). Lets `prisma migrate` run through the
// WASM schema engine + pg driver adapter in an environment where Prisma's engine
// binaries cannot be downloaded. Pass with --config.
import { defineConfig } from 'prisma/config';
import { PrismaPg } from '@prisma/adapter-pg';
export default defineConfig({
  engine: 'js',
  experimental: { adapter: true },
  schema: '/home/claude/prisma-tools/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  async adapter() {
    return new PrismaPg({ connectionString: process.env.DATABASE_URL });
  },
});
