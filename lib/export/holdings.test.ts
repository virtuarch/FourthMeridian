/**
 * lib/export/holdings.test.ts  (P2-5)
 *
 * Pure guards for the export holdings projection + the source-scan guard that the
 * assembler reads canonical positions (getCurrentPositions) and NO legacy
 * `Holding` model at all (W5 — the crypto-only bridge is deleted; crypto rides
 * the canonical seam; a wallet without observations is honestly absent).
 * Standalone tsx script (exit 0/1). No DB, no network.
 *
 *     npx tsx lib/export/holdings.test.ts
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { toExportHoldingFromPosition, mergeSpaceExportHoldings } from "@/lib/export/holdings";
import type { CurrentPositionRow } from "@/lib/investments/current-positions-core";

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

console.log("mergeSpaceExportHoldings — the W5 passthrough (one source, no merge left)");
{
  // W5 (P2-6 executed): the crypto args are gone — this is the passthrough the
  // function's own P2-6 note promised. Crypto wallets arrive as canonical rows;
  // a wallet with no spine observation produces NO row (honest absence).
  const canonicalRows = [
    posRow({ accountId: "brokerage1", instrumentId: "vti" }),
    posRow({ accountId: "wallet1", instrumentId: "btc", symbol: "BTC", name: "Bitcoin" }),
  ];
  const merged = mergeSpaceExportHoldings({ canonicalRows, spaceId: "s1" });
  check("passthrough projects every canonical row", merged.length === 2);
  check("every row is canonical-sourced", merged.every((h) => h.source === "canonical"));
  check("wallet rides the SAME canonical projection as brokerage",
    merged.find((h) => h.accountId === "wallet1")?.id === "wallet1:btc");
  check("empty spine ⇒ empty export positions (honest absence, no legacy backfill)",
    mergeSpaceExportHoldings({ canonicalRows: [], spaceId: "s1" }).length === 0);
}

// ── Source guard — the assembler reads canonical positions, not general Holding ─
console.log("source guard — export assembler reads NO legacy Holding path (W5)");
{
  const src = readFileSync(join(process.cwd(), "lib/export/assemble.ts"), "utf8")
    .replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, ""); // strip comments (doc mentions Holding)
  check("assemble.ts does NOT import getHoldings", !/getHoldings/.test(src));
  check("assemble.ts does NOT read prisma.holding directly", !/\.holding\./.test(src));
  check("assemble.ts sources positions from getCurrentPositions", /getCurrentPositions\s*\(/.test(src));
  check("assemble.ts imports no crypto bridge (W5 — deleted)",
    !/legacy-crypto-holdings|readLegacyCryptoWalletPositions/.test(src));
  check("assemble.ts projects through the one passthrough",
    /mergeSpaceExportHoldings\s*\(/.test(src));

  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");

  // W5 ratchet — the bridge and the dedup rule STAY deleted, in both consumers.
  const mergeSrc = strip(readFileSync(join(process.cwd(), "lib/export/holdings.ts"), "utf8"));
  const aiCore   = strip(readFileSync(join(process.cwd(), "lib/ai/assemblers/holdings-core.ts"), "utf8"));
  check("export projection carries no bridge/dedup residue",
    !/legacy-crypto-holdings|canonical-precedence|LegacyCryptoPosition|crypto-compat/.test(mergeSrc));
  check("AI holdings-core carries no bridge/dedup residue",
    !/canonical-precedence|excludeCanonicalAccounts|CryptoHoldingsInput/.test(aiCore));

  // REVIEW-3 ratchet — the general legacy Holding reader (lib/data/accounts.ts
  // getHoldings) is DELETED; lib/data/accounts.ts must never regrow a Holding
  // read. (W5: there is no sanctioned production Holding read path AT ALL —
  // scripts/audit-crypto-holding-tombstone.ts enforces the repo-wide census.)
  const accountsSrc = strip(readFileSync(join(process.cwd(), "lib/data/accounts.ts"), "utf8"));
  check("lib/data/accounts.ts exports no getHoldings (general legacy reader deleted)",
    !/export\s+(async\s+)?function\s+getHoldings/.test(accountsSrc));
  check("lib/data/accounts.ts reads no Holding rows at all",
    !/\.holding\./.test(accountsSrc));
}

if (failures > 0) { console.error(`\n${failures} check(s) failed.`); process.exit(1); }
console.log("\nAll export/holdings checks passed.");
