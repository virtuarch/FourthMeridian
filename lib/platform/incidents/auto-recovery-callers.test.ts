/**
 * lib/platform/incidents/auto-recovery-callers.test.ts  (P8 #1 — S2 pin)
 *
 * resolveByAutomaticRecovery SYNTHESISES its proof: the stage fact it stores
 * as resolutionEvidence (SUCCEEDED, completedAt = now) is built by the
 * resolver, not read from the ledger. It is only true because of WHO calls it.
 * This source scan pins those callers and the success condition at each site:
 *
 *   1. the ONLY production caller of resolveByAutomaticRecovery is
 *      lib/plaid/syncIssues.ts, once inside resolveCursorBlockingIssues
 *      (domain "transactions") and once inside resolveBalanceUnobservedIssue
 *      (domain "balances");
 *   2. resolveCursorBlockingIssues is reached only after a COMPLETED
 *      transactions sync: syncTransactionsForItem, after the success health
 *      flip (directly, or through the ledger door's resolveIncidentsByRecovery,
 *      whose one caller is that same site);
 *   3. resolveBalanceUnobservedIssue is reached only on an OBSERVED balance
 *      write: refreshBalancesForItem (after the update, under `plan.observed`)
 *      and re-exchange (under `balanceStamp.balanceObserved`);
 *   4. the proof's executionId is the looked-up correlator, never filled in.
 *
 * A new caller fails here, on purpose: it must be reviewed for the same
 * success condition, or it fabricates proof.
 *
 * Run:  npx tsx lib/platform/incidents/auto-recovery-callers.test.ts
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const ROOT = process.cwd();
const code = (f: string) => readFileSync(path.join(ROOT, f), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
function walk(dir: string, out: string[] = []): string[] {
  let names: string[] = [];
  try { names = readdirSync(path.join(ROOT, dir)); } catch { return out; }
  for (const n of names) {
    const rel = path.join(dir, n);
    if (statSync(path.join(ROOT, rel)).isDirectory()) { if (n !== "node_modules") walk(rel, out); }
    else if (/\.tsx?$/.test(n) && !/\.test\.tsx?$/.test(n)) out.push(rel);
  }
  return out;
}
const PROD = ["lib", "app", "components", "jobs"].flatMap((d) => walk(d));
const callers = (re: RegExp) => PROD.filter((f) => re.test(code(f))).sort();
const count = (s: string, re: RegExp) => (s.match(new RegExp(re.source, "g")) ?? []).length;
/** The body of `export async function name(` up to the next top-level declaration. */
function body(src: string, name: string): string {
  const i = src.indexOf(`export async function ${name}(`);
  if (i < 0) return "";
  const rest = src.slice(i + 1);
  const j = rest.search(/\n(export |async function |function |const [A-Za-z_]+ = )/);
  return j < 0 ? rest : rest.slice(0, j);
}

console.log("1. resolveByAutomaticRecovery has exactly two callers: the two facades");
{
  const lc = "lib/platform/incidents/lifecycle.ts";
  const found = callers(/\bresolveByAutomaticRecovery\(/).filter((f) => f !== lc);
  check("the only production caller file is lib/plaid/syncIssues.ts", found.join() === "lib/plaid/syncIssues.ts", found.join(", "));
  const si = code("lib/plaid/syncIssues.ts");
  check("…with exactly two calls", count(si, /\bresolveByAutomaticRecovery\(/) === 2);
  const tx = body(si, "resolveCursorBlockingIssues");
  const bal = body(si, "resolveBalanceUnobservedIssue");
  check("one is resolveCursorBlockingIssues, scoped to domain \"transactions\"",
    count(tx, /\bresolveByAutomaticRecovery\(/) === 1 && /domain:\s*"transactions"/.test(tx) && !/domain:\s*"balances"/.test(tx));
  check("one is resolveBalanceUnobservedIssue, scoped to domain \"balances\"",
    count(bal, /\bresolveByAutomaticRecovery\(/) === 1 && /domain:\s*"balances"/.test(bal) && !/domain:\s*"transactions"/.test(bal));
}

console.log("2. resolveCursorBlockingIssues is reached only after a completed transactions sync");
{
  const found = callers(/\bresolveCursorBlockingIssues\(/).filter((f) => f !== "lib/plaid/syncIssues.ts");
  check("callers are exactly refresh-ledger.ts (the door) and syncTransactions.ts",
    found.join() === "lib/plaid/refresh-ledger.ts,lib/plaid/syncTransactions.ts", found.join(", "));
  const st = code("lib/plaid/syncTransactions.ts");
  check("syncTransactions.ts calls it once", count(st, /\bresolveCursorBlockingIssues\(/) === 1);
  const site = st.indexOf("resolveCursorBlockingIssues(plaidItemDbId");
  const flip = st.lastIndexOf("setPlaidItemHealth(", site);
  check("…AFTER the success health flip (ACTIVE, errorCode cleared, cursor advanced)",
    site > 0 && flip > 0 && /status:\s*PlaidItemStatus\.ACTIVE,\s*errorCode:\s*null/.test(st.slice(flip, site))
    && /cursor:\s*cursor/.test(st.slice(flip, site)));
  check("…on the same line as the door path (ledger ? door : facade) — one success site",
    /if \(ledger\) await ledger\.resolveIncidentsByRecovery\(\{ plaidItemId: plaidItemDbId \}\);\s*else await resolveCursorBlockingIssues\(plaidItemDbId, incidents, runId\);/.test(st));
  const door = callers(/\.resolveIncidentsByRecovery\(/);
  check("the ledger door's resolveIncidentsByRecovery has that ONE caller", door.join() === "lib/plaid/syncTransactions.ts" && count(st, /\.resolveIncidentsByRecovery\(/) === 1, door.join(", "));
  const rl = code("lib/plaid/refresh-ledger.ts");
  check("refresh-ledger.ts calls the facade only from defaultResolveCursorBlockingIssues",
    count(rl, /\bresolveCursorBlockingIssues\(/) === 1 && /async function defaultResolveCursorBlockingIssues\([\s\S]*?resolveCursorBlockingIssues\(/.test(rl));
}

console.log("3. resolveBalanceUnobservedIssue is reached only on an observed balance write");
{
  const found = callers(/\bresolveBalanceUnobservedIssue\(/).filter((f) => f !== "lib/plaid/syncIssues.ts");
  check("callers are exactly exchange-balance-observation.ts and refresh.ts",
    found.join() === "lib/plaid/exchange-balance-observation.ts,lib/plaid/refresh.ts", found.join(", "));
  const rf = code("lib/plaid/refresh.ts");
  check("refresh.ts: one call, guarded by `plan.observed && fa.balanceObserved === false`, after the balance update",
    count(rf, /\bresolveBalanceUnobservedIssue\(/) === 1
    && /financialAccount\.update\(\{[\s\S]{0,400}?\}\);[\s\S]{0,400}?if \(plan\.observed && fa\.balanceObserved === false\) \{\s*await resolveBalanceUnobservedIssue\(fa\.id\);/.test(rf));
  const ex = code("lib/plaid/exchange-balance-observation.ts");
  check("exchange-balance-observation.ts: its one call is inside resolveExchangeBalanceObserved",
    count(ex, /\bresolveBalanceUnobservedIssue\(/) === 1 && /export async function resolveExchangeBalanceObserved\([^)]*\)[^{]*\{\s*await resolveBalanceUnobservedIssue\(/.test(ex));
  const exCallers = callers(/\bresolveExchangeBalanceObserved\(/).filter((f) => f !== "lib/plaid/exchange-balance-observation.ts");
  check("resolveExchangeBalanceObserved has one caller, exchangeToken.ts", exCallers.join() === "lib/plaid/exchangeToken.ts", exCallers.join(", "));
  const et = code("lib/plaid/exchangeToken.ts");
  check("…guarded by `wroteExistingRow && balanceStamp.balanceObserved`",
    count(et, /\bresolveExchangeBalanceObserved\(/) === 1
    && /else if \(wroteExistingRow && balanceStamp\.balanceObserved\) \{\s*await resolveExchangeBalanceObserved\(fa\.id\);/.test(et));
}

console.log("4. the synthesised proof never fills in a missing execution");
{
  const lc = code("lib/platform/incidents/lifecycle.ts");
  const resolver = body(lc, "resolveByAutomaticRecovery");
  check("resolvingExecutionId comes only from the correlator lookup",
    /const resolvingExecutionId = await resolveExecutionId\(scope\.runId,/.test(resolver)
    && count(resolver, /\bresolvingExecutionId\s*=/) === 1);
  check("both proof facts carry `executionId: resolvingExecutionId` verbatim (no fallback)",
    count(resolver, /executionId: resolvingExecutionId,/) === 2 && !/executionId: resolvingExecutionId\s*(\?\?|\|\|)/.test(resolver));
  check("both proof facts are SUCCEEDED and nothing else", count(resolver, /status: "SUCCEEDED"/) === 2 && !/status: "(FAILED|SKIPPED|NOT_ATTEMPTED|PROVIDER_LIMITED)"/.test(resolver));
}

if (failures > 0) {
  console.error(`\nauto-recovery-callers.test: ${failures} failure(s).`);
  process.exit(1);
}
console.log("\nauto-recovery-callers.test: all passed.");
