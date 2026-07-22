/**
 * lib/snapshots/wealth-window.test.ts  (CONN-2 — max-available intelligence)
 *
 * Standalone `tsx` (no DB). Proves:
 *   - the initial connect builds the FULL available window (earliest tx → yesterday)
 *   - no fabricated history: only as many days as transactions exist are built
 *   - initial connect AND manual recovery use the SAME window helper + L2 authority
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { wealthWindowFromEarliest, recentWealthWindow } from "./regenerate-history";

const ROOT = process.cwd();
const code = (rel: string) =>
  readFileSync(path.join(ROOT, rel), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}`); }
}

const NOW = new Date("2026-07-19T12:00:00.000Z");
const recent = recentWealthWindow(NOW); // { from: 2026-06-18, to: 2026-07-18 (yesterday) }

console.log("Max-available window — builds the FULL history, not 30 days");
{
  const twoYears = wealthWindowFromEarliest(new Date("2024-07-19T00:00:00.000Z"), NOW);
  check("2 years available → fromDate = earliest tx", twoYears.fromDate === "2024-07-19");
  check("2 years available → toDate = yesterday", twoYears.toDate === recent.toDate);
  check("2 years available → NOT the 30-day recent window", twoYears.fromDate !== recent.fromDate);
  check("2 years available → window spans ~2 years", twoYears.fromDate < "2025-01-01");
}

console.log("No fabricated history — only what exists is built");
{
  const ninetyDays = wealthWindowFromEarliest(new Date("2026-04-20T00:00:00.000Z"), NOW);
  check("90 days available → fromDate = earliest (not 2 years)", ninetyDays.fromDate === "2026-04-20");

  const none = wealthWindowFromEarliest(null, NOW);
  check("no transactions → recent 30-day window (nothing deeper exists)", none.fromDate === recent.fromDate && none.toDate === recent.toDate);

  const today = wealthWindowFromEarliest(new Date("2026-07-19T00:00:00.000Z"), NOW);
  check("earliest on/after yesterday → recent window (no pre-yesterday history)", today.fromDate === recent.fromDate);
}

console.log("Initial connect == manual recovery: same window helper + same L2 authority");
{
  const connect = code("lib/plaid/backgroundHistorySync.ts");
  const route   = code("app/api/connections/build-intelligence/route.ts");

  check("initial connect uses maxAvailableWealthWindow", connect.includes("maxAvailableWealthWindow("));
  check("recovery route uses maxAvailableWealthWindow", route.includes("maxAvailableWealthWindow("));
  check("both call the one L2 authority regenerateWealthHistoryForAccounts",
    connect.includes("regenerateWealthHistoryForAccounts(") && route.includes("regenerateWealthHistoryForAccounts("));
  check("initial connect no longer hardcodes a 30-day wealth window",
    !/minusDaysISO\([^)]*,\s*30\)/.test(connect) && !connect.includes("matches the 30-day snapshot backfill window"));
}

if (failures > 0) { console.error(`\nwealth-window: ${failures} failure(s).`); process.exit(1); }
console.log("\nwealth-window: all passed.");
