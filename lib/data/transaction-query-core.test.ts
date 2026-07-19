/**
 * lib/data/transaction-query-core.test.ts  (TX-3.0)
 *
 * Pure unit tests for the Transaction Explorer query contract — no DB. Proves the
 * ordering + keyset guarantees that make server-side paging correct:
 *   - scale guard: limit is always clamped to [1, MAX]
 *   - ordering: each sort is a strict total order (sort key + id)
 *   - keyset WHERE: the right comparators per sort/direction
 *   - filters: every TransactionQuery field maps to the right WHERE fragment
 *   - PAGINATION INVARIANTS (the core proof): across simulated pages the keyset
 *     never duplicates a row, never skips a row, and orders same-day rows by id.
 *
 *   npx tsx lib/data/transaction-query-core.test.ts
 */

import {
  clampLimit,
  MAX_TRANSACTION_PAGE_SIZE,
  DEFAULT_TRANSACTION_PAGE_SIZE,
  orderByForSort,
  keysetWhere,
  buildFilterWhere,
  compareForSort,
  afterCursorMatches,
  cursorFromRow,
  nextCursorFrom,
  toDbDate,
  type TransactionSort,
  type KeyedRow,
} from "./transaction-query-core";

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}`); }
}
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

const SORTS: TransactionSort[] = ["newest", "oldest", "largest", "smallest"];

console.log("SCALE GUARD — limit clamped to [1, MAX]");
{
  check("undefined → default", clampLimit(undefined) === DEFAULT_TRANSACTION_PAGE_SIZE);
  check("over MAX → MAX", clampLimit(10_000) === MAX_TRANSACTION_PAGE_SIZE);
  check("MAX is 100", MAX_TRANSACTION_PAGE_SIZE === 100);
  check("zero → 1", clampLimit(0) === 1);
  check("negative → 1", clampLimit(-5) === 1);
  check("in-range preserved", clampLimit(25) === 25);
  check("float floored", clampLimit(25.9) === 25);
  check("NaN → default", clampLimit(NaN) === DEFAULT_TRANSACTION_PAGE_SIZE);
}

console.log("ORDERING — strict total order (sort key + id tie-break)");
{
  check("newest", eq(orderByForSort("newest"), [{ date: "desc" }, { id: "desc" }]));
  check("oldest", eq(orderByForSort("oldest"), [{ date: "asc" }, { id: "asc" }]));
  check("largest", eq(orderByForSort("largest"), [{ amount: "desc" }, { id: "desc" }]));
  check("smallest", eq(orderByForSort("smallest"), [{ amount: "asc" }, { id: "asc" }]));
  check("every sort ends with an id tie-break", SORTS.every((s) => {
    const ob = orderByForSort(s);
    return "id" in ob[ob.length - 1];
  }));
}

console.log("KEYSET WHERE — first page null; correct comparators per sort");
{
  check("no cursor → null (first page)", keysetWhere("newest", undefined) === null);
  const D = toDbDate("2026-06-01");
  check("newest → (date lt) OR (date eq, id lt)",
    eq(keysetWhere("newest", { lastDate: "2026-06-01", lastId: "x" }),
       { OR: [{ date: { lt: D } }, { date: D, id: { lt: "x" } }] }));
  check("oldest → (date gt) OR (date eq, id gt)",
    eq(keysetWhere("oldest", { lastDate: "2026-06-01", lastId: "x" }),
       { OR: [{ date: { gt: D } }, { date: D, id: { gt: "x" } }] }));
  check("largest → (amount lt) OR (amount eq, id lt)",
    eq(keysetWhere("largest", { lastDate: "2026-06-01", lastId: "x", lastAmount: -50 }),
       { OR: [{ amount: { lt: -50 } }, { amount: -50, id: { lt: "x" } }] }));
  check("smallest → (amount gt) OR (amount eq, id gt)",
    eq(keysetWhere("smallest", { lastDate: "2026-06-01", lastId: "x", lastAmount: -50 }),
       { OR: [{ amount: { gt: -50 } }, { amount: -50, id: { gt: "x" } }] }));
  check("amount sort without lastAmount → null (no unsafe keyset)",
    keysetWhere("largest", { lastDate: "2026-06-01", lastId: "x" }) === null);
}

console.log("FILTER WHERE — every field maps to the right fragment (population stays separate)");
{
  check("empty query → empty where", eq(buildFilterWhere({ sort: "newest" }), {}));
  check("dateFrom/dateTo → date gte/lte",
    eq(buildFilterWhere({ sort: "newest", dateFrom: "2026-01-01", dateTo: "2026-02-01" }).date,
       { gte: toDbDate("2026-01-01"), lte: toDbDate("2026-02-01") }));
  check("accountIds → financialAccountId in",
    eq(buildFilterWhere({ sort: "newest", accountIds: ["a", "b"] }).financialAccountId, { in: ["a", "b"] }));
  check("empty accountIds → no financialAccountId key",
    buildFilterWhere({ sort: "newest", accountIds: [] }).financialAccountId === undefined);
  check("flowTypes → flowType in (NOT the population's not:INVESTMENT — ANDed separately)",
    eq((buildFilterWhere({ sort: "newest", flowTypes: ["SPENDING" as never] }).flowType), { in: ["SPENDING"] }));
  check("categories → category in",
    eq(buildFilterWhere({ sort: "newest", categories: ["Dining"] }).category, { in: ["Dining"] }));
  check("pending true → pending:true", buildFilterWhere({ sort: "newest", pending: true }).pending === true);
  check("pending false → pending:false", buildFilterWhere({ sort: "newest", pending: false }).pending === false);
  check("pending omitted → no pending key", buildFilterWhere({ sort: "newest" }).pending === undefined);
  check("merchantId → merchantId", buildFilterWhere({ sort: "newest", merchantId: "m1" }).merchantId === "m1");
  const txt = buildFilterWhere({ sort: "newest", text: "coffee" }).OR;
  check("text → OR over merchant/description/resolved name (insensitive)",
    Array.isArray(txt) && txt.length === 3
    && eq(txt[0], { merchant: { contains: "coffee", mode: "insensitive" } })
    && eq(txt[2], { resolvedMerchant: { displayName: { contains: "coffee", mode: "insensitive" } } }));
  check("blank text → no OR", buildFilterWhere({ sort: "newest", text: "   " }).OR === undefined);
}

// ── PAGINATION INVARIANTS — the correctness proof ───────────────────────────
// Synthetic dataset with MANY same-day rows (ties on date, distinct ids) plus
// multi-day + duplicate amounts, so every tie-break path is exercised.
const rows: KeyedRow[] = [
  { id: "b", date: toDbDate("2026-06-03"), amount: -10 },
  { id: "a", date: toDbDate("2026-06-03"), amount: -10 }, // same day + same amount as b
  { id: "c", date: toDbDate("2026-06-03"), amount: 200 }, // same day, different amount
  { id: "d", date: toDbDate("2026-06-02"), amount: -5 },
  { id: "e", date: toDbDate("2026-06-02"), amount: -5 },  // same day + same amount as d
  { id: "f", date: toDbDate("2026-06-01"), amount: 999 },
  { id: "g", date: toDbDate("2026-05-31"), amount: -1 },
];

function fullSorted(sort: TransactionSort): KeyedRow[] {
  return [...rows].sort((a, b) => compareForSort(a, b, sort));
}

// Walk the whole dataset page-by-page through the KEYSET path and reassemble it.
function pageThrough(sort: TransactionSort, pageSize: number): KeyedRow[] {
  const out: KeyedRow[] = [];
  let cursor = undefined as ReturnType<typeof cursorFromRow> | undefined;
  let guard = 0;
  while (guard++ < 100) {
    // Candidates strictly after the cursor, ordered by the same comparator, then
    // fetch limit+1 to mirror the server's sentinel.
    const candidates = rows
      .filter((r) => (cursor ? afterCursorMatches(r, sort, cursor) : true))
      .sort((a, b) => compareForSort(a, b, sort));
    if (candidates.length === 0) break;
    const { pageRows, nextCursor, hasMore } = nextCursorFrom(candidates.slice(0, pageSize + 1), sort, pageSize);
    out.push(...pageRows);
    if (!hasMore || !nextCursor) break;
    cursor = nextCursor;
  }
  return out;
}

for (const sort of SORTS) {
  console.log(`PAGINATION — ${sort}: no duplicates, no missing rows, same-day ordered`);
  const expected = fullSorted(sort);
  const walked = pageThrough(sort, 2); // page size 2 → forces many boundaries

  check(`${sort}: reassembled sequence equals the full sorted order (no dup / no missing)`,
    eq(walked.map((r) => r.id), expected.map((r) => r.id)));
  check(`${sort}: every row appears exactly once`,
    walked.length === rows.length && new Set(walked.map((r) => r.id)).size === rows.length);

  // Same-day tie-break: the two 2026-06-03 rows a,b (identical amount) must be
  // adjacent and ordered by id per the sort direction.
  const ids = walked.map((r) => r.id);
  const ia = ids.indexOf("a"), ib = ids.indexOf("b");
  check(`${sort}: same-day+same-amount rows a,b are adjacent`, Math.abs(ia - ib) === 1);
  const idAsc = sort === "oldest" || sort === "smallest";
  check(`${sort}: a,b ordered by id ${idAsc ? "asc" : "desc"}`, idAsc ? ia < ib : ib < ia);
}

console.log("CURSOR — derived from the last kept row; null on the final page");
{
  const asc = fullSorted("newest");
  const firstThree = nextCursorFrom(asc.slice(0, 4), "newest", 3); // 3 kept + 1 sentinel
  check("hasMore when a sentinel row exists", firstThree.hasMore === true);
  check("nextCursor is the 3rd row's key", eq(firstThree.nextCursor, cursorFromRow(asc[2], "newest")));
  const lastPage = nextCursorFrom(asc.slice(0, 2), "newest", 3); // fewer than limit
  check("no sentinel → hasMore false + nextCursor null", lastPage.hasMore === false && lastPage.nextCursor === null);
  check("amount sort cursor carries lastAmount", cursorFromRow(rows[0], "largest").lastAmount === -10);
  check("date sort cursor omits lastAmount", cursorFromRow(rows[0], "newest").lastAmount === undefined);
}

if (failures > 0) { console.error(`\ntransaction-query-core: ${failures} failure(s).`); process.exit(1); }
console.log("\ntransaction-query-core: all passed.");
