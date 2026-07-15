/**
 * lib/investments/current-positions-core.test.ts
 *
 * P2-3 — pure current-position assembly + read-strategy helper. Standalone tsx:
 *
 *     npx tsx lib/investments/current-positions-core.test.ts
 *
 * Pins:
 *   1. latestObservationsPerPair keeps exactly the max-date row(s) per pair.
 *   2. assembleCurrentPositions.rows/portfolio are BYTE-IDENTICAL to A10's
 *      holdings/portfolio for the SAME valuation view (parity by shared builders)
 *      — the only difference is the additive `costBasis`.
 *   3. cash, FX conversion, unvalued rows, and canonical instrument identity all
 *      pass through from the valuation view unchanged (no second math).
 */

import {
  latestObservationsPerPair,
  assembleCurrentPositions,
} from "./current-positions-core";
import {
  assembleInvestmentsTimeMachine,
  type InstrumentDisplay,
} from "./investments-time-machine-core";
import { valueInstrumentAsOf, valuePortfolioAsOf } from "./valuation-core";
import { vInput, observedPrice, priceMiss, identityFxCtx, walkedBackFxCtx } from "./valuation.fixtures";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const approx = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps;

const ASOF = "2026-06-05";
const USD = identityFxCtx("USD");
const FX = walkedBackFxCtx("USD", 1.1); // EUR → USD at 1.1, walked-back ⇒ estimated

// ── 1. latestObservationsPerPair ────────────────────────────────────────────
console.log("1. latestObservationsPerPair — max-date row(s) per pair");
{
  const rows = [
    { financialAccountId: "a1", instrumentId: "i1", date: "2026-01-01", tag: "old" },
    { financialAccountId: "a1", instrumentId: "i1", date: "2026-06-01", tag: "latest" },
    { financialAccountId: "a1", instrumentId: "i1", date: "2026-03-01", tag: "mid" },
    { financialAccountId: "a2", instrumentId: "i1", date: "2026-05-01", tag: "a2-latest" },
    { financialAccountId: "a2", instrumentId: "i1", date: "2026-02-01", tag: "a2-old" },
  ];
  const latest = latestObservationsPerPair(rows);
  check("keeps one row per pair at its own max date",
    latest.length === 2 &&
    latest.some((r) => r.tag === "latest") && latest.some((r) => r.tag === "a2-latest"));
  check("multiple accounts holding the SAME instrument resolve independently",
    latest.find((r) => r.financialAccountId === "a1")!.date === "2026-06-01" &&
    latest.find((r) => r.financialAccountId === "a2")!.date === "2026-05-01");
}
{
  // Same max date, two origins/sources — BOTH kept so the downstream origin
  // tiebreak resolves them exactly as the full-window read would.
  const rows = [
    { financialAccountId: "a1", instrumentId: "i1", date: "2026-06-01", origin: "DERIVED" },
    { financialAccountId: "a1", instrumentId: "i1", date: "2026-06-01", origin: "OBSERVED" },
    { financialAccountId: "a1", instrumentId: "i1", date: "2026-05-01", origin: "OBSERVED" },
  ];
  const latest = latestObservationsPerPair(rows);
  check("same-date multi-origin rows are all retained", latest.length === 2 &&
    latest.every((r) => r.date === "2026-06-01"));
}

// ── 2 & 3. assembleCurrentPositions parity with A10 + pass-through semantics ──
console.log("2. assembleCurrentPositions ≈ A10 holdings/portfolio (shared builders)");

const cEquity = valueInstrumentAsOf(
  vInput({ instrumentId: "i1", accountId: "a1", quantity: 10, price: observedPrice(200) }), ASOF, USD); // 2000 USD
const cCash = valueInstrumentAsOf(
  vInput({ instrumentId: "iCash", accountId: "a1", quantity: 1500, isCash: true, price: null }), ASOF, USD); // 1500 cash
const cFx = valueInstrumentAsOf(
  vInput({ instrumentId: "iEur", accountId: "a1", quantity: 5, nativeCurrency: "EUR", price: observedPrice(100, { currency: "EUR" }) }), ASOF, FX); // 500 EUR × 1.1 = 550 USD
const cMiss = valueInstrumentAsOf(
  vInput({ instrumentId: "iMiss", accountId: "a1", quantity: 3, price: priceMiss() }), ASOF, USD); // unvalued

const view = valuePortfolioAsOf([cEquity, cCash, cFx, cMiss], ASOF, "USD");

const display: Record<string, InstrumentDisplay> = {
  i1:    { symbol: "AAA",  name: "Alpha",     assetClass: "EQUITY", sector: "Technology", isCash: false },
  iCash: { symbol: "CASH", name: "Cash",      assetClass: "CASH",   sector: null,          isCash: true  },
  iEur:  { symbol: "EUF",  name: "Euro Fund", assetClass: "EQUITY", sector: null,          isCash: false },
  // iMiss intentionally absent → UNKNOWN identity fallback.
};

const costBasisByPair: Record<string, number | null> = {
  "a1|i1":    1800,
  "a1|iCash": null,
  "a1|iEur":  400,
  "a1|iMiss": 250,
};

const current = assembleCurrentPositions({ asOf: ASOF, view, display, costBasisByPair });
const a10 = assembleInvestmentsTimeMachine({ asOf: ASOF, compareTo: null, view, compareView: null, flows: null, display });

// Parity: strip the additive costBasis and compare byte-for-byte with A10 holdings.
const strippedRows = current.rows.map(({ costBasis, ...rest }) => { void costBasis; return rest; });
check("rows (minus costBasis) are byte-identical to A10 holdings",
  JSON.stringify(strippedRows) === JSON.stringify(a10.holdings),
  "current.rows diverged from A10.holdings");
check("portfolio is byte-identical to A10 portfolio",
  JSON.stringify(current.portfolio) === JSON.stringify(a10.portfolio));
check("reportingCurrency + asOf surfaced", current.reportingCurrency === "USD" && current.asOf === ASOF);

console.log("3. pass-through semantics (cost basis / cash / FX / unvalued / identity)");
const byId = (id: string) => current.rows.find((r) => r.instrumentId === id)!;

check("costBasis additive per resolved pair", byId("i1").costBasis === 1800 && byId("iMiss").costBasis === 250);
check("cash row: value = balance, basis cash", approx(byId("iCash").reportingValue!, 1500) && byId("iCash").basisUsed === "cash" && byId("iCash").isCash === true);
check("FX row: native 500 EUR → 550 USD, fxTier estimated",
  approx(byId("iEur").nativeValue!, 500) && approx(byId("iEur").reportingValue!, 550) && byId("iEur").fxTier === "estimated");
check("unvalued row retained with null value + null share",
  byId("iMiss").reportingValue === null && byId("iMiss").share === null);
check("unvalued row listed in portfolio.unvalued", current.portfolio.unvalued.some((u) => u.instrumentId === "iMiss"));
check("canonical instrument identity from display", byId("i1").symbol === "AAA" && byId("i1").name === "Alpha");
check("absent display → honest UNKNOWN identity", byId("iMiss").symbol === null && byId("iMiss").assetClass === "UNKNOWN");
check("valued subtotal = 2000 + 1500 + 550 = 4050", approx(current.portfolio.valuedSubtotal, 4050));

// ── Exit ────────────────────────────────────────────────────────────────────
if (failures > 0) { console.error(`\n${failures} check(s) failed.`); process.exit(1); }
console.log("\nAll current-positions-core checks passed.");
