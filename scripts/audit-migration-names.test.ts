/**
 * scripts/audit-migration-names.test.ts — DB-008 naming rule, on fixtures and
 * on this checkout. Hermetic.
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { auditMigrationNames, isCalendarTimestamp, LEGACY_DATE_ONLY } from "./lib/migration-names";

let failures = 0, passes = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) { passes++; console.log(`  ✓ ${name}`); }
  else { failures++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const errs = (names: string[], legacy: string[] = []) => auditMigrationNames(names, legacy).errors;

console.log("conforming sequences pass");
check("two timestamped names in order", errs(["20260101000000_a", "20260102000000_b"]).length === 0);
check("legacy date-only names pass when allowlisted, and sort monotone with timestamps",
  errs(["20260609234422_init", "20260722_legacy", "20260801120000_next"], ["20260722_legacy"]).length === 0);

console.log("non-conforming names fail");
check("a NEW date-only name fails", errs(["20260101000000_a", "20260102_b"]).some((e) => /date-only/.test(e)));
check("a non-digit prefix fails", errs(["init_schema"]).some((e) => /not <YYYYMMDDHHMMSS>/.test(e)));
check("uppercase slug fails", errs(["20260101000000_Init"]).length === 1);
check("13 digits fails", errs(["2026010100000_a"]).length === 1);
check("duplicate timestamp fails", errs(["20260101000000_a", "20260101000000_b"]).some((e) => /already used/.test(e)));
check("impossible instant fails (month 13)", errs(["20261301000000_a"]).some((e) => /calendar/.test(e)));
check("isCalendarTimestamp: Feb 30 ⇒ false, Feb 29 2028 ⇒ true", !isCalendarTimestamp("20260230000000") && isCalendarTimestamp("20280229000000"));
check("a back-dated timestamp after a later one fails (monotone)",
  errs(["20260102000000_b", "20260101000000_a"]).some((e) => /lexical|monotone/.test(e)));
check("a timestamp earlier than a preceding legacy date fails",
  errs(["20260722_legacy", "20260721120000_z"], ["20260722_legacy"]).some((e) => /lexical|monotone/.test(e)));

console.log("the legacy allowlist is exact");
check("an allowlisted name missing from the tree fails", errs(["20260101000000_a"], ["20260722_gone"]).some((e) => /shrink the allowlist/.test(e)));
check("the allowlist itself is sorted and date-only", LEGACY_DATE_ONLY.every((n) => /^\d{8}_/.test(n)) && [...LEGACY_DATE_ONLY].sort().join() === LEGACY_DATE_ONLY.join());

console.log("this checkout conforms");
{
  const names = readdirSync(join(process.cwd(), "prisma", "migrations"), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
  const r = auditMigrationNames(names);
  check(`prisma/migrations (${r.total}) has no violation`, r.errors.length === 0, r.errors.slice(0, 5).join("; "));
  check(`legacy count on disk == allowlist (${LEGACY_DATE_ONLY.length})`, r.legacy === LEGACY_DATE_ONLY.length, `${r.legacy}`);
}

console.log(`\n${passes} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
