/**
 * lib/investments/valuation-batch.test.ts
 *
 * HIST-1C — batch historical valuation, source guards. The valuation binding is
 * DB-coupled (Prisma + price archive + FX), so — like valuation.investment-bucket
 * and regenerate-history — this pins the load-bearing contract a future edit must
 * not silently break: the window batch is an execution-strategy optimization over
 * the SAME single valuation authority, never a second engine.
 *
 *   - getInvestmentValueForWindow exists and routes every date through the shared
 *     per-day core (valuePositionRowsOverDates), same as the single-date path;
 *   - the single-date valuePositionRows is a thin wrapper over that core, so there
 *     is exactly ONE place the per-instrument valuation math (valueInstrumentAsOf)
 *     is invoked — no forked/duplicated valuation;
 *   - the batch reads the position window ONCE (no per-date getInvestmentValueAsOf
 *     loop inside the window entry point).
 *
 * Standalone tsx script:  npx tsx lib/investments/valuation-batch.test.ts
 */

import { readFileSync } from "fs";
import { join } from "path";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

function read(rel: string): string {
  return readFileSync(join(process.cwd(), rel), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");
}

function main(): void {
  const valuation = read("lib/investments/valuation.ts");

  console.log("1. Batch window entry point exists and shares the single core");
  check("exports getInvestmentValueForWindow", /export\s+async\s+function\s+getInvestmentValueForWindow\b/.test(valuation));
  check("exports the shared multi-date core valuePositionRowsOverDates",
    /export\s+async\s+function\s+valuePositionRowsOverDates\b/.test(valuation));
  check("the window entry delegates to the shared core (valuePositionRowsOverDates)",
    /return\s+valuePositionRowsOverDates\(/.test(valuation));

  console.log("2. Single-date path is a thin wrapper over the same core (no fork)");
  check("valuePositionRows calls valuePositionRowsOverDates", /valuePositionRowsOverDates\(\{/.test(valuation));
  check("per-instrument valuation math runs in exactly ONE place (no duplicated engine)",
    (valuation.match(/valueInstrumentAsOf\(/g) ?? []).length === 1,
    `found ${(valuation.match(/valueInstrumentAsOf\(/g) ?? []).length} call sites`);

  console.log("3. The window entry reads once, not N×date");
  check("getInvestmentValueForWindow does NOT call getInvestmentValueAsOf per date",
    !/getInvestmentValueForWindow[\s\S]*?getInvestmentValueAsOf\s*\(/.test(valuation) ||
    // getInvestmentValueAsOf is defined ABOVE getInvestmentValueForWindow; ensure the
    // window function body itself contains no per-date single-value call.
    !/function\s+getInvestmentValueForWindow[\s\S]*?getInvestmentValueAsOf\s*\(/.test(valuation));
  check("the window entry reads the position window in one findMany over the account set",
    /function\s+getInvestmentValueForWindow[\s\S]*?positionObservation\.findMany/.test(valuation));

  if (failures > 0) {
    console.error(`\n${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log("\nAll batch-valuation source guards passed.");
  process.exit(0);
}

main();
