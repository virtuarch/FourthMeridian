/**
 * lib/format.test.ts
 *
 * Focused tests for the shared transaction-date presentation helper
 * (transactionDateParts) that backs the canonical <TransactionDate> block:
 *   11 / Jul / 2026 — day / 3-letter month / 4-digit year.
 * Pure — no DB/React. Auto-discovered by scripts/run-tests.ts.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { transactionDateParts } from "./format";

// ── Currency-regrowth guard (REVIEW-3 wave 3) ─────────────────────────────────
// lib/format.ts once carried byte-equivalent copies of the lib/currency.ts
// formatters (formatCurrency / formatCurrencyExact / formatCompactCurrency);
// they were consolidated into lib/currency.ts. This source scan fails if any
// currency formatter regrows here: no `style: "currency"` Intl option and no
// export whose name contains "Currency" may appear in lib/format.ts. New
// currency helpers belong in lib/currency.ts.
test("lib/format.ts contains no currency formatter (consolidated in lib/currency.ts)", () => {
  const src = readFileSync(join(__dirname, "format.ts"), "utf8");
  const code = src
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join("\n");
  assert.ok(
    !/style:\s*["']currency["']/.test(code),
    'lib/format.ts uses Intl style:"currency" — currency formatting belongs in lib/currency.ts',
  );
  assert.ok(
    !/export\s+(function|const)\s+\w*[Cc]urrency/.test(code),
    "lib/format.ts exports a *Currency* helper — it belongs in lib/currency.ts",
  );
});

test("transactionDateParts: day / 3-letter month / 4-digit year", () => {
  assert.deepEqual(transactionDateParts("2026-07-11"), { day: "11", month: "Jul", year: "2026" });
});

test("transactionDateParts: single-digit day has no leading zero", () => {
  assert.equal(transactionDateParts("2026-01-05").day, "5");
});

test("transactionDateParts: month is always the 3-letter abbreviation (never full name)", () => {
  const expected = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  for (let m = 1; m <= 12; m++) {
    const iso = `2026-${String(m).padStart(2, "0")}-15`;
    assert.equal(transactionDateParts(iso).month, expected[m - 1], iso);
    assert.ok(transactionDateParts(iso).month.length === 3, `${iso} month is 3 letters`);
  }
});

test("transactionDateParts: four-digit year, distinct across years (multi-year history)", () => {
  assert.equal(transactionDateParts("2015-03-30").year, "2015");
  assert.equal(transactionDateParts("2026-07-09").year, "2026");
  assert.equal(transactionDateParts("2015-03-30").year.length, 4);
});

test("transactionDateParts: date-only parsing is timezone-stable (parts equal the literal date)", () => {
  // Local-noon construction means the returned day/month/year always equal the
  // literal YYYY-MM-DD components regardless of the runtime timezone — no
  // off-by-one day shift (the long-standing transaction-row behavior).
  for (const iso of ["2024-01-01", "2024-12-31", "2026-06-05", "2019-11-01"]) {
    const [y, mo, d] = iso.split("-");
    const parts = transactionDateParts(iso);
    assert.equal(parts.year, y);
    assert.equal(parts.day, String(Number(d)));   // numeric, no leading zero
    // month index round-trips to the same calendar month
    const monIdx = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"].indexOf(parts.month);
    assert.equal(monIdx + 1, Number(mo), iso);
  }
});
