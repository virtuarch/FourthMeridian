/**
 * lib/investments/activity-enumeration.test.ts
 *
 * A SUMMARY MUST BE ABLE TO ENUMERATE ITSELF.
 *
 * The Activity card could say "9 sells" and never name one, and a dividend
 * total could not say which security paid it — because `FlowEvent` dropped
 * instrument and account identity at the projection step, and `PeriodFlows`
 * carried no rows at all. Counts were assertions, not evidence.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { summarizePeriodFlows, type FlowEvent } from "./investment-flows-core";
import type { InvestmentEventType } from "@prisma/client";

const checks: string[] = [];
const ok = (l: string) => checks.push(l);

const ev = (
  type: InvestmentEventType, date: string, amount: number | null,
  over: Partial<FlowEvent> = {},
): FlowEvent => ({
  type, date, amount, fxEstimated: false, hasQuantity: over.quantity != null,
  accountId: over.accountId ?? "acc-1",
  instrumentId: over.instrumentId ?? null,
  symbol: over.symbol ?? null,
  name: over.name ?? null,
  quantity: over.quantity ?? null,
});

const FROM = "2026-01-01";
const TO = "2026-03-31";

// ── counts equal their enumerated rows ────────────────────────────────────
{
  const events = [
    ev("SELL", "2026-02-10", 500, { symbol: "AMZN", quantity: 1 }),
    ev("SELL", "2026-02-11", 300, { symbol: "JPM", quantity: 2 }),
    ev("BUY",  "2026-02-12", -200, { symbol: "NVDA", quantity: 1 }),
    ev("DIVIDEND", "2026-02-13", 1.4, { symbol: "TXN" }),
  ];
  const f = summarizePeriodFlows(events, FROM, TO, "USD");

  assert.equal(f.events.length, f.eventCount, "rows === eventCount");
  const sells = f.events.filter((e) => e.type === "SELL");
  assert.equal(sells.length, 2, "the sells can be enumerated");
  assert.equal(sells.reduce((n, e) => n + (e.amount ?? 0), 0), f.sells,
    "the listed sells sum to the sell subtotal");
  const divs = f.events.filter((e) => e.type === "DIVIDEND");
  assert.equal(divs.reduce((n, e) => n + (e.amount ?? 0), 0), f.income,
    "the listed dividends sum to income");
  ok("every count and subtotal is derived from rows the card can list");
}

// ── each row carries the security that produced it ───────────────────────
{
  const f = summarizePeriodFlows([
    ev("DIVIDEND", "2026-02-13", 1.4, { symbol: "TXN", instrumentId: "i-txn" }),
  ], FROM, TO, "USD");
  const d = f.events[0];
  assert.equal(d.symbol, "TXN", "a dividend names its paying security");
  assert.equal(d.instrumentId, "i-txn");
  assert.equal(d.accountId, "acc-1", "and the account it landed in");
  ok("a dividend identifies its paying security and account");
}

// ── unknown attribution stays explicitly unknown ─────────────────────────
{
  const f = summarizePeriodFlows([
    ev("DIVIDEND", "2026-02-13", 0.03),   // provider gave no instrument
  ], FROM, TO, "USD");
  assert.equal(f.events[0].symbol, null, "no ticker is invented");
  assert.equal(f.events[0].instrumentId, null);
  assert.equal(f.income, 0.03, "…and the amount still counts");
  ok("an unattributed event stays unattributed — no fabricated ticker");
}

// ── every row falls inside the window, on the stock-attribution boundary ─
{
  const f = summarizePeriodFlows([
    ev("SELL", FROM, 100, { symbol: "OPEN" }),       // the OPENING day
    ev("SELL", "2026-02-01", 200, { symbol: "MID" }),
    ev("SELL", TO, 300, { symbol: "CLOSE" }),        // the CLOSING day
    ev("SELL", "2026-04-01", 400, { symbol: "AFTER" }),
  ], FROM, TO, "USD");

  const symbols = f.events.map((e) => e.symbol);
  // These flows explain a change between two BALANCES, so the window is
  // half-open: the opening balance already contains the opening day.
  assert.ok(!symbols.includes("OPEN"), "the opening day is excluded from stock attribution");
  assert.ok(symbols.includes("CLOSE"), "the closing day is included");
  assert.ok(!symbols.includes("AFTER"), "outside the window is excluded");
  assert.equal(f.eventCount, 2);
  assert.ok(f.events.every((e) => e.date > FROM && e.date <= TO),
    "every enumerated row is inside the window it is summarised over");
  ok("every row lies inside the window, on the half-open attribution boundary");
}

// ── rows are deterministically ordered ───────────────────────────────────
{
  const f = summarizePeriodFlows([
    ev("SELL", "2026-02-11", 1, { symbol: "ZZZ" }),
    ev("BUY",  "2026-02-11", -1, { symbol: "AAA" }),
    ev("SELL", "2026-02-10", 1, { symbol: "MMM" }),
  ], FROM, TO, "USD");
  assert.deepEqual(f.events.map((e) => `${e.date}|${e.type}|${e.symbol}`), [
    "2026-02-10|SELL|MMM", "2026-02-11|BUY|AAA", "2026-02-11|SELL|ZZZ",
  ]);
  ok("rows are ordered by (date, type, symbol) — a list never reshuffles");
}

// ── STATIC · the card renders rows, it does not query or classify ────────
{
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const binding = strip(readFileSync(new URL("./investments-time-machine.ts", import.meta.url), "utf8"));
  // Identity is READ from the event row and resolved through the ONE display
  // reader — not re-queried per card.
  assert.ok(/instrumentId: true, financialAccountId: true/.test(binding),
    "the event read carries identity");
  assert.ok(/readDisplay\(client, flowInstrumentIds\)/.test(binding),
    "flow instruments resolve display through the same reader as holdings");
  ok("STATIC · identity is read once at the boundary, never re-queried per card");
}

for (const c of checks) console.log("  ✓ " + c);
console.log(`activity-enumeration: ${checks.length} checks passed`);
