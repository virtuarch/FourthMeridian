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
// with null/UNKNOWN INCLUDED.
//
// ⚠️ v2.6-POP-1 — this block used to add: "This is the exact meaning of the Prisma
// fragment `flowType: { not: INVESTMENT }` (scalar `not` returns null rows too)."
// That sentence was false, and asserting it HERE — in the file that claimed to pin
// the predicate and the query "in lockstep" — is why nobody checked. `not` compiles
// to `NOT (flowType = 'INVESTMENT')`, SQL UNKNOWN for NULL, so the query silently
// excluded every unclassified row while this test proved the predicate includes it.
//
// A prose claim is not a lockstep test. The two definitions are now compared by
// EXECUTING the query against a database: scripts/audit-banking-population.ts,
// REQUIRED tier, run in CI on every PR. What remains below is the pure half — the
// predicate's own behaviour — which is all a database-free test can honestly assert.

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
// 2. Source tripwires — the banking population + the reads that apply it
// ---------------------------------------------------------------------------
//
// v2.6-OWN-2 — `BANKING_POPULATION` and `bankingTransactionWhere` MOVED to
// lib/data/banking-population.ts, byte-identical, so read-only audits can import
// the canonical population without reaching `server-only` (lib/data/transactions.ts
// → lib/space → lib/auth). lib/data/transactions.ts re-exports both, so no
// consumer moved. The tripwires below split accordingly: the FRAGMENT is checked
// where it now lives, the READS where they still live.

const DATA_TX  = ["lib", "data", "transactions.ts"];
const dataCode = codeOf(DATA_TX);
const POPULATION = ["lib", "data", "banking-population.ts"];
const populationCode = codeOf(POPULATION);

// The canonical fragment is defined once and applied by the banking reads.
// v2.6-POP-1 — the fragment is an OR with TWO arms, and both are load-bearing.
// It was `flowType: { not: FlowType.INVESTMENT }` alone, which drops NULLs
// (`NOT (flowType = 'INVESTMENT')` is SQL UNKNOWN for null), silently excluding
// every unclassified row from every banking surface.
check(
  "BANKING_POPULATION excludes INVESTMENT",
  /flowType:\s*\{\s*not:\s*FlowType\.INVESTMENT\s*\}/.test(populationCode),
  "the population must exclude investment security-activity",
);
check(
  "BANKING_POPULATION explicitly ADMITS unclassified rows (flowType: null)",
  /\{\s*flowType:\s*null\s*\}/.test(populationCode),
  "a bare `not: INVESTMENT` drops NULLs — the null arm is what keeps unclassified " +
  "rows visible to review / needs-classification. Proven against a DB by " +
  "scripts/audit-banking-population.ts (INV-P1/P3).",
);
check(
  "BANKING_POPULATION is not a category allow-list",
  !/category:\s*\{/.test(populationCode),
  "the population is decided by FlowType, never by provider category",
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
    endMarker: "function resolveAccountName(",
  },
];

// TX-2 — the population + structural filters now live in the shared
// `bankingTransactionWhere` builder; the loaders delegate to it (DRY). Verify
// BOTH: the builder carries the invariants, AND each loader applies it. The
// semantic guarantee (population/visibility/soft-delete) is unchanged — only its
// location moved.
// `bankingTransactionWhere` is the last declaration in banking-population.ts, so
// the slice runs to end-of-file (bodyBetween returns the tail when the end marker
// is absent). Passing a marker that cannot occur states that intent explicitly.
const whereBody = bodyBetween(populationCode, "export function bankingTransactionWhere(", "\n// END-OF-MODULE-SENTINEL");
check("bankingTransactionWhere: body located", whereBody.length > 0, "could not slice the shared where-builder");
// v2.6-POP-1 — composed with AND, never object-spread. Both the population
// fragment and eventProjectionWhere() carry an `OR`; spreading two objects that
// share a key keeps only the LAST, so `{ ...eventProjectionWhere(), ...BANKING_POPULATION }`
// would silently drop the event-projection filter and let every total
// double-count a pending row and its posting. This guard is the only thing
// standing between that shape and a green build.
check(
  "bankingTransactionWhere: applies the canonical FlowType population fragment",
  /\bBANKING_POPULATION\b/.test(whereBody),
  "the shared where must apply the FlowType population fragment, not a category filter",
);
check(
  "bankingTransactionWhere: composes with AND, never object-spread (OR-collision safety)",
  /AND:\s*\[/.test(whereBody) && !/\.\.\.BANKING_POPULATION\b/.test(whereBody) && !/\.\.\.eventProjectionWhere\(\)/.test(whereBody),
  "spreading two OR-bearing fragments into one object silently drops the first — " +
  "the population and the event projection must be ANDed",
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

// ---------------------------------------------------------------------------
// 4. v2.6-POP-1 — the unclassified fixture must survive
// ---------------------------------------------------------------------------
//
// The seed classifies through the canonical classifier now, which is what makes
// it resemble production. That removes the accident that exposed the null-drop
// defect: a corpus that was 100% unclassified.
//
// So the seed keeps a DELIBERATE unclassified fixture, and this guard keeps the
// fixture. Without it the next person deletes three odd-looking rows, INV-P3 in
// audit-banking-population goes vacuous (it warns rather than fails, correctly —
// a real corpus may legitimately have none), and the regression test for a
// silent, self-concealing data-visibility bug evaporates with no red anywhere.
//
// Fails CLOSED on purpose: removing the fixture is a decision, not a cleanup.
const SEED = ["prisma", "seed.ts"];
const seedCode = codeOf(SEED);
check(
  "prisma/seed.ts still declares the unclassified fixture helper",
  /const unclassifiedTx\s*=/.test(seedCode),
  "the helper that produces deliberately-unclassified seed rows was removed",
);
check(
  "prisma/seed.ts still seeds unclassified fixture rows",
  (seedCode.match(/unclassifiedTx\(/g) ?? []).length >= 2,
  "fewer than two fixture rows remain — the null-flowType path is no longer seeded, " +
  "so audit-banking-population INV-P3 would pass vacuously",
);
check(
  "prisma/seed.ts classifies through the CANONICAL classifier (no seed-local logic)",
  /buildFlowWriteFields\(classifyFlow\(/.test(seedCode),
  "the seed must classify via buildFlowInputFromRow → classifyFlow → buildFlowWriteFields, " +
  "the same chain the Plaid sync and the CSV import run",
);

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll P2-2 transaction-population invariants passed.");
