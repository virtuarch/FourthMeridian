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
 *
 *   3. A RATCHET ON THE DEFAULTED AUTHORITY (RLS-PREP-C). Check 2 counts files
 *      that IMPORT `db`. It cannot see a file that reaches `db` without
 *      importing it — and that turned out to be the more dangerous half. A
 *      library function declared `client?: X` and resolved it `?? db`; a route
 *      called it with no client; the route imported nothing from @/lib/db, sat
 *      outside the baseline, and read a tenant's portfolio as the table owner.
 *      Three foreground routes were in that state (Investments workspace,
 *      wealth amendment, the Connections page and its poller) and the ratchet
 *      reported them as converted, because by its only measure they were.
 *
 *      So two more things are recorded, and neither may grow:
 *        · DEFAULT SITES — every place runtime code resolves a missing client
 *          to the migration principal (`?? db`, a `= db` parameter default, or
 *          the lazy `(await import("@/lib/db")).db` spelling), per file.
 *        · IMPLICIT OWNER CALLS — every call, anywhere in runtime code, to a
 *          function that HAS such a default and is handed no authority. That is
 *          the call that looks like nothing and executes as the owner.
 *      Removing a default removes its implicit calls with it, which is the
 *      direction this is meant to be driven in.
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
/** Every tracked .ts/.tsx, unfiltered — the RLS-suite check below scans scripts/. */
const RUNTIME_ALL = execSync(`git ls-files -- '*.ts' '*.tsx'`, { cwd: ROOT, encoding: "utf8" })
  .trim().split("\n").filter(Boolean).sort();
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
      // RLS-AI — the AI cost ledger. AiInvocation is REVOKED from fm_app and has
      // no tenant column by a recorded privacy decision, so fm_system is the only
      // authority that can write it. Listed as a FILE, not a directory, for the
      // same reason as availability.ts above: the opening is one function that
      // takes a usage payload and returns void. It is fired `void` from
      // provider.ts DURING a model call, so it could not live in a tenant
      // transaction even if a tenant could write the table.
      "lib/ai/invocation.ts",
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
      // RLS-C-S7 — the "revoke everywhere" capability, listed as a single FILE
      // and NOT as `lib/accounts/`, which must never become a systemDb
      // neighbourhood. Disconnecting an account revokes EVERY SpaceAccountLink
      // pointing at it, including a co-owner's in a Space the actor is not a
      // member of; that has always been the semantics, and fm_app cannot express
      // it, because `SpaceAccountLink.fm_app_sel` is `spaceId IN
      // (SELECT fm_visible_space_ids())` — the co-owner's link is INVISIBLE, so
      // the revoke would land on one row of two and `updateMany` would report a
      // smaller count instead of raising. A partial is worse than a zero: 1-of-2
      // looks exactly like success. Authority therefore follows the operation's
      // true blast radius, through the narrowest possible opening: two functions
      // that take ALREADY-AUTHORIZED account ids (proved in a withTenantDb phase
      // by the callers) and return counts plus Space ids, never rows. There is no
      // spaceId parameter and no userId SELECTOR, so no argument through which a
      // caller could ask it about somebody else. The suite asserts the narrowing
      // (every `where` mentions only financialAccountId and status) and both of
      // the orderings the policies force, so this stays a capability.
      // Decision: docs/plans/RLS-DISCONNECT-BLAST-RADIUS.md.
      "lib/accounts/links-everywhere.ts",
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

// ── 2b. THE DEFAULTED AUTHORITY ──────────────────────────────────────────────
// Comments are stripped first: this codebase explains its defaults at length,
// and a sentence that QUOTES `?? db` is not a default.
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " ")).replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");

/**
 * The three spellings of "no client was passed, so use the migration principal":
 *   `x ?? db`                               the option-bag form
 *   `client: T = db`                        the parameter-default form
 *   `x ?? (await import("@/lib/db")).db`    the lazy-deps form
 * `\bdb\b` and the lookahead keep `?? dbFoo` and `= db.something` out.
 */
const OWNER_DEFAULT =
  /\?\?\s*db\b(?!\s*\.)|=\s*db\b(?=\s*[,)\n])|\?\?\s*\(\s*await\s+import\(\s*["']@\/lib\/db["']\s*\)\s*\)\s*\.\s*db\b/g;

/** The nearest function declared ABOVE an index — the one whose default it is. */
function enclosingFunction(code: string, index: number): string | null {
  const head = code.slice(0, index);
  const re = /(?:^|\n)\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)|(?:^|\n)\s*(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s*)?(?:<[^>]*>\s*)?\(/g;
  let name: string | null = null;
  for (const m of head.matchAll(re)) name = m[1] ?? m[2] ?? name;
  return name;
}

const defaultSites: Record<string, number> = {};
const defaultedFunctions = new Set<string>();
for (const f of RUNTIME) {
  const code = stripComments(read(f));
  const hits = [...code.matchAll(OWNER_DEFAULT)];
  if (hits.length === 0) continue;
  defaultSites[f] = hits.length;
  for (const h of hits) {
    const fn = enclosingFunction(code, h.index ?? 0);
    if (fn) defaultedFunctions.add(fn);
  }
}

/** The text between a call's parentheses, balanced. Null if it never closes. */
function callArguments(code: string, openParen: number): string | null {
  let depth = 0;
  for (let i = openParen; i < code.length; i++) {
    const c = code[i];
    if (c === "(") depth++;
    else if (c === ")") { depth--; if (depth === 0) return code.slice(openParen + 1, i); }
  }
  return null;
}

/**
 * A call "names an authority" when its arguments mention one. Deliberately
 * generous — `tx`, `client`, an explicit `db`/`systemDb`/`authDb`, or anything
 * ending in Client/Db — because the failure this check exists for is the call
 * that mentions NONE, and a false "implicit" would teach people to ignore it.
 * An explicit `db` is not hidden: the IMPORT ratchet above already counts it.
 */
const NAMES_AUTHORITY = /\b(tx|client|db|systemDb|authDb|tenantDb|database|prisma|deps|\w+Client|\w+Db)\b/;

const implicitOwnerCalls: string[] = [];
for (const f of RUNTIME) {
  const code = stripComments(read(f));
  for (const fn of defaultedFunctions) {
    const call = new RegExp(`(?<![\\w.])${fn}\\(`, "g");
    for (const m of code.matchAll(call)) {
      const at = m.index ?? 0;
      // A declaration is not a call.
      if (/function\s+$/.test(code.slice(Math.max(0, at - 12), at))) continue;
      const args = callArguments(code, at + m[0].length - 1);
      if (args === null || NAMES_AUTHORITY.test(args)) continue;
      implicitOwnerCalls.push(`${f} -> ${fn}`);
    }
  }
}
implicitOwnerCalls.sort();
const totalDefaults = Object.values(defaultSites).reduce((a, b) => a + b, 0);

if (process.argv.includes("--write-baseline")) {
  writeFileSync(baselinePath, JSON.stringify({
    note: "RLS-4 ratchet. Runtime-reachable files still reaching the database through the migration principal (@/lib/db `db`). This set may SHRINK freely as adoption proceeds; it may never GROW. Regenerate with `npx tsx scripts/audit-db-authority.ts --write-baseline`, and say in the commit why anything added is justified.",
    generatedAt: new Date().toISOString().slice(0, 10),
    count: globalImporters.length,
    files: globalImporters,
    defaultSiteCount: totalDefaults,
    defaultSites,
    implicitOwnerCallCount: implicitOwnerCalls.length,
    implicitOwnerCalls,
  }, null, 2) + "\n");
  console.log(`  wrote ${BASELINE_FILE}: ${globalImporters.length} importing file(s), ${totalDefaults} default site(s), ${implicitOwnerCalls.length} implicit owner call(s)\n`);
  process.exit(0);
}

if (!existsSync(baselinePath)) {
  console.error(`\n  ✗ missing ${BASELINE_FILE}. Regenerate with:\n      npx tsx scripts/audit-db-authority.ts --write-baseline\n`);
  process.exit(1);
}
const baselineDoc = JSON.parse(readFileSync(baselinePath, "utf8")) as {
  files: string[];
  defaultSites?: Record<string, number>;
  implicitOwnerCalls?: string[];
};
const baseline: string[] = baselineDoc.files;

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

// ── 2b (continued). NEITHER THE DEFAULTS NOR THEIR SILENT CALLERS MAY GROW ───
{
  const baseSites = baselineDoc.defaultSites;
  const baseCalls = baselineDoc.implicitOwnerCalls;
  check("the baseline records the defaulted-authority sets (regenerate it if this fails on an old file)",
    baseSites !== undefined && baseCalls !== undefined,
    `npx tsx scripts/audit-db-authority.ts --write-baseline`);

  const grown = Object.entries(defaultSites).filter(([f, n]) => n > (baseSites?.[f] ?? 0));
  const baseTotal = Object.values(baseSites ?? {}).reduce((a, b) => a + b, 0);
  check(`no NEW place resolves a missing client to the migration principal (${totalDefaults} default site(s), baseline ${baseTotal})`,
    grown.length === 0,
    grown.length
      ? `A parameter that defaults to \`db\` makes every caller that forgets it an owner without saying so.\n      Make the client REQUIRED and LEADING instead:\n        ${grown.map(([f, n]) => `${f}  (${baseSites?.[f] ?? 0} -> ${n})`).join("\n        ")}`
      : "");

  // Compared as multisets: the same file may legitimately call one defaulted
  // function twice, and a second silent call is growth even though its label
  // already appears once.
  const remaining = [...(baseCalls ?? [])];
  const newCalls: string[] = [];
  for (const c of implicitOwnerCalls) {
    const i = remaining.indexOf(c);
    if (i === -1) newCalls.push(c); else remaining.splice(i, 1);
  }
  check(`no NEW call reaches the migration principal by passing no authority (${implicitOwnerCalls.length} implicit call(s), baseline ${baseCalls?.length ?? 0})`,
    newCalls.length === 0,
    newCalls.length
      ? `These call a function whose client defaults to \`db\` and hand it none, so they execute as the\n      table owner while importing nothing that says so. Pass the phase you are in:\n        ${newCalls.join("\n        ")}`
      : "");

  if (remaining.length) {
    console.log(`  · ${remaining.length} implicit owner call(s) were closed since the baseline — regenerate it to lock that in.`);
  }
  const shrunk = Object.entries(baseSites ?? {}).filter(([f, n]) => (defaultSites[f] ?? 0) < n);
  if (shrunk.length) {
    console.log(`  · ${shrunk.length} file(s) dropped an owner default since the baseline — regenerate it to lock that in.`);
  }
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

  // ⚠️ EVERY REAL-ROLE SUITE MUST CHECK THE BINDING, NOT ONLY THE URL.
  //
  // assertTenantPrincipal() interrogates a connection string with psql, which
  // proves the CREDENTIAL is constrained and says nothing about which client
  // lib/db bound. Those came apart: a probe added a STATIC import of a
  // production module, that module imported "@/lib/db" before the harness had
  // set DATABASE_URL_APP, tenantDb fell back to the legacy client, and Prisma
  // connected as the throwaway's SUPERUSER OWNER. Every refusal became a
  // success. The probe reported no defects at all — and the harness printed
  // "tenant principal verified: fm_app" during that very run.
  //
  // assertTenantClientBound() closes it by asking the binding. This asserts no
  // suite can forget to call it: a new scripts/rls-*acceptance.ts that skips it
  // fails the build rather than silently measuring the owner principal.
  {
    // Scoped to the suites that actually BIND lib/db — i.e. the ones that call
    // prepareHarness(). scripts/rls-acceptance.ts is deliberately not among
    // them: it drives psql directly and constructs its own PrismaClient, so
    // there is no lib/db binding for this hazard to corrupt. Deriving the set
    // from prepareHarness rather than from the filename means a suite cannot
    // dodge the check by being named differently, and a suite that genuinely
    // does not bind is not asked to prove something that does not apply.
    const suites = RUNTIME_ALL.filter(
      (f) => /^scripts\/rls-.*\.ts$/.test(f) && read(f).includes("prepareHarness("),
    );
    const missing = suites.filter((f) => !read(f).includes("assertTenantClientBound"));
    check(`every suite that binds lib/db verifies the BOUND client, not just the URL (${suites.length} suite(s))`,
      suites.length > 0 && missing.length === 0,
      suites.length === 0
        ? "found NO suite calling prepareHarness() — the scan is broken, not the tree"
        : `these measure a URL and could be running as the table owner: ${missing.join(", ")}`);
  }
}

if (failures > 0) {
  console.error(`\naudit-db-authority: ${failures} failure(s).\n`);
  process.exit(1);
}
console.log("\naudit-db-authority: all passed.\n");
