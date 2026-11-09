/**
 * lib/accounts/credit-utilization.test.ts
 *
 * UX-PER-3 Debt — credit-utilization normalization + level. Runnable with tsx:
 *   npx tsx lib/accounts/credit-utilization.test.ts
 * Auto-discovered by scripts/run-tests.ts. Pure module.
 */

import { creditUtilization, utilizationLevel, type UtilizationInputAccount } from "@/lib/accounts/credit-utilization";

let failures = 0, passes = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) passes++;
  else { failures++; console.log(`[FAIL] ${name}`); if (detail) console.log(`        ${detail}`); }
}

function acct(p: Partial<UtilizationInputAccount> & { id: string }): UtilizationInputAccount {
  return { name: p.id, type: "debt", balance: 0, creditLimit: null, ...p };
}

// ── Level thresholds ────────────────────────────────────────────────────────────
check("10% → low",       utilizationLevel(10) === "low");
check("35% → moderate",  utilizationLevel(35) === "moderate");
check("90% → high",      utilizationLevel(90) === "high");
check("120% → over",     utilizationLevel(120) === "over");

// ── Boundaries are graded on the DISPLAYED whole percent (label never contradicts number) ──
check("29.4% shows 29% → low",      utilizationLevel(29.4) === "low");
check("29.9% shows 30% → moderate", utilizationLevel(29.9) === "moderate");
check("30.0% → moderate",           utilizationLevel(30) === "moderate");
check("69.4% shows 69% → moderate", utilizationLevel(69.4) === "moderate");
check("69.5% shows 70% → high",     utilizationLevel(69.5) === "high");
check("100.4% shows 100% → high",   utilizationLevel(100.4) === "high");
check("100.5% shows 101% → over",   utilizationLevel(100.5) === "over");
for (const p of [0, 12.5, 29.49, 29.5, 29.9, 30, 69.49, 69.5, 99.6, 100.4, 100.5, 140]) {
  const shown = Number(p.toFixed(0));
  const want = shown > 100 ? "over" : shown >= 70 ? "high" : shown >= 30 ? "moderate" : "low";
  check(`label matches shown ${p.toFixed(0)}% for ${p}`, utilizationLevel(p) === want);
}

// ── Normalization: 0.35 ratio → 35%, not 3500% ──────────────────────────────────
const normal = creditUtilization([acct({ id: "card", balance: 350, creditLimit: 1000 })]);
check("normal: pct is 35 (not 3500)", normal.rows[0].pct === 35);
check("normal: barPct is 35",          normal.rows[0].barPct === 35);
check("normal: level moderate",        normal.rows[0].level === "moderate");

// ── High utilization ────────────────────────────────────────────────────────────
const high = creditUtilization([acct({ id: "card", balance: 900, creditLimit: 1000 })]);
check("high: pct 90, level high", high.rows[0].pct === 90 && high.rows[0].level === "high");

// ── Over-limit: pct preserved, bar clamped ──────────────────────────────────────
const over = creditUtilization([acct({ id: "card", balance: 1200, creditLimit: 1000 })]);
check("over: pct kept at 120", over.rows[0].pct === 120);
check("over: barPct clamped to 100", over.rows[0].barPct === 100);
check("over: level over", over.rows[0].level === "over");

// ── Missing / zero / negative limit → missingLimit, not a row ────────────────────
const missing = creditUtilization([
  acct({ id: "noLimit" }),
  acct({ id: "zeroLimit", creditLimit: 0 }),
  acct({ id: "card", balance: 100, creditLimit: 500 }),
]);
check("missing-limit accounts are surfaced separately",
  missing.missingLimit.map((m) => m.id).sort().join(",") === "noLimit,zeroLimit");
check("only accounts with a limit become rows", missing.rows.length === 1 && missing.rows[0].id === "card");

// ── Asset accounts are ignored ──────────────────────────────────────────────────
const withAsset = creditUtilization([
  acct({ id: "checking", type: "checking", balance: 5000, creditLimit: 9999 }),
  acct({ id: "card", type: "debt", balance: 100, creditLimit: 500 }),
]);
check("non-debt accounts excluded entirely",
  withAsset.rows.length === 1 && withAsset.missingLimit.length === 0);

// ── Sort: highest utilization first ─────────────────────────────────────────────
const sorted = creditUtilization([
  acct({ id: "low", balance: 100, creditLimit: 1000 }),   // 10%
  acct({ id: "high", balance: 800, creditLimit: 1000 }),  // 80%
]);
check("rows sorted by utilization desc", sorted.rows.map((r) => r.id).join(",") === "high,low");

console.log(`\n${passes} passed, ${failures} failed (${passes + failures} checks).`);
if (failures > 0) { console.log("Credit-utilization tests FAILED."); process.exit(1); }
console.log("Credit-utilization tests passed.");
process.exit(0);
