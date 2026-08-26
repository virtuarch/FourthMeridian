/**
 * lib/crypto/eth-rpc.ts
 *
 * W-M1b — native Ethereum balance acquisition: the PURE provider layer.
 *
 * Deliberately has NO dependency on @/lib/db or next/*, so it imports cleanly
 * under the bare-tsx unit runner and can be exercised offline with an injected
 * `fetch` — the same constraint (and the same reason) as btc-explorer.ts.
 *
 * Scope: the native balance of one Ethereum mainnet address. No transaction
 * history, no ERC-20 enumeration, no logs, no ENS, no multi-EVM. Orchestration
 * and persistence live in ./eth-sync.ts.
 *
 * ── WEI IS AN INTEGER AND MUST STAY ONE UNTIL THE LAST MOMENT ────────────────
 * `eth_getBalance` returns a hex quantity in wei, and 1 ETH is 10^18 wei. A
 * float64 carries ~15–16 significant decimal digits, so parsing wei through
 * `Number` loses precision before any division happens: 1.234567890123456789
 * ETH arrives as 1234567890123456789 wei, which `Number` rounds to
 * 1234567890123456800 — the last three digits invented. The balance would still
 * LOOK right to a human and be wrong in the ledger.
 *
 * So the wire value is parsed with BigInt, stays a BigInt through validation,
 * and is converted exactly once, at the boundary where the canonical domain
 * requires a whole-unit number (`PositionObservation.quantity` is a Float). That
 * final conversion is lossy for absurdly precise balances and CANNOT be avoided
 * without a schema change; `weiToEth` documents the bound rather than hiding it.
 *
 * ── PROVIDER IS CONFIGURATION, NOT ARCHITECTURE ──────────────────────────────
 * Any JSON-RPC endpoint serving `eth_getBalance` works: a self-hosted node,
 * Alchemy, Infura, or Etherscan's RPC. The URL is read from the environment and
 * the transport is injectable. With nothing configured this layer is DARK — it
 * reports UNCONFIGURED and acquires nothing, exactly as the price registry stays
 * empty without a vendor key. A dark provider is an honest absence, never a zero.
 */

/** 1 ETH = 10^18 wei. */
export const WEI_PER_ETH = BigInt(10) ** BigInt(18);

/** Which external step failed — carried on the error and into any SyncIssue. */
export type EthSyncStage = "config" | "address" | "balance";

/** Typed failure so callers can record an honest, staged sync issue. */
export class EthRpcError extends Error {
  constructor(public readonly stage: EthSyncStage, message: string) {
    super(message);
    this.name = "EthRpcError";
  }
}

const DEFAULT_TIMEOUT_MS = 10_000;

function timeoutMs(): number {
  const n = Number(process.env.ETH_SYNC_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TIMEOUT_MS;
}

/**
 * The configured JSON-RPC endpoint, or null when this deployment has none.
 *
 * `ETH_RPC_URL` is the direct form (any provider, any plan). `ETHERSCAN_API_KEY`
 * is accepted as a convenience because the key is already declared in lib/env.ts;
 * it is turned into Etherscan's JSON-RPC proxy URL here, at the edge, so nothing
 * above this line knows which vendor answered.
 *
 * NULL IS A FIRST-CLASS ANSWER. It means "this deployment cannot read Ethereum",
 * which is different from "the wallet holds nothing" and must never collapse
 * into it.
 */
export function ethRpcUrl(): string | null {
  const direct = process.env.ETH_RPC_URL?.trim();
  if (direct) return direct.replace(/\/+$/, "");
  const etherscan = process.env.ETHERSCAN_API_KEY?.trim();
  if (etherscan) return `https://api.etherscan.io/v2/api?chainid=1&apikey=${encodeURIComponent(etherscan)}`;
  return null;
}

// ── Address validation (pure) ────────────────────────────────────────────────

const ADDRESS_SHAPE = /^0x[0-9a-fA-F]{40}$/;

/**
 * Is this a well-formed Ethereum address?
 *
 * Shape only — 0x plus 40 hex digits, any case. The EIP-55 checksum carried by a
 * mixed-case address is NOT verified, because verifying it requires keccak-256
 * and this repository has no hashing dependency; adding one to validate a
 * user-typed string is not a trade this slice makes. See `normalizeEthAddress`
 * for what is done instead, and why an unverified checksum is not a correctness
 * hole here.
 *
 * Deliberately NOT verified: whether the address exists, has ever transacted, or
 * is a contract. None of those is a validity question, and refusing a fresh
 * address would refuse a legitimate cold wallet.
 */
export function isEthAddressShape(address: string): boolean {
  return ADDRESS_SHAPE.test(address.trim());
}

/**
 * The canonical lowercase form, for the RPC call and for comparison.
 *
 * Lower-casing makes two spellings of one address compare equal, which is what
 * duplicate detection and provider identity need, and it is the form every RPC
 * accepts. It also DISCARDS the EIP-55 checksum, which this layer cannot verify
 * (no keccak-256 dependency) — so the checksum's protection against a
 * transcription typo is not available.
 *
 * That is a stated limit, not a hidden one, and it is bounded: an address typed
 * wrong resolves to a DIFFERENT address, which returns its own balance — almost
 * always zero. The user sees a wallet that does not match their expectation
 * rather than a wrong number attributed to the right wallet. Adding checksum
 * verification is a small, well-defined improvement whenever a hashing
 * dependency arrives for another reason.
 */
export function normalizeEthAddress(address: string): string {
  return address.trim().toLowerCase();
}

// ── Wire parsing (pure) ──────────────────────────────────────────────────────

/**
 * Parse a JSON-RPC hex QUANTITY into an exact BigInt.
 *
 * Accepts the canonical `0x`-prefixed form. Throws rather than returning a
 * sentinel: a balance we cannot parse must fail the sync, never be written as
 * zero (an unparseable response and an empty wallet are opposite facts).
 */
export function parseHexQuantity(raw: unknown): bigint {
  if (typeof raw !== "string" || !/^0x[0-9a-fA-F]+$/.test(raw.trim())) {
    throw new EthRpcError("balance", `unexpected balance quantity (want 0x-hex, got ${JSON.stringify(raw)})`);
  }
  const value = BigInt(raw.trim());
  if (value < BigInt("0")) throw new EthRpcError("balance", `negative balance quantity: ${raw}`);
  return value;
}

/** The minimal JSON-RPC response shape this layer reads. */
interface JsonRpcEnvelope {
  result?: unknown;
  error?:  { code?: number; message?: string };
}

/**
 * Extract the wei balance from an `eth_getBalance` response.
 *
 * A JSON-RPC `error` member is a PROVIDER refusal and is surfaced as such — it
 * is not an empty wallet. Etherscan's proxy additionally answers some failures
 * with a `result` that is a human string rather than a quantity; that falls
 * through to `parseHexQuantity` and throws, which is the correct outcome.
 */
export function parseEthBalanceWei(json: unknown): bigint {
  const env = (json ?? {}) as JsonRpcEnvelope;
  if (env.error) {
    throw new EthRpcError("balance", `provider error ${env.error.code ?? "?"}: ${env.error.message ?? "unknown"}`);
  }
  return parseHexQuantity(env.result);
}

/**
 * Wei → ETH as a whole-unit number, for the canonical quantity column.
 *
 * Exact for every balance whose significant digits fit float64 (which is every
 * balance any human holds). The integer and fractional parts are split BEFORE
 * conversion so the integer side never loses precision to the divisor — dividing
 * a BigInt through Number in one step would round balances above ~9 ETH.
 *
 * The residual imprecision is the fractional part beyond ~15 significant
 * digits, and it is unavoidable while `PositionObservation.quantity` is a Float.
 * That bound is the same one `ledgerEpsilonFor(ETH_NATIVE)` states, and it is
 * documented in both places rather than discovered later.
 */
export function weiToEth(wei: bigint): number {
  const whole = wei / WEI_PER_ETH;
  const rem   = wei % WEI_PER_ETH;
  return Number(whole) + Number(rem) / Number(WEI_PER_ETH);
}

// ── Fetcher (injectable `fetch` for offline tests) ───────────────────────────

export type FetchFn = typeof fetch;

/**
 * The confirmed native balance of one address, in WEI.
 *
 * `latest` rather than `pending`: an unconfirmed balance is not a balance, the
 * same confirmed-only stance btc-explorer takes with `chain_stats`.
 *
 * Throws `EthRpcError` on every failure path — unconfigured provider, malformed
 * address, transport failure, non-2xx, JSON-RPC error, unparseable quantity —
 * so the caller can stage an honest SyncIssue and, critically, so no failure can
 * be mistaken for a zero balance.
 */
export async function fetchEthWeiBalance(
  address: string,
  deps: { fetchImpl?: FetchFn; rpcUrl?: string | null } = {},
): Promise<bigint> {
  const url = deps.rpcUrl !== undefined ? deps.rpcUrl : ethRpcUrl();
  if (!url) {
    throw new EthRpcError("config",
      "no Ethereum RPC endpoint configured (set ETH_RPC_URL or ETHERSCAN_API_KEY)");
  }
  if (!isEthAddressShape(address)) {
    throw new EthRpcError("address", `not a well-formed Ethereum address: ${address}`);
  }

  const doFetch = deps.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs());
  let res: Response;
  try {
    res = await doFetch(url, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "eth_getBalance",
        params: [normalizeEthAddress(address), "latest"],
      }),
      signal: controller.signal,
    });
  } catch (e) {
    throw new EthRpcError("balance", `network error: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) throw new EthRpcError("balance", `HTTP ${res.status} from the Ethereum RPC endpoint`);

  let body: unknown;
  try { body = await res.json(); }
  catch { throw new EthRpcError("balance", "unparseable JSON-RPC response"); }

  return parseEthBalanceWei(body);
}
