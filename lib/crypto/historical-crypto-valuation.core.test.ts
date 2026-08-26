/**
 * lib/crypto/historical-crypto-valuation.core.test.ts
 *
 * W-M0 — the crypto day valuation, now per-asset.
 *
 *     npx tsx lib/crypto/historical-crypto-valuation.core.test.ts
 *
 * Pure: no DB, no clock, no network.
 *
 * ── PART A is the acceptance criterion, and it is the whole point ────────────
 * "BTC behaviour must be byte-identical." A source-scan cannot show that and a
 * fixture of expected numbers only shows that the numbers match what SOMEONE
 * typed. So PART A carries the PRE-W-M0 implementation verbatim — the exact
 * function body as it stood at fca9a63 — and asserts that for every BTC-shaped
 * input the two produce the same answer, field for field.
 *
 * That reference is deliberately a copy and deliberately frozen. It is not a
 * second authority: nothing imports it, it values nothing, and when BTC is
 * eventually cut over to the position spine it should be deleted along with the
 * carry it describes.
 *
 * PART B covers what only became expressible once the asset was data: two
 * assets at two prices, an asset nobody can name, and the refusals that must
 * stay distinguishable from one another.
 */

import {
  valueCryptoDay,
  type CryptoAccountBalance,
  type CryptoDayValuation,
} from "./historical-crypto-valuation.core";
import { BTC_NATIVE, ETH_NATIVE } from "./native-asset";

const BTC = BTC_NATIVE.assetKey;
const ETH = ETH_NATIVE.assetKey;

let failures = 0;
let passes = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) { passes++; }
  else { failures++; console.log(`[FAIL] ${name}`); if (detail) console.log(`        ${detail}`); }
}

// ── PART A — the frozen pre-W-M0 reference ───────────────────────────────────

/** The account shape the pre-W-M0 core took: symbol was a non-null literal. */
interface LegacyAccount {
  financialAccountId: string;
  name:               string;
  nativeBalance:      number | null;
  symbol:             string;
}

/**
 * `valueCryptoDay` EXACTLY as it stood before W-M0 (lib/crypto/
 * historical-crypto-valuation.core.ts @ fca9a63). One price for the whole
 * account set; the symbol carried through for display and deciding nothing.
 * Frozen — never "fixed", never imported by production.
 */
function valueCryptoDayLegacy(input: {
  accounts: readonly LegacyAccount[];
  unitPrice: number | null;
  quantityLicensed: boolean;
  materialityEpsilon?: number;
}) {
  const eps = input.materialityEpsilon ?? 0;
  const held = [...input.accounts]
    .filter((a) => Math.abs(a.nativeBalance ?? 0) > eps)
    .sort((a, b) => a.financialAccountId.localeCompare(b.financialAccountId));

  if (input.unitPrice == null || !Number.isFinite(input.unitPrice) || input.unitPrice <= 0) {
    return { positions: [], nativeTotal: 0, positionCount: held.length, licensed: false, refusal: "NO_PRICE" as const };
  }
  if (!input.quantityLicensed) {
    return { positions: [], nativeTotal: 0, positionCount: held.length, licensed: false, refusal: "QUANTITY_UNLICENSED" as const };
  }

  const positions = held.map((a) => {
    const quantity = a.nativeBalance ?? 0;
    return {
      financialAccountId: a.financialAccountId,
      accountName:        a.name,
      symbol:             a.symbol,
      quantity,
      unitPrice:          input.unitPrice!,
      nativeValue:        quantity * input.unitPrice!,
    };
  });

  return {
    positions,
    nativeTotal:   positions.reduce((n, p) => n + p.nativeValue, 0),
    positionCount: positions.length,
    licensed:      true,
    refusal:       null,
  };
}

/** Deep equality over the fields both shapes share. `unpricedAssetKeys` and
 *  `assetKey` are additive — the pre-W-M0 core had neither. */
function sameAsLegacy(now: CryptoDayValuation, legacy: ReturnType<typeof valueCryptoDayLegacy>): boolean {
  return now.licensed === legacy.licensed
    && now.refusal === legacy.refusal
    && now.positionCount === legacy.positionCount
    && Object.is(now.nativeTotal, legacy.nativeTotal)
    && now.positions.length === legacy.positions.length
    && now.positions.every((p, i) => {
      const q = legacy.positions[i];
      return p.financialAccountId === q.financialAccountId
        && p.accountName === q.accountName
        && p.symbol      === q.symbol
        && Object.is(p.quantity,   q.quantity)
        && Object.is(p.unitPrice,  q.unitPrice)
        && Object.is(p.nativeValue, q.nativeValue);
    });
}

// The live corpus, exactly: three BTC wallets, one of them the real one, plus
// the balance-less rows that must stay out of both the count and the total.
const LIVE_BTC: LegacyAccount[] = [
  { financialAccountId: "acc_cold", name: "Cold Wallet BTC", nativeBalance: 0.24060252, symbol: "BTC" },
  { financialAccountId: "acc_jane", name: "Jane BTC Wallet", nativeBalance: 0.02,       symbol: "BTC" },
  { financialAccountId: "acc_john", name: "John BTC Wallet", nativeBalance: 0.038,      symbol: "BTC" },
  { financialAccountId: "acc_zero", name: "Crypto",          nativeBalance: 0,          symbol: "BTC" },
  { financialAccountId: "acc_null", name: "Exchange",        nativeBalance: null,       symbol: "BTC" },
];

// Real archived closes from the live corpus, plus the boundary values that
// select each refusal branch.
const PRICES: (number | null)[] = [63075.67381531628, 62833.6446085629, 63452.96020776567, 1, 1e-9, null, 0, -1, NaN, Infinity];
const LICENCES = [true, false];
const SETS: LegacyAccount[][] = [
  LIVE_BTC,
  [],                                        // no crypto at all
  [LIVE_BTC[0]],                             // the single real wallet
  [LIVE_BTC[3], LIVE_BTC[4]],                // held nothing / knows nothing
  [...LIVE_BTC].reverse(),                   // input order must not matter
  [{ financialAccountId: "acc_neg", name: "Negative", nativeBalance: -0.5, symbol: "BTC" }],
];

/**
 * W-M1a — the fixtures are written in the legacy (ticker-only) shape because
 * that is what the frozen reference takes. Identity is attached here, at the
 * boundary, so the two implementations see the SAME accounts and any difference
 * is genuinely the implementation's.
 */
const withIdentity = (accounts: readonly LegacyAccount[]): CryptoAccountBalance[] =>
  accounts.map((a) => ({ ...a, assetKey: BTC }));

let compared = 0;
let divergences = 0;
for (const accounts of SETS) {
  for (const unitPrice of PRICES) {
    for (const quantityLicensed of LICENCES) {
      const legacy = valueCryptoDayLegacy({ accounts, unitPrice, quantityLicensed });
      const now = valueCryptoDay({
        accounts: withIdentity(accounts),
        // The one-asset case: the map has exactly the entry the old scalar was.
        unitPriceByAssetKey: { [BTC]: unitPrice },
        quantityLicensed,
      });
      compared++;
      if (!sameAsLegacy(now, legacy)) {
        divergences++;
        if (divergences <= 3) {
          console.log(`        diverged @ n=${accounts.length} price=${unitPrice} licensed=${quantityLicensed}`);
          console.log(`          legacy: ${JSON.stringify(legacy)}`);
          console.log(`          now:    ${JSON.stringify(now)}`);
        }
      }
    }
  }
}
check(`BTC is BYTE-IDENTICAL to the pre-W-M0 core across ${compared} input combinations`,
  divergences === 0, `${divergences} divergence(s)`);

// An ABSENT map entry must behave exactly as the old explicit null did — the
// migration hazard, since `{}` and `{ BTC: null }` are different objects that
// have to mean the same thing.
check("a missing price ENTRY behaves as the old explicit null price",
  sameAsLegacy(
    valueCryptoDay({ accounts: withIdentity(LIVE_BTC), unitPriceByAssetKey: {}, quantityLicensed: true }),
    valueCryptoDayLegacy({ accounts: LIVE_BTC, unitPrice: null, quantityLicensed: true }),
  ));

// ── PART B — what only became expressible once the asset was data ────────────

const MIXED: CryptoAccountBalance[] = [
  { financialAccountId: "acc_btc", name: "Cold Wallet BTC", nativeBalance: 0.25, assetKey: BTC, symbol: "BTC" },
  { financialAccountId: "acc_eth", name: "Ledger ETH",      nativeBalance: 1.5,  assetKey: ETH, symbol: "ETH" },
];

{
  const day = valueCryptoDay({
    accounts: MIXED,
    unitPriceByAssetKey: { [BTC]: 60000, [ETH]: 3000 },
    quantityLicensed: true,
  });
  check("two assets are valued at their OWN prices", day.licensed && day.nativeTotal === 0.25 * 60000 + 1.5 * 3000,
    JSON.stringify(day));
  check("…and each position reports the asset it was actually valued in",
    day.positions.find((p) => p.symbol === "ETH")?.unitPrice === 3000
      && day.positions.find((p) => p.symbol === "BTC")?.unitPrice === 60000);

  // THE regression this slice exists to make impossible. Before W-M0 the ETH
  // wallet would have been multiplied by the Bitcoin close and labelled BTC.
  check("an ETH wallet is NEVER valued at the Bitcoin price",
    day.positions.find((p) => p.financialAccountId === "acc_eth")!.nativeValue === 4500);

  // W-M1a — the ticker is carried for display and decides nothing. Two assets
  // sharing one would still be priced apart, because the key is the identity.
  const spoof = valueCryptoDay({
    accounts: [
      { financialAccountId: "acc_native", name: "Native ETH", nativeBalance: 1, assetKey: ETH, symbol: "ETH" },
      { financialAccountId: "acc_spoof",  name: "Token ETH",  nativeBalance: 1, assetKey: "eip155:1/erc20:0xdead", symbol: "ETH" },
    ],
    unitPriceByAssetKey: { [ETH]: 3000, "eip155:1/erc20:0xdead": 0.01 },
    quantityLicensed: true,
  });
  check("TWO assets sharing the ticker ETH are priced by IDENTITY, not by symbol",
    spoof.licensed
      && spoof.positions.find((p) => p.financialAccountId === "acc_native")!.nativeValue === 3000
      && spoof.positions.find((p) => p.financialAccountId === "acc_spoof")!.nativeValue === 0.01);
  check("…and each position reports the identity it was valued under",
    spoof.positions.every((p) => p.assetKey.length > 0)
      && new Set(spoof.positions.map((p) => p.assetKey)).size === 2
      && new Set(spoof.positions.map((p) => p.symbol)).size === 1);
}

{
  // One asset priced, one not → the WHOLE day refuses, and says which.
  const day = valueCryptoDay({
    accounts: MIXED, unitPriceByAssetKey: { [BTC]: 60000 }, quantityLicensed: true,
  });
  check("one unpriced asset refuses the whole day (all-or-nothing preserved)",
    !day.licensed && day.refusal === "NO_PRICE" && day.nativeTotal === 0 && day.positions.length === 0);
  check("…naming exactly the asset that is missing, by IDENTITY not ticker",
    day.unpricedAssetKeys.join(",") === ETH);
  check("…while still counting what EXISTED (the denominator is unaffected)", day.positionCount === 2);
}

{
  // The pre-W-M0 silent case: a wallet whose chain nobody could name.
  const day = valueCryptoDay({
    accounts: [{ financialAccountId: "acc_x", name: "Some Wallet", nativeBalance: 3, assetKey: null, symbol: null }],
    unitPriceByAssetKey: { [BTC]: 60000 },
    quantityLicensed: true,
  });
  check("an unnamed asset refuses as UNKNOWN_ASSET, not NO_PRICE",
    !day.licensed && day.refusal === "UNKNOWN_ASSET");
  check("…and is NOT valued at whatever price happened to be in hand",
    day.nativeTotal === 0 && day.positions.length === 0);
  check("…and names no missing symbol (there is no name to give)", day.unpricedAssetKeys.length === 0);
}

{
  // A wallet holding NOTHING never reaches the asset check — it is not a
  // position, so an unknown chain on an empty wallet cannot poison a real one.
  const day = valueCryptoDay({
    accounts: [
      { financialAccountId: "acc_btc", name: "Cold", nativeBalance: 0.25, assetKey: BTC, symbol: "BTC" },
      { financialAccountId: "acc_x",   name: "Empty MATIC", nativeBalance: 0, assetKey: null, symbol: null },
    ],
    unitPriceByAssetKey: { [BTC]: 60000 },
    quantityLicensed: true,
  });
  check("an EMPTY wallet on an unknown chain is not a position and refuses nothing",
    day.licensed && day.positionCount === 1 && day.nativeTotal === 15000);
}

{
  // Refusal precedence: an unnamed asset outranks an unlicensed quantity,
  // because "we do not know what this is" is the more fundamental answer.
  const day = valueCryptoDay({
    accounts: [{ financialAccountId: "a", name: "n", nativeBalance: 1, assetKey: null, symbol: null }],
    unitPriceByAssetKey: {}, quantityLicensed: false,
  });
  check("UNKNOWN_ASSET outranks both NO_PRICE and QUANTITY_UNLICENSED",
    day.refusal === "UNKNOWN_ASSET");
}

{
  // Quantity and price absence stay distinguishable — the acceptance invariant.
  const noPrice = valueCryptoDay({ accounts: MIXED, unitPriceByAssetKey: {}, quantityLicensed: true });
  const noCarry = valueCryptoDay({ accounts: MIXED, unitPriceByAssetKey: { [BTC]: 1, [ETH]: 1 }, quantityLicensed: false });
  check("a missing PRICE and an unlicensed QUANTITY are different refusals",
    noPrice.refusal === "NO_PRICE" && noCarry.refusal === "QUANTITY_UNLICENSED");
  check("…and neither becomes a zero-valued position",
    noPrice.positions.length === 0 && noCarry.positions.length === 0);
}

{
  // Two wallets, same asset — the multi-wallet shape, which must aggregate
  // without double counting and without minting a second asset identity.
  const day = valueCryptoDay({
    accounts: [
      { financialAccountId: "w1", name: "Wallet 1", nativeBalance: 0.1, assetKey: BTC, symbol: "BTC" },
      { financialAccountId: "w2", name: "Wallet 2", nativeBalance: 0.2, assetKey: BTC, symbol: "BTC" },
    ],
    unitPriceByAssetKey: { [BTC]: 50000 }, quantityLicensed: true,
  });
  check("two wallets in one asset aggregate at one price, as two positions",
    day.licensed && day.positions.length === 2 && Math.abs(day.nativeTotal - 15000) < 1e-9);
}

{
  // The DECLARED-SET half of the price contract, and why it exists. With every
  // wallet empty there is nothing held to demand a price for — but the day still
  // has to answer "did a price reach this date?", because the caller's next move
  // is to decide whether it may assert a digital-asset total at all. Requiring
  // only HELD assets would silently license a zero.
  const drained: CryptoAccountBalance[] = [
    { financialAccountId: "acc_drained", name: "Drained Wallet", nativeBalance: 0, assetKey: BTC, symbol: "BTC" },
  ];
  const noClose = valueCryptoDay({ accounts: drained, unitPriceByAssetKey: { [BTC]: null }, quantityLicensed: true });
  check("a drained wallet on a day with NO close still refuses (absence never becomes zero)",
    !noClose.licensed && noClose.refusal === "NO_PRICE" && noClose.unpricedAssetKeys.join(",") === BTC);
  const withClose = valueCryptoDay({ accounts: drained, unitPriceByAssetKey: { [BTC]: 60000 }, quantityLicensed: true });
  check("…and the same wallet on a day WITH a close is licensed at zero positions",
    withClose.licensed && withClose.positionCount === 0 && withClose.nativeTotal === 0);
}

check("determinism — identical input, identical output",
  JSON.stringify(valueCryptoDay({ accounts: MIXED, unitPriceByAssetKey: { [BTC]: 1, [ETH]: 2 }, quantityLicensed: true }))
    === JSON.stringify(valueCryptoDay({ accounts: [...MIXED].reverse(), unitPriceByAssetKey: { [ETH]: 2, [BTC]: 1 }, quantityLicensed: true })));

console.log(`\nhistorical-crypto-valuation.core: ${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
