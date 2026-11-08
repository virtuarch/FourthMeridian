/**
 * lib/assets/property-equity-migration.test.ts — Mortgage F9 migration policy
 *
 * Parses prisma/migrations/20261108140000_mortgage_f9_property_value_basis and
 * pins the owner's "handle existing records conservatively without silently
 * rewriting them": ADDITIVE ONLY (one CREATE TYPE + ADD COLUMNs on
 * ManualAssetProfile), the defaults (valueBasis UNKNOWN, links empty, kind NULL),
 * and NO UPDATE / DELETE / INSERT / DROP / ALTER COLUMN / grant or policy change.
 * Also pins the schema enum = the code's PROPERTY_VALUE_BASES.
 *
 *   npx tsx lib/assets/property-equity-migration.test.ts
 */

import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { PROPERTY_VALUE_BASES } from "./property-equity";

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (ok) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const ROOT = process.cwd();
const NAME = "20261108140000_mortgage_f9_property_value_basis";
const raw = readFileSync(path.join(ROOT, "prisma/migrations", NAME, "migration.sql"), "utf8");
const sql = raw.replace(/--[^\n]*/g, "").replace(/\s+/g, " ").trim();

console.log("1. additive only");
{
  const statements = sql.split(";").map((s) => s.trim()).filter(Boolean);
  check("exactly two statements", statements.length === 2, String(statements.length));
  check("statement 1 creates the enum", /^CREATE TYPE "PropertyValueBasis" AS ENUM \('MARKET_VALUE', 'EQUITY_ENTERED', 'UNKNOWN'\)$/.test(statements[0] ?? ""));
  check("statement 2 alters ManualAssetProfile only", /^ALTER TABLE "ManualAssetProfile" /.test(statements[1] ?? ""));
  const clauses = (statements[1] ?? "").replace(/^ALTER TABLE "ManualAssetProfile" /, "").split(/,\s*(?=ADD COLUMN)/);
  check("every clause is ADD COLUMN", clauses.length === 3 && clauses.every((c) => c.startsWith("ADD COLUMN ")), clauses.join(" | "));
  for (const kw of ["UPDATE", "DELETE", "INSERT", "DROP", "TRUNCATE", "GRANT", "REVOKE", "POLICY", "ALTER COLUMN", "RENAME", "SET NOT NULL"]) {
    check(`no ${kw}`, !new RegExp(`\\b${kw}\\b`, "i").test(sql));
  }
}

console.log("2. defaults (existing rows read UNKNOWN / [] / NULL)");
{
  check("valueBasis NOT NULL DEFAULT 'UNKNOWN'", sql.includes(`ADD COLUMN "valueBasis" "PropertyValueBasis" NOT NULL DEFAULT 'UNKNOWN'`));
  check("securedDebtAccountIds defaults to an empty array", sql.includes(`ADD COLUMN "securedDebtAccountIds" TEXT[] DEFAULT ARRAY[]::TEXT[]`));
  check("assetKind nullable, no default", /ADD COLUMN "assetKind" TEXT(,|$)/.test(sql));
}

console.log("3. schema + code agree; README; ordering");
{
  const schema = readFileSync(path.join(ROOT, "prisma/schema.prisma"), "utf8");
  const m = schema.match(/enum PropertyValueBasis \{([^}]*)\}/);
  const values = (m?.[1] ?? "").split(/\s+/).filter(Boolean);
  check("schema enum = PROPERTY_VALUE_BASES", JSON.stringify(values) === JSON.stringify([...PROPERTY_VALUE_BASES]), values.join(","));
  check("schema default UNKNOWN", /valueBasis\s+PropertyValueBasis\s+@default\(UNKNOWN\)/.test(schema));
  const readme = readFileSync(path.join(ROOT, "prisma/migrations", NAME, "README.md"), "utf8");
  check("README states S2 review before apply", /NOT before S2 reviews/.test(readme));
  const names = readdirSync(path.join(ROOT, "prisma/migrations")).filter((n) => /^\d{14}_/.test(n)).sort();
  check("sorts last among F9's predecessors", names.indexOf(NAME) > names.indexOf("20261108120000_platform_ai_retention_7_days"));
}

console.log("4. FREEZE PIN — S2 approved this exact SQL (2026-11-08)");
{
  // The migration was APPROVED by S2 byte-for-byte. Any edit — even a comment —
  // fails here; a change needs a NEW migration and a new review.
  const MIGRATION_SQL_SHA256 = "3d3514974f4ee4b3ff4d98654e59213e8c8acaf3637e5cf7c3a9bad87b6d4fe1";
  const actual = createHash("sha256").update(readFileSync(path.join(ROOT, "prisma/migrations", NAME, "migration.sql"))).digest("hex");
  check("migration.sql sha256 = the S2-approved pin", actual === MIGRATION_SQL_SHA256, actual);
  const readme = readFileSync(path.join(ROOT, "prisma/migrations", NAME, "README.md"), "utf8");
  check("README carries the exact Preview-only rollback block",
    readme.includes("## Rollback (Preview only, S2 approval)")
    && readme.includes(`ALTER TABLE "ManualAssetProfile" DROP COLUMN "assetKind", DROP COLUMN "securedDebtAccountIds", DROP COLUMN "valueBasis";`)
    && readme.includes(`DROP TYPE "PropertyValueBasis";`)
    && readme.includes(`DELETE FROM _prisma_migrations WHERE migration_name='${NAME}';`));
}

if (failures > 0) { console.error(`\n✗ ${failures} failure(s)`); process.exit(1); }
console.log("\n✓ property-equity migration policy: all checks passed");
