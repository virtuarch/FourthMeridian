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
  // Part-A crypto override — default OFF (no evidence) so existing cases are
  // unchanged (flat totalDigitalAssets preserved); crypto cases set these.
  digitalAssetValue: 0,
  digitalAssetTier: "estimated",
  hasDigitalAssetEvidence: false,
  cashCardTier: "derived",
  membershipChangedSince: false,
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

  // ── 1b. Crypto (digital-asset) override (Part-A) ──────────────────────────
  console.log("1b. Crypto override");
  {
    // Evidence present → totalDigitalAssets replaced with the historical value.
    const r = regenerateDay(input({ digitalAssetValue: 3_500, hasDigitalAssetEvidence: true }));
    check("crypto replaced with the historical value, not the flat 2,000", r.fields?.crypto === 3_500);
    const expected = computeSnapshotFields({ ...base(), totalInvestments: 8_500, totalDigitalAssets: 3_500 });
    check("aggregates match computeSnapshotFields with BOTH overrides", JSON.stringify(r.fields) === JSON.stringify(expected));
    // No evidence → flat crypto preserved (never fabricated).
    const flat = regenerateDay(input({ digitalAssetValue: 9_999, hasDigitalAssetEvidence: false }));
    check("no crypto evidence → flat 2,000 preserved", flat.fields?.crypto === 2_000);
  }

  // ── 2. Frozen-row safety (observed rows never touched) ────────────────────
  console.log("2. Frozen-row safety");
  {
    const r = regenerateDay(input({ existingIsEstimated: false }));
    check("observed row → skip-frozen, no fields", r.action === "skip-frozen" && r.fields === null);
    check("frozen row stays observed/false", r.tier === "observed" && r.isEstimated === false);
  }

  // ── 2b. Membership-changed guard (2026-07-15 — the archived-account leak fix) ─
  console.log("2b. Membership-changed guard");
  {
    const r = regenerateDay(input({ membershipChangedSince: true }));
    check("account removed since this day ⇒ skip-membership-changed, no fields", r.action === "skip-membership-changed" && r.fields === null);
    check("reason names the account-removal boundary", /removed from this Space/i.test(r.reason));
    check("preserves the prior isEstimated flag when one exists", regenerateDay(input({ membershipChangedSince: true, existingIsEstimated: true })).isEstimated === true);
    check("defaults isEstimated true when there was no existing row", regenerateDay(input({ membershipChangedSince: true, existingIsEstimated: null })).isEstimated === true);
    // FROZEN still takes priority — an observed row is never touched regardless
    // of membership changes (frozen is the load-bearing safety rule; membership
    // changed is a softer "don't guess" guard for still-estimated days).
    const frozenWins = regenerateDay(input({ membershipChangedSince: true, existingIsEstimated: false }));
    check("FROZEN check still wins over membership-changed", frozenWins.action === "skip-frozen");
    // No membership change ⇒ ordinary write proceeds unaffected (regression guard).
    check("no membership change ⇒ writes normally", regenerateDay(input({ membershipChangedSince: false })).action === "write");
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
