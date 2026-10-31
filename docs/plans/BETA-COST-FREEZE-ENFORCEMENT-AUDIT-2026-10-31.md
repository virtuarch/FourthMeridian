# Beta lifecycle / Cost Freeze enforcement audit (2026-10-31)

> **Status (added at commit, 2026-10-31):** this is the PRE-FIX audit of #162 @ `1487076`. The gaps it lists were closed by #169 (`bc2e8ae`) and #174 (`2fe9e38`), which two independent reviews confirmed. It is kept as the call-site map and the rationale behind those fixes. Current state: docs/plans/OVERNIGHT-2026-10-31-SESSION2-HANDOFF.md §4.

**Scope.** A read-only audit of PR #162 (`feat/beta-lifecycle-evaluator` @ `1487076`). It maps every server-side code path that can cause a third-party cost and checks whether the Beta lifecycle / Cost Freeze gate covers it. The code was read from a `git archive` snapshot of `1487076`. No code was changed, no database was touched and no provider was called.

**Standard applied.** A path counts as PROTECTED only when all four of these hold:

1. the lifecycle check runs **before** the first provider call;
2. it **fails closed** when the policy cannot be read (UNKNOWN / POLICY_UNAVAILABLE);
3. Cost Freeze **beats** the Founder overlay, any per-group overlay and the per-customer AI allowance override;
4. a refusal writes **no completion state**: no cooldown is used up, no lock or claim is left behind, no `lastSyncedAt` or checkpoint moves, and connection status is unchanged.

---

## 0. Headline findings

1. **`assertBillableAllowed` / `billableAllowedForUsers` have no production caller.** `lib/entitlements/billable-gate.ts:26` says so itself ("NOT WIRED YET (L1): no route or job calls this module"). `git grep` confirms it: the only references are the module, its core and tests. `getBetaLifecycleState` is likewise unused outside its own module and tests (it is meant for invitation issuance).
2. **The lifecycle is enforced only through the entitlement resolver**, via `refuseIfFailClosed` (alias `refuseIfBillableRestricted`), `refuseIfDisabled`, `countLimit` and `isManualRefreshEntitled`. Seven customer or operator request paths use it, plus the connection cap on new links and wallets.
3. **No scheduled job, webhook, continuation, resume path or backfill worker checks the lifecycle.** Under COST_FREEZE, BETA_PAUSED, BETA_ENDED or POLICY_UNAVAILABLE, these keep calling Plaid, Esplora, Alchemy/Solana RPC and CoinGecko/Tiingo for every customer: `sync-banks`, `sync-crypto` and its continuation, `sol-history-backfill` (SOL+BTC+ETH), `resume-stale-imports`, the Plaid webhook, the exchange-token `after()` import, and `resume-sync`. The owner decision says PAUSED ⇒ "background work for the group stops initiating" and COST FREEZE ⇒ "disables every NEW billable … operation". The current code does not meet either.
4. **Four customer- or operator-initiated paths are open even under freeze.** Each one leads to a paid full import:
   - `POST /api/plaid/exchange-token` creates a new Plaid Item (it has no entitlement or cap check of its own).
   - Re-adding an already-active wallet runs a full chain sync and bypasses the cap.
   - Platform-Ops "Resync connection" runs a full Plaid refresh.
   - Admin "Expand History" exchange creates a new Item.
5. **Inside the request paths the resolver does cover, the mechanics are sound.** Freeze beats overlay and override, an unreadable lifecycle fails closed (as POLICY_UNAVAILABLE), the refusal comes before every provider call and side effect, and reading existing Briefs and exports stays available.

---

## 1. How the gate actually works in #162

| Mechanism | File | Used by |
|---|---|---|
| Resolver applies the lifecycle: `costFrozen` → COST_FREEZE, ENDED → BETA_ENDED, PAUSED → BETA_PAUSED, with billable dimensions set to `READ_ONLY_VALUES` (source `LIFECYCLE`). While restricted, the overlay, override and platform allowance setting are **not candidates**. | `lib/entitlements/resolve.ts:258-301`, `lifecycle.ts:94-140` | every `loadEffectiveEntitlements(…, entitlementLoadOptions())` caller (all six production callers pass the options) |
| Lifecycle unreadable (`CODE_FALLBACK`, `servedFromLastGood`, `lifecycleSource: UNAVAILABLE`) → restriction POLICY_UNAVAILABLE, billable dimensions read-only | `resolve.ts:86-88, 281-288` | same |
| `refuseIfFailClosed` = `refuseIfBillableRestricted`: fail-closed returns 403 "plan needs attention"; any `lifecycleRestriction` returns 403 for a group state or 503 for POLICY_UNAVAILABLE | `lib/entitlements/consume.ts:113-125` | brief/generate, plaid/refresh, accounts/[id]/sync, plaid/investments/enable, link-token (investments consent only) |
| `refuseIfDisabled`: a boolean that is off with source LIFECYCLE gets the lifecycle wording | `consume.ts:88-102` | ai/chat (`conversations`), brief GET/generate (`dailyBrief`, which stays **true** under read-only so reading keeps working) |
| `countLimit`: deliberate 0 under a restriction | `consume.ts:135-140` | connection cap (`maxConnections`), wallet manual sync (`manualWalletRefreshPerHour`), AI pacing |
| `isManualRefreshEntitled` returns `failClosed !== true && lifecycleRestriction == null`; refusals are reported as `PLAN_RESTRICTED` | `lib/refresh/refresh-all.ts:127-137, 184-240` | `/api/refresh/all`, CS operator Refresh All |
| `assertBillableAllowed` / `billableAllowedForUsers` / `decideBillable` (strict 30 s fresh catalogue, NO_OWNER for Spaces with 0 or ≥2 owners) | `lib/entitlements/billable-gate*.ts` | **none** |
| `getBetaLifecycleState` (UNKNOWN unless a fresh DB read) | `lib/entitlements/beta-lifecycle.ts` | **none in production** |

### Policy propagation (requirement: ≤ 30 s)

- **Resolver path (all enforcement that is live today).** It uses `loadPolicyGroupCatalogue`, an in-process cache with `CATALOGUE_TTL_MS = 30_000` (`policy-group-catalogue.ts:52,134`). A lifecycle write invalidates the local instance immediately (`policy-group-lifecycle-write.ts:144`). Other instances pick it up within **30 s + one read's latency**: `expiresAt` is stamped *after* the three-query read finishes, while the lifecycle query is the last of the three. In practice that is 30–31 s, which overruns the requirement by the read latency.
  - **Fix:** stamp `expiresAt` from read start, or use a TTL of about 25 s.
  - The customer's own assignment row is read live on every request.
- **A failed read** serves the last-good copy marked `servedFromLastGood`, or the code fallback. Either one resolves to **POLICY_UNAVAILABLE**, so billable work fails closed. The failure is cached for 5 s, then retried.
- **Billable-gate path (unwired).** `loadFreshPolicyGroupCatalogue` requires `loadedAt` to be ≤ 30 s old and never accepts the last-good copy or the fallback. That is strictly within the requirement.
- **Long-running work never re-checks.** No job checks the lifecycle at all. Once one is gated, a check made once per dispatch still lets a 300 s invocation keep starting items for up to 5 minutes after a freeze. Re-check per item, or at least every ≤ 30 s.

### Overlay / override precedence (verified)

- **Founder overlay** (`FOUNDER_INTERNAL_V1`): `overlayValue` is reported but not applied when `restricted !== null` (`resolve.ts:289-296`).
- **Per-customer AI override:** the restricted branch sets `aiDailyUsdAllowance = 0` and skips `resolveAiDailyAllowance`, so neither the override nor the platform setting can lift it.
- **Exception: a missing or invalid assignment.** It takes the existing FAIL_CLOSED branch, where `lifecycleRestriction` is null but `failClosed` is true. Every seam above still refuses it, with "plan needs attention".
- **The freeze is per policy group.** A customer assigned to a different (DB-created) group is not frozen when `BETA_FULL_ACCESS_V1` is frozen. Today there is only one code group, but freezing all spend means freezing every group.

---

## 2. Call-site inventory and verdicts

Legend: **P** PROTECTED · **PART** PARTIAL · **U** UNPROTECTED · **n/a** not customer-billable (platform-wide or free). "Admission" is the existing platform ingestion pause or maintenance gate (`admitOperationalWork`). It is *not* the lifecycle gate.

### 2.1 OpenAI

| # | Provider call | Entry point(s) | Identity there | Gate & order | Fail-closed | State when blocked | Verdict |
|---|---|---|---|---|---|---|---|
| A1 | `lib/ai/provider.ts:520` `generateWithTools` and `:682` `generateStructuredWithUsage` (via `conversation/turn.ts:432`, `engine.ts:393`) | `POST /api/ai/chat` | session `user.id` (the asker, also in shared Spaces) | `refuseIfDisabled(conversations)` at `app/api/ai/chat/route.ts:120-121`, **before** pacing, the AI kill switch, the allowance reservation and any model call. `conversations` → false (LIFECYCLE) under all four restrictions. The allowance (`:156`) is also 0. | Yes: POLICY_UNAVAILABLE makes `conversations` false, so 503 | nothing written (refusal comes before reservation or transcript) | **P** |
| A2 | `provider.ts:682` via `lib/ai/brief/generate.ts:224` | `POST /api/brief/generate` (`generateBriefResponse` → `ensureDailyBrief`). No cron or other producer of Brief generation exists. | session `user.id` (the requester; `ownerUserId` in the lifecycle call) | `refuseIfFailClosed` at `app/api/brief/generate/route.ts:58`, before pacing, kill switch, allowance and the claim. Works whether `ai_daily_allowance_enforced` is on or off. | Yes (503 POLICY_UNAVAILABLE) | nothing written | **P** |
| A3 | Reading: `GET /api/brief`, `/dashboard/brief` (`readBriefResponse`, "Never a model call") | — | — | `dailyBrief` stays **true** under READ_ONLY | — | — | stays available ✔ |

The other AI importers are `scripts/ai-baseline/*` (operator CLIs, outside the server runtime).

### 2.2 Plaid

| # | Provider call | Entry point(s) | Identity | Gate & order | Fail-closed | State when blocked | Verdict |
|---|---|---|---|---|---|---|---|
| P1 | `linkTokenCreate` `app/api/plaid/link-token/route.ts:241` | `POST /api/plaid/link-token` (fresh link) | session user | connection cap `connectionCapForUser` at `:172`, before `linkTokenCreate`. `maxConnections` → 0 under every restriction. | Yes (0 limit) | nothing written | **PART**: refused, but the body says "Connection limit reached (n of 0)", not the lifecycle wording (`connectionLimitResponse` only special-cases `failClosed`) |
| P1b | same, **update mode** (repair / reauth) | same, with an existing Item | session user | Plain update mode is ungated by design (repair). Investments-consent update mode uses `refuseIfFailClosed` at `:104`. | — | — | acceptable *if* the follow-on exchange is gated; it is not (P2) |
| P2 | `itemPublicTokenExchange` `lib/plaid/exchangeToken.ts:235`, then `accountsGet` `:372`, holdings, and **`after(syncPlaidItemFromWebhook(..., "RECONNECT"))`** (`app/api/plaid/exchange-token/route.ts:112`), which runs the full transactions, investments and price backfill | `POST /api/plaid/exchange-token`. The client (`context/PlaidContext.tsx:151`, `app/plaid-oauth-return/page.tsx:100`) calls it for **both** fresh links and update-mode repairs | session `userId` + active `spaceId` | **None.** Only the rate limit (`:79`) and platform admission (`exchangeToken.ts:215-231`). The cap is not re-checked (a link token issued before a freeze, valid ~4 h, still completes). | No | n/a | **U**. This **creates a billable Item** |
| P3 | `plaidClient.linkTokenCreate` `app/api/admin/plaid/expand-history-token/route.ts:184` + `performPlaidTokenExchange` (`exchange-expanded-history-token/route.ts:128`) | Admin "Expand History" | operator session; target `oldPlaidItem.userId` | none (admission only) | No | — | **U** (operator-initiated new Item for a frozen customer) |
| P4 | `transactionsSync` `lib/plaid/syncTransactions.ts:433`, `accountsGet` `lib/plaid/refresh.ts:194`, `investmentsHoldingsGet` `lib/plaid/sync-investments.ts:131`, `investmentsTransactionsGet` `lib/investments/investment-event-ingest.ts:274` | **manual** `POST /api/plaid/refresh` | session user (owner of Item) | `refuseIfFailClosed` at `app/api/plaid/refresh/route.ts:91`, after admission and before the cooldown, lock or Plaid call | Yes | refuses before the cooldown is used and before the lock is claimed | **P** |
| P5 | same primitives | `POST /api/refresh/all` (USER) and `POST /api/platform/customer-success/customers/[userId]/refresh` (OPERATOR) via `refreshAllForUser` | the customer (`userId`); entitlements loaded for **the customer**, also on the operator path | `isManualRefreshEntitled` (`refresh-all.ts:184`) checked per Item (`:194`) and per wallet (`:236`) before cooldown and claim; outcome REFUSED / `PLAN_RESTRICTED` | Yes | Item and wallet `excluded`, no claim, no cooldown | **P** |
| P6 | same + Investments product | `POST /api/plaid/investments/enable` | session user | `refuseIfFailClosed` at the top (before limiter, admission and provider) | Yes | nothing written | **P** |
| P7 | `runFullRefresh` → `syncTransactionsForItem` etc. | `POST /api/platform/platform-ops/connections/[id]/resync` (`route.ts:100,138`) | operator; `PlaidItem.userId` is reachable | **none** (admission only) | No | — | **U** (inconsistent with the CS operator Refresh All, which *is* gated) |
| P8 | `runCronItemRefresh`: transactionsSync + accountsGet (+ holdings); `ingestInvestmentEvents` (`jobs/sync-banks.ts:352`); `regenerateWealthHistoryForAccounts` → price backfill | **cron** `sync-banks` (dispatcher `/api/jobs/dispatch`, 06:00, self-continuing) + fallback `/api/jobs/sync-banks` | `PlaidItem.userId` exists but is **not selected** (`loadSyncBanksItems`, `:215-219`) | **none.** Platform admission only (`:233`); the route comment says "Scheduled platform refresh is not an entitlement and continues" | No | — | **U** |
| P9 | `runDeferredHistorySync` (`lib/plaid/backgroundHistorySync.ts`: transactions to completion, `accountsGet` `:547`, `recoverMissingPlaidAccountsForItem`, price backfill `:330`, investments) via `syncPlaidItemFromWebhook` (`lib/plaid/webhook-sync.ts:70`) | **Plaid webhook** `POST /api/plaid/webhook` (`route.ts:65`, `after()`) for TRANSACTIONS `SYNC_UPDATES_AVAILABLE` / `HISTORICAL_UPDATE` / `INITIAL_UPDATE` / `DEFAULT_UPDATE` and HOLDINGS `DEFAULT_UPDATE` (`webhook-receiver.ts:75-128`); ITEM webhooks only change health | Item → `userId` (the receiver already loads the Item + owner `deactivatedAt`) | **none** (admission at `webhook-sync.ts:99`) | No | — | **U** |
| P10 | same pipeline (`syncPlaidItemFromWebhook(..., "RESUME", "IMPORT_RECOVERY")`) | `POST /api/plaid/resume-sync` (client polls it, `ConnectionsList.tsx:185`) | session user | none (rate limit + admission `:80`) | No | Note: it **re-arms `syncIncompleteAt` before** the sync (`:125`) | **U** |
| P11 | same pipeline | **cron** `resume-stale-imports` (`vercel.json` `*/5`, `jobs/resume-stale-imports.ts:202,228`) | `PlaidItem.userId` (not selected; `select {id, institutionName}`) | none (admission once per pass) | No | — | **U** |
| P12 | `itemRemove` `lib/plaid/disconnect.ts:106`, `lib/account-deletion/purge.ts:271`, `exchangeToken.ts:258`; `plaid-removal-retry` job | disconnect, account deletion, retry | — | not gated, **correctly**: removal *stops* subscription billing | — | — | keep available ✔ |
| P13 | `webhookVerificationKeyGet` `webhook-verify.ts:131`; `itemGet` / `itemWebhookUpdate` `webhook-migration.ts:95-160` (Platform-Ops webhook migration) | webhook verification; operator migration | — | none | — | — | **n/a** (not metered data products) |

> **Billing caveat (verify against the Plaid contract).** Plaid Transactions / Investments / Liabilities are usually billed as a **monthly subscription per connected Item**, not per call. Skipping syncs reduces per-call products and our own infrastructure load, but it does **not** stop an existing Item's monthly fee. Only `itemRemove` does. Cost Freeze as built cannot reduce that line. The new-Item paths (P2, P3) are therefore the highest-value Plaid gaps.

### 2.3 Crypto wallets (Esplora/blockstream, mempool, Alchemy/EVM RPC, Solana RPC, CoinGecko inside the sync)

Provider sites: `lib/crypto/btc-explorer.ts:241` (`esploraGetJson`, every BTC balance, discovery and tx call), `btc-history-backfill.ts:306`, `eth-rpc.ts:216`, `eth-history.ts:425`, `evm-native.ts:160` (BNB/AVAX), `token-rpc.ts:93`, `erc20-history-rpc.ts`, `alchemy.ts`, `sol-rpc.ts:294`, `sol-history.ts:251`, `sol-history-backfill.ts:138`. CoinGecko: current quotes `refreshCurrentQuotesForChains` (`wallet-sync-dispatch.ts:548`), token quotes `wallet-token-capture.ts` → `current-quotes.ts:305`, token history closes `token-history-prices.ts:127`, coin history `coingecko.ts:382` (via `backfillPricesForInstruments`). **All per-wallet work funnels through `syncWalletByChain` (`lib/crypto/wallet-sync-dispatch.ts:408`).** That function has no lifecycle or admission check of its own; callers check.

| # | Entry | Identity | Gate & order | Fail-closed | State when blocked | Verdict |
|---|---|---|---|---|---|---|
| W1 | `POST /api/accounts/[id]/sync` (manual wallet) → `syncWalletByChain` (`route.ts:177`) | session user = `ownerUserId` (checked) | admission → `refuseIfFailClosed` (`:129`) → cooldown → hourly limit (0) → claim | Yes | refused before the claim, attempt stamp and cooldown | **P** |
| W2 | Refresh All wallet branch | customer | `isManualRefreshEntitled` (`refresh-all.ts:236`) | Yes | not claimed | **P** |
| W3 | `POST /api/accounts/wallet` **new / archived** address → first sync (`route.ts:402,448`) + `regenWalletWealthHistory` (price backfill) | session `userId` | connection cap (`:163`) before any write. `maxConnections` → 0 | Yes | nothing written | **PART**: refused, but with "Connection limit reached (n of 0)" wording |
| W4 | `POST /api/accounts/wallet` with an address the user **already holds ACTIVE** (re-share / re-add) → `syncWalletBestEffort` (`:375`) + history regen | session `userId` | **bypasses the cap on purpose** (`:164-172`). No lifecycle check, no admission check, **no rate limit** on the route | No | — | **U**: a frozen user can trigger an unlimited full chain sync, quote refresh and history backfill by re-posting the same address |
| W5 | **cron** `sync-crypto` and `sync-crypto-continuation` → `refreshScheduledWallets` (`lib/crypto/wallet-refresh.ts`) → `syncWalletByChain` for every live wallet | `FinancialAccount.ownerUserId`. Wallets with **`ownerUserId: null` are deliberately included** (`wallet-refresh.ts:170`) | admission once per sweep (`:243`); **no lifecycle** | No | — | **U** |
| W6 | `sync-crypto` platform steps: `reconcileProviderCapability(BTC_PRICE_SOURCE)` (`jobs/sync-crypto.ts:101`), `maintainHeldCryptoCloseCoverage` (`:145`, CoinGecko history for every held crypto instrument), `revalueHoldersAfterPriceGaps` (`:220`), wealth regen (`:203`) | no single customer (instrument-scoped, shared archive) | none | — | — | **U** (platform-wide; the per-customer gate cannot express it) |
| W7 | **cron** `sol-history-backfill` (self-continuing every 15 min; SOL when `SOL_BACKFILL_ENABLED`, **BTC on unless `BTC_BACKFILL_ENABLED=false`**, ETH when `ETH_BACKFILL_ENABLED`). All passes: probe/listing, reconstruct, resume, price-gap acquisition (`acquireHistoricalPriceGaps`), revaluation, wealth regen | via `accountConnection → financialAccount.ownerUserId` (not selected; `jobs/sol-history-backfill.ts:960-972`) | **none, and not even platform admission.** The worker has no `admitOperationalWork`, and its wallet query does not filter deactivated owners | No | — | **U** (worst crypto gap) |
| W8 | Sync-time backfill passes (`refreshWalletHistory` inside `syncWalletByChain`, `:554`): BTC/ETH/SOL inline history | inherit W1–W5 | inherit | — | checkpoints are durable and resumable (`snapshotPendingFromISO`, request budgets) | inherits |

### 2.4 Prices / FX (non-wallet)

| # | Provider call | Entry | Identity | Gate | Verdict |
|---|---|---|---|---|---|
| X1 | Tiingo `lib/prices/providers/tiingo.ts:93` and CoinGecko history via `backfillPricesForInstruments` (`lib/prices/backfill.ts:145`) | `regenerateWealthHistoryForAccounts` (`regenerate-history.ts:656,687`), called from sync-banks, sync-crypto, the backfill worker, the webhook pipeline (`backgroundHistorySync.ts:330`), the wallet route and **`POST /api/connections/build-intelligence`** (`route.ts:125`; rate limit only, `:64`) | Space- and instrument-scoped; the archive is shared by every holder | none | **U** (build-intelligence is a customer-initiated path that reaches the price vendors) |
| X2 | `jobs/fetch-security-prices.ts:48` (Tiingo daily closes) | cron 06:30 + `/api/jobs/fetch-security-prices` | platform | none | **n/a** today; platform-wide |
| X3 | Open Exchange Rates `lib/fx/providers/openExchangeRates.ts:72` (Frankfurter `frankfurter.ts:79` is free) | cron `fetch-fx-rates`, `/api/jobs/fetch-fx-rates`, **and an opportunistic refresh on read** (`lib/money/server-context.ts:56-65`, ≤1 per 30 min per instance) | platform | none | **n/a** (platform-wide, bounded; an owner decision is needed if a "global freeze" should include it) |

### 2.5 Email (note only)

`lib/email/providers/resend.ts:109` is reached from auth (register, forgot/reset password, email change, 2FA reset), Space invites, Growth invitation issuance, account delete/deactivate/export notices, security anomaly alerts, platform alerts and the `notification-retry` outbox job. None of these are lifecycle-gated. Account-security mail must stay available under ENDED/PAUSED. Invitation issuance is meant to use `getBetaLifecycleState`, which it does not yet call on this branch.

### 2.6 Cron surface (complete)

`vercel.json` has two crons: `/api/jobs/dispatch` (`*/15`) and `/api/jobs/resume-stale-imports` (`*/5`). The dispatcher runs `lib/jobs/registry.ts`: sync-banks, fetch-fx-rates, fetch-security-prices, sync-crypto, sol-history-backfill, sync-crypto-continuation, process-deletions, notification-cleanup, notification-retry, purge-trash, rate-limit-sweep, plaid-removal-retry, product-event-retention and evaluate-alerts. There are fallback per-job routes under `app/api/jobs/*`; `app/api/cron` does not exist. **Not one job body references the lifecycle or the billable gate.**

---

## 3. Ranked gaps

| Rank | Gap | Why it matters | Natural seam / fix |
|---|---|---|---|
| **G1 (P0)** | `POST /api/plaid/exchange-token` has no lifecycle or cap check (P2) | Creates a **new billable Plaid Item**, then a full import. A link token issued before the freeze still completes. It also serves update-mode repairs, so a repair under freeze runs a full paid RECONNECT import. | In `performPlaidTokenExchange`, before `itemPublicTokenExchange` (`exchangeToken.ts:~215`): `assertBillableAllowed({userId, operation:"plaid_exchange"})`. For update mode (same `item_id`), allow the exchange (repair, account security) but defer the RECONNECT sync to the gated pipeline (G3). Re-check the cap at exchange time. |
| **G2 (P0)** | `sol-history-backfill` worker: no lifecycle gate, **no platform admission**, deactivated owners not excluded (W7) | Runs every 15 min for every SOL/BTC(/ETH) wallet: Alchemy (shared budget), Esplora and CoinGecko price gaps | Select `ownerUserId` in `wallets()`, call `billableAllowedForUsers(owners, "crypto_backfill")` once per run, and **re-check per wallet**. Skip denied wallets *before* `acquireLock`, without touching checkpoints (they are already resumable), and count them as `planRestricted`, not `deferred`, so `selfContinues` does not spin. Add `admitOperationalWork` too. |
| **G3 (P0)** | Plaid webhook / exchange `after()` / resume-sync / resume-stale-imports → `syncPlaidItemFromWebhook` (P9–P11) | Every SYNC_UPDATES_AVAILABLE / HISTORICAL_UPDATE / HOLDINGS webhook triggers a full deferred pipeline (transactions, investments, price backfill) | **One seam covers four producers:** `webhook-sync.ts:99`, next to admission. Look up `PlaidItem.userId` and call `assertBillableAllowed({userId, operation:"plaid_webhook_sync" \| "plaid_resume_sync"})`. On deny, follow the existing admission-denial contract: `recordAdmissionDenial`-style evidence, no lock, **no `syncIncompleteAt` stamp or clear**, return `"not-admitted"`-like (`"plan-restricted"`). resume-stale-imports must **not count a denial as an attempt** (keep `syncResumeAttempts` / backoff unchanged, as it already does for admission). resume-sync re-arms `syncIncompleteAt` *before* syncing (`resume-sync/route.ts:125`), so its gate must come before that write. Note: webhooks are not re-sent, but `syncIncompleteAt` + resume-stale-imports already give catch-up after unfreeze. |
| **G4 (P1)** | `sync-banks` cron (P8) | Every ACTIVE Item, daily, plus continuations; investments events | Select `userId`, use `billableAllowedForUsers(userIds, "plaid_sync")` per dispatch plus a per-item re-check. On deny, skip before `runFullRefresh`: no `lastSyncedAt`, no lock, no health change, and record a SKIPPED execution with reason PLAN_RESTRICTED. Exclude denied items from `deferred` so the continuation does not loop. |
| **G5 (P1)** | `sync-crypto` wallet sweep (W5) | Every wallet every 6 h + continuation | In `refreshScheduledWallets`, filter `listWallets` by `billableAllowedForUsers(…, "wallet_sync")`. Wallets with `ownerUserId: null` become NO_OWNER and are denied; decide whether that is intended. A denied wallet must not move its success or failure clocks or `Connection.errorCode`. |
| **G6 (P1)** | Re-adding an already-active wallet (W4) | An unlimited, un-rate-limited full sync under freeze | Gate `syncWalletBestEffort` in the route on `wallet_sync` (or `refuseIfBillableRestricted` on entitlements) for every branch. The re-share DB write can still succeed; skip only the provider work. Add a `limitByUser`. |
| **G7 (P1)** | Platform-Ops "Resync" (P7) and Admin "Expand History" (P3) | Operator-initiated paid work for a frozen customer. CS Refresh All is gated, so the operator surfaces disagree. | Load the customer's entitlements (`loadEffectiveEntitlements(systemDb, item.userId, entitlementLoadOptions())`) and refuse on `isManualRefreshEntitled === false`, or call `assertBillableAllowed`. If operators should be able to override, make it an explicit, audited override, not a silent bypass. |
| **G8 (P2)** | Price vendors reached from wealth regen, including the customer-initiated `POST /api/connections/build-intelligence` (X1), and the `sync-crypto` platform steps (W6) | Tiingo and CoinGecko historical fetches; shared archive | The `price_history` operation exists but nothing uses it. Gate `backfillHeldInstrumentPrices` on the **triggering account owner** (not the Space; see §4). For platform steps, owner decision: skip when no customer holding the instrument is billable-allowed. |
| **G9 (P2)** | Refusal wording for new link and new wallet under a restriction (P1, W3) | Customer sees "Connection limit reached (n of 0)" instead of the paused / frozen sentence | `connectionLimitResponse` should map `lifecycleRestriction` to `planRestrictedResponse` |
| **G10 (P2)** | Propagation is 30 s + read latency on the resolver path | Slightly over "≤ 30 s" | Stamp `expiresAt` from read start, or set the TTL to about 25 s |
| **G11 (P3)** | Freeze is per policy group | Freezing `BETA_FULL_ACCESS_V1` does not freeze customers on any other (DB-created) group | Document this, or add "freeze all groups" in the CONTROL path |
| **G12 (P3)** | FX opportunistic refresh and `fetch-security-prices` / `fetch-fx-rates` (X2, X3) | Platform-wide, bounded | Owner decision: are platform reference-data vendors in Cost Freeze scope? |

**What must be preserved when any of these gates is added.** A denial must:

- write no completion marker (`lastSyncedAt`, `historyCompletedAt`, checkpoint `COMPLETE`, clearing `syncIncompleteAt`);
- consume no cooldown;
- leave no lock;
- not move the connection to an error or reauth status;
- not count toward retry or backoff budgets.

Checkpoints (`snapshotPendingFromISO`, backfill cursors, Plaid cursors) must stay exactly as they were, so unfreezing resumes where work stopped. The existing `admitOperationalWork` denial handling in sync-banks, resume-stale-imports and webhook-sync already follows this contract and is the right template.

---

## 4. Shared Spaces: who is billed?

- **Request-scoped AI** (chat, Brief generation) bills **the requester** (`user.id`). That matches `assertBillableAllowed`'s rule: `userId` wins when given.
- **Plaid work** is Item-scoped, and the natural billed customer is **`PlaidItem.userId`**, the person who connected it, whatever Spaces its accounts are shared into. Every Plaid job and webhook can reach this id cheaply. None selects it today.
- **Wallet work** is account-scoped and bills **`FinancialAccount.ownerUserId`**. It is **nullable**, and the scheduled sweep deliberately includes null-owner wallets. Under the gate those are NO_OWNER, which means denied for metered work; that needs an owner ruling.
- **"Earliest owner" is not used anywhere.** `billedOwnerOf` (`billable-gate-core.ts:146`) returns the single ACTIVE OWNER, or **null (NO_OWNER) for zero or ≥2 owners**. The comment records the owner decision of 2026-10-31: never silently charge the earliest owner. There is a TODO for a future designated-billing-owner field. No production code calls it.
- **Risk if Space-scoped gating is adopted naively.** Wealth-history regeneration, and the price backfill inside it, run per **Space**. Gating them with `{ spaceId }` would deny every multi-owner shared Space outright (NO_OWNER). Gate on the triggering account's owner (Plaid Item or wallet owner) instead, and keep `spaceId`-only gating for work that truly has no account owner.

---

## 5. Readers that must stay available (verified)

- `GET /api/brief` and the `/dashboard/brief` page read the stored Brief, with no model call (`lib/ai/brief/view.ts:125`). `dailyBrief` stays `true` under READ_ONLY_VALUES.
- `/api/user/export` is `DATA_ACCESS` (the gate never refuses it for lifecycle). `exportsPerDay` stays 1. The PR test source-scans it for provider imports.
- Space, account, transaction and snapshot reads, sign-in, account security (2FA, password), and disconnect / `itemRemove` / account deletion stay available. None of them is gated, and none should be.

---

## 6. Summary table

| Path | Verdict |
|---|---|
| AI chat | PROTECTED |
| Daily Brief generation | PROTECTED |
| Brief / export reads | available ✔ |
| Manual Plaid refresh | PROTECTED |
| Refresh All (customer + CS operator) | PROTECTED |
| Investments enable | PROTECTED |
| Manual wallet sync | PROTECTED |
| Plaid link-token (new) | PARTIAL (refused via cap; wrong wording) |
| Add new wallet | PARTIAL (refused via cap; wrong wording) |
| Re-add active wallet | **UNPROTECTED** |
| Plaid exchange-token (new Item + RECONNECT import; also update-mode repair) | **UNPROTECTED** |
| Admin Expand History | **UNPROTECTED** |
| Platform-Ops Resync | **UNPROTECTED** |
| Plaid webhook (SYNC_UPDATES_AVAILABLE / HISTORICAL_UPDATE / INITIAL / DEFAULT / HOLDINGS) | **UNPROTECTED** |
| resume-sync route | **UNPROTECTED** |
| resume-stale-imports cron | **UNPROTECTED** |
| sync-banks cron (+ investments events) | **UNPROTECTED** |
| sync-crypto + continuation (wallets) | **UNPROTECTED** |
| sync-crypto platform price steps | UNPROTECTED (platform) |
| sol-history-backfill (SOL/BTC/ETH, all passes, price gaps) | **UNPROTECTED** (also no admission) |
| build-intelligence → price vendors | **UNPROTECTED** |
| FX / security-price jobs, FX on-read refresh | n/a (platform; owner decision) |
| itemRemove / disconnect / deletion | keep available ✔ |
| Email (Resend) | noted; not gated |
