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
export type BtcSyncStage = "balance" | "price" | "transactions" | "discovery";

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

/**
 * Total transaction count for an address (confirmed + mempool) — the "is this
 * address used?" signal for xpub gap-limit discovery.
 */
export function parseTxCount(json: unknown): number {
  const j = json as { chain_stats?: { tx_count?: unknown }; mempool_stats?: { tx_count?: unknown } } | null;
  const c = typeof j?.chain_stats?.tx_count === "number" ? (j!.chain_stats!.tx_count as number) : 0;
  const m = typeof j?.mempool_stats?.tx_count === "number" ? (j!.mempool_stats!.tx_count as number) : 0;
  return c + m;
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

/** Number of retries on HTTP 429/503 before giving up (env, default 4). */
function rateLimitRetries(): number {
  const n = Number(process.env.BTC_RATE_LIMIT_RETRIES);
  return Number.isFinite(n) && n >= 0 ? n : 4;
}
/** Base backoff between rate-limited retries, doubled each attempt (env, default 500ms). */
function rateLimitBackoffMs(): number {
  const n = Number(process.env.BTC_RATE_LIMIT_BACKOFF_MS);
  return Number.isFinite(n) && n > 0 ? n : 500;
}
const MAX_BACKOFF_MS = 8000;

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Rate-limit-safe JSON GET. On HTTP 429/503 it backs off (exponential, honoring
 * a `Retry-After` header) and retries up to `rateLimitRetries()`; if still
 * limited it throws a BtcSyncError whose message contains "rate limited" so
 * callers can surface a useful state instead of a generic failure. Each attempt
 * uses its own timeout/abort.
 */
async function getJson(url: string, stage: BtcSyncStage, fetchImpl: FetchFn): Promise<unknown> {
  const maxRetries = rateLimitRetries();

  for (let attempt = 0; ; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs());
    let retryAfterMs: number | undefined;
    try {
      const res = await fetchImpl(url, {
        signal: controller.signal,
        headers: { accept: "application/json" },
      });
      if (res.status === 429 || res.status === 503) {
        const ra = Number(res.headers?.get?.("retry-after"));
        if (Number.isFinite(ra) && ra > 0) retryAfterMs = ra * 1000;
        // fall through to backoff/retry below (after finally clears the timer)
      } else if (!res.ok) {
        throw new BtcSyncError(stage, `HTTP ${res.status} from ${url}`);
      } else {
        return await res.json();
      }
    } catch (err) {
      if (err instanceof BtcSyncError) throw err;
      throw new BtcSyncError(stage, err instanceof Error ? err.message : String(err));
    } finally {
      clearTimeout(timer);
    }

    // Reached only when the response was 429/503.
    if (attempt >= maxRetries) {
      throw new BtcSyncError(stage, `rate limited by explorer (HTTP 429/503) after ${attempt + 1} attempts`);
    }
    const delay = Math.min(retryAfterMs ?? rateLimitBackoffMs() * 2 ** attempt, MAX_BACKOFF_MS);
    await sleep(delay);
  }
}

/** Confirmed balance (satoshis) for a public BTC address. */
export async function fetchConfirmedSats(address: string, fetchImpl: FetchFn = fetch): Promise<number> {
  const url = `${btcExplorerBaseUrl()}/api/address/${encodeURIComponent(address)}`;
  return parseConfirmedSats(await getJson(url, "balance", fetchImpl));
}

/** Summed confirmed balance (satoshis) across many addresses (xpub aggregate). */
export async function fetchConfirmedSatsForAddresses(addresses: string[], fetchImpl: FetchFn = fetch): Promise<number> {
  let total = 0;
  for (const a of addresses) total += await fetchConfirmedSats(a, fetchImpl);
  return total;
}

/** Total tx count (confirmed + mempool) for an address — xpub usage/gap check. */
export async function fetchAddressTxCount(address: string, fetchImpl: FetchFn = fetch): Promise<number> {
  const url = `${btcExplorerBaseUrl()}/api/address/${encodeURIComponent(address)}`;
  return parseTxCount(await getJson(url, "balance", fetchImpl));
}

// ── Batch address stats (xpub discovery provider) ────────────────────────────
//
// mempool.space/Esplora has NO batch or xpub endpoint, so probing derived
// addresses one-by-one is the fragility behind the 429/timeout onboarding
// failures. For xpub discovery we derive locally and look up MANY addresses in a
// single request via a multiaddr-style provider (blockchain.info by default,
// keyless), which returns per-address n_tx AND final_balance at once. This is
// the swappable "batch provider" seam; single-address wallets keep using the
// per-address mempool path above.

/** Per-address usage + confirmed balance from a batch lookup. */
export interface AddrStat { txCount: number; sats: number }

/** Base URL of the multiaddr-style batch provider (env-overridable, keyless default). */
function batchApiUrl(): string {
  return process.env.BTC_BATCH_API_URL?.trim() || "https://blockchain.info";
}

/** Max addresses per multiaddr request (provider limit ~50). */
export const BATCH_CHUNK = 50;

/**
 * Parse a blockchain.info `/multiaddr` response into per-address stats for
 * EXACTLY the requested addresses. Addresses the provider omits (no activity)
 * default to zero, so the result always has an entry per requested address.
 */
export function parseMultiaddrStats(json: unknown, requested: string[]): Map<string, AddrStat> {
  const out = new Map<string, AddrStat>();
  for (const a of requested) out.set(a, { txCount: 0, sats: 0 });
  const arr = (json as { addresses?: unknown } | null)?.addresses;
  if (Array.isArray(arr)) {
    for (const e of arr) {
      const addr = (e as { address?: unknown }).address;
      const nTx  = (e as { n_tx?: unknown }).n_tx;
      const bal  = (e as { final_balance?: unknown }).final_balance;
      if (typeof addr === "string" && out.has(addr)) {
        out.set(addr, {
          txCount: typeof nTx === "number" ? nTx : 0,
          sats:    typeof bal === "number" ? bal : 0,
        });
      }
    }
  }
  return out;
}

/**
 * Batch usage+balance for a set of addresses in ONE request per BATCH_CHUNK
 * (with 429 backoff from getJson). The single-request-per-chunk shape is what
 * makes xpub discovery robust vs. one-request-per-address tarpitting.
 */
export async function fetchAddressStatsBatch(addresses: string[], fetchImpl: FetchFn = fetch): Promise<Map<string, AddrStat>> {
  const result = new Map<string, AddrStat>();
  for (let i = 0; i < addresses.length; i += BATCH_CHUNK) {
    const chunk = addresses.slice(i, i + BATCH_CHUNK);
    if (chunk.length === 0) continue;
    const active = encodeURIComponent(chunk.join("|"));
    const url = `${batchApiUrl()}/multiaddr?active=${active}&n=0`;
    const stats = parseMultiaddrStats(await getJson(url, "discovery", fetchImpl), chunk);
    for (const [k, v] of stats) result.set(k, v);
  }
  return result;
}

/** Current BTC→USD spot price. */
export async function fetchBtcUsdPrice(fetchImpl: FetchFn = fetch): Promise<number> {
  return parseUsdPrice(await getJson(btcPriceUrl(), "price", fetchImpl));
}

// ── Transactions (Wallet Provider v3) ────────────────────────────────────────
//
// Confirmed BTC transaction import. This is the NORMALIZE layer: it hides all
// UTXO mechanics and emits provider-agnostic "movements" that the engine
// (btc-sync.ts) persists as ordinary Transaction rows. No UTXO model ever
// reaches the application (see the chain-adapter design doc §3).

/** Minimal shape of a mempool.space address transaction — only what normalization needs. */
export interface RawBtcTx {
  txid: string;
  vin: { prevout?: { scriptpubkey_address?: string; value?: number } }[];
  vout: { scriptpubkey_address?: string; value?: number }[];
  fee?: number;
  status?: { confirmed?: boolean; block_time?: number };
}

export type BtcMovementRole = "PRINCIPAL" | "FEE";
export type BtcFlowType = "INCOME" | "INVESTMENT" | "SPENDING" | "FEE" | "TRANSFER";
export type BtcFlowDirection = "INFLOW" | "OUTFLOW" | "INTERNAL";

/**
 * One normalized economic movement — the adapter's output. A single on-chain tx
 * yields one PRINCIPAL movement (receive/send) and, for a spend, a sibling FEE
 * movement. `amountBtc` is signed to the platform convention (inflow +, outflow
 * / fee −). `counterpartyAddresses` are the EXTERNAL addresses (senders for a
 * receive, recipients for a send); the engine resolves any that belong to the
 * user's own wallets into an INTERNAL transfer.
 */
export interface NormalizedBtcMovement {
  txid: string;
  externalId: string;                 // txid, or `${txid}:fee` — the dedupe key
  occurredAt: Date;                   // from block_time
  amountBtc: number;                  // signed native BTC
  role: BtcMovementRole;
  flowType: BtcFlowType;
  flowDirection: BtcFlowDirection;
  settlement: "POSTED" | "PENDING";
  counterpartyAddresses: string[];    // external addresses (for engine internal-resolution)
  merchantLabel: string;
  description: string;
}

const uniq = (arr: (string | undefined)[]): string[] =>
  [...new Set(arr.filter((a): a is string => !!a))];

function formatBtc(sats: number): string {
  return satsToBtc(sats).toFixed(8).replace(/\.?0+$/, "");
}

/**
 * Normalize an address's raw transactions into economic movements (PURE — the
 * unit of the v3 test). For each tx it computes the wallet's NET effect across
 * its own inputs/outputs (change nets out; UTXOs never surface):
 *   - myInputs == 0  → pure receive → INCOME / INFLOW (amount = net received)
 *   - myInputs  > 0  → outbound principal → INVESTMENT / INTERNAL (amount sent to
 *                       others). Per FM FlowType doctrine (flow-classifier.ts: a
 *                       Sell is INVESTMENT/INTERNAL) moving BTC out of the wallet
 *                       is an asset conversion, NOT spending — so it never counts
 *                       as Cash Flow spend or income. The miner fee is a separate
 *                       FEE / OUTFLOW movement (a real cost, unchanged); a pure
 *                       self-consolidation (nothing sent out) is fee-only. The
 *                       engine may still reclassify an all-own-wallet send to a
 *                       TRANSFER / INTERNAL (see btc-sync.buildTransactionRow).
 * Confirmed → POSTED, unconfirmed → PENDING.
 */
export function normalizeBtcAddressTxs(rawTxs: RawBtcTx[], myAddresses: string[]): NormalizedBtcMovement[] {
  const out: NormalizedBtcMovement[] = [];
  const mine = new Set(myAddresses);
  const isMine = (a?: string): boolean => !!a && mine.has(a);

  for (const tx of rawTxs) {
    const vin = tx.vin ?? [];
    const vout = tx.vout ?? [];

    // Net across ALL of the wallet's addresses (xpub: change to another of the
    // wallet's own addresses nets out, exactly like single-address change).
    const myInputs = vin.reduce(
      (s, i) => s + (isMine(i.prevout?.scriptpubkey_address) ? (i.prevout?.value ?? 0) : 0), 0);
    const myOutputs = vout.reduce(
      (s, o) => s + (isMine(o.scriptpubkey_address) ? (o.value ?? 0) : 0), 0);
    const toOthers = vout.reduce(
      (s, o) => s + (o.scriptpubkey_address && !isMine(o.scriptpubkey_address) ? (o.value ?? 0) : 0), 0);

    const recipients = uniq(vout.map((o) => o.scriptpubkey_address).filter((a) => !isMine(a)));
    const senders    = uniq(vin.map((i) => i.prevout?.scriptpubkey_address).filter((a) => !isMine(a)));
    const fee        = tx.fee ?? 0;
    const settlement = tx.status?.confirmed ? "POSTED" : "PENDING";
    const occurredAt = new Date((tx.status?.block_time ?? 0) * 1000);

    if (myInputs === 0) {
      // Pure receive — I am only a recipient, so I pay no fee.
      const net = myOutputs;
      if (net > 0) {
        out.push({
          txid: tx.txid, externalId: tx.txid, occurredAt,
          amountBtc: satsToBtc(net), role: "PRINCIPAL",
          flowType: "INCOME", flowDirection: "INFLOW", settlement,
          counterpartyAddresses: senders,
          merchantLabel: "Bitcoin received",
          description: `Received ${formatBtc(net)} BTC`,
        });
      }
      continue;
    }

    // I moved coins out — the fee is mine. Change back to myself nets out.
    // Doctrine: an outbound principal BTC movement is an asset conversion
    // (INVESTMENT / INTERNAL), not spending — it must not touch Cash Flow.
    if (toOthers > 0) {
      out.push({
        txid: tx.txid, externalId: tx.txid, occurredAt,
        amountBtc: -satsToBtc(toOthers), role: "PRINCIPAL",
        flowType: "INVESTMENT", flowDirection: "INTERNAL", settlement,
        counterpartyAddresses: recipients,
        merchantLabel: "Bitcoin sent",
        description: `Sent ${formatBtc(toOthers)} BTC`,
      });
    }
    if (fee > 0) {
      out.push({
        txid: tx.txid, externalId: `${tx.txid}:fee`, occurredAt,
        amountBtc: -satsToBtc(fee), role: "FEE",
        flowType: "FEE", flowDirection: "OUTFLOW", settlement,
        counterpartyAddresses: [],
        merchantLabel: "Bitcoin network fee",
        description: `Network fee ${formatBtc(fee)} BTC`,
      });
    }
  }

  return out;
}

/**
 * Fetch an address's CONFIRMED transactions (newest page). Bounded by design —
 * `/txs/chain` returns the most-recent confirmed page; cursor-based backfill of
 * older history is a later refinement (keeps v3 minimal and volume-safe).
 */
export async function fetchAddressTxsRaw(address: string, fetchImpl: FetchFn = fetch): Promise<RawBtcTx[]> {
  const url = `${btcExplorerBaseUrl()}/api/address/${encodeURIComponent(address)}/txs/chain`;
  const json = await getJson(url, "transactions", fetchImpl);
  if (!Array.isArray(json)) {
    throw new BtcSyncError("transactions", "unexpected txs response shape (expected array)");
  }
  return json as RawBtcTx[];
}
