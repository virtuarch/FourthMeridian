/**
 * app/api/accounts/[id]/transactions/route.test.ts  (TX-3.2)
 *
 * Source-scan tripwires for the FIRST consumer of the Transaction Explorer query
 * authority. Before TX-3.2 this route was the only row-listing transaction reader
 * that bypassed `bankingTransactionWhere` — it hand-rolled a population-free query
 * and its own DTO. These assertions pin that it never grows that divergence back,
 * and that the two visibility contracts it owns (404 vs empty-200) survive.
 *
 * DB-behavioral guarantees (population, KD-15 visibility, soft-delete, keyset
 * correctness) are INHERITED from the already-tested shared authority; this file
 * proves DELEGATION, which is the thing a refactor can silently break. Pure (no DB).
 *
 *   npx tsx "app/api/accounts/[id]/transactions/route.test.ts"
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

const r = code("app/api/accounts/[id]/transactions/route.ts");

console.log("SINGLE AUTHORITY — delegates rows, never re-derives a population");
{
  check("delegates row fetching to queryTransactions", r.includes("queryTransactions("));
  check("no direct transaction table read (the hand-rolled query is gone)",
    !/db\.transaction\./.test(r));
  // No transaction-level population or soft-delete predicate survives here. (The
  // ONE remaining `financialAccountId` is the SpaceAccountLink lookup below, which
  // is the 404-vs-empty contract, not a row filter — asserted separately.)
  check("no inline transaction soft-delete predicate of its own",
    !/deletedAt:\s*null/.test(r));
  check("financialAccountId appears only in the link lookup, never as a row filter",
    (r.match(/financialAccountId/g) ?? []).length === 1 && r.includes("spaceAccountLink.findFirst"));
  check("no second DTO builder (no direct serializeTransactionRow / capFetched)",
    !/serializeTransactionRow/.test(r) && !/capFetched/.test(r));
  check("no hand-rolled take/orderBy (bounding + ordering belong to the authority)",
    !/\btake:/.test(r) && !/orderBy/.test(r));
}

console.log("VISIBILITY — both public contracts preserved, isolation non-negotiable");
{
  // The link lookup stays: bankingTransactionWhere alone cannot distinguish
  // "not shared at all" (404) from "shared below the detail tier" (empty 200).
  check("still resolves the SpaceAccountLink for the 404-vs-empty distinction",
    r.includes("spaceAccountLink.findFirst") && r.includes("ShareStatus.ACTIVE"));
  check("no ACTIVE link → 404 (no existence disclosure)", /status:\s*404/.test(r));
  check("insufficient tier → empty 200 via the shared KD-15 predicate",
    r.includes("grantsTransactionDetail") && /transactions:\s*\[\]/.test(r));
  check("auth guard retained (SEC-FIX-1)", r.includes("requireUser()"));

  // Account isolation: a caller-supplied ?accountIds= must never widen the scope.
  check("forces accountIds to this route's account",
    /accountIds:\s*\[id\]/.test(r));
  check("the forced accountIds is written AFTER the parsed query (spread cannot override it)",
    /\.\.\.parsed\.query,\s*accountIds:\s*\[id\]/.test(r));
}

console.log("M3 — untrusted input is parsed before it can reach Prisma");
{
  check("parses via the shared vocabulary-bound parser",
    r.includes("parseTransactionQueryParams(req.nextUrl.searchParams)"));
  check("malformed input → 400 with field detail, never a 500",
    /status:\s*400/.test(r) && r.includes("parsed.errors"));
  check("does not hand raw search params to the query authority",
    !/searchParams\.get/.test(r));
}

console.log("M2 — keyset paging is opaque and reset-aware");
{
  check("emits an OPAQUE cursor token (consumers cannot craft one)",
    r.includes("encodeCursor(nextCursor)"));
  check("emits hasMore", /hasMore/.test(r));
  check("propagates cursorReset from BOTH the parser and the authority",
    r.includes("cursorReset") && /parsed\.cursorReset/.test(r));
  check("no offset paging", !/\bskip\b/.test(r) && !/\bpage\b/.test(r));
}

if (failures > 0) { console.error(`\naccounts/[id]/transactions route: ${failures} failure(s).`); process.exit(1); }
console.log("\naccounts/[id]/transactions route: all passed.");
