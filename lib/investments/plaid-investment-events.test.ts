/**
 * lib/investments/plaid-investment-events.test.ts
 *
 * Exhaustive tests for the pure Plaid investment-event mapper (A3-2). Standalone
 * tsx, no DB. Proves totality (every SDK subtype + all 6 types map to a
 * canonical type — none silently UNKNOWN), sign/fee/currency normalization, raw
 * preservation, null preservation, unknown-future handling, and determinism.
 *
 *     npx tsx lib/investments/plaid-investment-events.test.ts
 */

import { InvestmentTransactionSubtype, InvestmentTransactionType, type InvestmentTransaction } from "plaid";
import { InvestmentEventType } from "@prisma/client";
import {
  classifyInvestmentEventType,
  mapPlaidInvestmentTransactionToEvent,
  MAPPER_VERSION,
} from "./plaid-investment-events";

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}`); }
}

function txn(p: Partial<InvestmentTransaction>): InvestmentTransaction {
  return {
    investment_transaction_id: p.investment_transaction_id ?? "itx_1",
    cancel_transaction_id: p.cancel_transaction_id ?? null,
    account_id: p.account_id ?? "acct_1",
    security_id: p.security_id === undefined ? "sec_1" : p.security_id,
    date: p.date ?? "2026-07-01",
    transaction_datetime: p.transaction_datetime ?? null,
    name: p.name ?? "RAW DESC",
    quantity: p.quantity ?? 0,
    amount: p.amount ?? 0,
    price: p.price ?? 0,
    fees: p.fees === undefined ? null : p.fees,
    type: p.type ?? InvestmentTransactionType.Cash,
    subtype: p.subtype ?? InvestmentTransactionSubtype.Dividend,
    iso_currency_code: p.iso_currency_code === undefined ? "USD" : p.iso_currency_code,
    unofficial_currency_code: p.unofficial_currency_code ?? null,
  } as InvestmentTransaction;
}

console.log("totality — every SDK subtype maps to a NON-UNKNOWN canonical type");
{
  const subtypes = Object.values(InvestmentTransactionSubtype);
  check(`SDK exposes 48 subtypes (got ${subtypes.length})`, subtypes.length === 48);
  let allMapped = true;
  for (const st of subtypes) {
    const t = classifyInvestmentEventType({ type: "cash", subtype: st, quantity: 1, amountFm: 1, hasSecurity: true });
    if (t === InvestmentEventType.UNKNOWN) { allMapped = false; console.error(`    ✗ subtype "${st}" → UNKNOWN`); }
  }
  check("all 48 known subtypes map to a specific canonical type (none UNKNOWN)", allMapped);
}

console.log("all six provider transaction types covered");
check("cancel type → CANCEL (any subtype)",
  classifyInvestmentEventType({ type: "cancel", subtype: "buy", quantity: 1, amountFm: 0, hasSecurity: true }) === InvestmentEventType.CANCEL);
check("buy type (buy) → BUY", classifyInvestmentEventType({ type: "buy", subtype: "buy", quantity: 1, amountFm: -1, hasSecurity: true }) === InvestmentEventType.BUY);
check("sell type (sell) → SELL", classifyInvestmentEventType({ type: "sell", subtype: "sell", quantity: -1, amountFm: 1, hasSecurity: true }) === InvestmentEventType.SELL);
check("cash type (dividend) → DIVIDEND", classifyInvestmentEventType({ type: "cash", subtype: "dividend", quantity: 0, amountFm: 1, hasSecurity: true }) === InvestmentEventType.DIVIDEND);
check("fee type (account fee) → FEE", classifyInvestmentEventType({ type: "fee", subtype: "account fee", quantity: 0, amountFm: -1, hasSecurity: false }) === InvestmentEventType.FEE);
check("transfer type (transfer) → TRANSFER_*", ([InvestmentEventType.TRANSFER_IN, InvestmentEventType.TRANSFER_OUT] as InvestmentEventType[]).includes(classifyInvestmentEventType({ type: "transfer", subtype: "transfer", quantity: 1, amountFm: 0, hasSecurity: true })));

console.log("sign-ambiguous resolution");
check("trade qty>0 → BUY", classifyInvestmentEventType({ type: "buy", subtype: "trade", quantity: 5, amountFm: -5, hasSecurity: true }) === InvestmentEventType.BUY);
check("trade qty<0 → SELL", classifyInvestmentEventType({ type: "sell", subtype: "trade", quantity: -5, amountFm: 5, hasSecurity: true }) === InvestmentEventType.SELL);
check("trade qty=0 → ADJUSTMENT", classifyInvestmentEventType({ type: "cash", subtype: "trade", quantity: 0, amountFm: 0, hasSecurity: true }) === InvestmentEventType.ADJUSTMENT);
check("contribution WITH security → BUY", classifyInvestmentEventType({ type: "buy", subtype: "contribution", quantity: 1, amountFm: -1, hasSecurity: true }) === InvestmentEventType.BUY);
check("contribution cash-only → CONTRIBUTION", classifyInvestmentEventType({ type: "cash", subtype: "contribution", quantity: 0, amountFm: 1, hasSecurity: false }) === InvestmentEventType.CONTRIBUTION);
check("in-kind transfer qty>0 → TRANSFER_IN", classifyInvestmentEventType({ type: "transfer", subtype: "transfer", quantity: 3, amountFm: 0, hasSecurity: true }) === InvestmentEventType.TRANSFER_IN);
check("in-kind transfer qty<0 → TRANSFER_OUT", classifyInvestmentEventType({ type: "transfer", subtype: "transfer", quantity: -3, amountFm: 0, hasSecurity: true }) === InvestmentEventType.TRANSFER_OUT);
check("cash-only transfer signed by FM amount (+in)", classifyInvestmentEventType({ type: "transfer", subtype: "transfer", quantity: 0, amountFm: 100, hasSecurity: false }) === InvestmentEventType.TRANSFER_IN);
check("cash-only transfer signed by FM amount (−out)", classifyInvestmentEventType({ type: "transfer", subtype: "transfer", quantity: 0, amountFm: -100, hasSecurity: false }) === InvestmentEventType.TRANSFER_OUT);

console.log("representative subtype mappings");
check("unqualified gain → CAPITAL_GAIN", classifyInvestmentEventType({ type: "cash", subtype: "unqualified gain", quantity: 0, amountFm: 1, hasSecurity: true }) === InvestmentEventType.CAPITAL_GAIN);
check("dividend reinvestment → REINVESTMENT", classifyInvestmentEventType({ type: "buy", subtype: "dividend reinvestment", quantity: 1, amountFm: 0, hasSecurity: true }) === InvestmentEventType.REINVESTMENT);
check("split → SPLIT", classifyInvestmentEventType({ type: "transfer", subtype: "split", quantity: 0, amountFm: 0, hasSecurity: true }) === InvestmentEventType.SPLIT);
check("merger → MERGER", classifyInvestmentEventType({ type: "transfer", subtype: "merger", quantity: 0, amountFm: 0, hasSecurity: true }) === InvestmentEventType.MERGER);
check("spin off → SPIN_OFF", classifyInvestmentEventType({ type: "transfer", subtype: "spin off", quantity: 0, amountFm: 0, hasSecurity: true }) === InvestmentEventType.SPIN_OFF);
check("tax withheld → TAX", classifyInvestmentEventType({ type: "cash", subtype: "tax withheld", quantity: 0, amountFm: -1, hasSecurity: false }) === InvestmentEventType.TAX);
check("pending debit → ADJUSTMENT", classifyInvestmentEventType({ type: "cash", subtype: "pending debit", quantity: 0, amountFm: -1, hasSecurity: false }) === InvestmentEventType.ADJUSTMENT);
check("expire → ADJUSTMENT", classifyInvestmentEventType({ type: "cash", subtype: "expire", quantity: 0, amountFm: 0, hasSecurity: true }) === InvestmentEventType.ADJUSTMENT);

console.log("unknown / future subtype → UNKNOWN (never throws, never drops)");
check("future subtype → UNKNOWN", classifyInvestmentEventType({ type: "cash", subtype: "quantum dividend", quantity: 0, amountFm: 0, hasSecurity: false }) === InvestmentEventType.UNKNOWN);

console.log("mapPlaidInvestmentTransactionToEvent — normalization + raw preservation");
{
  const m = mapPlaidInvestmentTransactionToEvent(txn({
    investment_transaction_id: "itx_9", security_id: "sec_9", name: "APPLE INC DIVIDEND",
    type: InvestmentTransactionType.Buy, subtype: InvestmentTransactionSubtype.Buy,
    quantity: 10, price: 150, amount: 1500, fees: -2.5, iso_currency_code: "USD", date: "2026-04-15",
  }));
  check("amount FM-signed (−plaid): +1500 debit → −1500 out", m.amount === -1500);
  check("quantity passed through (+10 in)", m.quantity === 10);
  check("fees absolute value", m.fees === 2.5);
  check("price passed through", m.price === 150);
  check("currency iso", m.currency === "USD");
  check("date parsed", m.date.toISOString() === "2026-04-15T00:00:00.000Z");
  check("source = plaid", m.source === "plaid");
  check("externalEventId = investment_transaction_id", m.externalEventId === "itx_9");
  check("providerType raw", m.providerType === "buy");
  check("providerSubtype raw", m.providerSubtype === "buy");
  check("providerSecurityId raw", m.providerSecurityId === "sec_9");
  check("description = raw name", m.description === "APPLE INC DIVIDEND");
  check("mapperVersion stamped", m.mapperVersion === MAPPER_VERSION);
  check("type classified BUY", m.type === InvestmentEventType.BUY);
}

console.log("currency fallback + null/cash preservation");
{
  const unofficial = mapPlaidInvestmentTransactionToEvent(txn({ iso_currency_code: null, unofficial_currency_code: "BTC" }));
  check("currency falls back to unofficial", unofficial.currency === "BTC");
  const noCur = mapPlaidInvestmentTransactionToEvent(txn({ iso_currency_code: null, unofficial_currency_code: null }));
  check("no currency → null", noCur.currency === null);
  const cash = mapPlaidInvestmentTransactionToEvent(txn({ security_id: null, type: InvestmentTransactionType.Cash, subtype: InvestmentTransactionSubtype.Interest }));
  check("pure-cash row → quantity null (routes by currency)", cash.quantity === null);
  check("pure-cash row → providerSecurityId null", cash.providerSecurityId === null);
  check("pure-cash INTEREST classified", cash.type === InvestmentEventType.INTEREST);
  const noFee = mapPlaidInvestmentTransactionToEvent(txn({ fees: null }));
  check("null fees preserved", noFee.fees === null);
}

console.log("determinism — same input twice → identical output");
{
  const t = txn({ investment_transaction_id: "itx_det", quantity: -3, amount: 900, subtype: InvestmentTransactionSubtype.Sell, type: InvestmentTransactionType.Sell });
  check("identical mapped output", JSON.stringify(mapPlaidInvestmentTransactionToEvent(t)) === JSON.stringify(mapPlaidInvestmentTransactionToEvent(t)));
}

if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nAll plaid-investment-events checks passed");
