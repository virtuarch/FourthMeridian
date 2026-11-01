/**
 * lib/connections/valuation-coverage.core.test.ts
 *
 * The price-bounded-history note: states a gap only when an asset's balances
 * are older than its stored prices; never mentions a non-limiting asset; never
 * says "zero"-valued; wired once under the Net Worth / Assets chart through the
 * Space's ONE data-health read.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { deriveValuationCoverage, valuationCoverageNote } from "./valuation-coverage.core";

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const read = (p: string) => readFileSync(path.join(process.cwd(), p), "utf8");

console.log("\nderiveValuationCoverage");
{
  const floors = new Map<string, string | null>([["sol", "2026-09-27"], ["btc", "2020-01-01"], ["eth", null]]);
  const cov = deriveValuationCoverage([
    { symbol: "SOL", instrumentId: "sol", balanceFromISO: "2022-03-26" },
    { symbol: "SOL", instrumentId: "sol", balanceFromISO: "2021-01-05" },
    { symbol: "BTC", instrumentId: "btc", balanceFromISO: "2023-01-01" },
    { symbol: "ETH", instrumentId: "eth", balanceFromISO: null },
  ], floors);
  check("prices older than balances ⇒ not a limit (BTC omitted)", !!cov && !cov.limits.some((l) => l.symbol === "BTC"));
  check("unbounded balance start ⇒ ignored (ETH omitted)", !!cov && !cov.limits.some((l) => l.symbol === "ETH"));
  check("same asset across accounts ⇒ earliest balance day", cov?.limits.length === 1 && cov.limits[0].balanceFromISO === "2021-01-05");
  check("valuedFrom = the price floor", cov?.valuedFromISO === "2026-09-27");
  check("nothing limited ⇒ null", deriveValuationCoverage([{ symbol: "BTC", instrumentId: "btc", balanceFromISO: "2023-01-01" }], floors) === null);

  const none = deriveValuationCoverage([{ symbol: "ETH", instrumentId: "eth", balanceFromISO: "2024-02-02" }], floors);
  check("no stored prices ⇒ limit with null floor, valuedFrom null", none?.limits[0].pricedFromISO === null && none.valuedFromISO === null);
}

console.log("\nvaluationCoverageNote");
{
  const cov = deriveValuationCoverage([{ symbol: "SOL", instrumentId: "sol", balanceFromISO: "2022-03-26" }], new Map([["sol", "2026-09-27"]]));
  const note = valuationCoverageNote(cov, "2026-09-27") ?? "";
  check("names asset and both absolute dates", /SOL balances are known from Mar 26, 2022, but its historical prices start Sep 27, 2026/.test(note), note);
  check("never claims zero value", /never counted as zero/.test(note) && !/valued at \$?0/.test(note));
  check("chart already reaching the balance start ⇒ no note", valuationCoverageNote(cov, "2022-03-26") === null);
  check("a chosen window starting after the price floor ⇒ no note (1 month from Sep 28)", valuationCoverageNote(cov, "2026-09-28") === null);
  check("no coverage / no chart ⇒ no note", valuationCoverageNote(null, "2026-09-27") === null && valuationCoverageNote(cov, null) === null);
  const noPrices = deriveValuationCoverage([{ symbol: "ETH", instrumentId: "eth", balanceFromISO: "2024-02-02" }], new Map([["eth", null]]));
  check("no stored prices wording", /no historical ETH prices are stored yet/.test(valuationCoverageNote(noPrices, "2026-10-01") ?? ""));
}

console.log("\nwiring");
{
  const route = read("app/api/spaces/[id]/data-health/route.ts");
  check("data-health route returns valuationCoverage from the loader", /loadValuationCoverage\(tx, spaceId\)/.test(route) && /valuationCoverage \}/.test(route));
  const loader = read("lib/connections/valuation-coverage.ts");
  check("loader: balance-disclosing links only", /grantsBalanceDisclosure\(l\.visibilityLevel\)/.test(loader));
  check("loader: no global db import", !/from ['"]@\/lib\/db['"]/.test(loader));
  const pes = read("components/space/PerspectiveEmptyState.tsx");
  check("one fetch of data-health in the shared hook file", (pes.match(/\/data-health`/g) ?? []).length === 1);
  const ww = read("components/space/widgets/wealth/WealthWorkspace.tsx");
  check("note under the chart for Net Worth / Assets only",
    /\(metric === "netWorth" \|\| metric === "totalAssets"\) && \(\s*<ValuationCoverageNote from=\{result\.chart\.points\[0\]\?\.date \?\? null\} \/>/.test(ww));
}

if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log("\nall passed");
