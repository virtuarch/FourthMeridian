/**
 * lib/crypto/erc20-history-rpc.ts
 *
 * ERC-20 HISTORY — the two reads, on the SAME metered Ethereum transport the
 * native history uses (eth-history.ts `buildTransport`: every JSON-RPC call is
 * counted into `deps.meter` before it is sent, a batch of n counts n), so the
 * caller records them on the shared Alchemy ledger like every other call.
 *
 *   alchemy_getAssetTransfers   one page (≤ 1,000 transfers) per call
 *   eth_call balanceOf          one call per anchor, batched per token
 *
 * No Prisma, no DB. A throttle is retried with the shared bounded backoff; every
 * other failure THROWS — except a per-call `eth_call` revert, which is an answer
 * about the CONTRACT (it does not implement balanceOf the standard way) and is
 * returned as such for that one token.
 */

import {
  buildTransport, callBatchWithBackoff, EthThrottleError, type EthHistoryDeps, type EthRpcTransport,
} from "./eth-history";
import { redactProviderSecrets } from "./alchemy";
import {
  parseAssetTransfers, parseBalanceOfResult, balanceOfCalldata, type BalanceRead, type Erc20Transfer,
} from "./erc20-history.core";

/** Max transfers per page (Alchemy's ceiling, 0x3e8). */
export const TRANSFERS_PAGE_SIZE = "0x3e8";

const hex = (n: number) => "0x" + n.toString(16);

/** One page of one direction of a wallet's ERC-20 transfers over [fromBlock, toBlock]. */
export async function fetchErc20TransfersPage(
  args: { wallet: string; direction: "from" | "to"; fromBlock: number; toBlock: number; pageKey: string | null },
  deps: EthHistoryDeps,
): Promise<{ transfers: Erc20Transfer[]; pageKey: string | null }> {
  const transport = buildTransport(deps);
  const params: Record<string, unknown> = {
    fromBlock: hex(args.fromBlock), toBlock: hex(args.toBlock),
    category: ["erc20"], withMetadata: true, excludeZeroValue: false, maxCount: TRANSFERS_PAGE_SIZE, order: "asc",
    ...(args.direction === "from" ? { fromAddress: args.wallet } : { toAddress: args.wallet }),
    ...(args.pageKey ? { pageKey: args.pageKey } : {}),
  };
  const [result] = await callBatchWithBackoff([{ method: "alchemy_getAssetTransfers", params: [params] }], transport,
    { retries: deps.throttleRetries, sleepImpl: deps.sleepImpl });
  return parseAssetTransfers(result);
}

/** Thrown for a provider failure that is NOT an answer about the contract (retry the step). */
export class Erc20ProviderError extends Error {
  constructor(message: string) { super(message); this.name = "Erc20ProviderError"; }
}

/** JSON-RPC error codes / messages a node uses for an execution revert. */
function isRevert(err: { code?: unknown; message?: unknown }): boolean {
  const m = typeof err.message === "string" ? err.message.toLowerCase() : "";
  return err.code === 3 || m.includes("revert") || m.includes("invalid opcode") || m.includes("out of gas");
}

/** Send one batch, keeping per-call errors (only a throttle or a transport failure throws). */
async function callSettled(calls: Array<{ method: string; params: unknown[] }>, transport: EthRpcTransport):
  Promise<Array<{ result: unknown } | { error: { code?: unknown; message?: unknown } }>> {
  const body = calls.map((c, i) => ({ jsonrpc: "2.0", id: i, method: c.method, params: c.params }));
  const text = await transport(calls.length === 1 ? body[0] : body);
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new Erc20ProviderError("unparseable JSON-RPC response"); }
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  const out: Array<{ result: unknown } | { error: { code?: unknown; message?: unknown } }> = new Array(calls.length);
  let seen = 0;
  for (const row of rows as Array<{ id?: unknown; result?: unknown; error?: { code?: unknown; message?: unknown } }>) {
    const idx = typeof row.id === "number" ? row.id : Number(row.id);
    if (!Number.isInteger(idx) || idx < 0 || idx >= calls.length) throw new Erc20ProviderError("JSON-RPC response carried an id outside the batch");
    if (row.error) {
      if (row.error.code === 429) throw new EthThrottleError("the Ethereum RPC endpoint refused the batch for capacity");
      out[idx] = { error: row.error };
    } else out[idx] = { result: row.result };
    seen++;
  }
  if (seen !== calls.length) throw new Erc20ProviderError(`JSON-RPC batch answered ${seen} of ${calls.length} calls`);
  return out;
}

/**
 * `balanceOf(wallet)` on `contract` at each block, in order. A revert or a
 * non-standard answer is that read's VALUE (judgeAnchors refuses it); any other
 * error member is a provider failure and throws.
 */
export async function readBalancesAt(
  args: { contract: string; wallet: string; blocks: readonly number[] },
  deps: EthHistoryDeps,
): Promise<BalanceRead[]> {
  if (args.blocks.length === 0) return [];
  const transport = buildTransport(deps);
  const data = balanceOfCalldata(args.wallet);
  const calls = args.blocks.map((b) => ({ method: "eth_call", params: [{ to: args.contract, data }, hex(b)] }));
  const retries = deps.throttleRetries ?? 6;
  const sleep = deps.sleepImpl ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let attempt = 0; ; attempt++) {
    try {
      const rows = await callSettled(calls, transport);
      return rows.map((r) => {
        if ("result" in r) return parseBalanceOfResult(r.result);
        if (isRevert(r.error)) return { kind: "REVERTED" } as const;
        throw new Erc20ProviderError(redactProviderSecrets(`provider error ${String(r.error.code ?? "?")}: ${String(r.error.message ?? "unknown")}`));
      });
    } catch (e) {
      if (!(e instanceof EthThrottleError) || attempt >= retries) throw e;
      await sleep(300 * 2 ** attempt);
    }
  }
}
