/**
 * lib/debt/balance-semantics.test.ts
 *
 * V25-SIDE-1 — the canonical liability-balance authority, end to end
 * (house pattern: standalone tsx, DB-free):
 *
 *   npx tsx lib/debt/balance-semantics.test.ts
 *
 * §1  locks the three canonical states on the helper itself.
 * §2–8 prove the CONSUMERS honour them: debt lens, KPIs, payoff aggregate,
 *      net-worth classifier, credit utilization, liquidity headroom, and the
 *      AI payoff-targeting path. A helper that nobody consumes fixes nothing,
 *      so the invariants are asserted where users actually see them.
 * §9  is the AUTHORITY DRIFT GUARD — a source scan over the known debt-semantic
 *      surfaces (see its own header for what it bans and why).
 */

import {
  amountOwed, creditBalance, liabilityState, hasOutstandingDebt,
} from "./balance-semantics";
import { accountTier, classifyAccounts } from "@/lib/account-classifier";
import { creditUtilization } from "@/lib/accounts/credit-utilization";
import { computeDebt } from "@/lib/perspective-engine/lenses/debt.core";
import { computeLiquidity } from "@/lib/perspective-engine/lenses/liquidity.core";
import { computeDebtKpis, computePayoffAggregate } from "@/components/space/widgets/debt/debt-kpis";
import { computeDebtStrategy } from "@/lib/ai/intelligence/annotations/metrics";
import type { PerspectiveScope } from "@/lib/perspective-engine/types";
import type { DebtPerspectiveAccount } from "@/components/space/widgets/debt-perspective-adapters";
import { readFileSync } from "node:fs";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const approx = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) < eps;

// The three canonical fixtures used throughout, per the V25-SIDE-1 contract.
const OWED = 1000;
const SETTLED = 0;
const CREDIT = -100;

// ── 1. The authority itself ──────────────────────────────────────────────────
console.log("1. Canonical contract — owed / settled / credit");
{
  check("owed: amountOwed = balance", amountOwed(OWED) === 1000);
  check("owed: creditBalance = 0", creditBalance(OWED) === 0);
  check("owed: state = owed", liabilityState(OWED) === "owed");
  check("owed: hasOutstandingDebt", hasOutstandingDebt(OWED) === true);

  check("settled: amountOwed = 0", amountOwed(SETTLED) === 0);
  check("settled: creditBalance = 0", creditBalance(SETTLED) === 0);
  check("settled: state = settled", liabilityState(SETTLED) === "settled");
  check("settled: not outstanding", hasOutstandingDebt(SETTLED) === false);

  check("credit: amountOwed = 0 (NOT 100, NOT -100)", amountOwed(CREDIT) === 0);
  check("credit: creditBalance = 100 (positive magnitude)", creditBalance(CREDIT) === 100);
  check("credit: state = credit", liabilityState(CREDIT) === "credit");
  check("credit: not outstanding", hasOutstandingDebt(CREDIT) === false);

  // The two failure modes this module exists to prevent.
  check("credit is never phantom debt (≠ Math.abs)", amountOwed(CREDIT) !== Math.abs(CREDIT));
  check("credit is never negative debt", amountOwed(CREDIT) >= 0);
}

// ── 2. Debt lens ─────────────────────────────────────────────────────────────
console.log("2. Debt lens — no phantom debt, interest, or APR weight");
{
  const now = () => new Date("2026-07-22T00:00:00Z");
  const scope: PerspectiveScope = { spaceId: "s1", userId: "u1" };
  const row = (id: string, balance: number, interestRate?: number, minimumPayment?: number) => ({
    id, type: "debt", balance, currency: "USD",
    lastUpdated: "2026-07-21T00:00:00Z", visibilityLevel: "FULL",
    ...(interestRate != null ? { interestRate } : {}),
    ...(minimumPayment != null ? { minimumPayment } : {}),
  });

  const mixed = computeDebt(scope, { now }, [
    row("a", OWED, 20, 50),
    row("b", SETTLED, 30, 99),
    row("c", CREDIT, 24, 40),
  ]);
  const metric = (id: string) => mixed.metrics.find((m) => m.id === id)?.value as number | undefined;

  check("totalDebt = 1000 (credit + settled contribute 0)", metric("totalDebt") === 1000);
  check("interest = 1000×20%/12 only — no phantom accrual",
    approx(metric("monthlyInterest") ?? -1, 1000 * 0.20 / 12));
  check("blendedApr = 20 (owed-weighted; 30/24 carry no weight)", metric("blendedApr") === 20);
  check("minPayments = 50 — nothing due on settled/credit rows", metric("minPayments") === 50);
  check("all three accounts remain lens members",
    mixed.provenance.accountIds.length === 3, mixed.provenance.accountIds.join(","));
  // The verdict's account count describes what the TOTAL is spread across, so it
  // counts only accounts that owe — never "across 3 accounts" when 2 owe nothing.
  check("verdict count = 1 account (not 3)",
    /across 1 account\b/.test(mixed.verdict ?? ""), mixed.verdict);

  // A Space whose ONLY liability is in credit owes nothing — not +100, not −100.
  const creditOnly = computeDebt(scope, { now }, [row("c", CREDIT, 24)]);
  check("credit-only Space: totalDebt = 0",
    (creditOnly.metrics.find((m) => m.id === "totalDebt")?.value) === 0);
  check("credit-only Space: verdict says no outstanding debt",
    /No outstanding debt/i.test(creditOnly.verdict ?? ""), creditOnly.verdict);
  check("credit-only Space: no interest metric at all",
    creditOnly.metrics.every((m) => m.id !== "monthlyInterest"));
}

// ── 3. Debt KPIs ─────────────────────────────────────────────────────────────
console.log("3. Debt KPIs — membership structural, totals owed-only");
{
  let uid = 0;
  const debt = (over: Partial<DebtPerspectiveAccount>): DebtPerspectiveAccount => ({
    id: `d${uid++}`, name: "Card", type: "debt", institution: "Bank",
    balance: 0, currency: "USD", ...over,
  });

  const accounts = [
    debt({ balance: OWED, interestRate: 20, minimumPayment: 50, creditLimit: 2000 }),
    debt({ balance: SETTLED, interestRate: 30, minimumPayment: 99, creditLimit: 1000 }),
    debt({ balance: CREDIT, interestRate: 24, minimumPayment: 40, creditLimit: 1000 }),
  ];
  const k = computeDebtKpis(accounts);

  check("totalDebt = 1000", k.totalDebt === 1000);
  check("estMonthlyInterest from owed principal only",
    approx(k.estMonthlyInterest, 1000 * 0.20 / 12));
  check("utilization = 1000/4000 = 25% — limits of paid-off cards still count",
    approx(k.utilizationPct ?? -1, 25));
  check("utilization is never negative", (k.utilizationPct ?? 0) >= 0);
  check("minPayments = 50 (settled/credit owe nothing)", k.minPayments === 50);
  check("missingMinCount ignores rows that owe nothing", k.missingMinCount === 0);

  // Utilization must not go negative even when every card is in credit.
  const allCredit = computeDebtKpis([debt({ balance: CREDIT, creditLimit: 1000 })]);
  check("all-credit: totalDebt = 0", allCredit.totalDebt === 0);
  check("all-credit: utilization = 0%, not negative", allCredit.utilizationPct === 0);
  check("all-credit: minPayments = 0", allCredit.minPayments === 0);
}

// ── 4. Payoff aggregate — NO cross-account netting ───────────────────────────
console.log("4. Payoff aggregate — issuer credit never discharges other debt");
{
  let uid = 0;
  const debt = (over: Partial<DebtPerspectiveAccount>): DebtPerspectiveAccount => ({
    id: `p${uid++}`, name: "Card", type: "debt", institution: "Bank",
    balance: 0, currency: "USD", ...over,
  });

  const withCredit = computePayoffAggregate([
    debt({ balance: OWED, interestRate: 20, minimumPayment: 50 }),
    debt({ balance: CREDIT, interestRate: 24, minimumPayment: 40 }),
  ]);
  const owedOnly = computePayoffAggregate([
    debt({ balance: OWED, interestRate: 20, minimumPayment: 50 }),
  ]);

  check("total = 1000, NOT 900 — no netting", withCredit.total === 1000);
  check("a credit balance changes nothing about the payoff",
    withCredit.total === owedOnly.total && withCredit.minPayment === owedOnly.minPayment);
  check("monthlyRate weighted by owed only (20% APR)",
    approx(withCredit.monthlyRate, 0.20 / 12));
  check("minPayment excludes the credit row's stale minimum", withCredit.minPayment === 50);
}

// ── 5. Net worth ─────────────────────────────────────────────────────────────
console.log("5. Net worth — credit is not a liability and not an asset");
{
  const c = classifyAccounts([
    { type: "checking", balance: 5000 },
    { type: "debt", balance: OWED },
    { type: "debt", balance: SETTLED },
    { type: "debt", balance: CREDIT },
  ]);
  check("totalLiabilities = 1000 (credit floors at 0)", c.totalLiabilities === 1000);
  check("totalLiabilities is never negative", c.totalLiabilities >= 0);
  check("totalAssets unchanged — credit is NOT reclassified as an asset", c.totalAssets === 5000);
  check("netWorth = 5000 − 1000 = 4000, NOT 4100", c.netWorth === 4000);
  check("all three liabilities remain classified members", c.liabilities.length === 3);
}

// ── 6. Credit utilization ────────────────────────────────────────────────────
console.log("6. Credit utilization — never negative");
{
  const { rows } = creditUtilization([
    { id: "a", name: "Owed", type: "debt", balance: OWED, creditLimit: 2000 },
    { id: "c", name: "Credit", type: "debt", balance: CREDIT, creditLimit: 1000 },
  ]);
  const byId = new Map(rows.map((r) => [r.id, r]));
  check("owed card = 50%", approx(byId.get("a")!.pct, 50));
  check("credit card = 0%, not −10%", byId.get("c")!.pct === 0);
  check("every utilization ≥ 0", rows.every((r) => r.pct >= 0));
}

// ── 7. Liquidity headroom ────────────────────────────────────────────────────
console.log("7. Liquidity — headroom correct, credit is not liquid");
{
  const now = () => new Date("2026-07-22T00:00:00Z");
  const scope: PerspectiveScope = { spaceId: "s1", userId: "u1" };
  const base = {
    type: "debt", currency: "USD", lastUpdated: "2026-07-21T00:00:00Z",
    visibilityLevel: "FULL", creditLimit: 1000,
  };
  const val = (r: ReturnType<typeof computeLiquidity>, id: string) =>
    r.metrics.find((m) => m.id === id)?.value as number | undefined;
  // NOTE the headroom metric is `availableCredit`; `cashNow` is the headline.

  const credit = computeLiquidity(scope, { now }, [{ ...base, id: "c", balance: CREDIT }]);
  check("credit balance does NOT eat headroom (1000, not 900)", val(credit, "availableCredit") === 1000);
  check("issuer credit is not cash", val(credit, "cashNow") === 0);
  check("issuer credit is not marketable", val(credit, "marketable") === 0);
  check("issuer credit is not an illiquid asset", val(credit, "illiquid") === 0);

  const owed = computeLiquidity(scope, { now }, [{ ...base, id: "o", balance: 400 }]);
  check("owed still consumes headroom (1000 − 400 = 600)", val(owed, "availableCredit") === 600);
}

// ── 8. AI payoff targeting ───────────────────────────────────────────────────
console.log("8. AI — a credit-balance card can NEVER be a payoff target");
{
  const acct = (id: string, name: string, balance: number, apr: number | null) => ({
    id, name, type: "debt", institution: "Bank", balance, currency: "USD",
    reportingBalance: balance, lastUpdated: "2026-07-21T00:00:00Z",
    needsReauth: false, visibilityLevel: "FULL" as const,
    apr, amountOwed: amountOwed(balance), creditBalance: creditBalance(balance),
    liabilityState: liabilityState(balance),
  });

  // computeDebtStrategy(accts, debt) — `debt.totalLiabilities` is only the
  // "is there any debt at all" gate; it comes from classifyAccounts, which
  // already floors at zero, so a credit balance never opens or closes it falsely.
  const strategy = (accounts: ReturnType<typeof acct>[], totalLiabilities: number) =>
    computeDebtStrategy(
      { accounts } as unknown as Parameters<typeof computeDebtStrategy>[0],
      { totalLiabilities } as unknown as Parameters<typeof computeDebtStrategy>[1],
    );

  // The credit card is the smallest by |balance| AND carries the highest APR —
  // under the old Math.abs ordering it won BOTH strategies.
  const s = strategy([
    acct("big", "Big Card", 5000, 18),
    acct("cred", "Overpaid Card", CREDIT, 29.99),
  ], 5000);
  check("snowball target is NOT the credit card",
    s.snowballCandidate?.accountName === "Big Card", String(s.snowballCandidate?.accountName));
  check("avalanche target is NOT the credit card (despite the highest APR)",
    s.avalancheCandidate?.accountName === "Big Card", String(s.avalancheCandidate?.accountName));
  check("no candidate balance is ever negative",
    (s.snowballCandidate?.balance ?? 0) >= 0 && (s.avalancheCandidate?.balance ?? 0) >= 0);
  check("weightedAvgApr excludes the credit card (18, not blended with 29.99)",
    s.weightedAvgApr === 18, String(s.weightedAvgApr));

  // With NOTHING owed there is simply no target — not a credit-balance one.
  // totalLiabilities is 0 here precisely BECAUSE the classifier floors the
  // credit at zero, which is the same authority under test.
  const creditOnly = strategy([acct("cred", "Overpaid Card", CREDIT, 29.99)], 0);
  check("credit-only Space yields NO snowball target", creditOnly.snowballCandidate === null);
  check("credit-only Space yields NO avalanche target", creditOnly.avalancheCandidate === null);

  // And even if the gate is open (other debt exists), a lone credit row that
  // reaches the ranking is still never chosen.
  const gateOpen = strategy([acct("cred", "Overpaid Card", CREDIT, 29.99)], 5000);
  check("credit row is not a target even with the gate open",
    gateOpen.snowballCandidate === null && gateOpen.avalancheCandidate === null);
  check("no phantom interest burden from a credit balance",
    (gateOpen.knownMonthlyInterestBurden ?? 0) === 0,
    String(gateOpen.knownMonthlyInterestBurden));
}

// ── 9. Authority drift guard ─────────────────────────────────────────────────
//
// The root cause of V25-SIDE-1 was not one bad line — it was EIGHT consumers
// each privately re-deriving what a signed liability balance means, four
// mutually contradictory ways. A unit test on the helper cannot catch a NINTH
// consumer inventing a tenth rule, so this scans the known debt-semantic
// surfaces for the specific re-derivation patterns that caused the defect.
//
// Deliberately NOT a global ban on Math.abs / Math.max: both are legitimate
// almost everywhere (ordering magnitudes, bar clamps, FX deltas). The scan is
// narrow — a fixed file list, and only balance-shaped operands.
console.log("9. Authority drift guard — debt semantics stay in one place");
{
  // Files that interpret liability balances and must delegate to the authority.
  const GUARDED = [
    "lib/account-classifier.ts",
    "lib/accounts/credit-utilization.ts",
    "lib/perspective-engine/lenses/debt.core.ts",
    "lib/perspective-engine/lenses/liquidity.core.ts",
    "lib/ai/intelligence/annotations/metrics.ts",
    "lib/ai/intelligence/annotations/engine.ts",
    "components/space/widgets/debt/debt-kpis.ts",
    "components/space/widgets/debt/debt-ledger-util.ts",
    "components/space/widgets/debt/LiabilitiesLedger.tsx",
    "components/space/widgets/debt-perspective-adapters.tsx",
    "components/space/widgets/debt-adapters.tsx",
    "components/space/widgets/accounts/AccountsLedger.tsx",
    "components/space/sections/SectionRegistry.tsx",
    "components/space/sections/SectionCard.tsx",
    "components/space/sections/DebtPayoffSection.tsx",
    "components/dashboard/DebtClient.tsx",
    "lib/data/accounts.ts",
  ];

  const EXPLANATION =
    "Debt/liability balance semantics are owned by the canonical liability-balance " +
    "helper (lib/debt/balance-semantics.ts). Consumers must not reinterpret raw " +
    "signed liability balances independently — call amountOwed / creditBalance / " +
    "liabilityState / hasOutstandingDebt instead.";

  /** Strip comments so PROSE describing the old behaviour never trips the scan
   *  (these files document exactly the patterns being banned). */
  function stripComments(src: string): string {
    return src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
  }

  // A balance-shaped operand: `balance`, `bal`, `reportingBalance`, `x.a.balance`…
  // The member path is OPTIONAL — a bare `Math.abs(bal)` must match too (an
  // earlier form of this pattern required a prefix and missed exactly that).
  const BAL = String.raw`(?:[A-Za-z_$][\w$]*\.)*\w*(?:balance|Balance|bal)\b`;
  // The operand may be wrapped in ONE conversion call — the debt lens's original
  // `Math.abs(inTarget(r.balance, …))` was the single worst offender in the
  // codebase and an unwrapped-only pattern walked straight past it.
  const W = String.raw`(?:[\w$.]+\(\s*)?`;
  const BANNED: { re: RegExp; why: string }[] = [
    { re: new RegExp(String.raw`Math\.abs\(\s*${W}${BAL}`),          why: "Math.abs(<balance>) — turns issuer credit into phantom debt" },
    { re: new RegExp(String.raw`Math\.max\(\s*0\s*,\s*${W}${BAL}`),  why: "Math.max(0, <balance>) — a private copy of amountOwed()" },
    { re: new RegExp(String.raw`Math\.max\(\s*${W}${BAL}\s*,\s*0`),  why: "Math.max(<balance>, 0) — a private copy of amountOwed()" },
    { re: new RegExp(String.raw`Math\.max\(\s*-\s*${W}${BAL}`),      why: "Math.max(-<balance>, …) — a private copy of creditBalance()" },
  ];

  let violations = 0;
  for (const file of GUARDED) {
    const lines = stripComments(readFileSync(file, "utf8")).split("\n");
    lines.forEach((line, i) => {
      for (const { re, why } of BANNED) {
        if (re.test(line)) {
          violations++;
          console.error(`  ✗ ${file}:${i + 1} — ${why}\n      ${line.trim()}`);
        }
      }
    });
  }
  check(`no local re-derivation across ${GUARDED.length} guarded files`,
    violations === 0, violations > 0 ? EXPLANATION : undefined);

  // The guard must be able to FAIL — a scan that matches nothing is not a scan.
  // (Mutation check: synthetic sources exercising each banned pattern.)
  const FIXTURES = [
    "const owed = Math.abs(a.balance);",
    "const owed = Math.max(0, a.balance);",
    "const owed = Math.max(account.balance, 0);",
    "const credit = Math.max(-r.reportingBalance, 0);",
    "const x = Math.abs(bal);",
    // The exact pre-V25-SIDE-1 debt-lens line, wrapped in a conversion call.
    "const totalDebt = countable.reduce((s, r) => s + Math.abs(inTarget(r.balance, r.currency)), 0);",
    "credit += inTarget(Math.max(r.creditLimit - Math.abs(r.balance), 0), r.currency);",
  ];
  const detected = FIXTURES.filter((f) => BANNED.some(({ re }) => re.test(f)));
  check("detector catches every synthetic violation",
    detected.length === FIXTURES.length,
    `missed: ${FIXTURES.filter((f) => !detected.includes(f)).join(" | ")}`);

  // …and must not fire on legitimate uses that are NOT balance semantics.
  const BENIGN = [
    "const magnitude = Math.abs(d.amount);",
    "barPct: Math.min(100, Math.max(0, pct)),",
    "const mismatch = Math.abs(balanceDelta - expected);",
    "const owed = amountOwed(a.balance);",
  ];
  check("detector does not fire on legitimate non-semantic uses",
    BENIGN.every((f) => !BANNED.some(({ re }) => re.test(f))),
    BENIGN.filter((f) => BANNED.some(({ re }) => re.test(f))).join(" | "));
}

// ── 10. Cash-flow firewall ───────────────────────────────────────────────────
//
// Balance semantics and TRANSACTION semantics are separate authorities. This
// slice must not have moved that line: account tiering keys on structural type,
// and flow classification is transaction-side. Asserted here rather than assumed.
console.log("10. Cash-flow firewall — transaction semantics untouched");
{
  const src = readFileSync("lib/account-classifier.ts", "utf8");
  const tierBody = src.slice(src.indexOf("export function accountTier"),
                             src.indexOf("export const DIGITAL_ASSET_ACCOUNT_TYPES"));
  check("accountTier() never reads a balance", !/balance/.test(tierBody));
  check("accountTier() keys on structural type only",
    /switch\s*\(\s*type\s*\)/.test(tierBody));

  check("debt tier is 'liability' when owed", accountTier("debt") === "liability");
  check("tier is balance-independent by construction",
    accountTier("debt") === "liability" && accountTier("checking") === "liquid");

  // No flow/transaction authority may import the balance helper.
  const FLOW_AUTHORITIES = [
    "lib/transactions/flow-classifier.ts",
    "lib/transactions/flow-predicates.ts",
    "lib/transactions/liquidity.ts",
  ];
  const leaked = FLOW_AUTHORITIES.filter((f) =>
    readFileSync(f, "utf8").includes("balance-semantics"));
  check("no flow authority imports balance semantics", leaked.length === 0, leaked.join(", "));
}

// ── 11. AI wiring ────────────────────────────────────────────────────────────
//
// §8 proves the RANKING is safe. This proves the CONTEXT is explicit: the
// assembler must emit the derived fields on every debt row (both visibility
// branches), and the serializer must warn when a credit balance is present.
// Both are DB-bound, so they are asserted structurally on source.
console.log("11. AI wiring — semantics reach the model, not just the math");
{
  const asm = readFileSync("lib/ai/assemblers/accounts.ts", "utf8");
  check("assembler derives liability semantics from the canonical helper",
    /amountOwed:\s*amountOwed\(fa\.balance\)/.test(asm) &&
    /creditBalance:\s*creditBalance\(fa\.balance\)/.test(asm) &&
    /liabilityState:\s*liabilityState\(fa\.balance\)/.test(asm));
  check("both visibility branches spread the semantics (FULL + BALANCE_ONLY)",
    (asm.match(/\.\.\.liability/g) ?? []).length === 2);

  const ser = readFileSync("lib/ai/prompts/context-serializer.ts", "utf8");
  check("serializer gates its warning on an actual credit-balance account",
    /liabilityState\s*===\s*'credit'/.test(ser));
  check("serializer tells the model a credit balance is ZERO debt",
    /A credit balance is ZERO debt/.test(ser));
  check("serializer forbids recommending payoff of a credit balance",
    /never recommend paying it off/.test(ser));
}

// ── 12. Liabilities section stays structurally gated ─────────────────────────
//
// The final V25-SIDE-1 defect: the Liabilities Block sat INSIDE DebtWorkspace's
// `hasDebt` gate (`kpis.totalDebt > 0`), so settling every card removed the
// entire account browser. Re-gating it on any debt AMOUNT would silently
// reintroduce that, and the render test cannot see the workspace's JSX — so the
// gate is pinned here on source.
console.log("12. Liabilities Block is gated on ACCOUNTS, not on debt");
{
  const ws = readFileSync("components/space/widgets/debt/DebtWorkspace.tsx", "utf8");
  const idx = ws.indexOf('id="debt-liabilities"');
  check("the Liabilities Block exists", idx > 0);

  // The gate immediately preceding the Block must be the structural count.
  const before = ws.slice(Math.max(0, idx - 900), idx);
  check("gated on liabilityCount (structural), not totalDebt/hasDebt",
    /\{liabilityCount > 0 && \(/.test(before) && !/\{hasDebt && \(\s*<>?\s*$/.test(before));
  check("liabilityCount derives from the structural accountCount",
    /const liabilityCount = kpis\.accountCount;/.test(ws));
  check("hasDebt still gates the debt-MAGNITUDE blocks (cost/payoff)",
    ws.indexOf("{hasDebt && (") > 0 &&
    ws.indexOf('id="debt-costrisk"') > ws.indexOf("{hasDebt && ("));
  check("the Liabilities Block precedes the hasDebt gate",
    idx < ws.indexOf("{hasDebt && ("), `${idx} vs ${ws.indexOf("{hasDebt && (")}`);
}

console.log(failures === 0
  ? "\n✅ balance-semantics: all checks passed"
  : `\n❌ balance-semantics: ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
