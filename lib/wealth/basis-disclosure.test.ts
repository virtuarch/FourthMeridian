/**
 * lib/wealth/basis-disclosure.test.ts
 *
 * HIST-2E — the today/history basis disclosure appears ONLY where the two
 * valuation bases are both visible (an observed today point AND a reconstructed
 * point), is name-free/number-free, and explains rather than reconciles.
 *
 *   npx tsx lib/wealth/basis-disclosure.test.ts
 */

import { wealthBasisDisclosure } from "./basis-disclosure";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

console.log("wealthBasisDisclosure — only where the two bases actually coexist");
{
  check("all-observed view ⇒ null (uniform basis, no seam)",
    wealthBasisDisclosure({ hasObserved: true, hasReconstructed: false }) === null);
  check("all-reconstructed view ⇒ null (uniform basis, no seam)",
    wealthBasisDisclosure({ hasObserved: false, hasReconstructed: true }) === null);
  check("empty view ⇒ null",
    wealthBasisDisclosure({ hasObserved: false, hasReconstructed: false }) === null);
}

console.log("wealthBasisDisclosure — the disclosure copy when bases mix");
{
  const d = wealthBasisDisclosure({ hasObserved: true, hasReconstructed: true });
  check("mixed view ⇒ a disclosure", d !== null);
  check("has a short title", !!d && d.title.length > 0 && d.title.length < 60);
  check("explains today = provider current balances", !!d && /providers report/i.test(d.note));
  check("explains earlier = reconstructed from historical prices/rates",
    !!d && /reconstructed from historical prices/i.test(d.note));
  check("flags the coverage-gap cases (no recent price / balance-only)",
    !!d && /no recent price/i.test(d.note) && /balance-only/i.test(d.note));
  check("surfaces, never reconciles (no $ figures, no 'error'/'wrong')",
    !!d && !/\$/.test(d.note) && !/error|wrong|incorrect/i.test(d.note));
}

if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nAll basis-disclosure checks passed");
