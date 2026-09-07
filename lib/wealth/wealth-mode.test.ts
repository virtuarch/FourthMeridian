/**
 * lib/wealth/wealth-mode.test.ts  (OVERVIEW-CONSOLIDATION)
 *
 * The Net Worth subject vocabulary: Total · Assets · Debt modes, the Assets
 * slice, and the legacy-URL canonicalisation that keeps every old `?metric=` and
 * `?perspective=` link resolving to the right consolidated subject.
 *
 *   npx tsx lib/wealth/wealth-mode.test.ts
 */

import {
  ASSETS_SLICES, WEALTH_MODES, WEALTH_MODE_LABELS, ASSETS_SLICE_LABELS,
  legacyPerspectiveTarget, parseAssetsSlice, parseWealthMode,
  serializeAssetsSlice, serializeWealthMode, wealthSeriesKey,
} from "./wealth-mode";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

console.log("1. The Net Worth selector is Total | Assets | Debt");
check("exactly three modes, in order", WEALTH_MODES.join() === "total,assets,debt");
check("labels", WEALTH_MODES.map((m) => WEALTH_MODE_LABELS[m]).join(" | ") === "Total | Assets | Debt");
check("Assets chart slices are All | Cash | Investments", ASSETS_SLICES.map((s) => ASSETS_SLICE_LABELS[s]).join(" | ") === "All | Cash | Investments");

console.log("2. Legacy ?metric= values resolve safely");
check("netWorth → total", parseWealthMode("netWorth") === "total");
check("totalAssets → assets", parseWealthMode("totalAssets") === "assets");
check("totalLiabilities → debt", parseWealthMode("totalLiabilities") === "debt");
check("liquidNetWorth → total (the figure lives on as a Total stat, not a page)", parseWealthMode("liquidNetWorth") === "total");
check("case-insensitive", parseWealthMode("TOTALASSETS") === "assets");
check("new values pass through", parseWealthMode("assets") === "assets" && parseWealthMode("debt") === "debt" && parseWealthMode("total") === "total");
check("unknown → total (never a crash)", parseWealthMode("nonsense") === "total");
check("absent → total", parseWealthMode(null) === "total" && parseWealthMode(undefined) === "total");
check("slice: cash / investments / unknown / absent", parseAssetsSlice("cash") === "cash" && parseAssetsSlice("investments") === "investments" && parseAssetsSlice("x") === "all" && parseAssetsSlice(null) === "all");

console.log("3. Serialisation — the default clears the param");
check("total serialises to null", serializeWealthMode("total") === null);
check("assets / debt serialise verbatim", serializeWealthMode("assets") === "assets" && serializeWealthMode("debt") === "debt");
check("all serialises to null", serializeAssetsSlice("all") === null);
check("cash serialises verbatim", serializeAssetsSlice("cash") === "cash");

console.log("4. Old peer-lens URLs resolve into the new IA");
const liq = legacyPerspectiveTarget("liquidity");
const inv = legacyPerspectiveTarget("investments");
const debt = legacyPerspectiveTarget("debt");
check("liquidity → Net Worth → Assets / Cash", liq?.mode === "assets" && liq.slice === "cash" && liq.focus === "cash");
check("investments → Net Worth → Assets / Investments", inv?.mode === "assets" && inv.slice === "investments" && inv.focus === "investments");
check("debt → Net Worth → Debt", debt?.mode === "debt" && debt.focus === null);
check("cashFlow is NOT a legacy target (it stays a lens)", legacyPerspectiveTarget("cashFlow") === null);
check("wealth / unknown / absent are not legacy targets", legacyPerspectiveTarget("wealth") === null && legacyPerspectiveTarget("x") === null && legacyPerspectiveTarget(null) === null);

console.log("5. Mode + slice → the ONE series the chart plots");
check("total → netWorth", wealthSeriesKey("total", "all") === "netWorth");
check("total ignores the slice", wealthSeriesKey("total", "cash") === "netWorth");
check("assets / all → totalAssets", wealthSeriesKey("assets", "all") === "totalAssets");
check("assets / cash → cash", wealthSeriesKey("assets", "cash") === "cash");
check("assets / investments → invested", wealthSeriesKey("assets", "investments") === "invested");
check("debt → totalLiabilities (the series is retained)", wealthSeriesKey("debt", "all") === "totalLiabilities");

if (failures > 0) { console.error(`\n${failures} wealth-mode check(s) failed`); process.exit(1); }
console.log("\nAll wealth-mode checks passed");
