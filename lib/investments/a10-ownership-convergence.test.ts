/**
 * lib/investments/a10-ownership-convergence.test.ts
 *
 * A10 IS NO LONGER AN INDEPENDENT HISTORICAL AUTHORITY.
 *
 * It used to hand a raw valuation view straight to assembly. The valuation
 * engine answers "what is this position worth on date D"; it does not answer
 * "did you own it on date D" — and `holdConstantBeforeEarliest` made that worse,
 * carrying the earliest observed quantity BACKWARD so an account connected in
 * 2026 was priced across 2025 as though always held.
 *
 * Measured on Chris' Space at 2025-11-03: the `Individual` account contributed
 * $2,482.12 — six positions, seven months before its first ownership evidence —
 * and that was the ENTIRE gap between the headline ($32,820.13) and the chart,
 * panel and snapshot, which all agreed at $30,338.00.
 *
 * These tests pin the convergence and the shape that makes it total: every A10
 * surface derives from `view.components`, so licensing the view converges all of
 * them at once.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { licenseView, licenseValuationView } from "./historical-holdings";
import type { HoldingOwnershipFacts } from "./historical-holdings.core";
import type { InvestmentValuationView } from "./valuation-core";

const checks: string[] = [];
const ok = (l: string) => checks.push(l);
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
/** Money equality — the engine sums floats; a test must not demand bit equality. */
const near = (a: number, b: number, what: string) =>
  assert.ok(Math.abs(a - b) < 0.005, `${what}: ${a} !~ ${b}`);

const comp = (accountId: string, instrumentId: string, value: number) => ({
  accountId, instrumentId,
  quantity: 10, reportingValue: value, overallTier: "derived" as const,
  reason: "test", isCash: false, nativeCurrency: "USD",
  conflicted: false, basisUsed: "raw-close", priceDate: "2025-11-03",
  staleDays: 0, quantityTier: "observed" as const, priceTier: "observed" as const,
} as unknown as InvestmentValuationView["components"][number]);

const view = (components: InvestmentValuationView["components"]): InvestmentValuationView => ({
  asOf: "2025-11-03", reportingCurrency: "USD",
  valuedSubtotal: components.reduce((n, c) => n + (c.reportingValue ?? 0), 0),
  valuedCount: components.length, unvaluedCount: 0, unvalued: [],
  components,
  completeness: { tier: "derived", conflict: false, reason: "test", byInstrument: {} },
});

/** Ownership that licenses `owned` and refuses everything else. */
const facts = (owned: [string, string][]): Map<string, HoldingOwnershipFacts> => {
  const m = new Map<string, HoldingOwnershipFacts>();
  for (const [a, i] of owned) {
    // The engine's real shape: a RESOLVED resolution carrying confidence
    // segments. Anything else reads as UNKNOWN — which is exactly how an
    // account with no evidence is refused.
    m.set(`${a}|${i}`, {
      resolution: {
        kind: "resolved",
        segments: [{ confidence: "KNOWN", fromISO: "2020-01-01", toISO: "2030-01-01" }],
      },
      closedFromISO: null,
    } as unknown as HoldingOwnershipFacts);
  }
  return m;
};

// ── the licence REMOVES an unowned position and re-aggregates ──────────────
{
  const v = view([comp("llc", "aapl", 3_284.85), comp("individual", "msft", 2_482.12)]);
  near(v.valuedSubtotal, 5_766.97, "unlicensed subtotal");

  const licensed = licenseView(v, "2025-11-03", facts([["llc", "aapl"]]));
  assert.equal(licensed.components.length, 1, "the unowned position is removed");
  assert.equal(licensed.components[0].accountId, "llc");
  // THE FIX: subtotal and counts follow the licensed set. Filtering components
  // alone would have left 5,766.97 describing one row — which is exactly the
  // bug's shape, a total disagreeing with the rows beneath it.
  near(licensed.valuedSubtotal, 3_284.85, "the subtotal follows the licence");
  assert.equal(licensed.valuedCount, 1, "and so do the counts");
  ok("an unowned position is REMOVED and the subtotal/counts re-aggregate with it");
}

// ── a position is never zeroed ─────────────────────────────────────────────
{
  const licensed = licenseView(
    view([comp("llc", "aapl", 100), comp("individual", "msft", 50)]),
    "2025-11-03", facts([["llc", "aapl"]]),
  );
  assert.ok(!licensed.components.some((c) => c.reportingValue === 0),
    "an excluded position is absent, never a zero-valued row asserting ownership");
  ok("an excluded position is absent, never zeroed");
}

// ── fully-licensed views are returned UNCHANGED (identity, not a rebuild) ──
{
  const v = view([comp("llc", "aapl", 100), comp("llc", "msft", 50)]);
  const licensed = licenseView(v, "2025-11-03", facts([["llc", "aapl"], ["llc", "msft"]]));
  assert.equal(licensed, v, "nothing filtered ⇒ the same object, so no Space is disturbed");
  ok("a fully-licensed view is returned unchanged — a no-op where nothing is excluded");
}

// ── an empty view is a no-op (the demo-Space case) ────────────────────────
{
  const v = view([]);
  assert.equal(licenseView(v, "2025-11-03", facts([])), v,
    "a Space with no position evidence is untouched");
  ok("a Space with no position evidence is provably untouched");
}

// ── the licence and the snapshot path share ONE core ──────────────────────
{
  const set = licenseValuationView("2025-11-03",
    [comp("llc", "aapl", 100), comp("individual", "msft", 50)], facts([["llc", "aapl"]]));
  assert.equal(set.heldCount, 1);
  assert.equal(set.excluded.length, 1);
  assert.equal(set.excluded[0].financialAccountId, "individual");
  assert.equal(set.valuedSubtotal, 100);
  ok("licensing runs through buildHistoricalHoldings — the same core the snapshot path uses");
}

// ── STATIC · A10 is a CONSUMER, not an authority ──────────────────────────
{
  const a10 = strip(readFileSync(new URL("./investments-time-machine.ts", import.meta.url), "utf8"));

  assert.ok(/licenseView\(/.test(a10), "A10 licenses its view through the ownership authority");
  assert.ok(/loadOwnershipLicence\(/.test(a10), "and loads the licence from that authority");
  // It must NOT hand a raw view to assembly any more.
  assert.ok(!/assembleInvestmentsTimeMachine\(\{[^}]*view:\s*rawView/.test(a10),
    "the RAW view never reaches assembly");
  // No ownership logic of its own — application only.
  for (const forbidden of [
    "resolveOwnershipWindow", "loadHoldingOwnership", "buildHistoricalHoldings",
    "ownershipOn", "resolveEvidenceCeiling",
  ]) {
    assert.ok(!a10.includes(forbidden), `A10 must not implement ownership (${forbidden})`);
  }
  // No valuation arithmetic of its own (the pre-existing guard, restated).
  assert.ok(!/valuation-core/.test(a10), "A10 imports no valuation core");
  ok("STATIC · A10 applies the licence and owns neither ownership nor valuation");
}

// ── STATIC · exactly ONE historical investments authority ─────────────────
{
  const hh = strip(readFileSync(new URL("./historical-holdings.ts", import.meta.url), "utf8"));
  // The licence loader and the view licensor live together, beside the window
  // form, so there is one place that resolves the evidence ceiling.
  assert.ok(/export async function loadOwnershipLicence/.test(hh));
  assert.ok(/export function licenseView/.test(hh));
  assert.equal((hh.match(/resolveEvidenceCeiling\(/g) ?? []).length, 2,
    "the ceiling is derived in one function and called from one place");
  ok("STATIC · one historical investments authority, one evidence ceiling");
}

for (const c of checks) console.log("  ✓ " + c);
console.log(`a10-ownership-convergence: ${checks.length} checks passed`);
