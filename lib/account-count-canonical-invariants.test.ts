/**
 * lib/account-count-canonical-invariants.test.ts
 *
 * Source-scan invariant (no DOM/DB runner needed).
 * Standalone tsx script:  npx tsx lib/account-count-canonical-invariants.test.ts
 *
 * Pins the per-Space / system account-count paths to the CANONICAL form —
 * ACTIVE `SpaceAccountLink` with a live `FinancialAccount`, or
 * `db.financialAccount.count` for system totals — and fails CI if any of them
 * regresses to a `Space.accounts` relation count or a `db.account.*` read.
 *
 * The legacy `Account` model was physically retired (PCS-3B, 2026-07-16), so a
 * `db.account.*` read no longer compiles; these negative checks remain as a
 * cheap, self-documenting tripwire against reintroducing the count anti-pattern
 * under any future name. The positive checks are the live guarantee: they keep
 * the count surfaces reading SpaceAccountLink/FinancialAccount so Space cards
 * and admin totals can never silently disagree with the canonical account set.
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
  // NOTE: api/admin/overview was retired (P1 closeout — superseded by the RSC
  // admin/page.tsx direct DB read); its A1 count invariants live on in the RSC
  // page and api/admin/spaces below.
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

// The system-wide total uses the canonical FinancialAccount count. (The former
// api/admin/overview mirror of this was retired in the P1 closeout; the RSC
// admin/page.tsx is now the sole system-total surface.)
for (const rel of [["app", "admin", "page.tsx"]]) {
  const code = codeOf(rel);
  check(`${rel.join("/")}: system total via db.financialAccount.count`,
    /financialAccount\.count\(\s*\{\s*where:\s*\{\s*deletedAt:\s*null\s*\}\s*\}\s*\)/.test(code));
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll legacy-Account count-path invariants passed.");
