/**
 * lib/data/transactions-bounding.test.ts  (TX-2)
 *
 * Regression tests for the bounded transaction read contract. Standalone `tsx`
 * (no DB). Proves the four TX-2 guarantees:
 *   - BOUNDARY: a consumer cannot accidentally request unlimited history
 *   - TRUNCATION: 10,000 available → 5,000 rows + truncated:true
 *   - WINDOW: an explicit windowDays produces the right date floor
 *   - SEMANTIC: within the returned set the rows are IDENTICAL to before, so any
 *     downstream fold (DayFacts / FlowType / totals) is unchanged
 * plus source tripwires that the shared consumers stay bounded.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { capFetched, windowFloorDate, DEFAULT_TX_LIMIT } from "./transaction-bounds";

const ROOT = process.cwd();
const code = (rel: string) =>
  readFileSync(path.join(ROOT, rel), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}`); }
}

const arr = (n: number) => Array.from({ length: n }, (_, i) => i);

console.log("BOUNDARY — the default is a finite cap; unlimited is not reachable by default");
{
  check("DEFAULT_TX_LIMIT is a finite positive number (5000)", Number.isFinite(DEFAULT_TX_LIMIT) && DEFAULT_TX_LIMIT === 5000);
  const src = code("lib/data/transactions.ts");
  check("getTransactions defaults limit to DEFAULT_TX_LIMIT", /limit\s*=\s*ctx\?\.limit\s*\?\?\s*DEFAULT_TX_LIMIT/.test(src));
  check("getDebtTransactions defaults limit to DEFAULT_TX_LIMIT", (src.match(/limit\s*=\s*ctx\?\.limit\s*\?\?\s*DEFAULT_TX_LIMIT/g) ?? []).length >= 2);
  check("both banking loaders fetch a bounded page (take: limit + 1)", (src.match(/take:\s*limit\s*\+\s*1/g) ?? []).length >= 2);
}

console.log("TRUNCATION — 10,000 available (fetched limit+1) → 5,000 rows + truncated");
{
  // The loader fetches `take: limit + 1`; simulate that fetched page.
  const fetched5001 = arr(DEFAULT_TX_LIMIT + 1); // what findMany returns when >5000 exist
  const r = capFetched(fetched5001, DEFAULT_TX_LIMIT);
  check("fetched limit+1 → rows === limit", r.rows.length === DEFAULT_TX_LIMIT);
  check("fetched limit+1 → truncated === true", r.truncated === true);

  const r2 = capFetched(arr(DEFAULT_TX_LIMIT), DEFAULT_TX_LIMIT);
  check("exactly limit rows → truncated === false", r2.truncated === false && r2.rows.length === DEFAULT_TX_LIMIT);

  const r3 = capFetched(arr(10), DEFAULT_TX_LIMIT);
  check("under limit → truncated false, all rows kept", r3.truncated === false && r3.rows.length === 10);
}

console.log("SEMANTIC — under the cap the rows are IDENTICAL (fold unchanged)");
{
  const under = arr(100);
  const r = capFetched(under, DEFAULT_TX_LIMIT);
  check("under-cap returns the SAME array reference (byte-identical fold input)", r.rows === under);
  check("under-cap preserves order + every element", r.rows.every((v, i) => v === i));
  // Truncation slices from the FRONT (newest, since rows arrive date-desc) — the
  // most-recent window is fully preserved; only the oldest tail is dropped.
  const trunc = capFetched(arr(DEFAULT_TX_LIMIT + 50), DEFAULT_TX_LIMIT);
  check("truncation keeps the most-recent slice (front), drops the oldest tail", trunc.rows[0] === 0 && trunc.rows[DEFAULT_TX_LIMIT - 1] === DEFAULT_TX_LIMIT - 1);
}

console.log("WINDOW — explicit windowDays → correct UTC date floor; null → no floor");
{
  const now = new Date("2026-07-20T12:00:00.000Z");
  const floor800 = windowFloorDate(800, now)!;
  const daysBack = Math.round((Date.UTC(2026, 6, 20) - floor800.getTime()) / 86_400_000);
  check("windowDays 800 → floor is 800 days before today (UTC midnight)", daysBack === 800);
  check("windowFloorDate(null) → null (no floor; the row cap still bounds)", windowFloorDate(null, now) === null);
  check("windowFloorDate(undefined) → null", windowFloorDate(undefined, now) === null);
}

console.log("CONSUMER tripwires — shared consumers stay bounded");
{
  const acct = code("app/api/accounts/[id]/transactions/route.ts");
  check("per-account route is bounded (take + capFetched)", /take:\s*DEFAULT_TX_LIMIT\s*\+\s*1/.test(acct) && acct.includes("capFetched("));
  const view = code("app/api/money/view-context/route.ts");
  check("view-context no longer loads rows (uses groupBy, not getTransactions)",
    !view.includes("getTransactions(") && view.includes("groupBy"));
  const exp = code("lib/export/assemble.ts");
  check("export passes an explicit query cap (EXPORT_TRANSACTION_CAP)", /getTransactions\(\{\s*spaceId,\s*limit:\s*EXPORT_TRANSACTION_CAP\s*\}\)/.test(exp));
}

if (failures > 0) { console.error(`\ntransactions-bounding: ${failures} failure(s).`); process.exit(1); }
console.log("\ntransactions-bounding: all passed.");
