/**
 * lib/account-classifier.golden.test.ts
 *
 * MC1 Phase 2 Slice 3 — the byte-identical golden gate (plan §3.4).
 *
 * Proves that threading the ConversionContext through classifyAccounts is
 * behavior-neutral: with identityContext(DEFAULT_DISPLAY_CURRENCY), the FULL
 * classification output is byte-identical (JSON.stringify) to the context-less
 * call — for USD rows, null/undefined-currency rows, and even non-USD rows
 * (identity/native-pass-through arithmetic, plan D-3).
 *
 * Coverage of the required golden surfaces:
 *   - classifyAccounts itself (direct byte-equality, fixed + randomized);
 *   - snapshot writer fields (regenerate.ts's exact derivation, replicated
 *     over both classifications — equal classifications ⇒ equal fields);
 *   - AI accounts section (the assembler consumes ONLY classification totals
 *     for its blended figures — lib/ai/assemblers/accounts.ts builds
 *     {type, balance, currency, syncStatus} rows and reads classification.*;
 *     byte-equal classifications on assembler-shaped rows ⇒ byte-equal
 *     section, by composition);
 *   - perspective/liquidity: lib/perspective-engine/lenses/liquidity.core.ts
 *     does its own deliberate raw addition ("matching classifyAccounts()
 *     behavior — raw addition, no FX conversion") and was NOT threaded in
 *     this slice — untouched code is unchanged by definition; its own suite
 *     (liquidity.test.ts) remains the regression net. Recorded as Phase 3
 *     entry finding F-3: the lens must be threaded when the target flips.
 *
 * Pure: no DB, no network. House-style standalone tsx script.
 */

import { classifyAccounts, type ClassifiableAccount } from "./account-classifier";
import { identityContext } from "./money/convert";
import { DEFAULT_DISPLAY_CURRENCY } from "./currency";

let passed = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { passed++; return; }
  failures.push(`✗ ${name}${detail ? ` — ${detail}` : ""}`);
}

const CTX = identityContext(DEFAULT_DISPLAY_CURRENCY);

/** The regenerate.ts snapshot-field derivation, verbatim shape. */
function snapshotFields(c: ReturnType<typeof classifyAccounts>) {
  const stocks     = c.totalInvestments;
  const crypto     = c.totalDigitalAssets;
  const total      = stocks + crypto;
  const cash       = c.totalChecking;
  const savings    = c.totalSavings;
  const debt       = c.totalLiabilities;
  const realAssets = c.totalRealAssets;
  const totalAssets = total + cash + savings + realAssets;
  const netWorth    = totalAssets - debt;
  const netLiquid   = cash + savings - debt;
  const cashOnHand  = Math.max(cash, 0);
  return { stocks, crypto, total, cash, savings, debt, netWorth, totalAssets, netLiquid, cashOnHand };
}

// ── fixed USD fixture (incl. residue + edge shapes) ───────────────────────────

const usdFixture: ClassifiableAccount[] = [
  { type: "checking",   balance: 5230.44,  currency: "USD" },
  { type: "checking",   balance: 0.1,      currency: "USD" },
  { type: "savings",    balance: 20000.02, currency: "USD" },
  { type: "investment", balance: 150000.5, currency: "USD", syncStatus: "ok" },
  { type: "crypto",     balance: 4321.09,  currency: "USD" },
  { type: "other",      balance: 350000,   currency: "USD", syncStatus: "manual" },
  { type: "debt",       balance: 9876.54,  currency: "USD" },
  { type: "debt",       balance: -45.1,    currency: "USD" },   // card credit — clamped
  { type: "checking",   balance: 77.77 },                        // currency undefined (SpaceAccount shape)
  { type: "savings",    balance: 12.34,    currency: null },     // Phase 0 null-residue
  { type: "mystery",    balance: 999,      currency: "USD" },    // uncategorized — excluded from totals
];

{
  const without = classifyAccounts(usdFixture);
  const withCtx = classifyAccounts(usdFixture, CTX);
  check("golden: classifyAccounts byte-identical (USD fixture)",
    JSON.stringify(without) === JSON.stringify(withCtx));
  check("golden: snapshot writer fields byte-identical",
    JSON.stringify(snapshotFields(without)) === JSON.stringify(snapshotFields(withCtx)));
  check("golden: float accumulation identical (0.1-style sums preserved)",
    without.totalChecking === withCtx.totalChecking && without.netWorth === withCtx.netWorth);
}

// ── non-USD rows under identity: STILL byte-identical (D-3 continuity) ───────

{
  const mixed: ClassifiableAccount[] = [
    ...usdFixture,
    { type: "savings", balance: 40000, currency: "EUR" }, // future-shaped data
    { type: "debt",    balance: 1200,  currency: "SAR" },
  ];
  check("golden: non-USD rows pass through natively under identityContext (byte-identical)",
    JSON.stringify(classifyAccounts(mixed)) === JSON.stringify(classifyAccounts(mixed, CTX)));
}

// ── AI accounts section (composition surface) ─────────────────────────────────

{
  // Exactly the row shape lib/ai/assemblers/accounts.ts builds (L201–208).
  const assemblerRows: ClassifiableAccount[] = [
    { type: "checking",   balance: 1500.25, currency: "USD", syncStatus: undefined },
    { type: "investment", balance: 80000,   currency: "USD", syncStatus: "ok" },
    { type: "debt",       balance: 4321,    currency: "USD", syncStatus: "error" },
  ];
  const a = classifyAccounts(assemblerRows);
  const b = classifyAccounts(assemblerRows, CTX);
  check("golden: assembler-shaped rows byte-identical", JSON.stringify(a) === JSON.stringify(b));
  check("golden: the three blended figures the AI section reads are identical",
    a.totalAssets === b.totalAssets && a.totalLiabilities === b.totalLiabilities && a.netWorth === b.netWorth);
}

// ── randomized property check ─────────────────────────────────────────────────

{
  const types = ["checking", "savings", "investment", "crypto", "other", "debt", "weird"];
  const currencies: (string | null | undefined)[] = ["USD", "EUR", "GBP", "SAR", null, undefined];
  let rng = 424242;
  const rand = () => (rng = (rng * 1103515245 + 12345) % 2147483648) / 2147483648; // deterministic LCG

  let allEqual = true;
  for (let i = 0; i < 200; i++) {
    const n = Math.floor(rand() * 12);
    const fixture: ClassifiableAccount[] = Array.from({ length: n }, () => ({
      type:     types[Math.floor(rand() * types.length)],
      balance:  Math.round((rand() * 200000 - 20000) * 100) / 100,
      currency: currencies[Math.floor(rand() * currencies.length)],
    }));
    if (JSON.stringify(classifyAccounts(fixture)) !== JSON.stringify(classifyAccounts(fixture, CTX))) {
      allEqual = false;
      break;
    }
  }
  check("golden: 200 randomized fixtures byte-identical (incl. empty, negative, mixed-currency)", allEqual);
}

// ── seam liveness (unit-level only — NOT product behavior) ────────────────────

{
  // A real-rate fixture context proves the threading actually converts when a
  // non-identity context arrives (Phase 3's dial). 100 EUR @ 1.25 → 125 USD.
  const realCtx = {
    target: "USD",
    resolve: (from: string, dateISO: string) =>
      from === "EUR"
        ? ({ kind: "rate", rate: 1.25, requestedDateISO: dateISO, effectiveDates: { from: dateISO, to: dateISO }, staleness: "exact" } as const)
        : ({ kind: "miss", quote: from, requestedDateISO: dateISO } as const),
  };
  const c = classifyAccounts(
    [{ type: "savings", balance: 100, currency: "EUR" }, { type: "savings", balance: 10, currency: "USD" }],
    realCtx,
  );
  check("seam live: real context converts (100 EUR @1.25 + 10 USD = 135)", c.totalSavings === 135);
  const clamp = classifyAccounts([{ type: "debt", balance: -100, currency: "EUR" }], realCtx);
  check("seam live: convert-then-clamp keeps card credits excluded", clamp.totalLiabilities === 0);
}

// ── Report ────────────────────────────────────────────────────────────────────
if (failures.length > 0) {
  console.error(`\nMC1 P2 classifier goldens: ${failures.length} FAILURE(S) (${passed} checks passed):`);
  for (const f of failures) console.error("  " + f);
  process.exit(1);
}
console.log(`MC1 P2 classifier goldens: all ${passed} checks passed.`);
process.exit(0);
