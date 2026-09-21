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
// BIP32 test vector 1 master xpub — public test material, not a wallet.
const XPUB = "xpub661MyMwAqRbcFtXgS5sYJABqqG9YLmC4Q1Rdap9gSE8NqtwybGhePY2gZ29ESFjqJoCu1Rupje8YtGqsefD265TMg7usUDFdp6W1EGMcet8";
const XPUB_ADDRS = ["bc1qxpubchildzero", "bc1qxpubchildone"];

/** The wallet shape the fake store serves. */
const shape = { walletAddress: ADDRESS, identities: [ADDRESS] };
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
    findUnique: async () => ({ id: ACCOUNT, ownerUserId: null, walletChain: "BTC", walletAddress: shape.walletAddress, deletedAt: null }),
    update: async ({ data }: { data: Record<string, unknown> }) => {
      store.accountUpdates.push(data);
      Object.assign(store.account, data);
      return { id: ACCOUNT };
    },
  };
  db.accountConnection = { findFirst: async () => null };
  db.providerAccountIdentity = { findMany: async () => shape.identities.map((externalAccountId) => ({ externalAccountId })) };
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

  // ── CASE 5. balance ok, valuation authority fails → quantity fresh, value not
  {
    const store = freshStore(PRIOR);
    install(db as unknown as Record<string, unknown>, store);
    const r = await syncBtcWallet(ACCOUNT, {
      balanceFetcher: async () => 0.15 * SATS,
      txFetcher: async () => [receive("txA", 0.1 * SATS), receive("txB", 0.05 * SATS)],
      priceFetcher: async () => { throw new Error("no canonical BTC close in the price archive on or before 2026-09-21"); },
    });
    check("9 price failure: the sync is ok — the quantity does not wait on a price", r.ok === true, JSON.stringify(r));
    check("9 price failure: the fresh quantity IS recorded — on the spine observation",
      store.observations[0]?.quantity === 0.15 && r.nativeBalance === 0.15);
    check("9 price failure: the legacy pair AND its clock stay as the last priced run left them",
      store.accountUpdates.length === 1 && !("nativeBalance" in store.accountUpdates[0]) && !("balance" in store.accountUpdates[0])
        && !("lastUpdated" in store.accountUpdates[0]) && store.account.balance === 7000 && store.account.nativeBalance === 0.1
        && store.account.lastUpdated.getTime() < before.getTime(), JSON.stringify(store.accountUpdates));
    check("9 price failure: valuation UNAVAILABLE by name; no priceUsd/balanceUsd claimed",
      r.valuation?.status === "UNAVAILABLE" && /no canonical BTC close/.test(r.valuation.reason)
        && r.priceUsd === undefined && r.balanceUsd === undefined, JSON.stringify(r.valuation));
    check("9 price failure: history import unaffected", r.transactionImport?.status === "IMPORTED");
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

    const unpriced = new StageRecorder();
    unpriced.begin("WALLET_SYNC", "PROVIDER");
    unpriced.succeed("WALLET_SYNC");
    unpriced.recordMeasured("VALUATION", "DERIVED", { ok: false, startedAt: new Date(), durationMs: 3, err: new Error("no canonical BTC close") });
    unpriced.recordMeasured("TRANSACTIONS", "PROVIDER", { ok: true, startedAt: new Date(), durationMs: 5 });
    check("13 ledger: quantity ok + VALUATION failed ⇒ PARTIAL (not FAILED, not SUCCEEDED)",
      deriveOverallStatus(unpriced.records) === "PARTIAL");

    const noBalance = new StageRecorder();
    noBalance.begin("WALLET_SYNC", "PROVIDER");
    noBalance.fail("WALLET_SYNC", new Error("HTTP 500 from blockstream.info"));
    check("13 ledger: balance authority failed ⇒ FAILED (current position not refreshed)",
      deriveOverallStatus(noBalance.records) === "FAILED");
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

  // ── SINGLE-ADDRESS through the REAL provider routing (injected fetch) ────
  //
  // No balanceFetcher / txFetcher: syncBtcWallet builds the real Esplora calls,
  // and a fake network routes by HOST. This is what proves which authority owns
  // which dimension — not a stub standing in for the routing itself.
  const esplora = (funded: number, spent: number) =>
    ({ chain_stats: { funded_txo_sum: funded, spent_txo_sum: spent, tx_count: 1 }, mempool_stats: { funded_txo_sum: 0, spent_txo_sum: 0, tx_count: 0 } });
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  type Route = (url: URL) => Promise<Response>;
  function network(routes: Record<string, Route>) {
    const calls: string[] = [];
    const f = (async (input: string) => {
      const url = new URL(input);
      calls.push(url.host);
      const route = routes[url.host];
      if (!route) throw new TypeError(`fetch failed (no route to ${url.host})`);
      return route(url);
    }) as unknown as typeof fetch;
    return { f, calls };
  }
  const unreachable: Route = async () => { throw new TypeError("fetch failed: connect ETIMEDOUT"); };
  const savedRetries = process.env.BTC_RATE_LIMIT_RETRIES;
  process.env.BTC_RATE_LIMIT_RETRIES = "0";
  // The history authority is CONFIGURED here to a host distinct from the
  // balance authority, so the fake network can tell the two dimensions apart.
  // (mempool.space is a contract-compatible history host; the default is
  // blockstream.info — pinned separately below.)
  const savedExplorer = process.env.BTC_EXPLORER_BASE_URL;
  process.env.BTC_EXPLORER_BASE_URL = "https://mempool.space";

  shape.walletAddress = ADDRESS; shape.identities = [ADDRESS];

  // S1 — balance authority ok, history ok → full success
  {
    const store = freshStore(PRIOR);
    install(db as unknown as Record<string, unknown>, store);
    const net = network({
      "blockstream.info": async () => json(esplora(0.15 * SATS, 0)),
      "mempool.space":    async (u) => json(u.pathname.split("/").length > 6 ? [] : [receive("txA", 0.1 * SATS), receive("txB", 0.05 * SATS)]),
    });
    const r = await syncBtcWallet(ACCOUNT, { fetchImpl: net.f, priceFetcher: async () => PRICE });
    check("S1 single: full success (synced, history imported)",
      r.ok && r.syncStatus === "synced" && r.transactionImport?.status === "IMPORTED", JSON.stringify(r));
    check("S1 single: balance read from the BALANCE authority (blockstream.info), history from mempool.space",
      net.calls[0] === "blockstream.info" && net.calls.slice(1).every((h) => h === "mempool.space"), net.calls.join(","));
    check("S1 single: observation advances to the provider's quantity", store.observations[0]?.quantity === 0.15);
    check("12 valuation is the injected archive price, never a network quote",
      r.priceUsd === PRICE && !net.calls.some((h) => h !== "blockstream.info" && h !== "mempool.space"));
  }

  // S2 — balance ok, mempool history times out → PARTIAL-shaped result
  {
    const store = freshStore(PRIOR);
    install(db as unknown as Record<string, unknown>, store);
    const savedT = process.env.BTC_SYNC_TIMEOUT_MS;
    process.env.BTC_SYNC_TIMEOUT_MS = "25";
    const net = network({
      "blockstream.info": async () => json(esplora(0.1 * SATS, 0)),
      "mempool.space":    (u) => new Promise<Response>(() => { void u; }), // never answers
    });
    // The fake never honours abort by itself; wrap so the abort rejects like undici.
    const aborting = ((input: string, init?: RequestInit) => new Promise<Response>((resolve, reject) => {
      init?.signal?.addEventListener("abort", () => { const e = new Error("This operation was aborted"); e.name = "AbortError"; reject(e); }, { once: true });
      (net.f as unknown as (i: string) => Promise<Response>)(input).then(resolve, reject);
    })) as unknown as typeof fetch;
    const r = await syncBtcWallet(ACCOUNT, { fetchImpl: aborting, priceFetcher: async () => PRICE });
    if (savedT === undefined) delete process.env.BTC_SYNC_TIMEOUT_MS; else process.env.BTC_SYNC_TIMEOUT_MS = savedT;
    check("S2 single: history timeout ⇒ ok, quantity + valuation + observation written",
      r.ok && store.account.nativeBalance === 0.1 && store.account.balance === 8_000 && store.observations[0]?.quantity === 0.1, JSON.stringify(r));
    check("S2 single: transaction stage FAILED naming mempool.space's budget",
      r.transactionImport?.status === "FAILED" && /^mempool\.space did not respond within 25 ms$/.test(r.transactionImport.reason),
      JSON.stringify(r.transactionImport));
    check("S2 single: history preserved, nothing fabricated", store.transactions.length === 1 && store.transactions[0].externalTransactionId === "txA");
  }

  // S3 — THE PRIMARY GATE: mempool.space unavailable ENTIRELY, balance authority ok
  {
    const store = freshStore(PRIOR);
    install(db as unknown as Record<string, unknown>, store);
    const net = network({ "blockstream.info": async () => json(esplora(0.12345678 * SATS, 0)), "mempool.space": unreachable });
    const r = await syncBtcWallet(ACCOUNT, { fetchImpl: net.f, priceFetcher: async () => PRICE });
    check("S3 single: mempool.space gone ⇒ current position STILL updates",
      r.ok === true && store.observations[0]?.quantity === 0.12345678 && store.account.nativeBalance === 0.12345678, JSON.stringify(r));
    check("S3 single: valuation follows (0.12345678 × 80,000 = 9,876.54)", store.account.balance === 9876.54);
    check("S3 single: the outage is reported as a history failure, not a position failure",
      r.transactionImport?.status === "FAILED" && /network error reaching mempool\.space/.test(r.transactionImport.reason));
    check("S3 single: prior history intact, no rows fabricated", store.transactions.length === 1);
  }

  // S4 — balance authority fails, history would succeed → nothing claimed
  {
    const store = freshStore(PRIOR);
    install(db as unknown as Record<string, unknown>, store);
    const net = network({ "blockstream.info": async () => json({ error: "down" }, 500), "mempool.space": async () => json([]) });
    const r = await syncBtcWallet(ACCOUNT, { fetchImpl: net.f, priceFetcher: async () => PRICE });
    check("S4 single: balance authority failure ⇒ not ok, stage balance", r.ok === false && r.stage === "balance", JSON.stringify(r));
    check("S4 single: no fabricated quantity, no observation, no account write, clock NOT advanced",
      store.observations.length === 0 && store.accountUpdates.length === 0 && store.account.nativeBalance === 0.1
        && store.account.lastUpdated.getTime() < before.getTime());
    check("S4 single: history is not consulted for the quantity (no mempool call)", !net.calls.includes("mempool.space"), net.calls.join(","));
    check("15 privacy: the failure names the host, never the address",
      r.reason === "HTTP 500 from blockstream.info" && !JSON.stringify(store.syncIssues).includes(ADDRESS), r.reason);
  }

  // S5 — balance AND history unavailable → not fresh, nothing written
  {
    const store = freshStore(PRIOR);
    install(db as unknown as Record<string, unknown>, store);
    const net = network({ "blockstream.info": unreachable, "mempool.space": unreachable });
    const r = await syncBtcWallet(ACCOUNT, { fetchImpl: net.f, priceFetcher: async () => PRICE });
    check("S5 single: both down ⇒ not ok at balance; previous quantity stands, not re-stamped fresh",
      r.ok === false && r.stage === "balance" && store.accountUpdates.length === 0 && store.observations.length === 0
        && store.account.lastUpdated.getTime() < before.getTime(), JSON.stringify(r));
    check("S5 single: the balance failure is recorded (history was not attempted)",
      store.syncIssues.some((i) => (i.detail as { stage?: string }).stage === "balance") && !(r.reason ?? "").includes(ADDRESS));
  }

  // S6 — zero balance is an exact zero, not missing
  {
    const store = freshStore([]);
    install(db as unknown as Record<string, unknown>, store);
    const net = network({ "blockstream.info": async () => json(esplora(5_000, 5_000)), "mempool.space": async () => json([]) });
    const r = await syncBtcWallet(ACCOUNT, { fetchImpl: net.f, priceFetcher: async () => PRICE });
    check("S6 zero: ok, quantity exactly 0, a 0 observation written, value 0",
      r.ok && r.nativeBalance === 0 && store.account.nativeBalance === 0 && store.observations[0]?.quantity === 0 && store.account.balance === 0,
      JSON.stringify(r));
  }

  // S7 — satoshi precision
  for (const sats of [1, 24_060_252, 12_345_678_901, 2_099_999_997_690_000]) {
    const store = freshStore([]);
    install(db as unknown as Record<string, unknown>, store);
    const net = network({ "blockstream.info": async () => json(esplora(sats, 0)), "mempool.space": unreachable });
    const r = await syncBtcWallet(ACCOUNT, { fetchImpl: net.f, priceFetcher: async () => PRICE });
    const q = store.observations[0]?.quantity ?? NaN;
    check(`S7 precision: ${sats} sats round-trips exactly`, r.ok && Math.round(q * SATS) === sats && q === sats / SATS, `q=${q}`);
  }

  // ── XPUB regression: blockchain.info still owns xpub balance ──────────────
  shape.walletAddress = XPUB; shape.identities = XPUB_ADDRS;
  {
    const store = freshStore([]);
    install(db as unknown as Record<string, unknown>, store);
    const net = network({
      "blockchain.info": async () => json({ addresses: [
        { address: XPUB_ADDRS[0], n_tx: 3, final_balance: 20_000_000 },
        { address: XPUB_ADDRS[1], n_tx: 0, final_balance: 0 },
      ] }),
      "mempool.space": unreachable,
    });
    const r = await syncBtcWallet(ACCOUNT, { fetchImpl: net.f, priceFetcher: async () => PRICE });
    check("8 xpub: balance from blockchain.info (summed), NOT the single-address authority",
      r.ok && store.account.nativeBalance === 0.2 && net.calls[0] === "blockchain.info" && !net.calls.includes("blockstream.info"),
      `${JSON.stringify(r)} calls=${net.calls.join(",")}`);
    check("9 xpub: mempool.space gone ⇒ 1352d4f partial contract intact (position written, import FAILED)",
      store.observations[0]?.quantity === 0.2 && r.transactionImport?.status === "FAILED" && store.transactions.length === 0);
    check("9 xpub: only the ACTIVE address is asked for history", net.calls.filter((h) => h === "mempool.space").length === 1, net.calls.join(","));
  }
  {
    const store = freshStore([]);
    install(db as unknown as Record<string, unknown>, store);
    const net = network({ "blockchain.info": async () => json({}, 500) });
    const r = await syncBtcWallet(ACCOUNT, { fetchImpl: net.f, priceFetcher: async () => PRICE });
    check("15 privacy: an xpub batch failure names the host, never the (up to 50) addresses in its URL",
      r.ok === false && r.reason === "HTTP 500 from blockchain.info" && !XPUB_ADDRS.some((a) => JSON.stringify(store.syncIssues).includes(a)),
      r.reason);
  }
  shape.walletAddress = ADDRESS; shape.identities = [ADDRESS];
  if (savedRetries === undefined) delete process.env.BTC_RATE_LIMIT_RETRIES; else process.env.BTC_RATE_LIMIT_RETRIES = savedRetries;
  if (savedExplorer === undefined) delete process.env.BTC_EXPLORER_BASE_URL; else process.env.BTC_EXPLORER_BASE_URL = savedExplorer;

  // ── SLICE 2A — ONE configured history authority; the pager stops on a short page
  {
    const { btcExplorerBaseUrl, ESPLORA_CHAIN_PAGE_SIZE } = await import("@/lib/crypto/btc-explorer");
    const saved = process.env.BTC_EXPLORER_BASE_URL;
    delete process.env.BTC_EXPLORER_BASE_URL;
    check("2A default history authority is blockstream.info (proven 28/28 against stored history)",
      btcExplorerBaseUrl() === "https://blockstream.info");
    process.env.BTC_EXPLORER_BASE_URL = "https://esplora.example/";
    check("2A the ONE setting still overrides it (trailing slash trimmed)", btcExplorerBaseUrl() === "https://esplora.example");
    if (saved === undefined) delete process.env.BTC_EXPLORER_BASE_URL; else process.env.BTC_EXPLORER_BASE_URL = saved;
    check("2A Esplora page size is 25", ESPLORA_CHAIN_PAGE_SIZE === 25);

    const pager = (sizes: number[]) => {
      const urls: string[] = [];
      let n = 0;
      const f = (async (u: string) => {
        urls.push(u);
        const size = sizes[urls.length - 1] ?? 0;
        return new Response(JSON.stringify(Array.from({ length: size }, () => receive(`p-${n++}`, 1000))), { status: 200 });
      }) as unknown as typeof fetch;
      return { f, urls };
    };
    for (const [sizes, expectCalls, expectTxs] of [
      [[25, 3], 2, 28],       // the live wallet's shape: was 3 requests
      [[3], 1, 3],            // one short page: one request
      [[25, 25, 0], 3, 50],   // exact multiple: the empty page is genuinely needed
      [[0], 1, 0],            // no history
    ] as Array<[number[], number, number]>) {
      const p = pager(sizes);
      const txs = await fetchAddressTxsRaw(ADDRESS, p.f);
      check(`2A pager ${JSON.stringify(sizes)} ⇒ ${expectCalls} request(s), ${expectTxs} txs`,
        p.urls.length === expectCalls && txs.length === expectTxs, `calls=${p.urls.length} txs=${txs.length}`);
    }
    const p2 = pager([25, 3]);
    await fetchAddressTxsRaw(ADDRESS, p2.f);
    check("2A pager continues from the last txid of a FULL page (cursor unchanged)",
      p2.urls[1]?.endsWith("/txs/chain/p-24") === true, p2.urls[1]);
  }

  // ── Regeneration gate: an unpriced run feeds NO snapshot rebuild ─────────
  {
    const { outcomeRevalued } = await import("./wallet-sync-dispatch");
    const { refreshScheduledWallets } = await import("./wallet-refresh");
    check("gate: ok + PRICED ⇒ revalued", outcomeRevalued({ ok: true, valuation: { status: "PRICED" } }));
    check("gate: ok + UNAVAILABLE ⇒ NOT revalued", !outcomeRevalued({ ok: true, valuation: { status: "UNAVAILABLE", reason: "no close" } }));
    check("gate: failed ⇒ NOT revalued", !outcomeRevalued({ ok: false }));
    check("gate: a chain with no valuation field (ETH/SOL) ⇒ revalued as before", outcomeRevalued({ ok: true }));
    let t = 0;
    const sweep = await refreshScheduledWallets({ now: new Date("2026-09-21T12:00:00Z"), deps: {
      listWallets: async () => [
        { accountId: "priced", chain: "BTC", lastSuccessAt: null },
        { accountId: "unpriced", chain: "BTC", lastSuccessAt: null },
      ],
      sync: async (accountId) => ({ accountId, chain: "BTC", support: "HISTORY_SUPPORTED", ok: true, netWorthParticipation: "LEGACY_BALANCE_COLUMN",
        valuation: accountId === "unpriced" ? { status: "UNAVAILABLE", reason: "no close" } : { status: "PRICED" } }),
      policy: async () => ({ sourceKind: "WALLET", cadence: "EVERY_6H", expectedEveryHours: 6, graceHours: 1, overdueAfterHours: 12, origin: "DEFAULT" } as never),
      admit: async () => ({ decision: "ADMIT" }),
      clock: () => (t += 10),
    } });
    check("sweep: both runs count as succeeded, only the PRICED one feeds regeneration",
      sweep.succeeded === 2 && JSON.stringify(sweep.syncedAccountIds) === JSON.stringify(["priced"]), JSON.stringify(sweep));
  }

  // ── 15 privacy: transport text never carries the URL ──────────────────────
  {
    const { fetchConfirmedSats } = await import("@/lib/crypto/btc-explorer");
    const quoting = (async (u: string) => { throw new TypeError(`request to ${u} failed, reason: ECONNRESET`); }) as unknown as typeof fetch;
    let e: unknown;
    try { await fetchConfirmedSats(ADDRESS, quoting); } catch (x) { e = x; }
    check("15 privacy: a transport that quotes the request URL is redacted to the host",
      e instanceof BtcSyncError && !e.message.includes(ADDRESS) && /network error reaching blockstream\.info: request to blockstream\.info failed/.test(e.message),
      e instanceof Error ? e.message : String(e));
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
