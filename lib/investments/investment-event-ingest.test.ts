/**
 * lib/investments/investment-event-ingest.test.ts
 *
 * Pure tests for the A3-3 ingestion core (window, restatement detection, stable
 * ordering, kill switch). Standalone tsx, no DB/network. The paginated fetch,
 * account mapping, instrument resolution, and append+supersede persistence are
 * exercised by the real-data validation.
 *
 *     npx tsx lib/investments/investment-event-ingest.test.ts
 */

import type { InvestmentTransaction } from "plaid";
import {
  computeIngestWindow,
  isMaterialInvestmentEventChange,
  sortInvestmentTransactions,
  investmentEventsEnabled,
  type StoredEventForCompare,
} from "./investment-event-ingest";
import type { MappedInvestmentEvent } from "./plaid-investment-events";
import { InvestmentEventType } from "@prisma/client";

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}`); }
}

console.log("computeIngestWindow — 24-month window ending today");
{
  const w = computeIngestWindow(new Date("2026-07-11T09:30:00Z"));
  check("end = today", w.end === "2026-07-11");
  check("start = today − 24 months", w.start === "2024-07-11");
  const leap = computeIngestWindow(new Date("2026-02-28T00:00:00Z"));
  check("handles month arithmetic", leap.start === "2024-02-28" && leap.end === "2026-02-28");
}

function mapped(p: Partial<MappedInvestmentEvent>): MappedInvestmentEvent {
  return {
    type: p.type ?? InvestmentEventType.BUY, date: p.date ?? new Date("2026-04-15T00:00:00Z"),
    datetime: null, quantity: p.quantity ?? 10, price: p.price ?? 150, amount: p.amount ?? -1500,
    fees: p.fees ?? 0, currency: p.currency ?? "USD", source: "plaid", externalEventId: p.externalEventId ?? "itx_1",
    providerType: p.providerType ?? "buy", providerSubtype: p.providerSubtype ?? "buy",
    providerSecurityId: p.providerSecurityId ?? "sec_1", description: p.description ?? "APPLE", mapperVersion: 1,
  };
}
function stored(p: Partial<StoredEventForCompare>): StoredEventForCompare {
  return {
    type: p.type ?? "BUY", date: p.date ?? new Date("2026-04-15T00:00:00Z"),
    quantity: p.quantity ?? 10, price: p.price ?? 150, amount: p.amount ?? -1500, fees: p.fees ?? 0,
    currency: p.currency ?? "USD", providerType: p.providerType ?? "buy", providerSubtype: p.providerSubtype ?? "buy",
    providerSecurityId: p.providerSecurityId ?? "sec_1", description: p.description ?? "APPLE",
  };
}

console.log("isMaterialInvestmentEventChange — restatement detection");
check("identical row → not material (idempotent re-fetch)", isMaterialInvestmentEventChange(stored({}), mapped({})) === false);
check("changed amount → material (restatement)", isMaterialInvestmentEventChange(stored({ amount: -1500 }), mapped({ amount: -1600 })) === true);
check("changed quantity → material", isMaterialInvestmentEventChange(stored({ quantity: 10 }), mapped({ quantity: 11 })) === true);
check("changed canonical type → material", isMaterialInvestmentEventChange(stored({ type: "BUY" }), mapped({ type: InvestmentEventType.SELL })) === true);
check("changed date → material", isMaterialInvestmentEventChange(stored({ date: new Date("2026-04-15T00:00:00Z") }), mapped({ date: new Date("2026-04-16T00:00:00Z") })) === true);
check("changed raw subtype → material", isMaterialInvestmentEventChange(stored({ providerSubtype: "buy" }), mapped({ providerSubtype: "buy to cover" })) === true);
check("date compared date-only (time drift not material)", isMaterialInvestmentEventChange(stored({ date: new Date("2026-04-15T00:00:00Z") }), mapped({ date: new Date("2026-04-15T18:00:00Z") })) === false);
check("null↔value fees change → material", isMaterialInvestmentEventChange(stored({ fees: 0 }), mapped({ fees: 2.5 })) === true);

console.log("sortInvestmentTransactions — deterministic total order (date, id)");
{
  const t = (id: string, date: string): InvestmentTransaction => ({ investment_transaction_id: id, date } as InvestmentTransaction);
  const sorted = sortInvestmentTransactions([t("b", "2026-02-01"), t("a", "2026-01-01"), t("a", "2026-02-01")]);
  check("sorted by date then id", sorted.map((x) => `${x.date}:${x.investment_transaction_id}`).join("|") === "2026-01-01:a|2026-02-01:a|2026-02-01:b");
  const again = sortInvestmentTransactions([t("b", "2026-02-01"), t("a", "2026-01-01"), t("a", "2026-02-01")]);
  check("deterministic (stable across runs)", JSON.stringify(sorted) === JSON.stringify(again));
}

console.log("kill switch");
{
  const prev = process.env.INVESTMENT_EVENTS_ENABLED;
  delete process.env.INVESTMENT_EVENTS_ENABLED;
  check("absent → disabled", investmentEventsEnabled() === false);
  process.env.INVESTMENT_EVENTS_ENABLED = "false";
  check("false → disabled", investmentEventsEnabled() === false);
  process.env.INVESTMENT_EVENTS_ENABLED = "true";
  check("true → enabled", investmentEventsEnabled() === true);
  if (prev === undefined) delete process.env.INVESTMENT_EVENTS_ENABLED; else process.env.INVESTMENT_EVENTS_ENABLED = prev;
}

if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nAll investment-event-ingest checks passed");
