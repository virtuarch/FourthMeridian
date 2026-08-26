/**
 * lib/crypto/native-asset.ts
 *
 * W-M0 — WHICH ASSET DOES A SELF-CUSTODY WALLET'S NATIVE BALANCE DENOMINATE?
 *
 * Pure: no Prisma, no DB, no clock, no network, no @/lib/db.
 *
 * ── Why this module exists ───────────────────────────────────────────────────
 * `FinancialAccount.nativeBalance` is a bare number. Nothing on the row says
 * what it counts. Until W-M0 the answer was supplied by a LITERAL at the point
 * of use — `symbol: "BTC"` at both `valueCryptoDay` call sites
 * (regenerate-history.ts, account-series.ts) and `currency: "BTC"` at every
 * movement-ledger predicate.
 *
 * That literal is correct for exactly as long as Bitcoin is the only chain that
 * can write a native balance. It is not a design; it is an assumption held in
 * place by the absence of a second syncer. The moment one exists, an ETH wallet
 * carrying 1.4 in `nativeBalance` is valued at the Bitcoin price and its ledger
 * is reconciled against Bitcoin-denominated rows. Both are silent, and both
 * produce a confident wrong number rather than a refusal.
 *
 * So the asset becomes DATA, resolved from the one column that already records
 * which chain the wallet is on, and an unrecognised chain resolves to NOTHING
 * rather than to Bitcoin. "We do not know what this wallet holds" is an answer;
 * "it holds Bitcoin because that is all we have ever held" is not.
 *
 * ── This is a fact about chains, not an identity claim ───────────────────────
 * A descriptor here says: chain C's native asset is symbol S with D decimals.
 * That is true of the chain whether or not this system can sync it, price it,
 * or resolve it to an `Instrument`. Canonical INSTRUMENT identity is
 * `lib/investments/crypto-instrument.ts`'s job and it is a database question;
 * this module is the pure descriptor the identity resolver and the valuation
 * core both read, so the two can never disagree about what "BTC" denominates.
 *
 * ── assetKey is IDENTITY; symbol is DISPLAY ───────────────────────────────────
 * W-M1a. A ticker is not an identity. It is chosen by whoever mints the asset,
 * it is not unique, and for tokens it is attacker-controlled: anyone can deploy
 * an ERC-20 called "SOL". Identity is therefore `assetKey` — a CAIP-19 asset
 * identifier, which names the CHAIN and then the asset ON that chain, so two
 * assets can share a ticker forever without ever colliding.
 *
 *   BTC  bip122:000000000019d6689c085ae165831e93/slip44:0
 *   ETH  eip155:1/slip44:60
 *   SOL  solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/slip44:501
 *
 * The chain reference is the truncated genesis-block hash (CAIP-2), so it is a
 * fact about the network rather than a name someone assigned; `slip44:<n>` is
 * the registered coin type, which is how CAIP-19 spells "the chain's own native
 * asset" as opposed to a contract or mint on it. USDC-on-Ethereum and
 * USDC-on-Solana will be `eip155:1/erc20:0x…` and `solana:5eykt…/token:EPjFW…`:
 * same ticker, same price, different assets, and correctly different identities.
 *
 * `symbol` survives, and only for display and denomination:
 *   1. `Transaction.currency` on a native on-chain movement row (btc-sync writes
 *      "BTC"), which is what scopes a wallet's movement ledger — a DENOMINATION,
 *      which for native assets coincides with the ticker;
 *   2. `Instrument.tickerSymbol`, which the schema pointedly does NOT make
 *      unique: "Display / weak identity — never the canonical primary key";
 *   3. the label a position renders.
 * It is NOT the alias key, NOT the price-map key, and NOT how any asset is
 * looked up. Anything that resolves BY symbol is a defect waiting for a second
 * asset to share one.
 *
 * NOTE ON TOKENS: this module describes NATIVE assets only — the one asset a
 * chain's base protocol denominates fees in. ERC-20 and SPL tokens are not
 * native assets, are not addressed by chain alone, and are deliberately absent.
 */

/** A chain's native asset — the descriptor, independent of any database row. */
export interface NativeAsset {
  /**
   * THE canonical identity — a CAIP-19 asset id. The `InstrumentAlias.externalId`
   * under provider "crypto", and the key every price map and lookup uses. Stable
   * forever: it is derived from the chain's genesis hash and a registered coin
   * type, so it cannot be re-pointed by anyone renaming anything.
   */
  assetKey: string;
  /** Canonical chain token, matching `FinancialAccount.walletChain` (uppercase). */
  chain:    string;
  /**
   * DISPLAY AND DENOMINATION ONLY — `Instrument.tickerSymbol` and, for a native
   * asset, `Transaction.currency`. Never identity. See the header.
   */
  symbol:   string;
  /** Human display name (Instrument.name). */
  name:     string;
  /**
   * Base units per whole unit, as a power of ten: BTC 8 (satoshi), ETH 18 (wei),
   * SOL 9 (lamport). The adapter normalises base units → whole units before any
   * canonical write, so this is the PRECISION of the whole-unit figure, not a
   * unit the domain ever handles.
   */
  decimals: number;
  /** The currency this asset is quoted and valued in. */
  currency: string;
}

/** CAIP-2 chain references — truncated genesis-block hashes, not names. */
const BITCOIN_MAINNET  = "bip122:000000000019d6689c085ae165831e93";
const ETHEREUM_MAINNET = "eip155:1";
const SOLANA_MAINNET   = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";

export const BTC_NATIVE: NativeAsset = {
  assetKey: `${BITCOIN_MAINNET}/slip44:0`,
  chain: "BTC", symbol: "BTC", name: "Bitcoin",  decimals: 8,  currency: "USD",
};
export const ETH_NATIVE: NativeAsset = {
  assetKey: `${ETHEREUM_MAINNET}/slip44:60`,
  chain: "ETH", symbol: "ETH", name: "Ethereum", decimals: 18, currency: "USD",
};
export const SOL_NATIVE: NativeAsset = {
  assetKey: `${SOLANA_MAINNET}/slip44:501`,
  chain: "SOL", symbol: "SOL", name: "Solana",   decimals: 9,  currency: "USD",
};

/**
 * Every chain whose native asset this system can name. A chain absent here is
 * not an error — it is an honest "unknown", and every consumer must refuse
 * rather than substitute.
 *
 * `SUPPORTED_CHAINS` in app/api/accounts/wallet/route.ts is deliberately WIDER
 * (MATIC, AVAX, DOT, ADA, XRP, OTHER): a user may record a wallet on a chain
 * this system cannot yet read. Recording custody is not the same as being able
 * to value it, and conflating the two is what produced the literal this module
 * replaces.
 */
export const NATIVE_ASSETS: readonly NativeAsset[] = [BTC_NATIVE, ETH_NATIVE, SOL_NATIVE];

const BY_CHAIN:  ReadonlyMap<string, NativeAsset> = new Map(NATIVE_ASSETS.map((a) => [a.chain, a]));
const BY_SYMBOL: ReadonlyMap<string, NativeAsset> = new Map(NATIVE_ASSETS.map((a) => [a.symbol, a]));
const BY_KEY:    ReadonlyMap<string, NativeAsset> = new Map(NATIVE_ASSETS.map((a) => [a.assetKey, a]));

/**
 * The native asset of a wallet on this chain, or null when the chain is absent,
 * blank or unrecognised.
 *
 * Matching is exact on the UPPERCASED, trimmed token. Deliberately no aliasing:
 * "bitcoin" does not resolve to BTC. The write path (POST /api/accounts/wallet)
 * uppercases and validates against a fixed list, so every production row already
 * carries a canonical token; accepting near-misses here would only paper over a
 * writer that had stopped doing that, and papering over is the failure mode this
 * module exists to remove.
 */
export function nativeAssetForChain(chain: string | null | undefined): NativeAsset | null {
  if (!chain) return null;
  return BY_CHAIN.get(chain.trim().toUpperCase()) ?? null;
}

/**
 * The native asset with this canonical assetKey, or null. THE identity lookup.
 * Exact match — an assetKey is a machine identifier, not user input.
 */
export function nativeAssetForKey(assetKey: string | null | undefined): NativeAsset | null {
  if (!assetKey) return null;
  return BY_KEY.get(assetKey) ?? null;
}

/**
 * The native asset with this ticker, or null.
 *
 * NARROW USE ONLY, and it is not an identity resolver. It answers "is this
 * DENOMINATION one of the native assets?" — which is meaningful because
 * `Transaction.currency` on a native movement row carries the ticker and the
 * schema offers nowhere else to put it. It is unambiguous today only because
 * NATIVE_ASSETS has unique symbols (pinned by test), and it stops being a safe
 * question the moment a token shares one. Resolve identity with
 * `nativeAssetForKey` or `nativeAssetForChain`; never with this.
 */
export function nativeAssetForSymbol(symbol: string | null | undefined): NativeAsset | null {
  if (!symbol) return null;
  return BY_SYMBOL.get(symbol.trim().toUpperCase()) ?? null;
}

/**
 * THE FLOAT64 FLOOR ON LEDGER RECONCILIATION.
 *
 * A ledger reconciliation asks whether Σ(signed movements) equals an observed
 * balance. Both sides are `Float`s (Transaction.amount, FinancialAccount
 * .nativeBalance), so the comparison cannot be finer than float64 can represent
 * at the magnitudes involved: a float64 near 1.0 has a ULP of ~2.2e-16, and
 * summing a few hundred movements accumulates several ULPs of ordinary rounding
 * error that says nothing about missing rows.
 *
 * For an 8- or 9-decimal asset this never binds — one satoshi (1e-8) and one
 * lamport (1e-9) are both far above the noise. For an 18-decimal asset it binds
 * absolutely: one wei is 1e-18, which is BELOW the representable difference, so
 * a wei-exact tolerance would classify every ETH ledger as short no matter how
 * complete it was.
 *
 * 1e-12 is therefore a STATED FLOOR, not a precision claim. It is ~4 orders
 * above float64 noise at unit magnitudes and ~6 orders below any economically
 * meaningful quantity of ETH. An 18-decimal ledger that genuinely needs
 * wei-exact reconciliation needs INTEGER BASE UNITS end to end — a schema
 * question (Transaction.amount is a Float), explicitly out of W-M0's scope and
 * recorded here rather than silently approximated.
 */
export const LEDGER_EPSILON_FLOOR = 1e-12;

/**
 * The reconciliation tolerance for an asset: one base unit, floored at what
 * float64 can actually distinguish.
 *
 *   BTC (8)  → 1e-8   one satoshi — IDENTICAL to the pre-W-M0 LEDGER_EPSILON
 *   SOL (9)  → 1e-9   one lamport
 *   ETH (18) → 1e-12  the float floor (see LEDGER_EPSILON_FLOOR)
 *
 * A null asset yields the floor: an unknown asset has no base unit, and the
 * loosest defensible tolerance is the least likely to manufacture a shortfall
 * we cannot explain. Callers should refuse on the unknown asset itself long
 * before the tolerance matters.
 */
export function ledgerEpsilonFor(asset: NativeAsset | null): number {
  if (!asset) return LEDGER_EPSILON_FLOOR;
  const baseUnit = Math.pow(10, -asset.decimals);
  return baseUnit > LEDGER_EPSILON_FLOOR ? baseUnit : LEDGER_EPSILON_FLOOR;
}
