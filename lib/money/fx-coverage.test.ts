/**
 * lib/money/fx-coverage.test.ts — V25-CLOSE-3A
 *
 * The reporting-currency failure contract's PURE core: the coverage verdict and
 * the requested/effective/reverted decision. No DB, no FX resolution — these
 * read the resolution table the builder already produced.
 *
 *     npx tsx lib/money/fx-coverage.test.ts
 */

import type { Resolution } from "@/lib/fx/types";
import { fxCoverageOf, decideEffectiveCurrency } from "./convert";
import type { SerializedConversionContext } from "./convert";

let failures = 0;
let passes = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) { passes++; }
  else { failures++; console.log(`[FAIL] ${name}`); if (detail) console.log(`        ${detail}`); }
}

const miss = (from: string, d: string): Resolution => ({ kind: "miss", quote: from, requestedDateISO: d });
const rate = (from: string, d: string): Resolution =>
  ({ kind: "rate", rate: 0.9, requestedDateISO: d, effectiveDates: { from: d, to: d }, staleness: "exact" });

function ctxOf(entries: Record<string, Resolution>): SerializedConversionContext {
  return { target: "EUR", entries };
}

// ── Coverage tests ────────────────────────────────────────────────────────────

// all FX resolutions missing → unsatisfiable
{
  const c = fxCoverageOf(ctxOf({ "USD|2026-07-20": miss("USD", "2026-07-20"), "USD|2026-07-19": miss("USD", "2026-07-19") }));
  check("all missing → unsatisfiable", c.satisfiable === false, JSON.stringify(c));
  check("all missing → needed=missed", c.needed === 2 && c.missed === 2);
}

// any valid conversion → satisfiable (partial coverage stays satisfiable)
{
  const c = fxCoverageOf(ctxOf({ "USD|2026-07-20": rate("USD", "2026-07-20"), "USD|2026-07-19": miss("USD", "2026-07-19") }));
  check("one resolved among misses → satisfiable", c.satisfiable === true, JSON.stringify(c));
}

// USD identity / all-USD → no conversion needed → always valid
{
  const c = fxCoverageOf(ctxOf({}));
  check("empty entries (all-identity) → satisfiable", c.satisfiable === true && c.needed === 0);
}

// ── Resolver decision tests ─────────────────────────────────────────────────

// unavailable conversion: requested preserved, effective USD, reverted true
{
  const d = decideEffectiveCurrency("EUR", { needed: 3, missed: 3, satisfiable: false }, "USD");
  check("unavailable → requested preserved (EUR)", d.requested === "EUR");
  check("unavailable → effective USD", d.effective === "USD");
  check("unavailable → reverted true", d.reverted === true);
}

// valid conversion: requested == effective, reverted false
{
  const d = decideEffectiveCurrency("EUR", { needed: 3, missed: 1, satisfiable: true }, "USD");
  check("valid → requested == effective", d.requested === d.effective && d.effective === "EUR");
  check("valid → reverted false", d.reverted === false);
}

// USD requested-but-unsatisfiable: no better fallback ⇒ not a revert
{
  const d = decideEffectiveCurrency("USD", { needed: 2, missed: 2, satisfiable: false }, "USD");
  check("USD unsatisfiable → effective USD, NOT reverted", d.effective === "USD" && d.reverted === false);
}

console.log(`\nfx-coverage: ${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
