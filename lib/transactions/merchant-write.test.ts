/**
 * lib/transactions/merchant-write.test.ts  (MI1 M4)
 *
 * Unit tests for the shared live write-time integration
 * (lib/transactions/merchant-write.ts) and the provider-neutral enrichment
 * capture (lib/transactions/merchant-enrichment.ts). Standalone tsx script:
 *
 *     npx tsx lib/transactions/merchant-write.test.ts
 *
 * Exits 0 on pass / 1 on failure. Deterministic and Prisma-free: a tiny
 * in-memory fake stands in for the Prisma client (cast to the client type), so
 * the full mint/reuse + alias + enrichment + provenance surface is exercised
 * without a database. Covers the M4 test checklist: live stamping, merchant
 * reuse, alias reuse, categorySource stamping, USER_RULE/USER_OVERRIDE
 * preservation, safe/unsafe enrichment capture, and idempotent re-sync.
 */

import type { Prisma } from "@prisma/client";
import { resolveMerchantWrite } from "./merchant-write";
import { plaidCounterpartyEnrichment, type EnrichmentCapture } from "./merchant-enrichment";
import type { CapturedPlaidMetadata } from "./plaid-flow-input";

let passed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { passed++; return; }
  failures.push(`✗ ${name}${detail ? ` — ${detail}` : ""}`);
}
function eq<T>(name: string, got: T, want: T): void {
  check(name, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}

// ── In-memory fake Prisma client (only the methods the helper calls) ──────────
interface MerchantRec {
  id: string;
  canonicalKey: string;
  plaidEntityId: string | null;
  displayName: string;
  website: string | null;
  logoUrl: string | null;
  enrichmentSource: string | null;
  enrichmentConfidence: number | null;
  enrichedAt: Date | null;
}
interface RuleRec { id: string; merchantId: string; scope: string; ownerUserId: string; category: string; }
function makeFake() {
  const merchants = new Map<string, MerchantRec>();
  const byKey = new Map<string, string>();
  const byEntity = new Map<string, string>();
  const aliases = new Map<string, { id: string; merchantId: string; source: string }>();
  const rules: RuleRec[] = [];
  let seq = 0;

  const client = {
    merchant: {
      findUnique: async (args: { where: { plaidEntityId?: string; canonicalKey?: string } }) => {
        const { plaidEntityId, canonicalKey } = args.where;
        const id = plaidEntityId != null ? byEntity.get(plaidEntityId) : canonicalKey != null ? byKey.get(canonicalKey) : undefined;
        return id ? { id } : null;
      },
      upsert: async (args: {
        where: { canonicalKey: string };
        create: MerchantRec & Record<string, unknown>;
      }) => {
        const existing = byKey.get(args.where.canonicalKey);
        if (existing) return { id: existing }; // update: {} → no-op
        const id = `m${++seq}`;
        const c = args.create;
        const rec: MerchantRec = {
          id,
          canonicalKey: c.canonicalKey,
          plaidEntityId: (c.plaidEntityId as string | null) ?? null,
          displayName: c.displayName,
          website: (c.website as string | null) ?? null,
          logoUrl: (c.logoUrl as string | null) ?? null,
          enrichmentSource: (c.enrichmentSource as string | null) ?? null,
          enrichmentConfidence: (c.enrichmentConfidence as number | null) ?? null,
          enrichedAt: (c.enrichedAt as Date | null) ?? null,
        };
        merchants.set(id, rec);
        byKey.set(rec.canonicalKey, id);
        if (rec.plaidEntityId) byEntity.set(rec.plaidEntityId, id);
        return { id };
      },
      updateMany: async (args: { where: { id: string; enrichmentSource: null }; data: Record<string, unknown> }) => {
        const rec = merchants.get(args.where.id);
        if (!rec || rec.enrichmentSource !== null) return { count: 0 };
        Object.assign(rec, args.data);
        return { count: 1 };
      },
    },
    merchantAlias: {
      findUnique: async (args: { where: { aliasKey: string } }) => {
        const a = aliases.get(args.where.aliasKey);
        return a ? { merchantId: a.merchantId } : null;
      },
      upsert: async (args: { where: { aliasKey: string }; create: { aliasKey: string; source: string; merchantId: string } }) => {
        const existing = aliases.get(args.where.aliasKey);
        if (existing) return { id: existing.id };
        const id = `a${++seq}`;
        aliases.set(args.where.aliasKey, { id, merchantId: args.create.merchantId, source: args.create.source });
        return { id };
      },
    },
    merchantRule: {
      findMany: async (args: { where: { merchantId: string; scope: string; ownerUserId: string } }) => {
        const { merchantId, ownerUserId } = args.where;
        return rules.filter((r) => r.merchantId === merchantId && r.scope === "USER" && r.ownerUserId === ownerUserId)
          .map((r) => ({ id: r.id, category: r.category, scope: r.scope }));
      },
    },
  };
  return { client: client as unknown as Prisma.TransactionClient, merchants, aliases, rules };
}

async function main() {
// ── 1. Live stamping: a brand-new row mints merchant + alias + provenance ─────
{
  const { client, merchants, aliases } = makeFake();
  const r = await resolveMerchantWrite(client, { merchant: "NETFLIX.COM", currentCategory: "Subscriptions" });
  eq("new: setMerchantId", r.setMerchantId, true);
  check("new: merchantId assigned", typeof r.merchantId === "string" && r.merchantId!.length > 0);
  eq("new: categorySource GLOBAL_CATALOG", r.categorySource, "GLOBAL_CATALOG");
  eq("new: categoryRuleId null", r.categoryRuleId, null);
  eq("new: minted one merchant", merchants.size, 1);
  eq("new: created one alias", aliases.size, 1);
  eq("new: merchant displayName", [...merchants.values()][0].displayName, "Netflix");
}

// ── 2. Merchant + alias reuse on the second occurrence ────────────────────────
{
  const { client, merchants, aliases } = makeFake();
  const a = await resolveMerchantWrite(client, { merchant: "NETFLIX.COM", currentCategory: "Subscriptions" });
  const b = await resolveMerchantWrite(client, { merchant: "Netflix", currentCategory: "Subscriptions" });
  eq("reuse: same merchant id", b.merchantId, a.merchantId);
  eq("reuse: still one merchant", merchants.size, 1);
  eq("reuse: still one alias", aliases.size, 1);
  eq("reuse: b did not mint", b.applied.minted, false);
  eq("reuse: b reused", b.applied.reused, true);
  eq("reuse: b created no alias", b.applied.aliasCreated, false);
}

// ── 3. Provider PFC provenance when no catalog match ──────────────────────────
{
  const { client } = makeFake();
  const r = await resolveMerchantWrite(client, {
    merchant: "SOME LOCAL DINER",
    currentCategory: "Dining",
    provider: { pfcPrimary: "FOOD_AND_DRINK", pfcConfidenceLevel: "HIGH" },
  });
  eq("provider: categorySource PLAID_PFC", r.categorySource, "PLAID_PFC");
  eq("provider: merchant assigned", r.setMerchantId, true);
}

// ── 4. USER_RULE / USER_OVERRIDE provenance is preserved ──────────────────────
{
  const { client } = makeFake();
  const userRule = await resolveMerchantWrite(client, {
    merchant: "NETFLIX.COM", currentCategory: "Utilities", currentCategorySource: "USER_RULE",
  });
  eq("USER_RULE: categorySource not stamped", userRule.categorySource, null);
  eq("USER_RULE: merchant still assigned", userRule.setMerchantId, true);

  const { client: c2 } = makeFake();
  const manual = await resolveMerchantWrite(c2, {
    merchant: "NETFLIX.COM", currentCategory: "Dining", currentCategorySource: "USER_OVERRIDE",
  });
  eq("USER_OVERRIDE: categorySource not stamped", manual.categorySource, null);
}

// ── 5. Idempotent re-sync: an already-assigned row is never re-pointed ────────
{
  const { client, merchants, aliases } = makeFake();
  await resolveMerchantWrite(client, { merchant: "NETFLIX.COM", currentCategory: "Subscriptions" });
  const again = await resolveMerchantWrite(client, {
    merchant: "NETFLIX.COM", currentCategory: "Subscriptions",
    currentMerchantId: "m1", currentCategorySource: "GLOBAL_CATALOG",
  });
  eq("idempotent: setMerchantId false", again.setMerchantId, false);
  eq("idempotent: merchantId unchanged", again.merchantId, "m1");
  eq("idempotent: categorySource null (already sourced)", again.categorySource, null);
  eq("idempotent: no extra merchant", merchants.size, 1);
  eq("idempotent: no extra alias", aliases.size, 1);
}

// ── 6. Enrichment capture — safe match attaches website/logo on mint ──────────
{
  const NOW = new Date("2026-07-07T00:00:00Z");
  const captured: CapturedPlaidMetadata = {
    pfcConfidenceLevel: "HIGH",
    merchantEntityId: "ent_netflix",
    counterparties: [
      { name: "Netflix", entityId: "ent_netflix", type: "merchant", website: "netflix.com", logoUrl: "https://x/logo.png", confidenceLevel: "VERY_HIGH" },
    ],
  };
  const enrichment = plaidCounterpartyEnrichment(captured, NOW);
  check("safe: enrichment produced", enrichment !== null);
  eq("safe: source PLAID_COUNTERPARTY", enrichment?.source, "PLAID_COUNTERPARTY");
  eq("safe: website captured", enrichment?.website, "netflix.com");

  const { client, merchants } = makeFake();
  await resolveMerchantWrite(
    client,
    { merchant: "NETFLIX.COM", currentCategory: "Subscriptions", merchantEntityId: "ent_netflix" },
    enrichment,
  );
  const rec = [...merchants.values()][0];
  eq("safe: merchant website stamped", rec.website, "netflix.com");
  eq("safe: merchant logoUrl stamped", rec.logoUrl, "https://x/logo.png");
  eq("safe: merchant enrichmentSource stamped", rec.enrichmentSource, "PLAID_COUNTERPARTY");
  eq("safe: merchant enrichedAt stamped", rec.enrichedAt?.toISOString(), NOW.toISOString());
}

// ── 7. Enrichment ignored when identity is unsafe ─────────────────────────────
{
  // Counterparty entity_id does not match the transaction's merchant_entity_id.
  const mismatch: CapturedPlaidMetadata = {
    pfcConfidenceLevel: null,
    merchantEntityId: "ent_netflix",
    counterparties: [
      { name: "Some Aggregator", entityId: "ent_other", type: "merchant", website: "agg.com", logoUrl: "https://x/agg.png", confidenceLevel: "HIGH" },
    ],
  };
  eq("unsafe: enrichment is null (id mismatch)", plaidCounterpartyEnrichment(mismatch), null);

  // No merchant entity id at all → null.
  const noId: CapturedPlaidMetadata = {
    pfcConfidenceLevel: null, merchantEntityId: null,
    counterparties: [{ name: "X", entityId: "ent_x", type: "merchant", website: "x.com", logoUrl: null, confidenceLevel: "LOW" }],
  };
  eq("unsafe: enrichment null (no merchant entity id)", plaidCounterpartyEnrichment(noId), null);

  // A mint with null enrichment leaves the merchant's enrichment columns empty.
  const { client, merchants } = makeFake();
  await resolveMerchantWrite(client, { merchant: "AGG STORE", currentCategory: "Shopping", merchantEntityId: "ent_netflix" }, null);
  eq("unsafe: merchant has no enrichmentSource", [...merchants.values()][0].enrichmentSource, null);
}

// ── 8. Enrichment never overwrites an already-enriched merchant ───────────────
{
  const NOW = new Date("2026-07-07T00:00:00Z");
  const { client, merchants } = makeFake();
  // First safe capture enriches the merchant.
  const first: EnrichmentCapture = { website: "netflix.com", logoUrl: "https://x/1.png", confidence: 0.99, source: "PLAID_COUNTERPARTY", timestamp: NOW };
  await resolveMerchantWrite(client, { merchant: "NETFLIX.COM", currentCategory: "Subscriptions", merchantEntityId: "ent_netflix" }, first);
  // A later reuse with different enrichment must NOT overwrite it.
  const second: EnrichmentCapture = { website: "other.com", logoUrl: "https://x/2.png", confidence: 0.5, source: "PLAID_COUNTERPARTY", timestamp: NOW };
  await resolveMerchantWrite(client, { merchant: "Netflix", currentCategory: "Subscriptions", merchantEntityId: "ent_netflix" }, second);
  eq("no-overwrite: website unchanged", [...merchants.values()][0].website, "netflix.com");
  eq("no-overwrite: logoUrl unchanged", [...merchants.values()][0].logoUrl, "https://x/1.png");
}

// ── 9. Import-shaped call (no provider hints, no enrichment) still stamps ──────
{
  const { client, merchants } = makeFake();
  const r = await resolveMerchantWrite(client, { merchant: "SPOTIFY", currentCategory: "Subscriptions" });
  eq("import: merchant assigned", r.setMerchantId, true);
  eq("import: categorySource GLOBAL_CATALOG", r.categorySource, "GLOBAL_CATALOG");
  eq("import: one merchant minted", merchants.size, 1);
}

// ── 10. USER_RULE applies to a FUTURE transaction (owner-scoped override) ─────
{
  const { client, merchants, rules } = makeFake();
  // First occurrence mints the merchant (no rule yet).
  const first = await resolveMerchantWrite(client, { merchant: "AMAZON", currentCategory: "Shopping", ownerUserId: "u1" });
  eq("future: first occurrence has no override", first.category, null);
  const merchantId = [...merchants.values()][0].id;
  // User later creates a USER rule for that merchant → Services.
  rules.push({ id: "rule1", merchantId, scope: "USER", ownerUserId: "u1", category: "Services" });
  // A FUTURE transaction of the same merchant now inherits the rule.
  const future = await resolveMerchantWrite(client, {
    merchant: "AMAZON", currentCategory: "Shopping", currentMerchantId: null, ownerUserId: "u1",
  });
  eq("future: category overridden to rule", future.category, "Services");
  eq("future: categorySource USER_RULE", future.categorySource, "USER_RULE");
  eq("future: categoryRuleId set", future.categoryRuleId, "rule1");
  eq("future: not preserved", future.preserveExisting, false);
  // A DIFFERENT owner does not see the rule.
  const other = await resolveMerchantWrite(client, { merchant: "AMAZON", currentCategory: "Shopping", ownerUserId: "u2" });
  eq("future: other owner gets no override", other.category, null);
}

// ── 11. Existing USER_OVERRIDE / USER_RULE is preserved (never downgraded) ────
{
  const { client } = makeFake();
  const override = await resolveMerchantWrite(client, {
    merchant: "STARBUCKS #5", currentCategory: "Travel", currentCategorySource: "USER_OVERRIDE", currentMerchantId: "m9", ownerUserId: "u1",
  });
  eq("preserve: preserveExisting true", override.preserveExisting, true);
  eq("preserve: no category override", override.category, null);
  eq("preserve: no categorySource stamp", override.categorySource, null);

  const { client: c2 } = makeFake();
  const rule = await resolveMerchantWrite(c2, {
    merchant: "STARBUCKS #5", currentCategory: "Dining", currentCategorySource: "USER_RULE", currentMerchantId: "m9", ownerUserId: "u1",
  });
  eq("preserve: USER_RULE row preserved", rule.preserveExisting, true);
}

// ── Summary ───────────────────────────────────────────────────────────────────
if (failures.length === 0) {
  console.log(`merchant-write: all ${passed} checks passed.`);
  process.exit(0);
} else {
  console.error(`merchant-write: ${failures.length} FAILED (of ${passed + failures.length}):`);
  for (const f of failures) console.error("  " + f);
  process.exit(1);
}
}

main().catch((e) => { console.error("merchant-write test crashed:", e); process.exit(1); });
