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
  check("sync writes syncStatus 'synced' on success", /syncStatus:\s*["']synced["']/.test(sync));
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
  // v3: BTC transactions are now IN scope for sync; xpub remains out.
  check("sync stays in v3 scope: no xpub", !/xpub/i.test(sync));

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

  const card = code(read("components", "dashboard", "AccountCard.tsx"));
  check("AccountCard renders SyncWalletButton", card.includes("SyncWalletButton"));
  check("AccountCard gates the sync button to crypto wallet-backed accounts",
    /type\s*===\s*["']crypto["']/.test(card) && card.includes("walletAddress"));

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

  const mv = normalizeBtcAddressTxs([receiveTx, sendTx, consolidateTx, pendingReceive], MY);
  const byId = (id: string) => mv.filter((m) => m.externalId === id);

  // Receive → INCOME / INFLOW, positive BTC, POSTED, sender as counterparty.
  const rcv = byId("aaa")[0];
  check("receive → INCOME/INFLOW positive amount, POSTED",
    !!rcv && rcv.flowType === "INCOME" && rcv.flowDirection === "INFLOW" &&
    Math.abs(rcv.amountBtc - 0.0009) < 1e-12 && rcv.settlement === "POSTED");
  check("receive counterparty = external sender", !!rcv && rcv.counterpartyAddresses.includes("1Sender"));

  // Send → SPENDING/OUTFLOW (amount = to-others, negative) + a FEE sibling.
  const spend = byId("bbb")[0];
  const fee   = byId("bbb:fee")[0];
  check("send → SPENDING/OUTFLOW negative amount (to-others only, change nets out)",
    !!spend && spend.flowType === "SPENDING" && spend.flowDirection === "OUTFLOW" &&
    Math.abs(spend.amountBtc + 0.0015) < 1e-12);
  check("fee mapping → FEE/OUTFLOW negative, externalId `${txid}:fee`",
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

  // ── Summary ─────────────────────────────────────────────────────────────────
  console.log(`\nbtc-sync: ${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error("btc-sync test crashed:", e);
  process.exit(1);
});
