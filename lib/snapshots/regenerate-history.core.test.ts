/**
 * lib/snapshots/regenerate-history.core.test.ts
 *
 * A9 — pure wealth-regeneration core tests. Standalone tsx script:
 *
 *     npx tsx lib/snapshots/regenerate-history.core.test.ts
 *
 * Covers: investment override via A8 value, frozen-row safety, flip rule,
 * no-fabrication (unsupported skip), monotone/coverage, cash-only days,
 * formula parity with computeSnapshotFields, and determinism.
 */

import { regenerateDay, regenerateWindow, writableRows, WEALTH_REGEN_EPSILON, type DayRegenInput } from "./regenerate-history.core";
import { computeSnapshotFields, type ClassifyTotals } from "./backfill-core";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const base = (over: Partial<ClassifyTotals> = {}): ClassifyTotals => ({
  totalInvestments: 10_000, // flat-held by backfill — the value A9 replaces
  totalDigitalAssets: 2_000,
  totalChecking: 3_000,
  totalSavings: 1_000,
  totalLiabilities: 500,
  totalRealAssets: 0,
  ...over,
});

const input = (over: Partial<DayRegenInput> = {}): DayRegenInput => ({
  date: "2026-05-01",
  existingIsEstimated: true,
  base: base(),
  investmentValue: 8_500, // A8 historical value (lower than the flat 10,000)
  investmentTier: "derived",
  hasInvestmentEvidence: true,
  cashCardTier: "derived",
  ...over,
});

function main(): void {
  // ── 1. Investment override via A8 valuation ───────────────────────────────
  console.log("1. A8 investment override");
  {
    const r = regenerateDay(input());
    check("action write", r.action === "write");
    check("stocks replaced with the A8 value, not the flat 10,000", r.fields?.stocks === 8_500);
    check("crypto/cash/savings/debt kept from the walk-back base",
      r.fields?.crypto === 2_000 && r.fields?.cash === 3_000 && r.fields?.savings === 1_000 && r.fields?.debt === 500);
    // Parity: fields equal computeSnapshotFields with investments overridden.
    const expected = computeSnapshotFields({ ...base(), totalInvestments: 8_500 });
    check("derived aggregates match computeSnapshotFields (formula parity)", JSON.stringify(r.fields) === JSON.stringify(expected));
    check("netWorth reflects the A8 value", r.fields?.netWorth === expected.netWorth);
  }

  // ── 2. Frozen-row safety (observed rows never touched) ────────────────────
  console.log("2. Frozen-row safety");
  {
    const r = regenerateDay(input({ existingIsEstimated: false }));
    check("observed row → skip-frozen, no fields", r.action === "skip-frozen" && r.fields === null);
    check("frozen row stays observed/false", r.tier === "observed" && r.isEstimated === false);
  }

  // ── 3. Flip rule (derived/estimated never presented as observed) ──────────
  console.log("3. Flip rule");
  {
    check("derived investment ⇒ row stays estimated", regenerateDay(input({ investmentTier: "derived", cashCardTier: "derived" })).isEstimated === true);
    check("estimated investment ⇒ estimated + worst tier", (() => { const r = regenerateDay(input({ investmentTier: "estimated" })); return r.isEstimated === true && r.tier === "estimated"; })());
    check("all-observed ⇒ flips to observed (isEstimated false)", (() => { const r = regenerateDay(input({ investmentTier: "observed", cashCardTier: "observed" })); return r.tier === "observed" && r.isEstimated === false; })());
    check("incomplete investment drags the row tier to incomplete", regenerateDay(input({ investmentTier: "incomplete" })).tier === "incomplete");
  }

  // ── 4. No fabrication: unsupported investments left as-is ─────────────────
  console.log("4. No fabrication (unsupported skip)");
  {
    const r = regenerateDay(input({ hasInvestmentEvidence: false, base: base({ totalInvestments: 10_000 }) }));
    check("flat investments with no A8 evidence → skip-unsupported (never zeroed)", r.action === "skip-unsupported" && r.fields === null);
    check("skipped-unsupported reason names the honest boundary", /not fabricated/i.test(r.reason));
  }

  // ── 5. Cash-only day (no investments at all) ──────────────────────────────
  console.log("5. Cash-only reconstruction");
  {
    const r = regenerateDay(input({ hasInvestmentEvidence: false, base: base({ totalInvestments: 0, totalDigitalAssets: 0 }), investmentValue: 0 }));
    check("no investments + no evidence ⇒ writes a cash-only derived row", r.action === "write" && r.fields?.stocks === 0);
    check("cash-only row is estimated (reconstruction)", r.isEstimated === true && r.tier === "derived");
  }
  {
    // Sub-epsilon flat investment is treated as nothing to reconstruct → writes.
    const r = regenerateDay(input({ hasInvestmentEvidence: false, base: base({ totalInvestments: WEALTH_REGEN_EPSILON / 2 }) }));
    check("sub-epsilon flat investment is not a fabrication concern → writes", r.action === "write");
  }

  // ── 6. Missing-day fill (no existing row) ─────────────────────────────────
  console.log("6. Missing-day coverage");
  {
    const r = regenerateDay(input({ existingIsEstimated: null }));
    check("missing day with evidence → write an estimated row (adds coverage)", r.action === "write" && r.isEstimated === true);
  }

  // ── 7. Determinism + window/writable helpers ──────────────────────────────
  console.log("7. Determinism");
  {
    const inputs = [input({ date: "2026-05-01" }), input({ date: "2026-05-02", existingIsEstimated: false }), input({ date: "2026-05-03", hasInvestmentEvidence: false, base: base({ totalInvestments: 9_999 }) })];
    const a = regenerateWindow(inputs);
    const b = regenerateWindow(inputs);
    check("identical inputs → byte-identical results", JSON.stringify(a) === JSON.stringify(b));
    check("writableRows excludes frozen + unsupported", writableRows(a).length === 1 && writableRows(a)[0].date === "2026-05-01");
    // Monotone: no result turns an observed row estimated.
    check("monotone — a frozen observed row never becomes estimated", !a.some((r) => r.action === "write" && r.date === "2026-05-02"));
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log("\nAll wealth-regeneration core checks passed.");
  process.exit(0);
}

main();
