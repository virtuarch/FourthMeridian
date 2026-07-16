/**
 * lib/investments/scope-divergence.test.ts
 *
 * HIST-1D — the shared-Space scope-divergence disclosure: applies ONLY on a
 * shared Space that has ≥1 reduced-visibility investment account, is name-free,
 * pluralizes correctly, and reconciles nothing (pure copy). The DB read that
 * feeds it (Space type + redacted investment-link count) is a source-guarded
 * binding; this pins the pure decision.
 *
 *   npx tsx lib/investments/scope-divergence.test.ts
 */

import { investmentsScopeDivergence } from "./scope-divergence";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

console.log("investmentsScopeDivergence — only where the divergence is real");
{
  check("personal Space ⇒ null (no divergence)",
    investmentsScopeDivergence({ isSharedSpace: false, redactedInvestmentAccountCount: 3 }) === null);
  check("shared Space, no redacted investment account ⇒ null",
    investmentsScopeDivergence({ isSharedSpace: true, redactedInvestmentAccountCount: 0 }) === null);
  check("negative count is treated as none ⇒ null",
    investmentsScopeDivergence({ isSharedSpace: true, redactedInvestmentAccountCount: -1 }) === null);
}

console.log("investmentsScopeDivergence — the disclosure copy");
{
  const one = investmentsScopeDivergence({ isSharedSpace: true, redactedInvestmentAccountCount: 1 });
  check("one redacted account ⇒ a disclosure", one !== null);
  check("carries the count", one?.redactedAccountCount === 1);
  check("singular grammar (1 shared account contributes/keeps)",
    !!one && /1 shared account contributes[\s\S]*keeps individual holdings private/.test(one.note));
  check("explains it can read LOWER than wealth (surfaces, never reconciles)",
    !!one && /read lower than the wealth figure for the same date/.test(one.note));

  const many = investmentsScopeDivergence({ isSharedSpace: true, redactedInvestmentAccountCount: 4 });
  check("plural grammar (4 shared accounts contribute/keep)",
    !!many && /4 shared accounts contribute[\s\S]*keep individual holdings private/.test(many.note));
  check("has a short title", !!many && many.title.length > 0 && many.title.length < 60);
  check("name-free (no account names / dollar amounts in the note)",
    !!many && !/\$/.test(many.note));
}

if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nAll scope-divergence checks passed");
