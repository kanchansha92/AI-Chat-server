-- Plan enum v2: FREE / BASIC / PLUS / ULTRA (config/plans.js).
-- Existing PRO users are mapped to ULTRA, the top tier. No row is deleted.
-- Reversible by hand only (recreate the old enum) - take a backup first.
-- Comments here must not contain semicolons.

CREATE TYPE "Plan_new" AS ENUM ('FREE', 'BASIC', 'PLUS', 'ULTRA');
ALTER TABLE "User" ALTER COLUMN "plan" DROP DEFAULT;
ALTER TABLE "User" ALTER COLUMN "plan" TYPE "Plan_new"
  USING ((CASE "plan"::text WHEN 'PRO' THEN 'ULTRA' ELSE "plan"::text END)::"Plan_new");
ALTER TYPE "Plan" RENAME TO "Plan_old";
ALTER TYPE "Plan_new" RENAME TO "Plan";
DROP TYPE "Plan_old";
ALTER TABLE "User" ALTER COLUMN "plan" SET DEFAULT 'FREE';
