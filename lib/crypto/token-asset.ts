/**
 * lib/crypto/token-asset.ts
 *
 * TOKEN HOLDINGS FOUNDATION (PR-A) — WHAT A TOKEN IS, BEFORE ANYTHING IS STORED.
 *
 * Pure: no Prisma client, no DB, no clock, no network, no @/lib/db.
 *
 * A native asset is named by its chain (lib/crypto/native-asset.ts). A token is
 * not: it is named by the CONTRACT (ERC-20) or MINT (SPL) that defines it, on a
 * chain. Its ticker and name are chosen by whoever deployed it and are
 * attacker-controlled — anyone can deploy an ERC-20 called "ETH" or an SPL mint
 * called "USDC". So, exactly as for native assets:
 *
 *   identity  = a CAIP-19 asset id (the `assetKey`), the InstrumentAlias
 *               externalId under provider "crypto" — the SAME vocabulary native
 *               assets already use, not a second one:
 *                 ERC-20  eip155:1/erc20:<lowercase 0x contract>
 *                 SPL     solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/token:<mint>
 *               (native-asset.ts' header anticipated exactly these two forms.)
 *   display   = symbol / name, sanitised, stored as alias METADATA only. Never
 *               looked up by, never a price key, never the Instrument ticker
 *               (see token-instrument.ts `resolveTokenInstrumentId`: a token
 *               Instrument carries tickerSymbol NULL so no ticker-routed price
 *               path can ever price an "ETH"-tickered token as Ether).
 *
 * Token-2022 mints use the same `token:` namespace as classic SPL mints: a mint
 * address is unique across both programs, and CAIP-19 does not distinguish the
 * program. The program is recorded as evidence, not identity.
 *
 * ── INTEGERS UNTIL THE CANONICAL BOUNDARY ───────────────────────────────────
 * Raw amounts are base-unit integers: SPL's jsonParsed `tokenAmount.amount` is a
 * decimal STRING, Alchemy's `tokenBalance` a 0x hex string. Both are parsed to
 * BigInt and summed as BigInt; the single conversion to a whole-unit float is at
 * `PositionObservation.quantity`, which requires one — the same boundary
 * `lamportsToSol` / `weiToEth` hold for native assets. `uiAmount` (a float the
 * RPC pre-computes) is never read.
 *
 * ── ZERO IS NOT A POSITION ──────────────────────────────────────────────────
 * Solana keeps empty token accounts alive until closed and Alchemy lists every
 * contract an address ever touched. A zero balance is excluded from holdings;
 * a token that WAS held and is now zero is closed by the capture layer with an
 * explicit `quantity: 0` row (the wallet closure doctrine), and only when the
 * enumeration that omitted it was complete.
 */

import { NATIVE_ASSETS } from "./native-asset";

/** The InstrumentAlias namespace for crypto identity — MUST equal crypto-instrument's CRYPTO_PROVIDER (pinned by test). */
export const TOKEN_ALIAS_PROVIDER = "crypto";

/** PositionObservation.source for token observations — distinct from the native "wallet". */
export const WALLET_TOKEN_POSITION_SOURCE = "wallet-token";

/** Classic SPL Token program. */
export const SPL_TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
/** Token-2022 (Token Extensions) program. */
export const TOKEN_2022_PROGRAM_ID = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PQAmSoW8tdkqe6u";
/** Both token programs a Solana owner's balances can live under, in query order. */
export const SOLANA_TOKEN_PROGRAMS: readonly string[] = [SPL_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID];

const SOLANA_MAINNET   = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const ETHEREUM_MAINNET = "eip155:1";

/** assetKey prefixes. A native key contains `/slip44:` and can never match these. */
export const SPL_TOKEN_KEY_PREFIX = `${SOLANA_MAINNET}/token:`;
export const ERC20_KEY_PREFIX     = `${ETHEREUM_MAINNET}/erc20:`;

export type TokenStandard = "SPL" | "ERC20";

/** Chains whose wallets carry token capture in this PR. A chain token, never a ticker. */
export const TOKEN_CAPTURE_CHAINS: readonly string[] = ["SOL", "ETH"];

export function tokenCaptureSupported(chain: string | null | undefined): boolean {
  return !!chain && TOKEN_CAPTURE_CHAINS.includes(chain.trim().toUpperCase());
}

/** The token standard a wallet chain's tokens use, or null. */
export function tokenStandardForChain(chain: string | null | undefined): TokenStandard | null {
  const k = chain?.trim().toUpperCase();
  return k === "SOL" ? "SPL" : k === "ETH" ? "ERC20" : null;
}

/** CoinGecko asset platform id for a token standard's chain (for contract-addressed prices). */
export function coinGeckoPlatformFor(standard: TokenStandard): "solana" | "ethereum" {
  return standard === "SPL" ? "solana" : "ethereum";
}

export function splTokenAssetKey(mint: string): string {
  return `${SPL_TOKEN_KEY_PREFIX}${mint.trim()}`;
}

/** EVM contract addresses are case-insensitive hex; the identity is the lowercase form. */
export function erc20AssetKey(contract: string): string {
  return `${ERC20_KEY_PREFIX}${contract.trim().toLowerCase()}`;
}

/** Parse a token assetKey back to its parts, or null when it is not a token key. */
export function parseTokenAssetKey(assetKey: string | null | undefined):
  { standard: TokenStandard; chain: "SOL" | "ETH"; contract: string } | null {
  if (!assetKey) return null;
  if (assetKey.startsWith(SPL_TOKEN_KEY_PREFIX)) {
    const contract = assetKey.slice(SPL_TOKEN_KEY_PREFIX.length);
    return contract ? { standard: "SPL", chain: "SOL", contract } : null;
  }
  if (assetKey.startsWith(ERC20_KEY_PREFIX)) {
    const contract = assetKey.slice(ERC20_KEY_PREFIX.length);
    return contract ? { standard: "ERC20", chain: "ETH", contract } : null;
  }
  return null;
}

export function isTokenAssetKey(assetKey: string | null | undefined): boolean {
  return parseTokenAssetKey(assetKey) !== null;
}

/** Every native assetKey — the complement a native-only reader keeps. */
export const NATIVE_ASSET_KEYS: readonly string[] = NATIVE_ASSETS.map((a) => a.assetKey);

/**
 * THE alias predicate that identifies a TOKEN instrument, as a Prisma
 * `InstrumentAliasWhereInput` literal (no client import — this module stays pure).
 *
 * Readers that were written for ONE native instrument per wallet account
 * (historical wealth composition, the native coverage licence, the history
 * planner's blocking price floor) exclude tokens with
 * `instrument: { NOT: { aliases: { some: TOKEN_ALIAS_WHERE } } }` — a NOT EXISTS,
 * so every non-token row, including an alias-less fixture instrument, is kept
 * byte-identically. Exclusion rather than a native allow-list on purpose.
 */
export const TOKEN_ALIAS_WHERE = {
  provider: TOKEN_ALIAS_PROVIDER,
  OR: [
    { externalId: { startsWith: SPL_TOKEN_KEY_PREFIX } },
    { externalId: { startsWith: ERC20_KEY_PREFIX } },
  ],
};

/** `instrument` relation filter: NOT a token instrument. */
export const NOT_TOKEN_INSTRUMENT = { NOT: { aliases: { some: TOKEN_ALIAS_WHERE } } };

/** `instrument` relation filter: IS a token instrument. */
export const IS_TOKEN_INSTRUMENT = { aliases: { some: TOKEN_ALIAS_WHERE } };

// ── Integers ─────────────────────────────────────────────────────────────────

/** Largest decimals accepted. ERC-20 allows uint8 (255); nothing real exceeds 36 and a larger value is refused, not rounded. */
export const MAX_TOKEN_DECIMALS = 36;

export function isValidDecimals(d: unknown): d is number {
  return typeof d === "number" && Number.isInteger(d) && d >= 0 && d <= MAX_TOKEN_DECIMALS;
}

/**
 * Base units → whole units, for the canonical quantity column. Integer and
 * fractional parts are split on the BigInt before conversion (the lamportsToSol
 * rule), so the whole part is exact far past float64's integer range.
 */
export function baseUnitsToWhole(raw: bigint, decimals: number): number {
  if (!isValidDecimals(decimals)) throw new Error(`invalid token decimals: ${String(decimals)}`);
  if (raw < BigInt(0)) throw new Error(`negative token amount: ${raw}`);
  const scale = BigInt(10) ** BigInt(decimals);
  const whole = raw / scale;
  const rem = raw % scale;
  return Number(whole) + (decimals === 0 ? 0 : Number(rem) / Number(scale));
}

/** A non-negative base-10 integer string → BigInt, or null. Never a float. */
export function parseDecimalAmount(s: unknown): bigint | null {
  if (typeof s !== "string" || !/^\d{1,80}$/.test(s)) return null;
  return BigInt(s);
}

/** A 0x hex quantity → BigInt, or null. Alchemy pads to 32 bytes. */
export function parseHexAmount(s: unknown): bigint | null {
  if (typeof s !== "string" || !/^0x[0-9a-fA-F]{1,64}$/.test(s)) return null;
  return BigInt(s);
}

// ── Display metadata (attacker-controlled; sanitised, bounded, never identity) ─

/** Strip control/bidi characters and bound the length. Null when nothing printable remains. */
export function sanitizeTokenText(s: unknown, max: number): string | null {
  if (typeof s !== "string") return null;
  const clean = s.replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, "").trim();
  if (!clean) return null;
  return clean.length > max ? clean.slice(0, max) : clean;
}

/** "EPjF…Dt1v" — enough to recognise a mint/contract without displaying all of it. */
export function shortenTokenAddress(contract: string): string {
  const c = contract.trim();
  return c.length <= 12 ? c : `${c.slice(0, 4)}…${c.slice(-4)}`;
}

/** What a surface shows for a token: its sanitised symbol, else the shortened mint/contract. */
export function tokenDisplayLabel(t: { symbol: string | null; contract: string }): string {
  return t.symbol ?? shortenTokenAddress(t.contract);
}

// ── One observed holding ─────────────────────────────────────────────────────

export interface TokenHolding {
  assetKey: string;
  standard: TokenStandard;
  /** Mint (SPL) or lowercase contract (ERC-20). */
  contract: string;
  /** Base units, decimal string — the lossless fact. */
  rawAmount: string;
  decimals: number;
  /** Whole units, converted ONCE (baseUnitsToWhole). */
  quantity: number;
  symbol: string | null;
  name: string | null;
  /** SPL only: the owning program (classic or Token-2022). */
  program?: string;
  /** SPL only: every token account summed into this holding (evidence). */
  tokenAccounts?: string[];
}

// ── Solana: getTokenAccountsByOwner (jsonParsed) ─────────────────────────────

/** One parsed SPL token account, before grouping. */
export interface SplTokenAccountEntry {
  tokenAccount: string;
  mint: string;
  program: string;
  amount: bigint;
  decimals: number;
}

/**
 * Parse one `getTokenAccountsByOwner` jsonParsed response (one program).
 * THROWS on an error member or a malformed envelope — an unreadable answer is
 * never an empty wallet. Individual malformed entries are refused into
 * `rejected` (counted, never guessed).
 */
export function parseSplTokenAccounts(body: unknown, programId: string): { entries: SplTokenAccountEntry[]; rejected: number; rejectedMints: string[] } {
  const env = body as { result?: { value?: unknown }; error?: { code?: number; message?: string } } | null;
  if (!env || typeof env !== "object") throw new Error("unparseable getTokenAccountsByOwner response");
  if (env.error) throw new Error(`provider error ${env.error.code ?? "?"}: ${env.error.message ?? "unknown"}`);
  const value = env.result?.value;
  if (!Array.isArray(value)) throw new Error("unexpected getTokenAccountsByOwner response shape (missing result.value)");
  const entries: SplTokenAccountEntry[] = [];
  const rejectedMints: string[] = [];
  let rejected = 0;
  for (const v of value as Array<Record<string, unknown>>) {
    const pubkey = typeof v?.pubkey === "string" ? v.pubkey : null;
    const info = (v?.account as { data?: { parsed?: { info?: Record<string, unknown> } } } | undefined)?.data?.parsed?.info;
    const mint = typeof info?.mint === "string" ? info.mint : null;
    const ta = info?.tokenAmount as { amount?: unknown; decimals?: unknown } | undefined;
    const amount = parseDecimalAmount(ta?.amount);
    if (!pubkey || !mint || amount === null || !isValidDecimals(ta?.decimals)) {
      rejected++;
      if (mint) rejectedMints.push(mint);
      continue;
    }
    entries.push({ tokenAccount: pubkey, mint, program: programId, amount, decimals: ta!.decimals as number });
  }
  return { entries, rejected, rejectedMints };
}

/**
 * Group token accounts by mint: an owner may hold several accounts for one mint
 * (an ATA plus auxiliaries). Amounts are summed as BigInt; every account is kept
 * as evidence. A mint whose accounts disagree about decimals is refused (a mint
 * has exactly one decimals value — disagreement means the data is wrong). Zero
 * sums are not positions and are dropped.
 */
export function groupSplHoldings(entries: readonly SplTokenAccountEntry[]): { holdings: TokenHolding[]; refusedMints: string[]; zeroMints: string[] } {
  const byMint = new Map<string, SplTokenAccountEntry[]>();
  for (const e of entries) (byMint.get(e.mint) ?? byMint.set(e.mint, []).get(e.mint)!).push(e);
  const holdings: TokenHolding[] = [];
  const refusedMints: string[] = [];
  /** Mints whose every token account read cleanly and summed to EXACTLY zero — an explicit provider zero. */
  const zeroMints: string[] = [];
  for (const [mint, list] of byMint) {
    const decimals = list[0].decimals;
    if (list.some((e) => e.decimals !== decimals) || new Set(list.map((e) => e.program)).size > 1) {
      refusedMints.push(mint);
      continue;
    }
    const raw = list.reduce((s, e) => s + e.amount, BigInt(0));
    if (raw === BigInt(0)) { zeroMints.push(mint); continue; }
    holdings.push({
      assetKey: splTokenAssetKey(mint), standard: "SPL", contract: mint,
      rawAmount: raw.toString(), decimals, quantity: baseUnitsToWhole(raw, decimals),
      symbol: null, name: null, program: list[0].program,
      tokenAccounts: list.map((e) => e.tokenAccount).sort(),
    });
  }
  holdings.sort((a, b) => a.contract.localeCompare(b.contract));
  return { holdings, refusedMints, zeroMints: zeroMints.sort() };
}

// ── Ethereum: alchemy_getTokenBalances / alchemy_getTokenMetadata ────────────

export interface Erc20BalanceEntry { contract: string; amount: bigint }

/**
 * Parse one `alchemy_getTokenBalances` page. THROWS on an error member or a
 * malformed envelope. Entries carrying a per-token `error` (or an unparseable
 * balance) are UNREADABLE — counted, never read as zero, and they make the
 * enumeration incomplete for closure purposes.
 */
export function parseAlchemyTokenBalances(body: unknown): {
  entries: Erc20BalanceEntry[]; unreadable: string[]; pageKey: string | null;
} {
  const env = body as { result?: { tokenBalances?: unknown; pageKey?: unknown }; error?: { code?: number; message?: string } } | null;
  if (!env || typeof env !== "object") throw new Error("unparseable alchemy_getTokenBalances response");
  if (env.error) throw new Error(`provider error ${env.error.code ?? "?"}: ${env.error.message ?? "unknown"}`);
  const list = env.result?.tokenBalances;
  if (!Array.isArray(list)) throw new Error("unexpected alchemy_getTokenBalances response shape (missing tokenBalances)");
  const entries: Erc20BalanceEntry[] = [];
  const unreadable: string[] = [];
  for (const t of list as Array<Record<string, unknown>>) {
    const contract = typeof t?.contractAddress === "string" && /^0x[0-9a-fA-F]{40}$/.test(t.contractAddress)
      ? t.contractAddress.toLowerCase() : null;
    if (!contract) continue; // not an address — nothing to identify, nothing to close
    const amount = t.error ? null : parseHexAmount(t.tokenBalance);
    if (amount === null) { unreadable.push(contract); continue; }
    entries.push({ contract, amount });
  }
  const pk = env.result?.pageKey;
  return { entries, unreadable, pageKey: typeof pk === "string" && pk ? pk : null };
}

export interface TokenMetadata { decimals: number | null; symbol: string | null; name: string | null }

/** Parse `alchemy_getTokenMetadata`. Decimals null ⇒ the quantity cannot be stated. */
export function parseAlchemyTokenMetadata(body: unknown): TokenMetadata {
  const env = body as { result?: Record<string, unknown>; error?: { code?: number; message?: string } } | null;
  if (!env || typeof env !== "object") throw new Error("unparseable alchemy_getTokenMetadata response");
  if (env.error) throw new Error(`provider error ${env.error.code ?? "?"}: ${env.error.message ?? "unknown"}`);
  const r = env.result ?? {};
  return {
    decimals: isValidDecimals(r.decimals) ? (r.decimals as number) : null,
    symbol:   sanitizeTokenText(r.symbol, 24),
    name:     sanitizeTokenText(r.name, 64),
  };
}

/** One ERC-20 balance + its metadata → a holding, or null (zero / undecidable decimals). */
export function erc20Holding(entry: Erc20BalanceEntry, meta: TokenMetadata): TokenHolding | null {
  if (entry.amount === BigInt(0) || meta.decimals === null) return null;
  return {
    assetKey: erc20AssetKey(entry.contract), standard: "ERC20", contract: entry.contract,
    rawAmount: entry.amount.toString(), decimals: meta.decimals,
    quantity: baseUnitsToWhole(entry.amount, meta.decimals),
    symbol: meta.symbol, name: meta.name,
  };
}
