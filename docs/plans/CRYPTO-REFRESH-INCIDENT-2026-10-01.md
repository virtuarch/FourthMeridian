# CRYPTO REFRESH INCIDENT — 2026-10-01

**BTC PARTIAL / ETH + SOL HARD FAILURE — INVESTIGATION ONLY, NO IMPLEMENTATION**

Investigated at `v2.6` / `e750055` (S1 closed). No code, test or DB state was
modified. Live DB access was read-only (`SELECT` only). No application sync was
triggered by this investigation; every sync in the evidence below was the owner
pressing Refresh.

---

## VERDICT (answering item 26 first)

### **BOTH** — and the two halves are cleanly separable.

| | Cause | Evidence |
|---|---|---|
| **ETH + SOL hard failure** | **EXTERNAL INCIDENT.** A high-jitter network path exceeded a 10 s budget on the first and only network call, with zero retries. | Same code, same hosts, same timeouts **SUCCEEDED 7–8 minutes later** (§17). Nothing in the code changed in between. |
| **BTC "couldn't be priced"** | **IMPLEMENTATION DEFECT — P0.** It is not a provider failure at all; it is a self-latching data gap that a BTC sync is structurally incapable of repairing. | Reproduced on *both* BTC runs with 29–36 ms stage duration (a DB read, not a network call), and the archive was repaired only by a *different chain's* successful sync (§9). |
| **BTC 28.4 s** | **BOTH.** External degradation (blockstream.info at 3–20 s, independently measured) amplified by **unnecessary serialization** of two independent stages. | §7, §20. |
| **BTC UI freshness contradiction** | **IMPLEMENTATION DEFECT — P1.** Three different claims read one clock; a fourth is gated on valuation rather than on observation. | §16. |

The headline defect is **not** any of the three visible failures. It is this:

> **Once the crypto `RAW_CLOSE` archive goes more than 7 days stale, a BTC wallet can
> never price itself again — not by Refresh, and not by the 6-hourly cron — because the
> only thing that refreshes that archive runs *only after* a successful valuation.**
> It is a latch, not an outage. In this incident it was broken by a *Solana* sync.

---

## 1. Baseline HEAD / status

```
branch        v2.6
HEAD          e7500550b7b5f3a989ac82f6fa40329b2f847627  (e750055)
origin/v2.6   0 ahead / 0 behind
remote        https://github.com/virtuarch/FourthMeridian.git
```

Untracked, **left untouched** (peer work — the brief forbids modifying them):

```
?? docs/audits/status-drift/STATUS-DRIFT-AUDIT-2026-09-21.md
?? docs/audits/status-drift/STATUS-DRIFT-AUDIT-2026-09-23.md
?? docs/audits/status-drift/STATUS-DRIFT-AUDIT-2026-09-24.md
?? docs/audits/status-drift/STATUS-DRIFT-AUDIT-2026-09-25.md
?? docs/audits/status-drift/STATUS-DRIFT-AUDIT-2026-09-26.md
```

No stash, reset, clean or checkout was performed. This report is the only file added.

Relevant crypto commits reachable from HEAD (newest first): `caf2699` (position
written before history), `493d3a3` (current quote with its own clock), `9c27fc9`
(Esplora history authority), `edfde14` (BTC balance has its own authority),
`1352d4f` (BTC partial sync named), `891458f` (incremental ETH history),
`e94da68` (refresh ledger), `f54a62b` (unified refresh policy).

### ⚠️ Correction to the brief's account IDs

The brief transposes the ETH and SOL account ids. From `FinancialAccount`:

| Account id (prefix) | **Actual** chain | Name |
|---|---|---|
| `cmu2z54c2000…` | **ETH** | Ethereum wallet |
| `cmtafnm9w005…` | **SOL** | Solana Wallet |
| `cmrrmyclf09t…` | BTC | Cold Wallet BTC |

The brief labels `cmu2z54c…` as SOL and `cmtafnm9w…` as ETH. The *timings* in the
brief are still correctly paired with their log lines (§17 reconciles them), so no
conclusion changes — but the ids should be read the other way round.

### ⚠️ Incidental, unrelated to this incident

`PLAID_REDIRECT_URI` is now **present** in `.env.local`. A prior note recorded it
as confirmed unset. Out of scope here; flagged so the Plaid redirect-hardening
backlog is re-checked against reality.

---

## 2. BTC refresh call graph

`POST /api/accounts/[id]/sync` → `app/api/accounts/[id]/sync/route.ts:52`

```
route.ts:58   requireUser()
route.ts:61   limitByUser(… "wallet-resync", 6/hour)       SYSTEM_ADMIN exempt
route.ts:65   db.financialAccount.findUnique               owner-only, 404 otherwise
route.ts:79   isSyncableChain(walletChain)                 400 if UNSUPPORTED
route.ts:91   syncWalletByChain(id, chain, {trigger:"MANUAL"})
              └─ lib/crypto/wallet-sync-dispatch.ts:448
                 runFullRefresh({source:{kind:"WALLET",network:"BTC"}, profile:"WALLET_SYNC"})
                 └─ runner — wallet-sync-dispatch.ts:477
                    ① recorder.begin("WALLET_SYNC","PROVIDER")      :479
                       adapter.sync → syncBtcWallet                 :480 → btc-sync.ts:669
                    ② recordMeasured("VALUATION","DERIVED")         :490   (from adapter clock)
                    ③ recordMeasured("TRANSACTIONS","PROVIDER")     :497   (from adapter clock)
                    ④ refreshCurrentQuotesForChains(["BTC"])        :533   ok only
                    ⑤ refreshWalletHistory(id,"BTC")                :542   ok only
route.ts:95   snapshotAccountsForOutcome(result)           → regenerateSnapshotsForAccounts
route.ts:106  if (outcomeRevalued(result))  ← ★ THE GATE (see §9)
                 chainSupportsHistory → resolveHistoricalWorkWindow
                                      → regenerateWealthHistoryForAccounts
route.ts:153  NextResponse.json(result, {status: result.ok ? 200 : 502})
```

Inside the adapter — `syncBtcWallet`, `lib/crypto/btc-sync.ts:669`, **strictly sequential**:

| # | Stage | file:line | Authority | Fatal? |
|---|---|---|---|---|
| 1 | load account | `btc-sync.ts:673` | DB | FATAL `stage:"load"` |
| 2 | xpub discovery (if xpub) | `:695` | batch provider | FATAL `stage:"discovery"` |
| 3 | address set | `:722` | `ProviderAccountIdentity` | FATAL `stage:"load"` |
| 4 | **confirmed balance** | `:745` → `fetchConfirmedSatsForAddresses` → `btc-explorer.ts:249` | **Esplora `btcBalanceBaseUrl()`** | **FATAL `stage:"balance"`** |
| 5 | coherence check | `:795` | pure | FATAL `stage:"balance"` |
| 6 | **valuation** | `:782` → `canonicalBtcCloseUsd` → `crypto-price-window.ts:120` | **DB price archive — NO network call** | **NON-FATAL** → `UNAVAILABLE` |
| 7 | **position write (spine)** | `:879` `writeBtcObservation` | `PositionObservation` | FATAL `stage:"capture"` |
| 8 | ledger reconcile (before) | `:885` | DB | — |
| 9 | legacy column write | `:924` | `FinancialAccount` | **conditional on price** (§16) |
| 10 | **transaction import** | `:952` `importBtcTransactions` → `fetchAddressTxsRaw` → `btc-explorer.ts:516` | **Esplora `btcExplorerBaseUrl()`** | **NON-FATAL** → `FAILED` |
| 11 | ledger reconcile (after) | `:953` | DB | — |
| 12 | connection spine align | `:992` `alignWalletProviderSpine({markSynced:true})` | `Connection` | non-fatal |

Stage 7 before stage 10 is `caf2699`'s invariant ("the position is written before the
history is fetched"). **It held perfectly in this incident.**

---

## 3. ETH refresh call graph

`ADAPTERS[ETH].sync` → `eth-sync.ts:90` is a one-line delegate to
`syncEvmWallet(accountId, ETH_NETWORK)` — **all orchestration is in
`lib/crypto/evm-native.ts:211-314`**, strictly sequential, no `Promise.all`:

| # | Stage | file:line | Fatal? |
|---|---|---|---|
| 1 | load account | `evm-native.ts:216` | — |
| 2 | chain/deleted/address guard | `:222` | FATAL `stage:"load"` |
| 3 | address shape | `:227` | FATAL `stage:"address"` |
| 4 | resolve RPC URL (dark-path check) | `:235` | FATAL `stage:"config"` — **sub-second** |
| 5 | **`fetchEvmNativeWei` — the ONE network call** (`eth_getBalance`, blockTag `latest`) | `:242`, impl `:137-183` | **FATAL `stage:"balance"`** ← **fails here** |
| 6 | `wei < 0` coherence | `:254` | FATAL |
| 7 | `weiToEth` + finite check | `:261` | FATAL |
| 8 | **`captureWalletPosition`** — the canonical write | `:271-284` | FATAL |
| 9 | capture-gate-off branch | `:286` | FATAL |
| 10 | `financialAccount.update{syncStatus, lastUpdated}` | `:296` | — |
| 11 | `alignWalletProviderSpine` | `:301` | non-fatal |

History is **not** in the adapter. It runs at `wallet-sync-dispatch.ts:542`, gated on
`result.ok`, via `refreshWalletHistory` → `reconstructEthHistory`
(`eth-history-sync.ts:113`).

**`lib/crypto/eth-rpc.ts` is dead code on the live balance path** — `fetchEthWeiBalance`
has no production caller (only `eth-sync.test.ts`). It carries its own duplicate
10 s constant and its own `ETH_SYNC_TIMEOUT_MS` knob. See P2-1.

---

## 4. SOL refresh call graph

`ADAPTERS[SOL].sync` → `syncSolWallet`, `lib/crypto/sol-sync.ts:171-301`, strictly
sequential, no `Promise.all`:

| # | Stage | file:line | Fatal? |
|---|---|---|---|
| 1 | load account + chain guard | `sol-sync.ts:175-186` | FATAL `stage:"load"` |
| 2 | `isSolAddressShape` (pure) | `:188` | FATAL `stage:"address"` |
| 3 | `solRpcUrl()` dark-path check | `:198` | FATAL `stage:"config"` — **sub-second** |
| 4 | **`fetchSolLamports` — the ONE network call** (`getBalance`, commitment `finalized`) | `:208-217`, impl `sol-rpc.ts:290-316` | **FATAL `stage:"balance"`** ← **fails here** |
| 5 | coherence + `lamportsToSol` | `:219-231` | FATAL `stage:"balance"` |
| 6 | **`captureWalletPosition`** | `:240-251` | FATAL (⚠️ mislabels stage — P2-3) |
| 7 | capture-gate-off branch | `:257` | FATAL `stage:"capture"` |
| 8 | `financialAccount.update{syncStatus, lastUpdated}` | `:274-277` | — |
| 9 | `alignWalletProviderSpine` | `:280` | non-fatal |

`SolWalletSyncResult` (`sol-sync.ts:102-129`) has **no `valuation` and no
`transactionImport` field** — SOL has no partial semantics inside the adapter at all.
History runs outside, as for ETH (`sol-history-sync.ts:160` → `acquireSolHistory`).

---

## 5. Provider / authority matrix (as configured at HEAD)

| Dimension | BTC | ETH | SOL |
|---|---|---|---|
| **Current native quantity** | Esplora `GET /api/address/{addr}` → `btcBalanceBaseUrl()`, default **blockstream.info** (`btc-explorer.ts:41,95`) | JSON-RPC `eth_getBalance` → `evmRpcUrl()` = `ETH_RPC_URL` → **Alchemy** (`evm-native.ts:117-121`) | JSON-RPC `getBalance` → `solRpcUrl()` = `SOL_RPC_URL` → **Alchemy** → **Helius** (`sol-rpc.ts:96-104`) |
| **Transaction history** | Esplora `GET /api/address/{addr}/txs/chain` → `btcExplorerBaseUrl()`, default **blockstream.info** (`btc-explorer.ts:40,61,516`) | batched JSON-RPC state reads (`eth_getBalance`/`getTransactionCount`/`getCode`/`getBlockByNumber`/`getBlockReceipts`) via `ethRpcUrl()` (`eth-history.ts:375`) | `getSignaturesForAddress` + `getTransaction` per signature (`sol-history.ts:401-424`) |
| **Current USD price** | `refreshCurrentQuotesForChains` (**`lib/prices/current-quotes.ts:102`**) → **CoinGecko `/simple/price`** → `PriceObservation` basis `INTRADAY`; dispatch call site `:533` | same | same |
| **Historical / valuation USD price** | **`PriceObservation` basis `RAW_CLOSE`, read from the DB** via `readCryptoUsdWindows` (`crypto-price-window.ts:120`), `maxStaleDays = 7` (`:60`). Written by **CoinGecko `/coins/{id}/market_chart/range`** (`coingecko.ts:226,248`) — same vendor as the quote, different endpoint, deliberately (`coingecko.ts:387-391`). The archive **cannot hold today** — `assertClosedDateISO` caps it at yesterday (`lib/prices/config.ts:86-93`). | same reader | same reader |
| **Token balances** | n/a (native only) | native only — no ERC-20 discovery on this path | native only — no SPL discovery on this path |
| **Valuation** | quantity × `RAW_CLOSE` nearest-on-or-before (`btc-sync.ts:658-667`) | priced at read time via `loadWalletCurrentValues` | same |
| **Freshness timestamp** | `PositionObservation.date` (always) + `FinancialAccount.lastUpdated` (**only if priced** — `btc-sync.ts:938`) + `Connection.lastSyncedAt` | `PositionObservation` + `lastUpdated` **unconditional** (`evm-native.ts:298`) | `PositionObservation` + `lastUpdated` **unconditional** (`sol-sync.ts:276`) |
| **Net-worth participation** | `LEGACY_BALANCE_COLUMN` | `WITHHELD_PENDING_CONVERGENCE` | `WITHHELD_PENDING_CONVERGENCE` |
| **Support level** | `HISTORY_SUPPORTED` | `HISTORY_SUPPORTED` | `HISTORY_SUPPORTED` |

> **Note:** the route's own docstring (`route.ts:21-23`) still claims wealth history is
> regenerated "only for a HISTORY_SUPPORTED chain — today BTC alone". All three chains
> are `HISTORY_SUPPORTED` at HEAD. Stale comment, P2-5.

### Where the two observed strings come from — both **server-side**

| String | Origin |
|---|---|
| `blockstream.info did not respond within 10000 ms` | `lib/crypto/btc-explorer.ts:227` — `BtcSyncError(stage, \`${host} did not respond within ${budgetMs} ms\`)`, raised when `controller.signal.aborted`. This is the *deliberate renaming* added so an operator can tell a timeout from a defect. |
| `network error: This operation was aborted` | **SOL:** `lib/crypto/sol-rpc.ts:310`. **ETH:** `lib/crypto/evm-native.ts:166-167`. Both wrap undici's own `AbortError.message` with a `network error: ` prefix. |

Path to the user: thrown → adapter catch → `result.reason` →
`wallet-sync-dispatch.ts:554` → `route.ts:153` 502 body →
`components/dashboard/SyncWalletButton.tsx:50`
`setError(data?.error ?? data?.reason ?? …)` → rendered verbatim.

**There is no client-side timeout.** `SyncWalletButton.tsx:44` issues a plain
`fetch(…, {method:"POST"})` with no `AbortController` and no signal. The abort was
entirely server-side. (So "network error" in the UI is misleading copy — the
browser's network was fine.)

---

## 6. Timeout / retry / fallback matrix

| Path | Constant | Env knob | Value in force | Retries | Fallback host | Fatal? | Blocks position write? |
|---|---|---|---|---|---|---|---|
| BTC balance | `btc-explorer.ts:43` | `BTC_SYNC_TIMEOUT_MS` | **10 000 ms** (unset) | **0 on abort**; 4 on HTTP 429/503, 500 ms × 2ⁿ capped 8 s (`:170-179`) | **none by design** (`:85-93`) | YES | YES |
| BTC history | same wrapper, per page | same | **10 000 ms per page** | same | none | **NO** | **NO** |
| BTC valuation | — | — | **no network call** — DB read, `maxStaleDays = 7` (`crypto-price-window.ts:60`) | — | — | **NO** | NO |
| BTC current quote | `wallet-current-value.ts` | — | **no AbortController** | — | — | **NO** | NO |
| ETH balance | `evm-native.ts:123` | **`EVM_SYNC_TIMEOUT_MS`** | **10 000 ms** (unset) | **0** | none at request time | **YES** | **YES** |
| ETH history | `eth-history.ts:380-388` | — | **NO TIMEOUT AT ALL** (no `signal`) | 6 on `EthThrottleError` only, 300 ms × 2ⁿ (≈18.9 s) | `ethRpcUrl()` adds Etherscan | NO | NO |
| SOL balance | `sol-rpc.ts:63` | `SOL_SYNC_TIMEOUT_MS` | **10 000 ms** (unset) | **0** | resolved once; none at request time | **YES** | **YES** |
| SOL history | `sol-history.ts:233-248` | — | **NO TIMEOUT AT ALL** (no `signal`) | none | none | NO | NO |

Confirmed from `.env.local` (names only): **none** of `BTC_SYNC_TIMEOUT_MS`,
`EVM_SYNC_TIMEOUT_MS`, `ETH_SYNC_TIMEOUT_MS`, `SOL_SYNC_TIMEOUT_MS`,
`BTC_EXPLORER_BASE_URL`, `BTC_BALANCE_API_URL`, `ETH_RPC_URL`, `SOL_RPC_URL` is set.
`ALCHEMY_API_KEY`, `HELIUS_API_KEY`, `COINGECKO_API_KEY`, `ETHERSCAN_API_KEY` **are**
set. So every chain ran at its 10 s default against its default host.

The route exports **no `maxDuration`**; `vercel.json` sets none for it. There is no
platform-level 10 s cutoff — every 10 s boundary observed is application code.

---

## 7. BTC — the 31.5 seconds, accounted for exactly

From `RefreshEndpointResult` for run `5de46659-607f-46da-bd8c-3e17d956e115`
(read-only query). **This is measured, not inferred:**

| Stage | Kind | Status | Started | Duration | Notes |
|---|---|---|---|---|---|
| `WALLET_SYNC` | PROVIDER | SUCCEEDED | 17:10:01.855 | **19 860 ms** | the adapter; contains the two below |
| ↳ *(balance, implied)* | | ok | 17:10:01.855 | **≈ 9 740 ms** | 17:10:11.595 − 17:10:01.855 — **260 ms short of the abort** |
| `VALUATION` | DERIVED | **FAILED** | 17:10:11.595 | **36 ms** | DB read. `no canonical BTC close in the price archive on or before 2026-10-01` |
| `TRANSACTIONS` | PROVIDER | **FAILED** | 17:10:11.647 | **10 006 ms** | `blockstream.info did not respond within 10000 ms` |
| `CURRENT_QUOTE` | PROVIDER | SUCCEEDED | 17:10:21.716 | **8 124 ms** | CoinGecko — **slow but SUCCEEDED**, 1 read / 1 written |
| `HISTORY_BACKFILL` | DERIVED | SUCCEEDED | 17:10:29.840 | **253 ms** | reconstruction, 1 294 rows |

```
  9 740   balance            (blockstream.info, succeeded)
     36   valuation          (DB read, failed)
 10 006   transaction import (blockstream.info, aborted at the 10 s budget)
  8 124   current quote      (CoinGecko, succeeded)
    253   history backfill   (DB-only reconstruction)
───────
 28 159   ≈ RefreshExecution.durationMs = 28 248   (+89 ms ledger/snapshot writes)
        + 3 200   Next.js
───────
 31 448   ≈ the observed 31.5 s
```

**It is not "a provider timeout". It is four sequential waits, three of them network:**

1. The balance read took **9.74 s** — the position survived by **260 ms**.
2. The history import spent its **full 10 s** budget and aborted.
3. The current quote took a further **8.12 s** and **succeeded**.
4. Nothing was retried. The only retry path is HTTP 429/503, and an *abort* throws
   immediately (`btc-explorer.ts:225-228`) — so no retry contributed.

Stages 2 and 3 are **mutually independent and independent of the balance** (§20).

### Independent confirmation that blockstream.info is degraded right now

DIRECT PROVIDER TEST — plain read-only `GET`, a public Satoshi-era address, **not the
user's wallet**, no application state touched:

| Endpoint | Try 1 | Try 2 | Try 3 |
|---|---|---|---|
| `/api/address/1A1zP1…DivfNa` | **10.07 s** | 3.06 s | 3.13 s |
| `/api/address/1A1zP1…DivfNa/txs/chain` | **20.01 s** | 9.47 s | — |
| `/api/blocks/tip/height` (6-byte response) | **12.00 s** | — | — |

A 6-byte tip-height read taking 12 s is unambiguous provider degradation. **The
application's 10 000 ms budget is currently below blockstream.info's own latency for
the endpoints BTC depends on.** That is the external half of this incident, and it is
reproducible on demand.

### Is Blockstream used for balance, history, both, or neither?

**Both** — and that reconciles with the older BTC authority work exactly as documented.
`edfde14` *separated* the two settings (`btcBalanceBaseUrl` vs `btcExplorerBaseUrl`) so
one outage could not be two; `9c27fc9` then moved the **history** default from
mempool.space to blockstream.info on proof (28/28 rows reproduced). The two
**defaults** therefore coincide today, which `btc-explorer.ts:68-78` already states
verbatim: *"That is shared availability, not shared fate."*

That claim is **half true, and this incident shows which half**. Fate is correctly
separated — the history failure did not cost the position. But **availability is
shared, and so is the latency budget**: one degraded host now spends 10 s on history
*and* nearly spent 10 s on balance in the same run. The 260 ms margin is the real
finding.

---

## 8. BTC — the exact history failure

`btc-explorer.ts:197-228`, inside `getJson`, called from `fetchAddressTxsRaw`
(`:516-553`) via `importBtcTransactions` (`btc-sync.ts:952`):

```
197  const controller = new AbortController();
198  const budgetMs = timeoutMs();                      // 10_000, unset env
199  const timer = setTimeout(() => controller.abort(), budgetMs);
…
225  if (controller.signal.aborted) {
227    throw new BtcSyncError(stage, `${host} did not respond within ${budgetMs} ms`);
```

Caught non-fatally at `btc-sync.ts:487-489`, which emits the exact observed log line
and returns `{status:"FAILED", reason, durationMs}`. The dispatch records it as a
FAILED `TRANSACTIONS` stage (`wallet-sync-dispatch.ts:497`), making the execution
`PARTIAL`, and carries it to the banner.

**This is the system working as designed.** The import is "complete-or-throw": a
failed import writes no rows, so the 28 stored movements were untouched. "Existing
history is kept" is literally true.

---

## 9. BTC — the exact valuation failure ⭐ **THE P0**

**This is not a provider failure. No network call was made.** The `VALUATION` stage
took **36 ms** and **29 ms** on the two runs — it is a DB read.

```
btc-sync.ts:658   async function canonicalBtcCloseUsd(now = new Date()) {
btc-sync.ts:660     const todayISO = todayUTCISO(now);                        // "2026-10-01"
btc-sync.ts:661     const window = await readCryptoUsdWindows([BTC_ASSET], todayISO, todayISO);
btc-sync.ts:662     const close = window(BTC_ASSET.assetKey, todayISO);
btc-sync.ts:663     if (close === null || !Number.isFinite(close) || close <= 0) {
btc-sync.ts:664       throw new Error(`no canonical BTC close in the price archive on or before ${todayISO}`);
```

`readCryptoUsdWindows` (`crypto-price-window.ts:120`) reads basis **`RAW_CLOSE`** only,
floored at `fromISO − maxStaleDays` with `DEFAULT_MAX_STALE_DAYS = 7` (`:60`):

```
floorISO = 2026-10-01 − 7 = 2026-09-24
rows     = RAW_CLOSE in [2026-09-24 … 2026-10-01]
```

Live archive at incident time (read-only query, `PriceObservation` ⋈ `Instrument`):

| date | basis | fetchedAt |
|---|---|---|
| 2026-09-19 | RAW_CLOSE | 2026-09-20 17:47:58 |
| **2026-09-20** | **RAW_CLOSE** | 2026-09-21 12:20:39 ← **newest close at 17:10** |
| 2026-09-21 | INTRADAY | 2026-09-21 15:37:40 |
| **2026-09-30** | **RAW_CLOSE** | **2026-10-01 17:17:53** ← **written during this investigation, by SOL's run** |
| 2026-10-01 | INTRADAY | 2026-10-01 17:13:10 |

At 17:10 the newest `RAW_CLOSE` was **2026-09-20 — 11 days old, four days outside the
7-day floor.** The query returned zero rows, `nearestOnOrBefore` returned null, and
the valuation threw. **Exactly reproducible, with no network involved.**

Note the cruel detail: **an `INTRADAY` observation for 2026-10-01 at $84,406 existed
in the archive the whole time.** The reader is `RAW_CLOSE`-only by deliberate design
(one dated authority, never a live quote), so it could not see it.

### The latch — why BTC can never repair this itself

The **only** caller that refreshes crypto `RAW_CLOSE` is inside the **wealth-history
regeneration**:

```
lib/snapshots/regenerate-history.ts:624   backfillHeldInstrumentPrices(heldInstrumentIds, fromDate, toDate)
```

and the sync route reaches it only through this gate:

```
route.ts:106   if (outcomeRevalued(result)) {
route.ts:131     if (chainSupportsHistory(account.walletChain)) try {
route.ts:144       await regenerateWealthHistoryForAccounts([id], …)
```

```
wallet-sync-dispatch.ts:427   export function outcomeRevalued(outcome) {
wallet-sync-dispatch.ts:428     return outcome.ok && outcome.valuation?.status !== "UNAVAILABLE";
```

**The circular dependency, stated plainly:**

- BTC's valuation needs a `RAW_CLOSE` within 7 days.
- The `RAW_CLOSE` backfill runs only inside wealth-history regeneration.
- Wealth-history regeneration runs only when `outcomeRevalued` is true.
- `outcomeRevalued` is false precisely when the valuation was `UNAVAILABLE`.

⇒ **Once the archive crosses 7 days stale, every BTC sync is permanently unpriced.
Pressing Refresh can never fix it. There is no retry, no cron, no fallback that
closes this loop.** This is a latch with no exit on the BTC path.

### The escape hatch — and the proof, to the second

`outcomeRevalued` returns **true** for ETH and SOL *regardless*, because
`SolWalletSyncResult`/the EVM result carry **no `valuation` field at all** —
`undefined !== "UNAVAILABLE"` is true. So a successful ETH or SOL sync *does* run
wealth regeneration, and `backfillHeldInstrumentPrices` prices **every held crypto
instrument, Bitcoin included** — `regenerate-history.ts:611-619`: *"Bitcoin is
included because it is held, not because it is Bitcoin."*

The timestamps corroborate this exactly:

```
17:16:57.263  SOL  WALLET_SYNC       SUCCEEDED   6 860 ms
17:17:04.123  SOL  CURRENT_QUOTE     SUCCEEDED   1 465 ms
17:17:05.588  SOL  HISTORY_BACKFILL  SUCCEEDED  44 123 ms   ← wealth regen
17:17:53.609                                                 ← BTC RAW_CLOSE 2026-09-30 fetchedAt
17:17:55.886                                                 ← SOL RAW_CLOSE 2026-09-30 fetchedAt
17:17:59.605                                                 ← ETH RAW_CLOSE 2026-09-30 fetchedAt
```

**A Solana sync is what repaired Bitcoin's price archive.** BTC's own
`HISTORY_BACKFILL` ran in 253 ms and 242 ms on its two runs and refreshed no prices —
because BTC never reaches the wealth-regen branch while unpriced.

### Residual gap (P1)

Only `2026-09-30` landed. **`2026-09-21` … `2026-09-29` is still a 9-day hole** in the
BTC/ETH/SOL `RAW_CLOSE` archive. BTC valuation now succeeds (09-30 is within 7 days of
10-01), but any historical valuation over that window is unpriced, and the latch will
re-arm the moment the newest close ages past 7 days again.

> **Environment caveat, stated honestly.** This is the local dev DB
> (`localhost:5432/fintracker`), last exercised 2026-09-21, where no cron runs — which is
> *how* the archive went stale here. So the **trigger** is dev-flavoured.
> **The latch is not.** `jobs/sync-crypto.ts` is scheduled 00/06/12/18 UTC in
> production, and it is gated on the *same* `outcomeRevalued` predicate
> (`wallet-refresh.ts:245` → `sync-crypto.ts:109`) — see **P0-2**. A BTC-only holder
> whose archive ever exceeds 7 days stale is latched in production too, and any gap
> longer than 7 days (a CoinGecko outage, a paused cron, a failed deployment, a newly
> connected wallet) arms it identically.

---

## 10. SOL — the exact failure

**`lib/crypto/sol-rpc.ts:296`** — the single `AbortController` guarding
`getBalance`, the **first and only** network call of the whole SOL adapter:

```
63   const DEFAULT_TIMEOUT_MS = 10_000;
295  const controller = new AbortController();
296  const timer = setTimeout(() => controller.abort(), timeoutMs());
302  // method: "getBalance", params: [address, { commitment: "finalized" }]
310  throw new SolRpcError("balance", `network error: ${e instanceof Error ? e.message : String(e)}`);
```

`controller.abort()` → undici throws `DOMException: This operation was aborted` → wrapped
→ caught at `sol-sync.ts:212-216` → `{ok:false, stage:"balance", reason}` → 502.

Measured: `durationMs = 10 028` for the `WALLET_SYNC` stage, `10 070` for the execution.
The ~40 ms remainder is the account load, the `SyncIssue` write and the ledger writes.

**Zero retries. No second host at request time.** `solRpcUrl()` resolves once
(`sol-rpc.ts:96-104`): `SOL_RPC_URL` → Alchemy → Helius. Since the failure was
`stage:"balance"` and not `stage:"config"`, a URL *was* resolved and a host *was*
reached — with `SOL_RPC_URL` unset, that is Alchemy's Solana mainnet endpoint. It
simply did not answer in 10 s.

**Could the quantity have been established first? NO.** The balance read *is* the
failing stage — stage 4 of 9, and the first network call. `captureWalletPosition`
(`sol-sync.ts:240`) is stage 6. There was nothing to discard.

---

## 11. ETH — the exact failure

**`lib/crypto/evm-native.ts:123` via `:153`** — the `AbortController` guarding the
`eth_getBalance` POST at `:156`:

```
123  const DEFAULT_TIMEOUT_MS = 10_000;
125    const n = Number(process.env.EVM_SYNC_TIMEOUT_MS);
152  const controller = new AbortController();
153  const timer = setTimeout(() => controller.abort(), timeoutMs());
166  throw new EthRpcError("balance",
167    redactProviderSecrets(`network error: ${e instanceof Error ? e.message : String(e)}`));
```

Measured: `WALLET_SYNC` stage `10 025 ms`, execution `10 066 ms`, + 1 847 ms Next.js
= the observed 12.0 s.

Elimination proof that no other timeout could be responsible:
- `lib/prices/current-quotes.ts` and the CoinGecko provider contain **no**
  `AbortController` — they cannot produce an abort, and are non-gating anyway.
- `eth-history.ts`'s transport has **no signal**, so it cannot abort — and a history
  failure is non-fatal (`wallet-history-refresh.ts:140-148`), which would have
  returned **200**, not 502.
- `runFullRefresh` adds no timeout and no retry.
- The route exports no `maxDuration`.
- A 502 is returned only when `result.ok === false` (`route.ts:153`) — i.e. the
  adapter itself failed, and the only adapter step that can consume ~10 s is the
  balance fetch.

**Could the quantity have been established first? NO.** Same shape as SOL: the
balance read is stage 5 of 11 and the only network call; `captureWalletPosition` is
stage 8. `evm-native.ts:35-39` states the intent — *"FAILURE IS NEVER A ZERO"*.

---

## 12. Do ETH and SOL share a failing dependency?

**PARTIALLY — and not the one the brief hypothesised.**

They do **not** share a provider *instance* in the sense of one endpoint: ETH hits
`eth-mainnet.g.alchemy.com`, SOL hits `solana-mainnet.g.alchemy.com`. They **do**
share, exactly:

1. **The same vendor and the same credential** — Alchemy, via `alchemy.ts:69-72`,
   keyed by one `ALCHEMY_API_KEY`, because neither `ETH_RPC_URL` nor `SOL_RPC_URL` is
   set. A vendor-wide or account-wide degradation would hit both. *(No evidence of one
   here: both edges answer in 1.5–4.7 s.)*
2. **The same 10 000 ms budget**, the same **zero-retry** policy, and the same
   **all-or-nothing** adapter shape — so an identical transient produces an identical
   total failure on both. **This is the dependency that actually failed.**
3. **The same network path**, which is measurably high-jitter (§18), and **the same
   failure instant**: both executions started within one second (SOL 17:10:01.866,
   ETH 17:10:02.863) and both aborted at ~10 03x ms, with **three concurrent wallet
   syncs in flight** (BTC started 17:10:01.849) competing for that path.

**It was transient, and this is proven rather than inferred:** the same code against
the same hosts with the same timeouts **succeeded 7–8 minutes later** —
SOL `SUCCEEDED` at 17:16:57 (balance in 6 860 ms), ETH `SUCCEEDED` at 17:18:28
(balance in 5 617 ms). Note both were still *slow* (5.6–6.9 s against a 10 s budget),
which is why a transient was enough to tip them over.

---

## 13. Does BTC intersect that dependency?

**NO — DISPROVEN, on three independent grounds.**

1. **BTC's valuation makes no network call.** It is a `PriceObservation` DB read
   (36 ms / 29 ms). It cannot be a provider outage.
2. **BTC's current-quote provider SUCCEEDED in the very same run** —
   `CURRENT_QUOTE` SUCCEEDED, 8 124 ms, 1 read / 1 written, and again at 488 ms on
   the later run. CoinGecko was slow but working throughout. So the shared
   current-price authority **was not failing at all**, and the banner's "couldn't be
   priced" has nothing to do with it.
3. **BTC's providers are different hosts and a different vendor** — Esplora /
   blockstream.info for both balance and history, no Alchemy involvement.

What BTC *does* share with ETH and SOL is **the 10 000 ms budget, the zero-retry policy
and the degraded network path** (§6, §18) — and, independently, **the `RAW_CLOSE`
archive** that all three value against. The archive gap is a *data* dependency, not a
provider one, and its repair path is the latch in §9.

There **is** exactly one shared current-price authority, and the brief was right to
suspect it: CoinGecko `/simple/price` prices BTC, ETH and SOL **in a single HTTP call**
(`coingecko.ts:415,421`; coin ids `bitcoin`/`ethereum`/`solana` at `:126-134`). It is a
genuine single point of intersection — and it **tested 200 with all three prices
correct**, was **never invoked** on the ETH or SOL runs (gated behind `result.ok` at
`wallet-sync-dispatch.ts:533`, and both adapters failed before reaching it), and is
**not on BTC's valuation path at all**. So the one real shared authority is healthy and
exonerated.

**So the brief's shared-current-price-authority hypothesis is DISPROVEN.** There were
**two unrelated faults** on 2026-10-01 that merely coincided:

- **Fault A (external, transient):** a high-jitter network path, against a 10 s budget
  with zero retries, hit by three concurrent syncs at once. blockstream.info is the
  slowest dependency and BTC leans on it twice, which is why BTC came within 260 ms of
  losing its position.
- **Fault B (internal, latched, pre-existing since 2026-09-28):** a `RAW_CLOSE`
  archive 11 days stale with **no BTC-reachable repair path — not even the cron**.
  The arming date is derivable exactly: with the newest close at 2026-09-20 and
  `maxStaleDays = 7`, the walk-back still reached it on 09-27 (floor 09-20) and
  missed it on 09-28 (floor 09-21). **Every BTC refresh from 2026-09-28 onward was
  silently unpriced.**

Fault B would have produced "its USD value couldn't be priced right now" on a perfect
network. It had been true, silently, for days.

---

## 14. Position-write semantics per chain

| | BTC | ETH | SOL |
|---|---|---|---|
| Quantity authority fails | no write, `ok:false`, 502 | no write, `ok:false`, 502 | no write, `ok:false`, 502 |
| Quantity established | **spine write at `btc-sync.ts:879`, BEFORE history** | capture at `evm-native.ts:271` | capture at `sol-sync.ts:240` |
| Valuation fails | **position kept; legacy pair + clock frozen; `PARTIAL`** | n/a — no valuation stage | n/a — no valuation stage |
| History/tx import fails | **non-fatal; `PARTIAL`; prior rows kept** | non-fatal (runs outside adapter) | non-fatal (runs outside adapter) |
| Legacy `balance` column | written **only when priced** (`btc-sync.ts:938`) | never written | never written |
| HTTP on quantity failure | 502 | 502 | 502 |

**The key invariant from the brief holds on all three chains:**

- *"A non-critical history or valuation outage should not make a successfully
  established current position disappear or remain stale."* — **HELD.** BTC's
  `PositionObservation` for 2026-10-01 exists (verified: latest spine date 2026-10-01,
  1 304 rows) despite both the valuation and the history failing.
- *"A failed authoritative quantity lookup must never advance current-position
  freshness."* — **HELD.** ETH and SOL wrote nothing; their `lastUpdated` stayed at
  Sep 21 until the later successful runs.

---

## 15. Freshness timestamp semantics per chain

| Clock | BTC | ETH | SOL |
|---|---|---|---|
| `PositionObservation.date` | today, on any successful quantity read | same | same |
| `FinancialAccount.lastUpdated` | **only when `balanceUsd !== null`** (`btc-sync.ts:938`) | **unconditional** on success (`evm-native.ts:298`) | **unconditional** on success (`sol-sync.ts:276`) |
| `FinancialAccount.nativeBalance` / `balance` | only when priced | never written | never written |
| `Connection.lastSyncedAt` | **unconditional** on a successful *balance* read (`health-transitions.ts:164-166`, via `btc-sync.ts:992`) | same | same |
| `Connection.errorCode` | cleared on success; set by dispatch on failure (`wallet-sync-dispatch.ts:511`) | same | same |

**The asymmetry is the defect surface.** BTC alone suppresses `lastUpdated` when
unpriced — defensibly, because for BTC that column doubles as the legacy USD pair's
valuation instant (`btc-sync.ts:927-937`: advancing it would publish
old-quantity × old-price as fresh). But the *consequence* is that BTC's "Balances"
row and the top-level clock cannot distinguish *"we failed to read the chain"* from
*"we read the chain fine but had no price"*. Those are very different facts.

---

## 16. The BTC UI freshness contradiction — explained

All four lines come from one server-built object, `ConnectionIntelligenceStatus`
(`lib/connections/space-data.ts:211-339`), rendered by
`components/connections/ConnectionCard.tsx`.

| UI line | Exact field | Writer | Why it did / didn't move |
|---|---|---|---|
| **"Hasn't updated since Sep 21"** | `sourceHealth.lastUpdatedAt` = **`minDate([oldest FinancialAccount.lastUpdated, Connection.lastSyncedAt])`** — `space-data-health.core.ts:212`; state from `walletState` `:172-180`; overdue vs the WALLET 6 h cadence (`refresh-policy.core.ts:56,180`) | both below | **Correct, for a surprising reason.** It is the **OLDER** of the two clocks. `Connection.lastSyncedAt` moved to today; `FinancialAccount.lastUpdated` is still Sep 21; `min` = Sep 21 ⇒ `OUT_OF_DATE`. |
| **"Transactions: Updated today"** | `intelligence.lastSyncedAt` (`ConnectionCard.tsx:492`) ← `SyncConnection.lastSyncedAt` ← **`Connection.lastSyncedAt`** (`lib/sync/wallet-connections.ts:39,72`) | `setWalletConnectionHealth(ok:true)` → `{status:ACTIVE, errorCode:null, lastSyncedAt:new Date()}` — `health-transitions.ts:164-166`, reached from `btc-sync.ts:992` | **WRONG — defect D.** `btc-sync.ts:980-1000` stamps the connection *after* the import at `:952` and **never reads `transactionImport.status`**. The field means "a balance sync succeeded" but is labelled `Transactions`. Its own doc (`intelligence.ts:72`) says "last successful transaction acquisition" — true for Plaid, false for a wallet. |
| **"Financial profile: Built today"** | `intelligence.lastReconstructedAt` ← `historySyncedAt` ← for a WALLET with no audit anchor, **`Connection.lastSyncedAt` again** (`space-data.ts:315-321`) | same writer | **WRONG — same root cause.** Nothing was rebuilt: `outcomeRevalued` was false, so the route skipped snapshot *and* wealth-history regen (`route.ts:96-149`). For a ready wallet, "Financial profile: Built" and "Transactions: Updated" are **literally the same timestamp**. |
| **"Balances: Updated on Sep 21"** | `intelligence.balancesUpdatedAt` = **oldest `FinancialAccount.lastUpdated`** (`space-data.ts:270-279, 303-313`) | `btc-sync.ts:924-946` | **Correct-by-design — defect B.** `:938` writes the pair *and the clock* only when `balanceUsd !== null`. Verified live: `Cold Wallet BTC.lastUpdated = 2026-09-21 15:39:29`, `nativeBalance = 0.24060252` unchanged. The fresh quantity went to the spine (`PositionObservation` dated 2026-10-01). |

**So the brief's options resolve as: A + C + D simultaneously, plus B.**

- **(A) the balance really was written but freshness wasn't advanced** — **TRUE**, on
  the spine. The `PositionObservation` for 2026-10-01 exists.
- **(B) valuation failure intentionally prevents balance freshness** — **TRUE**, and
  deliberate (`btc-sync.ts:927-937`). Defensible for the legacy column; it is the
  *reason* the Balances row is honest-but-misleading.
- **(C) the UI reads a different timestamp** — **TRUE**. "Balances" reads
  `FinancialAccount.lastUpdated`; the position it describes lives on
  `PositionObservation`. **The UI has no reader for the spine clock at all** — the
  authoritative current-position freshness is invisible to the card.
- **(D) transaction freshness is incorrectly advanced despite history failure** —
  **TRUE, and this is the correctness bug.** Confirmed: `Connection.lastSyncedAt` was
  stamped today although the import aborted.

**The brief's standard — "A failed history refresh must not say 'Updated today'
unless 'updated' has a precisely defensible meaning" — is NOT met.** There is no
durable timestamp anywhere recording when the transaction import last *succeeded*.
The outcome exists on the result object and reaches the banner, then is discarded.
The card therefore cannot tell a failed import from a successful one, and defaults to
claiming success.

The banner, by contrast, was **completely accurate** — `SyncWalletButton.tsx:57-64`
reads `transactionImport.status === "FAILED"` and `valuation.status === "UNAVAILABLE"`
directly. **The banner and the card disagreed because only the banner had the facts.**

---

## 17. Read-only RefreshExecution / SyncIssue evidence

`RefreshExecution` where `sourceKind='WALLET'` (newest first):

| runId | net | trigger | startedAt | durationMs | status | errorSummary |
|---|---|---|---|---|---|---|
| `d86a03c4…` | ETH | MANUAL | 17:18:28.568 | — | RUNNING→**SUCCEEDED** | |
| `ed435fab…` | SOL | MANUAL | 17:16:57.259 | 52 456 | **SUCCEEDED** | |
| `e4a10c43…` | BTC | MANUAL | 17:15:18.327 | 7 665 | **PARTIAL** | no canonical BTC close in the price archive on or before 2026-10-01 |
| `e5251d9c…` | ETH | MANUAL | 17:10:02.863 | 10 066 | **FAILED** | network error: This operation was aborted |
| `884e1346…` | SOL | MANUAL | 17:10:01.866 | 10 070 | **FAILED** | network error: This operation was aborted |
| `5de46659…` | BTC | MANUAL | 17:10:01.849 | **28 248** | **PARTIAL** | no canonical BTC close in the price archive on or before 2026-10-01 |
| `fbfb0134…` | BTC | MANUAL | 09-21 15:39:24 | 8 116 | SUCCEEDED | |
| `4276ca8d…` | SOL | MANUAL | 09-21 15:39:24 | 12 911 | SUCCEEDED | |
| `71984454…` | BTC | MANUAL | 09-21 13:16:16 | 10 896 | PARTIAL | **mempool.space did not respond within 10000 ms** |
| `e41c2ab4…` | ETH | MANUAL | 09-20 17:47:54 | **169 924** | SUCCEEDED | |

The three 17:10 rows are the incident. The three 17:15–17:18 rows are the owner
retrying **during this investigation** — they are the transience proof. (⚠️ The
17:15+ rows were created by the user pressing Refresh, not by this investigation; no
sync was triggered here.)

Stages for the later runs — every one of them succeeded:

| net | stage | status | duration | rd/wr |
|---|---|---|---|---|
| BTC | WALLET_SYNC | SUCCEEDED | 6 923 | |
| BTC | **VALUATION** | **FAILED** | **29** | *(same archive gap)* |
| BTC | TRANSACTIONS | **SUCCEEDED** | 5 770 | 28 / 0 |
| BTC | CURRENT_QUOTE | SUCCEEDED | 488 | 1 / 1 |
| BTC | HISTORY_BACKFILL | SUCCEEDED | 242 | / 1 294 |
| SOL | WALLET_SYNC | **SUCCEEDED** | 6 860 | |
| SOL | CURRENT_QUOTE | SUCCEEDED | 1 465 | 1 / 1 |
| SOL | HISTORY_BACKFILL | SUCCEEDED | **44 123** | / 1 651 |
| ETH | WALLET_SYNC | **SUCCEEDED** | 5 617 | |
| ETH | CURRENT_QUOTE | SUCCEEDED | 1 468 | 1 / 1 |
| ETH | HISTORY_BACKFILL | SUCCEEDED | **43 784** | / **0** |

Two further findings fall out of this table:

- **BTC's `TRANSACTIONS` succeeded on retry in 5 770 ms** (28 rows read, 0 new) —
  i.e. the work *fits* inside 10 s when the provider is merely slow rather than
  degraded. The 10 s budget is marginal, not wrong by an order of magnitude.
- **ETH's `HISTORY_BACKFILL` spent 43 784 ms to write ZERO rows**, and SOL's spent
  44 123 ms. That is ~85 % of each request's wall-clock, it is non-gating, it holds
  the HTTP connection open, and for ETH it accomplished nothing. P1-3.

`SyncIssue` where `provider='WALLET'` today — **exactly two rows, both from the
incident, both honest**:

```
17:10:12.886  WALLET_SYNC_FAILED  {"chain":"ETH","stage":"balance","message":"network error: This operation was aborted"}
17:10:11.887  WALLET_SYNC_FAILED  {"chain":"SOL","stage":"balance","message":"network error: This operation was aborted"}
```

> ⚠️ **Note: BTC's PARTIAL runs produced NO `SyncIssue` row today.** `btc-sync.ts:785`
> does call `recordWalletSyncIssue(accountId, "price", …)`, so a `price` issue should
> exist for both BTC runs and does not appear in the `provider='WALLET'` set. Either
> it is recorded under a different provider/kind or it was suppressed. Worth one
> check during repair — a latched valuation failure that leaves no incident row is
> exactly the thing that let this go unnoticed for days. (Flagged as P1-4; not
> chased further here to keep the read-only footprint small.)

Live state fingerprint (read-only, taken before any conclusion):

```
FinancialAccount (wallets, not deleted)
  cmrrkzh0l006  BTC  Jane BTC Wallet   0.02        synced  2026-06-09 10:05:00
  cmrrkzh3j00n  BTC  John BTC Wallet   0.038       synced  2026-06-09 10:10:00
  cmrrmyclf09t  BTC  Cold Wallet BTC   0.24060252  synced  2026-09-21 15:39:29.053  ← frozen
  cmu2z54c2000  ETH  Ethereum wallet   0           synced  2026-10-01 17:18:34.168
  cmtafnm9w005  SOL  Solana Wallet     0           synced  2026-10-01 17:17:04.078

PositionObservation (current, per wallet)
  cmrrmyclf09t  BTC  latest 2026-10-01  1304 rows   ← spine DID advance today
  cmu2z54c2000  ETH  latest 2026-10-01  3278 rows
  cmtafnm9w005  SOL  latest 2026-10-01  1657 rows
```

`Cold Wallet BTC.lastUpdated` frozen at Sep 21 while its spine reaches 2026-10-01 is
the freshness contradiction, visible directly in the data.

---

## 18. Safe direct-provider test results

All tests below are **read-only GETs / JSON-RPC reads that cannot mutate application
state**. None is an application sync. No secret was printed; where a key would be
required the test was skipped rather than executed with credentials.

| # | Target | Result |
|---|---|---|
| 1 | `GET blockstream.info/api/address/1A1zP1…DivfNa` ×3 | 200 — **10.07 s**, 3.06 s, 3.13 s |
| 2 | `GET blockstream.info/api/address/1A1zP1…DivfNa/txs/chain` ×2 | 200 — **20.01 s**, 9.47 s |
| 3 | `GET blockstream.info/api/blocks/tip/height` ×2, minutes apart | 200 — **12.00 s**, then **2.72 s** |
| 4 | `GET mempool.space/api/blocks/tip/height` | 200 — 2.67 s |
| 5 | `GET api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,solana&vs_currencies=usd` | 200, **all three prices returned in ONE call** — 0.37 s, then **7.43 s** |
| 6 | Alchemy ETH / SOL edges, no credential | 401 in 1.45 s / 4.73 s — edges reachable |

**Public address `1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa` was used deliberately — it is
not the user's wallet, so no wallet address left this machine in a diagnostic.**
Alchemy's authenticated endpoints were **not** exercised: the key rides in the URL
path, and testing them would have meant handling the secret. The Solana public-RPC
`getHealth` was **skipped** because the code's default host is not public
(`sol-rpc.ts:87-104` refuses `api.mainnet-beta.solana.com` as a default rung).

### Control probes — and the correction they force

| Control | Result |
|---|---|
| `api.github.com` | 200 — 15 s timeout on one run, **1.28 s** on another |
| `cloudflare.com/cdn-cgi/trace` | 200 — 5.21 s, then **0.20 s** |
| `ping 1.1.1.1` ×5 | 0 % loss, min 83 ms / **avg 445 ms** / max **1 012 ms**, **stddev 329 ms** |
| system DNS `blockstream.info` | 3.90 s |

**This changes the characterisation of the external half, and the report must say so.**
My first pass concluded "blockstream.info is degraded". The fuller picture is that
**this machine's network path has severe jitter** — the *same* endpoint measured 12.00 s
and then 2.72 s; CoinGecko measured 0.37 s and then 7.43 s; a cached CDN trace measured
5.21 s and then 0.20 s; and ping shows a 329 ms standard deviation with a 1-second worst
case on an otherwise lossless link.

So the honest external finding is **not** "provider X is down". It is:

> **Under a high-jitter network path, any provider can intermittently exceed a 10 000 ms
> budget — and with zero retries on abort, each such excursion is a total failure.**

That single mechanism explains every external symptom coherently, which no
single-provider-outage theory does:

- all three wallets failing within one second of each other at 17:10 (one jitter
  excursion, **three concurrent requests competing for the same degraded link**);
- all three succeeding 7–8 minutes later with no code change;
- BTC's balance read at 9.74 s then 1.08 s;
- CoinGecko at 8.12 s then 0.49 s;
- blockstream still showing 2.7–20 s on demand.

Blockstream *is* the slowest of the set and BTC is the chain that depends on it twice,
which is why BTC alone came within 260 ms of losing its position. But the shared factor
across ETH, SOL and BTC is **the budget and the absent retry, not a common vendor**.

---

## 19. Is any provider / configuration currently unhealthy?

| Dependency | State | Evidence |
|---|---|---|
| **Network path from this machine** | **DEGRADED — high jitter, ongoing** | ping stddev 329 ms / max 1 012 ms; same endpoints varying 0.2 s → 15 s |
| **blockstream.info** (BTC balance **and** history) | **SLOWEST of the set; intermittently over budget** | 2.7–20 s across runs; 12 s then 2.7 s for the same 6-byte read |
| **Alchemy** (ETH + SOL balance) | **No evidence of a vendor outage** | Edges answer 401 in 1.5–4.7 s; app saw 10 03x ms aborts then 5.6–6.9 s successes |
| **CoinGecko** (current quote **and** archived close) | **Healthy; serves all three chains in ONE call** | 200 with BTC+ETH+SOL prices; 0.37 s then 7.43 s (jitter, not failure); app: 8 124 ms then 488 ms, both SUCCEEDED |
| **`PriceObservation` RAW_CLOSE archive** | **UNHEALTHY — DATA GAP** | Newest close was 09-20 at incident; 09-21…09-29 **still missing** |
| **Configuration** | **Healthy but under-tuned** | Every key present; every timeout at the 10 s default; no override set |
| **Crypto price scheduling** | **Scheduled, but gated behind the latch** | `sync-crypto` 00/06/12/18 UTC + :30 continuation — yet `wallet-refresh.ts:245` gates it on `outcomeRevalued` (P0-2) |
| **CoinGecko transport** | **Unbounded** | `coingecko.ts:419-428` is a bare `fetch` — no `AbortSignal`, no retry, no fallback (P1-7) |

---

## 20. Does the architecture unnecessarily serialize independent calls?

**YES — measurably, and it is the single largest avoidable cost in the BTC run.**

Within `runner` (`wallet-sync-dispatch.ts:477-553`) everything is a bare sequential
`await`. Within each adapter likewise — `Promise.all` appears only *inside* a stage
(BTC balance across addresses at `btc-sync.ts:739`, BTC tx fetch across addresses at
`:434`), never *across* stages.

Genuinely independent pairs that are nonetheless serialized:

| Pair | Independent because | Cost paid in the incident |
|---|---|---|
| `TRANSACTIONS` ↔ `CURRENT_QUOTE` | different vendors (blockstream vs CoinGecko), different outputs, neither reads the other | 10 006 + 8 124 = **18 130 ms serial → ~10 006 ms parallel** |
| `VALUATION` ↔ `TRANSACTIONS` | valuation is a DB read; import is a network write | 36 ms — negligible, but the ordering is arbitrary |
| `CURRENT_QUOTE` ↔ balance | the quote is per-*asset*, not per-wallet | quote waited 9.74 s for a balance it does not use |
| BTC balance across addresses | `fetchConfirmedSatsForAddresses` (`btc-explorer.ts:251`) is a **sequential `for` loop** | not hit (1 address), but an n-address wallet pays n × up to 10 s |

Running the quote concurrently with the import would have cut the BTC run from
**28.2 s to ≈19.9 s — a 29 % reduction with no change to any outcome.** Both stages
already carry their own clocks and their own non-gating semantics, so the refresh
ledger needs no change to represent it.

Worse, `fetchConfirmedSatsForAddresses` is sequential *per address* with a 10 s budget
*per address* and no overall deadline — a 5-address wallet against a degraded
blockstream can spend 50 s in the balance stage alone and still be "working".

SOL history is the extreme case: up to **5 + 5 000 strictly sequential RPC calls**
(`sol-history.ts:401-424`, `DEFAULT_PAGE_BUDGET = 5`, `SIGNATURE_PAGE_LIMIT = 1000`),
one `getTransaction` per signature in a bare `for` loop, no batching, no concurrency,
**and no timeout**.

---

## 21. Is BTC's partial-success behaviour correct?

**YES — it is the best-behaved part of this system, and it is why this incident cost
nothing.** Specifically correct:

- The position was written **before** the history was fetched (`caf2699`), so a 10 s
  history abort could not touch it.
- The valuation failure did **not** gate the quantity — the fresh quantity reached the
  spine, dated today.
- The import is complete-or-throw, so 28 stored movements survived intact.
- The run was reported **PARTIAL**, not SUCCEEDED, with per-stage clocks and reasons in
  the refresh ledger — which is the only reason this investigation could be precise.
- HTTP 200 for a partial is right: a position *was* established.
- The banner told the user exactly the truth, in three sentences, each traceable to a
  typed result field.

**Three corrections, none of which change the shape:**

1. **The partial is not *surfaced* durably.** The stage outcomes live in the ledger and
   the banner, but the connection card reads neither — hence §16. A partial that the
   UI renders as a success is only half a partial.
2. **`PARTIAL` is being used for two very different things.** "History timed out,
   retry will fix it" and "the price archive is latched and retrying can *never* fix
   it" are both `PARTIAL` with a `FAILED` stage. The second needs to be
   non-retryable — the ledger already has `retryable` and `errorCode` columns
   (`schema.prisma`, `RefreshEndpointResult`) and neither is populated here.
3. **The 10 s budget has no headroom and no retry on abort.** Balance survived by
   260 ms. One retry on `AbortError` would have absorbed both the BTC history failure
   and the ETH/SOL failures entirely.

---

## 22. Should ETH / SOL adopt equivalent partial-stage semantics?

**They already have the structural half, and they do not need the rest. The real gap
is elsewhere.**

- **History:** already outside the adapter (`wallet-sync-dispatch.ts:542`, gated on
  `result.ok`), so a history failure *structurally cannot* cost either chain its
  position. They inherit `caf2699`'s invariant for free. **No change needed.**
- **Valuation:** neither chain has a valuation stage, because neither writes a legacy
  USD column — they are priced at *read* time by `loadWalletCurrentValues`. **So
  there is no valuation outage for them to be partial about.** Adding a BTC-shaped
  `valuation` stage would be cargo-culting.
- **Balance:** this is the real gap, and partial semantics **cannot** help it. The
  balance read is the authoritative quantity. If it fails there is, correctly,
  nothing to persist — and `evm-native.ts:35-39`'s *"FAILURE IS NEVER A ZERO"* is
  right to refuse.

**What ETH and SOL actually need is not partial semantics but retry and headroom on
the balance read** — one retry with a fresh controller on `AbortError`/429/5xx would
have turned both 502s into successes, since both succeeded minutes later at 5.6–6.9 s.

**One thing they should adopt from BTC:** `outcomeRevalued` returning **true** for a
chain with *no* valuation field (`undefined !== "UNAVAILABLE"`) is accidental. It
happens to be load-bearing — it is the only reason BTC's archive ever gets repaired
(§9) — which means a correct-looking future change ("only regenerate when we actually
revalued") would silently weld the latch shut forever. **This must be made explicit
before anyone touches that predicate.**

---

## 23. Concrete defects, ranked

### P0

**P0-1 — The crypto price archive is a latch: BTC can never repair its own valuation.**
`route.ts:106` gates wealth regeneration — the **only** `RAW_CLOSE` refresher
(`regenerate-history.ts:624`) — on `outcomeRevalued`
(`wallet-sync-dispatch.ts:428`), which is false exactly when the valuation failed.
Once the archive exceeds `maxStaleDays = 7`, every BTC sync is permanently unpriced
and no amount of retrying helps. Repaired in this incident only by a *Solana* sync.
**Impact:** BTC shows a stale USD value and a stale Balances clock indefinitely;
`outcomeRevalued` false also suppresses snapshot regeneration, so Overview / Wealth /
Liquidity silently stop following the wallet.

**P0-2 — The scheduled sweep is gated on the SAME predicate, so the cron does not break
the latch either.** A crypto cron **does** exist — `jobs/sync-crypto.ts`, registered at
00/06/12/18 UTC with a `sync-crypto-continuation` at :30 (`lib/jobs/registry.ts`,
pinned by `lib/jobs/dispatch.test.ts:109-121`). But:

```
lib/crypto/wallet-refresh.ts:245   if (outcomeRevalued(outcome)) result.syncedAccountIds.push(w.accountId);
jobs/sync-crypto.ts:109            if (result.syncedAccountIds.length > 0) {
jobs/sync-crypto.ts:111              if (wealthRegenerationEnabled()) {   → regenerateWealthHistoryForAccounts
```

An unpriced BTC run is `ok` but **not** `revalued`, so its id never enters
`syncedAccountIds`, so the sweep's wealth regeneration — and with it the only
`RAW_CLOSE` backfill — never runs for it. **The cron escapes the latch only because a
non-BTC wallet also syncs successfully in the same sweep** (ETH/SOL have no `valuation`
field, so `outcomeRevalued` is vacuously true for them) and
`backfillHeldInstrumentPrices` then prices every *held* instrument, Bitcoin included.

⇒ **For a BTC-only holder the latch is absolute, cron or no cron.** That is the
sharpest statement of P0-1, and it is why P0-1 is not merely a dev-environment artifact.

### P1

**P1-1 — `Connection.lastSyncedAt` is one clock serving three incompatible claims.**
Written unconditionally on a successful *balance* read
(`health-transitions.ts:164-166`), then read as "Transactions: Updated"
(`ConnectionCard.tsx:492`) and as "Financial profile: Built" (`:493`). A failed
transaction import is rendered as "Updated today". **There is no durable timestamp
anywhere for a successful transaction import.** Fails the brief's stated correctness
standard.

**P1-2 — Zero retry on `AbortError` on every chain's balance read.** `btc-explorer.ts:225`
(throws before the retry loop), `evm-native.ts:165`, `sol-rpc.ts:310`. The retry loop
that *does* exist covers only HTTP 429/503. One transient slow response = total
failure. Directly caused both 502s.

**P1-3 — ETH and SOL history reconstruction has no timeout at all.** `eth-history.ts:380-388`
and `sol-history.ts:233-248` build transports with **no `signal`**. A hanging host
hangs until the platform kills the request. Measured cost even when healthy:
43 784 ms (ETH, **0 rows written**) and 44 123 ms (SOL) — ~85 % of the request.

**P1-4 — BTC's latched valuation failure left no `SyncIssue` row.** `btc-sync.ts:785`
should record a `price` issue; none appears in today's `provider='WALLET'` set despite
two PARTIAL runs. A permanent failure with no incident row is why this went unnoticed
for ~11 days.

**P1-7 — The CoinGecko transport is unbounded.** `coingecko.ts:419-428` is a bare
`fetch(url, init)` with **no `AbortSignal`, no retry, no fallback vendor** — the only
external call in this subsystem without a 10 s budget. It is non-gating for
correctness, but on the network measured in §18 a hung socket would stall the
`CURRENT_QUOTE` stage indefinitely *inside an otherwise successful sync*, holding the
HTTP request open. It already cost 8 124 ms in the incident run.

**P1-5 — A 9-day hole remains in the archive.** `RAW_CLOSE` for 2026-09-21…2026-09-29 is
still absent for BTC, ETH and SOL. Historical valuation over that window is unpriced,
and the latch re-arms once 09-30 ages past 7 days.

**P1-6 — The UI has no reader for the spine clock.** `PositionObservation.date` is the
authoritative current-position freshness and no connection surface reads it
(`space-data.ts:270-321` reads only `FinancialAccount.lastUpdated` and
`Connection.lastSyncedAt`). The one clock that was correct and current is invisible.

### P2

**P2-1 — ETH timeout-knob split-brain.** `EVM_SYNC_TIMEOUT_MS` (`evm-native.ts:125`)
governs the live ETH balance read; `ETH_SYNC_TIMEOUT_MS` (`eth-rpc.ts:55`) governs only
dead code. Raising the ETH timeout by its obvious name changes nothing.
`lib/crypto/eth-rpc.ts`'s `fetchEthWeiBalance` has no production caller.

**P2-2 — Independent stages serialized.** `CURRENT_QUOTE` waits for `TRANSACTIONS`
(§20): 18.1 s serial where 10.0 s parallel would do. `fetchConfirmedSatsForAddresses`
(`btc-explorer.ts:251`) is a sequential per-address loop with a per-address 10 s budget
and no overall deadline.

**P2-3 — SOL mislabels a capture failure as a balance failure.** `sol-sync.ts:250`
returns `stage:"balance"` while its own `SyncIssue` at `:249` records `"capture"`,
mis-mapping to `BALANCE_UNAVAILABLE` instead of a capture code. The adjacent branch at
`:263-265` was already fixed for this; this one was missed.

**P2-4 — `recordWalletSyncRefusal` can pin a stale diagnosis.** `lib/accounts/wallet-connection.ts:170`
short-circuits when `conn.errorCode !== null`, so a repeat failure never refreshes the
code and an older, different failure's code outlives it.

**P2-5 — Stale route docstring.** `route.ts:21-23` claims history regenerates for "BTC
alone"; ETH and SOL are both `HISTORY_SUPPORTED` at HEAD.

**P2-6 — "network error" is misleading user copy.** The browser's network was fine; the
string is the server's own abort, surfaced verbatim (`SyncWalletButton.tsx:50`). It
reads as "your connection failed".

**P2-7 — `retryable` / `errorCode` unpopulated on wallet stages.** The columns exist on
`RefreshEndpointResult` and would let a latched valuation be distinguished from a
retryable timeout (§21.2).

---

## 24. Minimal repair slices (proposed — not implemented)

Ordered so each is independently shippable and independently provable. **Slice 1 alone
closes the only defect with unbounded, silent, permanent impact.**

**Slice 1 — BREAK THE LATCH (P0-1, P0-2).**
Make the `RAW_CLOSE` refresh reachable from a failed valuation, **on both the manual
route and the scheduled sweep** — they are two call sites of one predicate, and fixing
only the route leaves the cron latched. Smallest honest change: hoist
`backfillHeldInstrumentPrices` out from behind the `outcomeRevalued` gate into its own
non-gating stage that runs on any `ok` sync; or, when BTC's valuation fails *because the
archive is stale*, refresh the archive and re-attempt the valuation **once** inside the
same run. The price archive's freshness should not be a side effect of whether a
*different chain's* wallet happened to sync.
*Must not*: value BTC from an `INTRADAY` quote (that would undo `4752ec2`/`493d3a3`'s
one-dated-authority doctrine), or widen `maxStaleDays` (that hides the gap instead of
closing it).
*Must*: add an explicit comment at `wallet-sync-dispatch.ts:428` recording that
`undefined !== "UNAVAILABLE"` is load-bearing (§22), so the latch cannot be welded shut
by a later tidy-up.

**Slice 2 — ONE RETRY ON ABORT (P1-2).**
A single retry with a fresh `AbortController` on `AbortError`/429/5xx, in all four
provider wrappers (`btc-explorer.ts:193`, `evm-native.ts:137`, `sol-rpc.ts:290`, and
`eth-rpc.ts` if it is not deleted first). On the measured evidence this alone converts
both 502s and the BTC history failure into successes. Pair it with a *total* deadline
so retry cannot multiply the worst case.

**Slice 3 — A TRANSACTION CLOCK THAT MEANS WHAT IT SAYS (P1-1, P1-6).**
Record when the transaction import last *succeeded*, durably and separately from
`Connection.lastSyncedAt`; have the "Transactions" row read it; have "Financial
profile" read a real reconstruction anchor or say nothing. Surface the spine clock so
"Balances" can distinguish *"could not read the chain"* from *"read it, no price"*.

**Slice 4 — BOUND THE UNBOUNDED TRANSPORTS (P1-3, P1-7).**
Also `coingecko.ts:419` — the one external call in the subsystem with no budget at all.
Give `eth-history.ts:380` and `sol-history.ts:233` the same `signal` + `timeoutMs()`
the balance paths have, and an overall budget. Separately: ETH spending 43.8 s to write
0 rows wants a cheap no-op check before the walk.

**Slice 5 — PARALLELIZE THE INDEPENDENT STAGES (P2-2).**
`CURRENT_QUOTE` concurrent with `TRANSACTIONS`; bounded concurrency in
`fetchConfirmedSatsForAddresses`. Both stages already own their clocks, so the ledger
needs no change. ~29 % off the BTC run.

**Slice 6 — THE SMALL TRUTHS (P1-4, P2-1, P2-3…P2-7).**
The missing `price` `SyncIssue`; delete dead `eth-rpc.ts` balance path or unify the
knob; SOL's capture-stage mislabel; the stale `errorCode` short-circuit; the route
docstring; the "network error" copy; populate `retryable`/`errorCode`.

**Explicitly NOT proposed:** raising the 10 s timeouts as the primary fix. The measured
successes ran in 5.6–6.9 s; the budget is marginal, not wrong, and a bigger number
makes a degraded provider hold a request open longer instead of retrying a transient.
Retry (Slice 2) is the right instrument. If a budget change is wanted, it belongs to
the *history* paths, which have no budget at all.

---

## 25. Tests required before implementation

**Slice 1 (the latch) — the whole point is the loop, so the test must be the loop:**
- An archive stale beyond `maxStaleDays` ⇒ a BTC sync **completes priced**, with the
  refresh and the re-attempt visible as their own stage(s). This test must *fail* at
  HEAD — if it passes, it isn't testing the latch.
- A valuation failure for a reason that is **not** staleness (no instrument, provider
  refuses) ⇒ still `PARTIAL`, no infinite re-attempt, and **no fabricated price**.
- Pin that exactly **one** `RAW_CLOSE` authority exists: assert BTC's valuation never
  reads basis `INTRADAY`, with an `INTRADAY` row present for today and no close — the
  precise live shape that produced this incident.
- Pin that `outcomeRevalued` stays true for a chain with no `valuation` field, with the
  reason in the assertion message.
- Pin the `maxStaleDays = 7` boundary at exactly 7 and 8 days — the 09-27/09-28 flip
  above is the real-world instance of that boundary.
- **The same test against the scheduled sweep**, not only the route: a sweep containing
  **only** a BTC wallet whose archive is stale must still end with the archive
  refreshed. At HEAD it does not (`wallet-refresh.ts:245` → `sync-crypto.ts:109`). This
  is the test that proves the cron is unlatched, and it is the one most likely to be
  skipped.

**Slice 2 (retry):**
- One abort then success ⇒ `ok`, exactly 2 attempts, position written, `PROVIDER_TIMEOUT`
  not recorded as a terminal failure.
- Persistent abort ⇒ still fails, attempts bounded, **total** elapsed within the
  overall deadline (guard against retry × timeout multiplication).
- Retry must **not** fire on a deterministic error (bad shape, 404) — those must stay
  one attempt.
- Per chain: BTC balance, BTC history, ETH balance, SOL balance.

**Slice 3 (clocks) — the regression that started this:**
- Successful balance + **failed** import ⇒ the Transactions row does **not** say
  "Updated today". Fails at HEAD.
- Successful balance + successful import ⇒ it does.
- Unpriced-but-read ⇒ the card distinguishes it from could-not-read; assert the two
  render differently.
- "Financial profile" is not the same timestamp as "Transactions" for a wallet.
- The top-level `minDate` composition keeps a deliberate stale clock honest — don't
  let the fix paper over a genuinely stale account.

**Slice 4/5:**
- History transport aborts at its budget rather than hanging (both chains).
- `CURRENT_QUOTE` and `TRANSACTIONS` overlap in time; a failure in either keeps the
  other's outcome and clock intact; the ledger still records two stages with
  independent clocks.
- Bounded concurrency in `fetchConfirmedSatsForAddresses`, and a per-run overall
  deadline for an n-address wallet.

**Cross-cutting, before any slice lands:**
- `npm run ci` (clean copy + throwaway PG, Node 24) — the house gate.
- A **source scan**, as this codebase's idiom requires: assert exactly one `RAW_CLOSE`
  reader for crypto valuation and exactly one `backfillHeldInstrumentPrices` call site,
  so Slice 1 does not create a second price authority.
- No test may hit a live provider. Every provider test goes through the injected
  `fetchImpl` / transport seams these modules already expose.

---

## 26. Verdict

### **BOTH.**

**EXTERNAL INCIDENT — real, ongoing, and proven transient for ETH/SOL.**
The network path from this machine has severe jitter (ping stddev 329 ms, max 1 012 ms;
the *same* endpoints measuring 0.2 s and then 15 s). Against a 10 000 ms budget with
**zero retries on abort**, and with three concurrent syncs competing for that path, each
jitter excursion is a total failure. blockstream.info is the slowest dependency in the
set (2.7–20 s) and BTC depends on it twice. The ETH and SOL 502s are **fully explained
by external latency**: identical code, hosts and timeouts succeeded 7–8 minutes later in
5.6–6.9 s. Nothing about those two failures is an application defect — though the absent
retry is what turned a transient into a 502.

**IMPLEMENTATION DEFECT — and it is the more serious half.**
BTC's *"USD value couldn't be priced right now"* is **not** an outage. It is a 29–36 ms
DB read against a `RAW_CLOSE` archive that was 11 days stale, and the only code that
refreshes that archive sits **behind a gate that a failed valuation closes** — on the
manual route (`route.ts:106`) *and* on the scheduled sweep
(`wallet-refresh.ts:245` → `sync-crypto.ts:109`). That is a latch: a BTC wallet cannot
price itself out of it, ever, and **the 6-hourly cron cannot either**. It was broken, in
this incident, by a **Solana** sync — which is not a repair path anyone designed. Had
the owner held only Bitcoin, the wallet would have stayed unpriced indefinitely, with
snapshot regeneration suppressed, while the card said "synced".

And the UI told the user *"Transactions: Updated today"* about an import that aborted —
because no durable timestamp records a successful import, so the card defaults to
claiming one.

**What the system got right, and should not be disturbed:** BTC's partial-success
architecture did exactly its job. The position was written before the history was
fetched; the valuation failure did not gate the quantity; the fresh quantity is on the
spine dated 2026-10-01; the 28 stored movements are intact; the run was honestly
reported `PARTIAL` with per-stage clocks. Both invariants in the brief **held on all
three chains**. The refresh ledger is the only reason any of this could be stated as
fact rather than hypothesis.

**The incident's real lesson:** a provider outage was loud and self-healing; a data
latch was silent and permanent. The loud one is already handled well. The silent one
has been true for roughly eleven days and surfaced only because an outage happened to
draw attention to the same card.

---

*Investigation only. No code, test or DB state modified. No sync triggered. Read-only
DB access. Provider tests were unauthenticated public reads against a non-user address.
No secrets printed.*
