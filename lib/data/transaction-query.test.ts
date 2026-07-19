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
  check("composes the pure keyset predicate", q.includes("keysetWhere(query.sort, query.cursor)"));
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

if (failures > 0) { console.error(`\ntransaction-query: ${failures} failure(s).`); process.exit(1); }
console.log("\ntransaction-query: all passed.");
