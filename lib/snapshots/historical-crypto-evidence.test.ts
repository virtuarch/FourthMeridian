/**
 * lib/snapshots/historical-crypto-evidence.test.ts
 *
 * W6 — an unknown historical quantity is not a zero.
 *
 *     npx tsx lib/snapshots/historical-crypto-evidence.test.ts
 *
 * The defect: `valueCryptoDay` read `nativeBalance ?? 0` and then filtered out
 * anything at or below the materiality epsilon. An account whose historical
 * quantity was UNKNOWN therefore looked exactly like an account that held
 * NOTHING — it was dropped, the day still reported `licensed: true`, and the
 * stored `crypto` figure was composed from the remaining wallets and stamped
 * `supported`. The aggregate asserted a completeness it did not have:
 *
 *     BTC $18,869.73 · SOL unknown  →  crypto $18,869.73, "supported"
 *
 * What is pinned here is the boundary between the five answers a historical
 * crypto day can give, and the rule that only two of them are numbers.
 */

import { readFileSync } from "fs";
import { join } from "path";
import { valueCryptoDay } from "@/lib/crypto/historical-crypto-valuation.core";
import { resolvePositionAsOf, type PositionRow } from "@/lib/investments/reconstruction-read";
import {
  resolveCryptoValuationState, isCryptoAssertable, isAssetSideContaminated,
} from "@/lib/snapshots/crypto-valuation-status.core";
import { PositionOrigin } from "@prisma/client";

let failures = 0, passes = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) passes++;
  else { failures++; console.log(`[FAIL] ${name}`); if (detail) console.log(`        ${detail}`); }
}
const read = (...s: string[]) => readFileSync(join(process.cwd(), ...s), "utf8");
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");

const BTC = "bip122:000000000019d6689c085ae165831e93/slip44:0";
const SOL = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/slip44:501";
const ETH = "eip155:1/slip44:60";

const acct = (id: string, qty: number | null, assetKey: string, symbol: string, applicable?: boolean) => ({
  financialAccountId: id, name: id, nativeBalance: qty, assetKey, symbol,
  ...(applicable === undefined ? {} : { applicable }),
});

// ══ THE FIVE ANSWERS, EACH DISTINCT ═══════════════════════════════════════════
//
// Collapsing any two of these is how a chart shows a confident wrong number.
{
  // 1. VALUED — quantity known, price known.
  const valued = valueCryptoDay({
    accounts: [acct("sol", 100.776600602, SOL, "SOL")],
    unitPriceByAssetKey: { [SOL]: 100 }, quantityLicensed: true });
  check("VALUED: licensed quantity × dated price is a number",
    valued.licensed && Math.abs(valued.nativeTotal - 10077.6600602) < 1e-9);

  // 2. CONFIRMED ZERO — the wallet held nothing, and that is evidence.
  const zero = valueCryptoDay({
    accounts: [acct("btc", 0.25, BTC, "BTC"), acct("sol", 0, SOL, "SOL")],
    unitPriceByAssetKey: { [BTC]: 60000, [SOL]: 100 }, quantityLicensed: true });
  check("CONFIRMED_ZERO: a known zero is not a position and refuses nothing",
    zero.licensed && zero.nativeTotal === 15000 && zero.positionCount === 1);
  check("…and is NOT reported as an unknown quantity",
    zero.unknownQuantityAccountIds.length === 0);

  // 3. NO_PRICE — quantity known and non-zero, price unavailable.
  const noPrice = valueCryptoDay({
    accounts: [acct("btc", 0.25, BTC, "BTC"), acct("sol", 100.7766, SOL, "SOL")],
    unitPriceByAssetKey: { [BTC]: 60000, [SOL]: null }, quantityLicensed: true });
  check("NO_PRICE: an unpriceable held asset refuses the DAY, naming the asset",
    !noPrice.licensed && noPrice.refusal === "NO_PRICE" && noPrice.unpricedAssetKeys.join() === SOL);
  check("…and publishes no number — never BTC alone passed off as the total",
    noPrice.nativeTotal === 0 && noPrice.positions.length === 0);

  // 4. UNKNOWN / UNLICENSED — the wallet was here; what it held is unrecoverable.
  //    THE W6 DEFECT. Before this slice the day was licensed and worth $15,000.
  const unknown = valueCryptoDay({
    accounts: [acct("btc", 0.25, BTC, "BTC"), acct("sol", null, SOL, "SOL")],
    unitPriceByAssetKey: { [BTC]: 60000, [SOL]: 100 }, quantityLicensed: true });
  check("UNKNOWN: an unlicensed quantity REFUSES the day",
    !unknown.licensed && unknown.refusal === "QUANTITY_UNKNOWN");
  check("…naming the account whose evidence is missing",
    unknown.unknownQuantityAccountIds.join() === "sol");
  check("…counting it as a position that EXISTED, so no denominator lies",
    unknown.positionCount === 2);
  check("…and producing NO number at all",
    unknown.nativeTotal === 0 && unknown.positions.length === 0);
  check("UNKNOWN and CONFIRMED_ZERO reach OPPOSITE verdicts on identical input shape",
    zero.licensed && !unknown.licensed,
    "if these ever agree, `?? 0` is back");

  // 5. NOT_APPLICABLE — no evidence places the account here at all.
  const notApplicable = valueCryptoDay({
    accounts: [acct("btc", 0.25, BTC, "BTC"), acct("eth", null, ETH, "ETH", false)],
    unitPriceByAssetKey: { [BTC]: 60000 }, quantityLicensed: true });
  check("NOT_APPLICABLE: an account outside its existence interval refuses nothing",
    notApplicable.licensed && notApplicable.nativeTotal === 15000);
  check("…and is not counted as a position that existed",
    notApplicable.positionCount === 1 && notApplicable.unknownQuantityAccountIds.length === 0);
}

// ══ THE AGGREGATE MUST NOT CLAIM COMPLETENESS ═════════════════════════════════
//
// A refused day reaches the row as `cryptoValuationStatus: "unavailable"`, and
// the ratified authority then refuses the asset side rather than labelling it.
{
  const refused = resolveCryptoValuationState({
    crypto: 18869.73, isEstimated: true, cryptoValuationStatus: "unavailable" });
  check("a refused day resolves to `unavailable`", refused === "unavailable");
  check("…which is NOT assertable", !isCryptoAssertable(refused));
  check("…and contaminates netWorth/totalAssets, which are composed from it",
    isAssetSideContaminated(refused));

  // The forbidden shape: BTC known, SOL unknown, total published as complete.
  const asIfComplete = resolveCryptoValuationState({
    crypto: 18869.73, isEstimated: true, cryptoValuationStatus: "supported" });
  check("a `supported` stamp WOULD assert the number — which is exactly why an "
      + "unknown quantity must never reach that stamp",
    isCryptoAssertable(asIfComplete));

  // A genuine zero stays a legitimate answer.
  const none = resolveCryptoValuationState({
    crypto: 0, isEstimated: true, cryptoValuationStatus: "supported" });
  check("no material crypto is a legitimate zero, not a refusal",
    none === "none" && isCryptoAssertable(none));
}

// ══ CURRENT EVIDENCE LICENSES A POINT, NOT AN INTERVAL ════════════════════════
//
// §13 — the first-class invariant. A wallet with history through X and a later
// current observation on Y must not use Y's quantity for X+1 … Y−1.
{
  const rows: PositionRow[] = [
    { date: "2026-02-26", quantity: 100.776600602, origin: PositionOrigin.DERIVED,  completeness: "REPLAYED" },
    { date: "2026-02-27", quantity: 0.751600602,   origin: PositionOrigin.DERIVED,  completeness: "REPLAYED" },
    // …history ends here. A sync months later observes a much larger balance.
    { date: "2026-08-26", quantity: 42.5,          origin: PositionOrigin.OBSERVED, completeness: null },
  ];

  check("the later OBSERVED quantity does not appear on a date before it",
    resolvePositionAsOf(rows, "2026-05-01").quantity === 0.751600602,
    "resolution must be nearest-on-or-BEFORE, never nearest-overall");
  check("…nor on the day before it",
    resolvePositionAsOf(rows, "2026-08-25").quantity === 0.751600602);
  check("…and it does stand on its own date",
    resolvePositionAsOf(rows, "2026-08-26").quantity === 42.5);
  check("a date before ALL evidence is unknown — not zero, not the first quantity",
    resolvePositionAsOf(rows, "2022-01-01").quantity === null
      && resolvePositionAsOf(rows, "2022-01-01").origin === null);
  check("an OBSERVED row outranks a DERIVED one on the same date",
    resolvePositionAsOf(
      [{ date: "2026-08-26", quantity: 9, origin: PositionOrigin.DERIVED, completeness: "REPLAYED" }, rows[2]],
      "2026-08-26").quantity === 42.5);

  // And the binding must not let the resolver carry past the licensed edge.
  const binding = code(read("lib", "snapshots", "regenerate-history.ts"));
  // W6b — the bound is the persisted COVERAGE, not the shape of the rows.
  check("the regeneration asks the coverage licence before returning a quantity",
    /resolveLicensedQuantityAsOf\(/.test(binding) && /licence\.refusal !== null\) return null/.test(binding),
    "without this, a current observation silently licenses every later date");
}

// ══ CURRENT-ONLY CHAINS GAIN NO HISTORY ═══════════════════════════════════════
//
// §14 — teaching the historical consumer to read the spine must NOT promote
// ETH/BNB/AVAX. Their single observation is today's; every earlier date is
// outside their existence interval, so they neither contribute nor refuse.
{
  const todayOnly: PositionRow[] = [
    { date: "2026-08-26", quantity: 12.5, origin: PositionOrigin.OBSERVED, completeness: null },
  ];
  for (const d of ["2025-01-01", "2026-02-27", "2026-08-25"]) {
    check(`a current-only wallet has NO quantity on ${d}`,
      resolvePositionAsOf(todayOnly, d).quantity === null);
  }
  // Which the binding turns into NOT_APPLICABLE, not a refusal of everyone else.
  const withEth = valueCryptoDay({
    accounts: [acct("btc", 0.25, BTC, "BTC"), acct("eth", null, ETH, "ETH", false)],
    unitPriceByAssetKey: { [BTC]: 60000 }, quantityLicensed: true });
  check("adding an ETH wallet does not black out a year of BTC history",
    withEth.licensed && withEth.nativeTotal === 15000);

  const binding = code(read("lib", "snapshots", "regenerate-history.ts"));
  check("existence begins at the wallet's FIRST dated evidence, not its connection date",
    /dISO >= earliest/.test(binding),
    "flooring on createdAt would delete Solana's four years of proven history");
  check("a spine wallet with no dated evidence at all is applicable NOWHERE",
    /if \(earliest === undefined\) return false/.test(binding));
}

// ══ NO LEGACY FALLBACK FOR SPINE-BACKED CRYPTO ════════════════════════════════
{
  const binding = code(read("lib", "snapshots", "regenerate-history.ts"));
  check("membership is decided by CHAIN, not by whether rows were found",
    /const spineAccountIds = new Set\(spineCryptoAccounts\.map/.test(binding),
    "keying off map presence let a spine wallet with no rows fall back to the column");
  check("a spine-backed account with no rows resolves to UNKNOWN, never the column",
    /if \(rows === undefined\) return null;/.test(binding));
  check("the legacy column is still read for legacy chains only",
    /cryptoAccounts\.find\(\(a\) => a\.id === accountId\)\?\.nativeBalance \?\? null/.test(binding));
  check("the historical path reads no CURRENT wallet value authority",
    !/loadWalletCurrentValues/.test(binding),
    "a current observation must not reach a historical day");
}

// ══ BTC IS UNCHANGED ══════════════════════════════════════════════════════════
{
  // BTC composes from the legacy column, which is never null for a live wallet;
  // an ABSENT column is no balance evidence and stays NOT_APPLICABLE, exactly as
  // it behaved before W6.
  const btcOnly = valueCryptoDay({
    accounts: [acct("cold", 0.24060252, BTC, "BTC"), acct("jane", 0.02, BTC, "BTC"),
               acct("john", 0.038, BTC, "BTC"), acct("zero", 0, BTC, "BTC"),
               acct("absent", null, BTC, "BTC", false)],
    unitPriceByAssetKey: { [BTC]: 63075.67381531628 }, quantityLicensed: true });
  check("the live BTC corpus values exactly as before",
    btcOnly.licensed && btcOnly.positionCount === 3
      && Math.abs(btcOnly.nativeTotal - (0.24060252 + 0.02 + 0.038) * 63075.67381531628) < 1e-6);
  check("an absent BTC column contributes nothing and refuses nothing",
    btcOnly.unknownQuantityAccountIds.length === 0);

  const binding = code(read("lib", "snapshots", "regenerate-history.ts"));
  check("a legacy account with an absent column is NOT_APPLICABLE, never unknown",
    /nativeBalance != null;/.test(binding));
  check("the legacy carry licence is untouched",
    /cryptoQuantityLicensed\(dISO\)/.test(binding));
}

// ══ THE CONTRACT IS DECLARED, NOT INFERRED ════════════════════════════════════
{
  const core = read("lib", "crypto", "historical-crypto-valuation.core.ts");
  check("the refusal vocabulary carries QUANTITY_UNKNOWN",
    /"QUANTITY_UNKNOWN"/.test(core));
  check("QUANTITY_UNKNOWN is distinguished from the day-wide QUANTITY_UNLICENSED",
    /Distinct from QUANTITY_UNLICENSED/.test(core));
  check("`applicable` defaults to TRUE, so a caller that has not considered "
      + "existence gets the conservative answer",
    /a caller that has not thought about\s*\n\s*\*\s*existence gets the conservative answer/.test(core));
  const stripped = code(core);
  check("the `?? 0` that caused the defect is gone from the quantity filter",
    !/nativeBalance \?\? 0/.test(stripped));
}

// ══ DOCTRINE ══════════════════════════════════════════════════════════════════
{
  const doc = read("docs", "systems", "crypto-networks.md");
  check("doctrine: an unknown historical quantity is not zero",
    /unknown historical quantity is not a zero/i.test(doc));
  check("doctrine: a numeric aggregate must not imply completeness",
    /must not imply completeness/i.test(doc));
  check("doctrine: legacy storage is not a universal fallback",
    /legacy storage is not a universal fallback/i.test(doc));
}

console.log(`\nhistorical-crypto-evidence: ${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
