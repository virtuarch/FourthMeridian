/**
 * lib/export/holdings.test.ts  (P2-5)
 *
 * Pure guards for the export holdings projection + the source-scan guard that the
 * assembler reads canonical positions (getCurrentPositions), NOT the general
 * legacy `Holding` model — the ONLY legacy read left is the crypto-only bridge.
 * Standalone tsx script (exit 0/1). No DB, no network.
 *
 *     npx tsx lib/export/holdings.test.ts
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { toExportHoldingFromPosition, toExportHoldingFromLegacyCrypto, mergeSpaceExportHoldings } from "@/lib/export/holdings";
import type { CurrentPositionRow } from "@/lib/investments/current-positions-core";
import type { LegacyCryptoPosition } from "@/lib/investments/legacy-crypto-holdings";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

/** A canonical current-position row (only the fields the projection reads matter). */
function posRow(over: Partial<CurrentPositionRow>): CurrentPositionRow {
  return {
    instrumentId: "i1", accountId: "acc1", quantity: 3,
    nativePrice: 250, nativeValue: 750, reportingValue: 600,
    currency: "USD", reportingCurrency: "GBP",
    quantityTier: "observed", priceTier: "observed", fxTier: "estimated", overallTier: "estimated",
    basisUsed: "institution-value", priceDate: "2026-07-15", staleDays: 0,
    reason: "x", conflicted: false,
    symbol: "VTI", name: "Vanguard", share: 1, assetClass: "EQUITY", sector: null, isCash: false,
    costBasis: 500,
    ...over,
  } as CurrentPositionRow;
}

console.log("toExportHoldingFromPosition — canonical projection");
{
  const h = toExportHoldingFromPosition(posRow({}), "s1");
  check("stable id = accountId:instrumentId", h.id === "acc1:i1");
  check("native value/price/currency preserved (pre-P2-5 contract)",
    h.value === 750 && h.price === 250 && h.currency === "USD");
  check("reporting value + currency ADDED", h.reportingValue === 600 && h.reportingCurrency === "GBP");
  check("costBasis surfaced", h.costBasis === 500);
  check("source = canonical", h.source === "canonical");
  check("spaceId tagged", h.spaceId === "s1");
}
{
  // Unvalued canonical row — value/price null, NEVER 0. Row still produced.
  const h = toExportHoldingFromPosition(posRow({ nativeValue: null, nativePrice: null, reportingValue: null, currency: null, costBasis: null }), "s1");
  check("unvalued: value null (not 0)", h.value === null);
  check("unvalued: price null (not 0)", h.price === null);
  check("unvalued: reportingValue null (not 0)", h.reportingValue === null);
  check("unvalued: quantity retained (row preserved)", h.quantity === 3);
  check("unvalued: reportingCurrency still carried", h.reportingCurrency === "GBP");
}
{
  // Cash position flows through with isCash true.
  const h = toExportHoldingFromPosition(posRow({ isCash: true, symbol: null, name: "Cash" }), "s1");
  check("cash row: isCash true", h.isCash === true);
}

console.log("toExportHoldingFromLegacyCrypto — crypto-only bridge projection");
{
  const c: LegacyCryptoPosition = {
    holdingId: "hold_btc", financialAccountId: "wallet1", symbol: "BTC", name: "Bitcoin",
    quantity: 0.5, price: 60000, value: 30000, currency: "USD", isCash: false,
  };
  const h = toExportHoldingFromLegacyCrypto(c, "s1", "GBP");
  check("id = legacy Holding id", h.id === "hold_btc");
  check("accountId = financialAccountId", h.accountId === "wallet1");
  check("native (quote) value/currency preserved", h.value === 30000 && h.currency === "USD");
  check("reportingValue null (bridge does NO FX)", h.reportingValue === null);
  check("reportingCurrency carried for column consistency", h.reportingCurrency === "GBP");
  check("costBasis null (legacy Holding has none)", h.costBasis === null);
  check("source = crypto-compat", h.source === "crypto-compat");
}

console.log("mergeSpaceExportHoldings — disjoint by account, no double count");
{
  // A backfilled wallet observation would put the SAME wallet account into BOTH
  // the canonical rows and the crypto bridge. The merge must drop the canonical
  // wallet row and keep only the crypto one.
  const canonicalRows = [
    posRow({ accountId: "brokerage1", instrumentId: "vti" }),        // A-track — kept
    posRow({ accountId: "wallet1", instrumentId: "btc", symbol: "BTC" }), // backfilled wallet — dropped
  ];
  const cryptoPositions: LegacyCryptoPosition[] = [
    { holdingId: "h_btc", financialAccountId: "wallet1", symbol: "BTC", name: "Bitcoin", quantity: 0.5, price: 60000, value: 30000, currency: "USD", isCash: false },
  ];
  const merged = mergeSpaceExportHoldings({ canonicalRows, cryptoPositions, spaceId: "s1", reportingCurrency: "USD" });
  check("wallet appears exactly once (crypto bridge wins)",
    merged.filter((h) => h.accountId === "wallet1").length === 1);
  check("the single wallet row is crypto-compat",
    merged.find((h) => h.accountId === "wallet1")?.source === "crypto-compat");
  check("non-wallet canonical row retained", merged.some((h) => h.accountId === "brokerage1" && h.source === "canonical"));
  check("total rows = canonical(non-wallet) + crypto", merged.length === 2);
}
{
  // No crypto → passthrough of canonical rows only.
  const merged = mergeSpaceExportHoldings({ canonicalRows: [posRow({ accountId: "b1" })], cryptoPositions: [], spaceId: "s1", reportingCurrency: "USD" });
  check("no-crypto passthrough keeps canonical rows", merged.length === 1 && merged[0].source === "canonical");
}

// ── Source guard — the assembler reads canonical positions, not general Holding ─
console.log("source guard — export assembler off the general legacy Holding read");
{
  const src = readFileSync(join(process.cwd(), "lib/export/assemble.ts"), "utf8")
    .replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, ""); // strip comments (doc mentions Holding)
  check("assemble.ts does NOT import getHoldings", !/getHoldings/.test(src));
  check("assemble.ts does NOT read prisma.holding directly", !/\.holding\./.test(src));
  check("assemble.ts sources positions from getCurrentPositions", /getCurrentPositions\s*\(/.test(src));
  check("assemble.ts bridges crypto ONLY via readLegacyCryptoWalletPositions",
    /readLegacyCryptoWalletPositions\s*\(/.test(src));
  check("assemble.ts merges the two sources disjointly (no double count)",
    /mergeSpaceExportHoldings\s*\(/.test(src));

  // The crypto bridge itself must stay crypto-only (walletChain), FULL-gated.
  const bridge = readFileSync(join(process.cwd(), "lib/investments/legacy-crypto-holdings.ts"), "utf8");
  const bridgeCode = bridge.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");
  check("bridge scopes to self-custody wallets only (walletChain)", /walletChain/.test(bridgeCode));
  check("bridge enforces FULL detail visibility", /TRANSACTION_DETAIL_VISIBILITY/.test(bridgeCode));
}

if (failures > 0) { console.error(`\n${failures} check(s) failed.`); process.exit(1); }
console.log("\nAll export/holdings checks passed.");
