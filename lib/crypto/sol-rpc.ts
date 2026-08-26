/**
 * lib/crypto/sol-rpc.ts
 *
 * W-M1c — native Solana balance acquisition: the PURE provider layer.
 *
 * No dependency on @/lib/db or next/*, so it imports cleanly under the bare-tsx
 * unit runner and can be exercised offline with an injected `fetch` — the same
 * constraint as btc-explorer.ts and eth-rpc.ts, for the same reason.
 *
 * Scope: the native SOL balance of ONE owner address on mainnet-beta. No SPL
 * token accounts, no stake accounts, no transaction history, no program
 * decoding. Orchestration and persistence live in ./sol-sync.ts.
 *
 * ── THE u64 PROBLEM, WHICH IS WORSE HERE THAN ON ETHEREUM ────────────────────
 * Ethereum returns wei as a HEX STRING, so the digits survive transport intact
 * and only the parse has to be careful. Solana returns lamports as a JSON
 * NUMBER — a bare `u64` literal in the response body:
 *
 *     {"jsonrpc":"2.0","result":{"context":{"slot":1},"value":18446744073709551615}}
 *
 * `JSON.parse` converts that to a float64 BEFORE any code of ours runs. u64 goes
 * to 1.8e19; `Number.MAX_SAFE_INTEGER` is 9.007e15. Everything above that is
 * silently rounded to the nearest representable double, and the precision is
 * gone before the first line of a parser could object. This is not theoretical
 * at Solana's scale: 9,007,199 SOL is where lamports cross the safe-integer
 * boundary, which large holders exceed.
 *
 * So this layer reads the RAW RESPONSE TEXT and lifts the integer literal out of
 * it as DIGITS, then converts with BigInt. `JSON.parse` is still used — to detect
 * a JSON-RPC `error` member and to validate the envelope's shape — but never as
 * the source of the quantity. The parsed number serves only as a fallback when
 * the literal cannot be located AND is provably safe.
 *
 * ── FINALIZED, NOT PROCESSED ─────────────────────────────────────────────────
 * The request pins `commitment: "finalized"`. Solana's default is "confirmed",
 * which can still be rolled back; "processed" more so. A balance that may be
 * reverted is not a balance, and this is the same confirmed-only stance
 * btc-explorer takes with `chain_stats` and eth-rpc with `latest`.
 *
 * ── PROVIDER IS CONFIGURATION, NOT ARCHITECTURE ──────────────────────────────
 * Any JSON-RPC endpoint serving `getBalance` works. The URL is read from the
 * environment and the transport is injectable. With nothing configured this
 * layer is DARK — it reports UNCONFIGURED and acquires nothing. A dark provider
 * is an honest absence, never a zero.
 */

import { alchemyRpcUrl, ALCHEMY_NETWORKS } from "./alchemy";

/** 1 SOL = 10^9 lamports. */
export const LAMPORTS_PER_SOL = BigInt(1000000000);

/** Which external step failed — carried on the error and into any SyncIssue. */
export type SolSyncStage = "config" | "address" | "balance";

/** Typed failure so callers can record an honest, staged sync issue. */
export class SolRpcError extends Error {
  constructor(public readonly stage: SolSyncStage, message: string) {
    super(message);
    this.name = "SolRpcError";
  }
}

const DEFAULT_TIMEOUT_MS = 10_000;

function timeoutMs(): number {
  const n = Number(process.env.SOL_SYNC_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TIMEOUT_MS;
}

/**
 * The configured JSON-RPC endpoint, or null when this deployment has none.
 *
 * PRECEDENCE, and the reason for each rung:
 *   1. `SOL_RPC_URL`     an explicit operator override — a self-hosted archive,
 *                        a second vendor, a fixture proxy. Always wins.
 *   2. Alchemy           THE PREFERRED PROVIDER. One credential across chains,
 *                        and verified archival on standard methods: a live probe
 *                        of the acceptance wallet resolved signatures back to
 *                        2022 and fetched the oldest transaction in full.
 *   3. `HELIUS_API_KEY`  retained as a specialist/fallback. Helius is a capable
 *                        Solana archive and keeping the rung costs nothing;
 *                        removing it would throw away a working alternative for
 *                        a preference that is operational, not epistemic.
 *
 * The public `api.mainnet-beta.solana.com` endpoint is deliberately NOT a
 * default at any rung. Its own documentation says it is not for production, and
 * its address-history index reaches days rather than years — so defaulting to it
 * would make an unconfigured deployment look configured and fail intermittently
 * instead of honestly.
 *
 * NULL IS A FIRST-CLASS ANSWER: "this deployment cannot read Solana" is a
 * different fact from "the wallet holds nothing" and must never collapse into it.
 *
 * THE RETURNED URL MAY EMBED A CREDENTIAL. Never log it; log the stage.
 */
export function solRpcUrl(): string | null {
  const direct = process.env.SOL_RPC_URL?.trim();
  if (direct) return direct.replace(/\/+$/, "");
  const alchemy = alchemyRpcUrl(ALCHEMY_NETWORKS.SOLANA);
  if (alchemy) return alchemy;
  const helius = process.env.HELIUS_API_KEY?.trim();
  if (helius) return `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(helius)}`;
  return null;
}

// ── Base58 + address validation (pure) ───────────────────────────────────────

/** The Bitcoin/Solana base58 alphabet — no 0, O, I or l, by design. */
const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const BASE58_INDEX: ReadonlyMap<string, number> =
  new Map([...BASE58_ALPHABET].map((c, i) => [c, i]));

/** An ed25519 public key is 32 bytes. Every Solana account address is one. */
export const SOLANA_ADDRESS_BYTES = 32;

/**
 * Decode a base58 string to its byte length, or null when it is not base58.
 *
 * Returns the LENGTH rather than the bytes because length is the only thing
 * validation needs, and returning bytes would invite a caller to start doing
 * key arithmetic in a module whose job is transport.
 *
 * Leading '1' characters encode leading zero bytes and are counted as such —
 * omitting that is the classic base58 decoding bug, and it matters: an address
 * whose key begins with a zero byte would otherwise measure 31 bytes and be
 * rejected as malformed.
 */
export function base58DecodedLength(input: string): number | null {
  if (input.length === 0) return null;
  let leadingZeros = 0;
  while (leadingZeros < input.length && input[leadingZeros] === "1") leadingZeros++;

  let value = BigInt(0);
  const fiftyEight = BigInt(58);
  for (const ch of input) {
    const digit = BASE58_INDEX.get(ch);
    if (digit === undefined) return null;
    value = value * fiftyEight + BigInt(digit);
  }

  // Byte length of the big-endian magnitude, plus the explicit leading zeros.
  let magnitudeBytes = 0;
  let v = value;
  const zero = BigInt(0);
  const twoFiftySix = BigInt(256);
  while (v > zero) { magnitudeBytes++; v = v / twoFiftySix; }
  return leadingZeros + magnitudeBytes;
}

/**
 * Is this a well-formed Solana MAINNET address?
 *
 * DECODED, not merely measured. A length-and-charset check accepts strings that
 * are valid base58 but decode to the wrong number of bytes, which is exactly the
 * class of typo a user makes — and it would then be sent to the RPC, which
 * answers with an error the user cannot interpret. The real test is the one the
 * chain applies: 32 bytes, because every Solana account address is an ed25519
 * public key.
 *
 * DELIBERATELY NOT CHECKED: whether the key lies ON the ed25519 curve. An
 * off-curve address is a Program Derived Address rather than a keypair wallet;
 * verifying that needs curve arithmetic this repository has no dependency for,
 * and a PDA still HAS a lamport balance that `getBalance` reports correctly. So
 * the check would refuse a readable account to enforce a distinction this slice
 * does not act on. Stated rather than silently skipped.
 */
export function isSolAddressShape(address: string): boolean {
  const trimmed = address.trim();
  // Cheap bound first: 32 bytes cannot base58-encode shorter than 32 characters
  // and never exceeds 44. Rejects obvious garbage before the BigInt loop.
  if (trimmed.length < 32 || trimmed.length > 44) return false;
  return base58DecodedLength(trimmed) === SOLANA_ADDRESS_BYTES;
}

/** Solana addresses are case-SIGNIFICANT base58 — normalising means trimming only. */
export function normalizeSolAddress(address: string): string {
  return address.trim();
}

// ── Wire parsing (pure) ──────────────────────────────────────────────────────

/** The minimal JSON-RPC response shape this layer reads. */
interface SolRpcEnvelope {
  result?: { context?: unknown; value?: unknown } | null;
  error?:  { code?: number; message?: string };
}

/**
 * Locate the `result.value` integer LITERAL in the raw response text.
 *
 * Anchored after `"result"` so a `value` appearing elsewhere in the envelope
 * cannot be mistaken for the balance. Returns the digits as a string, or null
 * when the literal is absent or is not a bare non-negative integer (a float, a
 * string, or `null` all fall through to the caller's stricter handling).
 */
export function extractLamportLiteral(rawBody: string): string | null {
  const resultAt = rawBody.indexOf('"result"');
  if (resultAt < 0) return null;
  const m = /"value"\s*:\s*(\d+)\s*[,}]/.exec(rawBody.slice(resultAt));
  return m ? m[1] : null;
}

/**
 * Extract the lamport balance from a `getBalance` response.
 *
 * Takes the RAW BODY TEXT, not a parsed object, because `JSON.parse` has already
 * destroyed a large u64 by the time an object exists (see the header). The parse
 * still happens — for the `error` member and the envelope shape — but the
 * quantity comes from the literal.
 *
 * The parsed number is used ONLY as a fallback, and only when it is a safe
 * integer. If the literal cannot be located and the parsed value is beyond
 * float64's exact range, this THROWS rather than returning a rounded balance: a
 * quantity we cannot state exactly is not a quantity we may record.
 */
export function parseSolLamports(rawBody: string): bigint {
  let env: SolRpcEnvelope;
  try { env = JSON.parse(rawBody) as SolRpcEnvelope; }
  catch { throw new SolRpcError("balance", "unparseable JSON-RPC response"); }

  if (env.error) {
    throw new SolRpcError("balance", `provider error ${env.error.code ?? "?"}: ${env.error.message ?? "unknown"}`);
  }
  if (!env.result || typeof env.result !== "object") {
    throw new SolRpcError("balance", "unexpected getBalance response shape (missing result)");
  }

  const literal = extractLamportLiteral(rawBody);
  if (literal !== null) {
    const value = BigInt(literal);
    if (value < BigInt(0)) throw new SolRpcError("balance", `negative lamport balance: ${literal}`);
    return value;
  }

  // Fallback: the shape was valid but the literal was not where it should be.
  const parsed = env.result.value;
  if (typeof parsed !== "number" || !Number.isFinite(parsed) || parsed < 0) {
    throw new SolRpcError("balance", `unexpected lamport value: ${JSON.stringify(parsed)}`);
  }
  if (!Number.isSafeInteger(parsed)) {
    throw new SolRpcError("balance",
      `lamport balance ${parsed} exceeds exact integer range and its literal could not be read; ` +
      "refusing rather than recording a rounded quantity");
  }
  return BigInt(parsed);
}

/**
 * Lamports → SOL as a whole-unit number, for the canonical quantity column.
 *
 * Exact for every balance that exists: SOL's total supply is ~6e17 lamports, and
 * splitting integer from fractional part before conversion keeps the whole-SOL
 * side exact well past that. The fractional side carries 9 digits, comfortably
 * inside float64.
 *
 * Dividing the BigInt through `Number` in one step would round balances above
 * ~9,007,199 SOL, which is precisely the range this function exists to protect.
 */
export function lamportsToSol(lamports: bigint): number {
  const whole = lamports / LAMPORTS_PER_SOL;
  const rem   = lamports % LAMPORTS_PER_SOL;
  return Number(whole) + Number(rem) / Number(LAMPORTS_PER_SOL);
}

// ── Fetcher (injectable `fetch` for offline tests) ───────────────────────────

export type FetchFn = typeof fetch;

/**
 * The FINALIZED native balance of one owner address, in LAMPORTS.
 *
 * This is the OWNER account's own lamports and nothing else. SPL token balances
 * live in separate token accounts derived from (owner, mint) and are absent from
 * this figure — correctly, and by design for W-M1c. A Solana wallet's SOL
 * balance is a complete answer to "how much SOL does this wallet hold"; it is
 * not an answer to "what is in this wallet", and no caller may present it as one.
 *
 * Throws `SolRpcError` on every failure path, so no failure can be mistaken for
 * a zero balance.
 */
export async function fetchSolLamports(
  address: string,
  deps: { fetchImpl?: FetchFn; rpcUrl?: string | null } = {},
): Promise<bigint> {
  const url = deps.rpcUrl !== undefined ? deps.rpcUrl : solRpcUrl();
  if (!url) {
    throw new SolRpcError("config",
      "no Solana RPC endpoint configured (set SOL_RPC_URL or HELIUS_API_KEY)");
  }
  if (!isSolAddressShape(address)) {
    throw new SolRpcError("address", `not a well-formed Solana address: ${address}`);
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
        jsonrpc: "2.0", id: 1, method: "getBalance",
        // FINALIZED — a balance that can still be rolled back is not a balance.
        params: [normalizeSolAddress(address), { commitment: "finalized" }],
      }),
      signal: controller.signal,
    });
  } catch (e) {
    throw new SolRpcError("balance", `network error: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) throw new SolRpcError("balance", `HTTP ${res.status} from the Solana RPC endpoint`);

  // TEXT, not json() — the digits must reach BigInt before JSON.parse rounds them.
  let rawBody: string;
  try { rawBody = await res.text(); }
  catch { throw new SolRpcError("balance", "could not read the JSON-RPC response body"); }

  return parseSolLamports(rawBody);
}
