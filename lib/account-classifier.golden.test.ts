/**
 * lib/account-classifier.golden.test.ts
 *
 * MC1 Phase 2 Slice 3 golden gate, evolved into the MC1 Phase 3 Slice 2
 * EQUIVALENCE GATES (plan D-10):
 *
 *   - Pure-USD fixtures: with-context vs context-less output remains
 *     BYTE-IDENTICAL (both emit `estimated: false`) — the kill-switch gate.
 *   - Null/undefined-currency (Phase 0 residue) fixtures: totals remain
 *     numerically identical under identity, and `estimated` is now TRUE with
 *     a context (D-3 honesty) vs FALSE without — flags may differ, numbers
 *     may not.
 *   - All-USD data through a REAL (serialized+rehydrated) USD context equals
 *     legacy numerically with `estimated: false` — the "flip is a no-op for
 *     USD users" gate.
 *   - Walk-back ⇒ estimated; miss ⇒ native amount + estimated.
 *
 * Composition surfaces unchanged from Phase 2: snapshot writer fields
 * (regenerate.ts derivation) and AI accounts-section rows; liquidity lens
 * remains un-threaded raw addition until the Phase 3 Slice 5 flip (F-3).
 *
 * Pure: no DB, no network. House-style standalone tsx script.
 */

import { classifyAccounts, type ClassifiableAccount } from "./account-classifier";
import { identityContext, rehydrateContext, serializeContext } from "./money/convert";
import { DEFAULT_DISPLAY_CURRENCY } from "./currency";
import type { ConversionContext } from "./money/types";
import type { Resolution } from "./fx/types";

let passed = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { passed++; return; }
  failures.push(`✗ ${name}${detail ? ` — ${detail}` : ""}`);
}

const CTX = identityContext(DEFAULT_DISPLAY_CURRENCY);

/** All numeric totals, for numeric-equality comparisons where flags may differ. */
function totals(c: ReturnType<typeof classifyAccounts>) {
  const { totalChecking, totalSavings, totalLiquid, totalInvestments,
          totalDigitalAssets, totalRealAssets, totalLiabilities, totalAssets, netWorth } = c;
  return { totalChecking, totalSavings, totalLiquid, totalInvestments,
           totalDigitalAssets, totalRealAssets, totalLiabilities, totalAssets, netWorth };
}

/** The regenerate.ts snapshot-field derivation, verbatim shape. */
function snapshotFields(c: ReturnType<typeof classifyAccounts>) {
  const stocks = c.totalInvestments, crypto = c.totalDigitalAssets, total = stocks + crypto;
  const cash = c.totalChecking, savings = c.totalSavings, debt = c.totalLiabilities;
  const totalAssets = total + cash + savings + c.totalRealAssets;
  return {
    stocks, crypto, total, cash, savings, debt,
    netWorth: totalAssets - debt, totalAssets,
    netLiquid: cash + savings - debt, cashOnHand: Math.max(cash, 0),
  };
}

// ── pure-USD fixture: byte-identity (kill-switch gate) ────────────────────────

const pureUsd: ClassifiableAccount[] = [
  { type: "checking",   balance: 5230.44,  currency: "USD" },
  { type: "checking",   balance: 0.1,      currency: "USD" },
  { type: "savings",    balance: 20000.02, currency: "USD" },
  { type: "investment", balance: 150000.5, currency: "USD", syncStatus: "ok" },
  { type: "crypto",     balance: 4321.09,  currency: "USD" },
  { type: "other",      balance: 350000,   currency: "USD", syncStatus: "manual" },
  { type: "debt",       balance: 9876.54,  currency: "USD" },
  { type: "debt",       balance: -45.1,    currency: "USD" }, // card credit — clamped
  { type: "mystery",    balance: 999,      currency: "USD" }, // uncategorized — excluded
];

{
  const without = classifyAccounts(pureUsd);
  const withCtx = classifyAccounts(pureUsd, CTX);
  check("kill switch: pure-USD byte-identical with vs without context",
    JSON.stringify(without) === JSON.stringify(withCtx));
  check("kill switch: estimated false on both paths",
    without.estimated === false && withCtx.estimated === false);
  check("snapshot fields: byte-identical (pure-USD)",
    JSON.stringify(snapshotFields(without)) === JSON.stringify(snapshotFields(withCtx)));
}

// ── Phase 0 residue: numbers identical, flags honest ──────────────────────────

{
  const residue: ClassifiableAccount[] = [
    ...pureUsd,
    { type: "checking", balance: 77.77 },                 // currency undefined (SpaceAccount shape)
    { type: "savings",  balance: 12.34, currency: null }, // null-residue
  ];
  const without = classifyAccounts(residue);
  const withCtx = classifyAccounts(residue, CTX);
  check("residue: totals numerically identical under identity",
    JSON.stringify(totals(without)) === JSON.stringify(totals(withCtx)));
  check("residue: estimated TRUE with context (D-3 honesty), FALSE without",
    withCtx.estimated === true && without.estimated === false);
}

// ── mixed non-USD under identity: numbers identical, flagged ─────────────────

{
  const mixed: ClassifiableAccount[] = [
    ...pureUsd,
    { type: "savings", balance: 40000, currency: "EUR" },
    { type: "debt",    balance: 1200,  currency: "SAR" },
  ];
  const a = classifyAccounts(mixed);
  const b = classifyAccounts(mixed, CTX);
  check("mixed: totals numerically identical under identityContext (native pass-through)",
    JSON.stringify(totals(a)) === JSON.stringify(totals(b)));
  check("mixed: estimated TRUE with context (unresolved non-USD rows)", b.estimated === true);
}

// ── all-USD through a REAL context == legacy (the no-op-for-USD-users gate) ──

{
  // A real context materialized through the full serialize→rehydrate transport
  // path (doubles as the client-prop equivalence proof for Slice 6).
  const realUsd = rehydrateContext(serializeContext(identityContext("USD"), ["USD"], ["2026-07-04"]));
  const legacy = classifyAccounts(pureUsd);
  const real   = classifyAccounts(pureUsd, realUsd);
  check("real-context gate: all-USD == legacy numerically",
    JSON.stringify(totals(legacy)) === JSON.stringify(totals(real)));
  check("real-context gate: estimated false everywhere for all-USD", real.estimated === false);
}

// ── walk-back and miss semantics at the classifier level ─────────────────────

{
  const walked: Resolution = {
    kind: "rate", rate: 1.25, requestedDateISO: "x",
    effectiveDates: { from: "2026-06-27", to: "x" }, staleness: "walked-back",
  };
  const realCtx: ConversionContext = {
    target: "USD",
    resolve: (from, dateISO) =>
      from === "EUR" ? { ...walked, requestedDateISO: dateISO } : { kind: "miss", quote: from, requestedDateISO: dateISO },
  };
  const c = classifyAccounts(
    [
      { type: "savings", balance: 100, currency: "EUR" },  // walked-back rate
      { type: "savings", balance: 50,  currency: "SAR" },  // miss → native
      { type: "savings", balance: 10,  currency: "USD" },  // identity
    ],
    realCtx,
  );
  check("walk-back: converts and flags (100×1.25 + 50 native + 10 = 185)", c.totalSavings === 185);
  check("walk-back/miss: estimated TRUE", c.estimated === true);
  const clamp = classifyAccounts([{ type: "debt", balance: -100, currency: "EUR" }], realCtx);
  check("convert-then-clamp: card credits still excluded", clamp.totalLiabilities === 0);
}

// ── historical valuation date (MC1 P3 Slice 3 — snapshot backfill rule) ──────

{
  // Resolver keyed by date: the same EUR balance converts differently on
  // different valuation dates — classifyAccounts must pass the caller's
  // explicit date through (backfill), defaulting to latest-close otherwise.
  const jan = "2026-01-15", jun = "2026-06-15";
  // Binary-exact rates (no-rounding doctrine D-4 means float artifacts are
  // preserved — pick rates whose products are exact so equality checks hold).
  const rateByDate: Record<string, number> = { [jan]: 1.25, [jun]: 1.5 };
  const datedCtx: ConversionContext = {
    target: "USD",
    resolve: (from, dateISO) =>
      from === "EUR" && rateByDate[dateISO] !== undefined
        ? { kind: "rate", rate: rateByDate[dateISO], requestedDateISO: dateISO, effectiveDates: { from: dateISO, to: dateISO }, staleness: "exact" }
        : { kind: "miss", quote: from, requestedDateISO: dateISO },
  };
  const eur = [{ type: "savings", balance: 100, currency: "EUR" }];
  check("valuation date: explicit January date converts at January's rate",
    classifyAccounts(eur, datedCtx, jan).totalSavings === 125);
  check("valuation date: explicit June date converts at June's rate",
    classifyAccounts(eur, datedCtx, jun).totalSavings === 150);
  check("valuation date: default (latest close) misses the fixture → native + estimated",
    classifyAccounts(eur, datedCtx).totalSavings === 100 && classifyAccounts(eur, datedCtx).estimated === true);
}

// ── AI accounts-section composition rows (pure-USD, byte-identical) ──────────

{
  const assemblerRows: ClassifiableAccount[] = [
    { type: "checking",   balance: 1500.25, currency: "USD", syncStatus: undefined },
    { type: "investment", balance: 80000,   currency: "USD", syncStatus: "ok" },
    { type: "debt",       balance: 4321,    currency: "USD", syncStatus: "error" },
  ];
  check("assembler rows: byte-identical (pure-USD)",
    JSON.stringify(classifyAccounts(assemblerRows)) === JSON.stringify(classifyAccounts(assemblerRows, CTX)));
}

// ── randomized properties ─────────────────────────────────────────────────────

{
  const types = ["checking", "savings", "investment", "crypto", "other", "debt", "weird"];
  const currencies: (string | null | undefined)[] = ["USD", "EUR", "GBP", "SAR", null, undefined];
  let rng = 424242;
  const rand = () => (rng = (rng * 1103515245 + 12345) % 2147483648) / 2147483648;

  let usdByteEqual = true, mixedNumericEqual = true;
  for (let i = 0; i < 200; i++) {
    const n = Math.floor(rand() * 12);
    const mixedFixture: ClassifiableAccount[] = Array.from({ length: n }, () => ({
      type:     types[Math.floor(rand() * types.length)],
      balance:  Math.round((rand() * 200000 - 20000) * 100) / 100,
      currency: currencies[Math.floor(rand() * currencies.length)],
    }));
    const usdFixture = mixedFixture.map((a) => ({ ...a, currency: "USD" }));
    if (JSON.stringify(classifyAccounts(usdFixture)) !== JSON.stringify(classifyAccounts(usdFixture, CTX))) {
      usdByteEqual = false; break;
    }
    if (JSON.stringify(totals(classifyAccounts(mixedFixture))) !==
        JSON.stringify(totals(classifyAccounts(mixedFixture, CTX)))) {
      mixedNumericEqual = false; break;
    }
  }
  check("random: 200 pure-USD fixtures byte-identical", usdByteEqual);
  check("random: 200 mixed fixtures numerically identical under identity", mixedNumericEqual);
}

// ── Report ────────────────────────────────────────────────────────────────────
if (failures.length > 0) {
  console.error(`\nMC1 P3 classifier equivalence gates: ${failures.length} FAILURE(S) (${passed} checks passed):`);
  for (const f of failures) console.error("  " + f);
  process.exit(1);
}
console.log(`MC1 P3 classifier equivalence gates: all ${passed} checks passed.`);
process.exit(0);
