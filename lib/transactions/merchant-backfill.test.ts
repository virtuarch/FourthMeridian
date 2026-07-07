/**
 * lib/transactions/merchant-backfill.test.ts  (MI1 M3)
 *
 * Unit tests for the pure M3 backfill planner (lib/transactions/
 * merchant-backfill.ts). Standalone tsx script (house pattern):
 *
 *     npx tsx lib/transactions/merchant-backfill.test.ts
 *
 * Exits 0 on pass / 1 on failure. Fully PURE — no DB, no Prisma client. The
 * "existing identity" facts the DB would supply are injected as plain objects,
 * so the whole decision surface (mint/reuse, alias create/reuse, provenance
 * stamping, never-overwrite, idempotency, restart safety) is exercised without
 * a database. A tiny in-memory store simulates the script's per-row apply loop
 * to prove idempotent reruns, merchant/alias reuse, and restart safety.
 */

import { resolveMerchant } from "./merchant-resolver";
import { computeBackfillPlan, type BackfillRowState, type ExistingIdentity } from "./merchant-backfill";

let passed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { passed++; return; }
  failures.push(`✗ ${name}${detail ? ` — ${detail}` : ""}`);
}
function eq<T>(name: string, got: T, want: T): void {
  check(name, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}

const NONE: ExistingIdentity = { existingMerchant: null, aliasExists: false };

// Resolve a row's MI result the same way the script does.
function resolve(merchant: string, opts: { pfcPrimary?: string; pfcConfidenceLevel?: string; entityId?: string | null } = {}) {
  return resolveMerchant({
    merchant,
    merchantEntityId: opts.entityId ?? null,
    provider: opts.pfcPrimary ? { pfcPrimary: opts.pfcPrimary, pfcConfidenceLevel: opts.pfcConfidenceLevel } : null,
  });
}

// ── 1. Mint path: unknown merchant, unknown alias → mint + create alias ───────
{
  const res = resolve("NETFLIX.COM");
  const row: BackfillRowState = {
    id: "t1", category: "Subscriptions", categorySource: null, merchantId: null, merchantEntityId: null,
  };
  const plan = computeBackfillPlan(row, res, NONE);
  eq("mint: assignMerchant", plan.assignMerchant, true);
  eq("mint: mintMerchant canonicalKey", plan.mintMerchant?.canonicalKey, "NETFLIX");
  eq("mint: mintMerchant displayName", plan.mintMerchant?.displayName, "Netflix");
  eq("mint: reuseMerchantId null", plan.reuseMerchantId, null);
  eq("mint: createAlias aliasKey", plan.createAlias?.aliasKey, "NETFLIX");
  eq("mint: alias source IMPORT (no entityId)", plan.createAlias?.source, "IMPORT");
  // Netflix resolves via GLOBAL_CATALOG to Subscriptions, which matches the stored
  // category → provenance is stamped.
  eq("mint: categorySource GLOBAL_CATALOG", plan.setCategorySource, "GLOBAL_CATALOG");
  eq("mint: not skipped", plan.skip, false);
}

// ── 2. Merchant reuse: existing merchant, existing alias → no mint/no alias ────
{
  const res = resolve("NETFLIX.COM");
  const row: BackfillRowState = {
    id: "t2", category: "Subscriptions", categorySource: null, merchantId: null, merchantEntityId: null,
  };
  const existing: ExistingIdentity = { existingMerchant: { id: "m-netflix" }, aliasExists: true };
  const plan = computeBackfillPlan(row, res, existing);
  eq("reuse: mintMerchant null", plan.mintMerchant, null);
  eq("reuse: reuseMerchantId", plan.reuseMerchantId, "m-netflix");
  eq("reuse: createAlias null (alias exists)", plan.createAlias, null);
  eq("reuse: still stamps provenance", plan.setCategorySource, "GLOBAL_CATALOG");
}

// ── 3. Alias reuse but merchant found by key (alias missing) → create alias ───
{
  const res = resolve("STARBUCKS #2841", { pfcPrimary: "FOOD_AND_DRINK", pfcConfidenceLevel: "HIGH" });
  const row: BackfillRowState = {
    id: "t3", category: "Dining", categorySource: null, merchantId: null, merchantEntityId: "plaid_sbux",
  };
  const existing: ExistingIdentity = { existingMerchant: { id: "m-sbux" }, aliasExists: false };
  const plan = computeBackfillPlan(row, res, existing);
  eq("alias-missing: reuse merchant", plan.reuseMerchantId, "m-sbux");
  eq("alias-missing: create alias", plan.createAlias?.aliasKey, "STARBUCKS");
  eq("alias-missing: source PLAID (entityId present)", plan.createAlias?.source, "PLAID");
  // Dining came from provider PFC and matches stored category → PLAID_PFC provenance.
  eq("alias-missing: categorySource PLAID_PFC", plan.setCategorySource, "PLAID_PFC");
}

// ── 4. Category provenance rules ──────────────────────────────────────────────
{
  // (a) Resolver disagrees with stored category → do NOT stamp (preserve, no downgrade).
  const disagree = computeBackfillPlan(
    { id: "t4a", category: "Shopping", categorySource: null, merchantId: null, merchantEntityId: null },
    resolve("NETFLIX.COM"), // resolver says Subscriptions ≠ Shopping
    NONE,
  );
  eq("disagree: categorySource stays null", disagree.setCategorySource, null);

  // (b) Resolver returns unknown → preserve unknown provenance.
  const unknown = computeBackfillPlan(
    { id: "t4b", category: "Other", categorySource: null, merchantId: null, merchantEntityId: null },
    resolve("ZZZ MYSTERY 55"),
    NONE,
  );
  eq("unknown: categorySource stays null", unknown.setCategorySource, null);

  // (c) Confirmed category → stamp accurate provenance.
  const confirmed = computeBackfillPlan(
    { id: "t4c", category: "Travel", categorySource: null, merchantId: null, merchantEntityId: null },
    resolve("X", { pfcPrimary: "TRAVEL" }),
    NONE,
  );
  eq("confirmed: categorySource PLAID_PFC", confirmed.setCategorySource, "PLAID_PFC");
}

// ── 5. Never overwrite USER_RULE / manual provenance ──────────────────────────
{
  const res = resolve("NETFLIX.COM"); // would say Subscriptions/GLOBAL_CATALOG
  const userRow: BackfillRowState = {
    id: "t5", category: "Utilities", categorySource: "USER_RULE", merchantId: null, merchantEntityId: null,
  };
  const plan = computeBackfillPlan(userRow, res, NONE);
  eq("USER_RULE: categorySource NOT changed", plan.setCategorySource, null);
  // Merchant identity may still be assigned (that is not a provenance change).
  eq("USER_RULE: merchant still assigned", plan.assignMerchant, true);

  const manual: BackfillRowState = {
    id: "t5b", category: "Dining", categorySource: "USER_OVERRIDE", merchantId: null, merchantEntityId: null,
  };
  eq("USER_OVERRIDE: not re-stamped", computeBackfillPlan(manual, res, NONE).setCategorySource, null);
}

// ── 6. Existing merchant assignment is never re-pointed / idempotent ──────────
{
  const res = resolve("NETFLIX.COM");
  const assigned: BackfillRowState = {
    id: "t6", category: "Subscriptions", categorySource: "GLOBAL_CATALOG", merchantId: "m-existing", merchantEntityId: null,
  };
  const plan = computeBackfillPlan(assigned, res, { existingMerchant: { id: "m-other" }, aliasExists: true });
  eq("assigned: assignMerchant false", plan.assignMerchant, false);
  eq("assigned: mintMerchant null", plan.mintMerchant, null);
  eq("assigned: reuseMerchantId null", plan.reuseMerchantId, null);
  eq("assigned: setCategorySource null (already sourced)", plan.setCategorySource, null);
  eq("assigned: skip", plan.skip, true);
}

// ── 7. Batch + restart safety via an in-memory apply simulation ───────────────
{
  // A tiny store mirroring the script: merchants keyed by canonicalKey, aliases by
  // aliasKey, and transactions with mutable merchantId/categorySource.
  interface TxRow { id: string; merchant: string; category: string; categorySource: string | null; merchantId: string | null; entityId: string | null; }
  const merchants = new Map<string, string>();   // canonicalKey → merchantId
  const aliases = new Map<string, string>();      // aliasKey → merchantId
  let seq = 0;

  function applyOne(row: TxRow): void {
    const res = resolveMerchant({ merchant: row.merchant, merchantEntityId: row.entityId });
    const key = res.merchant.canonicalKey;
    const aliasKey = res.alias.aliasKey;
    const existing: ExistingIdentity = aliases.has(aliasKey)
      ? { existingMerchant: { id: aliases.get(aliasKey)! }, aliasExists: true }
      : { existingMerchant: merchants.has(key) ? { id: merchants.get(key)! } : null, aliasExists: false };
    const plan = computeBackfillPlan(
      { id: row.id, category: row.category as never, categorySource: row.categorySource as never, merchantId: row.merchantId, merchantEntityId: row.entityId },
      res,
      existing,
    );
    if (plan.skip) return;
    let mid = plan.reuseMerchantId;
    if (plan.mintMerchant) {
      mid = merchants.get(key) ?? `m${++seq}`;
      merchants.set(key, mid);
    }
    if (plan.createAlias && mid) aliases.set(aliasKey, mid);
    // Guarded write (merchantId IS NULL) — mirror the raw update.
    if (plan.assignMerchant && row.merchantId === null) {
      row.merchantId = mid;
      if (plan.setCategorySource && row.categorySource === null) row.categorySource = plan.setCategorySource;
    }
  }

  // Two Netflix rows + one Starbucks row across "batches".
  const rows: TxRow[] = [
    { id: "a", merchant: "NETFLIX.COM",     category: "Subscriptions", categorySource: null, merchantId: null, entityId: null },
    { id: "b", merchant: "Netflix",         category: "Subscriptions", categorySource: null, merchantId: null, entityId: null },
    { id: "c", merchant: "STARBUCKS #2841", category: "Dining",        categorySource: null, merchantId: null, entityId: null },
  ];
  for (const r of rows) applyOne(r);

  eq("batch: exactly one Netflix merchant minted", merchants.size, 2); // Netflix + Starbucks
  eq("batch: row a and b share the same merchant (reuse)", rows[0].merchantId, rows[1].merchantId);
  check("batch: Starbucks got its own merchant", rows[2].merchantId !== rows[0].merchantId && rows[2].merchantId !== null);
  eq("batch: provenance stamped on a", rows[0].categorySource, "GLOBAL_CATALOG");

  // Restart safety + idempotency: re-running over the SAME rows makes no changes.
  const beforeMerchants = merchants.size;
  const snapshot = rows.map((r) => `${r.id}:${r.merchantId}:${r.categorySource}`).join("|");
  for (const r of rows) applyOne(r);
  eq("rerun: no new merchants minted", merchants.size, beforeMerchants);
  eq("rerun: rows unchanged (idempotent)", rows.map((r) => `${r.id}:${r.merchantId}:${r.categorySource}`).join("|"), snapshot);
}

// ── Summary ───────────────────────────────────────────────────────────────────
if (failures.length === 0) {
  console.log(`merchant-backfill: all ${passed} checks passed.`);
  process.exit(0);
} else {
  console.error(`merchant-backfill: ${failures.length} FAILED (of ${passed + failures.length}):`);
  for (const f of failures) console.error("  " + f);
  process.exit(1);
}
