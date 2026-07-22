/**
 * lib/investments/investments-time-machine.test.ts
 *
 * A10 — binding-source guards for the Investments Time Machine DB binding.
 * Standalone tsx script (source-scan, no DB):
 *
 *     npx tsx lib/investments/investments-time-machine.test.ts
 *
 * The binding must COMPOSE the canonical services, never fork them. These guards
 * fail the moment it grows a second replay engine, price lookup, FX
 * interpretation, or a persistence write — the A10 §"one canonical
 * implementation" rule made executable.
 */

import { readFileSync } from "fs";
import { join } from "path";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

function main(): void {
  const raw = readFileSync(join(process.cwd(), "lib/investments/investments-time-machine.ts"), "utf8");
  const code = raw.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, ""); // strip comments

  console.log("1. Single valuation path");
  check("values via the canonical getInvestmentValueAsOf (A8/A4/FX), not a reimplementation",
    /getInvestmentValueAsOf\s*\(/.test(code));
  check("no second price engine (does not import lib/prices)",
    !/@\/lib\/prices/.test(code) && !/priceArchive|createPriceService|getPriceAsOf/.test(code));
  check("no second replay engine (does not import the A4 quantity seam directly)",
    !/resolvePositionAsOf|getPositionQuantityAsOf|reconstruction-read/.test(code));
  check("no bespoke valuation arithmetic (does not import valuation-core directly)",
    !/valueInstrumentAsOf|valuePortfolioAsOf/.test(code));

  console.log("2. Canonical FX + provenance-safe event read");
  check("FX via the money layer convertMoney, no hand-rolled rate math",
    /convertMoney\s*\(/.test(code));
  check("events read with the A7-1 provenance filter (deletedAt + supersededById null)",
    /deletedAt:\s*null/.test(code) && /supersededById:\s*null/.test(code));
  check("period flows come from the pure summariser, not an inline reducer",
    /summarizePeriodFlows\s*\(/.test(code));
  check("result shaped by the pure assembler",
    /assembleInvestmentsTimeMachine\s*\(/.test(code));

  console.log("3. No persistence (derived, never a second fact store)");
  check("no create/upsert/update/delete writes",
    !/\.(create|createMany|upsert|update|updateMany|delete|deleteMany)\s*\(/.test(code));

  console.log("4. Receives resolved dates (does not own time state)");
  check("takes asOf + compareTo, not a preset",
    /asOf/.test(code) && /compareTo/.test(code) && !/preset/.test(code));

  if (failures > 0) {
    console.error(`\n${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log("\nAll investments-time-machine binding guards passed.");
  process.exit(0);
}

main();
