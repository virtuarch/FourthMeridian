/**
 * lib/transactions/merchant-merge-suggest.test.ts  (MI2 S2)
 *
 * Unit tests for the PURE merge-candidate detector. Standalone tsx script:
 *
 *     npx tsx lib/transactions/merchant-merge-suggest.test.ts
 *
 * Exits 0 on pass / 1 on failure. No DB, no Prisma, no network — the detector is
 * pure over injected facts. The deny-list is tested more heavily than the
 * matching (it is the priority feature): a denied pair must never appear at any
 * tier, and detection must be deterministic.
 */

import { suggestMerchantMerges, type MergeDetectorMerchant } from "./merchant-merge-suggest";

let passed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { passed++; return; }
  failures.push(`✗ ${name}${detail ? ` — ${detail}` : ""}`);
}
function eq<T>(name: string, got: T, want: T): void {
  check(name, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}

function m(id: string, canonicalKey: string, extra: Partial<MergeDetectorMerchant> = {}): MergeDetectorMerchant {
  return { id, canonicalKey, displayName: canonicalKey, ...extra };
}

// ── 1. T2 canonical containment (the WGU truncation class) ───────────────────
{
  const cands = suggestMerchantMerges([
    m("s", "WESTERN GOVERNORS UNIVERSITY"),
    m("d", "WESTERN GOVERNORS UN"),
  ]);
  eq("t2: one candidate", cands.length, 1);
  eq("t2: tier T2", cands[0]?.tier, "T2");
  eq("t2: signal CANONICAL_CONTAINMENT", cands[0]?.signal, "CANONICAL_CONTAINMENT");
  eq("t2: survivor is the least-truncated", cands[0]?.survivorKey, "WESTERN GOVERNORS UNIVERSITY");
  eq("t2: absorbed is the truncation", cands[0]?.absorbedKey, "WESTERN GOVERNORS UN");
}

// ── 2. T2 requires ≥2 shared leading tokens ──────────────────────────────────
{
  const cands = suggestMerchantMerges([
    m("a", "SHELL GAS STATION"),
    m("b", "SHELL"),
  ]);
  eq("t2: single-token side not paired", cands.length, 0);

  const oneToken = suggestMerchantMerges([m("a", "DELTA"), m("b", "DELTA AIR LINES")]);
  // "DELTA" is a single token → only one shared leading token → denied at T2.
  eq("t2: one shared token not enough", oneToken.length, 0);
}

// ── 3. T1 provider entity-id contradiction dominates, and picks the id owner ──
{
  const cands = suggestMerchantMerges([
    m("owner", "WESTERN GOVERNORS UNIVERSITY", { plaidEntityId: "ent_wgu" }),
    m("dup", "WGU PAYMENTS", { observedEntityIds: ["ent_wgu"] }),
  ]);
  eq("t1: one candidate", cands.length, 1);
  eq("t1: tier T1", cands[0]?.tier, "T1");
  eq("t1: signal PLAID_ENTITY", cands[0]?.signal, "PLAID_ENTITY");
  eq("t1: survivor owns the entity id", cands[0]?.survivorKey, "WESTERN GOVERNORS UNIVERSITY");
  eq("t1: absorbed observed the id", cands[0]?.absorbedKey, "WGU PAYMENTS");
}

// ── 4. T1 beats T2 for the same pair (only one candidate, tier T1) ───────────
{
  const cands = suggestMerchantMerges([
    m("s", "WESTERN GOVERNORS UNIVERSITY", { plaidEntityId: "ent_wgu" }),
    m("d", "WESTERN GOVERNORS UN", { observedEntityIds: ["ent_wgu"] }),
  ]);
  eq("t1>t2: single candidate", cands.length, 1);
  eq("t1>t2: tier is T1", cands[0]?.tier, "T1");
}

// ── 5. Deny-list: aggregator/rail prefixes are NEVER paired (any tier) ───────
{
  // Two Google service suffixes share the prefix — the shared prefix is non-evidence.
  const google = suggestMerchantMerges([m("a", "GOOGLE FI"), m("b", "GOOGLE CLOUD")]);
  eq("deny: google services not paired", google.length, 0);

  // Even containment is denied under a deny-prefix.
  const amzn = suggestMerchantMerges([m("a", "AMZN MKTP US"), m("b", "AMZN MKTP")]);
  eq("deny: amzn containment denied", amzn.length, 0);

  // Even a provider entity-id contradiction is denied under a deny-prefix
  // (PayPal-the-rail must not absorb merchants reached through it).
  const paypal = suggestMerchantMerges([
    m("a", "PAYPAL TRANSFER", { plaidEntityId: "ent_pp" }),
    m("b", "PAYPAL SOMEONE", { observedEntityIds: ["ent_pp"] }),
  ]);
  eq("deny: paypal rail denied even at T1", paypal.length, 0);
}

// ── 6. Self-pair and unrelated merchants produce nothing ─────────────────────
{
  eq("no self-pair", suggestMerchantMerges([m("x", "NETFLIX")]).length, 0);
  const unrelated = suggestMerchantMerges([m("a", "NETFLIX"), m("b", "SPOTIFY")]);
  eq("unrelated not paired", unrelated.length, 0);
}

// ── 7. Determinism: identical input → identical output (stable order) ────────
{
  const input = [
    m("d", "WESTERN GOVERNORS UN"),
    m("s", "WESTERN GOVERNORS UNIVERSITY"),
    m("x", "COSTCO WHOLESALE"),
    m("y", "COSTCO WHOLESALE CORP"),
  ];
  const a = JSON.stringify(suggestMerchantMerges(input));
  const b = JSON.stringify(suggestMerchantMerges([...input].reverse()));
  eq("deterministic regardless of input order", a, b);
}

// ── Summary ───────────────────────────────────────────────────────────────────
if (failures.length === 0) {
  console.log(`merchant-merge-suggest: all ${passed} checks passed.`);
  process.exit(0);
} else {
  console.error(`merchant-merge-suggest: ${failures.length} FAILED (of ${passed + failures.length}):`);
  for (const f of failures) console.error("  " + f);
  process.exit(1);
}
