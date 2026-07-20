/**
 * lib/data/transaction-query.test.ts  (TX-3.0)
 *
 * Source-scan tripwires for the server keyset authority. The DB-behavioral
 * guarantees the mission lists — account isolation, shared-space visibility,
 * soft-deleted-account exclusion, flow/date/pending filtering — are INHERITED from
 * the already-tested authorities (bankingTransactionWhere: transactions.population
 * / privacy tests; the filter/keyset semantics: transaction-query-core.test). This
 * file pins that the authority actually DELEGATES to them and never grows a second
 * population path, an offset pager, or a divergent DTO. Pure (no DB).
 *
 *   npx tsx lib/data/transaction-query.test.ts
 */

import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const code = (rel: string) =>
  readFileSync(path.join(ROOT, rel), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}`); }
}

const q = code("lib/data/transaction-query.ts");
const tx = code("lib/data/transactions.ts");

console.log("SINGLE AUTHORITY — reuse population/visibility, never re-derive");
{
  check("composes bankingTransactionWhere (the ONE population + KD-15 authority)",
    q.includes("bankingTransactionWhere(spaceId)"));
  check("does NOT declare its own flowType population gate",
    !/flowType:\s*\{\s*not:/.test(q) && !/BANKING_POPULATION/.test(q));
  check("does NOT inline a spaceAccountLinks population predicate in the tx query (only the account-id resolver)",
    (q.match(/spaceAccountLinks/g) ?? []).length === 1); // resolveVisibleAccountIds only
  check("account isolation: intersects accountIds with resolveVisibleAccountIds",
    q.includes("resolveVisibleAccountIds") && /filter\(\(id\)\s*=>\s*visible\.has\(id\)\)/.test(q));
  check("visibility guard reuses the shared KD-15 constant (not a new rule)",
    q.includes("TRANSACTION_DETAIL_VISIBILITY"));
}

console.log("KEYSET, NOT OFFSET — bounded page, strict order");
{
  check("no offset pagination (skip:) anywhere", !/\bskip:/.test(q));
  check("composes the pure keyset predicate", q.includes("keysetWhere(query.sort,"));
  check("orders via the pure orderByForSort", q.includes("orderByForSort(query.sort)"));
  check("bounded: take = clampLimit(...) + 1 (sentinel, <= MAX+1)",
    q.includes("clampLimit(query.limit)") && /take:\s*limit\s*\+\s*1/.test(q));
  check("filters/keyset/population ANDed as SEPARATE terms (no key overwrite)",
    /AND:\s*\[/.test(q) && q.includes("buildFilterWhere(") && q.includes("keysetWhere("));
  check("returns { rows, nextCursor, hasMore } (no aggregates)",
    q.includes("nextCursor") && q.includes("hasMore") && !/groupBy|aggregate|_sum|_count/.test(q));
}

console.log("SHARED DTO — same row shape + projection as getTransactions");
{
  check("uses the shared transactionListInclude", q.includes("transactionListInclude(spaceId)"));
  check("uses the shared projectTransactionListRows (no second DTO builder)",
    q.includes("projectTransactionListRows(pageRows, spaceId)"));
  check("transactions.ts exports the shared projection + include",
    tx.includes("export async function projectTransactionListRows") && tx.includes("export function transactionListInclude"));
  check("getTransactions now delegates to the shared projection (parity)",
    tx.includes("await projectTransactionListRows(capped, spaceId)"));
}

console.log("CONTRACT — no canonical Perspective time on the explorer");
{
  const core = code("lib/data/transaction-query-core.ts");
  check("query contract carries no preset/asOf/compareTo",
    !/\bpreset\b/.test(core) && !/\basOf\b/.test(core) && !/compareTo/.test(core));
  check("server-only guard present", /["']server-only["']/.test(q));
}

// ── TX-3.1b ─────────────────────────────────────────────────────────────────

console.log("M2 CURSOR SAFETY — the sort mismatch is resolved and reported");
{
  check("resolves the cursor against the sort before use", q.includes("resolveCursor(query.sort, query.cursor)"));
  check("surfaces cursorReset on the result (consumers must reset, not append)",
    q.includes("cursorReset"));
  check("every return path carries cursorReset (incl. the empty short-circuit)",
    (q.match(/cursorReset/g) ?? []).length >= 3);
}

console.log("M1 DOCTRINE — amount sorting cannot come back through the core");
{
  const core = code("lib/data/transaction-query-core.ts");
  check("no amount-keyed ordering in the pure core",
    !/amount:\s*["'](asc|desc)["']/.test(core));
  check('no "largest"/"smallest" in the sort vocabulary',
    !/["']largest["']/.test(core) && !/["']smallest["']/.test(core));
  check("cursor carries no lastAmount", !/lastAmount/.test(core));
}

console.log("M7 AGGREGATE PARITY — the count and the list are the same population");
{
  const agg = code("lib/data/transaction-aggregate.ts");
  check("aggregate composes the SAME population authority",
    agg.includes("bankingTransactionWhere(spaceId)"));
  check("aggregate composes the SAME filter builder (shared construction)",
    agg.includes("buildFilterWhere("));
  check("aggregate does NOT re-derive a population gate",
    !/flowType:\s*\{\s*not:/.test(agg) && !/BANKING_POPULATION/.test(agg));
  check("aggregate applies the SAME visibility intersection",
    agg.includes("resolveVisibleAccountIds"));
  check("aggregate NEVER applies the keyset (a total is not a page)",
    !agg.includes("keysetWhere") && !/\btake:/.test(agg));
  check("aggregate returns no rows (no include / no findMany)",
    !/findMany/.test(agg) && !/transactionListInclude/.test(agg));
  check("aggregate sign-splits (magnitude, not a netted sum)",
    /amount:\s*\{\s*gt:\s*0\s*\}/.test(agg) && /amount:\s*\{\s*lt:\s*0\s*\}/.test(agg));
  check("aggregate groups by date so conversion uses each day's own rate",
    /["']date["']/.test(agg) && agg.includes("groupBy"));
  check("server-only guard present", /["']server-only["']/.test(agg));

  // The row query must NOT grow totals of its own — that is what a paginated
  // aggregate would be, and it would be a lie shaped like a number.
  check("the ROW query still computes no aggregates",
    !/groupBy|_sum|_count|\.aggregate\(/.test(q));
}

console.log("M6 MERCHANT PIVOT — the filter has a real source on the row");
{
  check("the shared projection exposes merchantId (so merchantId filtering is usable)",
    /merchantId:\s*r\.merchantId/.test(tx));
}

if (failures > 0) { console.error(`\ntransaction-query: ${failures} failure(s).`); process.exit(1); }
console.log("\ntransaction-query: all passed.");
