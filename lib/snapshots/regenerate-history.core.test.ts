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

import {
  regenerateDay, regenerateWindow, writableRows, WEALTH_REGEN_EPSILON,
  isUsableValuation, INVALID_VALUATION_REASON_CODE, NO_CRYPTO_EVIDENCE_REASON_CODE,
  type DayRegenInput,
} from "./regenerate-history.core";
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

/**
 * A plausible stored row, so a per-component refusal has something to PRESERVE.
 * Values are deliberately distinct from every fresh input below, so a test can
 * tell "preserved the stored value" from "recomputed and happened to match".
 */
const STORED = {
  stocks: 7_777, crypto: 3_333, total: 11_110, cash: 1_111, savings: 2_222,
  debt: 999, netWorth: 11_444, totalAssets: 12_443, netLiquid: 2_334, cashOnHand: 1_111,
};

const input = (over: Partial<DayRegenInput> = {}): DayRegenInput => ({
  date: "2026-05-01",
  existingIsEstimated: true,
  base: base(),
  investmentValue: 8_500, // A8 historical value (lower than the flat 10,000)
  investmentTier: "derived",
  hasInvestmentEvidence: true,
  // Part-A crypto override — default ON, valuing the base's crypto at its own
  // flat amount so the DEFAULT day is fully valuable and every non-crypto case
  // below exercises only what it is about.
  //
  // V26-CRYPTO-QTY-1 changed why this matters: crypto that CANNOT be valued now
  // skips the day (the analogue of the investment no-fabrication rule), so a
  // default of `hasDigitalAssetEvidence: false` alongside a material
  // `totalDigitalAssets` would silently turn every case here into a skip and
  // stop testing its subject. Cases that mean to exercise missing crypto
  // evidence set it explicitly — see 1b.
  digitalAssetValue: 2_000,
  digitalAssetTier: "estimated",
  hasDigitalAssetEvidence: true,
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
    // V26-CRYPTO-QTY-1 — no crypto evidence and a MATERIAL flat balance: the day
    // is left unwritten. This assertion previously read "flat 2,000 preserved",
    // which encoded the defect: `base.totalDigitalAssets` is the wallet's CURRENT
    // USD balance carried backward, so writing it asserted a crypto value for a
    // day nothing could value — 235 consecutive identical days in production.
    // Preserving the stored row is not the same as asserting the carried number.
    const flat = regenerateDay(input({ digitalAssetValue: 9_999, hasDigitalAssetEvidence: false }));
    check("no crypto evidence + material flat balance → day skipped, not asserted",
      flat.action === "skip-unsupported" && flat.fields === null);
    check("…and the skip is machine-searchable",
      flat.reason.startsWith(NO_CRYPTO_EVIDENCE_REASON_CODE));

    // A Space with NO crypto is untouched by the guard — nothing to fabricate.
    const noCrypto = regenerateDay(input({
      base: base({ totalDigitalAssets: 0 }), digitalAssetValue: 0, hasDigitalAssetEvidence: false,
    }));
    check("no crypto at all → guard silent, day still writes",
      noCrypto.action === "write" && noCrypto.fields?.crypto === 0);

    // INVALID EVIDENCE is more specific and must still win on a day that is both.
    const both = regenerateDay(input({
      investmentValue: -1, hasInvestmentEvidence: true,
      digitalAssetValue: 0, hasDigitalAssetEvidence: false,
    }));
    check("invalid evidence outranks the crypto no-fabrication skip",
      both.action === "skip-unsupported" && both.reason.startsWith(INVALID_VALUATION_REASON_CODE));
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

  // ── 2c. Amendment bypass (Phase 2 — explicit, consent-gated rebuild) ──────
  console.log("2c. Amendment bypass");
  {
    // A frozen (observed) row IS revised by an amendment — the one sanctioned
    // way to deliberately rewrite an observation (proposal §4).
    const frozen = regenerateDay(input({ existingIsEstimated: false, isAmendment: true }));
    check("amendment revises a frozen row → write (not skip-frozen)", frozen.action === "write" && frozen.fields !== null);
    check("amended row lands isEstimated=true (a revised observation is a reconstruction)", frozen.isEstimated === true);

    // A membership-changed day IS revised by an amendment (the guard is exempt
    // by construction for the consent-gated path).
    const member = regenerateDay(input({ membershipChangedSince: true, isAmendment: true }));
    check("amendment revises a membership-changed day → write (not skip)", member.action === "write" && member.fields !== null);

    // Even an all-observed day stays estimated once amended (§4 flip).
    const allObserved = regenerateDay(input({ investmentTier: "observed", cashCardTier: "observed", isAmendment: true }));
    check("amendment forces isEstimated=true even when every component is observed", allObserved.isEstimated === true);

    // Regression: without isAmendment the guards are unchanged.
    check("no isAmendment ⇒ frozen still skips (automatic path unchanged)", regenerateDay(input({ existingIsEstimated: false })).action === "skip-frozen");
    check("no isAmendment ⇒ membership-changed still skips", regenerateDay(input({ membershipChangedSince: true })).action === "skip-membership-changed");
  }

  // ── 3. Flip rule (derived/estimated never presented as observed) ──────────
  console.log("3. Flip rule");
  {
    check("derived investment ⇒ row stays estimated", regenerateDay(input({ investmentTier: "derived", cashCardTier: "derived" })).isEstimated === true);
    check("estimated investment ⇒ estimated + worst tier", (() => { const r = regenerateDay(input({ investmentTier: "estimated" })); return r.isEstimated === true && r.tier === "estimated"; })());
    check("all-observed ⇒ flips to observed (isEstimated false)", (() => { const r = regenerateDay(input({ investmentTier: "observed", cashCardTier: "observed", digitalAssetTier: "observed" })); return r.tier === "observed" && r.isEstimated === false; })());
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
    const r = regenerateDay(input({ hasInvestmentEvidence: false, base: base({ totalInvestments: 0, totalDigitalAssets: 0 }), investmentValue: 0, digitalAssetValue: 0, hasDigitalAssetEvidence: false }));
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

  // ── 8. INVALID EVIDENCE guard (P0) ────────────────────────────────────────
  // A negative or non-finite historical valuation is an impossible balance
  // component, not a weak estimate. It must never reach a snapshot write, must
  // not be clamped to 0 or replaced with the flat value, and must be
  // distinguishable from ABSENT evidence so the upstream position-reconstruction
  // defect that produced it stays observable.
  console.log("\n8. Invalid valuation evidence (P0)");
  {
    const INVALID = [
      ["negative", -1_810],
      ["NaN", Number.NaN],
      ["+Infinity", Number.POSITIVE_INFINITY],
      ["-Infinity", Number.NEGATIVE_INFINITY],
    ] as const;

    // Predicate itself — the shared definition the SQL probe mirrors.
    check("isUsableValuation accepts zero", isUsableValuation(0));
    check("isUsableValuation accepts a positive finite value", isUsableValuation(4_968));
    for (const [label, v] of INVALID) {
      check(`isUsableValuation rejects ${label}`, !isUsableValuation(v));
    }

    // Investments — each invalid form skips the day and writes nothing.
    for (const [label, v] of INVALID) {
      const r = regenerateDay(input({ investmentValue: v, hasInvestmentEvidence: true }));
      check(`investments ${label} → skip-unsupported`, r.action === "skip-unsupported", r.action);
      check(`investments ${label} → no fields written`, r.fields === null);
      check(`investments ${label} → reason carries the code + component`,
        r.reason.startsWith(`${INVALID_VALUATION_REASON_CODE} (investments)`), r.reason);
    }

    // Digital assets — the NO-FABRICATION rule above covers only investments, so
    // a crypto-only invalid value must be caught independently.
    for (const [label, v] of INVALID) {
      const r = regenerateDay(input({ digitalAssetValue: v, hasDigitalAssetEvidence: true }));
      check(`digitalAssets ${label} → skip-unsupported`, r.action === "skip-unsupported", r.action);
      check(`digitalAssets ${label} → reason names digitalAssets`,
        r.reason.startsWith(`${INVALID_VALUATION_REASON_CODE} (digitalAssets)`), r.reason);
    }

    // Zero is a legitimate balance component (an emptied portfolio) — it must
    // still WRITE, and the written component must be exactly 0.
    {
      const r = regenerateDay(input({ investmentValue: 0, hasInvestmentEvidence: true }));
      check("investments zero is valid → write", r.action === "write", r.action);
      check("investments zero → component written as 0", r.fields?.stocks === 0, String(r.fields?.stocks));
    }
    {
      const r = regenerateDay(input({ digitalAssetValue: 0, hasDigitalAssetEvidence: true }));
      check("digitalAssets zero is valid → write", r.action === "write", r.action);
      check("digitalAssets zero → component written as 0", r.fields?.crypto === 0, String(r.fields?.crypto));
    }

    // MIXED validity — the invalid component is refused ON ITS OWN and the valid
    // one is still rewritten. This ASSERTION CHANGED with per-component
    // authorisation: it previously skipped the whole day, on the rationale that
    // computeSnapshotFields derives the aggregates from all components at once
    // so a partial write would be internally inconsistent. It no longer is —
    // aggregates are recomputed from exactly the values the row will carry, and
    // the refused component is PRESERVED from the stored row rather than mixed
    // with a stale aggregate. With NO stored row there is nothing to preserve
    // and the whole day still skips, which the next case pins.
    {
      const r = regenerateDay(input({
        investmentValue: 8_500, hasInvestmentEvidence: true,          // valid
        digitalAssetValue: -1, hasDigitalAssetEvidence: true,          // invalid
        existing: STORED,
      }));
      check("mixed validity → the day is PATCHED, not skipped", r.action === "write-partial", r.action);
      const crypto = r.components?.find((c) => c.component === "crypto");
      const stocks = r.components?.find((c) => c.component === "stocks");
      check("mixed validity → the invalid component is preserved, not zeroed",
        crypto?.action === "preserved" && crypto.value === STORED.crypto, JSON.stringify(crypto));
      check("mixed validity → the preserved component is NOT authorized",
        crypto?.authorized === false, String(crypto?.authorized));
      check("mixed validity → the valid component is still recomputed",
        stocks?.action === "recomputed" && stocks.value === 8_500, JSON.stringify(stocks));
      check("mixed validity → only the invalid component is named",
        (crypto?.reason ?? "").startsWith(`${INVALID_VALUATION_REASON_CODE} (digitalAssets)`), String(crypto?.reason));
      check("mixed validity → the patch never names the preserved component",
        !Object.prototype.hasOwnProperty.call(r.fieldPatch ?? {}, "crypto"),
        JSON.stringify(r.fieldPatch));
    }

    // With NO stored row, preservation is impossible ⇒ the whole day still skips.
    {
      const r = regenerateDay(input({
        investmentValue: 8_500, hasInvestmentEvidence: true,
        digitalAssetValue: -1, hasDigitalAssetEvidence: true,
        existing: null,
      }));
      check("no stored row → an unsupported component still skips the whole day",
        r.action === "skip-unsupported", r.action);
    }

    // Both invalid — each component named separately, deterministic order.
    {
      const r = regenerateDay(input({
        investmentValue: -5, hasInvestmentEvidence: true,
        digitalAssetValue: Number.NaN, hasDigitalAssetEvidence: true,
        existing: STORED,
      }));
      const refused = (r.components ?? []).filter((c) => c.action === "preserved").map((c) => c.component);
      check("both invalid → both components refused, in deterministic order",
        JSON.stringify(refused) === JSON.stringify(["stocks", "crypto"]), JSON.stringify(refused));
      check("both invalid → each carries its OWN reason code",
        (r.components ?? []).filter((c) => (c.reason ?? "").includes(INVALID_VALUATION_REASON_CODE)).length === 2,
        JSON.stringify((r.components ?? []).map((c) => c.reason)));
    }

    // PRECEDENCE — the guards above the new one are unchanged.
    {
      const r = regenerateDay(input({ existingIsEstimated: false, investmentValue: -1, hasInvestmentEvidence: true }));
      check("frozen precedence survives an invalid value", r.action === "skip-frozen", r.action);
    }
    {
      const r = regenerateDay(input({ membershipChangedSince: true, investmentValue: -1, hasInvestmentEvidence: true }));
      check("membership-change precedence survives an invalid value", r.action === "skip-membership-changed", r.action);
    }

    // AMENDMENT — a consented rebuild may bypass frozen/membership, never this.
    {
      const r = regenerateDay(input({
        isAmendment: true, existingIsEstimated: false,
        investmentValue: -1_810, hasInvestmentEvidence: true,
      }));
      check("an amendment may NOT write an impossible value", r.action === "skip-unsupported", r.action);
      check("amendment rejection carries the code", r.reason.startsWith(INVALID_VALUATION_REASON_CODE), r.reason);
    }

    // Distinguishable from ABSENT evidence — the two skips share an action but
    // must never share a reason, or the upstream defect becomes invisible.
    {
      const absent = regenerateDay(input({ hasInvestmentEvidence: false, base: base({ totalInvestments: 9_999 }) }));
      const invalid = regenerateDay(input({ investmentValue: -1, hasInvestmentEvidence: true }));
      check("absent-evidence skip does NOT carry the invalid code",
        absent.action === "skip-unsupported" && !absent.reason.includes(INVALID_VALUATION_REASON_CODE), absent.reason);
      check("invalid-evidence skip is distinguishable from absent",
        invalid.reason !== absent.reason);
    }

    // Healthy evidence is untouched by the new guard.
    {
      const r = regenerateDay(input({ investmentValue: 8_500, hasInvestmentEvidence: true }));
      check("healthy historical evidence still writes", r.action === "write", r.action);
      check("healthy value unchanged by the guard", r.fields?.stocks === 8_500, String(r.fields?.stocks));
    }

    // writableRows must exclude an invalid day, so the stored row survives.
    {
      const rows = regenerateWindow([
        input({ date: "2026-06-01" }),
        input({ date: "2026-06-02", investmentValue: -1, hasInvestmentEvidence: true }),
      ]);
      const w = writableRows(rows);
      check("writableRows excludes the invalid day", w.length === 1 && w[0].date === "2026-06-01");
    }
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) FAILED`);
    process.exit(1);
  }
  // ── 9. OWNERSHIP PREHISTORY (V26-PRICE-5A) ───────────────────────────────
  console.log("9. ownership prehistory — never a zero-valued portfolio");
  {
    const r = regenerateDay(input({ ownershipIneligible: true, hasInvestmentEvidence: false }));
    check("ineligible ownership → skip-unsupported",
      r.action === "skip-unsupported" && r.fields === null);
    check("…carrying the OWNERSHIP_PREHISTORY code",
      (r.reason ?? "").startsWith("OWNERSHIP_PREHISTORY"));

    // THE BUG THIS GUARD EXISTS FOR: when the day's accounts are floored out the
    // flat investment value is already 0, so the NO-FABRICATION test — which
    // only fires above the epsilon — would let the day through and overwrite a
    // stored value with a fabricated zero.
    const flatZero = regenerateDay(input({
      ownershipIneligible: true, hasInvestmentEvidence: false,
      base: base({ totalInvestments: 0 }),
    }));
    check("a ZERO flat estimate is still skipped, not written as a zero portfolio",
      flatZero.action === "skip-unsupported" && flatZero.fields === null);

    check("a frozen row stays frozen — immutability outranks the prehistory guard",
      regenerateDay(input({ ownershipIneligible: true, existingIsEstimated: false })).action === "skip-frozen");
    check("a membership change still wins",
      regenerateDay(input({ ownershipIneligible: true, membershipChangedSince: true })).action === "skip-membership-changed");

    const amended = regenerateDay(input({
      ownershipIneligible: true, existingIsEstimated: false, isAmendment: true,
    }));
    check("an amendment may NOT write an ownership-ineligible day",
      amended.action === "skip-unsupported" && (amended.reason ?? "").startsWith("OWNERSHIP_PREHISTORY"));

    check("an eligible day still writes normally",
      regenerateDay(input({ ownershipIneligible: false })).action === "write");
    check("omitting the flag preserves prior behaviour exactly",
      regenerateDay(input()).action === "write");
    check("writableRows excludes an ownership-ineligible day",
      writableRows([regenerateDay(input({ ownershipIneligible: true }))]).length === 0);
  }

  console.log("\nAll wealth-regeneration core checks passed.");
  process.exit(0);
}

main();
