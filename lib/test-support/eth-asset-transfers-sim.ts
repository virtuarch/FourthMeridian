/**
 * lib/test-support/eth-asset-transfers-sim.ts
 *
 * TEST SUPPORT. An offline stand-in for Alchemy's `alchemy_getAssetTransfers`
 * over a simulated chain's event list, so the ETH history FAST PATH can be
 * exercised against the same oracles the walk is tested with.
 *
 * It reproduces the index's real blind spots ON PURPOSE: by default an event is
 * listed only when a TRANSFER caused it, so
 *   - a validator WITHDRAWAL-only event is NOT listed (no withdrawal category exists);
 *   - an own transaction that REVERTED is NOT listed (failed transfers are omitted);
 *   - `indexed: false` hides anything else (e.g. a SELFDESTRUCT payout it missed);
 *   - `indexed: true` forces a listing.
 * An own transaction appears in the fromAddress stream; any positive non-withdrawal
 * residual in the toAddress stream. Paging is newest-first (`order: "desc"`) with a
 * server-side page size (`pageSize`, default the request's maxCount) and an opaque
 * offset `pageKey`, as the vendor does.
 */

export interface IndexedSimEvent {
  block: number;
  delta: bigint;
  originated?: boolean;
  feeWei?: bigint;
  withdrawalWei?: bigint;
  reverted?: boolean;
  /** Override whether the index lists this event at all. */
  indexed?: boolean;
}

export interface AssetTransfersSimOpts {
  owner: string;
  /** Server-side page size (the vendor may return fewer than maxCount). */
  pageSize?: number;
  /** Extra listings the chain does not back (an index that lies about blocks). */
  phantom?: ReadonlyArray<{ block: number; dir: "from" | "to" }>;
}

interface Row { id: number; method: string; params: unknown[] }

const hex = (n: number) => "0x" + n.toString(16);

/** The listings (block, direction) an honest-but-blind index holds for these events. */
export function indexListings(events: readonly IndexedSimEvent[], opts: AssetTransfersSimOpts): Array<{ block: number; dir: "from" | "to" }> {
  const out: Array<{ block: number; dir: "from" | "to" }> = [];
  for (const e of events) {
    if (e.indexed === false) continue;
    const dir = e.originated ? "from" : "to";
    if (e.indexed === true) { out.push({ block: e.block, dir }); continue; }
    const residual = e.delta + (e.feeWei ?? BigInt(0)) - (e.withdrawalWei ?? BigInt(0));
    if (e.originated ? e.reverted !== true : residual > BigInt(0)) out.push({ block: e.block, dir });
  }
  for (const p of opts.phantom ?? []) out.push(p);
  return out;
}

/** Serve one `alchemy_getAssetTransfers` JSON-RPC row. */
export function serveAssetTransfers(r: Row, events: readonly IndexedSimEvent[], opts: AssetTransfersSimOpts): unknown {
  const q = (r.params[0] ?? {}) as {
    fromBlock?: string; toBlock?: string; fromAddress?: string; toAddress?: string;
    order?: string; maxCount?: string; pageKey?: string; category?: string[];
  };
  const owner = opts.owner.toLowerCase();
  const dir: "from" | "to" | null = q.fromAddress?.toLowerCase() === owner ? "from" : q.toAddress?.toLowerCase() === owner ? "to" : null;
  if (!dir) return { jsonrpc: "2.0", id: r.id, error: { code: -32602, message: "address filter required" } };
  const lo = q.fromBlock ? Number(BigInt(q.fromBlock)) : 0;
  const hi = q.toBlock ? Number(BigInt(q.toBlock)) : Number.MAX_SAFE_INTEGER;
  const desc = q.order === "desc";
  const listed = indexListings(events, opts)
    .filter((l) => l.dir === dir && l.block >= lo && l.block <= hi)
    .sort((a, b) => (desc ? b.block - a.block : a.block - b.block));
  const max = Math.min(opts.pageSize ?? Number.MAX_SAFE_INTEGER, q.maxCount ? Number(BigInt(q.maxCount)) : 1000);
  const offset = q.pageKey ? Number(q.pageKey.replace(/^off-/, "")) : 0;
  const page = listed.slice(offset, offset + max);
  const more = offset + max < listed.length;
  return {
    jsonrpc: "2.0", id: r.id,
    result: {
      transfers: page.map((l, i) => ({
        blockNum: hex(l.block), hash: `0xtx${l.block}${l.dir}${i}`, category: "external",
        from: l.dir === "from" ? owner : "0x0000000000000000000000000000000000001234",
        to: l.dir === "to" ? owner : "0x0000000000000000000000000000000000001234",
        // Deliberately WRONG values: the fast path must never read them.
        value: 123456789, asset: "ETH",
      })),
      ...(more ? { pageKey: `off-${offset + max}` } : {}),
    },
  };
}
