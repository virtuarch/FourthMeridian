/**
 * lib/crypto/token-rpc.ts
 *
 * TOKEN HOLDINGS FOUNDATION (PR-A) — the two token TRANSPORTS. No Prisma, no DB.
 *
 *   Solana    getTokenAccountsByOwner(owner, {programId}, {encoding: jsonParsed})
 *             once per token program (classic SPL + Token-2022) → 2 calls.
 *   Ethereum  alchemy_getTokenBalances(address, "erc20", {pageKey}) paginated,
 *             then alchemy_getTokenMetadata(contract) for each contract whose
 *             decimals are not already known (callers pass what the alias
 *             metadata already holds, so a repeat sync spends balances only).
 *
 * ── EVERY REQUEST IS COUNTED, AND BOUNDED BEFORE IT IS SENT ─────────────────
 * Each call increments `meter[method]` (the RequestMeter shape the shared
 * Alchemy budget records — lib/usage/provider-budget) BEFORE it goes out, so a
 * request that times out is still a request spent. `callBudget` is a hard
 * ceiling: a call that would exceed it is not sent, and the enumeration is
 * reported INCOMPLETE rather than silently shortened.
 *
 * ── ALCHEMY'S ENHANCED METHOD, STATED ───────────────────────────────────────
 * lib/crypto/alchemy.ts keeps interpreted endpoints out of the MOVEMENT model.
 * `alchemy_getTokenBalances` is a balance read (an aggregated `balanceOf`), not
 * a transfer interpretation, and it is used here only for the CURRENT position —
 * never as history evidence. The ERC-20 history follow-up must derive history
 * from raw chain evidence, as ETH native does.
 *
 * Failure is never a zero: every transport/HTTP/envelope failure THROWS
 * `TokenRpcError`, and the capture layer writes nothing on a throw.
 */

import { redactProviderSecrets } from "./alchemy";
import {
  SOLANA_TOKEN_PROGRAMS, parseSplTokenAccounts, groupSplHoldings,
  parseAlchemyTokenBalances, parseAlchemyTokenMetadata, erc20Holding,
  type TokenHolding, type TokenMetadata, type Erc20BalanceEntry,
} from "./token-asset";

export type FetchFn = typeof fetch;
export type RequestMeter = Record<string, number>;

export class TokenRpcError extends Error {
  constructor(public readonly phase: "config" | "budget" | "tokens" | "metadata", message: string) {
    super(message);
    this.name = "TokenRpcError";
  }
}

export interface TokenTransportDeps {
  rpcUrl: string;
  fetchImpl?: FetchFn;
  /** Incremented per method BEFORE each request is sent. */
  meter: RequestMeter;
  /** Hard ceiling on requests this enumeration may send. */
  callBudget: number;
  timeoutMs?: number;
}

/** What one enumeration produced. `complete` licenses closing tokens that vanished. */
export interface TokenEnumeration {
  holdings: TokenHolding[];
  /**
   * TRUE only when every page was read and every listed balance was readable
   * and normalisable. Closure (writing a 0 for a token no longer listed) is
   * allowed only on a complete enumeration — a page we did not read is not
   * evidence that a token is gone.
   */
  complete: boolean;
  /** Assets seen but not stated (unreadable balance, unknown decimals, refused mint, budget). */
  unstated: Array<{ contract: string; reason: string }>;
  calls: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const callsIn = (m: RequestMeter) => Object.values(m).reduce((s, n) => s + n, 0);

async function rpc(deps: TokenTransportDeps, method: string, params: unknown[], phase: "tokens" | "metadata"): Promise<unknown> {
  if (callsIn(deps.meter) >= deps.callBudget) throw new TokenRpcError("budget", `request budget of ${deps.callBudget} reached before ${method}`);
  deps.meter[method] = (deps.meter[method] ?? 0) + 1;
  const doFetch = deps.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  let res: Response;
  try {
    res = await doFetch(deps.rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: controller.signal,
    });
  } catch (e) {
    throw new TokenRpcError(phase, redactProviderSecrets(`${method} network error: ${e instanceof Error ? e.message : String(e)}`));
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new TokenRpcError(phase, `${method}: HTTP ${res.status}`);
  try { return await res.json(); }
  catch { throw new TokenRpcError(phase, `${method}: unparseable JSON-RPC response`); }
}

/**
 * Every SPL + Token-2022 holding of a Solana owner, grouped by mint. Exactly
 * `SOLANA_TOKEN_PROGRAMS.length` (2) requests. Throws on any failure — a
 * half-read wallet (one program answered, the other refused) writes nothing.
 */
export async function fetchSolTokenHoldings(owner: string, deps: TokenTransportDeps): Promise<TokenEnumeration> {
  const all = [];
  let rejected = 0;
  for (const programId of SOLANA_TOKEN_PROGRAMS) {
    const body = await rpc(deps, "getTokenAccountsByOwner",
      [owner, { programId }, { encoding: "jsonParsed", commitment: "finalized" }], "tokens");
    let parsed;
    try { parsed = parseSplTokenAccounts(body, programId); }
    catch (e) { throw new TokenRpcError("tokens", redactProviderSecrets(e instanceof Error ? e.message : String(e))); }
    all.push(...parsed.entries);
    rejected += parsed.rejected;
  }
  const { holdings, refusedMints } = groupSplHoldings(all);
  return {
    holdings,
    complete: rejected === 0 && refusedMints.length === 0,
    unstated: refusedMints.map((m) => ({ contract: m, reason: "token accounts disagree about decimals" })),
    calls: callsIn(deps.meter),
  };
}

export interface Erc20EnumerationOptions {
  /** Pages of 100 balances to read at most. */
  maxPages: number;
  /**
   * Decimals/symbol/name already known (alias metadata) for these non-zero
   * contracts — no metadata call is sent for them. Injected so this module stays
   * DB-free; a lookup failure only means more metadata calls, never a guess.
   */
  knownMetadata: (contracts: readonly string[]) => Promise<ReadonlyMap<string, TokenMetadata>>;
}

/**
 * Every non-zero ERC-20 holding of an address. Balances first (paginated, bounded
 * by `maxPages`), then metadata for the non-zero contracts whose decimals are not
 * known. A balances failure throws; a METADATA failure for one contract leaves
 * that one token unstated (and the enumeration incomplete) rather than discarding
 * every other token's evidence.
 */
export async function fetchErc20TokenHoldings(
  address: string, deps: TokenTransportDeps, opts: Erc20EnumerationOptions,
): Promise<TokenEnumeration> {
  const nonZero: Erc20BalanceEntry[] = [];
  const unstated: TokenEnumeration["unstated"] = [];
  let complete = true;
  let pageKey: string | null = null;
  for (let page = 0; page < opts.maxPages; page++) {
    const params: unknown[] = pageKey ? [address, "erc20", { pageKey }] : [address, "erc20"];
    const body = await rpc(deps, "alchemy_getTokenBalances", params, "tokens");
    let parsed;
    try { parsed = parseAlchemyTokenBalances(body); }
    catch (e) { throw new TokenRpcError("tokens", redactProviderSecrets(e instanceof Error ? e.message : String(e))); }
    for (const e of parsed.entries) if (e.amount > BigInt(0)) nonZero.push(e);
    for (const c of parsed.unreadable) unstated.push({ contract: c, reason: "balance unreadable" });
    pageKey = parsed.pageKey;
    if (!pageKey) break;
  }
  if (pageKey) { complete = false; unstated.push({ contract: "*", reason: `more than ${opts.maxPages} page(s) of token balances` }); }
  if (unstated.length > 0) complete = false;

  let known: ReadonlyMap<string, TokenMetadata> = new Map();
  try { known = await opts.knownMetadata(nonZero.map((e) => e.contract)); } catch { /* fall through to metadata calls */ }

  const holdings: TokenHolding[] = [];
  for (const entry of nonZero) {
    let meta = known.get(entry.contract) ?? null;
    if (!meta || meta.decimals === null) {
      try {
        meta = parseAlchemyTokenMetadata(await rpc(deps, "alchemy_getTokenMetadata", [entry.contract], "metadata"));
      } catch (e) {
        complete = false;
        unstated.push({ contract: entry.contract, reason: e instanceof TokenRpcError && e.phase === "budget" ? "request budget reached" : "metadata unavailable" });
        continue;
      }
    }
    const h = erc20Holding(entry, meta);
    if (h) holdings.push(h);
    else { complete = false; unstated.push({ contract: entry.contract, reason: "decimals unknown" }); }
  }
  holdings.sort((a, b) => a.contract.localeCompare(b.contract));
  return { holdings, complete, unstated, calls: callsIn(deps.meter) };
}
