/**
 * lib/history/holding-series.test.ts
 *
 * V27-D — the holding level. The episode derivation is pure and is tested
 * directly; the rest is asserted by intent against the module source.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ownershipEpisodes } from "./holding-series";
import type { HistoricalSeriesPoint } from "./historical-node.core";

const checks: string[] = [];
const ok = (label: string) => checks.push(label);

const held = (dateISO: string, value: number): HistoricalSeriesPoint =>
  ({ dateISO, value, basis: "reconstructed" });
const gap = (dateISO: string, reason: string): HistoricalSeriesPoint =>
  ({ dateISO, value: null, basis: "reconstructed", unavailableReason: reason });

// ── D3 · a continuous run is ONE episode ─────────────────────────────────────
assert.deepEqual(
  ownershipEpisodes([held("2026-01-01", 10), held("2026-01-02", 11), held("2026-01-03", 12)]),
  [{ fromISO: "2026-01-01", toISO: "2026-01-03" }],
);
ok("a continuous run is one episode");

// ── D3 · sold and re-bought is TWO episodes, not one long span ───────────────
//
// A single first→last span would draw a line across a stretch when nothing was
// owned — the specific lie the historical engine exists to avoid.
assert.deepEqual(
  ownershipEpisodes([
    held("2026-01-01", 10), held("2026-01-02", 11),
    gap("2026-01-03", "OWNERSHIP_CLOSED"), gap("2026-01-04", "NOT_HELD"),
    held("2026-01-05", 20),
  ]),
  [{ fromISO: "2026-01-01", toISO: "2026-01-02" }, { fromISO: "2026-01-05", toISO: "2026-01-05" }],
);
ok("sold-and-re-bought yields two episodes with a real gap between them");

// ── D3 · owned-but-unvalued does NOT end an episode ──────────────────────────
//
// "We know you held it, we could not price it" and "you did not hold it" are
// different absences. Only the second ends ownership.
assert.deepEqual(
  ownershipEpisodes([
    held("2026-01-01", 10),
    gap("2026-01-02", "NO_DEFENSIBLE_VALUE"),
    held("2026-01-03", 12),
  ]),
  [{ fromISO: "2026-01-01", toISO: "2026-01-03" }],
);
ok("a held-but-unvalued day continues the episode rather than ending it");

assert.deepEqual(ownershipEpisodes([]), []);
assert.deepEqual(ownershipEpisodes([gap("2026-01-01", "NOT_YET_OWNED")]), []);
ok("never held yields no episodes at all");

// ── Intent assertions on the module ──────────────────────────────────────────
const src = readFileSync(new URL("./holding-series.ts", import.meta.url), "utf8");

// D1 — identity is (accountId, instrumentId). A ticker is reassignable, and the
// same symbol in two accounts is two positions with two ownership histories.
assert.ok(/holding:\$\{account\.accountId\}:\$\{instrumentId\}/.test(src),
  "node id is keyed by account AND instrument");
assert.ok(!/find\(\(h\) => h\.symbol ===/.test(src), "positions are never matched by symbol");
ok("identity is (accountId, instrumentId); symbol is display only");

// D2 — every value comes from an authority that already exists.
for (const authority of ["historicalHoldingsForWindow", "getCurrentPositions"]) {
  assert.ok(src.includes(authority), `${authority} is consumed, not reimplemented`);
}
assert.ok(!/reconstructDaily(Cash|Liability)Balances/.test(src),
  "the holding level does not touch the walk-back primitives");
assert.ok(!/\.(create|update|delete|upsert|createMany|updateMany)\(/.test(src), "no writes");
ok("values come from the existing holdings authorities; no walk primitives, no writes");

// The instrument set is the UNION over the window, never the selected date
// alone — otherwise everything sold earlier in the window silently disappears
// and the chart shows a portfolio that never shrank.
assert.ok(/for \(const d of dates\)/.test(src), "the instrument set is built across the window");
ok("the instrument set is the union over the window, not the selected date");

for (const c of checks) console.log("  ✓ " + c);
console.log(`holding-series: ${checks.length} checks passed`);
