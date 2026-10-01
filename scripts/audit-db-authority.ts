/**
 * scripts/audit-db-authority.ts  (RLS-4)
 *
 * EVERY RUNTIME DATABASE AUTHORITY IS INTENTIONAL.
 *
 * Tenant isolation is enforced by PostgreSQL policies bound to the CONNECTING
 * ROLE, which means the client a code path chooses IS its authority. `db` is the
 * migration principal: it owns every table and carries BYPASSRLS, so a query
 * through it is exempt from every policy. That is correct for migrations and
 * catastrophic for a request handler, and nothing about the two call sites looks
 * different.
 *
 * So the difference is asserted here instead of reviewed by eye.
 *
 * ── WHAT THIS ENFORCES ───────────────────────────────────────────────────────
 *
 *   1. CONFINEMENT. Each role client may only be imported by the code that owns
 *      that authority. authDb is the sharpest: it exists so authentication can
 *      read User/UserSession before an identity exists, and the moment it is
 *      importable from ordinary product code it becomes a general-purpose
 *      bypass with a reassuring name.
 *
 *   2. A RATCHET ON THE GLOBAL CLIENT. Adoption is incremental, so a blanket ban
 *      on `db` in runtime code would fail today and teach nothing. Instead the
 *      current set is recorded. It may SHRINK freely; it may never GROW. A new
 *      unexplained `db` import in runtime-reachable code fails the build and
 *      names the file.
 *
 * A ratchet rather than a target, because the honest state is "adoption in
 * progress" and a gate that pretends otherwise is the kind that gets disabled.
 */

import { execSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) { console.log(`  ✓ ${name}`); return; }
  failures++;
  console.error(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`);
}

const tracked = (globs: string[]): string[] =>
  execSync(`git ls-files -- ${globs.map((g) => `'${g}'`).join(" ")}`, { cwd: ROOT, encoding: "utf8" })
    .trim().split("\n").filter(Boolean);

const read = (f: string) => { try { return readFileSync(join(ROOT, f), "utf8"); } catch { return ""; } };

/** Runtime-reachable source: what actually serves a request or a job. */
const RUNTIME = tracked(["app/**/*.ts", "app/**/*.tsx", "lib/**/*.ts", "jobs/**/*.ts", "components/**/*.tsx", "components/**/*.ts"])
  .filter((f) => !f.endsWith(".test.ts") && !f.endsWith(".test.tsx"));

console.log("\naudit-db-authority — every runtime database authority is intentional\n");

// ── 1. CONFINEMENT ───────────────────────────────────────────────────────────
// Who is allowed to import each role client. Everything else is an escape.

const CONFINED: Record<string, { allowed: string[]; why: string }> = {
  tenantDb: {
    allowed: ["lib/db.ts", "lib/db/tenant-context.ts"],
    why: "the tenant client must only ever be reached through withTenantDb(), which supplies the identity the policies read. A direct import is a query with NO app.user_id set, which under RLS returns nothing and under the fallback returns EVERYTHING.",
  },
  authDb: {
    allowed: ["lib/db.ts", "lib/auth.ts", "lib/session.ts"],
    why: "fm_auth exists so authentication can read User/UserSession BEFORE an identity exists. Imported anywhere else it is a convenience escape hatch from tenancy with a reassuring name.",
  },
  systemDb: {
    allowed: [
      "lib/db.ts",
      "jobs/", "lib/jobs/", "app/api/jobs/",
      "lib/plaid/", "lib/crypto/", "lib/snapshots/", "lib/prices/",
      "lib/platform/", "app/api/platform/", "app/api/admin/",
      "lib/notifications/", "lib/security/", "lib/account-deletion/",
      "lib/alerts/", "lib/usage/", "lib/investments/",
    ],
    why: "fm_system reaches every tenant through role-scoped policies. It is an exceptional authority; an ordinary HTTP request handler must never execute through it.",
  },
};

for (const [symbol, { allowed, why }] of Object.entries(CONFINED)) {
  const importers = RUNTIME.filter((f) => {
    const src = read(f);
    return new RegExp(`import\\s*\\{[^}]*\\b${symbol}\\b[^}]*\\}\\s*from\\s*["']@/lib/db["']`).test(src);
  });
  const strays = importers.filter((f) => !allowed.some((a) => (a.endsWith("/") ? f.startsWith(a) : f === a)));
  check(`${symbol} is confined to the code that owns that authority`,
    strays.length === 0,
    strays.length ? `${why}\n      Unexpected importer(s): ${strays.join(", ")}` : "");
}

// ── 2. THE RATCHET ───────────────────────────────────────────────────────────
// The set of runtime files still importing the migration-principal client.
// Recorded, not banned. It may shrink; it may never grow.

const BASELINE_FILE = "scripts/lib/db-authority-baseline.json";

const globalImporters = RUNTIME.filter((f) => {
  const src = read(f);
  // `db` as a named import from @/lib/db, not tenantDb/authDb/systemDb.
  const m = src.match(/import\s*\{([^}]*)\}\s*from\s*["']@\/lib\/db["']/);
  if (m && m[1].split(",").some((s) => s.trim().split(/\s+as\s+/)[0].trim() === "db")) return true;
  // dynamic import, which the investigation found in at least one job
  return /await\s+import\(\s*["']@\/lib\/db["']\s*\)/.test(src);
}).sort();

const baselinePath = join(ROOT, BASELINE_FILE);
if (!existsSync(baselinePath)) {
  console.error(`\n  ✗ missing ${BASELINE_FILE}. Regenerate with:\n      npx tsx scripts/audit-db-authority.ts --write-baseline\n`);
  process.exit(1);
}
const baseline: string[] = JSON.parse(readFileSync(baselinePath, "utf8")).files;

const added = globalImporters.filter((f) => !baseline.includes(f));
const removed = baseline.filter((f) => !globalImporters.includes(f));

check(`no NEW runtime file reaches the database through the migration principal (${globalImporters.length} remain, baseline ${baseline.length})`,
  added.length === 0,
  added.length
    ? `These import the global \`db\` and are runtime-reachable. Route them to an explicit authority\n      (withTenantDb / authDb / systemDb), or if the use is justified, record it by regenerating\n      the baseline and saying why in the commit:\n        ${added.join("\n        ")}`
    : "");

if (removed.length) {
  console.log(`  · ${removed.length} file(s) adopted an explicit authority since the baseline — regenerate it to lock the progress in:`);
  for (const f of removed.slice(0, 12)) console.log(`      ${f}`);
  if (removed.length > 12) console.log(`      … and ${removed.length - 12} more`);
}

// ── 3. STRICT MODE CANNOT BE SILENTLY DEFEATED ───────────────────────────────
{
  const strict = read("lib/db/strict-mode.ts");
  const dbSrc  = read("lib/db.ts");
  check("strict mode is asserted BEFORE any role client is constructed",
    dbSrc.includes("assertStrictRoleConfiguration()")
    && dbSrc.indexOf("assertStrictRoleConfiguration()") < dbSrc.indexOf("function roleClient"));
  check("strict mode refuses the migration principal as a role URL",
    strict.includes("isMigrationPrincipal") && /postgres\./.test(strict));
  check("strict mode treats a missing role URL as fatal, not as a fallback",
    /is not set\./.test(strict) && strict.includes("Refusing to start"));
  check("the authoritative check asks the DATABASE who it is, not the URL",
    strict.includes("current_user") && strict.includes("rolbypassrls") && strict.includes("rolsuper"));
}

// ── 4. THE TENANT CHANNEL ITSELF ─────────────────────────────────────────────
{
  const ctx = read("lib/db/tenant-context.ts");
  check("the tenant identity is transaction-local (set_config(..., true))",
    /set_config\([\s\S]{0,80}true\s*\)/.test(ctx));
  check("the tenant channel refuses an empty identity",
    ctx.includes("TenantIdentityError"));
}

if (failures > 0) {
  console.error(`\naudit-db-authority: ${failures} failure(s).\n`);
  process.exit(1);
}
console.log("\naudit-db-authority: all passed.\n");
