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
// The activity model is a PURE module (no React, no DB), so it imports directly.
import {
  buildActivityGroups, UNATTRIBUTED_LABEL,
} from "@/components/space/widgets/investments/investments-activity";

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

// ── the CARD MODEL's sections enumerate their own counts and subtotals ─────
{
  const events = [
    ev("SELL", "2026-02-10", 500, { symbol: "AMZN", quantity: 1 }),
    ev("SELL", "2026-02-11", 300, { symbol: "JPM", quantity: 2 }),
    ev("BUY",  "2026-02-12", -200, { symbol: "NVDA", quantity: 1 }),
    ev("DIVIDEND", "2026-02-13", 1.4, { symbol: "TXN" }),
    ev("DIVIDEND", "2026-02-14", 0.03),                 // unattributed
    ev("TRANSFER_IN", "2026-02-15", 1000),
    ev("SPLIT", "2026-02-16", 0, { symbol: "TQQQ", quantity: 10 }),
    ev("FEE", "2026-02-17", -5),
  ];
  const model = buildActivityGroups(summarizePeriodFlows(events, FROM, TO, "USD"));
  const byKey = new Map(model.sections.map((s) => [s.key, s]));

  // Every section's count and subtotal come FROM its rows.
  for (const s of model.sections) {
    assert.equal(s.count, s.rows.length, `${s.key}: count === rows`);
    const withAmount = s.rows.filter((r) => r.amount != null);
    if (withAmount.length > 0) {
      assert.ok(Math.abs((s.amount ?? 0) - withAmount.reduce((n, r) => n + (r.amount ?? 0), 0)) < 0.005,
        `${s.key}: subtotal === Σ its rows`);
    }
  }
  assert.equal(byKey.get("sells")?.count, 2);
  assert.equal(byKey.get("buys")?.count, 1);
  assert.equal(byKey.get("income")?.count, 2);

  // Transfers are NOT income — a transfer in is not a gain.
  assert.equal(byKey.get("transfers")?.count, 1);
  assert.ok(!byKey.get("income")?.rows.some((r) => r.type === "TRANSFER_IN"),
    "a transfer never appears under income");
  // Fees and corporate actions are their own sections, not spending or gain.
  assert.equal(byKey.get("fees")?.count, 1);
  assert.equal(byKey.get("corporate_actions")?.count, 1);
  assert.equal(byKey.get("corporate_actions")?.rows[0].label, "TQQQ");

  // An unattributed event is labelled honestly, never given a ticker.
  const unattributed = byKey.get("income")!.rows.find((r) => !r.attributed)!;
  assert.equal(unattributed.label, UNATTRIBUTED_LABEL);
  assert.equal(unattributed.amount, 0.03, "…and still counts toward the subtotal");
  ok("the card model's sections enumerate their own counts and subtotals");
}

// ── STATIC · the card renders; it does not classify or filter ─────────────
{
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const card = strip(readFileSync(
    new URL("../../components/space/widgets/investments/InvestmentsActivityCard.tsx", import.meta.url), "utf8"));
  assert.ok(!/\.filter\(|\.reduce\(/.test(card), "the card neither filters nor reduces");
  assert.ok(!/classifyEventFlow|summarizePeriodFlows/.test(card), "the card classifies nothing");
  assert.ok(/buildActivityGroups\(/.test(card), "it renders the pure model");
  assert.ok(/aria-expanded=\{open\}/.test(card), "disclosure is accessible");
  ok("STATIC · the Activity card renders the model and performs no arithmetic");
}

for (const c of checks) console.log("  ✓ " + c);
console.log(`activity-enumeration: ${checks.length} checks passed`);
