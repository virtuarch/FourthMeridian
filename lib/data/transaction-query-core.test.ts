/**
 * lib/data/transaction-query-core.test.ts  (TX-3.0, extended TX-3.1b)
 *
 * Pure unit tests for the Transaction Explorer query contract — no DB. Proves the
 * ordering + keyset + parser guarantees that make server-side paging correct:
 *   - scale guard: limit is always clamped to [1, MAX]
 *   - ordering: each sort is a strict total order (date + id)
 *   - keyset WHERE: the right comparators per sort/direction
 *   - M1: amount sorting is GONE from the contract (doctrine tripwire)
 *   - M2: CURSOR SAFETY — a cursor never crosses sorts; no infinite-scroll dup
 *   - M3: PARSER SAFETY — malformed input never reaches Prisma
 *   - filters: every TransactionQuery field maps to the right WHERE fragment,
 *     and two OR-shaped filters can never overwrite each other
 *   - PAGINATION INVARIANTS (the core proof): across simulated pages the keyset
 *     never duplicates a row, never skips a row, and orders same-day rows by id.
 *
 *   npx tsx lib/data/transaction-query-core.test.ts
 */

import {
  clampLimit,
  MAX_TRANSACTION_PAGE_SIZE,
  DEFAULT_TRANSACTION_PAGE_SIZE,
  DEFAULT_TRANSACTION_SORT,
  TRANSACTION_SORTS,
  TRANSACTION_SOURCES,
  orderByForSort,
  keysetWhere,
  buildFilterWhere,
  sourceWhere,
  compareForSort,
  afterCursorMatches,
  cursorFromRow,
  nextCursorFrom,
  resolveCursor,
  isCursorCompatible,
  isValidISODate,
  encodeCursor,
  decodeCursor,
  parseTransactionQuery,
  toDbDate,
  type TransactionSort,
  type TransactionCursor,
  type KeyedRow,
} from "./transaction-query-core";

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}`); }
}
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

const SORTS: TransactionSort[] = ["newest", "oldest"];

// The vocabularies the parser validates against (injected — the pure module never
// imports the generated Prisma client).
const VOCAB = {
  flowTypes:  ["INCOME", "SPENDING", "TRANSFER", "INVESTMENT"],
  categories: ["Dining", "Groceries", "Travel", "Other"],
};
const qs = (s: string) => new URLSearchParams(s);

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

console.log("M1 DOCTRINE — amount sorting is not in the contract");
{
  // The product's "largest" is Math.abs(FX-converted); SQL can only order by the
  // signed native column. Those differ by SIGN even in a single-currency Space, and
  // Prisma cannot express ORDER BY abs(amount). Shipping it = shipping a wrong sort.
  check("only two sorts exist", eq([...TRANSACTION_SORTS], ["newest", "oldest"]));
  check("default sort is newest", DEFAULT_TRANSACTION_SORT === "newest");
  check('"largest" is rejected by the parser', (() => {
    const r = parseTransactionQuery(qs("sort=largest"), VOCAB);
    return r.ok === false && r.errors.some((e) => e.field === "sort");
  })());
  check('"smallest" is rejected by the parser', (() => {
    const r = parseTransactionQuery(qs("sort=smallest"), VOCAB);
    return r.ok === false;
  })());
  check("no orderBy fragment ever mentions amount",
    SORTS.every((s) => !JSON.stringify(orderByForSort(s)).includes("amount")));
}

console.log("ORDERING — strict total order (date + id tie-break)");
{
  check("newest", eq(orderByForSort("newest"), [{ date: "desc" }, { id: "desc" }]));
  check("oldest", eq(orderByForSort("oldest"), [{ date: "asc" }, { id: "asc" }]));
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
    eq(keysetWhere("newest", { sort: "newest", lastDate: "2026-06-01", lastId: "x" }),
       { OR: [{ date: { lt: D } }, { date: D, id: { lt: "x" } }] }));
  check("oldest → (date gt) OR (date eq, id gt)",
    eq(keysetWhere("oldest", { sort: "oldest", lastDate: "2026-06-01", lastId: "x" }),
       { OR: [{ date: { gt: D } }, { date: D, id: { gt: "x" } }] }));
}

// ── M2 — CURSOR SAFETY ──────────────────────────────────────────────────────
console.log("M2 CURSOR SAFETY — a cursor never crosses sorts");
{
  const newestCursor: TransactionCursor = { sort: "newest", lastDate: "2026-06-01", lastId: "x" };
  const oldestCursor: TransactionCursor = { sort: "oldest", lastDate: "2026-06-01", lastId: "x" };

  check("cursor carries the sort it was minted under",
    cursorFromRow({ id: "r1", date: toDbDate("2026-06-01") }, "oldest").sort === "oldest");

  check("compatible cursor accepted", isCursorCompatible("newest", newestCursor) === true);
  check("mismatched cursor rejected", isCursorCompatible("newest", oldestCursor) === false);
  check("absent cursor is trivially compatible", isCursorCompatible("newest", undefined) === true);

  check("resolveCursor: match → kept, no reset",
    eq(resolveCursor("newest", newestCursor), { cursor: newestCursor, reset: false }));
  check("resolveCursor: MISMATCH → dropped AND reported (explicit reset, not silent)",
    eq(resolveCursor("newest", oldestCursor), { cursor: null, reset: true }));
  check("resolveCursor: no cursor → no reset",
    eq(resolveCursor("newest", undefined), { cursor: null, reset: false }));

  // The pre-hardening bug this closes: a mismatched cursor must NEVER silently
  // produce a keyset predicate belonging to the other ordering.
  check("keysetWhere ignores a mismatched cursor (never a wrong window)",
    keysetWhere("newest", oldestCursor) === null);

  // Infinite-scroll duplication tripwire. A consumer that keeps sending a stale
  // cursor after switching sort would, if the mismatch were silent, receive page 1
  // forever and append it to itself. The reset flag is the signal that lets it
  // discard instead of concatenate — assert it is always raised.
  const stale = { sort: "oldest" as const, lastDate: "2026-06-03", lastId: "b" };
  let resets = 0;
  for (let i = 0; i < 3; i++) if (resolveCursor("newest", stale).reset) resets++;
  check("every request with a stale cursor raises reset (no silent page-1 loop)", resets === 3);
}

console.log("M2 CURSOR TRANSPORT — opaque token round-trip + tamper safety");
{
  const c: TransactionCursor = { sort: "oldest", lastDate: "2026-06-01", lastId: "abc" };
  check("round-trips exactly", eq(decodeCursor(encodeCursor(c)), c));
  check("token is opaque (not the raw id)", !encodeCursor(c).includes("abc"));
  check("garbage → null (never a throw)", decodeCursor("!!!not-base64!!!") === null);
  check("truncated → null", decodeCursor(encodeCursor(c).slice(0, 5)) === null);
  check("valid base64 of the wrong shape → null",
    decodeCursor(Buffer.from(JSON.stringify({ a: 1 })).toString("base64url")) === null);
  check("unknown sort in token → null (M1 doctrine holds at the wire)",
    decodeCursor(Buffer.from(JSON.stringify(["largest", "2026-06-01", "x"])).toString("base64url")) === null);
  check("invalid date in token → null",
    decodeCursor(Buffer.from(JSON.stringify(["newest", "2026-02-31", "x"])).toString("base64url")) === null);
}

// ── M3 — PARSER SAFETY ──────────────────────────────────────────────────────
console.log("M3 PARSER SAFETY — malformed input never reaches Prisma");
{
  check("empty params → defaults (sort=newest, nothing else set)", (() => {
    const r = parseTransactionQuery(qs(""), VOCAB);
    return r.ok && r.query.sort === "newest" && r.query.dateFrom === undefined
      && r.query.categories === undefined && r.query.limit === undefined;
  })());

  check("valid full query parses", (() => {
    const r = parseTransactionQuery(
      qs("sort=oldest&dateFrom=2026-01-01&dateTo=2026-02-01&accountIds=a,b&flowTypes=SPENDING&categories=Dining,Travel&pending=true&sources=plaid&merchantId=m1&text=coffee&limit=25"),
      VOCAB,
    );
    return r.ok
      && r.query.sort === "oldest"
      && r.query.dateFrom === "2026-01-01" && r.query.dateTo === "2026-02-01"
      && eq(r.query.accountIds, ["a", "b"])
      && eq(r.query.flowTypes, ["SPENDING"])
      && eq(r.query.categories, ["Dining", "Travel"])
      && r.query.pending === true
      && eq(r.query.sources, ["plaid"])
      && r.query.merchantId === "m1" && r.query.text === "coffee"
      && r.query.limit === 25;
  })());

  // The exact crash the parser exists to prevent: an unvalidated date reached
  // `new Date("junk")` → Invalid Date → Prisma throws → 500 on user input.
  check("rejects malformed date shape", (() => {
    const r = parseTransactionQuery(qs("dateFrom=junk"), VOCAB);
    return !r.ok && r.errors[0].field === "dateFrom";
  })());
  check("rejects an impossible calendar date (2026-02-31)",
    parseTransactionQuery(qs("dateFrom=2026-02-31"), VOCAB).ok === false);
  check("rejects month 13", parseTransactionQuery(qs("dateTo=2026-13-01"), VOCAB).ok === false);
  check("isValidISODate: real date", isValidISODate("2026-02-28") === true);
  check("isValidISODate: leap-day rollover rejected", isValidISODate("2025-02-29") === false);
  check("isValidISODate: wrong shape rejected", isValidISODate("2026-2-8") === false);
  check("rejects inverted range", (() => {
    const r = parseTransactionQuery(qs("dateFrom=2026-05-01&dateTo=2026-01-01"), VOCAB);
    return !r.ok && r.errors.some((e) => e.field === "dateFrom");
  })());

  // The other crash: `categories` was cast `as TransactionCategory[]` unchecked.
  check("rejects unknown category (no unchecked enum cast)", (() => {
    const r = parseTransactionQuery(qs("categories=Dining,NotACategory"), VOCAB);
    return !r.ok && r.errors.some((e) => e.field === "categories" && e.message.includes("NotACategory"));
  })());
  check("rejects unknown flow type", parseTransactionQuery(qs("flowTypes=NOPE"), VOCAB).ok === false);
  check("rejects unknown source", parseTransactionQuery(qs("sources=telepathy"), VOCAB).ok === false);
  check("rejects non-boolean pending", parseTransactionQuery(qs("pending=maybe"), VOCAB).ok === false);
  check("rejects non-numeric limit", parseTransactionQuery(qs("limit=lots"), VOCAB).ok === false);

  check("limit is CLAMPED, not rejected (a page size is a preference)", (() => {
    const r = parseTransactionQuery(qs("limit=99999"), VOCAB);
    return r.ok && r.query.limit === MAX_TRANSACTION_PAGE_SIZE;
  })());
  check("blank values are ignored, not errors", (() => {
    const r = parseTransactionQuery(qs("sort=&dateFrom=&text=&categories="), VOCAB);
    return r.ok && r.query.sort === "newest" && r.query.text === undefined;
  })());
  check("whitespace-only text is dropped",
    (() => { const r = parseTransactionQuery(qs("text=%20%20"), VOCAB); return r.ok && r.query.text === undefined; })());
  check("list values are trimmed and de-blanked", (() => {
    const r = parseTransactionQuery(qs("accountIds=a,%20,b,"), VOCAB);
    return r.ok && eq(r.query.accountIds, ["a", "b"]);
  })());
  check("errors accumulate across fields", (() => {
    const r = parseTransactionQuery(qs("dateFrom=junk&categories=Nope&pending=maybe"), VOCAB);
    return !r.ok && r.errors.length === 3;
  })());

  // Cursor handling at the parse boundary.
  check("valid cursor for the SAME sort is kept, no reset", (() => {
    const token = encodeCursor({ sort: "newest", lastDate: "2026-06-01", lastId: "x" });
    const r = parseTransactionQuery(qs(`sort=newest&cursor=${token}`), VOCAB);
    return r.ok && r.query.cursor?.lastId === "x" && r.cursorReset === false;
  })());
  check("cursor for a DIFFERENT sort is dropped and reported (M2 at the wire)", (() => {
    const token = encodeCursor({ sort: "oldest", lastDate: "2026-06-01", lastId: "x" });
    const r = parseTransactionQuery(qs(`sort=newest&cursor=${token}`), VOCAB);
    return r.ok && r.query.cursor === undefined && r.cursorReset === true;
  })());
  check("tampered cursor → reset, NOT a 500", (() => {
    const r = parseTransactionQuery(qs("cursor=@@@garbage@@@"), VOCAB);
    return r.ok && r.query.cursor === undefined && r.cursorReset === true;
  })());
}

console.log("FILTER WHERE — every field maps to the right fragment (population stays separate)");
{
  const frag = (q: Parameters<typeof buildFilterWhere>[0]) =>
    (buildFilterWhere(q).AND ?? []) as Record<string, unknown>[];

  check("empty query → empty where (no stray AND)", eq(buildFilterWhere({ sort: "newest" }), {}));
  check("dateFrom/dateTo → date gte/lte",
    eq(frag({ sort: "newest", dateFrom: "2026-01-01", dateTo: "2026-02-01" })[0],
       { date: { gte: toDbDate("2026-01-01"), lte: toDbDate("2026-02-01") } }));
  check("accountIds → financialAccountId in",
    eq(frag({ sort: "newest", accountIds: ["a", "b"] })[0], { financialAccountId: { in: ["a", "b"] } }));
  check("empty accountIds → no fragment", frag({ sort: "newest", accountIds: [] }).length === 0);
  check("flowTypes → flowType in (NOT the population's not:INVESTMENT — ANDed separately)",
    eq(frag({ sort: "newest", flowTypes: ["SPENDING" as never] })[0], { flowType: { in: ["SPENDING"] } }));
  check("categories → category in",
    eq(frag({ sort: "newest", categories: ["Dining" as never] })[0], { category: { in: ["Dining"] } }));
  check("pending true → pending:true", eq(frag({ sort: "newest", pending: true })[0], { pending: true }));
  check("pending false → pending:false", eq(frag({ sort: "newest", pending: false })[0], { pending: false }));
  check("pending omitted → no fragment", frag({ sort: "newest" }).length === 0);
  check("merchantId → merchantId", eq(frag({ sort: "newest", merchantId: "m1" })[0], { merchantId: "m1" }));

  const txt = frag({ sort: "newest", text: "coffee" })[0].OR as unknown[];
  check("text → OR over merchant/description/resolved name (insensitive)",
    Array.isArray(txt) && txt.length === 3
    && eq(txt[0], { merchant: { contains: "coffee", mode: "insensitive" } })
    && eq(txt[2], { resolvedMerchant: { displayName: { contains: "coffee", mode: "insensitive" } } }));
  check("blank text → no fragment", frag({ sort: "newest", text: "   " }).length === 0);
}

console.log("SOURCE FILTER — mirrors deriveSource precedence exactly");
{
  check("import → importBatchId not null",
    eq(sourceWhere(["import"]), { importBatchId: { not: null } }));
  check("plaid → no import batch AND a plaid id",
    eq(sourceWhere(["plaid"]), { importBatchId: null, plaidTransactionId: { not: null } }));
  check("manual → neither",
    eq(sourceWhere(["manual"]), { importBatchId: null, plaidTransactionId: null }));
  check("multiple → OR of the fragments",
    eq(sourceWhere(["import", "manual"]),
       { OR: [{ importBatchId: { not: null } }, { importBatchId: null, plaidTransactionId: null }] }));
  check("all three → null (exhaustive selection is a no-op, not a giant OR)",
    sourceWhere([...TRANSACTION_SOURCES]) === null);
  check("empty → null", sourceWhere([]) === null);
  check("duplicates collapse", eq(sourceWhere(["plaid", "plaid"]), sourceWhere(["plaid"])));
}

console.log("OR-COLLISION — two OR-shaped filters cannot overwrite each other");
{
  // Pre-hardening, `text` was assigned to a top-level `where.OR`. Adding `sources`
  // (also OR-shaped) would have silently clobbered one of them, widening or
  // narrowing the result set with no error. The AND-array composition makes that
  // structurally impossible — assert BOTH survive.
  const w = buildFilterWhere({ sort: "newest", text: "coffee", sources: ["manual"] });
  const and = (w.AND ?? []) as Record<string, unknown>[];
  const hasText = and.some((f) => Array.isArray(f.OR) && JSON.stringify(f.OR).includes("coffee"));
  const hasSource = and.some((f) => f.plaidTransactionId === null && f.importBatchId === null);
  check("text fragment survives alongside source", hasText);
  check("source fragment survives alongside text", hasSource);
  check("both are separate AND terms (no top-level OR key)", and.length === 2 && w.OR === undefined);
}

// ── PAGINATION INVARIANTS — the correctness proof ───────────────────────────
// Synthetic dataset with MANY same-day rows (ties on date, distinct ids) so every
// tie-break path is exercised.
const rows: KeyedRow[] = [
  { id: "b", date: toDbDate("2026-06-03") },
  { id: "a", date: toDbDate("2026-06-03") }, // same day as b
  { id: "c", date: toDbDate("2026-06-03") }, // three-way same-day tie
  { id: "d", date: toDbDate("2026-06-02") },
  { id: "e", date: toDbDate("2026-06-02") },
  { id: "f", date: toDbDate("2026-06-01") },
  { id: "g", date: toDbDate("2026-05-31") },
];

function fullSorted(sort: TransactionSort): KeyedRow[] {
  return [...rows].sort((a, b) => compareForSort(a, b, sort));
}

// Walk the whole dataset page-by-page through the KEYSET path and reassemble it.
function pageThrough(sort: TransactionSort, pageSize: number): KeyedRow[] {
  const out: KeyedRow[] = [];
  let cursor: TransactionCursor | undefined;
  let guard = 0;
  while (guard++ < 100) {
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

  // Same-day tie-break: the three 2026-06-03 rows must be contiguous and id-ordered.
  const ids = walked.map((r) => r.id);
  const sameDay = ["a", "b", "c"].map((i) => ids.indexOf(i)).sort((x, y) => x - y);
  check(`${sort}: same-day rows a,b,c are contiguous`, sameDay[2] - sameDay[0] === 2);
  const idAsc = sort === "oldest";
  const order = ids.filter((i) => ["a", "b", "c"].includes(i));
  check(`${sort}: same-day rows ordered by id ${idAsc ? "asc" : "desc"}`,
    eq(order, idAsc ? ["a", "b", "c"] : ["c", "b", "a"]));
}

console.log("PAGINATION — page size 1 (every row is a boundary)");
{
  for (const sort of SORTS) {
    const walked = pageThrough(sort, 1);
    check(`${sort}: pageSize 1 still reassembles exactly`,
      eq(walked.map((r) => r.id), fullSorted(sort).map((r) => r.id)));
  }
}

console.log("CURSOR — derived from the last kept row; null on the final page");
{
  const asc = fullSorted("newest");
  const firstThree = nextCursorFrom(asc.slice(0, 4), "newest", 3); // 3 kept + 1 sentinel
  check("hasMore when a sentinel row exists", firstThree.hasMore === true);
  check("nextCursor is the 3rd row's key", eq(firstThree.nextCursor, cursorFromRow(asc[2], "newest")));
  const lastPage = nextCursorFrom(asc.slice(0, 2), "newest", 3); // fewer than limit
  check("no sentinel → hasMore false + nextCursor null", lastPage.hasMore === false && lastPage.nextCursor === null);
  check("nextCursor is tagged with the page's sort", firstThree.nextCursor?.sort === "newest");
  check("empty fetch → no cursor, no more",
    (() => { const p = nextCursorFrom([], "newest", 3); return p.nextCursor === null && p.hasMore === false; })());
}

if (failures > 0) { console.error(`\ntransaction-query-core: ${failures} failure(s).`); process.exit(1); }
console.log("\ntransaction-query-core: all passed.");
