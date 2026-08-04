/**
 * lib/perspectives/financial-window.test.ts
 *
 * ONE WINDOW PARSER, TWO INTERVAL SEMANTICS.
 *
 * The bug was never that stock and flow claims use different boundaries — both
 * are correct for their own question. The bug was that TWO PARSERS existed, so
 * nothing guaranteed a convention was applied deliberately rather than by
 * accident. These tests pin the single parser and the deliberate difference.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  resolveFinancialWindow, inFlowInterval, inStockAttribution,
  windowsDifferByOpeningDay, CLAIM_KINDS,
} from "./financial-window";
import { compareToForPreset } from "./time-range";
import { periodRange } from "@/lib/transactions/cash-flow";

const checks: string[] = [];
const ok = (l: string) => checks.push(l);

// ── ONE PARSER · the duplicate is gone, and it was WRONG ───────────────────
{
  // The retired local-time switch used `setMonth(m - 1)`, which OVERFLOWS:
  // "Feb 31" became Mar 3, so Cash Flow tallied THREE DAYS where every other
  // surface tallied a month. These are the dates that exposed it.
  for (const d of ["2026-03-31", "2026-05-31", "2026-01-31", "2024-02-29", "2026-08-04"]) {
    const canonical = compareToForPreset("PAST_MONTH", d, null);
    const viaCashFlow = periodRange("PAST_MONTH", new Date(`${d}T12:00:00`)).start;
    assert.equal(viaCashFlow, canonical,
      `Cash Flow must resolve 1M through the ONE parser (${d})`);
  }
  assert.equal(compareToForPreset("PAST_MONTH", "2026-03-31", null), "2026-02-28",
    "one calendar month back from Mar 31 is Feb 28, never Mar 3");
  ok("ONE PARSER · Cash Flow resolves presets through compareToForPreset, month overflow gone");
}

// ── the two claim kinds, from ONE selected range ───────────────────────────
{
  const w = resolveFinancialWindow({ preset: "PAST_MONTH", asOf: "2026-08-04", compareTo: "2026-07-04" });
  assert.equal(w.fromISO, "2026-07-04");
  assert.equal(w.toISO, "2026-08-04");

  // STOCK: the endpoints are POINTS, and attribution is HALF-OPEN.
  assert.equal(w.stock.openingISO, "2026-07-04");
  assert.equal(w.stock.closingISO, "2026-08-04");
  assert.equal(w.stock.attribution.fromExclusiveISO, "2026-07-04");
  assert.equal(w.stock.attribution.toInclusiveISO, "2026-08-04");

  // FLOW: the displayed calendar dates, BOTH included.
  assert.equal(w.flow.fromInclusiveISO, "2026-07-04");
  assert.equal(w.flow.toInclusiveISO, "2026-08-04");
  ok("one selected range resolves into both stock and flow semantics");
}

// ── THE DELIBERATE DIFFERENCE: the opening day ────────────────────────────
{
  const w = resolveFinancialWindow({ preset: "PAST_MONTH", asOf: "2026-08-04", compareTo: "2026-07-04" });

  // A flow claim COUNTS the opening day — a user who can see Jul 4 in the range
  // expects Jul 4's coffee in "spending Jul 4 → Aug 4".
  assert.equal(inFlowInterval("2026-07-04", w.flow), true);
  // A stock claim does NOT — the opening BALANCE already contains that day, so
  // counting it again would double-count it against the balance.
  assert.equal(inStockAttribution("2026-07-04", w.stock), false);

  // Both agree on every other day, including the closing day.
  for (const d of ["2026-07-05", "2026-07-20", "2026-08-04"]) {
    assert.equal(inFlowInterval(d, w.flow), true, d);
    assert.equal(inStockAttribution(d, w.stock), true, d);
  }
  // …and both exclude outside the range.
  assert.equal(inFlowInterval("2026-07-03", w.flow), false);
  assert.equal(inStockAttribution("2026-08-05", w.stock), false);

  assert.equal(windowsDifferByOpeningDay(w), true,
    "the difference is exactly the opening day, and it is deliberate");
  ok("stock and flow differ by EXACTLY the opening day — deliberate, not drift");
}

// ── a degenerate range is a point, never 'everything' ─────────────────────
{
  const w = resolveFinancialWindow({ preset: "CUSTOM", asOf: "2026-08-04", compareTo: null });
  assert.equal(w.fromISO, "2026-08-04");
  assert.equal(inFlowInterval("2026-08-04", w.flow), true);
  assert.equal(inStockAttribution("2026-08-04", w.stock), false, "a zero-width stock window attributes nothing");
  ok("a range with no start degenerates to a point, never to all-time");
}

// ── STATIC · no duplicated preset switch survives ─────────────────────────
{
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const cashFlow = strip(readFileSync(new URL("../transactions/cash-flow.ts", import.meta.url), "utf8"));
  const window = strip(readFileSync(new URL("./financial-window.ts", import.meta.url), "utf8"));

  // Cash Flow must not re-derive a preset start date itself. Scoped to
  // `periodRange`'s own body — other helpers in the file legitimately bucket by
  // week and are not preset parsers.
  assert.ok(/compareToForPreset\(/.test(cashFlow), "Cash Flow delegates to the one parser");
  const prStart = cashFlow.indexOf("export function periodRange");
  const prBody = cashFlow.slice(prStart, cashFlow.indexOf("\n}", prStart));
  assert.ok(prStart >= 0, "periodRange exists");
  for (const gone of ["setMonth(", "setFullYear(", "getDay()", "switch (period)"]) {
    assert.ok(!prBody.includes(gone),
      `the local-time preset switch is retired (${gone} must not survive in periodRange)`);
  }
  // The window authority must not become the SECOND parser either.
  assert.ok(!/subMonths|startOfMonth|startOfYear|new Date\(/.test(window),
    "the window authority derives no dates of its own — it asks the parser");
  assert.ok(/compareToForPreset/.test(window), "…and it asks the parser");

  assert.deepEqual([...CLAIM_KINDS], ["stock", "flow"], "exactly two claim kinds");
  ok("STATIC · one preset parser; the window authority derives no dates of its own");
}

for (const c of checks) console.log("  ✓ " + c);
console.log(`financial-window: ${checks.length} checks passed`);
