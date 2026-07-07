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
 *   • the pure MI modules (resolver, backfill planner, enrichment) stay PURE
 *   • MI stamping (M4) is confined to the designated write sites only
 *   • NO AI read cutover (M6) and NO MerchantRule writes / user corrections (M5)
 *
 * If a later change starts M5 (user corrections) or M6 (read cutover) without
 * updating this test, it fails first — pinning "schema is additive/behavior-
 * neutral; M4 live stamping is confined to the designated write sites;
 * M5/M6 not started".
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

// ── 6. M4/M5 boundary: stamping + rule-writes confined to designated sites; M6 not started ─
{
  // Genuinely-pure MI modules (no client, data-shape identifiers only).
  const PURE_MI = new Set([
    "lib/transactions/merchant-resolver.ts",
    "lib/transactions/merchant-backfill.ts",
    "lib/transactions/merchant-enrichment.ts",
  ]);
  // The shared writer + the designated write sites that stamp MI onto a
  // Transaction (live paths + the M5 correction workflow). Any OTHER module
  // stamping these columns is a rogue write.
  const WRITE_SITES = new Set([
    "lib/transactions/merchant-write.ts",
    "lib/transactions/merchant-corrections.ts",
    "lib/plaid/syncTransactions.ts",
    "app/api/accounts/[id]/import/route.ts",
    "app/api/transactions/[id]/correct/route.ts",
  ]);
  // The M5 sites permitted to write MerchantRule rows (user corrections).
  const RULE_WRITE_SITES = new Set([
    "lib/transactions/merchant-corrections.ts",
  ]);
  const source = [
    ...collectSource(path.join(ROOT, "lib")),
    ...collectSource(path.join(ROOT, "app")),
  ]
    // Test modules are excluded by the .test.ts filter in collectSource.
    .map((f) => ({ f: path.relative(ROOT, f), text: readFileSync(f, "utf8") }));

  // (a) Merchant-table persistence goes through the shared writer only (which
  //     uses an injected `client`, not a module-level `prisma`/`db` handle).
  const tableAccess = source.filter((s) =>
    /\b(prisma|db)\.(merchant|merchantAlias|merchantRule)\b/.test(s.text),
  );
  check(
    "no module reaches the merchant tables via a global prisma/db handle",
    tableAccess.length === 0,
    tableAccess.map((s) => s.f).join(", "),
  );

  // (b) MI stamping is confined to the designated write sites + pure data shapes.
  const stamps = source.filter(
    (s) =>
      !PURE_MI.has(s.f) &&
      !WRITE_SITES.has(s.f) &&
      /\b(categorySource|categoryRuleId|merchantId)\s*:/.test(s.text),
  );
  check(
    "MI columns are stamped only by the designated write sites (no rogue stamping)",
    stamps.length === 0,
    stamps.map((s) => s.f).join(", "),
  );

  // (c) The pure MI modules are PURE — no db client import, no prisma calls.
  for (const f of PURE_MI) {
    const mod = source.find((s) => s.f === f);
    check(`${f} exists`, mod !== undefined);
    if (mod) {
      check(`${f} imports no db client`, !/["']@\/lib\/db["']/.test(mod.text));
      check(`${f} calls no prisma.*`, !/\bprisma\./.test(mod.text));
    }
  }

  // (d) M6 boundary — NO read cutover: the AI assembler does not consume resolved
  //     merchant identity yet.
  const assemblers = source.filter((s) => /^lib\/ai\/assemblers\//.test(s.f));
  const readCutover = assemblers.filter((s) =>
    /merchant-resolver|merchant-write|resolvedMerchant|\.merchantId\b/.test(s.text),
  );
  check(
    "no AI read cutover to resolved merchant identity yet (M6 not started)",
    readCutover.length === 0,
    readCutover.map((s) => s.f).join(", "),
  );

  // (e) M5 boundary — MerchantRule writes (user corrections) are confined to the
  //     correction workflow; no other module creates/updates rules, and no
  //     category-rewrite helper exists.
  const ruleWrites = source.filter(
    (s) =>
      !RULE_WRITE_SITES.has(s.f) &&
      /\b(prisma|db|client|tx)\.merchantRule\.(create|createMany|update|updateMany|upsert)\b/.test(s.text),
  );
  check(
    "MerchantRule writes are confined to the M5 correction workflow",
    ruleWrites.length === 0,
    ruleWrites.map((s) => s.f).join(", "),
  );
  const rewrite = source.filter(
    (s) => !PURE_MI.has(s.f) && /(function|const)\s+buildCategoryRewrite\b/.test(s.text),
  );
  check("no category-rewrite helper exists yet (deferred)", rewrite.length === 0, rewrite.map((s) => s.f).join(", "));
}

// ── 7. Summary ───────────────────────────────────────────────────────────────
if (failures === 0) {
  console.log("\nMI1 M1 schema: all tripwires passed.");
  process.exit(0);
} else {
  console.error(`\nMI1 M1 schema: ${failures} tripwire(s) FAILED.`);
  process.exit(1);
}
