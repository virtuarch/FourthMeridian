/**
 * lib/transactions/merchant-rules.test.ts
 *
 * Unit tests for the curated global merchant→category resolver
 * (lib/transactions/merchant-rules.ts).
 *
 * The project has no test runner. This is a standalone, dependency-free script
 * runnable with the already-installed `tsx`, mirroring
 * lib/transactions/plaid-category.test.ts and flow-classifier.test.ts:
 *
 *     npx tsx lib/transactions/merchant-rules.test.ts
 *
 * Exits 0 when all cases pass, 1 on the first failure summary. It imports ONLY
 * merchant-rules.ts, which uses a type-only @prisma/client import and therefore
 * pulls in NO Prisma client at runtime — so this runs without `prisma generate`.
 */

import {
  resolveMerchantCategory,
  isKnownSubscriptionMerchant,
  MERCHANT_RULES,
} from "./merchant-rules";

// ── Tiny assert harness ───────────────────────────────────────────────────────

let passed = 0;
const failures: string[] = [];

function expectCat(
  label: string,
  merchant: string | null,
  name: string | null,
  want: string | null,
): void {
  const got = resolveMerchantCategory(merchant, name);
  if (got === want) { passed++; return; }
  failures.push(`✗ ${label} — got ${got}, want ${want}`);
}

function expectTrue(label: string, cond: boolean): void {
  if (cond) { passed++; return; }
  failures.push(`✗ ${label} — expected true`);
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Travel — global + regional
// ─────────────────────────────────────────────────────────────────────────────

expectCat("Uber → Travel",            "Uber",            null, "Travel");
expectCat("UBER TRIP upper → Travel", "UBER TRIP 1234",  null, "Travel");
expectCat("Careem (regional) → Travel", "Careem",        null, "Travel");
expectCat("Gathern (regional) → Travel", "GATHERN.SA",   null, "Travel");

// ─────────────────────────────────────────────────────────────────────────────
// 2. Ordering / specificity guard — "uber eats" MUST beat "uber"
// ─────────────────────────────────────────────────────────────────────────────

expectCat("Uber Eats → Dining (not Travel)", "Uber Eats", null, "Dining");
expectCat("UBER EATS in descriptor → Dining", "UBER", "UBER EATS SAN FRANCISCO", "Dining");

// ─────────────────────────────────────────────────────────────────────────────
// 3. Subscriptions — curated SaaS additions
// ─────────────────────────────────────────────────────────────────────────────

expectCat("Anthropic → Subscriptions",  "Anthropic",     null, "Subscriptions");
expectCat("Claude.ai → Subscriptions",  "CLAUDE.AI",     null, "Subscriptions");
expectCat("Supabase → Subscriptions",   "Supabase",      null, "Subscriptions");
expectCat("Vercel → Subscriptions",     "Vercel Inc.",   null, "Subscriptions");
expectCat("Hostinger → Subscriptions",  "HOSTINGER",     null, "Subscriptions");

// ─────────────────────────────────────────────────────────────────────────────
// 4. Subscriptions — folded legacy allowlist still resolves
// ─────────────────────────────────────────────────────────────────────────────

expectCat("Netflix → Subscriptions",    "Netflix",       null, "Subscriptions");
expectCat("Spotify → Subscriptions",    "Spotify",       null, "Subscriptions");
expectCat("Apple bill via name field",  "Apple", "APPLE.COM/BILL CUPERTINO CA", "Subscriptions");

// ─────────────────────────────────────────────────────────────────────────────
// 5. Shopping — global + regional
// ─────────────────────────────────────────────────────────────────────────────

expectCat("Sephora → Shopping",              "Sephora",              null, "Shopping");
expectCat("Bath & Body Works → Shopping",    "Bath & Body Works",    null, "Shopping");
expectCat("Bath and Body Works (variant)",   "BATH AND BODY WORKS",  null, "Shopping");
expectCat("Ace Hardware → Shopping",         "Ace Hardware #182",    null, "Shopping");
expectCat("Napa Auto Parts → Shopping",      "NAPA AUTO PARTS",      null, "Shopping");
expectCat("Ajmal (regional) → Shopping",     "Ajmal Perfumes",       null, "Shopping");

// ─────────────────────────────────────────────────────────────────────────────
// 6. Fee — phrase-scoped pattern family
// ─────────────────────────────────────────────────────────────────────────────

expectCat("Amex annual fee → Fee",       "AMEX ANNUAL FEE",              null, "Fee");
expectCat("Amex membership fee → Fee",    "American Express", "AMEX MEMBERSHIP FEE", "Fee");

// ─────────────────────────────────────────────────────────────────────────────
// 7. Conservative-match / false-positive guards — specific tokens only
// ─────────────────────────────────────────────────────────────────────────────

// "ace hardware" phrase must NOT be triggered by an unrelated "ace".
expectCat("Ace Cash Express → null",     "Ace Cash Express",     null, null);
// "napa auto" must NOT match a Napa winery.
expectCat("Napa Valley Winery → null",   "Napa Valley Winery",   null, null);
// "microsoft 365" must NOT match Microsoft Store (regression guard on legacy token).
expectCat("Microsoft Store → null",      "Microsoft Store",      null, null);
// Ordinary Amex purchase must NOT match the fee phrase.
expectCat("Amex grocery purchase → null", "AMEX", "AMEX PURCHASE WHOLE FOODS", null);
// Held-out merchants must NOT resolve (cadence-ambiguous / blocked / user-specific).
expectCat("PlayStation held out → null", "PlayStation Network",  null, null);
expectCat("Amazon Prime Video held out → null", "Amazon Prime Video", null, null);
expectCat("Namecheap held out → null",   "Namecheap",            null, null);
expectCat("Pharmacy held out → null",    "CVS Pharmacy",         null, null);
expectCat("Vox Cinema held out → null",  "VOX Cinemas",          null, null);
expectCat("WGU held out → null",         "WGU Tuition",          null, null);
expectCat("Unknown merchant → null",     "Joe's Corner Store",   null, null);

// ─────────────────────────────────────────────────────────────────────────────
// 8. Empty / null inputs → null (never throws, never mis-groups)
// ─────────────────────────────────────────────────────────────────────────────

expectCat("Empty strings → null",        "",                     "",   null);
expectCat("Null inputs → null",          null,                   null, null);

// ─────────────────────────────────────────────────────────────────────────────
// 9. isKnownSubscriptionMerchant parity — the narrow subscription predicate
// ─────────────────────────────────────────────────────────────────────────────

expectTrue("isKnownSubscriptionMerchant(Netflix)",  isKnownSubscriptionMerchant("Netflix"));
expectTrue("isKnownSubscriptionMerchant(Apple bill)", isKnownSubscriptionMerchant("Apple", "APPLE.COM/BILL"));
expectTrue("isKnownSubscriptionMerchant(Uber)=false", isKnownSubscriptionMerchant("Uber") === false);
expectTrue("isKnownSubscriptionMerchant(Anthropic)=false (curated, not legacy allowlist)",
  isKnownSubscriptionMerchant("Anthropic") === false);

// ─────────────────────────────────────────────────────────────────────────────
// 10. Catalog hygiene — no rule may target a flow-structural category
// ─────────────────────────────────────────────────────────────────────────────

const FORBIDDEN = new Set(["Income", "Transfer", "Payment", "Interest", "Buy", "Sell", "Dividend", "Split"]);
for (const rule of MERCHANT_RULES) {
  expectTrue(
    `catalog rule [${rule.tokens.join("|")}] targets a non-structural category (${rule.category})`,
    !FORBIDDEN.has(rule.category as string),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Report
// ─────────────────────────────────────────────────────────────────────────────

if (failures.length === 0) {
  console.log(`✓ merchant-rules: all ${passed} checks passed`);
  process.exit(0);
} else {
  console.error(`✗ merchant-rules: ${failures.length} failure(s), ${passed} passed:\n${failures.join("\n")}`);
  process.exit(1);
}
