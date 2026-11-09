/**
 * lib/debt/snapshot-installment-debt-migration.test.ts — Mortgage F1b migration policy
 *
 * Parses prisma/migrations/20261108160000_mortgage_f1b_snapshot_installment_debt and
 * pins S2's ruling: ADDITIVE ONLY — one nullable ADD COLUMN on SpaceSnapshot, the same
 * numeric type as debt / netLiquid, NO default fill, NO UPDATE / backfill / DELETE /
 * INSERT / DROP / grant or policy change. Also pins the schema field and the README's
 * Preview-only rollback, and FREEZES the SQL by sha256.
 *
 *   npx tsx lib/debt/snapshot-installment-debt-migration.test.ts
 */

import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (ok) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const ROOT = process.cwd();
const NAME = "20261108160000_mortgage_f1b_snapshot_installment_debt";
const DIR = path.join(ROOT, "prisma/migrations", NAME);
const raw = readFileSync(path.join(DIR, "migration.sql"), "utf8");
const sql = raw.replace(/--[^\n]*/g, "").replace(/\s+/g, " ").trim();

console.log("1. additive only — one nullable column, no default fill, no backfill");
{
  const statements = sql.split(";").map((s) => s.trim()).filter(Boolean);
  check("exactly one statement", statements.length === 1, String(statements.length));
  check("the statement adds installmentDebt DOUBLE PRECISION to SpaceSnapshot",
    statements[0] === `ALTER TABLE "SpaceSnapshot" ADD COLUMN "installmentDebt" DOUBLE PRECISION`, statements[0]);
  for (const kw of ["UPDATE", "DEFAULT", "NOT NULL", "DELETE", "INSERT", "DROP", "TRUNCATE", "GRANT", "REVOKE",
    "POLICY", "ALTER COLUMN", "RENAME", "SET"]) {
    check(`no ${kw}`, !new RegExp(`\\b${kw}\\b`, "i").test(sql));
  }
  const init = readFileSync(path.join(ROOT, "prisma/migrations/20260609234422_init/migration.sql"), "utf8");
  check("same numeric type as debt / netLiquid",
    /"debt" DOUBLE PRECISION/.test(init) && /"netLiquid" DOUBLE PRECISION/.test(init));
}

console.log("2. schema + README + ordering");
{
  const schema = readFileSync(path.join(ROOT, "prisma/schema.prisma"), "utf8");
  const model = schema.match(/model SpaceSnapshot \{[\s\S]*?\n\}/)?.[0] ?? "";
  check("schema: installmentDebt Float? (nullable, no @default)", /\n\s*installmentDebt Float\?\s*\n/.test(model));
  check("schema: no default on installmentDebt", !/installmentDebt[^\n]*@default/.test(model));
  const readme = readFileSync(path.join(DIR, "README.md"), "utf8");
  check("README states S2 review before apply", /NOT before S2 line-reviews/.test(readme));
  check("README states code reading the column requires the migration first", /applied BEFORE the F1b code is deployed/.test(readme));
  check("README carries the exact Preview-only rollback block (one psql -1)",
    readme.includes("## Rollback (Preview only, S2 approval)")
    && readme.includes(`psql -1 "$PREVIEW_DATABASE_URL"`)
    && readme.includes(`ALTER TABLE "SpaceSnapshot" DROP COLUMN "installmentDebt";`)
    && readme.includes(`DELETE FROM _prisma_migrations WHERE migration_name='${NAME}';`));
  const names = readdirSync(path.join(ROOT, "prisma/migrations")).filter((n) => /^\d{14}_/.test(n)).sort();
  check("sorts after 20261108140000 (F9)", names.indexOf(NAME) > names.indexOf("20261108140000_mortgage_f9_property_value_basis"));
}

console.log("3. FREEZE PIN — the SQL S2 line-reviews");
{
  // Pinned at authoring (2026-11-08) for S2's line review. Any edit — even a
  // comment — fails here; once applied anywhere a change needs a NEW migration.
  const MIGRATION_SQL_SHA256 = "2cb364139e2dde8db9a1713486022153bd3ac6ae093e35fad364ce6c8d6fe2fb";
  const actual = createHash("sha256").update(readFileSync(path.join(DIR, "migration.sql"))).digest("hex");
  check("migration.sql sha256 = the pin", actual === MIGRATION_SQL_SHA256, actual);
}

if (failures > 0) { console.error(`\n✗ ${failures} failure(s)`); process.exit(1); }
console.log("\n✓ snapshot installmentDebt migration policy: all checks passed");
