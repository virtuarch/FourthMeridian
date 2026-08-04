/**
 * lib/crypto/wallet-initial-connection.test.ts
 *
 * V26-S3-LEDGER — A NEWLY CONNECTED WALLET GETS THE SAME PAGINATED,
 * COMPLETENESS-CHECKED IMPORT AS A RESYNC.
 *
 * ── Why this test exists ─────────────────────────────────────────────────────
 * The pagination repair (S1) and the ledger gate (S3) were both proven by
 * re-syncing a wallet that already existed. That proves nothing about the FIRST
 * connection, which is the moment a wallet's whole history is established and
 * the only moment a user watches. If the connect route reached a different
 * import, every new wallet would start life with a truncated ledger and nothing
 * would say so.
 *
 * Two things are proven here, behaviourally where possible and structurally
 * where a DB would otherwise be required:
 *
 *   1. PAGINATION + DEDUPE, exercised against an injected explorer that behaves
 *      exactly like mempool.space: 25 confirmed transactions per page, continued
 *      by `:last_seen_txid`, with no total and no "has more" flag. This is the
 *      real 28-transaction wallet's shape.
 *   2. ONE PATH. The connect route, the manual sync route and the cron all reach
 *      `syncBtcWallet`, and the connect route runs it BEFORE the snapshot and
 *      history regeneration it triggers — so a first connection cannot reach
 *      history with an unimported ledger.
 */

import { readFileSync } from "node:fs";
import { fetchAddressTxsRaw, normalizeBtcAddressTxs, type RawBtcTx } from "./btc-explorer";
import { reconcileWalletLedger } from "./ledger-completeness.core";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");

const ADDR = "bc1qtestwalletaddressxxxxxxxxxxxxxxxxxxxx";
const PAGE = 25; // mempool.space's confirmed-transactions page size

/** A receive of `sats` to our address. Newest first, like the explorer. */
function rx(txid: string, sats: number, blockTime: number): RawBtcTx {
  return {
    txid, vin: [], vout: [{ scriptpubkey_address: ADDR, value: sats }],
    fee: 0, status: { confirmed: true, block_time: blockTime },
  };
}

/**
 * An explorer that pages exactly like mempool.space: `/txs/chain` returns the
 * newest 25, `/txs/chain/{lastSeenTxid}` continues from there, and a short page
 * is the ONLY signal that the history is exhausted.
 */
function makeExplorer(all: RawBtcTx[], opts: { unpaginated?: boolean; ignoresCursor?: boolean } = {}) {
  let requests = 0;
  const fetchImpl = (async (url: string) => {
    requests++;
    const u = String(url);
    const m = u.match(/\/txs\/chain\/([0-9a-f]+)$/);
    if (opts.unpaginated) return json(all.slice(0, PAGE));           // the S1 defect
    if (opts.ignoresCursor) return json(all.slice(0, PAGE));         // a provider that never advances
    const start = m ? all.findIndex((t) => t.txid === m[1]) + 1 : 0;
    return json(all.slice(start, start + PAGE));
  }) as unknown as Parameters<typeof fetchAddressTxsRaw>[1];
  return { fetchImpl, requests: () => requests };
}
function json(body: unknown) {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

async function main(): Promise<void> {
  console.log("V26-S3-LEDGER — initial wallet connection\n");

  // The live wallet's real shape: 28 confirmed receives, oldest three of which
  // an unpaginated fetch would miss.
  const OBSERVED = 0.24060252;
  const sats = [
    435799, 178703, 1414005, 530354, 618516, 1408729, 1314373, 1075411, 512714,
    676999, 345334, 350358, 357369, 374158, 732640, 547066, 1517750, 992778,
    651394, 1982382, 1692484, 689180, 1148289, 1497371, 774252, 1134141, 850507, 257196,
  ];
  // Newest first, as the explorer returns them.
  // Newest first, hex txids (the explorer's cursor is a txid).
  const all = sats.map((v, i) =>
    rx(`${(0xabc0000 + (27 - i)).toString(16)}`, v, 1_679_000_000 + (27 - i) * 86_400));
  /** The three OLDEST — exactly what an unpaginated first page leaves behind. */
  const missedSats = sats.slice(PAGE);

  // ══ A. PAGINATION — the whole history, in page-sized requests ═════════════
  console.log("A. Pagination to exhaustion");
  {
    const ex = makeExplorer(all);
    const rows = await fetchAddressTxsRaw(ADDR, ex.fetchImpl);
    check("A. every confirmed transaction is fetched", rows.length === 28, `got ${rows.length}`);
    check("A. it took more than one request (the page size is 25)", ex.requests() >= 2);
    check("A. no txid appears twice", new Set(rows.map((r) => r.txid)).size === 28);

    const movements = normaliseTotal(rows);
    check("A. the movement total equals the observed balance EXACTLY",
      Math.abs(movements - OBSERVED) < 1e-9, `got ${movements}`);
    check("A. and reconciles through the canonical authority",
      reconcileWalletLedger({ observedBalance: OBSERVED, movements: normaliseList(rows) }).complete);
  }

  // ══ B. THE DEFECT, REPRODUCED ═════════════════════════════════════════════
  console.log("\nB. An unpaginated fetch is refused, not silently accepted");
  {
    const ex = makeExplorer(all, { unpaginated: true });
    const rows = await fetchAddressTxsRaw(ADDR, ex.fetchImpl);
    check("B. only one page arrives", rows.length === PAGE);
    const recon = reconcileWalletLedger({ observedBalance: OBSERVED, movements: normaliseList(rows) });
    check("B. the ledger is REFUSED", !recon.complete && recon.refusal === "LEDGER_SHORTFALL");
    check("B. and the residual is exactly the omitted transactions",
      Math.abs(recon.residual! - missedSats.reduce((n, v) => n + v, 0) / 1e8) < 1e-9,
      `got ${recon.residual}`);
    check("B. which is three transactions, as on the live wallet", missedSats.length === 3);
  }

  // ══ C. A PROVIDER THAT IGNORES THE CURSOR CANNOT LOOP FOREVER ═════════════
  console.log("\nC. A non-advancing provider terminates");
  {
    const ex = makeExplorer(all, { ignoresCursor: true });
    const rows = await fetchAddressTxsRaw(ADDR, ex.fetchImpl);
    check("C. the loop stops rather than spinning", ex.requests() <= 3);
    check("C. and the repeated page never inflates the set", rows.length === PAGE);
    check("C. which the reconciliation then refuses",
      !reconcileWalletLedger({ observedBalance: OBSERVED, movements: normaliseList(rows) }).complete);
  }

  // ══ D. IDEMPOTENCY — a second import adds nothing ═════════════════════════
  console.log("\nD. A repeated sync is a no-op on the ledger");
  {
    const a = await fetchAddressTxsRaw(ADDR, makeExplorer(all).fetchImpl);
    const b = await fetchAddressTxsRaw(ADDR, makeExplorer(all).fetchImpl);
    check("D. identical txid sets", JSON.stringify(a.map((r) => r.txid)) === JSON.stringify(b.map((r) => r.txid)));
    // The import's dedupe key is the txid (`externalTransactionId`), so the union
    // of two identical fetches is the same ledger.
    const union = new Map([...a, ...b].map((t) => [t.txid, t]));
    check("D. the union is still 28 movements — no duplicates", union.size === 28);
    check("D. and still reconciles", Math.abs(normaliseTotal([...union.values()]) - OBSERVED) < 1e-9);
  }

  // ══ E. AN EMPTY WALLET RECONCILES TRIVIALLY ═══════════════════════════════
  console.log("\nE. A brand-new empty wallet is history-ready immediately");
  {
    const ex = makeExplorer([]);
    const rows = await fetchAddressTxsRaw(ADDR, ex.fetchImpl);
    check("E. no transactions fetched", rows.length === 0);
    check("E. 0 == 0 is COMPLETE, so a new empty wallet is not blocked",
      reconcileWalletLedger({ observedBalance: 0, movements: [] }).complete);
  }

  // ══ F. ONE PATH — connection reaches the same import as a resync ══════════
  console.log("\nF. First connection uses the one sync path, in the right order");
  {
    const connect = strip(readFileSync("app/api/accounts/wallet/route.ts", "utf8"));
    const manual  = strip(readFileSync("app/api/accounts/[id]/sync/route.ts", "utf8"));
    const cron    = strip(readFileSync("jobs/sync-crypto.ts", "utf8"));

    check("F. the CONNECT route syncs through syncBtcWallet", /syncBtcWallet\s*\(/.test(connect));
    check("F. the MANUAL sync route uses the same function", /syncBtcWallet\s*\(/.test(manual));
    check("F. the CRON uses the same function (via syncAllBtcWallets)",
      /syncAllBtcWallets|syncBtcWallet/.test(cron));
    check("F. no route imports the explorer directly (no second import path)",
      !/fetchAddressTxsRaw/.test(connect) && !/fetchAddressTxsRaw/.test(manual));

    // Ordering: sync (which imports + reconciles) must precede the history the
    // connect route triggers, or a first connection would build history from an
    // unimported ledger.
    // Compare the CALL SITES in the create handler, not the helper's own
    // declaration (which sits near the top of the file).
    const syncAt    = connect.lastIndexOf("await syncBtcWallet(fa.id)");
    const historyAt = connect.lastIndexOf("await regenWalletWealthHistory(fa.id)");
    check("F. sync runs BEFORE wallet history regeneration on a NEW wallet",
      syncAt !== -1 && historyAt !== -1 && syncAt < historyAt,
      `sync@${syncAt} history@${historyAt}`);

    const sync = strip(readFileSync("lib/crypto/btc-sync.ts", "utf8"));
    check("F. the sync reconciles the ledger after importing",
      /reconcileWalletLedgerForAccount\s*\(/.test(sync) &&
      sync.indexOf("importBtcTransactions(") < sync.lastIndexOf("reconcileWalletLedgerForAccount("));
    check("F. and 'synced' requires BOTH discovery and a reconciled ledger",
      /discoveryComplete && ledger\.complete \? "synced" : "pending"/.test(sync));
    check("F. an unreconciled ledger is recorded as a sync issue, not swallowed",
      /recordWalletSyncIssue\(accountId, "transactions"/.test(sync));
    check("F. the sync reuses the canonical authority (no second reconciliation rule)",
      /from "@\/lib\/crypto\/ledger-completeness\.core"/.test(readFileSync("lib/crypto/btc-sync.ts", "utf8")));
  }

  console.log(failures === 0 ? "\nAll initial-connection checks passed" : `\n${failures} failure(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

function normaliseList(rows: RawBtcTx[]): number[] {
  return normalizeBtcAddressTxs(rows, [ADDR]).map((m) => m.amountBtc);
}
function normaliseTotal(rows: RawBtcTx[]): number {
  return normaliseList(rows).reduce((n, v) => n + v, 0);
}

main();
