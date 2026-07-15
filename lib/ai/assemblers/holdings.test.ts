/**
 * lib/ai/assemblers/holdings.test.ts
 *
 * P2-4 — source-scan guards for the AI holdings assembler binding. Standalone tsx:
 *
 *     npx tsx lib/ai/assemblers/holdings.test.ts
 *
 * The binding touches the DB, so instead of a live DB these guards pin the
 * read-path invariants that make the canonical cutover real and keep it from
 * regressing to the legacy Holding read:
 *   1. FULL detail is sourced from the canonical getCurrentPositions seam.
 *   2. The all-visibility aggregate is the canonical getInvestmentValueAsOf("all").
 *   3. NO general Holding / current-holdings read remains — the ONLY Holding read
 *      is the crypto-only transitional arm, gated on AccountType.crypto.
 *   4. The pure shaper (buildHoldingsSummary) owns the payload logic.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");
const bindingRaw = readFileSync(join(process.cwd(), "lib/ai/assemblers/holdings.ts"), "utf8");
const binding = stripComments(bindingRaw);
const coreRaw = readFileSync(join(process.cwd(), "lib/ai/assemblers/holdings-core.ts"), "utf8");
const core = stripComments(coreRaw);

// ── 1. Canonical seams ──────────────────────────────────────────────────────
console.log("1. canonical read seams");
check("imports getCurrentPositions (FULL detail seam)",
  /import\s*\{[^}]*getCurrentPositions[^}]*\}\s*from\s*['"]@\/lib\/investments\/current-positions['"]/.test(binding));
check("calls getCurrentPositions with a spaceId scope",
  /getCurrentPositions\(\s*\{\s*spaceId\s*\}/.test(binding));
check("imports getInvestmentValueAsOf (aggregate valuation)",
  /import\s*\{[^}]*getInvestmentValueAsOf[^}]*\}\s*from\s*['"]@\/lib\/investments\/valuation['"]/.test(binding));
check("aggregate uses the canonical 'all' visibility scope",
  /visibilityScope:\s*['"]all['"]/.test(binding));
check("delegates payload shaping to the pure core",
  /buildHoldingsSummary\s*\(/.test(binding));

// ── 2. No legacy Holding read remains (not even for crypto — via the bridge) ──
console.log("2. no legacy brokerage/current-holdings read path");
check("no direct db.holding read", !/\bdb\.holding\b/.test(binding));
check("no prisma.holding read", !/\bprisma\.holding\b/.test(binding));
check("no raw holdings relation select", !/holdings:\s*\{/.test(binding));
check("does not import current-holdings", !/current-holdings/.test(binding));
check("does not import sync-current-holdings", !/sync-current-holdings/.test(binding));
check("no Plaid encryption import (unchanged invariant)", !/plaid\/encryption/.test(binding));

// ── 3. Crypto rides the shared, crypto-only transitional bridge ─────────────
console.log("3. crypto-only transitional bridge (shared with export P2-5)");
check("crypto via the shared legacy-crypto-holdings bridge",
  /readLegacyCryptoWalletPositions/.test(binding) &&
  /from\s*['"]@\/lib\/investments\/legacy-crypto-holdings['"]/.test(binding));
check("crypto arm is explicitly documented transitional",
  /TRANSITIONAL/.test(bindingRaw) && /P2-6/.test(bindingRaw));
check("CANONICAL WINS — bridge excludes wallets already on the spine (no double count)",
  /excludeCanonicalCryptoAccounts/.test(binding));
check("exclusion set is built from the canonical getCurrentPositions rows",
  /new Set\(\s*current\.rows\.map\(/.test(binding));

// ── 4. Pure core hygiene ────────────────────────────────────────────────────
console.log("4. pure core hygiene");
check("core has no DB import", !/@\/lib\/db/.test(core) && !/\bprisma\b/.test(core));
check("core reuses the shared concentration helper (no forked math)",
  /computeConcentration\s*\(/.test(core) &&
  /from\s*['"]@\/lib\/investments\/concentration['"]/.test(core));
check("core does not re-import Holding / current-holdings", !/current-holdings/.test(core) && !/\.holding\b/.test(core));

// ── Exit ────────────────────────────────────────────────────────────────────
if (failures > 0) { console.error(`\n${failures} check(s) failed.`); process.exit(1); }
console.log("\nAll holdings binding source-scan checks passed.");
