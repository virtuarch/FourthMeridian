/**
 * lib/db-safety.test.ts  (Recovery/Hardening slice)
 *
 * SOURCE-SCAN test: the destructive-DB guardrails are wired so an accidental
 * reset (the incident that motivated this slice) cannot happen via the sanctioned
 * scripts. Deterministic, no DB.
 */

import { execSync } from "node:child_process";
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
  // cdeac7e — the decision moved into the pure core (scripts/lib/db-guard.core.ts);
  // the script wires it. The contract is pinned across both files.
  const guard = src("scripts/db-guard.ts") + src("scripts/lib/db-guard.core.ts");
  check("guard requires ALLOW_DESTRUCTIVE_DB=true", guard.includes('allowDestructive !== "true"') && src("scripts/db-guard.ts").includes("process.env.ALLOW_DESTRUCTIVE_DB"));
  check("guard blocks SHADOW_DATABASE_URL === DATABASE_URL (the actual footgun)",
    guard.includes("SHADOW_DATABASE_URL") && /shadow[\s\S]*dbUrl|dbUrl[\s\S]*shadow/i.test(guard));
  check("guard exits non-zero when blocking", guard.includes("process.exit(1)"));
}

// I1 — Slice 0. A disposable process (a test, an eval, an agent harness) cannot
// reach live while the clone guard is armed, and the guard is wired at the ONE
// place every such process shares: the module-global Prisma client.
//
// ⚠️ THE INCIDENT: five of seven post-M1 agent worktrees wrote to LIVE because an
// EXPORTED DATABASE_URL beats `--env-file`. The predicate itself is proved in
// lib/db/live-guard.test.ts, including the planted accidents; this pins the WIRING.
{
  const dbSrc = src("lib/db.ts");
  check("lib/db.ts consults the clone guard", dbSrc.includes("assertNonLiveDatabase"));
  check("…before any client exists", dbSrc.indexOf("assertNonLiveDatabase(") < dbSrc.indexOf("new PrismaClient("));

  // Every write-capable script path reaches a DB through this ONE client. A new
  // `new PrismaClient` outside lib/db.ts is a path around the guard, so the set
  // of files allowed to construct one is closed and this counts it.
  // ⚠️ COMMITTED FILES ONLY. The first version listed `scripts/audit-visibility-
  // levels.ts`, which exists only as an UNTRACKED file in one checkout — so the
  // guard passed there and failed in a clean worktree. A guard about the code must
  // read the code that is committed, never whatever happens to be on one disk.
  const OWN_CLIENT = [
    "prisma/seed.ts", "scripts/db-guard.ts", "scripts/backfill-ai-agents.ts",
    "scripts/backfill-personal-sections.ts", "scripts/diagnose-invalid-plaid-tokens.ts",
    "scripts/run-reconstruction.ts", "scripts/audit-ciphertext-versions.ts",
    "scripts/copy-fx-rates.ts",
    "scripts/test-incident-transaction-safety.ts", "scripts/test-visibility-two-user-space.impl.ts",
  ];
  // ⚠️ TEST FILES EXCLUDED, because a test that ASSERTS about `new PrismaClient`
  // contains the string without constructing one — this file and
  // lib/db/live-guard.test.ts both do.
  const found = execSync("git grep -l 'new PrismaClient' -- 'prisma/*.ts' 'scripts/*.ts' 'lib/*.ts' 'app/*.ts' 'jobs/*.ts' || true",
    { cwd: ROOT, encoding: "utf8" }).trim().split("\n")
    .filter((f) => f && !f.endsWith(".test.ts")).sort();
  const expected = [...OWN_CLIENT, "lib/db.ts"].sort();
  check("no NEW way around the guard: `new PrismaClient` only in the known files",
    JSON.stringify(found) === JSON.stringify(expected));
}

// Backups are never committed.
{
  const gitignore = src(".gitignore");
  check("backups/ is gitignored", /^backups\/?$/m.test(gitignore));
}

if (failures > 0) { console.error(`\ndb-safety: ${failures} failure(s).`); process.exit(1); }
console.log("\ndb-safety: all passed.");
