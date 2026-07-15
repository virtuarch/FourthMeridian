/**
 * lib/legacy-account-invariants.test.ts
 *
 * A1-S2 source-scan invariant (no DOM/DB runner needed).
 * Standalone tsx script:  npx tsx lib/legacy-account-invariants.test.ts
 *
 * Guards the *safe-to-retire count paths* that A1-S1 migrated off the legacy
 * `Account` model. On current data all account creation is canonical
 * (FinancialAccount + SpaceAccountLink), so a legacy `Space.accounts`
 * relation-count or a `db.account.count()` counts only legacy `Account` rows —
 * i.e. systematically ~0, a user-facing undercount. This test pins those paths
 * to the canonical form (ACTIVE `SpaceAccountLink` with a live
 * `FinancialAccount`, or `db.financialAccount.count`) and fails CI if a legacy
 * read is reintroduced in any of them.
 *
 * SCOPE (deliberately narrow): only the count paths A1-S1 converted. This test
 * does NOT police the dual-read Transaction/Holding compatibility OR arms
 * (`lib/data/transactions.ts`, `lib/transactions/detail-query.ts`, the AI
 * assemblers, …) — those legacy reads are intentionally retained until the
 * Phase-0 prod gates are recorded (A1-S4 / the deferred DB milestone). Adding
 * more files here should track that retirement, not pre-empt it.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

let failures = 0;
function check(name: string, ok: boolean, detail?: string): void {
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name}`);
  if (!ok) {
    failures++;
    if (detail) console.log(`        ${detail}`);
  }
}

const ROOT = process.cwd();

/** Strip block + line comments so prose that mentions the banned tokens (this
 *  file's own migration comments) never trips a check — only real code counts. */
function codeOf(rel: string[]): string {
  const src = readFileSync(path.join(ROOT, ...rel), "utf8");
  return src.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");
}

// The safe-to-retire count paths converted by A1-S1.
const COUNT_PATHS: { label: string; rel: string[] }[] = [
  { label: "dashboard/spaces/page.tsx", rel: ["app", "(shell)", "dashboard", "spaces", "page.tsx"] },
  { label: "admin/page.tsx",            rel: ["app", "admin", "page.tsx"] },
  { label: "api/admin/overview",        rel: ["app", "api", "admin", "overview", "route.ts"] },
  { label: "api/admin/spaces",          rel: ["app", "api", "admin", "spaces", "route.ts"] },
  { label: "api/admin/users",           rel: ["app", "api", "admin", "users", "route.ts"] },
];

// ── Negative invariants: no legacy `Account` / `Space.accounts` reads ─────────
//
// `account` here is the lowercase Prisma delegate for the legacy `Account`
// model. `financialAccount` / `spaceAccountLink` carry a capital A in
// "Account", so the lowercase-anchored patterns below never match them.
const LEGACY_MODEL_READ =
  /\baccount\.(count|findMany|findFirst|findUnique|aggregate|groupBy|create|createMany|update|updateMany|upsert|delete|deleteMany)\b/;
// `select: { accounts …` — the legacy `Space.accounts` relation inside a Prisma
// select or _count select. The canonical form is `accountLinks`. (Response
// reshaping like `_count: { accounts: … }` has no `select:` prefix and is fine.)
const LEGACY_RELATION_SELECT = /select:\s*\{\s*accounts\b/;
// `accounts: true` — relation-count shorthand.
const LEGACY_RELATION_COUNT_SHORTHAND = /\baccounts:\s*true\b/;
// `accounts: { where|select|include|orderBy … }` — legacy relation include.
// (Reshaping like `accounts: accountLinks.map(…)` is `accounts: <ident>`, not
// `accounts: {`, so it is not matched.)
const LEGACY_RELATION_INCLUDE = /\baccounts:\s*\{\s*(where|select|include|orderBy)\b/;

for (const { label, rel } of COUNT_PATHS) {
  const code = codeOf(rel);
  check(`${label}: no legacy db.account.* read`, !LEGACY_MODEL_READ.test(code),
    "use db.financialAccount.count({ where: { deletedAt: null } }) for totals");
  check(`${label}: no legacy Space.accounts _count/select`, !LEGACY_RELATION_SELECT.test(code),
    "count ACTIVE SpaceAccountLink (accountLinks) instead");
  check(`${label}: no 'accounts: true' relation-count shorthand`, !LEGACY_RELATION_COUNT_SHORTHAND.test(code));
  check(`${label}: no legacy 'accounts: { where|select|… }' include`, !LEGACY_RELATION_INCLUDE.test(code));
}

// ── Positive invariants: the canonical form is present ───────────────────────
// Every per-space count path filters ACTIVE links to a live FinancialAccount.
const CANONICAL_LINK_COUNT = /accountLinks:\s*\{\s*where:\s*\{\s*status:\s*["']ACTIVE["'],\s*financialAccount:\s*\{\s*deletedAt:\s*null\s*\}/;
for (const { label, rel } of COUNT_PATHS) {
  const code = codeOf(rel);
  check(`${label}: uses canonical ACTIVE + live-FinancialAccount link count`,
    CANONICAL_LINK_COUNT.test(code),
    "expected accountLinks: { where: { status: 'ACTIVE', financialAccount: { deletedAt: null } } }");
}

// The two system-wide totals use the canonical FinancialAccount count.
for (const rel of [["app", "admin", "page.tsx"], ["app", "api", "admin", "overview", "route.ts"]]) {
  const code = codeOf(rel);
  check(`${rel.join("/")}: system total via db.financialAccount.count`,
    /financialAccount\.count\(\s*\{\s*where:\s*\{\s*deletedAt:\s*null\s*\}\s*\}\s*\)/.test(code));
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll legacy-Account count-path invariants passed.");
