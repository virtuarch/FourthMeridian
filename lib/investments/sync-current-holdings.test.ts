/**
 * lib/investments/sync-current-holdings.test.ts
 *
 * Pure tests for the A2 current-Holding sync core. Standalone tsx, no DB. The
 * transactional apply + per-account scoping (same symbol in different accounts)
 * are covered by the real-data validation; here we pin the diff doctrine and
 * the byte-identical row mapping that keeps the Investments UI unchanged.
 *
 *     npx tsx lib/investments/sync-current-holdings.test.ts
 */

import type { Holding as PlaidHolding, Security } from "plaid";
import {
  isHoldingEligible,
  mapPlaidHoldingToRow,
  planHoldingSync,
  type TargetRow,
  type ExistingRow,
} from "./sync-current-holdings";

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}`); }
}

function sec(p: Partial<Security>): Security {
  return {
    security_id: p.security_id ?? "s1", isin: null, cusip: null, sedol: null,
    institution_security_id: null, institution_id: null, proxy_security_id: null,
    name: p.name ?? "Thing", ticker_symbol: p.ticker_symbol ?? null,
    is_cash_equivalent: p.is_cash_equivalent ?? false, type: p.type ?? "equity", subtype: null,
    close_price: p.close_price ?? null, close_price_as_of: null,
    iso_currency_code: p.iso_currency_code ?? "USD", unofficial_currency_code: null,
    market_identifier_code: null, sector: null, industry: null, cfi_code: null,
    option_contract: null, fixed_income: null,
  } as Security;
}
// institution_value is typed non-null in the SDK but is null at runtime when
// Plaid omits it (the mapping's qty×price fallback exists for exactly that) —
// widen the helper param so the fallback path is testable.
function hld(p: Partial<Omit<PlaidHolding, "institution_value">> & { institution_value?: number | null }): PlaidHolding {
  return {
    account_id: "a1", security_id: p.security_id ?? "s1",
    institution_price: p.institution_price ?? 10, institution_price_as_of: null, institution_price_datetime: null,
    institution_value: p.institution_value === undefined ? 50 : p.institution_value, cost_basis: null, quantity: p.quantity ?? 5,
    iso_currency_code: p.iso_currency_code ?? "USD", unofficial_currency_code: null,
    vested_quantity: null, vested_value: null,
  } as PlaidHolding;
}
function row(p: Partial<TargetRow>): TargetRow {
  return { symbol: p.symbol ?? "AAPL", name: p.name ?? "Apple", quantity: p.quantity ?? 5,
    price: p.price ?? 10, value: p.value ?? 50, change24h: p.change24h ?? 0, currency: p.currency ?? "USD" };
}
function existing(p: Partial<ExistingRow>): ExistingRow {
  return { id: p.id ?? "id1", ...row(p) };
}

console.log("isHoldingEligible — cash/no-ticker excluded from Holding projection");
check("equity with ticker → eligible", isHoldingEligible(sec({ ticker_symbol: "AAPL", type: "equity" })));
check("cash type → not eligible", !isHoldingEligible(sec({ ticker_symbol: "CUR:USD", type: "cash", is_cash_equivalent: true })));
check("no ticker → not eligible", !isHoldingEligible(sec({ ticker_symbol: null, type: "fixed income" })));
check("missing security → not eligible", !isHoldingEligible(undefined));

console.log("mapPlaidHoldingToRow — byte-identical mapping (UI unchanged)");
{
  const r = mapPlaidHoldingToRow(hld({ quantity: 20, institution_price: 77.03, institution_value: 1540.6 }), sec({ ticker_symbol: "TQQQ", name: "ProShares", close_price: 77.03 }), "USD");
  check("symbol/name/qty/price/value", r.symbol === "TQQQ" && r.name === "ProShares" && r.quantity === 20 && r.price === 77.03 && r.value === 1540.6);
  check("change24h from close_price (0 when equal)", r.change24h === 0);
  const r2 = mapPlaidHoldingToRow(hld({ institution_price: 110, institution_value: null, quantity: 2 }), sec({ ticker_symbol: "X", close_price: 100 }), "USD");
  check("value falls back to qty×price", r2.value === 220);
  check("change24h computed", r2.change24h === 10);
  // Explicit nulls on both holding + security so the account-currency fallback
  // is reached (the helpers otherwise coerce null → "USD").
  const r3 = mapPlaidHoldingToRow(
    { ...hld({}), iso_currency_code: null } as PlaidHolding,
    { ...sec({ ticker_symbol: "X" }), iso_currency_code: null } as Security,
    "CAD",
  );
  check("currency falls back to account currency", r3.currency === "CAD");
}

console.log("planHoldingSync — insert / update-in-place / unchanged / remove");
{
  const existingRows = [ existing({ id: "keep", symbol: "AAPL", value: 50 }), existing({ id: "stale", symbol: "OLD", value: 10 }) ];
  const current = [ row({ symbol: "AAPL", value: 60 }), row({ symbol: "NEW", value: 30 }) ];
  const plan = planHoldingSync({ current, existing: existingRows, removeStale: true });
  check("new symbol inserted", plan.insert.length === 1 && plan.insert[0].symbol === "NEW");
  check("existing symbol updated IN PLACE (id preserved)", plan.update.length === 1 && plan.update[0].id === "keep" && plan.update[0].row.value === 60);
  check("stale symbol removed", plan.deleteIds.length === 1 && plan.deleteIds[0] === "stale");
}

console.log("unchanged holding is stable (no write, id preserved)");
{
  const existingRows = [ existing({ id: "keep", symbol: "AAPL", value: 50, quantity: 5, price: 10, change24h: 0, name: "Apple", currency: "USD" }) ];
  const current = [ row({ symbol: "AAPL", value: 50, quantity: 5, price: 10, change24h: 0, name: "Apple", currency: "USD" }) ];
  const plan = planHoldingSync({ current, existing: existingRows, removeStale: true });
  check("identical row → unchanged (not update/insert)", plan.unchanged.length === 1 && plan.update.length === 0 && plan.insert.length === 0);
  check("nothing removed", plan.deleteIds.length === 0);
}

console.log("idempotency — re-running the same payload yields all-unchanged, no id churn");
{
  const existingRows = [ existing({ id: "a", symbol: "AAPL" }), existing({ id: "b", symbol: "VOO" }) ];
  const current = [ row({ symbol: "AAPL" }), row({ symbol: "VOO" }) ];
  const plan = planHoldingSync({ current, existing: existingRows, removeStale: true });
  check("all unchanged, zero insert/update/delete", plan.unchanged.length === 2 && plan.insert.length === 0 && plan.update.length === 0 && plan.deleteIds.length === 0);
}

console.log("incomplete payload removes nothing");
{
  const existingRows = [ existing({ id: "keep", symbol: "AAPL" }), existing({ id: "notreturned", symbol: "MSFT" }) ];
  const current = [ row({ symbol: "AAPL" }) ]; // MSFT absent
  const complete = planHoldingSync({ current, existing: existingRows, removeStale: true });
  const partial  = planHoldingSync({ current, existing: existingRows, removeStale: false });
  check("complete payload removes the absent symbol", complete.deleteIds.length === 1);
  check("incomplete payload removes NOTHING", partial.deleteIds.length === 0);
}

console.log("duplicate symbol in one payload → conflict (keep first, skip extra)");
{
  const plan = planHoldingSync({ current: [ row({ symbol: "AAPL", value: 50 }), row({ symbol: "AAPL", value: 99 }) ], existing: [], removeStale: true });
  check("one insert, one conflict", plan.insert.length === 1 && plan.conflicts.length === 1 && plan.conflicts[0] === "AAPL");
}

console.log("same symbol in different accounts stays separate (per-account plan)");
{
  // Each account is a separate plan call with its own existing set; a symbol
  // present in account A's existing does not affect account B's plan.
  const planA = planHoldingSync({ current: [ row({ symbol: "BTC", value: 999 }) ], existing: [ existing({ id: "A-btc", symbol: "BTC", value: 100 }) ], removeStale: true });
  const planB = planHoldingSync({ current: [ row({ symbol: "BTC" }) ], existing: [], removeStale: true });
  check("account A reuses its own BTC row in place (no insert)", planA.insert.length === 0 && planA.update.length === 1 && planA.update[0].id === "A-btc");
  check("account B inserts its own BTC row (independent)", planB.insert.length === 1 && planB.update.length === 0);
}

if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nAll sync-current-holdings checks passed");
