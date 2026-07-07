/**
 * lib/transactions/merchant-resolver.test.ts  (MI1 M2)
 *
 * Unit tests for the pure merchant/category resolution engine
 * (lib/transactions/merchant-resolver.ts). Standalone tsx script (house pattern):
 *
 *     npx tsx lib/transactions/merchant-resolver.test.ts
 *
 * Exits 0 on pass / 1 on failure. Fully PURE — no DB, no Prisma client, no
 * network. The resolver's lookups are injected as in-memory functions, so the
 * whole precedence stack is exercised without persistence.
 *
 * Covers: normalization, precedence (User → Merchant → Provider → Unknown),
 * provider fallback, unknown merchants, category provenance (CategorySource),
 * and determinism.
 */

import {
  resolveMerchant,
  RESOLUTION_CONFIDENCE,
  type ResolverContext,
  type MerchantRuleRef,
  type ResolvedMerchantRef,
} from "./merchant-resolver";

let passed = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { passed++; return; }
  failures.push(`✗ ${name}${detail ? ` — ${detail}` : ""}`);
}
function eq<T>(name: string, got: T, want: T): void {
  check(name, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}

// ── 1. Normalization ──────────────────────────────────────────────────────────
{
  const netflix = resolveMerchant({ merchant: "NETFLIX.COM" });
  eq("NETFLIX.COM → displayName Netflix", netflix.merchant.displayName, "Netflix");
  eq("NETFLIX.COM → canonicalKey NETFLIX", netflix.merchant.canonicalKey, "NETFLIX");

  const starbucks = resolveMerchant({ merchant: "STARBUCKS #2841" });
  eq("STARBUCKS #2841 → displayName Starbucks", starbucks.merchant.displayName, "Starbucks");
  eq("STARBUCKS #2841 → canonicalKey STARBUCKS", starbucks.merchant.canonicalKey, "STARBUCKS");

  const square = resolveMerchant({ merchant: "SQ *BLUE BOTTLE 0099" });
  eq("SQ *BLUE BOTTLE 0099 → displayName Blue Bottle", square.merchant.displayName, "Blue Bottle");

  // Mixed-case brand is left intact (no destructive lowercasing).
  const mixed = resolveMerchant({ merchant: "Anthropic" });
  eq("Anthropic → displayName Anthropic", mixed.merchant.displayName, "Anthropic");

  // aliasKey mirrors the canonical key.
  eq("aliasKey mirrors canonicalKey", netflix.alias.aliasKey, "NETFLIX");
}

// ── 2. Precedence: User rules dominate everything ────────────────────────────
{
  const merchant: ResolvedMerchantRef = { id: "m1", canonicalKey: "NETFLIX", displayName: "Netflix" };
  const userRule: MerchantRuleRef = { id: "r1", category: "Utilities", scope: "USER" };
  const ctx: ResolverContext = {
    lookupMerchant: () => merchant,
    lookupUserRules: (id) => (id === "m1" ? [userRule] : []),
  };
  // Netflix would be Subscriptions via the global catalog AND has a provider hint,
  // but the USER rule (Utilities) must win.
  const r = resolveMerchant(
    { merchant: "NETFLIX.COM", provider: { pfcPrimary: "GENERAL_MERCHANDISE", pfcConfidenceLevel: "HIGH" } },
    ctx,
  );
  eq("user rule wins: category", r.category, "Utilities");
  eq("user rule wins: source USER_RULE", r.categorySource, "USER_RULE");
  eq("user rule wins: confidence 1.0", r.confidence, RESOLUTION_CONFIDENCE.USER_RULE);
  eq("user rule wins: matchedRule id", r.matchedRule?.id, "r1");
  eq("user rule wins: tier", r.metadata.tier, "USER_RULE");
  eq("user rule wins: merchant matched", r.merchant.matched?.id, "m1");
}

// ── 3. Precedence: Merchant rules (global catalog) beat provider ─────────────
{
  // Netflix is in the curated catalog (Subscriptions); a provider hint pointing
  // at Shopping must NOT override the catalog.
  const r = resolveMerchant({
    merchant: "NETFLIX.COM",
    provider: { pfcPrimary: "GENERAL_MERCHANDISE", pfcConfidenceLevel: "VERY_HIGH" },
  });
  eq("catalog beats provider: category", r.category, "Subscriptions");
  eq("catalog beats provider: source GLOBAL_CATALOG", r.categorySource, "GLOBAL_CATALOG");
  eq("catalog beats provider: confidence", r.confidence, RESOLUTION_CONFIDENCE.GLOBAL_CATALOG);
  eq("catalog beats provider: tier", r.metadata.tier, "GLOBAL_CATALOG");

  // A user rule is only consulted when a merchant is matched; with no context the
  // catalog is the top live arm.
  const uberEats = resolveMerchant({ merchant: "UBER EATS" });
  eq("catalog specificity: uber eats → Dining", uberEats.category, "Dining");
}

// ── 4. Provider fallback (PLAID_PFC) when no rule matches ─────────────────────
{
  const dining = resolveMerchant({
    merchant: "SOME LOCAL DINER",
    provider: { pfcPrimary: "FOOD_AND_DRINK", pfcConfidenceLevel: "HIGH" },
  });
  eq("provider fallback: category Dining", dining.category, "Dining");
  eq("provider fallback: source PLAID_PFC", dining.categorySource, "PLAID_PFC");
  eq("provider fallback: confidence from HIGH", dining.confidence, RESOLUTION_CONFIDENCE.PROVIDER_HIGH);
  eq("provider fallback: tier", dining.metadata.tier, "PLAID_PFC");

  // Detailed-level override.
  const interest = resolveMerchant({
    merchant: "BANK",
    provider: { pfcPrimary: "BANK_FEES", pfcDetailed: "BANK_FEES_INTEREST_CHARGE" },
  });
  eq("provider detailed override: Interest", interest.category, "Interest");

  // Confidence level mapping default when absent.
  const noLevel = resolveMerchant({ merchant: "SHOP X", provider: { pfcPrimary: "GENERAL_MERCHANDISE" } });
  eq("provider default confidence", noLevel.confidence, RESOLUTION_CONFIDENCE.PROVIDER_DEFAULT);

  // Legacy category array path.
  const legacy = resolveMerchant({ merchant: "OLD ROW", provider: { legacyCategory: ["Travel", "Airlines"] } });
  eq("provider legacy array: Travel", legacy.category, "Travel");
  eq("provider legacy array: source PLAID_PFC", legacy.categorySource, "PLAID_PFC");
}

// ── 5. Unknown merchants → null category, null source ─────────────────────────
{
  const unknown = resolveMerchant({ merchant: "ZZZ MYSTERY VENDOR 55" });
  eq("unknown: category null", unknown.category, null);
  eq("unknown: source null", unknown.categorySource, null);
  eq("unknown: confidence null", unknown.confidence, null);
  eq("unknown: tier UNKNOWN", unknown.metadata.tier, "UNKNOWN");
  eq("unknown: matchedRule null", unknown.matchedRule, null);

  // Unmapped provider primary must NOT default to Other — stays unknown.
  const unmapped = resolveMerchant({ merchant: "ZZZ", provider: { pfcPrimary: "SOMETHING_NEW" } });
  eq("unmapped provider primary → unknown", unmapped.category, null);
  eq("unmapped provider primary → source null", unmapped.categorySource, null);
}

// ── 6. Category provenance always present when a category is set ───────────────
{
  const cases = [
    resolveMerchant({ merchant: "NETFLIX.COM" }), // catalog
    resolveMerchant({ merchant: "X", provider: { pfcPrimary: "TRAVEL" } }), // provider
  ];
  for (const r of cases) {
    check(
      `resolved category carries a source (${r.category})`,
      r.category !== null ? r.categorySource !== null : r.categorySource === null,
    );
  }
}

// ── 7. Determinism ────────────────────────────────────────────────────────────
{
  const input = { merchant: "STARBUCKS #2841", provider: { pfcPrimary: "FOOD_AND_DRINK", pfcConfidenceLevel: "MEDIUM" } };
  const a = JSON.stringify(resolveMerchant(input));
  const b = JSON.stringify(resolveMerchant(input));
  const c = JSON.stringify(resolveMerchant({ ...input }));
  check("identical inputs → identical output (a==b)", a === b);
  check("identical inputs → identical output (a==c)", a === c);
}

// ── 8. Purity: resolver does not require any context ──────────────────────────
{
  // No throw, deterministic, when called with no lookups at all.
  const r = resolveMerchant({ merchant: "NETFLIX.COM" });
  check("no-context call succeeds", r.category === "Subscriptions" && r.merchant.matched === null);
}

// ── Summary ───────────────────────────────────────────────────────────────────
if (failures.length === 0) {
  console.log(`merchant-resolver: all ${passed} checks passed.`);
  process.exit(0);
} else {
  console.error(`merchant-resolver: ${failures.length} FAILED (of ${passed + failures.length}):`);
  for (const f of failures) console.error("  " + f);
  process.exit(1);
}
