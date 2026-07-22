/**
 * lib/investments/instrument-resolver.test.ts
 *
 * Pure tests for the Instrument identity core (Slice A1). Standalone tsx, no DB
 * — exercises the precedence engine, conflict detection, asset-class mapping,
 * and raw-metadata preservation. The DB-binding wrapper is a thin adapter over
 * these; its query wiring is covered by the real-data validation.
 *
 *     npx tsx lib/investments/instrument-resolver.test.ts
 */

import type { Security } from "plaid";
import { AssetClass } from "@prisma/client";
import {
  deriveAssetClass,
  mapPlaidSecurityToInstrument,
  strongIdsConflict,
  decideResolution,
} from "./instrument-resolver";

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}`); }
}

function sec(p: Partial<Security>): Security {
  return {
    security_id: p.security_id ?? "sec1",
    isin: p.isin ?? null, cusip: p.cusip ?? null, sedol: p.sedol ?? null,
    institution_security_id: p.institution_security_id ?? null,
    institution_id: null, proxy_security_id: p.proxy_security_id ?? null,
    name: p.name ?? "Thing", ticker_symbol: p.ticker_symbol ?? null,
    is_cash_equivalent: p.is_cash_equivalent ?? false, type: p.type ?? "equity",
    subtype: p.subtype ?? null, close_price: null, close_price_as_of: null,
    iso_currency_code: p.iso_currency_code ?? "USD", unofficial_currency_code: null,
    market_identifier_code: p.market_identifier_code ?? null,
    sector: p.sector ?? null, industry: p.industry ?? null, cfi_code: p.cfi_code ?? null,
    option_contract: p.option_contract ?? null, fixed_income: p.fixed_income ?? null,
  } as Security;
}

console.log("deriveAssetClass");
check("cash type → CASH", deriveAssetClass(sec({ type: "cash" })) === AssetClass.CASH);
check("is_cash_equivalent → CASH", deriveAssetClass(sec({ type: "equity", is_cash_equivalent: true })) === AssetClass.CASH);
check("etf → ETF", deriveAssetClass(sec({ type: "etf" })) === AssetClass.ETF);
check("mutual fund → MUTUAL_FUND", deriveAssetClass(sec({ type: "mutual fund" })) === AssetClass.MUTUAL_FUND);
check("fixed income → FIXED_INCOME", deriveAssetClass(sec({ type: "fixed income" })) === AssetClass.FIXED_INCOME);
check("derivative → OPTION", deriveAssetClass(sec({ type: "derivative" })) === AssetClass.OPTION);
check("cryptocurrency → CRYPTO", deriveAssetClass(sec({ type: "cryptocurrency" })) === AssetClass.CRYPTO);
check("equity → EQUITY", deriveAssetClass(sec({ type: "equity" })) === AssetClass.EQUITY);
check("unknown/other type → OTHER", deriveAssetClass(sec({ type: "loan" })) === AssetClass.OTHER);

console.log("mapPlaidSecurityToInstrument — raw preservation, no fabrication");
const m = mapPlaidSecurityToInstrument(sec({ ticker_symbol: "TQQQ", type: "etf", market_identifier_code: "XNAS", cusip: null, isin: null }));
check("ticker preserved", m.tickerSymbol === "TQQQ");
check("MIC preserved", m.marketIdentifierCode === "XNAS");
check("absent cusip stays null (not fabricated)", m.cusip === null);
check("absent isin stays null", m.isin === null);
check("assetClass derived", m.assetClass === AssetClass.ETF);
const noTicker = mapPlaidSecurityToInstrument(sec({ ticker_symbol: null, type: "fixed income", name: "US TREASURY 2028" }));
check("no-ticker security still maps (name preserved, ticker null)", noTicker.tickerSymbol === null && noTicker.name === "US TREASURY 2028");
const cashMap = mapPlaidSecurityToInstrument(sec({ type: "cash", is_cash_equivalent: true, ticker_symbol: "CUR:USD", name: "Cash" }));
check("cash instrument maps to CASH + isCashEquivalent", cashMap.assetClass === AssetClass.CASH && cashMap.isCashEquivalent === true);

console.log("strongIdsConflict");
check("same cusip → no conflict", strongIdsConflict(sec({ cusip: "A" }), { cusip: "A", isin: null, sedol: null }) === false);
check("different cusip → conflict", strongIdsConflict(sec({ cusip: "A" }), { cusip: "B", isin: null, sedol: null }) === true);
check("one side null → no conflict", strongIdsConflict(sec({ cusip: "A" }), { cusip: null, isin: null, sedol: null }) === false);
check("different isin → conflict", strongIdsConflict(sec({ isin: "X" }), { cusip: null, isin: "Y", sedol: null }) === true);

console.log("decideResolution — precedence");
check("provider alias hit → use (no re-alias)",
  JSON.stringify(decideResolution({ aliasInstrumentId: "i1", strongMatchInstrumentIds: [], strongConflict: false, weakMatchInstrumentId: null })) ===
  JSON.stringify({ action: "use", instrumentId: "i1", attachAlias: false, aliasBootstrap: false }));
check("single strong (CUSIP/ISIN/SEDOL) hit → use + attach alias",
  (() => { const d = decideResolution({ aliasInstrumentId: null, strongMatchInstrumentIds: ["i2"], strongConflict: false, weakMatchInstrumentId: null }); return d.action === "use" && d.instrumentId === "i2" && d.attachAlias === true; })());
check("two different strong matches → conflict (refuse merge)",
  decideResolution({ aliasInstrumentId: null, strongMatchInstrumentIds: ["i2", "i3"], strongConflict: false, weakMatchInstrumentId: null }).action === "conflict");
check("single strong match but disagreeing strong id → conflict",
  decideResolution({ aliasInstrumentId: null, strongMatchInstrumentIds: ["i2"], strongConflict: true, weakMatchInstrumentId: null }).action === "conflict");
check("weak ticker+MIC fallback → use + bootstrap alias",
  (() => { const d = decideResolution({ aliasInstrumentId: null, strongMatchInstrumentIds: [], strongConflict: false, weakMatchInstrumentId: "i4" }); return d.action === "use" && d.attachAlias === true && d.aliasBootstrap === true; })());
check("nothing matches → create",
  decideResolution({ aliasInstrumentId: null, strongMatchInstrumentIds: [], strongConflict: false, weakMatchInstrumentId: null }).action === "create");
check("deterministic repeat — identical inputs, identical decision",
  JSON.stringify(decideResolution({ aliasInstrumentId: "iX", strongMatchInstrumentIds: ["a"], strongConflict: false, weakMatchInstrumentId: "b" })) ===
  JSON.stringify(decideResolution({ aliasInstrumentId: "iX", strongMatchInstrumentIds: ["a"], strongConflict: false, weakMatchInstrumentId: "b" })));
check("alias wins over strong+weak (precedence order)",
  decideResolution({ aliasInstrumentId: "iA", strongMatchInstrumentIds: ["iS"], strongConflict: false, weakMatchInstrumentId: "iW" }).action === "use");

if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nAll instrument-resolver checks passed");
