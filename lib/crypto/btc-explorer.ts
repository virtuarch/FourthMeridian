/**
 * lib/crypto/btc-explorer.ts
 *
 * BTC wallet balance sync v1 — pure provider layer.
 *
 * Fetches a public BTC address's CONFIRMED balance and a BTC→USD spot price
 * from a keyless block explorer (mempool.space by default). Deliberately has
 * NO dependency on @/lib/db or next/* so it imports cleanly under the bare-tsx
 * unit runner (scripts/run-tests.ts) and can be exercised offline with an
 * injected `fetch`.
 *
 * Scope guard (see the wallet-sync investigation, 2026-07-09): BTC public
 * address balance only. No xpub, no transaction history, no other chains, no
 * schema changes. The orchestration + persistence live in ./btc-sync.ts.
 *
 * Confirmed-only: balance = chain_stats.funded_txo_sum - chain_stats.spent_txo_sum
 * (mempool_stats — unconfirmed — is intentionally ignored).
 */

/** 1 BTC = 100,000,000 satoshis. */
export const SATS_PER_BTC = 100_000_000;

const DEFAULT_EXPLORER_BASE = "https://mempool.space";
const DEFAULT_PRICE_URL = "https://mempool.space/api/v1/prices";
const DEFAULT_TIMEOUT_MS = 10_000;

/** Which external call failed — carried on the error and into any SyncIssue. */
export type BtcSyncStage = "balance" | "price";

/** Typed failure so callers can record an honest, staged sync issue. */
export class BtcSyncError extends Error {
  constructor(public readonly stage: BtcSyncStage, message: string) {
    super(message);
    this.name = "BtcSyncError";
  }
}

/** Explorer base URL (trailing slashes trimmed). Overridable, keyless default. */
export function btcExplorerBaseUrl(): string {
  const base = process.env.BTC_EXPLORER_BASE_URL?.trim() || DEFAULT_EXPLORER_BASE;
  return base.replace(/\/+$/, "");
}

/** BTC→USD price endpoint. Overridable, keyless default. */
export function btcPriceUrl(): string {
  return process.env.BTC_PRICE_URL?.trim() || DEFAULT_PRICE_URL;
}

function timeoutMs(): number {
  const n = Number(process.env.BTC_SYNC_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TIMEOUT_MS;
}

// ── Pure parsers (unit-tested directly) ──────────────────────────────────────

/**
 * Confirmed balance in satoshis from a mempool.space `/api/address/{addr}`
 * response. Throws BtcSyncError("balance") on an unexpected shape or an
 * impossible (negative / non-finite) result — we never write a bad balance.
 */
export function parseConfirmedSats(json: unknown): number {
  const cs = (json as { chain_stats?: { funded_txo_sum?: unknown; spent_txo_sum?: unknown } } | null)
    ?.chain_stats;
  if (
    !cs ||
    typeof cs.funded_txo_sum !== "number" ||
    typeof cs.spent_txo_sum !== "number"
  ) {
    throw new BtcSyncError("balance", "unexpected address response shape (missing chain_stats)");
  }
  const sats = cs.funded_txo_sum - cs.spent_txo_sum;
  if (!Number.isFinite(sats) || sats < 0) {
    throw new BtcSyncError("balance", `invalid confirmed balance: ${sats}`);
  }
  return sats;
}

/**
 * BTC→USD price from a mempool.space `/api/v1/prices` response (`{ USD: n }`).
 * Throws BtcSyncError("price") when USD is missing or non-positive — we never
 * value a wallet at a bogus price.
 */
export function parseUsdPrice(json: unknown): number {
  const usd = (json as { USD?: unknown } | null)?.USD;
  if (typeof usd !== "number" || !Number.isFinite(usd) || usd <= 0) {
    throw new BtcSyncError("price", "unexpected/invalid price response (missing USD)");
  }
  return usd;
}

/** Satoshis → BTC (native units stored on FinancialAccount.nativeBalance). */
export function satsToBtc(sats: number): number {
  return sats / SATS_PER_BTC;
}

/** USD value of a BTC amount at a spot price, rounded to cents. */
export function computeUsdBalance(btc: number, priceUsd: number): number {
  return Math.round(btc * priceUsd * 100) / 100;
}

// ── Fetchers (injectable `fetch` for offline tests) ──────────────────────────

export type FetchFn = typeof fetch;

async function getJson(url: string, stage: BtcSyncStage, fetchImpl: FetchFn): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs());
  try {
    const res = await fetchImpl(url, {
      signal: controller.signal,
      headers: { accept: "application/json" },
    });
    if (!res.ok) {
      throw new BtcSyncError(stage, `HTTP ${res.status} from ${url}`);
    }
    return await res.json();
  } catch (err) {
    if (err instanceof BtcSyncError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new BtcSyncError(stage, message);
  } finally {
    clearTimeout(timer);
  }
}

/** Confirmed balance (satoshis) for a public BTC address. */
export async function fetchConfirmedSats(address: string, fetchImpl: FetchFn = fetch): Promise<number> {
  const url = `${btcExplorerBaseUrl()}/api/address/${encodeURIComponent(address)}`;
  return parseConfirmedSats(await getJson(url, "balance", fetchImpl));
}

/** Current BTC→USD spot price. */
export async function fetchBtcUsdPrice(fetchImpl: FetchFn = fetch): Promise<number> {
  return parseUsdPrice(await getJson(btcPriceUrl(), "price", fetchImpl));
}
