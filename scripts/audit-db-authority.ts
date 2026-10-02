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
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) { console.log(`  ✓ ${name}`); return; }
  failures++;
  console.error(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`);
}

const read = (f: string) => { try { return readFileSync(join(ROOT, f), "utf8"); } catch { return ""; } };

/**
 * Runtime-reachable source: what actually serves a request or a job.
 *
 * ⚠️ LIST EVERY TRACKED FILE AND FILTER IN JS, rather than asking git for
 * `lib/**\/*.ts`. A git pathspec `**` requires at least one intervening
 * directory, so `lib/**\/*.ts` silently matches NOTHING at the top level —
 * lib/auth.ts, lib/session.ts, lib/rate-limit.ts and lib/space.ts were all
 * invisible to the first version of this audit. It reported a clean ratchet
 * over a set that excluded the authentication layer.
 *
 * That is precisely the failure lib/db-safety.test.ts already documents about
 * its own history: a guard whose coverage depends on a pattern nobody
 * re-checks is not a guard. Enumerate, then filter by prefix — a form that
 * cannot quietly under-match.
 */
const ROOT_DIRS = ["app/", "lib/", "jobs/", "components/"];
const RUNTIME = execSync(`git ls-files -- '*.ts' '*.tsx'`, { cwd: ROOT, encoding: "utf8" })
  .trim().split("\n").filter(Boolean)
  .filter((f) => ROOT_DIRS.some((d) => f.startsWith(d)))
  .filter((f) => !f.endsWith(".test.ts") && !f.endsWith(".test.tsx"))
  .sort();

console.log("\naudit-db-authority — every runtime database authority is intentional\n");

// ── 1. CONFINEMENT ───────────────────────────────────────────────────────────
// Who is allowed to import each role client. Everything else is an escape.

const CONFINED: Record<string, { allowed: string[]; why: string }> = {
  tenantDb: {
    allowed: ["lib/db.ts", "lib/db/tenant-context.ts"],
    why: "the tenant client must only ever be reached through withTenantDb(), which supplies the identity the policies read. A direct import is a query with NO app.user_id set, which under RLS returns nothing and under the fallback returns EVERYTHING.",
  },
  authDb: {
    // The list is meant to stay this short, and every entry runs BEFORE an
    // identity exists — that is the ONLY thing that earns fm_auth:
    //   lib/auth.ts    establishes the identity
    //   lib/session.ts re-checks revocation on every request
    //   app/api/user/email/confirm  the token IS the credential; requiring a
    //     session would break confirming from the emailed link in whatever
    //     browser opened it (owner decision, RLS-13)
    // lib/recovery-codes.ts is deliberately NOT here any more: it takes its
    // client as a parameter now, because the same module serves a pre-identity
    // verification AND post-identity regeneration AND an operator acting on
    // someone else. Authority follows the execution phase, not the module.
    allowed: ["lib/db.ts", "lib/auth.ts", "lib/session.ts", "app/api/user/email/confirm/route.ts"],
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
      // RLS-13 — the uniqueness capability. Uniqueness is a deployment-wide
      // question the tenant role cannot answer (fm_app's User policy is
      // `id = current_fm_user_id()`, so every name reads as free). It is listed
      // as a single FILE, not a directory, because the whole point is that the
      // widest authority is reached through the narrowest opening: two
      // functions that take a value and return a boolean.
      "lib/users/availability.ts",
      // RLS-C-S6 — the invite-validation capability, listed as a FILE for the
      // same reason. `validateInvite` takes a RAW INVITE TOKEN and returns a
      // closed {valid, email, requestId}; BetaAccessRequest is pre-tenant (the
      // subject has no User row, so no policy predicate can exist) and granting
      // the read to a public role would hand it `email` — a waitlist
      // enumeration oracle — and `inviteTokenHash`, the secret itself. The
      // token IS the authorisation: possession proves the right to learn that
      // one address. The suite asserts the narrowing (no email-keyed lookup, no
      // findMany), so this stays a capability and does not become a directory.
      "lib/registration-policy.ts",
      // RLS-C-S6 — the Merchant Operations review surface. MerchantMergeDecision
      // is revoked from the tenant role, and the candidate facts are
      // cross-tenant merchant/transaction counts: under fm_app they would
      // silently narrow to the reviewing operator's own rows rather than fail.
      // Gated on Merchant Operations Space membership, like the other operator
      // consoles above. The decision store and merge engine in lib/transactions/
      // need no entry at all — they take their client as a parameter.
      "app/merchant-ops/", "app/api/merchant-ops/",
    ],
    why: "fm_system reaches every tenant through role-scoped policies. It is an exceptional authority; an ordinary HTTP request handler must never execute through it.",
  },
};

/**
 * WHICH CLIENTS A FILE ACTUALLY TAKES FROM @/lib/db — asked once, used by both
 * checks below, because they were asking it two different and two differently
 * wrong ways.
 *
 * ⚠️ THE DYNAMIC FORM IS NOT A CURIOSITY, IT IS THE LAZY-DEPS IDIOM. Job modules
 * resolve their dependencies inside a `defaultDeps()` so importing the module
 * touches no database, and they do it in two spellings:
 *
 *     const { systemDb: db } = await import('@/lib/db');          // destructured
 *     const c = client ?? (await import('@/lib/db')).db;           // member access
 *
 * The confinement check matched only the STATIC form, so a dynamic
 * `const { authDb } = await import('@/lib/db')` anywhere in the tree was
 * invisible to it — and authDb's entire value is that its importer list is four
 * files long. The ratchet had the mirror-image defect: it counted ANY dynamic
 * import of the module whatever was destructured, so a file that fully adopted
 * `systemDb` stayed recorded as reaching the migration principal for ever and
 * the ratchet could never reach zero by honest work.
 *
 * ⚠️ AND THE OBVIOUS FIX IS A TRAP, WHICH IS WHY THE PATTERN FORBIDS `{` AND
 * NEWLINES INSIDE THE BINDING LIST. Written as `\{([^}]*)\}\s*=\s*await …` the
 * brace that matches is some earlier BLOCK's, and the capture swallows whole
 * lines up to the real destructuring — so `{ db }` was read as the binding
 * `const { db` and jobs/sync-crypto.ts and lib/crypto/eth-sync.ts silently left
 * the ratchet. Measured, not reasoned about: the first version of this fix
 * dropped four files and two of them genuinely still reach `db`.
 *
 * UNRECOGNISED DYNAMIC USE COUNTS AS `db`. A spelling neither form matches is
 * reported as the migration principal rather than as nothing, so a novel one
 * fails the ratchet loudly instead of disappearing from it.
 */
const DYN_DESTRUCTURE = /\{([^{}\n]*)\}\s*=\s*await\s+import\(\s*["']@\/lib\/db["']\s*\)/g;
const DYN_MEMBER      = /\(\s*await\s+import\(\s*["']@\/lib\/db["']\s*\)\s*\)\s*\.\s*(\w+)/g;
const DYN_ANY         = /await\s+import\(\s*["']@\/lib\/db["']\s*\)/g;
const STATIC_IMPORT   = /import\s*\{([^{}]*)\}\s*from\s*["']@\/lib\/db["']/g;

/** The exported names a file binds from @/lib/db, as it binds them (pre-alias). */
function clientsTakenFrom(src: string): Set<string> {
  const taken = new Set<string>();
  const addBindings = (list: string) => {
    for (const b of list.split(",")) {
      const name = b.trim().split(/\s+as\s+/)[0].trim();
      if (name) taken.add(name);
    }
  };
  for (const m of src.matchAll(STATIC_IMPORT)) addBindings(m[1]);
  let recognised = 0;
  for (const m of src.matchAll(DYN_DESTRUCTURE)) { addBindings(m[1]); recognised++; }
  for (const m of src.matchAll(DYN_MEMBER))      { taken.add(m[1]);   recognised++; }
  if ([...src.matchAll(DYN_ANY)].length > recognised) taken.add("db");
  return taken;
}

for (const [symbol, { allowed, why }] of Object.entries(CONFINED)) {
  const importers = RUNTIME.filter((f) => clientsTakenFrom(read(f)).has(symbol));
  const strays = importers.filter((f) => !allowed.some((a) => (a.endsWith("/") ? f.startsWith(a) : f === a)));
  check(`${symbol} is confined to the code that owns that authority`,
    strays.length === 0,
    strays.length ? `${why}\n      Unexpected importer(s): ${strays.join(", ")}` : "");
}

// ── 2. THE RATCHET ───────────────────────────────────────────────────────────
// The set of runtime files still importing the migration-principal client.
// Recorded, not banned. It may shrink; it may never grow.

const BASELINE_FILE = "scripts/lib/db-authority-baseline.json";

// `db` — the migration principal — however it was reached: statically, by
// destructuring a dynamic import, or off one as a member. Not tenantDb /
// authDb / systemDb, which are the point of adopting an authority.
const globalImporters = RUNTIME.filter((f) => clientsTakenFrom(read(f)).has("db")).sort();

const baselinePath = join(ROOT, BASELINE_FILE);

if (process.argv.includes("--write-baseline")) {
  writeFileSync(baselinePath, JSON.stringify({
    note: "RLS-4 ratchet. Runtime-reachable files still reaching the database through the migration principal (@/lib/db `db`). This set may SHRINK freely as adoption proceeds; it may never GROW. Regenerate with `npx tsx scripts/audit-db-authority.ts --write-baseline`, and say in the commit why anything added is justified.",
    generatedAt: new Date().toISOString().slice(0, 10),
    count: globalImporters.length,
    files: globalImporters,
  }, null, 2) + "\n");
  console.log(`  wrote ${BASELINE_FILE}: ${globalImporters.length} file(s)\n`);
  process.exit(0);
}

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
