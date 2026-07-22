/**
 * lib/transactions/merchant-corrections.test.ts  (MI1 M5)
 *
 * Unit tests for the user-correction workflow (lib/transactions/
 * merchant-corrections.ts). Standalone tsx script:
 *
 *     npx tsx lib/transactions/merchant-corrections.test.ts
 *
 * Deterministic and Prisma-free: a tiny in-memory fake stands in for the client.
 * Covers: the confirmed-create planner (no Merchant from free text alone),
 * merchant rename/reassign with alias (re)point + dedupe, MerchantRule
 * find-or-create (idempotent), USER_RULE + USER_OVERRIDE stamping, and the
 * flow/category invariant (flow re-derived from the new category).
 */

import type { Prisma, TransactionCategory } from "@prisma/client";
import {
  planMerchantIdentityCorrection,
  recomputeFlowFields,
  applyMerchantIdentityCorrection,
  applyCategoryRuleCorrection,
  applyTransactionOverride,
  type CorrectionRow,
  type CorrectionAcct,
} from "./merchant-corrections";
import { classifyFlow } from "./flow-classifier";

let passed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { passed++; return; }
  failures.push(`✗ ${name}${detail ? ` — ${detail}` : ""}`);
}
function eq<T>(name: string, got: T, want: T): void {
  check(name, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}

// ── In-memory fake (merchant, merchantAlias, merchantRule, transaction) ───────
function makeFake() {
  const merchants = new Map<string, { id: string; canonicalKey: string; displayName: string }>();
  const byKey = new Map<string, string>();
  const aliases = new Map<string, { id: string; merchantId: string; source: string }>();
  const rules: { id: string; merchantId: string; scope: string; ownerUserId: string | null; category: string }[] = [];
  const txns = new Map<string, Record<string, unknown>>();
  let seq = 0;

  const client = {
    merchant: {
      findUnique: async (args: { where: { id?: string; canonicalKey?: string }; select?: unknown }) => {
        const { id, canonicalKey } = args.where;
        const mid = id ?? (canonicalKey != null ? byKey.get(canonicalKey) : undefined);
        const m = mid ? merchants.get(mid) : undefined;
        return m ?? null;
      },
      upsert: async (args: { where: { canonicalKey: string }; create: { canonicalKey: string; displayName: string } }) => {
        const existing = byKey.get(args.where.canonicalKey);
        if (existing) return { id: existing };
        const id = `m${++seq}`;
        merchants.set(id, { id, canonicalKey: args.create.canonicalKey, displayName: args.create.displayName });
        byKey.set(args.create.canonicalKey, id);
        return { id };
      },
    },
    merchantAlias: {
      findUnique: async (args: { where: { aliasKey: string }; select?: unknown }) => {
        const a = aliases.get(args.where.aliasKey);
        if (!a) return null;
        const m = merchants.get(a.merchantId) ?? null;
        return { merchantId: a.merchantId, merchant: m };
      },
      upsert: async (args: { where: { aliasKey: string }; create: { aliasKey: string; source: string; merchantId: string }; update: { merchantId: string; source: string } }) => {
        const existing = aliases.get(args.where.aliasKey);
        if (existing) {
          existing.merchantId = args.update.merchantId;
          existing.source = args.update.source;
          return { id: existing.id };
        }
        const id = `a${++seq}`;
        aliases.set(args.where.aliasKey, { id, merchantId: args.create.merchantId, source: args.create.source });
        return { id };
      },
    },
    merchantRule: {
      findFirst: async (args: { where: { merchantId: string; scope: string; ownerUserId: string } }) => {
        const r = rules.find((x) => x.merchantId === args.where.merchantId && x.scope === "USER" && x.ownerUserId === args.where.ownerUserId);
        return r ? { id: r.id } : null;
      },
      create: async (args: { data: { merchantId: string; scope: string; ownerUserId: string; category: string } }) => {
        const id = `r${++seq}`;
        rules.push({ id, merchantId: args.data.merchantId, scope: args.data.scope, ownerUserId: args.data.ownerUserId, category: args.data.category });
        return { id };
      },
      update: async (args: { where: { id: string }; data: { category: string } }) => {
        const r = rules.find((x) => x.id === args.where.id);
        if (r) r.category = args.data.category;
        return { id: args.where.id };
      },
    },
    transaction: {
      update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        const cur = txns.get(args.where.id) ?? {};
        txns.set(args.where.id, { ...cur, ...args.data });
        return { id: args.where.id };
      },
    },
  };
  return { client: client as unknown as Prisma.TransactionClient, merchants, aliases, rules, txns };
}

const ACCT: CorrectionAcct = { accountType: "checking", debtSubtype: null };
function row(over: Partial<CorrectionRow> = {}): CorrectionRow {
  return {
    id: "t1", merchant: "WALMART #1842", description: "WALMART", category: "Shopping" as TransactionCategory,
    amount: -20, merchantId: "m-existing", categorySource: null, merchantEntityId: null,
    pfcPrimary: null, pfcDetailed: null, pfcConfidenceLevel: null, ...over,
  };
}

async function main() {
// ── 1. Confirmed-create planner: no merchant from free text alone ─────────────
{
  eq("plan: select by id", planMerchantIdentityCorrection({ selectMerchantId: "m5" }).kind, "select");
  eq("plan: confirmed create", planMerchantIdentityCorrection({ createDisplayName: "Walmart", confirmCreate: true }).kind, "create");
  // Bare proposed name → needs confirmation (NEVER auto-create).
  eq("plan: bare name needs confirmation", planMerchantIdentityCorrection({ proposedName: "Walmary" }).kind, "needs-confirmation");
  const create = planMerchantIdentityCorrection({ createDisplayName: "Walmart", confirmCreate: true });
  if (create.kind === "create") {
    eq("plan: create canonicalKey", create.canonicalKey, "WALMART");
    eq("plan: create displayName", create.displayName, "Walmart");
  }
}

// ── 2. Merchant rename via confirmed create + alias (re)point ─────────────────
{
  const { client, merchants, aliases, txns } = makeFake();
  const decision = planMerchantIdentityCorrection({ createDisplayName: "Walmart", confirmCreate: true });
  const r = row();
  const res = await applyMerchantIdentityCorrection(client, r, decision as never);
  eq("rename: one merchant created", merchants.size, 1);
  eq("rename: alias points to new merchant", aliases.get("WALMART")?.merchantId, res.merchantId);
  eq("rename: alias source USER", aliases.get("WALMART")?.source, "USER");
  eq("rename: transaction reassigned", txns.get("t1")?.merchantId, res.merchantId);
}

// ── 3. Alias reuse + dedupe (idempotent re-point, no duplicate) ───────────────
{
  const { client, aliases } = makeFake();
  const d = planMerchantIdentityCorrection({ createDisplayName: "Walmart", confirmCreate: true });
  await applyMerchantIdentityCorrection(client, row(), d as never);
  const firstAliasId = aliases.get("WALMART")?.id;
  // Re-run the same correction → same single alias (dedupe by unique aliasKey).
  await applyMerchantIdentityCorrection(client, row(), d as never);
  eq("dedupe: still one alias", aliases.size, 1);
  eq("dedupe: same alias id (idempotent)", aliases.get("WALMART")?.id, firstAliasId);
}

// ── 4. Reassign to an existing merchant (select) re-points the alias ──────────
{
  const { client, merchants, aliases, txns } = makeFake();
  // Seed an existing target merchant.
  await client.merchant.upsert({ where: { canonicalKey: "WALMART" }, create: { canonicalKey: "WALMART", displayName: "Walmart" }, update: {}, select: { id: true } } as never);
  const targetId = [...merchants.values()][0].id;
  const res = await applyMerchantIdentityCorrection(client, row(), { kind: "select", merchantId: targetId });
  eq("select: no new merchant", merchants.size, 1);
  eq("select: reassigned to target", res.merchantId, targetId);
  eq("select: alias points to target", aliases.get("WALMART")?.merchantId, targetId);
  eq("select: transaction reassigned", txns.get("t1")?.merchantId, targetId);
}

// ── 5. Category rule find-or-create + USER_RULE stamping + flow invariant ─────
{
  const { client, rules, txns } = makeFake();
  const r = row({ merchantId: "m-amazon", category: "Shopping" as TransactionCategory });
  const res = await applyCategoryRuleCorrection(client, r, ACCT, "u1", "Services" as TransactionCategory);
  eq("rule: one rule created", rules.length, 1);
  eq("rule: rule owner", rules[0].ownerUserId, "u1");
  eq("rule: rule category", rules[0].category, "Services");
  const t = txns.get("t1")!;
  eq("rule: txn category updated", t.category, "Services");
  eq("rule: txn categorySource USER_RULE", t.categorySource, "USER_RULE");
  eq("rule: txn categoryRuleId set", t.categoryRuleId, res.ruleId);
  // Flow invariant: flowType present and equals classifier's answer for the new category.
  const want = classifyFlow({ category: "Services", amount: -20, accountType: "checking", debtSubtype: null }).flowType;
  eq("rule: flowType re-derived from new category", t.flowType, want);

  // Idempotent edit: re-correcting the same merchant updates the SAME rule.
  await applyCategoryRuleCorrection(client, r, ACCT, "u1", "Medical" as TransactionCategory);
  eq("rule: still one rule (find-or-update)", rules.length, 1);
  eq("rule: rule category updated", rules[0].category, "Medical");
}

// ── 6. Transaction-only override (USER_OVERRIDE) — this row only ──────────────
{
  const { client, rules, txns } = makeFake();
  const r = row({ category: "Dining" as TransactionCategory });
  await applyTransactionOverride(client, r, ACCT, "Travel" as TransactionCategory);
  eq("override: no rule created", rules.length, 0);
  const t = txns.get("t1")!;
  eq("override: txn category updated", t.category, "Travel");
  eq("override: categorySource USER_OVERRIDE", t.categorySource, "USER_OVERRIDE");
  eq("override: categoryRuleId null", t.categoryRuleId, null);
  const want = classifyFlow({ category: "Travel", amount: -20, accountType: "checking", debtSubtype: null }).flowType;
  eq("override: flowType re-derived", t.flowType, want);
}

// ── 7. Flow/category invariant via recomputeFlowFields directly ───────────────
{
  const r = row({ amount: 500 });
  const flow = recomputeFlowFields(r, ACCT, "Income" as TransactionCategory);
  const want = classifyFlow({ category: "Income", amount: 500, accountType: "checking", debtSubtype: null });
  eq("recompute: flowType matches classifier", flow.flowType, want.flowType);
  eq("recompute: flowDirection matches classifier", flow.flowDirection, want.flowDirection);
}

// ── Summary ───────────────────────────────────────────────────────────────────
if (failures.length === 0) {
  console.log(`merchant-corrections: all ${passed} checks passed.`);
  process.exit(0);
} else {
  console.error(`merchant-corrections: ${failures.length} FAILED (of ${passed + failures.length}):`);
  for (const f of failures) console.error("  " + f);
  process.exit(1);
}
}

main().catch((e) => { console.error("merchant-corrections test crashed:", e); process.exit(1); });
