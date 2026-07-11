/**
 * lib/investments/position-capture.test.ts
 *
 * Pure tests for the position-capture core (Slice A1). Standalone tsx, no DB.
 * Covers the raw-field mapping (cash, no-ticker, cost basis, price-as-of,
 * currency fallback), disappearance computation, date parsing, and the kill
 * switch. The DB upsert/idempotency + disappearance-write are exercised by the
 * real-data validation.
 *
 *     npx tsx lib/investments/position-capture.test.ts
 */

import type { Holding as PlaidHolding, Security } from "plaid";
import {
  mapHoldingToObservedFacts,
  isCashSecurity,
  parsePlaidDate,
  computeDisappearedInstrumentIds,
  investmentObservationsEnabled,
} from "./position-capture";

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}`); }
}

function sec(p: Partial<Security>): Security {
  return {
    security_id: p.security_id ?? "sec1", isin: null, cusip: null, sedol: null,
    institution_security_id: null, institution_id: null, proxy_security_id: null,
    name: p.name ?? "Thing", ticker_symbol: p.ticker_symbol ?? null,
    is_cash_equivalent: p.is_cash_equivalent ?? false, type: p.type ?? "equity",
    subtype: null, close_price: null, close_price_as_of: null,
    iso_currency_code: p.iso_currency_code ?? "USD", unofficial_currency_code: p.unofficial_currency_code ?? null,
    market_identifier_code: null, sector: null, industry: null, cfi_code: null,
    option_contract: null, fixed_income: null,
  } as Security;
}
function hld(p: Partial<PlaidHolding>): PlaidHolding {
  return {
    account_id: p.account_id ?? "acct1", security_id: p.security_id ?? "sec1",
    institution_price: p.institution_price ?? 10, institution_price_as_of: p.institution_price_as_of ?? null,
    institution_price_datetime: null, institution_value: p.institution_value ?? 100,
    cost_basis: p.cost_basis ?? null, quantity: p.quantity ?? 10,
    // Preserve explicit null (distinct from "not provided") so the currency
    // fallback chain is testable.
    iso_currency_code: "iso_currency_code" in p ? p.iso_currency_code! : "USD",
    unofficial_currency_code: p.unofficial_currency_code ?? null,
    vested_quantity: p.vested_quantity ?? null, vested_value: p.vested_value ?? null,
  } as PlaidHolding;
}

console.log("parsePlaidDate");
check("date-only string parses to UTC", parsePlaidDate("2026-07-10")?.toISOString() === "2026-07-10T00:00:00.000Z");
check("null → null", parsePlaidDate(null) === null);
check("garbage → null", parsePlaidDate("not-a-date") === null);

console.log("isCashSecurity");
check("type cash → true", isCashSecurity(sec({ type: "cash" })) === true);
check("is_cash_equivalent → true", isCashSecurity(sec({ type: "equity", is_cash_equivalent: true })) === true);
check("equity → false", isCashSecurity(sec({ type: "equity" })) === false);

console.log("mapHoldingToObservedFacts — preserve every provided field, fabricate none");
const f = mapHoldingToObservedFacts(
  hld({ quantity: 20, institution_price: 77.03, institution_value: 1540.6, cost_basis: 424, institution_price_as_of: "2026-07-10" }),
  sec({ ticker_symbol: "TQQQ", type: "etf" }),
);
check("quantity preserved", f.quantity === 20);
check("institution price preserved", f.institutionPrice === 77.03);
check("institution value preserved", f.institutionValue === 1540.6);
check("cost basis preserved (the field FM discards today)", f.costBasis === 424);
check("price-as-of parsed", f.institutionPriceAsOf?.toISOString() === "2026-07-10T00:00:00.000Z");
check("currency resolved", f.currency === "USD");
check("not cash", f.isCash === false);

const cashFacts = mapHoldingToObservedFacts(
  hld({ quantity: 11.65, institution_price: 1, institution_value: 11.65, cost_basis: null }),
  sec({ ticker_symbol: "CUR:USD", type: "cash", is_cash_equivalent: true, name: "Cash" }),
);
check("cash holding captured (isCash true)", cashFacts.isCash === true && cashFacts.quantity === 11.65);
check("cash cost basis null preserved (not fabricated)", cashFacts.costBasis === null);

const noTicker = mapHoldingToObservedFacts(hld({ quantity: 3 }), sec({ ticker_symbol: null, type: "fixed income" }));
check("no-ticker holding still produces facts", noTicker.quantity === 3);

const missingCost = mapHoldingToObservedFacts(hld({ cost_basis: null, vested_quantity: null }), sec({}));
check("missing cost basis stays null", missingCost.costBasis === null);
check("missing vested stays null", missingCost.vestedQuantity === null);

const fxFallback = mapHoldingToObservedFacts(
  hld({ iso_currency_code: null, unofficial_currency_code: null }),
  sec({ iso_currency_code: "EUR" }),
);
check("currency falls back to security when holding lacks it", fxFallback.currency === "EUR");

console.log("computeDisappearedInstrumentIds");
check("instrument present before, absent now → disappeared",
  JSON.stringify(computeDisappearedInstrumentIds(["a", "b", "c"], ["a", "c"])) === JSON.stringify(["b"]));
check("all still present → none disappeared",
  computeDisappearedInstrumentIds(["a", "b"], ["a", "b"]).length === 0);
check("brand-new instrument does not count as disappeared",
  computeDisappearedInstrumentIds(["a"], ["a", "z"]).length === 0);

console.log("kill switch");
const prev = process.env.INVESTMENT_OBSERVATIONS_ENABLED;
delete process.env.INVESTMENT_OBSERVATIONS_ENABLED;
check("absent → disabled", investmentObservationsEnabled() === false);
process.env.INVESTMENT_OBSERVATIONS_ENABLED = "false";
check("false → disabled", investmentObservationsEnabled() === false);
process.env.INVESTMENT_OBSERVATIONS_ENABLED = "true";
check("true → enabled", investmentObservationsEnabled() === true);
if (prev === undefined) delete process.env.INVESTMENT_OBSERVATIONS_ENABLED; else process.env.INVESTMENT_OBSERVATIONS_ENABLED = prev;

if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nAll position-capture checks passed");
