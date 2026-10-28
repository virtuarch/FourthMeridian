/**
 * lib/crypto/wallet-token-capture.ts
 *
 * TOKEN HOLDINGS FOUNDATION (PR-A) — current SPL / ERC-20 holdings, captured on
 * each wallet sync, ISOLATED from the native sync it rides on.
 *
 *   1. budget     the SHARED daily Alchemy budget (ApiUsageCounter, provider
 *                 ALCHEMY — lib/usage/provider-budget) is read first; with no
 *                 room, or no readable ledger, capture is SKIPPED this run —
 *                 honestly, as "token facet not captured", never as "no tokens".
 *   2. enumerate  lib/crypto/token-rpc.ts — every request metered, hard-capped.
 *   3. identity   one canonical Instrument per token across all customers
 *                 (token-instrument.ts `resolveTokenInstrumentId`, CAIP-19
 *                 alias, tickerSymbol NULL).
 *   4. positions  one OBSERVED PositionObservation per (account, token, day),
 *                 source "wallet-token", quantity only — the same quantity-only
 *                 facts the native writer stamps (`buildWalletObservedFacts`).
 *                 A token that was held and is no longer listed gets an explicit
 *                 `quantity: 0` closure row — ONLY after a COMPLETE enumeration.
 *   5. quotes     contract-addressed CoinGecko current quotes (INTRADAY), bounded.
 *                 An unlisted token stays UNPRICED: excluded from totals, never 0.
 *
 * ── WHAT THIS NEVER DOES ────────────────────────────────────────────────────
 *   · Never throws. Every failure is an outcome; the caller attaches it to the
 *     native result and NOTHING about the native sync — ok, syncStatus, the
 *     SyncIssue ledger, Connection.errorCode, lastUpdated — reads it.
 *   · Never writes PositionCoverage. Token history is not reconstructed in this
 *     PR, so no interval is licensed: the per-(account, instrument) coverage row
 *     is ABSENT, which every licence reader treats as "nothing licensed"
 *     (position-coverage.ts NO_COVERAGE_RECORD). The ERC-20 / SPL history PRs
 *     write it through `persistPositionCoverage(tx, accountId, tokenInstrumentId, …)`.
 *   · Never writes a balance column, a SyncIssue, or a native row.
 *
 * Takes `client` explicitly (no defaulted authority — scripts/audit-db-authority).
 */

import { PositionOrigin, type Prisma, type PrismaClient } from "@prisma/client";
import { buildWalletObservedFacts, normalizeObservationDate } from "./wallet-position-capture";
import { investmentObservationsEnabled } from "@/lib/investments/position-capture";
import { resolveTokenInstrumentId, loadTokenAliasMetadata } from "@/lib/crypto/token-instrument";
import {
  tokenStandardForChain, coinGeckoPlatformFor, erc20AssetKey, WALLET_TOKEN_POSITION_SOURCE,
  type TokenHolding, type TokenMetadata, type TokenStandard,
} from "./token-asset";
import { fetchSolTokenHoldings, fetchErc20TokenHoldings, type FetchFn, type TokenEnumeration } from "./token-rpc";
import { solRpcUrl } from "./sol-rpc";
import { alchemyRpcUrl, ALCHEMY_NETWORKS, redactProviderSecrets } from "./alchemy";
import { workerConfig } from "./sol-backfill-worker.core";
import {
  ALCHEMY_USAGE_NETWORK, ALCHEMY_USAGE_PROVIDER, providerCallsOn, recordProviderMeter,
  type LedgerCalls, type ProviderUsageClient,
} from "@/lib/usage/provider-budget";
import { refreshCurrentTokenQuotes, type TokenQuoteTarget } from "@/lib/prices/current-quotes";
import type { fetchCoinGeckoTokenQuotes } from "@/lib/prices/providers/coingecko";
import type { CoinGeckoBudget } from "@/lib/prices/coingecko-budget";

type Client = PrismaClient | Prisma.TransactionClient;

export { WALLET_TOKEN_POSITION_SOURCE };

export { COINGECKO_USAGE_PROVIDER } from "@/lib/prices/coingecko-budget";

const num = (v: string | undefined, d: number, min: number, max: number) => {
  const n = Number(v);
  return Number.isInteger(n) && n >= min && n <= max ? n : d;
};

/** Env-configured, clamped bounds. A bad value falls back to the default, never to "unlimited". */
export function tokenCaptureConfig(env: Record<string, string | undefined> = process.env) {
  return {
    /** Kill switch. ON unless explicitly "false". */
    enabled:         env.WALLET_TOKEN_CAPTURE_ENABLED !== "false",
    /** alchemy_getTokenBalances pages (100 contracts each) per ETH sync. */
    erc20MaxPages:   num(env.WALLET_TOKEN_ERC20_MAX_PAGES, 3, 1, 20),
    /** alchemy_getTokenMetadata calls per ETH sync (only for contracts not already known). */
    erc20MaxMetadata: num(env.WALLET_TOKEN_ERC20_MAX_METADATA, 50, 0, 500),
    /** Token instruments quoted per sync (CoinGecko). */
    maxQuotedTokens: num(env.WALLET_TOKEN_QUOTE_MAX, 10, 0, 200),
    timeoutMs:       num(env.WALLET_TOKEN_TIMEOUT_MS, 10_000, 1_000, 60_000),
    /** Token positions written per wallet per sync (bounds DB work for airdrop-flooded wallets). */
    maxTokensPerWallet: num(env.WALLET_TOKEN_MAX_PER_WALLET, 200, 1, 2_000),
  };
}

/** The most Alchemy requests one capture may send for this standard — the budget reservation. */
export function plannedTokenCalls(standard: TokenStandard, cfg = tokenCaptureConfig()): number {
  return standard === "SPL" ? 2 : cfg.erc20MaxPages + cfg.erc20MaxMetadata;
}

export type TokenCaptureSkip =
  | "NOT_SUPPORTED" | "DISABLED" | "GATE_OFF" | "NOT_CONFIGURED" | "BUDGET_EXHAUSTED" | "BUDGET_UNKNOWN";

export interface CapturedToken {
  instrumentId: string;
  assetKey:     string;
  contract:     string;
  symbol:       string | null;
  rawAmount:    string;
  decimals:     number;
  quantity:     number;
}

export interface WalletTokenSyncOutcome {
  status: "CAPTURED" | "SKIPPED" | "FAILED";
  skipReason?: TokenCaptureSkip;
  reason?: string;
  tokens: CapturedToken[];
  /** Instruments closed to quantity 0 this run (complete enumerations only). */
  closedInstrumentIds: string[];
  complete: boolean;
  unstated: Array<{ contract: string; reason: string }>;
  /** Alchemy requests this run sent (all metered into the shared budget). */
  providerCalls: number;
  /** CoinGecko token quotes this run (calls metered into the shared COINGECKO budget). */
  quote?: { status: string; pricedInstrumentIds: string[]; unpricedAssetKeys: string[]; thinAssetKeys: string[]; calls: number; reason?: string };
}

export interface WalletTokenSyncDeps {
  fetchImpl?: FetchFn;
  /** Endpoint override; `null` forces NOT_CONFIGURED. */
  rpcUrl?: string | null;
  /** Today's shared Alchemy ledger. Default: providerCallsOn(client). Null ⇒ unreadable. */
  usageToday?: () => Promise<LedgerCalls | null>;
  /** Shared daily cap. Default: the SOL worker's SOL_BACKFILL_DAILY_REQUEST_CAP (the Alchemy budget). */
  dailyCap?: number;
  /** Flush the Alchemy meter. Default: recordProviderMeter(ALCHEMY, network, meter). */
  recordUsage?: (network: string, meter: Record<string, number>) => Promise<void>;
  /** The shared CoinGecko budget (read-before-spend, meter, pace). Default: defaultCoinGeckoBudget(client). */
  quoteBudget?: CoinGeckoBudget;
  fetchTokenQuotes?: typeof fetchCoinGeckoTokenQuotes;
  observationsEnabled?: boolean;
  config?: ReturnType<typeof tokenCaptureConfig>;
  now?: Date;
}

const empty = (o: Partial<WalletTokenSyncOutcome> & Pick<WalletTokenSyncOutcome, "status">): WalletTokenSyncOutcome =>
  ({ tokens: [], closedInstrumentIds: [], complete: false, unstated: [], providerCalls: 0, ...o });

/**
 * Capture one wallet's current token holdings. Never throws.
 *
 * Call ONLY after the native sync succeeded (the caller's contract): a wallet
 * whose native balance could not be read has no fresh evidence of anything.
 */
export async function syncWalletTokens(args: {
  client: Client;
  accountId: string;
  chain: string;
  address: string;
  deps?: WalletTokenSyncDeps;
}): Promise<WalletTokenSyncOutcome> {
  const { client, accountId, address } = args;
  const deps = args.deps ?? {};
  const cfg = deps.config ?? tokenCaptureConfig();
  const standard = tokenStandardForChain(args.chain);
  if (!standard) return empty({ status: "SKIPPED", skipReason: "NOT_SUPPORTED" });
  if (!cfg.enabled) return empty({ status: "SKIPPED", skipReason: "DISABLED" });
  // Same gate as the native writer: no spine, nowhere to record a token either.
  if (!(deps.observationsEnabled ?? investmentObservationsEnabled())) return empty({ status: "SKIPPED", skipReason: "GATE_OFF" });

  const rpcUrl = deps.rpcUrl !== undefined ? deps.rpcUrl
    : standard === "SPL" ? solRpcUrl() : alchemyRpcUrl(ALCHEMY_NETWORKS.ETHEREUM);
  if (!rpcUrl) return empty({ status: "SKIPPED", skipReason: "NOT_CONFIGURED" });

  const network = standard === "SPL" ? ALCHEMY_USAGE_NETWORK.SOLANA : ALCHEMY_USAGE_NETWORK.ETHEREUM;
  const now = deps.now ?? new Date();

  // 1. THE SHARED BUDGET. Unreadable is not "plenty": skip rather than spend blind.
  //    ETH token calls count against the SAME daily cap as the Solana history
  //    worker — intended: one Alchemy key, one bill (see token-rpc.ts on calls vs CU).
  let ledger: LedgerCalls | null = null;
  try {
    ledger = deps.usageToday
      ? await deps.usageToday()
      : await providerCallsOn(client as unknown as ProviderUsageClient, ALCHEMY_USAGE_PROVIDER, now.toISOString().slice(0, 10));
  } catch { ledger = null; }
  if (!ledger) return empty({ status: "SKIPPED", skipReason: "BUDGET_UNKNOWN", reason: "the shared provider budget could not be read" });
  const cap = deps.dailyCap ?? workerConfig().dailyRequestCap;
  const remaining = cap - (ledger.solana + ledger.other);
  const planned = plannedTokenCalls(standard, cfg);
  // SPL needs both program reads to say anything; ERC-20 needs at least a page.
  const minimum = standard === "SPL" ? 2 : 1;
  if (remaining < minimum) {
    return empty({ status: "SKIPPED", skipReason: "BUDGET_EXHAUSTED", reason: `shared daily provider budget reached (${cap} calls)` });
  }
  const callBudget = Math.min(planned, remaining);

  // 2. ENUMERATE — metered; the meter is flushed whatever happens.
  const meter: Record<string, number> = {};
  let enumeration: TokenEnumeration;
  try {
    enumeration = standard === "SPL"
      ? await fetchSolTokenHoldings(address, { rpcUrl, fetchImpl: deps.fetchImpl, meter, callBudget, timeoutMs: cfg.timeoutMs })
      : await fetchErc20TokenHoldings(address,
          { rpcUrl, fetchImpl: deps.fetchImpl, meter, callBudget: Math.min(callBudget, cfg.erc20MaxPages + cfg.erc20MaxMetadata), timeoutMs: cfg.timeoutMs },
          { maxPages: cfg.erc20MaxPages, knownMetadata: (contracts) => knownErc20Metadata(client, contracts),
            recheckRemaining: async () => {
              const l = deps.usageToday ? await deps.usageToday()
                : await providerCallsOn(client as unknown as ProviderUsageClient, ALCHEMY_USAGE_PROVIDER, now.toISOString().slice(0, 10));
              return l ? cap - (l.solana + l.other) : null; // this run is not flushed yet, so the ledger excludes it
            } });
  } catch (e) {
    await flush(deps, network, meter);
    return empty({ status: "FAILED", reason: redactProviderSecrets(e instanceof Error ? e.message : String(e)), providerCalls: total(meter) });
  }
  await flush(deps, network, meter);

  // Bounded DB work: an airdrop-flooded wallet is cut at the cap, and the cut
  // makes the enumeration INCOMPLETE — nothing beyond it may be closed.
  if (enumeration.holdings.length > cfg.maxTokensPerWallet) {
    const over = enumeration.holdings.length - cfg.maxTokensPerWallet;
    enumeration = {
      ...enumeration,
      holdings: enumeration.holdings.slice(0, cfg.maxTokensPerWallet),
      complete: false,
      unstated: [...enumeration.unstated, { contract: "*", reason: `${over} more token(s) beyond the per-wallet cap of ${cfg.maxTokensPerWallet}` }],
    };
  }

  // 3 + 4. IDENTITY AND POSITIONS. A DB failure here is still only a token outcome.
  const date = normalizeObservationDate(now);
  const tokens: CapturedToken[] = [];
  const closedInstrumentIds: string[] = [];
  try {
    for (const h of enumeration.holdings) {
      const instrumentId = await resolveTokenInstrumentId(specOf(h), { client });
      await writeTokenObservation(client, accountId, instrumentId, date, h.quantity);
      tokens.push({ instrumentId, assetKey: h.assetKey, contract: h.contract, symbol: h.symbol, rawAmount: h.rawAmount, decimals: h.decimals, quantity: h.quantity });
    }
    // CLOSURE. Two independent licences to write an explicit 0 for a token that
    // was held: (a) a COMPLETE enumeration that no longer lists it, or (b) the
    // provider reporting EXPLICITLY zero for it — evidence even when other
    // pages were unreadable (review fix 4).
    const held = new Set(tokens.map((t) => t.instrumentId));
    const previously = await previouslyHeldTokenInstruments(client, accountId, date);
    const explicitZeroIds = new Set(enumeration.explicitZero.length === 0 ? []
      : [...(await loadTokenAliasMetadata(client, enumeration.explicitZero)).values()].map((m) => m.instrumentId));
    for (const instrumentId of previously) {
      if (held.has(instrumentId)) continue;
      if (!enumeration.complete && !explicitZeroIds.has(instrumentId)) continue;
      await writeTokenObservation(client, accountId, instrumentId, date, 0);
      closedInstrumentIds.push(instrumentId);
    }
  } catch (e) {
    return empty({
      status: "FAILED", reason: `token position capture failed: ${e instanceof Error ? e.message : String(e)}`,
      tokens, closedInstrumentIds, unstated: enumeration.unstated, providerCalls: total(meter),
    });
  }

  // 5. QUOTES — contract-addressed; bounded; an unlisted token stays unpriced.
  let quote: WalletTokenSyncOutcome["quote"];
  if (tokens.length > 0 && cfg.maxQuotedTokens > 0) {
    const platform = coinGeckoPlatformFor(standard);
    const targets: TokenQuoteTarget[] = tokens.map((t) => ({ instrumentId: t.instrumentId, assetKey: t.assetKey, platform, contract: t.contract }));
    const q = await refreshCurrentTokenQuotes(targets, {
      client, fetchTokenQuotes: deps.fetchTokenQuotes, now, maxTokens: cfg.maxQuotedTokens, budget: deps.quoteBudget,
    });
    quote = {
      status: q.status,
      pricedInstrumentIds: q.status === "REFRESHED" ? q.instrumentIds : [],
      unpricedAssetKeys: q.unpricedAssetKeys ?? [],
      thinAssetKeys: q.thinAssetKeys ?? [],
      calls: q.calls ?? 0,
      ...(q.status === "UNAVAILABLE" ? { reason: q.reason } : {}),
    };
  }

  return {
    status: "CAPTURED", tokens, closedInstrumentIds,
    complete: enumeration.complete, unstated: enumeration.unstated,
    providerCalls: total(meter), ...(quote ? { quote } : {}),
  };
}

const total = (m: Record<string, number>) => Object.values(m).reduce((s, n) => s + n, 0);

async function flush(deps: WalletTokenSyncDeps, network: string, meter: Record<string, number>): Promise<void> {
  try {
    if (deps.recordUsage) await deps.recordUsage(network, meter);
    else await recordProviderMeter(ALCHEMY_USAGE_PROVIDER, network, meter);
  } catch { /* metering never fails a sync */ }
}

function specOf(h: TokenHolding) {
  return { assetKey: h.assetKey, standard: h.standard, contract: h.contract, decimals: h.decimals, symbol: h.symbol, name: h.name, program: h.program };
}

async function knownErc20Metadata(client: Client, contracts: readonly string[]): Promise<Map<string, TokenMetadata>> {
  const byKey = await loadTokenAliasMetadata(client, contracts.map(erc20AssetKey));
  const out = new Map<string, TokenMetadata>();
  for (const m of byKey.values()) out.set(m.contract, { decimals: m.decimals, symbol: m.symbol, name: m.name });
  return out;
}

/** Upsert today's OBSERVED token row — idempotent on the composite unique, prior days untouched. */
async function writeTokenObservation(client: Client, financialAccountId: string, instrumentId: string, date: Date, quantity: number): Promise<void> {
  const facts = buildWalletObservedFacts(quantity, "USD");
  await client.positionObservation.upsert({
    where: {
      financialAccountId_instrumentId_date_origin_source: {
        financialAccountId, instrumentId, date, origin: PositionOrigin.OBSERVED, source: WALLET_TOKEN_POSITION_SOURCE,
      },
    },
    create: { financialAccountId, instrumentId, date, origin: PositionOrigin.OBSERVED, source: WALLET_TOKEN_POSITION_SOURCE, ...facts },
    update: facts,
  });
}

/** Token instruments whose LATEST token observation on this account (on or before `date`) is non-zero. */
async function previouslyHeldTokenInstruments(client: Client, financialAccountId: string, date: Date): Promise<string[]> {
  const latest = await client.positionObservation.groupBy({
    by: ["instrumentId"],
    where: { financialAccountId, source: WALLET_TOKEN_POSITION_SOURCE, origin: PositionOrigin.OBSERVED, supersededById: null, deletedAt: null, date: { lte: date } },
    _max: { date: true },
  });
  const pairs = latest.filter((g) => g._max.date != null).map((g) => ({ instrumentId: g.instrumentId, date: g._max.date! }));
  if (pairs.length === 0) return [];
  const rows = await client.positionObservation.findMany({
    where: { financialAccountId, source: WALLET_TOKEN_POSITION_SOURCE, origin: PositionOrigin.OBSERVED, supersededById: null, deletedAt: null, OR: pairs },
    select: { instrumentId: true, quantity: true },
  });
  return [...new Set(rows.filter((r) => r.quantity > 0).map((r) => r.instrumentId))].sort();
}
