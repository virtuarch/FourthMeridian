/**
 * lib/snapshots/regenerate.test.ts
 *
 * REG-1 — the live "today" SpaceSnapshot writer must include EVERY balance-bearing
 * account so today's snapshot reconciles with the live KPI (renderNetWorth). The
 * binding is DB-coupled (getAccounts + Prisma), so — exactly like
 * regenerate-history.test.ts / the other snapshot bindings — this pins the
 * load-bearing contract with source guards a future edit cannot silently break:
 *
 *   - the removed "Part-B2" zero-transaction cash/debt EVIDENCE GATE (the ~$9k
 *     regression) can never be reintroduced;
 *   - classifyAccounts stays the sole inclusion + aggregation authority;
 *   - the legitimate Part-B investment-consent suppression (no holdings fetched)
 *     is retained.
 *
 * Standalone tsx script:  npx tsx lib/snapshots/regenerate.test.ts
 */

import { readFileSync } from "fs";
import { join } from "path";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

function main(): void {
  const src = readFileSync(join(process.cwd(), "lib/snapshots/regenerate.ts"), "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, ""); // strip comments

  // ── 1. No transaction-evidence gate on cash/debt (REG-1) ──────────────────
  console.log("1. REG-1 — no zero-transaction cash/debt exclusion in the live writer");
  check("the 'noEvidence' exclusion set is gone", !/noEvidence/.test(code));
  check("the 'cashDebtIds' evidence filter is gone", !/cashDebtIds/.test(code));
  check("does not group Transactions to gate snapshot inclusion", !/transaction\.groupBy/.test(code));
  check("no checking/savings/debt filter feeding an exclusion (evidence gate)",
    !/type\s*===\s*["']checking["'][\s\S]{0,80}filter/.test(code));

  // ── 2. classifyAccounts is the sole inclusion + aggregation authority ──────
  console.log("2. classifyAccounts remains the authority");
  check("classifies the eligible account set", /classifyAccounts\s*\(/.test(code));
  check("cash comes from classifyAccounts.totalChecking", /totalChecking/.test(code));
  check("totalAssets includes cash + savings", /totalAssets\s*=\s*total\s*\+\s*cash\s*\+\s*savings/.test(code));

  // ── 3. Legitimate Part-B consent suppression retained ─────────────────────
  console.log("3. Part-B investment-consent suppression retained (no holdings fetched)");
  check("still suppresses CONSENT_REQUIRED investment accounts", /CONSENT_REQUIRED/.test(code));

  // ── 4. Single canonical write path ────────────────────────────────────────
  console.log("4. One write path");
  check("writes only through SpaceSnapshot.upsert", /spaceSnapshot\.upsert/.test(code));

  if (failures > 0) {
    console.error(`\n${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log("\nAll REG-1 live-writer guards passed.");
  process.exit(0);
}

main();
