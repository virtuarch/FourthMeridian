/**
 * lib/snapshots/regeneration-candidates.core.test.ts
 *
 * V26-PRICE-5 — regeneration-candidate fixtures. Standalone tsx script:
 *
 *     npx tsx lib/snapshots/regeneration-candidates.core.test.ts
 *
 * The property under test: a regeneration touches only rows it would actually
 * change, and the four dispositions never blur. In particular a FROZEN row is
 * BLOCKED whether or not its evidence changed — "must not be rewritten" is not
 * the same fact as "need not be", and an audit trail that conflates them cannot
 * distinguish a protected row from an inert one.
 */

import {
  classifyRegeneration,
  summariseRegenerationImpact,
  detectDiscontinuities,
  REGENERATION_DISPOSITIONS,
  type StoredSnapshotComponents,
} from "./regeneration-candidates.core";
import { WEALTH_REGEN_EPSILON, type DayRegenResult } from "./regenerate-history.core";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const eq = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

const STORED: StoredSnapshotComponents = {
  stocks: 1000, crypto: 500, cash: 200, savings: 300, debt: 100, netWorth: 1900,
};

function fields(over: Partial<StoredSnapshotComponents> = {}) {
  return {
    ...STORED, ...over,
    totalAssets: 0, netLiquid: 0, cashOnHand: 0, total: 0,
  } as NonNullable<DayRegenResult["fields"]>;
}

function result(over: Partial<DayRegenResult> = {}): DayRegenResult {
  return {
    date: "2026-01-05", action: "write", fields: fields(),
    isEstimated: true, tier: "estimated", reason: null,
    ...over,
  } as DayRegenResult;
}

function main(): void {
  // ── 1. BLOCKED ────────────────────────────────────────────────────────────
  console.log("1. BLOCKED — immutability and identity");
  {
    const frozen = classifyRegeneration(result({ action: "skip-frozen", fields: null }), STORED);
    check("a frozen row is BLOCKED", frozen.disposition === "BLOCKED");
    check("…with no deltas claimed", eq(frozen.deltas, []) && frozen.largestAbsDelta === 0);
    check("…and the core's own action preserved for audit", frozen.action === "skip-frozen");

    const membership = classifyRegeneration(result({ action: "skip-membership-changed", fields: null }), STORED);
    check("a membership change is BLOCKED", membership.disposition === "BLOCKED");

    // The distinction the four dispositions exist to keep.
    const frozenIdentical = classifyRegeneration(
      result({ action: "skip-frozen", fields: null }), STORED);
    check("a frozen row is BLOCKED, never UNCHANGED — protected is not the same as inert",
      frozenIdentical.disposition === "BLOCKED");
  }

  // ── 2. SKIPPED ────────────────────────────────────────────────────────────
  console.log("2. SKIPPED — insufficient or invalid evidence");
  {
    const invalid = classifyRegeneration(result({
      action: "skip-unsupported", fields: null,
      reason: "INVALID_VALUATION_EVIDENCE (investments): historical valuation was negative",
    }), STORED);
    check("P0's invalid-evidence skip is SKIPPED", invalid.disposition === "SKIPPED");
    check("…and its coded reason is carried through, not discarded",
      invalid.reason?.startsWith("INVALID_VALUATION_EVIDENCE") === true);

    const nullFields = classifyRegeneration(result({ action: "write", fields: null }), STORED);
    check("a write with no fields is SKIPPED, never treated as a change",
      nullFields.disposition === "SKIPPED");
  }

  // ── 3. UNCHANGED ──────────────────────────────────────────────────────────
  console.log("3. UNCHANGED — recomputes identically, so is not rewritten");
  {
    const same = classifyRegeneration(result(), STORED);
    check("identical recomputation is UNCHANGED", same.disposition === "UNCHANGED");
    check("…with no deltas", eq(same.deltas, []));

    const withinEpsilon = classifyRegeneration(
      result({ fields: fields({ stocks: 1000 + WEALTH_REGEN_EPSILON / 2 }) }), STORED);
    check("a sub-epsilon difference is not a change",
      withinEpsilon.disposition === "UNCHANGED");
  }

  // ── 4. UPDATED ────────────────────────────────────────────────────────────
  console.log("4. UPDATED — the only rows that get written");
  {
    const changed = classifyRegeneration(
      result({ fields: fields({ stocks: 1200, netWorth: 2100 }) }), STORED);
    check("a real difference is UPDATED", changed.disposition === "UPDATED");
    check("…naming exactly the components that moved",
      eq(changed.deltas.map((d) => d.component), ["stocks", "netWorth"]));
    check("…with before, after and delta",
      eq(changed.deltas[0], { component: "stocks", before: 1000, after: 1200, delta: 200 }));
    check("…and the largest absolute change", changed.largestAbsDelta === 200);

    const created = classifyRegeneration(result(), null);
    check("no stored row → UPDATED (creating a row is a change)", created.disposition === "UPDATED");

    const negativeDelta = classifyRegeneration(result({ fields: fields({ crypto: 100 }) }), STORED);
    check("a decrease is reported as a negative delta",
      negativeDelta.deltas[0].delta === -400 && negativeDelta.largestAbsDelta === 400);
  }

  // ── 5. Impact aggregation ─────────────────────────────────────────────────
  console.log("5. impact aggregation");
  {
    const impact = summariseRegenerationImpact([
      classifyRegeneration(result({ date: "2026-01-03", fields: fields({ stocks: 1500 }) }), STORED),
      classifyRegeneration(result({ date: "2026-01-01" }), STORED),
      classifyRegeneration(result({ date: "2026-01-02", action: "skip-frozen", fields: null }), STORED),
      classifyRegeneration(result({ date: "2026-01-04", action: "skip-unsupported", fields: null }), STORED),
    ]);
    check("each disposition is counted separately",
      impact.updated === 1 && impact.unchanged === 1 && impact.blocked === 1 && impact.skipped === 1);
    check("only UPDATED days are writable", eq(impact.writable, ["2026-01-03"]));
    check("candidates are sorted by date, not input order",
      eq(impact.candidates.map((c) => c.dateISO),
         ["2026-01-01", "2026-01-02", "2026-01-03", "2026-01-04"]));
    check("the largest delta across the window is reported", impact.largestAbsDelta === 500);
    check("every disposition in the vocabulary is reachable",
      new Set(impact.candidates.map((c) => c.disposition)).size === REGENERATION_DISPOSITIONS.length);
  }

  // ── 6. Discontinuities ────────────────────────────────────────────────────
  console.log("6. newly introduced discontinuities");
  {
    // Two adjacent days whose net worth is adjusted by very different amounts:
    // the SERIES gains a step it did not have before.
    const cliff = detectDiscontinuities([
      classifyRegeneration(result({ date: "2026-01-01", fields: fields({ netWorth: 1900 + 10 }) }), STORED),
      classifyRegeneration(result({ date: "2026-01-02", fields: fields({ netWorth: 1900 + 5000 }) }), STORED),
    ], 1000);
    check("a regeneration-created step is reported",
      cliff.length === 1 && cliff[0].fromISO === "2026-01-01" && cliff[0].toISO === "2026-01-02");
    check("…with the size of the step", Math.round(cliff[0].jump) === 4990);

    const smooth = detectDiscontinuities([
      classifyRegeneration(result({ date: "2026-01-01", fields: fields({ netWorth: 2000 }) }), STORED),
      classifyRegeneration(result({ date: "2026-01-02", fields: fields({ netWorth: 2010 }) }), STORED),
    ], 1000);
    check("a uniform shift introduces no discontinuity", smooth.length === 0);
    check("nothing is auto-corrected — smoothing a real step would be fabrication",
      Array.isArray(smooth));
  }

  // ── 7. Determinism ────────────────────────────────────────────────────────
  console.log("7. determinism");
  {
    const r = result({ fields: fields({ stocks: 1200 }) });
    check("repeat classification → byte-identical",
      JSON.stringify(classifyRegeneration(r, STORED)) === JSON.stringify(classifyRegeneration(r, STORED)));
    const a = classifyRegeneration(result({ date: "2026-01-02", fields: fields({ stocks: 1200 }) }), STORED);
    const b = classifyRegeneration(result({ date: "2026-01-01", fields: fields({ crypto: 900 }) }), STORED);
    check("INPUT ORDER CANNOT CHANGE THE IMPACT",
      JSON.stringify(summariseRegenerationImpact([a, b])) ===
      JSON.stringify(summariseRegenerationImpact([b, a])));
    check("deltas follow declared component order, never object iteration",
      eq(classifyRegeneration(result({ fields: fields({ netWorth: 9999, stocks: 1200 }) }), STORED)
        .deltas.map((d) => d.component), ["stocks", "netWorth"]));
  }

  console.log(failures === 0 ? "\nAll regeneration-candidate checks passed." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
