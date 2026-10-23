/**
 * lib/account-privacy.test.ts
 *
 * REVIEW-3 B-1 — the privacy/population authority: aggregation happens AFTER
 * financial semantics, never before.
 *
 * The defect this locks out: `normalizeSharedAccounts` summed RAW SIGNED
 * balances into the synthetic BALANCE_ONLY aggregate row, UPSTREAM of
 * lib/debt/balance-semantics.ts — so two cards at +$500 and −$200 netted to a
 * $300 "owed" and an issuer credit discharged another account's debt. The
 * invariant test that forbids netting (balance-semantics.test.ts) sits
 * DOWNSTREAM of that sum and could not see it, which is why this guard asserts
 * at the aggregation site itself.
 *
 * Layers (house pattern: lib/debt/effective-terms.test.ts):
 *   A. Behavioral — the aggregate row preserves owed / credit / members /
 *      count separately; non-disclosing tiers fail closed into redactedCount.
 *   B. Current-state aggregation — per-member claims compose under the
 *      weakest-member rules.
 *   C. GUARD — source-scan of lib/account-privacy.ts: no raw signed balance
 *      is ever summed across accounts; debt members pass through amountOwed /
 *      creditBalance at the aggregation site; the site sits behind the
 *      fail-closed tier predicate and carries a runtime invariant.
 *
 * Standalone tsx:  npx tsx lib/account-privacy.test.ts
 * (self-shims `server-only`, same mechanism as scripts/lib/server-only-preload.cjs)
 */

import Module from "node:module";
import path from "node:path";
import { readFileSync } from "node:fs";

// ── server-only shim (must precede loading the module under test) ────────────
const NOOP_PATH = path.join(process.cwd(), "scripts", "lib", "server-only-noop.cjs");
type ResolveFn = (request: string, ...rest: unknown[]) => string;
const moduleInternals = Module as unknown as { _resolveFilename: ResolveFn };
const originalResolve = moduleInternals._resolveFilename;
moduleInternals._resolveFilename = function (this: unknown, request: string, ...rest: unknown[]): string {
  if (request === "server-only") return NOOP_PATH;
  return originalResolve.call(this, request, ...rest) as string;
};

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

async function main(): Promise<void> {
  const {
    normalizeSharedAccounts,
    aggregateCurrentCashState,
    grantsBalanceDisclosure,
  } = await import("./account-privacy");
  type ShareRow = import("./account-privacy").ShareRow;

  const T_OLD = new Date("2026-08-01T00:00:00.000Z");
  const T_NEW = new Date("2026-08-15T00:00:00.000Z");

  const share = (over: {
    id: string; balance: number; visibilityLevel?: string; type?: string;
    debtSubtype?: string | null; currency?: string; owner?: string;
    lastUpdated?: Date; balanceLastUpdatedAt?: Date | null;
  }): ShareRow => ({
    visibilityLevel: over.visibilityLevel ?? "BALANCE_ONLY",
    addedByUserId:   over.owner ?? "user_bob",
    addedByUser:     { firstName: "Bob", name: "Bob B" },
    financialAccount: {
      id:             over.id,
      name:           `Real name ${over.id}`,
      type:           over.type ?? "debt",
      institution:    "Chase",
      balance:        over.balance,
      currency:       over.currency ?? "USD",
      lastUpdated:    over.lastUpdated ?? T_NEW,
      balanceLastUpdatedAt: over.balanceLastUpdatedAt ?? null,
      creditLimit:    5000,
      debtSubtype:    over.debtSubtype === undefined ? "credit_card" : over.debtSubtype,
      interestRate:   19.99,
      minimumPayment: 35,
    },
  });

  // ── A. Behavioral — aggregation AFTER semantics ────────────────────────────
  console.log("A. Aggregation after semantics");
  {
    const { accounts, redactedCount } = normalizeSharedAccounts([
      share({ id: "fa_full", balance: 1000, visibilityLevel: "FULL" }),
      share({ id: "fa_b1", balance:  500 }),
      share({ id: "fa_b2", balance: -200 }),
    ]);
    check("no redactions in this set", redactedCount === 0);
    check("FULL row passes through individually", accounts.some((a) => a.id === "fa_full" && a.balance === 1000 && a.aggregate === undefined));
    const agg = accounts.find((a) => a.id.startsWith("balance-only:"));
    check("one aggregate row for the owner×label×currency group", agg !== undefined && accounts.length === 2);
    check("debt aggregate balance = Σ per-member amountOwed (500), NEVER the netted 300",
      agg?.balance === 500, String(agg?.balance));
    check("issuer credit preserved separately (creditTotal 200), never netted",
      agg?.aggregate?.creditTotal === 200, String(agg?.aggregate?.creditTotal));
    check("owedTotal mirrors the balance on a debt row", agg?.aggregate?.owedTotal === 500);
    check("member ids preserved for currentState resolution",
      JSON.stringify([...(agg?.aggregate?.memberAccountIds ?? [])].sort()) === JSON.stringify(["fa_b1", "fa_b2"]));
    check("member count disclosed (2 links, not 1 row)", agg?.aggregate?.memberCount === 2);
    check("clamp downstream is idempotent: amountOwed(balance) === balance",
      agg !== undefined && Math.max(agg.balance, 0) === agg.balance);
  }
  {
    // All-credit group: nothing owed, credit disclosed.
    const { accounts } = normalizeSharedAccounts([share({ id: "fa_c", balance: -124.04 })]);
    const agg = accounts[0];
    check("all-credit group owes 0 (never negative, never |x| phantom debt)", agg.balance === 0);
    check("all-credit group's credit disclosed (124.04)", agg.aggregate?.creditTotal === 124.04);
    check("single-member group still aggregates (synthetic id + memberCount 1)",
      agg.id.startsWith("balance-only:") && agg.aggregate?.memberCount === 1);
  }
  {
    // Non-debt members: the signed sum IS the per-member sum (no clamp applies).
    const { accounts } = normalizeSharedAccounts([
      share({ id: "fa_chk1", balance: 100, type: "checking", debtSubtype: null }),
      share({ id: "fa_chk2", balance: -50, type: "checking", debtSubtype: null }),
    ]);
    check("asset aggregate keeps the signed member sum (50)", accounts[0]?.balance === 50);
    check("asset aggregate has zero owed/credit semantics",
      accounts[0]?.aggregate?.owedTotal === 0 && accounts[0]?.aggregate?.creditTotal === 0);
  }
  {
    // Fail closed: SUMMARY_ONLY / PRIVATE / SHARED / unknown → no row, no sum.
    const { accounts, redactedCount } = normalizeSharedAccounts([
      share({ id: "fa_ok", balance: 500 }),
      share({ id: "fa_sum",  balance: 10_000, visibilityLevel: "SUMMARY_ONLY" }),
      share({ id: "fa_priv", balance: 20_000, visibilityLevel: "PRIVATE" }),
      share({ id: "fa_shd",  balance: 30_000, visibilityLevel: "SHARED" }),
      share({ id: "fa_new",  balance: 40_000, visibilityLevel: "SOME_FUTURE_TIER" }),
    ]);
    check("non-disclosing tiers produce NO rows", accounts.length === 1 && accounts[0].balance === 500);
    check("non-disclosing tiers are counted as redacted (4)", redactedCount === 4);
    const serialized = JSON.stringify(accounts);
    check("no withheld balance appears anywhere in the output",
      !serialized.includes("10000") && !serialized.includes("20000") &&
      !serialized.includes("30000") && !serialized.includes("40000"));
    check("no withheld member id appears anywhere in the output",
      !serialized.includes("fa_sum") && !serialized.includes("fa_priv"));
    check("predicate agrees: FULL/BALANCE_ONLY disclose, everything else fails closed",
      grantsBalanceDisclosure("FULL") && grantsBalanceDisclosure("BALANCE_ONLY") &&
      !grantsBalanceDisclosure("SUMMARY_ONLY") && !grantsBalanceDisclosure("PRIVATE") &&
      !grantsBalanceDisclosure("SHARED") && !grantsBalanceDisclosure("anything"));
  }
  {
    // v2.6-L1 rules preserved: OLDEST member freshness; attestation only if ALL attested.
    const { accounts } = normalizeSharedAccounts([
      share({ id: "fa_1", balance: 10, lastUpdated: T_NEW, balanceLastUpdatedAt: T_NEW }),
      share({ id: "fa_2", balance: 10, lastUpdated: T_OLD, balanceLastUpdatedAt: T_OLD }),
    ]);
    check("aggregate freshness is the OLDEST member's", accounts[0]?.lastUpdated === T_OLD.toISOString());
    check("all-attested group keeps the OLDEST attestation",
      accounts[0]?.balanceLastUpdatedAt === T_OLD.toISOString());
    const { accounts: mixed } = normalizeSharedAccounts([
      share({ id: "fa_1", balance: 10, balanceLastUpdatedAt: T_NEW }),
      share({ id: "fa_2", balance: 10, balanceLastUpdatedAt: null }),
    ]);
    check("one unattested member voids the aggregate attestation",
      mixed[0]?.balanceLastUpdatedAt === null);
  }
  {
    // Property: for any member signs, a debt aggregate NEVER nets. 20 random sets.
    let ok = true;
    for (let i = 0; i < 20 && ok; i++) {
      const n = 1 + (i % 4);
      const balances = Array.from({ length: n }, (_, j) => Math.round((Math.sin(i * 7 + j * 3) * 1000) * 100) / 100);
      const { accounts } = normalizeSharedAccounts(balances.map((b, j) => share({ id: `fa_${i}_${j}`, balance: b })));
      const agg = accounts[0];
      const owed = balances.reduce((s, b) => s + Math.max(b, 0), 0);
      const cred = balances.reduce((s, b) => s + Math.max(-b, 0), 0);
      if (Math.abs(agg.balance - owed) > 1e-9 || Math.abs((agg.aggregate?.creditTotal ?? NaN) - cred) > 1e-9) ok = false;
    }
    check("property: debt aggregate balance = Σ amountOwed and creditTotal = Σ creditBalance, for any signs", ok);
  }

  // ── B. Current-state aggregation (weakest-member rules) ────────────────────
  console.log("B. aggregateCurrentCashState");
  {
    const c = (over: Partial<import("./account-privacy").CurrentCashStateClaim>) => ({
      reachable: 0, unexplained: null, state: "EXACT", pendingCount: 0, ...over,
    });
    const sum = aggregateCurrentCashState([c({ reachable: 400 }), c({ reachable: 250, pendingCount: 2 })]);
    check("claims sum when every member resolved", sum?.reachable === 650 && sum?.pendingCount === 2);
    check("all-EXACT members → EXACT aggregate", sum?.state === "EXACT");
    check("no members → no claim", aggregateCurrentCashState([]) === undefined);
    check("any member WITHOUT a claim → no aggregate claim (never a partial sum)",
      aggregateCurrentCashState([c({}), undefined]) === undefined);
    const unknown = aggregateCurrentCashState([c({ reachable: 400 }), c({ reachable: null, state: "UNAVAILABLE" })]);
    check("any member UNKNOWN → aggregate reachable null (fail closed), never the known subset",
      unknown !== undefined && unknown.reachable === null);
    check("state merges pessimistically (UNAVAILABLE wins over EXACT)", unknown?.state === "UNAVAILABLE");
    const holds = aggregateCurrentCashState([c({ unexplained: 4000 }), c({ unexplained: -50 }), c({})]);
    check("unexplained sums POSITIVE holds only (a contradiction is never netted)",
      holds?.unexplained === 4000);
    const contra = aggregateCurrentCashState([c({ state: "CONTRADICTORY" }), c({ state: "PARTIALLY_ATTRIBUTED" })]);
    check("CONTRADICTORY dominates the merge", contra?.state === "CONTRADICTORY");
  }

  // ── C. GUARD — no pre-semantics raw-balance aggregation, at the site ───────
  console.log("C. Guard (source-scan of the aggregation site)");
  {
    const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const src = strip(readFileSync(path.join(process.cwd(), "lib/account-privacy.ts"), "utf8"));

    // The defect shape: accumulating a RAW signed `.balance` across accounts
    // (`existing.balance += a.balance` and any respelling of it). Owed/credit/
    // asset accumulators are interpreted quantities, not raw balances.
    const RAW_SUM = /\+=\s*[\w$.]*\.balance\b/;
    check("no raw signed `.balance` is ever summed across accounts", !RAW_SUM.test(src));
    check("no Math.abs over a balance (phantom debt) either", !/Math\.abs\([^)]*balance/i.test(src));
    check("debt members pass through amountOwed at the aggregation site", /amountOwed\(a\.balance\)/.test(src));
    check("issuer credit is captured via creditBalance at the aggregation site", /creditBalance\(a\.balance\)/.test(src));
    check("the site imports the balance-semantics authority",
      /import\s*\{[^}]*amountOwed[^}]*\}\s*from\s*"@\/lib\/debt\/balance-semantics"/.test(src));
    check("aggregation sits behind the fail-closed tier predicate",
      /if\s*\(!grantsBalanceDisclosure\(share\.visibilityLevel\)\)/.test(src));
    check("runtime invariant asserted at the site (not merely in a consumer)",
      src.includes("account-privacy invariant violated"));
    // The v2.6-L1 freshness rule must survive this rewrite (same regex the
    // freshness convergence guard pins).
    check("OLDEST-member freshness comparison intact",
      /if\s*\(\s*a\.lastUpdated\s*<\s*existing\.lastUpdated\s*\)/.test(src));
  }

  if (failures > 0) {
    console.error(`\naccount-privacy: ${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll account-privacy checks passed.");
}

main().catch((e) => {
  console.error("TEST CRASHED:", e instanceof Error ? e.stack ?? e.message : e);
  process.exit(1);
});
