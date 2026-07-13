/**
 * lib/crypto/btc-sync.test.ts
 *
 * BTC wallet balance sync v1 — unit + source-scan tests.
 *
 * Runnable with the already-installed `tsx`:
 *     npx tsx lib/crypto/btc-sync.test.ts
 * Auto-discovered by scripts/run-tests.ts. No network, no DB, no secrets.
 *
 * PART A exercises the PURE provider layer (lib/crypto/btc-explorer.ts) with an
 * injected `fetch`, so the fetch/parse/convert path is verified fully offline.
 * PART B source-scans the DB-touching modules (which pull @/lib/db and can't
 * import under bare tsx — same constraint the sibling route tests document) for
 * the invariants this slice must not regress.
 */

import { readFileSync } from "fs";
import { join } from "path";
import {
  parseConfirmedSats,
  parseUsdPrice,
  satsToBtc,
  computeUsdBalance,
  fetchConfirmedSats,
  fetchBtcUsdPrice,
  fetchAddressTxCount,
  parseMultiaddrStats,
  fetchAddressStatsBatch,
  normalizeBtcAddressTxs,
  BtcSyncError,
  SATS_PER_BTC,
  type RawBtcTx,
} from "@/lib/crypto/btc-explorer";

let failures = 0;
let passes = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) { passes++; }
  else { failures++; console.log(`[FAIL] ${name}`); if (detail) console.log(`        ${detail}`); }
}
async function throwsAsync(fn: () => Promise<unknown>): Promise<boolean> {
  try { await fn(); return false; } catch { return true; }
}
function read(...seg: string[]): string {
  return readFileSync(join(process.cwd(), ...seg), "utf8");
}
/** strip comments so scans match real code, not prose/doc-comments. */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");
}

// A mempool.space /api/address/{addr} response for the validation address
// 1Cn7RXTTd5aN1ys32GfXVdXUzTyDxdpS1D (funded 59636792, spent 53301678 sats;
// confirmed balance = 6,335,114 sats = 0.06335114 BTC). mempool_stats present
// to prove it is ignored (confirmed-only).
const ADDR_FIXTURE = {
  address: "1Cn7RXTTd5aN1ys32GfXVdXUzTyDxdpS1D",
  chain_stats: { funded_txo_sum: 59636792, spent_txo_sum: 53301678, tx_count: 11 },
  mempool_stats: { funded_txo_sum: 999999, spent_txo_sum: 0, tx_count: 3 },
};
const EXPECTED_SATS = 6335114;
const EXPECTED_BTC = 0.06335114;

const okResponse = (body: unknown) =>
  ({ ok: true, status: 200, json: async () => body }) as unknown as Response;
const failResponse = (status: number) =>
  ({ ok: false, status, json: async () => ({}) }) as unknown as Response;
const stubFetch = (resp: Response) => (async () => resp) as unknown as typeof fetch;

async function main(): Promise<void> {
  // ── PART A — pure provider layer ───────────────────────────────────────────

  check("SATS_PER_BTC is 1e8", SATS_PER_BTC === 100_000_000);

  check("parseConfirmedSats returns confirmed-only sats", parseConfirmedSats(ADDR_FIXTURE) === EXPECTED_SATS,
    `got ${parseConfirmedSats(ADDR_FIXTURE)}`);

  check("satsToBtc converts to BTC", Math.abs(satsToBtc(EXPECTED_SATS) - EXPECTED_BTC) < 1e-12,
    `got ${satsToBtc(EXPECTED_SATS)}`);

  check("parseConfirmedSats throws on missing chain_stats",
    await throwsAsync(async () => parseConfirmedSats({ address: "x" })));
  check("parseConfirmedSats throws on negative balance",
    await throwsAsync(async () => parseConfirmedSats({ chain_stats: { funded_txo_sum: 1, spent_txo_sum: 2 } })));

  check("parseUsdPrice reads USD", parseUsdPrice({ USD: 65000 }) === 65000);
  check("parseUsdPrice throws on missing USD", await throwsAsync(async () => parseUsdPrice({ EUR: 1 })));
  check("parseUsdPrice throws on non-positive USD", await throwsAsync(async () => parseUsdPrice({ USD: 0 })));

  check("computeUsdBalance rounds to cents",
    computeUsdBalance(EXPECTED_BTC, 65000) === 4117.82,
    `got ${computeUsdBalance(EXPECTED_BTC, 65000)}`);

  // Offline fetch path (injected fetch) — no network.
  const sats = await fetchConfirmedSats("1Cn7RXTTd5aN1ys32GfXVdXUzTyDxdpS1D", stubFetch(okResponse(ADDR_FIXTURE)));
  check("fetchConfirmedSats (injected fetch) returns confirmed sats", sats === EXPECTED_SATS, `got ${sats}`);

  const price = await fetchBtcUsdPrice(stubFetch(okResponse({ USD: 65000, EUR: 60000 })));
  check("fetchBtcUsdPrice (injected fetch) returns USD", price === 65000, `got ${price}`);

  // Explorer / price failure → typed, staged BtcSyncError (drives honest SyncIssue).
  let balErr: unknown;
  try { await fetchConfirmedSats("addr", stubFetch(failResponse(500))); } catch (e) { balErr = e; }
  check("balance HTTP failure throws BtcSyncError stage=balance",
    balErr instanceof BtcSyncError && balErr.stage === "balance");

  let priceErr: unknown;
  try { await fetchBtcUsdPrice(stubFetch(failResponse(503))); } catch (e) { priceErr = e; }
  check("price HTTP failure throws BtcSyncError stage=price",
    priceErr instanceof BtcSyncError && priceErr.stage === "price");

  // ── PART B — source-scan invariants on the DB-touching modules ──────────────

  const explorer = code(read("lib", "crypto", "btc-explorer.ts"));
  check("explorer stays pure (no @/lib/db import)", !explorer.includes("@/lib/db"));
  check("explorer stays pure (no next/* import)", !/from\s+["']next\//.test(explorer));

  const sync = code(read("lib", "crypto", "btc-sync.ts"));
  check("sync writes syncStatus (synced when complete, pending while discovering)",
    /syncStatus:\s*discoveryComplete \? "synced" : "pending"/.test(sync));
  check("sync materializes nativeBalance + balance", sync.includes("nativeBalance") && /balance:\s*balanceUsd/.test(sync));
  check("sync never flips to 'error'", !/syncStatus:\s*["']error["']/.test(sync));
  // Inspect the persist step specifically: the update's data must not touch
  // deletedAt (a `deletedAt: true` in the read `select` is fine and expected).
  const updateBlock = (sync.match(/financialAccount\.update\(\{[\s\S]*?\}\);/) || [""])[0];
  check("sync's balance write does not touch deletedAt (preserve visibility)",
    updateBlock.length > 0 && !/deletedAt/.test(updateBlock), updateBlock ? undefined : "update() block not found");
  check("sync never touches SpaceAccountLink", !/spaceAccountLink/i.test(sync));
  check("sync records SyncIssue provider=WALLET, reusing UPSERT_ERROR kind",
    /provider:\s*["']WALLET["']/.test(sync) && sync.includes("SyncIssueKind.UPSERT_ERROR"));
  check("sync records an issue on both balance and price failure",
    (sync.match(/recordWalletSyncIssue\(/g) || []).length >= 3); // 1 def + 2 call sites
  check("sync guards to BTC only", sync.includes("walletChain !== BTC_CHAIN"));
  // (v4: xpub is now IN scope for sync — the former "no xpub" guard is retired.)

  const job = code(read("jobs", "sync-crypto.ts"));
  check("job body delegates to syncAllBtcWallets", job.includes("syncAllBtcWallets"));

  const registry = code(read("lib", "jobs", "registry.ts"));
  check("sync-crypto is NOT registered in the daily cron (deferred; manual/run-on-add)",
    !registry.includes("sync-crypto"));

  const manual = code(read("app", "api", "accounts", "[id]", "sync", "route.ts"));
  check("manual route authenticates", manual.includes("requireUser"));
  check("manual route is owner-only", /ownerUserId\s*!==\s*user\.id/.test(manual));
  check("manual route is BTC-only", manual.includes("BTC_CHAIN"));
  check("manual route runs the sync", manual.includes("syncBtcWallet("));

  const walletRoute = code(read("app", "api", "accounts", "wallet", "route.ts"));
  check("wallet route runs balance sync on add (run-on-add)", walletRoute.includes("syncBtcWallet("));
  // No Transaction-model usage / import (the `db.$transaction` atomic wrapper is
  // unrelated and allowed — hence the capital-T model-name boundary check).
  check("wallet route creates/imports no transactions",
    !/\bTransaction\b/.test(walletRoute) && !/\.transaction\.create/.test(walletRoute));

  // ── PART C — manual sync affordance + active-dup backend correction ─────────

  // Backend correction: the active-duplicate re-add branch now syncs too, so
  // an already-existing BTC wallet has an automatic trigger. All three branches
  // (active-dup, reactivate, new-create) must call syncBtcWallet.
  check("wallet route syncs on re-add of an existing wallet (active-dup branch)",
    walletRoute.includes("syncBtcWallet(activeFa.id)"));
  check("wallet route syncs on all three branches",
    (walletRoute.match(/syncBtcWallet\(/g) || []).length >= 3);

  // AccountCard was retired with the standalone /dashboard/accounts page; the
  // live surface that renders the wallet sync affordance is now ConnectionCard
  // (its WalletActions), gated to WALLET-provider connections.
  const connCard = code(read("components", "connections", "ConnectionCard.tsx"));
  check("ConnectionCard renders SyncWalletButton", connCard.includes("SyncWalletButton"));
  check("ConnectionCard gates the sync button to wallet connections",
    /provider\s*!==\s*["']WALLET["']/.test(connCard));

  const btn = code(read("components", "dashboard", "SyncWalletButton.tsx"));
  check("SyncWalletButton is a client component", btn.includes('"use client"') || btn.includes("'use client'"));
  check("SyncWalletButton POSTs to the manual sync route",
    btn.includes("/api/accounts/${accountId}/sync") && /method:\s*["']POST["']/.test(btn));
  check("SyncWalletButton has a loading state", btn.includes("setLoading") && btn.includes("Loader2"));
  check("SyncWalletButton refreshes on success", btn.includes("router.refresh()"));
  check("SyncWalletButton shows an inline error on failure", btn.includes("setError"));
  check("SyncWalletButton label: pending -> 'Sync wallet', else 'Refresh'",
    /syncStatus\s*===\s*["']pending["']/.test(btn) && btn.includes("Sync wallet") && btn.includes("Refresh"));

  // ── PART D — Wallet Provider v2: BTC as a Holding ────────────────────────────
  check("sync upserts a BTC Holding on the (financialAccountId, symbol) key",
    /holding\.upsert/.test(sync) && /financialAccountId_symbol/.test(sync) && /symbol:\s*BTC_SYMBOL/.test(sync));
  check("BTC Holding value mirrors the account balance (no double count)",
    /value:\s*amounts\.balanceUsd/.test(sync));
  check("BTC Holding carries native-BTC quantity, price, and USD currency",
    /quantity:\s*amounts\.nativeBalance/.test(sync) && /price:\s*amounts\.priceUsd/.test(sync) && /currency:\s*["']USD["']/.test(sync));
  check("BTC Holding write is best-effort (never fails the sync)",
    /writeBtcHolding/.test(sync) && /catch/.test(sync));
  check("sync still writes transitional FinancialAccount.balance/nativeBalance",
    /financialAccount\.update/.test(sync) && /balance:\s*balanceUsd/.test(sync) && /nativeBalance/.test(sync));

  // ── PART E — Wallet Provider v3: BTC transaction normalization ───────────────

  const MY = "1MyWalletAddrXXXXXXXXXXXXXXXXXXXXX";
  const receiveTx: RawBtcTx = {
    txid: "aaa",
    vin:  [{ prevout: { scriptpubkey_address: "1Sender", value: 100000 } }],
    vout: [{ scriptpubkey_address: MY, value: 90000 }, { scriptpubkey_address: "1SenderChange", value: 9000 }],
    fee:  1000,
    status: { confirmed: true, block_time: 1700000000 },
  };
  const sendTx: RawBtcTx = {
    txid: "bbb",
    vin:  [{ prevout: { scriptpubkey_address: MY, value: 200000 } }],
    vout: [{ scriptpubkey_address: "1Recipient", value: 150000 }, { scriptpubkey_address: MY, value: 49000 }],
    fee:  1000,
    status: { confirmed: true, block_time: 1700000100 },
  };
  const consolidateTx: RawBtcTx = {
    txid: "ccc",
    vin:  [{ prevout: { scriptpubkey_address: MY, value: 50000 } }],
    vout: [{ scriptpubkey_address: MY, value: 49000 }],
    fee:  1000,
    status: { confirmed: true, block_time: 1700000200 },
  };
  const pendingReceive: RawBtcTx = { ...receiveTx, txid: "ddd", status: { confirmed: false } };

  const mv = normalizeBtcAddressTxs([receiveTx, sendTx, consolidateTx, pendingReceive], [MY]);
  const byId = (id: string) => mv.filter((m) => m.externalId === id);

  // Receive → INCOME / INFLOW, positive BTC, POSTED, sender as counterparty.
  const rcv = byId("aaa")[0];
  check("receive → INCOME/INFLOW positive amount, POSTED",
    !!rcv && rcv.flowType === "INCOME" && rcv.flowDirection === "INFLOW" &&
    Math.abs(rcv.amountBtc - 0.0009) < 1e-12 && rcv.settlement === "POSTED");
  check("receive counterparty = external sender", !!rcv && rcv.counterpartyAddresses.includes("1Sender"));

  // Outbound principal → INVESTMENT/INTERNAL (asset conversion, NOT spending) + FEE sibling.
  const send = byId("bbb")[0];
  const fee  = byId("bbb:fee")[0];
  check("outbound principal → INVESTMENT/INTERNAL negative amount (to-others only, change nets out)",
    !!send && send.flowType === "INVESTMENT" && send.flowDirection === "INTERNAL" &&
    Math.abs(send.amountBtc + 0.0015) < 1e-12);
  check("outbound principal is never SPENDING or INCOME (doctrine)",
    !!send && send.flowType !== "SPENDING" && send.flowType !== "INCOME");
  check("fee mapping unchanged → FEE/OUTFLOW negative, externalId `${txid}:fee`",
    !!fee && fee.flowType === "FEE" && fee.role === "FEE" && fee.flowDirection === "OUTFLOW" &&
    Math.abs(fee.amountBtc + 0.00001) < 1e-12);

  // Consolidation (nothing sent out) → fee-only.
  check("self-consolidation → fee-only movement",
    byId("ccc").length === 0 && byId("ccc:fee").length === 1);

  // Settlement mapping.
  check("unconfirmed → settlement PENDING", byId("ddd")[0]?.settlement === "PENDING");

  // ── Source-scan the engine import path ──────────────────────────────────────
  check("engine imports transactions via the pure normalizer",
    sync.includes("importBtcTransactions") && sync.includes("normalizeBtcAddressTxs"));
  check("import is idempotent: dedupes on existing externalTransactionId before createMany",
    /transaction\.findMany/.test(sync) && /externalTransactionId/.test(sync) &&
    /new Set\(/.test(sync) && /transaction\.createMany/.test(sync));
  check("transactions are stored as normal Transaction rows in BTC currency",
    /currency:\s*["']BTC["']/.test(sync));
  check("internal-transfer resolution via ProviderAccountIdentity + counterpartyAccountId",
    /providerAccountIdentity\.findMany/.test(sync) && /counterpartyAccountId/.test(sync) &&
    /FlowDirection\.INTERNAL/.test(sync));
  check("no BTC-specific transaction table (writes db.transaction, not a db.*Transaction table)",
    !/db\.(btcTransaction|walletTransaction|cryptoTransaction)/i.test(sync) && /db\.transaction\.createMany/.test(sync));
  check("transaction import is best-effort (never fails the sync)",
    /importBtcTransactions[\s\S]*?catch/.test(sync));

  // ── PART F — Wallet Provider v4: xpub / multi-address ────────────────────────

  // Multi-address normalization: a transfer between two of the wallet's OWN
  // addresses (A → B, with change) nets out — no phantom send, fee-only.
  const A = "1AaaMyWalletAddrXXXXXXXXXXXXXXXXX";
  const B = "1BbbMyWalletAddrXXXXXXXXXXXXXXXXX";
  const ownToOwn: RawBtcTx = {
    txid: "eee",
    vin:  [{ prevout: { scriptpubkey_address: A, value: 200000 } }],
    vout: [{ scriptpubkey_address: B, value: 150000 }, { scriptpubkey_address: A, value: 49000 }],
    fee:  1000,
    status: { confirmed: true, block_time: 1700000300 },
  };
  const multi = normalizeBtcAddressTxs([ownToOwn], [A, B]);
  check("multi-address: own→own transfer nets out (fee-only)",
    multi.filter((m) => m.externalId === "eee").length === 0 &&
    multi.filter((m) => m.externalId === "eee:fee").length === 1);
  // Same tx seen from only ONE address would look like a real send — proving the
  // full address set matters.
  const single = normalizeBtcAddressTxs([ownToOwn], [A]);
  check("single-address view of the same tx IS an outbound principal (justifies aggregation)",
    single.some((m) => m.externalId === "eee" && m.flowType === "INVESTMENT"));

  // ── Source-scan the v4 engine ───────────────────────────────────────────────
  check("sync resolves addresses through ProviderAccountIdentity (canonical table)",
    /getWalletAddresses/.test(sync) && /providerAccountIdentity\.findMany/.test(sync));
  check("balance is SUMMED across all addresses",
    sync.includes("fetchConfirmedSatsForAddresses") || /reduce\(\(s, x\) => s \+ x/.test(sync));
  check("xpub discovery is bounded + resumable (batch, checkpoint, no one-shot scan)",
    sync.includes("discoverXpubStep") && sync.includes("fetchAddressStatsBatch") &&
    /cursor:\s*JSON\.stringify/.test(sync) && /stepPerBranch/.test(sync) &&
    /parseExtendedKey/.test(sync) && /deriveAddressAt/.test(sync));
  check("partial xpub → pending, complete → synced (honest status)",
    /discoveryComplete \? "synced" : "pending"/.test(sync));
  check("tx import is bounded per run (behemoth-safe)",
    /BTC_TX_ADDR_CAP/.test(sync) && /addresses\.slice\(0, txAddrCap\)/.test(sync));
  check("xpub balance uses the batch provider (not per-address probing)",
    /fetchAddressStatsBatch\(addresses/.test(sync) || /batchStatsFetcher\(addresses\)/.test(sync));
  check("discovery writes per-address identities via the KEPT composite unique (not dualWrite)",
    /providerAccountIdentity\.upsert/.test(sync) &&
    /provider_externalAccountId_financialAccountId/.test(sync) &&
    !sync.includes("dualWriteProviderAccountIdentity"));
  check("xpub path stamps sync WITHOUT creating a PAI for the descriptor",
    /isXpub && connection/.test(sync) && sync.includes("touchWalletConnectionStatus"));
  check("raw txs deduped by txid across addresses before normalization",
    sync.includes("dedupeRawTxsByTxid"));
  check("one Holding + one balance write regardless of address count",
    (sync.match(/holding\.upsert/g) || []).length === 1 &&
    (sync.match(/financialAccount\.update/g) || []).length === 1);

  // ── Schema + migration: the approved constraint drop ────────────────────────
  const schema = read("prisma", "schema.prisma");
  check("schema dropped @@unique([provider, financialAccountId])",
    !/@@unique\(\[provider, financialAccountId\]\)/.test(schema));
  check("schema keeps the composite unique that blocks duplicate addresses",
    /@@unique\(\[provider, externalAccountId, financialAccountId\]\)/.test(schema));
  const migration = read("prisma", "migrations", "20260709231500_v4_xpub_drop_provider_identity_account_unique", "migration.sql");
  check("migration drops the exact index",
    /DROP INDEX "ProviderAccountIdentity_provider_financialAccountId_key"/.test(migration));

  // ── PART G — xpub onboarding reliability (rate limits + required discovery) ──

  process.env.BTC_RATE_LIMIT_BACKOFF_MS = "1"; // near-instant retries for the test

  const rl429 = (): Response =>
    ({ ok: false, status: 429, headers: { get: () => null }, json: async () => ({}) }) as unknown as Response;

  // 429 twice, then 200 → fetchAddressTxCount backs off and eventually succeeds.
  let calls = 0;
  const flaky: typeof fetch = (async () => {
    calls += 1;
    return calls <= 2 ? rl429() : okResponse({ chain_stats: { tx_count: 3 }, mempool_stats: { tx_count: 0 } });
  }) as unknown as typeof fetch;
  const txc = await fetchAddressTxCount("addr", flaky);
  check("429 backoff: retries then succeeds", txc === 3 && calls === 3, `calls=${calls} txc=${txc}`);

  // Persistent 429 → a rate-limited BtcSyncError (callers surface a useful state).
  const always: typeof fetch = (async () => rl429()) as unknown as typeof fetch;
  let rlErr: unknown;
  try { await fetchAddressTxCount("addr", always); } catch (e) { rlErr = e; }
  check("persistent 429 → rate-limited BtcSyncError",
    rlErr instanceof BtcSyncError && /rate limit/i.test((rlErr as Error).message));

  // Engine: discovery is REQUIRED — a failure with zero addresses must not
  // proceed as success; it returns stage "discovery", records a SyncIssue, and
  // sets the Connection error (→ card shows error, not "importing").
  check("xpub discovery failure returns stage 'discovery' (not proceeding as success)",
    /stage:\s*"discovery"/.test(sync) && sync.includes('recordWalletSyncIssue(accountId, "discovery"'));
  check("discovery failure sets Connection error (RATE_LIMITED) + records issue",
    /touchWalletConnectionStatus\(\{[\s\S]*?ok:\s*false/.test(sync) && /RATE_LIMITED/.test(sync));
  check("discovery failure returns a useful, non-generic reason (not 'no addresses')",
    /rate-limiting requests/.test(sync) && /Address discovery failed/.test(sync));
  check("manual/no-address xpub reruns discovery BEFORE resolving addresses",
    sync.indexOf("discoverXpubStep({ financialAccountId: accountId") <
      sync.indexOf("let addresses = await getWalletAddresses"));
  check("gap limit + per-run step are configurable (deps + env)",
    /deps\.gapLimit/.test(sync) && /BTC_XPUB_GAP_LIMIT/.test(sync) &&
    /deps\.stepPerBranch/.test(sync) && /BTC_XPUB_STEP/.test(sync));

  // ── PART I — partial-progress status fix + failure-mode differentiation ──────
  // Part A: partial PROGRESS must CLEAR a stale errorCode (card shows discovering,
  // not the old sync error) while staying pending (not marked ready).
  check("partial xpub progress clears stale errorCode (discovering, not error)",
    sync.includes("clearWalletConnectionError(connection.id)"));
  check("only COMPLETE discovery marks ready + mirrors AccountConnection",
    sync.includes("touchWalletConnectionStatus({ connectionId: connection.id, ok: true })") &&
    sync.includes("markWalletAccountConnectionSynced"));
  check("discovery step reports cumulative used-count (drives zero-used detection)",
    /usedCount:\s*next\.used/.test(sync) && /usedCount = step\.usedCount/.test(sync));
  // Part C: four distinct failure modes.
  check("zero-used valid key → NO_USED_ADDRESSES guidance (not a sync error)",
    /discoveryComplete && usedCount === 0/.test(sync) && /NO_USED_ADDRESSES/.test(sync));
  check("malformed key → INVALID_XPUB reject; network/rate → retryable codes",
    /INVALID_XPUB/.test(sync) && /malformed/.test(sync) &&
    /DISCOVERY_FAILED/.test(sync) && /RATE_LIMITED/.test(sync));
  check("malformed reason is distinct from the network/timeout reason",
    /valid extended public key/.test(sync));

  // Part B: the wallet route normalizes a Ledger JSON / xpub before use so the
  // user never picks a derivation path.
  check("wallet route normalizes descriptor input (Ledger JSON / xpub) before use",
    /normalizeExtendedKeyInput/.test(walletRoute) && /walletValue/.test(walletRoute));

  // Run-on-add: the Connection spine is aligned BEFORE syncBtcWallet, so a fresh
  // xpub's discovery has a Connection to read the descriptor from.
  check("run-on-add aligns Connection before syncBtcWallet (xpub discovery has a Connection)",
    walletRoute.indexOf("alignWalletProviderSpine({ userId, financialAccountId: fa.id") <
      walletRoute.indexOf("await syncBtcWallet(fa.id)"));

  // ── PART H — batch stats provider (multiaddr) ────────────────────────────────
  const multiaddrFixture = {
    addresses: [
      { address: "A1", n_tx: 3, final_balance: 500000 },
      { address: "A2", n_tx: 0, final_balance: 0 },
      // "A3" omitted by the provider (no activity) → must default to zeros.
    ],
  };
  const mstats = parseMultiaddrStats(multiaddrFixture, ["A1", "A2", "A3"]);
  check("parseMultiaddrStats: used address → txCount + sats",
    mstats.get("A1")?.txCount === 3 && mstats.get("A1")?.sats === 500000);
  check("parseMultiaddrStats: omitted/zero address defaults to zero (entry always present)",
    mstats.has("A3") && mstats.get("A3")?.txCount === 0 && mstats.get("A2")?.sats === 0);

  let batchCalls = 0;
  const batchFetch: typeof fetch = (async () => { batchCalls += 1; return okResponse(multiaddrFixture); }) as unknown as typeof fetch;
  const batched = await fetchAddressStatsBatch(["A1", "A2", "A3"], batchFetch);
  check("fetchAddressStatsBatch: ONE request per chunk (vs one-per-address)",
    batchCalls === 1 && batched.get("A1")?.sats === 500000);

  // ── Summary ─────────────────────────────────────────────────────────────────
  console.log(`\nbtc-sync: ${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error("btc-sync test crashed:", e);
  process.exit(1);
});
