/**
 * scripts/audit-migration-names.ts — DB-008, migration naming (REQUIRED,
 * source-only, no database).
 *
 * Fails the build when a prisma/migrations/ directory is not
 * `<YYYYMMDDHHMMSS>_<slug>` with a real, unique, monotone timestamp — except
 * the closed legacy date-only set in scripts/lib/migration-names.ts, which
 * must match the tree exactly. scripts/audit-migration-names.test.ts proves it
 * fails on a date-only, out-of-order, duplicate or impossible timestamp.
 *
 *   npx tsx scripts/audit-migration-names.ts
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { auditMigrationNames, LEGACY_DATE_ONLY } from "./lib/migration-names";

const dir = join(process.cwd(), "prisma", "migrations");
const names = readdirSync(dir, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .sort();

const r = auditMigrationNames(names);
console.log(`[migration-names] ${r.total} migrations: ${r.timestamped} timestamped, ${r.legacy} legacy date-only (allowlist ${LEGACY_DATE_ONLY.length})`);
if (r.errors.length > 0) {
  console.error(`\n✗ ${r.errors.length} naming violation(s):`);
  for (const e of r.errors) console.error(`    ${e}`);
  console.error("\n  Name new migrations <YYYYMMDDHHMMSS>_<slug> (prisma migrate dev does this); never reuse or back-date a timestamp.\n");
  process.exit(1);
}
console.log("✓ every migration is timestamped and monotone; the legacy set is exact.\n");
