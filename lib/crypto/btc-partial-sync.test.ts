/**
 * lib/crypto/btc-partial-sync.test.ts
 *
 * MEMPOOL TRANSACTION IMPORT FAILURE ≠ CANONICAL BTC SYNC FAILURE.
 *
 * 2026-09-21: "Bitcoin is not updating", beside a production log line
 * `[btc-sync] transaction import failed … (non-fatal): mempool.space did not
 * respond within 10000 ms`. The investigation found the canonical path intact —
 * quantity observed, valuation from the archived close, account clock advanced —
 * but NOTHING pinned that behaviourally: every existing syncBtcWallet test was a
 * source scan. And the import failure was invisible everywhere except the
 * console: the refresh ledger recorded a clean SUCCEEDED for a run that had
 * spent its whole timeout failing to read history.
 *
 * This file RUNS the real syncBtcWallet against an in-memory stand-in for the
 * handful of Prisma delegates the single-address path touches, with injected
 * balance / transaction / price providers. The DB URL is pointed at an
 * unreachable, clone-named address BEFORE @/lib/db loads, so a delegate this
 * file forgot to stub fails fast and can never reach a real database.
 *
 * Runs under scripts/run-tests.ts (server-only preload). No network, no DB.
 */

process.env.DATABASE_URL = "postgresql://stub@127.0.0.1:1/fintracker_unit_stub";
process.env.INVESTMENT_OBSERVATIONS_ENABLED = "true";

import { readFileSync } from "fs";
import { join } from "path";
import type { RawBtcTx } from "@/lib/crypto/btc-explorer";

process.on("unhandledRejection", (err) => {
  if ((err as { constructor?: { name?: string } })?.constructor?.name === "PrismaClientInitializationError") return;
  console.error("unexpected unhandled rejection:", err);
  process.exit(1);
});

let failures = 0;
let passes = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) passes++;
  else { failures++; console.log(`[FAIL] ${name}`); if (detail) console.log(`        ${detail}`); }
}
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const read = (...seg: string[]) => readFileSync(join(process.cwd(), ...seg), "utf8");

// ── The in-memory store ───────────────────────────────────────────────────────

const ADDRESS = "bc1qunitstubaddress";
const ACCOUNT = "acc-btc-unit";
const SATS = 100_000_000;

interface TxRow { externalTransactionId: string; amount: number; currency: string; deletedAt: Date | null; settlementState: string }

interface Store {
  account: { nativeBalance: number; balance: number; syncStatus: string; lastUpdated: Date };
  transactions: TxRow[];
  observations: { quantity: number; date: Date }[];
  accountUpdates: Record<string, unknown>[];
  syncIssues: Record<string, unknown>[];
}

function install(db: Record<string, unknown>, store: Store): void {
  db.financialAccount = {
    findUnique: async () => ({ id: ACCOUNT, ownerUserId: null, walletChain: "BTC", walletAddress: ADDRESS, deletedAt: null }),
    update: async ({ data }: { data: Record<string, unknown> }) => {
      store.accountUpdates.push(data);
      Object.assign(store.account, data);
      return { id: ACCOUNT };
    },
  };
  db.accountConnection = { findFirst: async () => null };
  db.providerAccountIdentity = { findMany: async () => [{ externalAccountId: ADDRESS }] };
  db.transaction = {
    findMany: async ({ where }: { where: Record<string, unknown> }) => {
      const ids = (where.externalTransactionId as { in?: string[] } | undefined)?.in;
      const rows = ids
        ? store.transactions.filter((t) => ids.includes(t.externalTransactionId))
        : store.transactions.filter((t) =>
            t.deletedAt === null && t.currency === where.currency && t.settlementState === where.settlementState);
      return rows.map((t) => ({ externalTransactionId: t.externalTransactionId, amount: t.amount }));
    },
    createMany: async ({ data }: { data: Array<Record<string, unknown>> }) => {
      for (const r of data) {
        store.transactions.push({
          externalTransactionId: r.externalTransactionId as string,
          amount: r.amount as number, currency: r.currency as string,
          deletedAt: null, settlementState: String(r.settlementState),
        });
      }
      return { count: data.length };
    },
  };
  db.instrumentAlias = { findUnique: async () => ({ instrumentId: "inst-btc" }) };
  db.positionObservation = {
    upsert: async ({ create }: { create: { quantity: unknown; date: Date } }) => {
      store.observations.push({ quantity: Number(create.quantity), date: create.date });
      return {};
    },
  };
  db.syncIssue = {
    findFirst: async () => null,
    create: async ({ data }: { data: Record<string, unknown> }) => { store.syncIssues.push(data); return { id: `si-${store.syncIssues.length}` }; },
    update: async () => ({}),
  };
  db.syncIssueOccurrence = { create: async () => ({ id: "occ" }) };
}

function freshStore(priorHistory: TxRow[]): Store {
  return {
    account: { nativeBalance: 0.1, balance: 7000, syncStatus: "synced", lastUpdated: new Date("2026-09-01T00:00:00Z") },
    transactions: priorHistory.map((t) => ({ ...t })),
    observations: [], accountUpdates: [], syncIssues: [],
  };
}

const posted = (id: string, btc: number): TxRow =>
  ({ externalTransactionId: id, amount: btc, currency: "BTC", deletedAt: null, settlementState: "POSTED" });

/** A confirmed receive of `sats` to the wallet's address. */
function receive(txid: string, sats: number): RawBtcTx {
  return {
    txid,
    vin: [{ prevout: { scriptpubkey_address: "bc1qsomeoneelse", value: sats + 500 } }],
    vout: [{ scriptpubkey_address: ADDRESS, value: sats }],
    fee: 500,
    status: { confirmed: true, block_time: 1_700_000_000 },
  };
}

async function main() {
  const { db } = await import("@/lib/db");
  const { syncBtcWallet } = await import("./btc-sync");
  const { BtcSyncError, fetchAddressTxsRaw } = await import("@/lib/crypto/btc-explorer");
  const { StageRecorder, deriveOverallStatus } = await import("@/lib/plaid/refresh-execution");

  const TIMEOUT = () => { throw new BtcSyncError("transactions", "mempool.space did not respond within 10000 ms"); };
  const PRICE = 80_000;
  const PRIOR = [posted("txA", 0.1)];
  const before = new Date();

  // ── 1. transaction provider succeeds → full sync succeeds ─────────────────
  {
    const store = freshStore(PRIOR);
    install(db as unknown as Record<string, unknown>, store);
    const r = await syncBtcWallet(ACCOUNT, {
      balanceFetcher: async () => 0.15 * SATS,
      txFetcher: async () => [receive("txA", 0.1 * SATS), receive("txB", 0.05 * SATS)],
      priceFetcher: async () => PRICE,
    });
    check("1 success: ok + synced", r.ok === true && r.syncStatus === "synced", JSON.stringify(r));
    check("1 success: import IMPORTED, one NEW row written (txA deduped)",
      r.transactionImport?.status === "IMPORTED" && r.transactionImport.written === 1 && r.transactionImport.fetched === 2,
      JSON.stringify(r.transactionImport));
    check("1 success: ledger reconciles", r.ledgerComplete === true);
    check("1 success: quantity + valuation written", store.account.nativeBalance === 0.15 && store.account.balance === 12_000);
  }

  // ── 2–7. timeout, no new chain activity (the live wallet's exact shape) ────
  {
    const store = freshStore(PRIOR);
    install(db as unknown as Record<string, unknown>, store);
    const r = await syncBtcWallet(ACCOUNT, {
      balanceFetcher: async () => 0.1 * SATS,
      txFetcher: async () => TIMEOUT(),
      priceFetcher: async () => PRICE,
    });
    check("2 timeout: the sync itself is ok (non-fatal)", r.ok === true, JSON.stringify(r));
    check("2 timeout: historical import reports FAILED, naming the provider and budget",
      r.transactionImport?.status === "FAILED" && /mempool\.space did not respond within 10000 ms/.test(r.transactionImport.reason),
      JSON.stringify(r.transactionImport));
    check("3 timeout: current quantity observed on the spine", store.observations.length === 1 && store.observations[0].quantity === 0.1);
    check("3 timeout: current quantity written to the account", store.account.nativeBalance === 0.1);
    check("4 timeout: valuation updated from the price authority (0.1 × 80,000)",
      store.account.balance === 8_000 && r.balanceUsd === 8_000 && r.priceUsd === PRICE);
    check("4 timeout: account clock advanced (the read model's observedAt)",
      store.account.lastUpdated.getTime() >= before.getTime());
    check("5 timeout: prior history intact", store.transactions.length === 1 && store.transactions[0].externalTransactionId === "txA");
    check("6 timeout: no fabricated rows", store.transactions.length === PRIOR.length);
    check("2 timeout + ledger still reconciles ⇒ synced (nothing is actually missing)",
      r.syncStatus === "synced" && r.ledgerComplete === true);
  }

  // ── 3/7. timeout WHILE the chain moved: quantity advances, history honestly short
  {
    const store = freshStore(PRIOR);
    install(db as unknown as Record<string, unknown>, store);
    const r = await syncBtcWallet(ACCOUNT, {
      balanceFetcher: async () => 0.15 * SATS,
      txFetcher: async () => TIMEOUT(),
      priceFetcher: async () => PRICE,
    });
    check("3b moved+timeout: ok, NEW quantity observed and written",
      r.ok === true && store.observations[0]?.quantity === 0.15 && store.account.nativeBalance === 0.15);
    check("4b moved+timeout: valuation follows the new quantity", store.account.balance === 12_000);
    check("6b moved+timeout: no fabricated movement to close the gap", store.transactions.length === 1);
    check("7b moved+timeout: status pending (history short), not synced",
      r.syncStatus === "pending" && store.account.syncStatus === "pending" && r.ledgerComplete === false);
    const issue = store.syncIssues.find((i) => (i.detail as { stage?: string } | undefined)?.stage === "transactions");
    check("7b moved+timeout: the short-ledger incident names the import outage as its cause",
      !!issue && /mempool\.space/.test(String((issue.detail as { transactionImportFailed?: string }).transactionImportFailed)),
      JSON.stringify(store.syncIssues.map((i) => i.detail)));
  }

  // ── 8. balance provider failure → no quantity claimed ─────────────────────
  {
    const store = freshStore(PRIOR);
    install(db as unknown as Record<string, unknown>, store);
    let txCalls = 0;
    const r = await syncBtcWallet(ACCOUNT, {
      balanceFetcher: async () => { throw new BtcSyncError("balance", "mempool.space did not respond within 10000 ms"); },
      txFetcher: async () => { txCalls++; return []; },
      priceFetcher: async () => PRICE,
    });
    check("8 balance failure: not ok, stage balance", r.ok === false && r.stage === "balance");
    check("8 balance failure: no observation, no account write, no import attempted",
      store.observations.length === 0 && store.accountUpdates.length === 0 && txCalls === 0);
    check("8 balance failure: previous quantity stands untouched", store.account.nativeBalance === 0.1);
  }

  // ── 9. price authority failure → no valuation claimed ─────────────────────
  {
    const store = freshStore(PRIOR);
    install(db as unknown as Record<string, unknown>, store);
    const r = await syncBtcWallet(ACCOUNT, {
      balanceFetcher: async () => 0.1 * SATS,
      txFetcher: async () => [],
      priceFetcher: async () => { throw new Error("no canonical BTC close in the price archive on or before 2026-09-21"); },
    });
    check("9 price failure: not ok, stage price", r.ok === false && r.stage === "price");
    check("9 price failure: no account write (no stale-priced value presented as current)",
      store.accountUpdates.length === 0 && store.account.balance === 7000);
  }

  // ── 7. the refresh ledger: a failed import makes the run PARTIAL ──────────
  {
    const rec = new StageRecorder();
    rec.begin("WALLET_SYNC", "PROVIDER");
    rec.succeed("WALLET_SYNC");
    const startedAt = new Date(Date.now() - 10_000);
    rec.recordMeasured("TRANSACTIONS", "PROVIDER", { ok: false, startedAt, durationMs: 10_000, err: new Error("mempool.space did not respond within 10000 ms") });
    const tx = rec.records.find((r) => r.endpoint === "TRANSACTIONS");
    check("7 ledger: WALLET_SYNC ok + TRANSACTIONS failed ⇒ PARTIAL", deriveOverallStatus(rec.records) === "PARTIAL");
    check("7 ledger: the stage carries the adapter's own clock, not a zero window",
      tx?.durationMs === 10_000 && tx.startedAt === startedAt && tx.status === "FAILED" && /mempool\.space/.test(tx.errorSummary ?? ""));

    const ok = new StageRecorder();
    ok.begin("WALLET_SYNC", "PROVIDER");
    ok.succeed("WALLET_SYNC");
    ok.recordMeasured("TRANSACTIONS", "PROVIDER", { ok: true, startedAt: new Date(), durationMs: 300, facts: { recordsRead: 28, recordsWritten: 0, recordsChanged: 0 } });
    check("1 ledger: import ok ⇒ SUCCEEDED", deriveOverallStatus(ok.records) === "SUCCEEDED");
  }

  // ── Explorer: complete-or-throw under a hang, with no partial page ────────
  {
    const hanging = ((_u: string, init?: RequestInit) => new Promise<Response>((_, reject) => {
      const s = init?.signal;
      if (!s) return;
      const abort = () => { const e = new Error("This operation was aborted"); e.name = "AbortError"; reject(e); };
      if (s.aborted) abort(); else s.addEventListener("abort", abort, { once: true });
    })) as unknown as typeof fetch;
    const fullPage = Array.from({ length: 25 }, (_, i) => receive(`p1-${i}`, 1000));
    let calls = 0;
    const secondPageHangs = ((url: string, init?: RequestInit) => {
      calls++;
      return calls === 1
        ? Promise.resolve(new Response(JSON.stringify(fullPage), { status: 200 }))
        : hanging(url, init);
    }) as unknown as typeof fetch;
    const saved = process.env.BTC_SYNC_TIMEOUT_MS;
    process.env.BTC_SYNC_TIMEOUT_MS = "25";
    let err: unknown; let got: unknown = null;
    try { got = await fetchAddressTxsRaw(ADDRESS, secondPageHangs); } catch (e) { err = e; }
    if (saved === undefined) delete process.env.BTC_SYNC_TIMEOUT_MS; else process.env.BTC_SYNC_TIMEOUT_MS = saved;
    check("explorer: a hang mid-pagination throws a staged error — never a partial list that looks complete",
      got === null && err instanceof BtcSyncError && err.stage === "transactions" && calls === 2,
      `calls=${calls} err=${String(err)}`);
  }

  // ── Source pins: the wiring that makes the outcome visible ────────────────
  const sync = code(read("lib", "crypto", "btc-sync.ts"));
  const body = sync.slice(sync.indexOf("export async function syncBtcWallet"), sync.indexOf("export interface SyncAllBtcWalletsResult"));
  const importAt = body.indexOf("await importBtcTransactions(");
  check("pin: the import outcome is kept, not discarded", /const transactionImport = await importBtcTransactions\(/.test(body));
  check("pin: no early return keyed on the import outcome (it never gates the position)",
    !/transactionImport[^;\n]*\)\s*return\b/.test(body) && !/if\s*\(\s*transactionImport/.test(body));
  check("pin: observation + account write still follow the import",
    importAt > 0 && body.indexOf("writeBtcObservation(", importAt) > importAt && body.indexOf("db.financialAccount.update(", importAt) > importAt);

  const dispatch = code(read("lib", "crypto", "wallet-sync-dispatch.ts"));
  check("pin: dispatch records the import as its own TRANSACTIONS provider stage",
    /recorder\.recordMeasured\("TRANSACTIONS",\s*"PROVIDER"/.test(dispatch));
  check("pin: dispatch surfaces transactionImport on the route's outcome", /transactionImport:\s*txImport/.test(dispatch));

  const button = code(read("components", "dashboard", "SyncWalletButton.tsx"));
  check("pin: the Refresh button says so when history did not refresh",
    /transactionImport\?\.status === "FAILED"/.test(button) && /Balance updated/.test(button));

  console.log(`\nbtc-partial-sync: ${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error("btc-partial-sync test crashed:", e);
  process.exit(1);
});
