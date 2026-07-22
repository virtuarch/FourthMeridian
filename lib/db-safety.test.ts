/**
 * lib/db-safety.test.ts  (Recovery/Hardening slice)
 *
 * SOURCE-SCAN test: the destructive-DB guardrails are wired so an accidental
 * reset (the incident that motivated this slice) cannot happen via the sanctioned
 * scripts. Deterministic, no DB.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const src = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

let failures = 0;
function check(name: string, cond: boolean): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}`); }
}

console.log("db-safety — destructive DB ops are guarded + backed up");

const pkg = JSON.parse(src("package.json")) as { scripts: Record<string, string> };

// db:reset must route through the guard AND take a backup before resetting.
{
  const reset = pkg.scripts["db:reset"] ?? "";
  check("db:reset runs the guard before anything", reset.includes("db-guard"));
  check("db:reset takes a backup before resetting", reset.includes("db:backup"));
  check("db:reset is not a bare `prisma migrate reset`", reset !== "prisma migrate reset");
  check("db:migrate:safe uses additive deploy (never reset)", (pkg.scripts["db:migrate:safe"] ?? "").includes("migrate deploy"));
  check("db:backup script exists", typeof pkg.scripts["db:backup"] === "string");
}

// The guard enforces explicit opt-in + blocks the shadow-DB footgun.
{
  const guard = src("scripts/db-guard.ts");
  check("guard requires ALLOW_DESTRUCTIVE_DB=true", guard.includes('ALLOW_DESTRUCTIVE_DB !== "true"'));
  check("guard blocks SHADOW_DATABASE_URL === DATABASE_URL (the actual footgun)",
    guard.includes("SHADOW_DATABASE_URL") && /shadow[\s\S]*dbUrl|dbUrl[\s\S]*shadow/i.test(guard));
  check("guard exits non-zero when blocking", guard.includes("process.exit(1)"));
}

// Backups are never committed.
{
  const gitignore = src(".gitignore");
  check("backups/ is gitignored", /^backups\/?$/m.test(gitignore));
}

if (failures > 0) { console.error(`\ndb-safety: ${failures} failure(s).`); process.exit(1); }
console.log("\ndb-safety: all passed.");
