/**
 * lib/snapshots/regenerate-history.test.ts
 *
 * A9 — binding source guards. Standalone tsx script:
 *
 *     npx tsx lib/snapshots/regenerate-history.test.ts
 *
 * The regeneration decisions are behaviour-tested in regenerate-history.core.test.ts;
 * the binding (regenerate-history.ts) is DB-coupled (Prisma + the FX context +
 * the A8 valuation, which itself reads the DB) and is validated on real data —
 * exactly like backfill.ts / valuation.ts / accounts-asof.ts, whose bindings also
 * carry only source guards. These guards pin the load-bearing architectural
 * contracts so a future edit cannot silently break them:
 *   - investments come from the canonical A8 valuation, NOT a duplicated
 *     price/FX/quantity calculation (the task's central "do not duplicate A8" rule);
 *   - every honesty decision is delegated to the pure core;
 *   - writes are flag-gated and go only through SpaceSnapshot.upsert;
 *   - backfill.ts / regenerate.ts are never modified (only backfill-core is imported).
 */

import { readFileSync } from "fs";
import { join } from "path";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

function main(): void {
  const src = readFileSync(join(process.cwd(), "lib/snapshots/regenerate-history.ts"), "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, ""); // strip comments

  // ── 1. Investments come from the canonical A8 valuation ───────────────────
  console.log("1. Canonical A8 valuation (no duplicated calculation)");
  check("consumes getInvestmentValueAsOf", /getInvestmentValueAsOf\s*\(/.test(code));
  check("uses the A8 valuedSubtotal as the investment component", /valuedSubtotal/.test(code));
  check("does NOT open a second historical price lookup (no lib/prices import)",
    !/from\s+["']@\/lib\/prices/.test(code));
  check("does NOT re-multiply quantity × price (no second valuation)",
    !/\.quantity\s*\*/.test(code) && !/priceAsOf|getPriceAsOf/.test(code));
  check("does NOT open a second FX interpretation (no convertMoney in the binding)",
    !/convertMoney/.test(code));

  // ── 2. Honesty decisions delegated to the pure core ───────────────────────
  console.log("2. Decisions delegated to the pure core");
  check("calls regenerateDay (the core), does not re-implement the rules", /regenerateDay\s*\(/.test(code));
  check("reuses backfill-core walk-backs (does not reimplement reconstruction)",
    /reconstructDailyCashBalances/.test(code) && /reconstructDailyLiabilityBalances/.test(code));
  check("reuses classifyAccounts for aggregation (no bespoke asset/liability math)", /classifyAccounts\s*\(/.test(code));

  // ── 3. Flag-gated, single write path ──────────────────────────────────────
  console.log("3. Flag gate + single write path");
  check("writes are gated on WEALTH_REGENERATION_ENABLED (via wealthRegenerationEnabled)",
    /wealthRegenerationEnabled\s*\(/.test(code) && /applyWrites/.test(code));
  check("upserts only through SpaceSnapshot (one canonical cache, zero new schema)",
    /spaceSnapshot\.upsert/.test(code));
  check("no other SpaceSnapshot/DB write verbs (create/createMany/update/delete) outside the upsert",
    !/spaceSnapshot\.(createMany|delete|deleteMany)\b/.test(code) && !/\.update\s*\(\s*\{[\s\S]*?spaceSnapshot/.test(code));

  // ── 4. Does not modify the sibling generators ─────────────────────────────
  console.log("4. Sibling generators untouched (read-only import discipline)");
  check("imports backfill-core (pure), not backfill.ts / regenerate.ts",
    /from\s+["']@\/lib\/snapshots\/backfill-core["']/.test(code) &&
    !/from\s+["']@\/lib\/snapshots\/backfill["']/.test(code) &&
    !/from\s+["']@\/lib\/snapshots\/regenerate["']/.test(code));

  // ── 5. Frozen-row safety is present in the pipeline ───────────────────────
  console.log("5. Frozen-row safety wired");
  check("reads existing isEstimated to feed the core's frozen-row guard", /isEstimated:\s*true/.test(code) || /existingIsEstimated/.test(code));

  // ── 6. REG-2 — held-flat balance accounts (historical symmetry) ───────────
  console.log("6. REG-2 held-flat inclusion (symmetric with the live writer)");
  check("uses the shared held-flat predicate (single authority, no local reimpl)",
    /isHeldFlatBalanceAccount\s*\(/.test(code));
  check("held-flat accounts floor to EPOCH (span the window), not today",
    /heldFlatIds\.has\([^)]*\)\s*\?\s*EPOCH\s*:\s*today/.test(code));
  check("held-flat spans the full window like holdings",
    /hasHoldings\s*\|\|\s*hasFlatHeld/.test(code));
  check("a held-flat day degrades the cash/card tier to estimated (not derived)",
    /dayHasHeldFlat\s*\?\s*["']estimated["']\s*:\s*["']derived["']/.test(code));

  // ── 7. BTC double-count fix — totalInvestments excludes digital assets ─────
  console.log("7. Investment component excludes crypto (no BTC double-count)");
  check("A9 asks getInvestmentValueAsOf for the investment bucket only",
    /excludeDigitalAssetAccounts:\s*true/.test(code));
  check("crypto is still valued SEPARATELY into the digital-asset component",
    /digitalAssetValue/.test(code) && /totalDigitalAssets/.test(code));

  if (failures > 0) {
    console.error(`\n${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log("\nAll wealth-regeneration binding guards passed.");
  process.exit(0);
}

main();
