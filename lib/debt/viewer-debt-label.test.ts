/**
 * lib/debt/viewer-debt-label.test.ts
 *
 * S2 PRIVACY ruling P1 (2026-11-08) — a debt TYPE label never discloses more
 * than the viewer's visibility allows. For any account the viewer neither owns
 * nor holds at FULL visibility, every type label in UI and AI payloads is the
 * coarse kind only: installment → "loan", revolving → "credit line",
 * unknown → "debt". Classification and arithmetic are unchanged.
 *
 *   1. The helper (debtLabelAccess / viewerDebtLabel / viewerDebtType / viewerRateLabel).
 *   2. A balance-only co-member Space holding a mortgage: liquid NW note,
 *      partial-total statement, AI excluded groups + liquid-NW kinds, account
 *      names, ledger label — all coarse, and NO "mortgage"/"HELOC" string in any
 *      of those payloads (scan). Math identical to the FULL view.
 *   3. Owner and FULL co-member see "mortgage".
 *   4. Source scan: the fine label (debtTypeLabel / DEBT_TYPE_LABEL[...]) is
 *      reached only through the helper (allowlist).
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import {
  COARSE_DEBT_LABEL, debtLabelAccess, kindOfDebtType, liabilityKind, debtType,
  viewerDebtLabel, viewerDebtType, type LiabilityKindInput,
} from "@/lib/debt/liability-kind";
import { viewerRateLabel, viewerRateLabelInline } from "@/lib/debt/rate-label";
import {
  liquidNetWorthBasis, liquidNetWorthNoteText, aiLiquidNetWorth, LIQUID_NET_WORTH_DEFINITION,
} from "@/lib/debt/liquid-net-worth";
import {
  aiExcludedAccountGroups, detectExcludedAccounts, excludedFromAiAccounts, partialTotalStatement,
  countsOfExcluded,
} from "@/lib/balances/unobserved-totals";
import { presentationDebtLabel } from "@/components/space/widgets/debt/debt-ledger-util";
import type { DebtPerspectiveAccount } from "@/components/space/widgets/debt-perspective-adapters";

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`); }
}

const FINE_WORDS = /mortgage|heloc|home equity|auto loan|student loan/i;

console.log("1. The helper");
{
  check("FULL ⇒ FINE", debtLabelAccess({ visibilityLevel: "FULL" }) === "FINE");
  check("owner ⇒ FINE (even at BALANCE_ONLY)", debtLabelAccess({ visibilityLevel: "BALANCE_ONLY", viewerIsOwner: true }) === "FINE");
  check("BALANCE_ONLY ⇒ COARSE", debtLabelAccess({ visibilityLevel: "BALANCE_ONLY" }) === "COARSE");
  check("SUMMARY_ONLY ⇒ COARSE", debtLabelAccess({ visibilityLevel: "SUMMARY_ONLY" }) === "COARSE");
  check("no tier stated ⇒ COARSE (fail closed)", debtLabelAccess({}) === "COARSE" && debtLabelAccess(null) === "COARSE");

  const cases: Array<[LiabilityKindInput, string, string]> = [
    [{ type: "debt", debtSubtype: "mortgage" },                            "Mortgage",       "Loan"],
    [{ type: "debt", providerSubtype: "mortgage" },                        "Mortgage",       "Loan"],
    [{ type: "debt", debtSubtype: "heloc" },                               "HELOC",          "Credit line"],
    [{ type: "debt", providerSubtype: "home equity", creditLimit: 50_000 }, "HELOC",         "Credit line"],
    [{ type: "debt", providerSubtype: "home equity" },                     "Installment loan", "Loan"],
    [{ type: "debt", debtSubtype: "auto_loan" },                           "Auto loan",      "Loan"],
    [{ type: "debt", debtSubtype: "credit_card" },                         "Credit card",    "Credit line"],
    [{ type: "debt" },                                                     "Debt",           "Debt"],
  ];
  for (const [a, fine, coarse] of cases) {
    check(`${JSON.stringify(a)} ⇒ FINE "${fine}" / COARSE "${coarse}"`,
      viewerDebtLabel(a, "FINE") === fine && viewerDebtLabel(a, "COARSE") === coarse,
      [viewerDebtLabel(a, "FINE"), viewerDebtLabel(a, "COARSE")]);
    check(`  viewerDebtType keeps the KIND at COARSE (${JSON.stringify(a)})`,
      kindOfDebtType(viewerDebtType(a, "COARSE")) === liabilityKind(a) && viewerDebtType(a, "FINE") === debtType(a));
  }
  check("COARSE vocabulary is S2's", COARSE_DEBT_LABEL.installment === "Loan" && COARSE_DEBT_LABEL.revolving === "Credit line" && COARSE_DEBT_LABEL.unknown === "Debt");
  const m = { type: "debt", debtSubtype: "mortgage" };
  check("rate label: FULL mortgage ⇒ 'Mortgage rate'; COARSE ⇒ 'Interest rate'",
    viewerRateLabel(m, "FINE") === "Mortgage rate" && viewerRateLabel(m, "COARSE") === "Interest rate"
    && viewerRateLabelInline(m, "COARSE") === "interest rate");
  check("rate label: COARSE card keeps 'APR' (kind-level)", viewerRateLabel({ type: "debt", debtSubtype: "credit_card" }, "COARSE") === "APR");
}

// ── A Space: the viewer's own checking (FULL) + a co-member's mortgage shared
// BALANCE_ONLY (balance never observed ⇒ excluded ⇒ partial statements) + a
// co-member's HELOC shared BALANCE_ONLY. The rows carry the raw subtypes for
// MATH (lib/data/accounts.ts / AI classifiableAll forward them), exactly as the
// product does.
type Row = {
  id: string; type: string; balance: number; currency: string; debtSubtype?: string | null;
  providerSubtype?: string | null; creditLimit?: number | null; balanceObserved?: boolean | null;
  valuationUnknown?: boolean; visibilityLevel?: string; viewerIsOwner?: boolean;
};
function space(tier: "BALANCE_ONLY" | "FULL", owner = false): Row[] {
  const t = (r: Row): Row => ({ ...r, visibilityLevel: tier, ...(owner ? { viewerIsOwner: true } : {}) });
  return [
    { id: "chk", type: "checking", balance: 5_000, currency: "USD", visibilityLevel: "FULL" },
    t({ id: "mtg", type: "debt", balance: 0, currency: "USD", debtSubtype: "mortgage", providerSubtype: "mortgage", balanceObserved: false, valuationUnknown: true }),
    t({ id: "mtg2", type: "debt", balance: 250_000, currency: "USD", providerSubtype: "mortgage" }),
    t({ id: "hel", type: "debt", balance: 0, currency: "USD", debtSubtype: "heloc", balanceObserved: false, valuationUnknown: true }),
  ];
}

function payloads(rows: Row[]) {
  const basis = liquidNetWorthBasis(rows);
  const excluded = detectExcludedAccounts(rows);
  const groups = aiExcludedAccountGroups(rows);
  const ai = {
    liquidNetWorth: aiLiquidNetWorth(rows, { totalLiquid: 5_000, totalLiabilities: 250_000, totalInstallmentLiabilities: 250_000 }),
    totalsExcluded: groups,
  };
  const fromAi = excludedFromAiAccounts(ai);
  const statements = (["NET_WORTH", "LIQUID_NET_WORTH", "TOTAL_DEBT"] as const)
    .map((t) => partialTotalStatement(t, excluded)).filter((s) => s !== null);
  const aiStatements = (["NET_WORTH", "TOTAL_DEBT"] as const)
    .map((t) => partialTotalStatement(t, fromAi)).filter((s) => s !== null);
  const ledger = rows.filter((r) => r.type === "debt").map((r) =>
    presentationDebtLabel({ ...r, debtSubtype: r.debtSubtype ?? undefined } as DebtPerspectiveAccount));
  return { basis, note: liquidNetWorthNoteText(basis), excluded, groups, ai, statements, aiStatements, ledger };
}

console.log("\n2. Balance-only co-member: every label coarse, no fine type anywhere");
{
  const p = payloads(space("BALANCE_ONLY"));
  check("liquid NW note: 'Excludes: loan'", p.basis.excludedNote === "Excludes: loan" && /Excludes: loan\./.test(p.note), p.note);
  const debtStmt = p.statements.find((s) => s.total === "TOTAL_DEBT");
  check("partial statement names '(loan and credit line)' — never the fine type",
    !!debtStmt && /\(loan and credit line\)/.test(debtStmt.detail), debtStmt?.detail);
  check("AI totalsExcluded labels coarse ('loan', 'credit line')",
    p.groups.map((g) => g.label).sort().join("|") === "credit line|loan", p.groups);
  check("AI totalsExcluded debtType is the kind-preserving generic",
    p.groups.every((g) => g.debtType === "other_installment" || g.debtType === "other_revolving"), p.groups);
  check("AI liquidNetWorth.excludedKinds = ['loan']", JSON.stringify(p.ai.liquidNetWorth.excludedKinds) === '["loan"]', p.ai.liquidNetWorth);
  check("AI-derived partial statements coarse", p.aiStatements.every((s) => /loan|credit line/.test(s.detail)), p.aiStatements.map((s) => s.detail));
  check("ledger labels coarse ('Loan', 'Credit line')", p.ledger.join("|") === "Loan|Loan|Credit line", p.ledger);
  // The scan: every label-bearing payload this viewer receives.
  const blob = JSON.stringify({ note: p.note, basis: p.basis, groups: p.groups, ai: p.ai,
    statements: p.statements.map((s) => s.text), aiStatements: p.aiStatements.map((s) => s.text),
    labels: p.excluded.map((e) => [e.label, e.debtType]), ledger: p.ledger });
  // The static DEFINITION sentence ("…excludes mortgages and other long-term
  // loans…") is identical for every viewer and discloses nothing about THIS
  // Space; it is the only place the word may appear.
  const scanned = blob.split(LIQUID_NET_WORTH_DEFINITION).join("<definition>");
  check("SCAN: no 'mortgage' / 'HELOC' / 'home equity' in the balance-only viewer's label payloads", !FINE_WORDS.test(scanned), scanned.match(FINE_WORDS)?.[0]);

  // Arithmetic unchanged: same counts / exclusions as the FULL view.
  const full = payloads(space("FULL"));
  check("math unchanged — liquid-NW exclusion count + amount identical to FULL",
    p.basis.excludedCount === full.basis.excludedCount && p.ai.liquidNetWorth.amount === full.ai.liquidNetWorth.amount
    && p.ai.liquidNetWorth.excludedInstallmentDebt === full.ai.liquidNetWorth.excludedInstallmentDebt);
  check("math unchanged — excluded counts identical to FULL",
    JSON.stringify(countsOfExcluded(p.excluded)) === JSON.stringify(countsOfExcluded(full.excluded)));
  check("math unchanged — statement coverage identical to FULL",
    JSON.stringify(p.statements.map((s) => s.coverage)) === JSON.stringify(full.statements.map((s) => s.coverage)));
}

console.log("\n3. Owner and FULL co-member see the fine type");
{
  for (const [who, p] of [["FULL co-member", payloads(space("FULL"))], ["owner (BALANCE_ONLY link)", payloads(space("BALANCE_ONLY", true))]] as const) {
    check(`${who}: liquid NW note 'Excludes: mortgage'`, p.basis.excludedNote === "Excludes: mortgage", p.basis.excludedNote);
    const debtStmt = p.statements.find((s) => s.total === "TOTAL_DEBT");
    check(`${who}: partial statement '(mortgage and HELOC)'`, !!debtStmt && /\(mortgage and HELOC\)/.test(debtStmt.detail), debtStmt?.detail);
    check(`${who}: AI groups name 'mortgage' + debtType 'mortgage'`,
      p.groups.some((g) => g.label === "mortgage" && g.debtType === "mortgage"), p.groups);
    check(`${who}: ledger 'Mortgage'`, p.ledger[0] === "Mortgage", p.ledger);
  }
}

console.log("\n4. Product sources: balance-only rows carry the tier; names are kind-only");
{
  const root = process.cwd();
  const priv = readFileSync(join(root, "lib/account-privacy.ts"), "utf8");
  check("normalizeSharedAccounts stamps visibilityLevel FULL + BALANCE_ONLY",
    /visibilityLevel: "FULL"/.test(priv) && /visibilityLevel: "BALANCE_ONLY"/.test(priv));
  check("genericAccountName has no fine debt names", !/"Mortgage Account"|"Auto Loan"|"Credit Card"/.test(priv));
  const data = readFileSync(join(root, "lib/data/accounts.ts"), "utf8");
  check("lib/data/accounts.ts stamps the tier on every row (2 non-FULL + FULL)",
    (data.match(/visibilityLevel: link\.visibilityLevel,/g) ?? []).length === 2 && /visibilityLevel: "FULL",/.test(data));
  const asm = readFileSync(join(root, "lib/ai/assemblers/accounts.ts"), "utf8");
  check("AI classifiableAll carries the tier", /visibilityLevel: l\.visibilityLevel,/.test(asm));
  check("AI balance-only debt rows carry coarse provider evidence + pinned kind", /coarseDebtEvidence\(liabilityKind\(/.test(asm));
}

console.log("\n5. Source scan — the fine label is reached only through the helper");
{
  const root = process.cwd();
  const ALLOW: Record<string, string> = {
    "lib/debt/liability-kind.ts": "defines debtTypeLabel + DEBT_TYPE_LABEL; viewerDebtLabel is THE caller",
    "lib/assets/property-equity.ts": "SECURED_DEBT_KIND_LABEL — property link candidates (owner / FULL only, linkCandidate check); BALANCE_ONLY linked-debt naming is S2-R2 property scope (flagged)",
  };
  const files: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d)) {
      if (e === "node_modules" || e.startsWith(".")) continue;
      const p = join(d, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(e) && !/\.test\.tsx?$/.test(e)) files.push(p);
    }
  };
  for (const d of ["lib", "app", "components", "jobs"]) walk(join(root, d));
  const offenders: string[] = [];
  for (const f of files) {
    const rel = relative(root, f);
    if (ALLOW[rel]) continue;
    const src = readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    if (/\bdebtTypeLabel\s*\(/.test(src) || /\bDEBT_TYPE_LABEL\b/.test(src)) offenders.push(rel);
  }
  check("debtTypeLabel( / DEBT_TYPE_LABEL appear only in the allowlist", offenders.length === 0, offenders);
}

if (failures > 0) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log("\nall viewer-debt-label checks passed");
