/**
 * lib/connections/wallet-facet-freshness.test.ts
 *
 * CRYPTO-FRESHNESS-1 — "TRANSACTIONS: UPDATED TODAY" AFTER A FAILED IMPORT,
 * PINNED SHUT.
 *
 * On 2026-10-01 a BTC refresh whose transaction import ABORTED at its 10 s
 * budget rendered, on the Connections card:
 *
 *     Hasn't updated since Sep 21        ← the OLDEST of two clocks
 *     Transactions: Updated today        ← WRONG. The import failed.
 *     Financial profile: Built today     ← WRONG. Nothing was rebuilt.
 *     Balances: Updated on Sep 21        ← correct-but-misleading
 *
 * …while the banner, which read the typed outcome directly, told the truth. The
 * banner and the card disagreed because only the banner had the facts: three
 * lines were reading `Connection.lastSyncedAt`, which for a wallet means "the
 * BALANCE was read", and the import's outcome had no durable home at all.
 *
 * Meanwhile `PositionObservation` already carried a 2026-10-01 row written
 * minutes earlier, and no line on the card read it.
 *
 * These assertions are on the PURE derivation + the rendering contract, so they
 * need no database and no React renderer.
 */

process.env.DATABASE_URL = "postgresql://stub@127.0.0.1:1/fintracker_unit_stub";

import { readFileSync } from "fs";
import { join } from "path";
import { deriveConnectionIntelligence, type IntelligenceInput } from "./intelligence";

let failures = 0;
let passes = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) passes++;
  else { failures++; console.log(`[FAIL] ${name}`); if (detail) console.log(`        ${detail}`); }
}
const read = (...seg: string[]) => readFileSync(join(process.cwd(), ...seg), "utf8");
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const NOW = new Date("2026-10-01T17:30:00Z");
const SEP21 = new Date("2026-09-21T15:39:29Z");
const TODAY = new Date("2026-10-01T17:10:20Z");

/** The incident's exact shape: balance read today, import FAILED, no rebuild. */
function incidentInput(over: Partial<IntelligenceInput> = {}): IntelligenceInput {
  return {
    provider: "WALLET",
    state:    "ready",
    historySyncedAt:   null,   // no reconstruction ever succeeded
    earliestTxDate:    new Date("2022-01-01T00:00:00Z"),
    connectedAt:       new Date("2026-06-01T00:00:00Z"),
    lastSyncedAt:      TODAY,  // the BALANCE clock — advanced, correctly
    balancesUpdatedAt: SEP21,  // unpriced run ⇒ legacy pair + clock frozen
    positionObservedAt:   TODAY, // the spine DID advance
    transactionsSyncedAt: null,  // the import has NEVER succeeded
    valuationUpdatedAt:   SEP21,
    valuationIsReadTime:  false,
    ...over,
  };
}

async function main(): Promise<void> {
  // ── 1. THE REGRESSION ─────────────────────────────────────────────────────
  {
    const s = deriveConnectionIntelligence(incidentInput(), NOW);
    check("1. a failed import leaves transaction freshness NULL, never today",
      s.transactionsSyncedAt === null, String(s.transactionsSyncedAt));
    check("1. …and it is NOT the balance clock (the exact substitution that lied)",
      s.transactionsSyncedAt !== s.lastSyncedAt);
    check("1. a reconstruction that never ran leaves profile freshness NULL",
      s.lastReconstructedAt === null, String(s.lastReconstructedAt));
    check("1. …also not the balance clock",
      s.lastReconstructedAt !== s.lastSyncedAt);
    check("1. the successful POSITION observation IS visible, and is today",
      s.positionObservedAt === TODAY.toISOString(), String(s.positionObservedAt));
    check("1. …even though the valuation failed and its clock stayed at Sep 21",
      s.valuationUpdatedAt === SEP21.toISOString(), String(s.valuationUpdatedAt));
  }

  // ── 2. A SUCCESSFUL IMPORT DOES ADVANCE IT ────────────────────────────────
  // Without this the fix could be "always null", which is not honesty.
  {
    const s = deriveConnectionIntelligence(
      incidentInput({ transactionsSyncedAt: TODAY, historySyncedAt: TODAY }), NOW);
    check("2. a COMPLETED import advances transaction freshness",
      s.transactionsSyncedAt === TODAY.toISOString(), String(s.transactionsSyncedAt));
    check("2. a COMPLETED reconstruction advances profile freshness",
      s.lastReconstructedAt === TODAY.toISOString(), String(s.lastReconstructedAt));
  }

  // ── 3. A TRUTHFUL OLDER SUCCESS SURVIVES A LATER FAILURE ──────────────────
  {
    const s = deriveConnectionIntelligence(
      incidentInput({ transactionsSyncedAt: SEP21 }), NOW);
    check("3. a failed import keeps the LAST SUCCESSFUL date, not today",
      s.transactionsSyncedAt === SEP21.toISOString(), String(s.transactionsSyncedAt));
    check("3. …while the balance clock is today — the two are now independent",
      s.lastSyncedAt === TODAY.toISOString() && s.transactionsSyncedAt !== s.lastSyncedAt);
  }

  // ── 4. READ-TIME-VALUED CHAINS CLAIM NO VALUATION CLOCK ───────────────────
  {
    const s = deriveConnectionIntelligence(
      incidentInput({ valuationIsReadTime: true, valuationUpdatedAt: null }), NOW);
    check("4. ETH/SOL report no valuation clock rather than inventing one",
      s.valuationUpdatedAt === null && s.valuationIsReadTime === true);
  }

  // ── 5. PLAID IS UNCHANGED ─────────────────────────────────────────────────
  // For Plaid the item sync IS the transaction sync, so lastSyncedAt is the
  // right authority there and this repair must not disturb it.
  {
    const s = deriveConnectionIntelligence({
      provider: "PLAID", state: "ready",
      historySyncedAt: TODAY, earliestTxDate: new Date("2021-01-01T00:00:00Z"),
      connectedAt: new Date("2025-01-01T00:00:00Z"),
      lastSyncedAt: TODAY, balancesUpdatedAt: TODAY,
      transactionsSyncedAt: TODAY, positionObservedAt: null,
      valuationUpdatedAt: null, valuationIsReadTime: false,
    }, NOW);
    check("5. Plaid keeps its transaction clock", s.transactionsSyncedAt === TODAY.toISOString());
    check("5. Plaid keeps its balances clock", s.balancesUpdatedAt === TODAY.toISOString());
    check("5. Plaid has no position clock (not a wallet)", s.positionObservedAt === null);
  }

  // ── 6. THE RENDERING CONTRACT ─────────────────────────────────────────────
  {
    const card = code(read("components", "connections", "ConnectionCard.tsx"));
    check("6. a row is rendered only when its OWN timestamp exists",
      /rows\.filter\(\(r\) => r\.iso\)/.test(card));
    check("6. the wallet rows read the per-facet clocks, not lastSyncedAt",
      /positionObservedAt/.test(card) && /intelligence\.transactionsSyncedAt/.test(card)
      && /valuationUpdatedAt/.test(card));
    check("6. the wallet branch labels the position row",
      /label: "Position"/.test(card));
    check("6. …and names transaction history distinctly",
      /label: "Transaction history"/.test(card));
    // The precise substitution that produced the false claim must not reappear.
    // Isolate the WALLET row array only — the PLAID array below it reads
    // `lastSyncedAt` legitimately, because for Plaid the item sync IS the
    // transaction sync.
    const rowsDecl = card.slice(card.indexOf("const rows"), card.indexOf("const shown"));
    // The ternary's two arms, split on the `]\n    : [` boundary (whitespace
    // varies, so match it as a pattern rather than a literal).
    const arms = rowsDecl.split(/\]\s*:\s*\[/);
    const walletArray = arms[0] ?? "";
    const plaidArray  = arms[1] ?? "";
    check("6. the WALLET row set never reads lastSyncedAt for any row",
      /label: "Position"/.test(walletArray) && !/lastSyncedAt/.test(walletArray),
      walletArray.slice(-260));
    check("6. …while the PLAID row set still does, which is correct there",
      /lastSyncedAt/.test(plaidArray), plaidArray.slice(0, 200));
  }

  // ── 7. THE WRITER ONLY WRITES ON SUCCESS ──────────────────────────────────
  {
    const dispatch = code(read("lib", "crypto", "wallet-sync-dispatch.ts"));
    check("7. the transaction clock is written only when the import IMPORTED",
      /txImport\?\.status === "IMPORTED"/.test(dispatch));
    check("7. the reconstruction clock only when it actually refreshed",
      /historyRefresh\?\.refreshed === true/.test(dispatch));
    check("7. each is passed only when its own facet succeeded (no blanket write)",
      /txSucceeded\s+\?\s+\{ transactionsSyncedAt/.test(dispatch)
      && /historySucceeded \? \{ historyRebuiltAt/.test(dispatch));
    const conn = code(read("lib", "accounts", "wallet-connection.ts"));
    check("7. the writer writes ONLY the fields passed (never a default now())",
      /if \(Object\.keys\(data\)\.length === 0\) return;/.test(conn));
    check("7. …and the dispatcher still performs no DB access of its own",
      !/@\/lib\/db/.test(dispatch));
  }

  // ── 8. THE LOADER'S PROXY IS GONE ─────────────────────────────────────────
  {
    const loader = code(read("lib", "connections", "space-data.ts"));
    check("8. a ready WALLET no longer uses lastSyncedAt as the reconstruction proxy",
      !/c\.provider === "WALLET" && c\.state === "ready" && c\.lastSyncedAt/.test(loader));
    check("8. the reconstruction clock comes from the connection's own column",
      /facets\?\.historyRebuiltAt/.test(loader));
    check("8. the transaction clock is per-provider, PLAID's sync being its own authority",
      /c\.provider === "PLAID"/.test(loader) && /facets\?\.transactionsSyncedAt/.test(loader));
    check("8. current-position freshness is read from the spine",
      /positionObservation\.groupBy/.test(loader) && /supersededById: null/.test(loader));
  }

  console.log(`\nwallet-facet-freshness: ${passes} passed, ${failures} failed`);
  if (failures > 0) process.exit(1);
}

void main();
