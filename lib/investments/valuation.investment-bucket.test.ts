/**
 * lib/investments/valuation.investment-bucket.test.ts
 *
 * BTC double-count fix — the historical INVESTMENT-bucket scope of
 * getInvestmentValueAsOf. The valuation binding is DB-coupled (Prisma + price
 * archive + FX), so — like regenerate-history.test.ts — this pins the load-bearing
 * contract with source guards a future edit cannot silently break:
 *
 *   - getInvestmentValueAsOf can exclude digital-asset (crypto) accounts, using the
 *     CANONICAL DIGITAL_ASSET_ACCOUNT_TYPES from account-classifier (no ad hoc list);
 *   - the exclusion is OPT-IN and DEFAULTS OFF, so the holdings-display callers
 *     (AI holdings, A10 Investments Time Machine, getCurrentPositions) still surface
 *     crypto positions (invariant #8);
 *   - the ONLY caller that assigns valuedSubtotal to totalInvestments — the A9
 *     snapshot regeneration — sets excludeDigitalAssetAccounts:true, so a crypto
 *     position on the shared spine (P2-6) is never double-counted into net worth.
 *
 * Standalone tsx script:  npx tsx lib/investments/valuation.investment-bucket.test.ts
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
  const regen     = read("lib/snapshots/regenerate-history.ts");
  const a10       = read("lib/investments/investments-time-machine.ts");
  const aiHold    = read("lib/ai/assemblers/holdings.ts");
  const classifier = read("lib/account-classifier.ts");

  // ── 1. Canonical boundary authority (no ad hoc list) ──────────────────────
  console.log("1. Digital-asset boundary lives in the canonical classifier authority");
  check("account-classifier exports DIGITAL_ASSET_ACCOUNT_TYPES", /export const DIGITAL_ASSET_ACCOUNT_TYPES/.test(classifier));
  check("classifyAccounts uses the shared predicate (single authority)", /isDigitalAssetAccountType\(/.test(classifier));
  check("valuation imports the canonical types, not a local crypto list", /import\s*\{[^}]*DIGITAL_ASSET_ACCOUNT_TYPES[^}]*\}\s*from\s*["']@\/lib\/account-classifier["']/.test(valuation));
  check("valuation does not hard-code its own 'crypto' account-type list", !/type:\s*\{\s*(not|notIn):\s*\[?\s*["']crypto["']/.test(valuation));

  // ── 2. Opt-in exclusion, applied on the position read ─────────────────────
  console.log("2. getInvestmentValueAsOf — opt-in digital-asset exclusion");
  check("adds an excludeDigitalAssetAccounts option", /excludeDigitalAssetAccounts\?:\s*boolean/.test(valuation));
  check("filters the position read by account type via DIGITAL_ASSET_ACCOUNT_TYPES",
    /notIn:\s*\[\s*\.\.\.DIGITAL_ASSET_ACCOUNT_TYPES\s*\]/.test(valuation));
  check("the filter is gated on the option (=== true), not always-on", /excludeDigitalAssetAccounts\s*===\s*true/.test(valuation));

  // ── 3. Default OFF → holdings-display callers keep crypto (invariant #8) ───
  console.log("3. Default OFF — holdings-display callers still see crypto positions");
  check("A10 (investments-time-machine) does NOT exclude digital assets", !/excludeDigitalAssetAccounts/.test(a10));
  check("AI holdings assembler does NOT exclude digital assets", !/excludeDigitalAssetAccounts/.test(aiHold));

  // ── 4. The net-worth caller (A9) DOES exclude (fixes the double-count) ─────
  console.log("4. A9 net-worth regeneration excludes digital assets from totalInvestments");
  check("regenerate-history passes excludeDigitalAssetAccounts:true", /excludeDigitalAssetAccounts:\s*true/.test(regen));
  check("regenerate-history still values crypto separately into digital assets", /digitalAssetValue/.test(regen));

  if (failures > 0) {
    console.error(`\n${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log("\nAll investment-bucket scope guards passed.");
  process.exit(0);
}

main();
