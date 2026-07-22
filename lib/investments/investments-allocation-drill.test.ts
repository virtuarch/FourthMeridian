/**
 * lib/investments/investments-allocation-drill.test.ts
 *
 * Standalone tsx guard (house convention: exit 0/1).
 *
 * UX-CLOSE-3 made Allocation segments interrogable. The load-bearing property is
 * MEMBERSHIP AGREEMENT: the rows a drill-down shows must sum to the value of the
 * segment that opened it, on every axis. `computeAllocation` and
 * `holdingsInSlice` therefore share one set of key functions
 * (ALLOCATION_KEY_OF); this file proves they agree rather than trusting that two
 * "identical" expressions stay identical.
 *
 * Also pins the null-bucketing that a naive re-derivation would get wrong: a
 * null sector and a null currency fall into a sentinel bucket, NOT into a
 * literal "null"/"Unknown" string, and asset class falls back on empty-string.
 *
 *   npx tsx lib/investments/investments-allocation-drill.test.ts
 */

import {
  computeAllocation, holdingsInSlice, ALLOCATION_KEY_OF,
  type AllocationDimension,
} from "./investments-allocation-core";
import type { ValuedHoldingRow } from "./investments-time-machine-core";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

/** Minimal row — only the fields the allocation axes read. */
function H(p: Partial<ValuedHoldingRow> & { instrumentId: string; accountId: string }): ValuedHoldingRow {
  return {
    quantity: 1, nativePrice: null, nativeValue: null,
    reportingValue: 100, currency: "USD", reportingCurrency: "USD",
    quantityTier: "observed", priceTier: "observed", fxTier: "observed", overallTier: "observed",
    basisUsed: "institution-value", priceDate: null, staleDays: 0, reason: null, conflicted: false,
    symbol: null, name: null, share: 0, assetClass: "EQUITY", sector: "Tech", isCash: false,
    ...p,
  } as ValuedHoldingRow;
}

const ROWS: ValuedHoldingRow[] = [
  H({ instrumentId: "i1", accountId: "a1", reportingValue: 500, assetClass: "EQUITY",  sector: "Tech",   currency: "USD" }),
  H({ instrumentId: "i2", accountId: "a1", reportingValue: 300, assetClass: "EQUITY",  sector: "Health", currency: "USD" }),
  H({ instrumentId: "i3", accountId: "a2", reportingValue: 200, assetClass: "ETF",     sector: null,     currency: "EUR" }),
  H({ instrumentId: "i4", accountId: "a2", reportingValue: 100, assetClass: "CRYPTO",  sector: null,     currency: null }),
  H({ instrumentId: "i5", accountId: "a3", reportingValue: 50,  assetClass: "",        sector: "Tech",   currency: "USD" }),
  // Unvalued — contributes to no slice and must never appear in a drill.
  H({ instrumentId: "i6", accountId: "a1", reportingValue: null, assetClass: "EQUITY", sector: "Tech",   currency: "USD" }),
];

const AXES: { dim: AllocationDimension; of: (r: ReturnType<typeof computeAllocation>) => { key: string; value: number }[] }[] = [
  { dim: "assetClass", of: (a) => a.byAssetClass },
  { dim: "sector",     of: (a) => a.bySector },
  { dim: "account",    of: (a) => a.byAccount },
  { dim: "currency",   of: (a) => a.byCurrency },
];

function main(): void {
  const alloc = computeAllocation(ROWS, { a1: "Brokerage", a2: "IRA", a3: "Other" });

  console.log("MEMBERSHIP AGREEMENT — a drill sums to the segment that opened it");
  for (const { dim, of } of AXES) {
    for (const slice of of(alloc)) {
      const rows = holdingsInSlice(ROWS, dim, slice.key);
      const summed = rows.reduce((s, r) => s + (r.reportingValue as number), 0);
      check(`${dim}/${slice.key}: rows sum to the slice value`, summed === slice.value,
        `${summed} vs ${slice.value}`);
    }
  }

  console.log("partition — every valued row lands in exactly one slice per axis");
  const valuedIds = ROWS.filter((r) => r.reportingValue != null).map((r) => r.instrumentId).sort();
  for (const { dim, of } of AXES) {
    const drilled = of(alloc).flatMap((s) => holdingsInSlice(ROWS, dim, s.key).map((r) => r.instrumentId)).sort();
    check(`${dim}: drills cover every valued row exactly once`,
      drilled.join() === valuedIds.join(), `${drilled.join()} vs ${valuedIds.join()}`);
  }

  console.log("unvalued rows never surface");
  for (const { dim, of } of AXES) {
    const anyUnvalued = of(alloc).some((s) =>
      holdingsInSlice(ROWS, dim, s.key).some((r) => r.reportingValue == null));
    check(`${dim}: no unvalued row appears in any drill`, !anyUnvalued);
  }

  console.log("null bucketing — the part a re-derivation gets wrong");
  check("a null sector buckets to the sentinel, not the string 'null'",
    ALLOCATION_KEY_OF.sector(ROWS[2]) === "__unknown__",
    ALLOCATION_KEY_OF.sector(ROWS[2]));
  check("a null currency buckets to the sentinel",
    ALLOCATION_KEY_OF.currency(ROWS[3]) === "__unknown__");
  check("an empty assetClass falls back to UNKNOWN",
    ALLOCATION_KEY_OF.assetClass(ROWS[4]) === "UNKNOWN");
  const unknownSector = holdingsInSlice(ROWS, "sector", "__unknown__");
  check("both null-sector rows drill together", unknownSector.length === 2);
  check("the unknown-sector slice reconciles",
    unknownSector.reduce((s, r) => s + (r.reportingValue as number), 0) === 300);

  console.log("ordering + edges");
  const eq = holdingsInSlice(ROWS, "assetClass", "EQUITY");
  check("rows are largest first", eq[0]?.reportingValue === 500 && eq[1]?.reportingValue === 300);
  check("EQUITY excludes the unvalued row", eq.length === 2);
  check("an unknown key yields nothing", holdingsInSlice(ROWS, "account", "nope").length === 0);
  check("no holdings yields nothing", holdingsInSlice([], "assetClass", "EQUITY").length === 0);

  console.log("known totals");
  check("valuedTotal excludes the unvalued row", alloc.valuedTotal === 1150, String(alloc.valuedTotal));
  check("unvaluedCount is 1", alloc.unvaluedCount === 1);
  check("account a1 totals 800",
    alloc.byAccount.find((s) => s.key === "a1")?.value === 800);

  console.log(failures === 0 ? "\nPASS" : `\nFAIL — ${failures} check(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
