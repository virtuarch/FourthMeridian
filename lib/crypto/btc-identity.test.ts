/**
 * lib/crypto/btc-identity.test.ts
 *
 * V26-PRE (B4) — BTC transaction identity defenses. The Plaid write path has a
 * per-item lock plus a plaidTransactionId unique backstop; the BTC wallet path
 * had NEITHER: find-then-createMany with no constraint (a manual sync racing
 * the daily cron duplicated movements), and a `deletedAt: null` dedupe filter
 * that re-created tombstoned rows as new ACTIVE rows on the next sync —
 * violating the identity doctrine's replay invariant.
 *
 * Layers:
 *   A. Behavioral — filterFreshMovements (tombstone-wins semantics, pure).
 *   B. Source-scan — the dedupe read includes tombstones; createMany passes
 *      skipDuplicates (ON CONFLICT DO NOTHING against the active-row index).
 *   C. Migration — the partial unique index exists with the exact predicate
 *      (active rows only, so import rollback → re-import keeps working).
 *
 * Standalone tsx:  npx tsx lib/crypto/btc-identity.test.ts
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import { filterFreshMovements } from "./btc-sync";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

// ─── A. Behavioral — tombstone-wins filter ───────────────────────────────────

const M = (externalId: string) => ({ externalId });

{
  const fresh = filterFreshMovements([M("tx1"), M("tx2"), M("tx3")], ["tx2"]);
  check("known id filtered, unknown ids kept", fresh.map((m) => m.externalId).join(",") === "tx1,tx3");
}
{
  // The core B4 scenario: the existing set now includes TOMBSTONED rows' ids —
  // a deliberate deletion must block re-creation exactly like an active row.
  const fresh = filterFreshMovements([M("tx1"), M("tx2")], ["tx1", "tx2"]);
  check("tombstone-wins: previously-imported ids never re-import", fresh.length === 0);
}
{
  const fresh = filterFreshMovements([M("tx1")], []);
  check("empty existing set → everything fresh", fresh.length === 1);
}
{
  // Null externalTransactionId rows (non-import rows caught by a broad read)
  // must not poison the set.
  const fresh = filterFreshMovements([M("tx1")], [null, null]);
  check("null ids in the existing read are ignored", fresh.length === 1);
}

// ─── B. Source-scan — the import step's write contract ───────────────────────

const ROOT = process.cwd();
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const sync = strip(readFileSync(path.join(ROOT, "lib", "crypto", "btc-sync.ts"), "utf8"));

// The dedupe read: the findMany selecting externalTransactionId for the
// account must NOT filter deletedAt — tombstones are part of identity.
const dedupeRead = sync.match(/findMany\(\{\s*where:\s*\{\s*financialAccountId:[^}]*externalTransactionId:\s*\{\s*in:[^}]*\}[^}]*\}/);
check("dedupe read exists (find existing ids for the account)", dedupeRead !== null);
check(
  "dedupe read INCLUDES tombstones (no deletedAt filter — tombstone wins)",
  dedupeRead !== null && !dedupeRead[0].includes("deletedAt"),
  dedupeRead?.[0],
);
check(
  "createMany passes skipDuplicates (concurrent-writer overlap no-ops via the active-row index)",
  /createMany\(\{[\s\S]{0,200}?skipDuplicates:\s*true/.test(sync),
);
check("movement filtering goes through the tested pure helper", sync.includes("filterFreshMovements(movements"));

// ─── C. Migration — the DB-level backstop ────────────────────────────────────

const MIGRATION = path.join(ROOT, "prisma", "migrations", "20260727_v26pre_b4_btc_identity_backstop", "migration.sql");
let sql = "";
try { sql = readFileSync(MIGRATION, "utf8"); } catch { /* handled below */ }

check("B4 migration exists", sql.length > 0, MIGRATION);
check("index is UNIQUE on (financialAccountId, externalTransactionId)",
  /CREATE UNIQUE INDEX[^;]*"Transaction"\s*\("financialAccountId",\s*"externalTransactionId"\)/.test(sql));
check("index is PARTIAL: non-null external ids only",
  /WHERE[^;]*"externalTransactionId"\s+IS\s+NOT\s+NULL/.test(sql));
check("index is PARTIAL: ACTIVE rows only (tombstones excluded — rollback → re-import unaffected)",
  /WHERE[^;]*"deletedAt"\s+IS\s+NULL/.test(sql));

// The pre-deploy duplicate check (scripts/check-external-id-duplicates.ts) was
// RETIRED once the B4 migration applied — the unique index above now enforces
// what it checked — and the file was deleted in REVIEW-3 wave 3 (tombstoned in
// scripts/audit-registry.ts). The migration assertions above are the live guard.

if (failures > 0) {
  console.error(`\nbtc-identity: ${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll btc-identity checks passed.");
