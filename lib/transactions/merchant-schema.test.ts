/**
 * lib/transactions/merchant-schema.test.ts  (MI1 M1)
 *
 * Schema-scan tripwire for the Merchant Intelligence additive foundation.
 * Standalone tsx script (house pattern, mirrors lib/deletion-safety.test.ts):
 *
 *     npx tsx lib/transactions/merchant-schema.test.ts
 *
 * Exits 0 on pass / 1 on failure. Pure — no DB, no network, no Prisma client.
 * Reads prisma/schema.prisma as text and scans the lib/ + app/ source tree, and
 * asserts the M1 contract:
 *   • the approved enums / enum values exist
 *   • Transaction merchant/category-provenance columns exist and are NULLABLE
 *   • categorySource is nullable with NO default (MC1 Phase 0 provenance doctrine)
 *   • Merchant enrichment fields exist (storage shape only)
 *   • NO MerchantAsset model exists
 *   • the M2 resolver is PURE (no db import, no prisma calls) and nothing
 *     persists / writes the new schema yet (M4 not started)
 *   • NO UI/API consumes the new schema yet
 *
 * If a later change starts M2 (a resolver, a write, a read) without updating this
 * test, it fails first — pinning "schema is additive/behavior-neutral, and M2 is
 * a pure resolver with no persistence (M3/M4 not started)".
 *
 * Ratification: docs/initiatives/mi1/MI1_M0_RATIFICATION_2026-07-07.md.
 */

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const schema = readFileSync(path.join(ROOT, "prisma", "schema.prisma"), "utf8");

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/** Extract a model/enum body (between `<kind> X {` and its closing `}`). */
function block(kind: "model" | "enum", name: string): string {
  const m = schema.match(new RegExp(`${kind} ${name} \\{([\\s\\S]*?)\\n\\}`, "m"));
  if (!m) throw new Error(`${kind} ${name} not found in schema.prisma`);
  return m[1];
}

/** Recursively collect non-test .ts/.tsx files under a dir. */
function collectSource(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectSource(full));
    else if (
      (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) &&
      !entry.name.endsWith(".test.ts") &&
      !entry.name.endsWith(".test.tsx")
    ) {
      out.push(full);
    }
  }
  return out;
}

console.log("Merchant Intelligence M1 schema tripwires (MI1)");

// ── 1. Approved enums exist with exactly the approved values ─────────────────
{
  const cs = block("enum", "CategorySource");
  for (const v of ["PLAID_PFC", "USER_RULE", "GLOBAL_CATALOG", "PFC_SPEND_BUCKET", "USER_OVERRIDE", "LEGACY"]) {
    check(`CategorySource has ${v}`, new RegExp(`\\b${v}\\b`).test(cs));
  }
  const scope = block("enum", "MerchantRuleScope");
  check("MerchantRuleScope has USER", /\bUSER\b/.test(scope));
  check("MerchantRuleScope has SPACE", /\bSPACE\b/.test(scope));
  check("MerchantRuleScope deliberately omits GLOBAL", !/\bGLOBAL\b/.test(scope), "global catalog stays in code");

  const aliasSrc = block("enum", "MerchantAliasSource");
  for (const v of ["PLAID", "IMPORT", "USER"]) {
    check(`MerchantAliasSource has ${v}`, new RegExp(`\\b${v}\\b`).test(aliasSrc));
  }
  const enrich = block("enum", "MerchantEnrichmentSource");
  check("MerchantEnrichmentSource has PLAID_COUNTERPARTY (first source)", /\bPLAID_COUNTERPARTY\b/.test(enrich));
}

// ── 2. TransactionCategory expanded with the six committed spend categories ───
{
  const cat = block("enum", "TransactionCategory");
  for (const v of ["Medical", "Entertainment", "Transport", "PersonalCare", "Services", "Education"]) {
    check(`TransactionCategory has ${v}`, new RegExp(`^\\s*${v}\\s*$`, "m").test(cat));
  }
}

// ── 3. Transaction additive columns exist and are NULLABLE ───────────────────
{
  const tx = block("model", "Transaction");
  check("Transaction.merchantId exists and is nullable", /merchantId\s+String\?/.test(tx));
  check("Transaction.categoryRuleId exists and is nullable", /categoryRuleId\s+String\?/.test(tx));
  check(
    "Transaction.categorySource exists, is nullable, and has NO default",
    /categorySource\s+CategorySource\?(?![\s\S]*?@default)/.test(
      tx.match(/categorySource[^\n]*/)?.[0] ?? "",
    ) || (/categorySource\s+CategorySource\?/.test(tx) && !/categorySource[^\n]*@default/.test(tx)),
    "categorySource must be `CategorySource?` with no @default (null = pre-MI provenance unknown)",
  );
  check("Transaction.resolvedMerchant relation is onDelete: SetNull", /resolvedMerchant\s+Merchant\?[\s\S]*?onDelete:\s*SetNull/.test(tx));
  check("Transaction.categoryRule relation is onDelete: SetNull", /categoryRule\s+MerchantRule\?[\s\S]*?onDelete:\s*SetNull/.test(tx));
  check("Transaction has @@index([merchantId])", /@@index\(\[merchantId\]\)/.test(tx));
  check("Transaction has @@index([categoryRuleId])", /@@index\(\[categoryRuleId\]\)/.test(tx));
}

// ── 4. Merchant identity + enrichment (storage shape only) ───────────────────
{
  const m = block("model", "Merchant");
  check("Merchant.canonicalKey is @unique", /canonicalKey\s+String\s+@unique/.test(m));
  check("Merchant.plaidEntityId is nullable + @unique", /plaidEntityId\s+String\?\s+@unique/.test(m));
  for (const f of ["website", "logoUrl", "enrichmentSource", "enrichmentConfidence", "enrichedAt"]) {
    check(`Merchant enrichment field ${f} exists`, new RegExp(`\\b${f}\\b`).test(m));
  }
  check("Merchant.website is nullable", /website\s+String\?/.test(m));
  check("Merchant.logoUrl is nullable", /logoUrl\s+String\?/.test(m));
  check("Merchant.enrichmentSource is nullable", /enrichmentSource\s+MerchantEnrichmentSource\?/.test(m));
  check("Merchant.enrichmentConfidence is nullable", /enrichmentConfidence\s+Float\?/.test(m));
  check("Merchant.enrichedAt is nullable", /enrichedAt\s+DateTime\?/.test(m));

  block("model", "MerchantAlias");
  block("model", "MerchantRule");
  check("MerchantAlias.aliasKey is @unique", /aliasKey\s+String\s+@unique/.test(block("model", "MerchantAlias")));
}

// ── 5. NO MerchantAsset table (explicit non-goal) ────────────────────────────
check("no MerchantAsset model exists in schema", !/model\s+MerchantAsset\b/.test(schema));

// ── 6. M2 boundary: pure resolver exists; NO persistence / write / M3-M4 yet ─
{
  const RESOLVER = "lib/transactions/merchant-resolver.ts";
  const source = [
    ...collectSource(path.join(ROOT, "lib")),
    ...collectSource(path.join(ROOT, "app")),
  ]
    // Test modules are excluded by the .test.ts filter in collectSource.
    .map((f) => ({ f: path.relative(ROOT, f), text: readFileSync(f, "utf8") }));

  // (a) No persistence: nothing reads or writes the new tables (M4 owns that).
  const tableAccess = source.filter((s) =>
    /\bprisma\.(merchant|merchantAlias|merchantRule)\b/.test(s.text),
  );
  check(
    "no code queries prisma.merchant / merchantAlias / merchantRule (no persistence)",
    tableAccess.length === 0,
    tableAccess.map((s) => s.f).join(", "),
  );

  // (b) No WRITE path stamps the new columns onto a transaction. The M2 resolver
  //     returns them as PURE DATA (allowed); every other module must be clean.
  const stamps = source.filter(
    (s) => s.f !== RESOLVER && /\b(categorySource|categoryRuleId|merchantId)\s*:/.test(s.text),
  );
  check(
    "no write path stamps categorySource / categoryRuleId / merchantId (M4 not started)",
    stamps.length === 0,
    stamps.map((s) => s.f).join(", "),
  );

  // (c) The M2 resolver is PURE — imports no db client and calls no prisma.
  const resolver = source.find((s) => s.f === RESOLVER);
  check("M2 resolver module exists", resolver !== undefined);
  if (resolver) {
    check("M2 resolver imports no db client", !/["']@\/lib\/db["']/.test(resolver.text));
    check("M2 resolver calls no prisma.*", !/\bprisma\./.test(resolver.text));
  }

  // (d) No M3/M4 helpers exist yet (backfill / mint / write-time rewrite).
  const later = source.filter((s) =>
    /\b(buildCategoryRewrite|resolveMerchantIdentity|mintMerchant)\b/.test(s.text),
  );
  check(
    "no M3/M4 backfill/mint/rewrite helper exists yet",
    later.length === 0,
    later.map((s) => s.f).join(", "),
  );
}

// ── 7. Summary ───────────────────────────────────────────────────────────────
if (failures === 0) {
  console.log("\nMI1 M1 schema: all tripwires passed.");
  process.exit(0);
} else {
  console.error(`\nMI1 M1 schema: ${failures} tripwire(s) FAILED.`);
  process.exit(1);
}
