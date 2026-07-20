/**
 * lib/data/transactions.population.test.ts
 *
 * P2-2 source-scan invariant (pure, no DB — standalone tsx script):
 *
 *     npx tsx lib/data/transactions.population.test.ts
 *
 * Guards the transaction-truth-spine population cutover: the BANKING reads decide a
 * row's eligibility for canonical financial analysis by canonical FlowType, NOT by a
 * provider/category allow-list. The desired architecture is
 *
 *     provider/import row → persisted FlowType → flow predicate → DayFacts / consumers
 *
 * NOT
 *
 *     provider/import row → legacy BANKING_CATEGORIES allow-list → maybe reaches semantics
 *
 * Two layers, mirroring lib/data/transactions.privacy.test.ts:
 *   1. Predicate/query lockstep — the pure row-level rule (isBankingPopulation) and
 *      the Prisma fragment the reads apply (`flowType: { not: INVESTMENT }`) agree,
 *      including the null/UNKNOWN case (Prisma scalar `not` returns null rows).
 *   2. Source tripwires — the banking reads carry the FlowType population rule and
 *      NO category gate, while STRUCTURAL filters (deletedAt, Space-visibility) are
 *      preserved, and no BANKING_CATEGORIES-style provider list is used as a
 *      `category: { in: … }` semantic population gate anywhere. Presentation/provider
 *      uses of BANKING_CATEGORIES (the filter dropdown, drilldown phrase resolution)
 *      remain legitimate and are explicitly allowed.
 *
 * DB-backed row behavior is covered by the existing integration scripts; this file
 * pins the WHERE-clause shape so a future edit cannot reintroduce a category
 * population gate without failing CI. Exits 0 on pass, 1 on failure.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import { FlowType } from "@prisma/client";
import { isBankingPopulation } from "../transactions/flow-predicates";

let failures = 0;
function check(name: string, ok: boolean, detail?: string): void {
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name}`);
  if (!ok) {
    failures++;
    if (detail) console.log(`        ${detail}`);
  }
}

const ROOT = process.cwd();

/** Strip block + line comments so prose that mentions the banned tokens (the
 *  migration comments this slice adds) never trips a check — only real code counts. */
function codeOf(rel: string[]): string {
  const src = readFileSync(path.join(ROOT, ...rel), "utf8");
  return src.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");
}

/** Extract a function's code body between its signature and the next top-level
 *  declaration, so per-function tripwires don't bleed across functions. */
function bodyBetween(code: string, startMarker: string, endMarker: string): string {
  const start = code.indexOf(startMarker);
  if (start < 0) return "";
  const end = code.indexOf(endMarker, start + startMarker.length);
  return code.slice(start, end < 0 ? undefined : end);
}

// ---------------------------------------------------------------------------
// 1. Predicate / query lockstep (pure)
// ---------------------------------------------------------------------------
// The banking population = every FlowType EXCEPT pure investment security-activity,
// with null/UNKNOWN INCLUDED. This is the exact meaning of the Prisma fragment
// `flowType: { not: INVESTMENT }` (scalar `not` returns null rows too).

const ALL_FLOWS: (FlowType | null)[] = [...(Object.values(FlowType) as FlowType[]), null];

for (const ft of ALL_FLOWS) {
  const label = ft ?? "null";
  check(
    `isBankingPopulation(${label}) === (${label} !== INVESTMENT)`,
    isBankingPopulation(ft) === (ft !== FlowType.INVESTMENT),
  );
}
check(
  "INVESTMENT is the ONLY flow excluded from the banking population",
  (Object.values(FlowType) as FlowType[]).filter((ft) => !isBankingPopulation(ft)).join(",") ===
    FlowType.INVESTMENT,
  "exactly one excluded flow (INVESTMENT) — the banking/investment split",
);
check(
  "UNKNOWN stays in the banking population (visible to review/needs-classification)",
  isBankingPopulation(FlowType.UNKNOWN) === true,
);
check(
  "null/unclassified stays in the banking population",
  isBankingPopulation(null) === true,
);

// ---------------------------------------------------------------------------
// 2. Source tripwires — lib/data/transactions.ts banking reads
// ---------------------------------------------------------------------------

const DATA_TX = ["lib", "data", "transactions.ts"];
const dataCode = codeOf(DATA_TX);

// The canonical fragment is defined once and applied by the banking reads.
check(
  "BANKING_POPULATION fragment is `flowType: { not: FlowType.INVESTMENT }`",
  /BANKING_POPULATION\s*=\s*\{\s*flowType:\s*\{\s*not:\s*FlowType\.INVESTMENT\s*\}\s*\}/.test(dataCode),
  "the single population fragment must be a FlowType exclusion, not a category list",
);

// The dead local BANKING_CATEGORIES allow-list is gone from this module.
check(
  "lib/data/transactions.ts no longer declares a local BANKING_CATEGORIES allow-list",
  !/\bBANKING_CATEGORIES\b/.test(dataCode),
  "the category population authority was deleted; presentation copy lives in the filter constants",
);

const BANKING_READS: { label: string; startMarker: string; endMarker: string }[] = [
  {
    label: "getTransactions",
    startMarker: "export async function getTransactions(",
    endMarker: "function deriveSource(",
  },
  {
    label: "getDebtTransactions",
    startMarker: "export async function getDebtTransactions(",
    endMarker: "export async function getInvestmentTransactions(",
  },
];

// TX-2 — the population + structural filters now live in the shared
// `bankingTransactionWhere` builder; the loaders delegate to it (DRY). Verify
// BOTH: the builder carries the invariants, AND each loader applies it. The
// semantic guarantee (population/visibility/soft-delete) is unchanged — only its
// location moved.
const whereBody = bodyBetween(dataCode, "export function bankingTransactionWhere(", "export async function getTransactions(");
check("bankingTransactionWhere: body located", whereBody.length > 0, "could not slice the shared where-builder");
check(
  "bankingTransactionWhere: applies the canonical FlowType population fragment (...BANKING_POPULATION)",
  /\.\.\.BANKING_POPULATION\b/.test(whereBody),
  "the shared where must spread the FlowType population fragment, not a category filter",
);
check(
  "bankingTransactionWhere: no category:{ } gate (population is FlowType, not provider category)",
  !/\bcategory:\s*\{/.test(whereBody),
);
check(
  "bankingTransactionWhere: preserves deletedAt: null (import-rollback soft-delete)",
  /\bdeletedAt:\s*null\b/.test(whereBody),
);
check(
  "bankingTransactionWhere: preserves SpaceAccountLink transaction-detail visibility gate",
  /visibilityLevel:\s*\{\s*in:\s*TRANSACTION_DETAIL_VISIBILITY\s*\}/.test(whereBody),
  "the KD-15 visibility predicate must remain on the SAL path",
);

for (const { label, startMarker, endMarker } of BANKING_READS) {
  const body = bodyBetween(dataCode, startMarker, endMarker);
  check(`${label}: body located`, body.length > 0, `could not slice ${label} body`);

  // Each loader applies the shared population/visibility/soft-delete via the builder.
  check(
    `${label}: applies the shared banking population via bankingTransactionWhere()`,
    /bankingTransactionWhere\(/.test(body),
    "the loader must delegate to the shared where-builder (population + visibility + deletedAt)",
  );

  // No category gate — the whole point of the cutover.
  check(
    `${label}: no category:{ } gate (population is FlowType, not provider category)`,
    !/\bcategory:\s*\{/.test(body),
    "a category population gate was reintroduced — use the FlowType rule",
  );

  // TX-2 — the read is bounded (a row cap / truncation sentinel), never unbounded.
  check(
    `${label}: is bounded (take: limit + 1)`,
    /take:\s*limit\s*\+\s*1/.test(body),
    "the loader must fetch a bounded page (limit + 1 sentinel), not the full history",
  );
}

// ---------------------------------------------------------------------------
// 3. Repo-wide invariant — BANKING_CATEGORIES is never a semantic population gate
// ---------------------------------------------------------------------------
// Legitimate presentation/provider uses (BANKING_CATEGORIES.map for the dropdown,
// the drilldown phrase→category loop) are allowed; using the list as a Prisma
// `category: { in: BANKING_CATEGORIES }` query filter is the banned regression.

const POPULATION_GATE_SITES: string[][] = [
  ["lib", "data", "transactions.ts"],
  ["lib", "ai", "assemblers", "transactions.ts"],
  ["components", "dashboard", "widgets", "transactions", "transactions-filter-constants.ts"],
  ["components", "dashboard", "widgets", "transactions", "TransactionsFilterOverlay.tsx"],
  ["components", "dashboard", "widgets", "SpaceTransactionsPanel.tsx"],
];
const CATEGORY_IN_LIST = /category:\s*\{\s*in:\s*[A-Z_]*CATEGORIES\b/;
for (const rel of POPULATION_GATE_SITES) {
  const code = codeOf(rel);
  check(
    `${rel.join("/")}: no category:{ in: *CATEGORIES } population gate`,
    !CATEGORY_IN_LIST.test(code),
    "provider/category lists may drive presentation, never row eligibility",
  );
}

// ---------------------------------------------------------------------------
// 4. Presentation is retained (we did not strip display/search filtering)
// ---------------------------------------------------------------------------

const FILTER_CONSTS = ["components", "dashboard", "widgets", "transactions", "transactions-filter-constants.ts"];
const filterCode = codeOf(FILTER_CONSTS);
check(
  "presentation BANKING_CATEGORIES vocabulary is retained for the filter dropdown",
  /export const BANKING_CATEGORIES\s*:/.test(filterCode),
  "the category filter options must still exist (presentation, not population)",
);
const PANEL = ["components", "dashboard", "widgets", "SpaceTransactionsPanel.tsx"];
// TX-3.3 — the user-selected category filter is still applied, but it MOVED: the
// explorer no longer evaluates `tx.category !== catFilter` over a client array, it
// sends `category` as a validated server query param. The invariant this guard
// protects (the presentation-only category filter must survive the population
// cutover) is unchanged; only its mechanism is. Assert the state AND its wiring
// into the server query, so deleting the filter still fails here.
check(
  "SpaceTransactionsPanel still applies the user-selected category filter (now a server param)",
  /setCatFilter/.test(codeOf(PANEL)) && /category:\s*catFilter/.test(codeOf(PANEL)),
  "the presentation-only category filter must not be removed by the population cutover",
);

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll P2-2 transaction-population invariants passed.");
