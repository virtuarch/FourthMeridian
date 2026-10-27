/**
 * lib/platform/growth-rename.test.ts  (P-3 — "Growth & Revenue" → "Growth")
 *
 * Owner ruling 2026-10-27: rename the Growth platform Space through a narrowly
 * scoped, tested, reversible migration; preserve area identifiers and grants.
 * Source scans + the registry; the SQL itself is exercised by the CI
 * architecture job (`prisma migrate deploy` + seed on a throwaway database).
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { PLATFORM_AREAS, ALL_PLATFORM_AREAS } from "@/lib/platform/policy";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const MIGRATION = "prisma/migrations/20261027230000_platform_growth_rename/migration.sql";
const raw = readFileSync(path.join(process.cwd(), MIGRATION), "utf8");
const sql = raw.replace(/--.*$/gm, "").replace(/\s+/g, " ").trim();

console.log("the migration is one guarded UPDATE of one row's display name");
check("exactly one statement", (sql.match(/;/g) ?? []).length === 1, sql);
check("it is an UPDATE of \"Space\".\"name\" only",
  /^UPDATE "Space" SET "name" = 'Growth' WHERE /.test(sql) && !/,/.test(sql.split(" WHERE ")[0]));
check("scoped to the GROWTH_REVENUE platform Space", /"platformArea" = 'GROWTH_REVENUE'/.test(sql));
check("guarded on the original name (idempotent; a customised name is left alone)", /AND "name" = 'Growth & Revenue'/.test(sql));
check("no DDL, delete, insert or grant change", !/\b(ALTER|DROP|DELETE|INSERT|TRUNCATE|GRANT|REVOKE|CREATE)\b/i.test(sql));
check("the rollback statement is documented in the file",
  /UPDATE "Space" SET "name" = 'Growth & Revenue'\s*\n--\s*WHERE "platformArea" = 'GROWTH_REVENUE' AND "name" = 'Growth';/.test(raw));
check("Production application is called out as owner-gated", /Production\s*\n?--?\s*requires explicit owner release approval/.test(raw));

console.log("identifiers preserved; new name in the registry");
check("the area key is still GROWTH_REVENUE", ALL_PLATFORM_AREAS.includes("GROWTH_REVENUE" as never) && PLATFORM_AREAS.GROWTH_REVENUE.key === "GROWTH_REVENUE");
check("label and seeded Space name are \"Growth\"", PLATFORM_AREAS.GROWTH_REVENUE.label === "Growth" && PLATFORM_AREAS.GROWTH_REVENUE.spaceName === "Growth");

if (failures > 0) {
  console.error(`\ngrowth-rename: ${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\ngrowth-rename: all checks passed.");
