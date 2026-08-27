/**
 * lib/crypto/btc-history.test.ts
 *
 * W6c — Bitcoin's history, derived rather than carried.
 *
 *     npx tsx lib/crypto/btc-history.test.ts
 *
 * Bitcoin was the last chain whose historical value came from a sync-time figure
 * carried backward across any interval in which no movement happened to be
 * found. That carry was licensed, and it was still the wrong shape: absence of a
 * recorded movement is only evidence of absence where something guarantees a
 * movement would have been recorded. It now earns a replayed, reconciled
 * timeline bounded by a persisted coverage licence — the same machinery Solana
 * uses, through the same functions.
 *
 * Pinned here: the conversion into canonical movements, exact satoshi
 * reconciliation, what a bounded xpub scan may and may not claim, and the
 * refusals that must survive contact with a wallet that cannot prove its past.
 */

import { readFileSync } from "fs";
import { join } from "path";
import {
  ledgerToChainMovements, btcToSats, BTC_RECONSTRUCTION_SOURCE,
  type BtcLedgerRow,
} from "./btc-history-sync";
import {
  reconcileMovementsAgainstBalance, licenseCoverageByReconciliation,
  type ChainCoverage,
} from "./chain-movement";
import { licensedInterval, resolveLicensedQuantityAsOf } from "./position-coverage";
import { movementsToQuantityEvents } from "./chain-movement";
import { replayQuantityTimeline } from "@/lib/investments/quantity-replay.core";
import { derivedRowsFromTimeline } from "./wallet-reconstruction";
import { BTC_NATIVE } from "./native-asset";
import {
  feedsLegacyWealthHistory, writesLegacyBalanceColumn, walletChainSupport, chainSupportsHistory,
} from "./wallet-sync-dispatch";
import { valueCryptoDay } from "./historical-crypto-valuation.core";

let failures = 0, passes = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) passes++;
  else { failures++; console.log(`[FAIL] ${name}`); if (detail) console.log(`        ${detail}`); }
}
const read = (...s: string[]) => readFileSync(join(process.cwd(), ...s), "utf8");
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");

/** The real wallet's shape in miniature: receives only, summing to the balance. */
const LEDGER: BtcLedgerRow[] = [
  { externalTransactionId: "tx1", date: new Date("2023-03-18T00:00:00Z"), amount: 0.00435799, settlementState: "POSTED" as never },
  { externalTransactionId: "tx2", date: new Date("2023-03-23T00:00:00Z"), amount: 0.00178703, settlementState: "POSTED" as never },
  { externalTransactionId: "tx3", date: new Date("2023-03-24T00:00:00Z"), amount: 0.01414005, settlementState: "POSTED" as never },
];
const LEDGER_TOTAL_SATS = BigInt(435799 + 178703 + 1414005);
const OBSERVED_BTC = 0.02028507; // == the three movements, exactly

// ══ EXACT SATOSHI ARITHMETIC ══════════════════════════════════════════════════
//
// `Transaction.amount` is a Float, so it carries a rounding error the chain never
// had. Reconciliation must be an integer comparison, not a tolerance.
{
  check("whole BTC converts to satoshis exactly",
    btcToSats(0.00435799) === BigInt(435799) && btcToSats(1) === BigInt(100000000));
  check("the float representation does not leak into the integer",
    btcToSats(0.1 + 0.2) === BigInt(30000000),
    "0.1+0.2 is 0.30000000000000004 in IEEE-754; rounding to the satoshi is the honest read");
  check("21,000,000 BTC survives the conversion",
    btcToSats(21000000) === BigInt("2100000000000000"));
  check("a negative movement stays negative",
    btcToSats(-0.005) === BigInt(-500000));
}

// ══ THE LEDGER BECOMES CANONICAL MOVEMENTS ════════════════════════════════════
{
  const m = ledgerToChainMovements(LEDGER, "xpub-derived");
  check("one movement per ledger row, in order",
    m.length === 3 && m[0].dateISO === "2023-03-18" && m[2].dateISO === "2023-03-24");
  check("base units are exact integers, never the float",
    m.map((x) => x.baseUnitsDelta).reduce((a, b) => a + b, BigInt(0)) === LEDGER_TOTAL_SATS);
  check("the provider's transaction identity is preserved",
    m[0].eventId === "tx1",
    "a movement must keep the same key across re-runs or replay dedup breaks");
  check("the asset is named by identity, not by ticker",
    m.every((x) => x.assetKey === BTC_NATIVE.assetKey));
  check("an unidentified legacy row still gets a stable key",
    ledgerToChainMovements([{ ...LEDGER[0], externalTransactionId: null }], "a")[0]
      .eventId.startsWith("ledger-row:2023-03-18"));
}

// ══ RECONCILIATION IS THE LICENCE, AND IT IS EXACT ════════════════════════════
{
  const m = ledgerToChainMovements(LEDGER, "a");
  const good = reconcileMovementsAgainstBalance(m, btcToSats(OBSERVED_BTC));
  check("movements summing to the observed balance reconcile at ZERO residual",
    good.reconciles && good.residual === BigInt(0) && good.movementCount === 3);

  // §10 — remove one movement and the licence must collapse.
  const short = reconcileMovementsAgainstBalance(
    ledgerToChainMovements(LEDGER.slice(0, 2), "a"), btcToSats(OBSERVED_BTC));
  check("REMOVING ONE MOVEMENT breaks reconciliation",
    !short.reconciles && short.residual === BigInt(1414005),
    "the residual names exactly what is missing, in satoshis");

  check("a ONE-SATOSHI discrepancy is still a failure",
    !reconcileMovementsAgainstBalance(m, LEDGER_TOTAL_SATS + BigInt(1)).reconciles,
    "integer reconciliation has no tolerance to hide behind");

  // And the coverage upgrade follows the reconciliation, not the other way round.
  const scanned: ChainCoverage = {
    kind: "PARTIAL", coveredFromISO: "2023-03-18", coveredToISO: "2023-03-24",
    caveats: ["ADDRESS_INDEX_INCOMPLETE"], source: "btc-ledger",
  };
  const licensed = licenseCoverageByReconciliation(scanned, good, "2026-08-26");
  check("a closed residual upgrades the bounded scan to COMPLETE",
    licensed.kind === "COMPLETE");
  check("…extending only to the observation the arithmetic closed against",
    licensed.kind === "COMPLETE" && licensed.toISO === "2026-08-26");
  check("…and saying so in its source",
    licensed.source.includes("balance-reconciliation"));
  check("a BROKEN reconciliation earns no upgrade",
    licenseCoverageByReconciliation(scanned, short, "2026-08-26").kind === "PARTIAL",
    "a missing movement must leave the wallet unlicensed, not merely inaccurate");
}

// ══ A BOUNDED SCAN MAY NOT CLAIM COMPLETE ON ITS OWN ══════════════════════════
{
  const src = code(read("lib", "crypto", "btc-history-sync.ts"));
  check("the acquisition claims PARTIAL with the address-index caveat",
    /kind: "PARTIAL"/.test(src) && /ADDRESS_INDEX_INCOMPLETE/.test(src));
  check("…and never constructs a COMPLETE coverage itself",
    !/kind: "COMPLETE"/.test(src),
    "COMPLETE must be EARNED through the shared upgrade, never asserted here");
  check("the upgrade goes through the canonical function",
    /licenseCoverageByReconciliation\(scanned, recon, anchorDateISO\)/.test(src));
  check("no BTC-specific coverage vocabulary was invented",
    !/COMPLETE_ENOUGH|BTC_COMPLETE|nearly/i.test(src));
}

// ══ REPLAY: THE ENGINE, NOT A SECOND ONE ══════════════════════════════════════
{
  const m = ledgerToChainMovements(LEDGER, "a");
  const events = movementsToQuantityEvents(m, {
    accountId: "acc", instrumentId: "inst", decimals: BTC_NATIVE.decimals,
  });
  const timeline = replayQuantityTimeline({
    instrumentId: "inst", accountId: "acc",
    anchors: [{
      observationId: "obs", dateISO: "2023-03-24",
      effectiveDateTimeISO: "2023-03-24T00:00:00.000Z",
      quantity: OBSERVED_BTC, origin: "OBSERVED", completeness: "observed",
    }],
    events,
    windowFromISO: "2023-01-01", windowToISO: "2023-04-30",
    // The licence, in the engine's own vocabulary — the shape
    // `toEventStreamCompleteness` produces from a COMPLETE coverage. Passing a
    // bare string here licenses nothing and the replay correctly refuses.
    eventStream: { kind: "COMPLETE", fromISO: "2023-03-18", toISO: "2023-04-30", source: "btc-ledger+balance-reconciliation" },
    tolerance: 1e-8,
  });
  const rows = derivedRowsFromTimeline(timeline);
  const on = (d: string) => rows.find((r) => r.dateISO === d)?.quantity ?? null;

  check("the replay walks BACKWARD from the anchor to the first movement",
    Math.abs((on("2023-03-18") ?? -1) - 0.00435799) < 1e-9,
    "the earliest date must hold only the first receive, not the anchor total");
  check("…and accumulates forward correctly",
    Math.abs((on("2023-03-23") ?? -1) - (0.00435799 + 0.00178703)) < 1e-9
      && Math.abs((on("2023-03-24") ?? -1) - OBSERVED_BTC) < 1e-9);
  check("…carrying the quantity between movements",
    on("2023-03-20") === on("2023-03-18"));
  check("…and forward past the last movement to the window edge",
    Math.abs((on("2023-04-30") ?? -1) - OBSERVED_BTC) < 1e-9);
  check("BEFORE the first movement writes NOTHING — not zero",
    on("2023-01-15") === null && on("2023-03-17") === null,
    "uncovered time must be absent from the spine, never present as a zero");
  check("every written row is REPLAYED, so its basis is inspectable",
    rows.every((r) => typeof r.basis === "string" && r.basis.length > 0));
}

// ══ THE REFUSALS ══════════════════════════════════════════════════════════════
{
  const src = code(read("lib", "crypto", "btc-history-sync.ts"));
  check("a wallet with no POSTED native movements is refused, not approximated",
    /refusal: "NO_MOVEMENT_LEDGER"/.test(src));
  check("only NATIVE-denominated rows count as a quantity ledger",
    /currency: BTC_NATIVE\.symbol/.test(src),
    "a fiat-denominated seeded row is not a movement ledger");
  check("the anchor must be an OBSERVED position, never the legacy column",
    /PERMITTED_ANCHOR_ORIGINS/.test(src) && !/nativeBalance/.test(src));
  check("a wallet with no anchor is refused",
    /refusal: "NO_OBSERVED_ANCHOR"/.test(src));
  check("a failed reconciliation writes nothing",
    src.indexOf('refusal: "LEDGER_DOES_NOT_RECONCILE"') < src.indexOf("db.$transaction"));
  check("rows and their licence are persisted together",
    /persistPositionCoverage\(tx, accountId, instrumentId, licensed\)/.test(src));
}

// ══ THE XPUB BALANCE-BASIS QUESTION, ANSWERED NOT BLESSED ═════════════════════
//
// An xpub's current balance is the provider's `final_balance`, whose
// confirmed/unconfirmed basis is undocumented. Anchoring on a figure whose basis
// is unknown is exactly what this programme refuses to do.
{
  const src = read("lib", "crypto", "btc-history-sync.ts");
  check("the unknown basis is refused, not assumed away",
    /refusal: "BALANCE_BASIS_AMBIGUOUS"/.test(code(src)));
  check("…specifically when UNCONFIRMED movements exist",
    /const unconfirmed = rows\.length - posted\.length;/.test(code(src))
      && /if \(unconfirmed > 0\)/.test(code(src)),
    "with unconfirmed activity the sums could agree because BOTH include it");
  check("…and the reason names the ambiguity rather than hiding it",
    /balance basis is not attested/.test(src));
  check("the argument that DOES license it is written down",
    /established by arithmetic and the anchor is corroborated rather than\s*\n\s*\/\/\s*trusted/.test(src),
    "confirmed movements summing to the whole balance leave no room for anything else");
  check("reconciliation compares POSTED movements only",
    /r\.settlementState === SettlementState\.POSTED/.test(code(src)));
}

// ══ THE CARRY IS RETIRED FOR BTC, AND THE HELPER SURVIVES ═════════════════════
{
  check("no chain uses the legacy historical authority any more",
    !feedsLegacyWealthHistory("BTC") && !feedsLegacyWealthHistory("SOL")
      && !feedsLegacyWealthHistory("ETH") && !feedsLegacyWealthHistory("BNB")
      && !feedsLegacyWealthHistory("AVAX") && !feedsLegacyWealthHistory("MATIC"));
  // But BTC still writes the column for the CURRENT path, deliberately.
  check("BTC still writes the balance column for the CURRENT path",
    writesLegacyBalanceColumn("BTC") && !writesLegacyBalanceColumn("SOL"),
    "historical and current authority are different questions (invariant 32)");

  const binding = code(read("lib", "snapshots", "regenerate-history.ts"));
  check("the constant carry now governs LEGACY accounts only",
    /cryptoAccounts\.filter\(\(a\) => !spineAccountIds\.has\(a\.id\)\)\.every/.test(binding),
    "gating a spine account on another chain's ledger would refuse proven history");
  // The helper stays: lib/history/account-series.ts is still a legitimate caller.
  check("the constant-carry helper is NOT deleted — another caller remains",
    /licenseConstantQuantityCarry/.test(read("lib", "history", "account-series.ts")));

  check("the historical binding reads no legacy balance for a spine account",
    /if \(rows === undefined\) return null;/.test(binding));
}

// ══ A WALLET WITH NO EVIDENCE GETS NO HISTORY — AND IS NOT DROPPED ════════════
{
  const binding = code(read("lib", "snapshots", "regenerate-history.ts"));
  check("a materially-held wallet with no reconstruction stays APPLICABLE",
    /const materiallyHeld = Math\.abs\(account\?\.nativeBalance \?\? 0\) > 0;/.test(binding),
    "dropping it silently would let the total read as complete — the W6 defect");
  check("…so it refuses every day it touches rather than contributing zero",
    /if \(!materiallyHeld\) return false;/.test(binding));

  // The aggregate consequence, at the valuation core.
  const BTC = BTC_NATIVE.assetKey;
  const unknownSeed = valueCryptoDay({
    accounts: [
      { financialAccountId: "cold", name: "cold", nativeBalance: 0.24060252, assetKey: BTC, symbol: "BTC" },
      { financialAccountId: "seed", name: "seed", nativeBalance: null, assetKey: BTC, symbol: "BTC" },
    ],
    unitPriceByAssetKey: { [BTC]: 60000 }, quantityLicensed: true });
  check("a seeded wallet with unknown quantity refuses the DAY",
    !unknownSeed.licensed && unknownSeed.refusal === "QUANTITY_UNKNOWN");
  check("…rather than publishing the reconstructed wallet's value as the total",
    unknownSeed.nativeTotal === 0);
}

// ══ VALUE = LICENSED QUANTITY × DATED CLOSE ═══════════════════════════════════
{
  const BTC = BTC_NATIVE.assetKey;
  const valued = valueCryptoDay({
    accounts: [{ financialAccountId: "cold", name: "cold", nativeBalance: 0.24060252, assetKey: BTC, symbol: "BTC" }],
    unitPriceByAssetKey: { [BTC]: 112572.13 }, quantityLicensed: true });
  check("a licensed BTC quantity × the dated close is the value",
    valued.licensed && Math.abs(valued.nativeTotal - 0.24060252 * 112572.13) < 1e-6);

  const noPrice = valueCryptoDay({
    accounts: [{ financialAccountId: "cold", name: "cold", nativeBalance: 0.24060252, assetKey: BTC, symbol: "BTC" }],
    unitPriceByAssetKey: { [BTC]: null }, quantityLicensed: true });
  check("a missing BTC close is NO_PRICE, never zero",
    !noPrice.licensed && noPrice.refusal === "NO_PRICE" && noPrice.nativeTotal === 0);

  const sync = code(read("lib", "crypto", "btc-history-sync.ts"));
  check("the reconstruction reads no price at all — valuation is not its job",
    !/price|Price/.test(sync));
  check("…and no spot fallback exists in it",
    !/spot|SPOT/.test(sync));
}

// ══ CURRENT-ONLY CHAINS AND SOL ARE UNTOUCHED ═════════════════════════════════
{
  check("BTC and SOL keep HISTORY; ETH/BNB/AVAX keep CURRENT only",
    chainSupportsHistory("BTC") && chainSupportsHistory("SOL")
      && !chainSupportsHistory("ETH") && !chainSupportsHistory("BNB")
      && !chainSupportsHistory("AVAX"));
  check("MATIC remains UNSUPPORTED on its pricing question",
    walletChainSupport("MATIC") === "UNSUPPORTED");
  check("teaching history to read BTC positions granted no chain a new capability",
    walletChainSupport("ETH") === "CURRENT_POSITION_SUPPORTED"
      && walletChainSupport("BNB") === "CURRENT_POSITION_SUPPORTED"
      && walletChainSupport("AVAX") === "CURRENT_POSITION_SUPPORTED");

  // A current-only wallet still licenses no historical date.
  check("a fresh current-only observation licenses no historical date",
    resolveLicensedQuantityAsOf([{ dateISO: "2026-08-27", quantity: 12.5 }], null, "2026-02-27")
      .refusal === "NO_COVERAGE_RECORD");
  check("BTC's own licence is bounded and does not reach before its first movement",
    licensedInterval({ kind: "COMPLETE", fromISO: "2023-03-18", toISO: "2026-08-26", source: "x" })
      ?.fromISO === "2023-03-18");

  const sol = code(read("lib", "crypto", "sol-history-sync.ts"));
  check("SOL's reconstruction was not modified, only its shared helper moved",
    /derivedRowsFromTimeline/.test(sol) && !/derivedRowsFromTimeline\(\s*\n?\s*timeline: QuantityTimeline/.test(sol));
  check("BTC's rows are stamped with their OWN source, so the two never collide",
    BTC_RECONSTRUCTION_SOURCE === "btc-reconstruction");
}

// ══ DOCTRINE ══════════════════════════════════════════════════════════════════
{
  const doc = read("docs", "systems", "crypto-networks.md");
  check("doctrine: historical value is quantity evidence × dated price",
    /never a carried sync-time value/i.test(doc));
  check("doctrine: absence of movement is not proof of constant quantity",
    /not proof of constant quantity/i.test(doc));
  check("doctrine: a provider's current-balance basis cannot become a historical anchor",
    /cannot silently become a historical anchor/i.test(doc));
  check("doctrine: legacy ingest may remain provenance without remaining authority",
    /provenance without remaining read authority/i.test(doc));
}

console.log(`\nbtc-history: ${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
