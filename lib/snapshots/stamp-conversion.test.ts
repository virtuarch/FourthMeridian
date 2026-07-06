/**
 * lib/snapshots/stamp-conversion.test.ts
 *
 * MC1 Phase 4 Slice 4 — pure gates for the mixed-stamp display conversion
 * (no DB, no network; fixture contexts). House-style standalone tsx script,
 * auto-discovered by scripts/run-tests.ts. The homogeneous fast path lives in
 * the readers (off-stamp rows never reach this module), so these gates cover
 * the off-stamp mapping: per-date historical rates, all-fields-one-rate,
 * miss ⇒ native + estimated, and the always-estimated display rule.
 */

import { convertStampedValues } from "./stamp-conversion";
import type { ConversionContext } from "@/lib/money/types";

let passed = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { passed++; return; }
  failures.push(`✗ ${name}${detail ? ` — ${detail}` : ""}`);
}

// Fixture: EUR-stamped history being displayed in a USD Space; rate varies by
// date (historical FX per snapshot).
const rateByDate: Record<string, number> = { "2026-01-15": 1.25, "2026-06-15": 1.5 };
const ctx: ConversionContext = {
  target: "USD",
  resolve: (from, dateISO) =>
    from === "EUR" && rateByDate[dateISO] !== undefined
      ? { kind: "rate", rate: rateByDate[dateISO], requestedDateISO: dateISO, effectiveDates: { from: dateISO, to: dateISO }, staleness: "exact" }
      : { kind: "miss", quote: from, requestedDateISO: dateISO },
};

const row = { netWorth: 1000, cash: 400, debt: 100, netLiquid: 300 };

// ── historical FX: each snapshot converts at its own date ────────────────────
{
  const jan = convertStampedValues(row, "EUR", "2026-01-15", ctx);
  const jun = convertStampedValues(row, "EUR", "2026-06-15", ctx);
  check("January point converts at January's rate (1000 × 1.25)", jan.values.netWorth === 1250);
  check("June point converts at June's rate (1000 × 1.5)", jun.values.netWorth === 1500);
  check("same currency, different dates ⇒ different display values", jan.values.netWorth !== jun.values.netWorth);
}

// ── one rate per row: every field converts consistently ─────────────────────
{
  const r = convertStampedValues(row, "EUR", "2026-01-15", ctx);
  check("all fields share the row's rate", r.values.cash === 500 && r.values.debt === 125 && r.values.netLiquid === 375);
  check("derived identities preserved under conversion (cash − debt = netLiquid)",
    r.values.cash - r.values.debt === r.values.netLiquid);
  check("off-stamp conversion is always estimation-flagged (summed-total approximation)", r.estimated === true);
}

// ── miss ⇒ native + estimated (D-3) ──────────────────────────────────────────
{
  const r = convertStampedValues(row, "SAR", "2026-01-15", ctx);
  check("missing rate: stored values pass through unchanged", r.values.netWorth === 1000 && r.values.cash === 400);
  check("missing rate: estimated flag set", r.estimated === true);
}

// ── determinism ───────────────────────────────────────────────────────────────
{
  const a = convertStampedValues(row, "EUR", "2026-01-15", ctx);
  const b = convertStampedValues(row, "EUR", "2026-01-15", ctx);
  check("byte-equal repeats", JSON.stringify(a) === JSON.stringify(b));
}

if (failures.length > 0) {
  console.error(`\nMC1 P4 stamp-conversion gates: ${failures.length} FAILURE(S) (${passed} checks passed):`);
  for (const f of failures) console.error("  " + f);
  process.exit(1);
}
console.log(`MC1 P4 stamp-conversion gates: all ${passed} checks passed.`);
process.exit(0);
