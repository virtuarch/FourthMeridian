/**
 * app/api/accounts/accounts-spine-s1.authority.test.ts  (RLS-ACC-S1)
 *
 * THE FOUR OWNER-SCOPED ACCOUNT READS EXECUTE AS THE CALLER, AND THE WORK THAT
 * MUST NOT BE INSIDE A SECURITY BOUNDARY IS OUTSIDE IT.
 *
 * ── WHY THIS IS A STRUCTURAL SCAN AND NOT AN EXECUTION PROBE ─────────────────
 * A Next route handler cannot be invoked from a bare-tsx unit test: `requireUser`
 * and `getSpaceContext` read the request store that `headers()` provides, which
 * only exists inside a request. (V26 recorded that exact wall: "a route handler
 * can't be called from a script".) And a behavioural proof is worth less than it
 * looks here anyway — local development has NO role URLs, so every client falls
 * back to one principal and a route left on the migration principal would not
 * fail a single assertion. The real-role proof belongs in
 * scripts/rls-app-acceptance.ts; the cases wanted there are listed in the slice
 * report.
 *
 * So this file pins the two things a scan genuinely CAN carry, both of which a
 * later tidy-up is likely to undo:
 *   1. no route in the set reaches the migration principal at all; and
 *   2. WHICH SIDE of the `withTenantDb` boundary each piece of work is on. That
 *      is a question about nesting, so it is answered by extracting the call's
 *      balanced-paren region rather than by asking whether two words co-occur in
 *      a file.
 *
 * ── THE TWO FAILURE MODES THIS FILE IS BUILT AGAINST ────────────────────────
 * ⚠️ THE VACUOUS PASS. A scan over a path that does not exist, or over a file
 * that failed to read, is an absence claim with no denominator. Every route below
 * is asserted to be present, non-trivial and to export a handler BEFORE anything
 * is claimed about what it does not contain.
 *
 * ⚠️ THE BROKEN NEEDLE. This programme has shipped a scan whose `$` was
 * unescaped, matched nothing, and reported clean over zero sites. So the
 * migration-principal needle is first shown to MATCH, on a control file that
 * legitimately still holds `db` — app/api/accounts/wallet/route.ts, which is
 * fenced out of this slice and therefore a stable positive. A needle that matched
 * nothing would fail the control and the zeroes below would not be believed.
 * The region extractor is likewise shown to extract something strictly smaller
 * than the file it was given.
 *
 *   npx tsx app/api/accounts/accounts-spine-s1.authority.test.ts
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

/** Source with comments stripped, so a header EXPLAINING a hazard never satisfies a scan for it. */
function code(rel: string): string {
  return readFileSync(path.join(ROOT, rel), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");
}

/**
 * The substring a call occupies, from its opening parenthesis to the MATCHING
 * close — i.e. everything lexically inside `fn(...)`, nested calls included.
 *
 * This is the whole point of the file: "is the provider call inside the
 * transaction" is a question about NESTING, and co-occurrence in a file cannot
 * answer it. Returns null when the call is absent, which the callers treat as a
 * failure rather than as an empty region that vacuously satisfies a "does not
 * contain" assertion.
 */
function callRegion(src: string, callee: string, occurrence = 0): string | null {
  let from = -1;
  for (let seen = 0; seen <= occurrence; seen++) {
    from = src.indexOf(`${callee}(`, from + 1);
    if (from < 0) return null;
  }
  let depth = 0;
  const open = from + callee.length;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "(") depth++;
    else if (src[i] === ")") {
      depth--;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  return null;
}

/** Every `db.<model>.` reach in a file. The needle is proved against a control below. */
const migrationPrincipalReads = (src: string) => src.match(/\bdb\.[a-zA-Z][a-zA-Z0-9_]*\./g) ?? [];

// ─────────────────────────────────────────────────────────────────────────────
console.log("THE NEEDLES WORK — proved on controls before any zero is trusted");
// ─────────────────────────────────────────────────────────────────────────────
{
  // RLS-PREP-C — the control used to be the wallet route, which was "fenced out
  // of this slice, so it stays a positive". It was converted, so it stopped
  // being one, and this control went red — which is the control working. It is
  // now a route whose owner reads are DELIBERATE and documented in its own
  // header (a cross-tenant ownership count and the Space delete), so it stays a
  // positive for a reason that does not depend on anybody's backlog.
  const CONTROL = "app/api/spaces/[id]/permanent/route.ts";
  check(`CONTROL ${CONTROL} exists (its owner reads are deliberate, so it stays a positive)`,
    existsSync(path.join(ROOT, CONTROL)));
  const control = code(CONTROL);
  check("the migration-principal needle MATCHES the control — so a zero below means something",
    migrationPrincipalReads(control).length > 0,
    `matched ${migrationPrincipalReads(control).length}`);
  check("…and the control genuinely imports the migration principal",
    /from\s+"@\/lib\/db"/.test(control));

  // The region extractor, shown to extract and to be strictly smaller than its input.
  const sample = `a(withTenantDb(u, (tx) => tx.x.find({ y: f(1) })); after();`;
  const region = callRegion(sample, "withTenantDb");
  check("the region extractor returns the BALANCED span of the call it was asked for",
    region === "(u, (tx) => tx.x.find({ y: f(1) }))", region ?? "null");
  check("…strictly smaller than the source, so it cannot vacuously exclude everything",
    region !== null && region.length < sample.length);
  check("…and returns null (a failure, never an empty pass) for an absent call",
    callRegion(sample, "nowhereToBeFound") === null);
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\nTHE SET — a real denominator before any absence is claimed");
// ─────────────────────────────────────────────────────────────────────────────

const ROUTES = [
  "app/api/accounts/route.ts",
  "app/api/accounts/[id]/sync/route.ts",
  "app/api/accounts/[id]/transactions/route.ts",
  "app/api/accounts/[id]/debt-profile/route.ts",
] as const;

check("the slice covers EXACTLY four routes", ROUTES.length === 4, `${ROUTES.length}`);

const src = new Map<string, string>();
for (const rel of ROUTES) {
  const ok = existsSync(path.join(ROOT, rel));
  check(`${rel} exists`, ok);
  if (!ok) continue;
  const s = code(rel);
  src.set(rel, s);
  check(`${rel} is a real handler, not an empty or stub file`,
    s.length > 400 && /export\s+(async\s+function|const)\s+(GET|POST|PATCH|DELETE)/.test(s),
    `${s.length} chars`);
}
check("all four sources were read", src.size === 4, `${src.size}`);

// ─────────────────────────────────────────────────────────────────────────────
console.log("\nNO ROUTE IN THE SET REACHES THE MIGRATION PRINCIPAL");
// ─────────────────────────────────────────────────────────────────────────────
for (const [rel, s] of src) {
  check(`${rel}: binds a tenant identity`, s.includes("withTenantDb("));
  check(`${rel}: does not import the migration principal`,
    !/from\s+"@\/lib\/db"/.test(s));
  check(`${rel}: zero \`db.<model>.\` reaches`,
    migrationPrincipalReads(s).length === 0,
    migrationPrincipalReads(s).join(", "));
  check(`${rel}: the identity is the SESSION's user, not a path or cookie value`,
    /withTenantDb\(\s*user\.id/.test(s));
  check(`${rel}: resolves that user through the session guard`,
    /requireUser\(\)/.test(s));
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\nGET /api/accounts — the valuation shares the list's authority");
// ─────────────────────────────────────────────────────────────────────────────
{
  const s = src.get("app/api/accounts/route.ts")!;
  const region = callRegion(s, "withTenantDb");
  check("the phase exists", region !== null);
  check("the owner-scoped account read is INSIDE the phase",
    !!region && /tx\.financialAccount\.findMany/.test(region));
  check("the read is `ownerUserId = <the bound identity>` — the policy's owner arm",
    !!region && /ownerUserId:\s*user\.id/.test(region));
  check("the canonical wallet valuation runs inside the SAME phase",
    !!region && region.includes("applyCanonicalWalletBalances("));
  check("…on the TENANT client, never on a wider one it could have defaulted to",
    !!region && /applyCanonicalWalletBalances\(\s*accounts,\s*\{\s*client:\s*tx\s*\}/.test(region));
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\nPOST /api/accounts/[id]/sync — THE BOUNDARY DOES NOT SPAN THE PROVIDER");
// ─────────────────────────────────────────────────────────────────────────────
{
  const s = src.get("app/api/accounts/[id]/sync/route.ts")!;
  const region = callRegion(s, "withTenantDb");
  check("the phase exists", region !== null);
  check("the owner-only gate read is INSIDE it",
    !!region && /tx\.financialAccount\.findUnique/.test(region));
  // The load-bearing half. `withTenantDb` holds an interactive transaction open
  // for the whole callback; a block-explorer round trip inside one pins a pooled
  // connection across the network. The provider call and the post-sync
  // finaliser must stay OUTSIDE. P1 REFRESH ALL moved the four post-sync steps
  // (snapshot scope, snapshot regen, history window, history regen) into
  // lib/refresh/wallet-post-sync.ts `finalizeWalletSync`, shared with the
  // customer's Refresh All; the route calls that one name now. The guard
  // writes it gained (claim / clock / release) go through lib/refresh/deps.ts,
  // each its own short phase inside the builder — the gate stays this handler's
  // one literal phase.
  for (const outside of [
    "syncWalletByChain",
    "finalizeWalletSync",
  ]) {
    check(`${outside} is NOT inside the tenant transaction`,
      !!region && !region.includes(outside));
    check(`…and it is still called by the route (so the exclusion is not vacuous)`,
      s.includes(`${outside}(`));
  }
  check("exactly ONE tenant phase in this handler — the gate, and nothing else",
    (s.match(/withTenantDb\(/g) ?? []).length === 1);
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\nGET /api/accounts/[id]/transactions — THE GATE IS NOW A PRE-READ GUARANTEE");
// ─────────────────────────────────────────────────────────────────────────────
{
  const s = src.get("app/api/accounts/[id]/transactions/route.ts")!;
  const region = callRegion(s, "withTenantDb");
  check("the phase exists", region !== null);
  // This is the defect the slice closes: the gate used to sit OUTSIDE, on `db`.
  check("the SpaceAccountLink gate is INSIDE the tenant phase",
    !!region && /tx\.spaceAccountLink\.findFirst/.test(region));
  check("the row read is in the SAME phase as the gate that authorizes it",
    !!region && region.includes("queryTransactions(tx,"));
  check("the gate comes BEFORE the rows — a check performed after the read is not a check",
    !!region &&
      region.indexOf("spaceAccountLink.findFirst") >= 0 &&
      region.indexOf("spaceAccountLink.findFirst") < region.indexOf("queryTransactions("));
  check("the tier check stays application-side, where the owner decision put it",
    s.includes("grantsTransactionDetail("));
  check("the 404 and the 400 are decided from the phase's OUTCOME, not from a loose variable",
    /kind:\s*"notFound"/.test(s) && /kind:\s*"invalid"/.test(s) && /kind:\s*"redacted"/.test(s));
  check("a malformed query still cannot out-rank the 404 (the parse is after the gate)",
    !!region &&
      region.indexOf("spaceAccountLink.findFirst") < region.indexOf("parseTransactionQueryParams("));
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\nPATCH /api/accounts/[id]/debt-profile — GATE, UPSERT AND AUDIT IN ONE PHASE");
// ─────────────────────────────────────────────────────────────────────────────
{
  const s = src.get("app/api/accounts/[id]/debt-profile/route.ts")!;
  const region = callRegion(s, "withTenantDb");
  check("the phase exists", region !== null);
  check("the ownership gate is inside it", !!region && /tx\.financialAccount\.findUnique/.test(region));
  check("the DebtProfile upsert is inside it, on the tenant client",
    !!region && /tx\.debtProfile\.upsert/.test(region));
  check("the audit row is inside it too, so the write and its trail are atomic",
    !!region && /tx\.auditLog\.create/.test(region));
  check("the gate precedes the write",
    !!region &&
      region.indexOf("financialAccount.findUnique") < region.indexOf("debtProfile.upsert"));
  check("validation stays OUTSIDE the boundary — a 400 never opens a transaction",
    !!region && !region.includes("Invalid apr"),
    "the apr guard must not be inside the phase");
  check("…and the apr guard is genuinely present in the file (not a vacuous exclusion)",
    s.includes("Invalid apr"));
  // The asymmetry this route exposes. The header must keep saying so: the next
  // reader of a 500 from here needs to know a policy can refuse it.
  const header = readFileSync(path.join(ROOT, "app/api/accounts/[id]/debt-profile/route.ts"), "utf8");
  check("the header records that the subtree policy has NO ownerUserId arm",
    /fm_account_visible/.test(header) && /ownerUserId/.test(header));
  check("…and that the refused upsert is deliberately NOT swallowed",
    /RAISES/.test(header));
}

if (failures > 0) {
  console.error(`\nRLS-ACC-S1 account-spine authority: ${failures} failure(s).`);
  process.exit(1);
}
console.log("\nRLS-ACC-S1 account-spine authority: all passed.");
