# CONN-1 — Connection Lifecycle Experience: Investigation & Architecture Audit

**Status:** INVESTIGATION COMPLETE. This is the gated deliverable — implementation of any phase follows *only* after the architecture below is confirmed.
**Date:** 2026-07-19.
**Mission:** When Fourth Meridian connects to someone's financial life, the product should clearly communicate that it is *building intelligence* — not just "spinning." This audit maps the complete connection lifecycle across the three provider families (banking, investments, crypto/wallet), establishes the single source of truth for sync state, identifies where state goes stale, and designs the confirmed-safe foundation — all inside the hard constraints (no second sync engine, no change to financial authorities / DayFacts / valuation / FlowType / aggregation, no fabricated progress).

---

## 0. Executive summary — the seven findings

1. **Sync state has one source of truth per provider, and it is a persisted record, not a notification.** Plaid: `PlaidItem.status` + `PlaidItem.syncIncompleteAt`. Wallet: `Connection.status` + `Connection.lastSyncedAt` + `Connection.errorCode`. Both normalize through `lib/sync/status.ts` into the single `SyncConnection` contract (`importing | ready | needs_reauth | error`). Completion is **already** persisted (`syncIncompleteAt = null`) independent of any notification. The notification is a best-effort side-channel, not the completion record.

2. **The "stuck spinner" is a UI refresh-cadence gap, not a missing record.** `ConnectionsList` polls `/api/sync/status` every 4s while building, caps at `MAX_POLLS = 45` (~3 min), and pauses on a hidden tab. The refocus handler already re-arms the budget. The residual gap: a **focused-and-idle** tab whose historical import outlasts 3 min, plus card copy that *over-promises a push* ("We'll notify you the moment it's ready") the client cannot guarantee.

3. **The lifecycle card partially exists.** `ConnectionCard` already renders an honest `StageStepper` while importing (Institution connected → Accounts discovered → Balances imported → Transaction history importing → Ready) plus forward "ready next" markers (Timeline / Daily Brief / AI insights). CONN-1 is about making this truthful surface *consistent, durable, and complete* — not inventing it.

4. **The deepest staleness cause is balance/snapshot freshness, and it is a known, documented deferral.** Only the manual **Refresh** button calls `accountsGet` (refreshing `FinancialAccount.balance`) and regenerates *today's* `SpaceSnapshot`. Every routine path — webhook, nightly cron, "Sync Now" — runs `syncTransactionsForItem`, which ingests transactions but **never touches balances or today's snapshot**. So a posted payment updates transactions while the displayed balance stays stale until Refresh. This is Phase-6's root cause. **It touches financial authorities and is therefore an investigation finding here, not a fix in this slice.**

5. **Multi-account reconstruction needs one additive line.** `refreshAllActiveItemsForUser(userId, { excludeItemIds? })` already batches every active item with per-item locks. Adding `includeItemIds?: string[]` (the inverse subset filter) satisfies the mission's ban on a new `refreshMultipleAccounts()` — no new authority, no new engine. (Design already recorded in `RECONSTRUCTION_EXPERIENCE_AUDIT.md`.)

6. **"Available history" is `earliestTxDate`, derivable now.** Per-account history depth = `today − MIN(non-deleted Transaction.date)` (`app/api/spaces/[id]/accounts/route.ts:84-110`). The `730`/`365` literals are unrelated (Plaid *request* window / chart display caps) and must not be surfaced as "days available."

7. **The registration verification UX has a real dead-end.** Open-mode signups are created **unverified** and *are* sent a verification email, but the UI routes straight to `/login?registered=true` showing "Account created! Sign in below." — which is wrong (login is blocked until verified). There is **no "check your inbox" screen**. This is pure presentation to fix; the API already does the hard part.

---

## 1. The lifecycle, provider by provider

### 1.1 Banking (Plaid transactions) — the canonical path

```
Link (openLink) → POST /api/plaid/exchange-token
  → performPlaidTokenExchange (exchangeToken.ts:113)
      · PlaidItem upsert         (create = initial auth · update = relink)
      · FinancialAccount + balances (accountsGet)
      · holdings (if investments consent)
      · today's SpaceSnapshot
      · syncIncompleteAt = now   ← connection is BORN "importing"
  → route schedules after(() => syncPlaidItemFromWebhook(itemId))   (exchange-token/route.ts:108)
      → runDeferredHistorySync (backgroundHistorySync.ts:275)
          · syncTransactionsForItem  (paged; persists cursor per page)
          · backfillHistoryForItem   (30-day historical, new-Space-gated)
          · regenerateWealthHistoryForAccounts  [yesterday-30 … yesterday]
          · syncIncompleteAt = null  ← COMPLETION (syncTransactions.ts:548)
          · best-effort PLAID_HISTORY_SYNCED audit + notification
```

- **State source of truth:** `deriveConnectionState(item)` — `ACTIVE + syncIncompleteAt≠null → importing`, `ACTIVE + null → ready`, `NEEDS_REAUTH`, `ERROR`, `REVOKED → excluded` (`lib/sync/status.ts:131`).
- **Completion is persisted** at `syncIncompleteAt = null`. The notification/audit are separate, error-swallowing side effects — they never gate completion.
- **Real, observable stages** (already rendered by `ConnectionCard`'s `StageStepper`): institution connected → accounts discovered → balances imported → transactions importing → ready.

### 1.2 Investments (Plaid Holdings) — fewer *tracked* stages

- **Ingest:** `syncInvestmentsForItem` (`lib/plaid/sync-investments.ts`) writes `PositionObservation` (append-only, gated `INVESTMENT_OBSERVATIONS_ENABLED`), `Holding` (current read model), brokerage cash, `InvestmentEvent` (gated), and same-day `PriceObservation`. Never throws — a holdings failure advances `PlaidItem.investmentsConsent` (`CONSENT_REQUIRED` / `ENABLED`) instead.
- **Capability is an orthogonal signal on the same card:** `deriveInvestmentsCapability` — `ENABLED→"enabled"`, `CONSENT_REQUIRED→"available"` (renders `EnableInvestmentsButton`), `UNSUPPORTED|null→null` (renders nothing — the never-mislead invariant).
- **Readiness is DERIVED at read time, never stored.** There is no `portfolioReady` flag. `buildInvestmentsTrustSummary` / `valuedOfTotalLabel` ("N of M positions valued") + `PortfolioValuationCoverage` are projections over `PositionObservation` + `PriceObservation`. The historical price backfill is currently a **vendor-gated no-op** (`defaultPriceRegistry()` is empty until a licensed vendor is wired).
- **Lifecycle implication:** an investment connection's `SyncConnection` only carries `importing → ready` driven by `syncIncompleteAt` (which tracks **transactions**, not holdings). A "holdings → valued → ready" data-completeness lifecycle is **computed, not tracked** — CONN-1 may *surface* the derived trust summary but must not invent a stored holdings-readiness stage.

### 1.3 Crypto / wallet (self-custody, `provider=WALLET`) — genuinely staged

- **Create:** `POST /api/accounts/wallet` → watch-only descriptor/xpub (never keys) → `FinancialAccount` (balance 0, `syncStatus:"pending"`) + `AccountConnection`/`SpaceAccountLink` via `persistAccountSpine` + `Connection(WALLET)` + `ProviderAccountIdentity` via `alignWalletProviderSpine`.
- **Sync engine:** `syncBtcWallet` (`lib/crypto/btc-sync.ts`, never throws). xpub **discovery** is bounded + resumable, checkpointing on `Connection.cursor` (a large wallet completes over several runs, staying `pending`). Balance sweep + **quantity-only** valuation (`nativeBalance × btcUsdSpot`); `Holding` + `PositionObservation` dual-write (quantity-only, no institution anchor — valued through the canonical BTC `Instrument`).
- **State source of truth:** `deriveWalletConnectionState` off `Connection.status/lastSyncedAt/errorCode` — `ACTIVE+lastSyncedAt→ready`, `ACTIVE+errorCode→error`, `ACTIVE+neither→importing`, `NEEDS_REAUTH→error` (wallets never reauth), `REVOKED→excluded` (`lib/sync/status.ts:202`).
- **Genuinely derivable staged lifecycle:** discovered addresses (`ProviderAccountIdentity`), discovery checkpoint (`Connection.cursor`), partial-vs-complete (`syncStatus`), balances (`FinancialAccount`), reconstructed history (wealth snapshots), ready (`Connection.status=ACTIVE + lastSyncedAt`). Honest error codes: `NO_USED_ADDRESSES`, `INVALID_XPUB`, `RATE_LIMITED`.

---

## 2. Source of truth — consolidated

| Question | Answer | Where |
|---|---|---|
| Is a connection importing or ready? | Persisted record → `SyncConnection.state` | `lib/sync/status.ts` |
| Plaid completion marker | `PlaidItem.syncIncompleteAt` (null = ready) | `syncTransactions.ts:548` |
| Wallet completion marker | `Connection.lastSyncedAt` set + `status=ACTIVE` | `btc-sync.ts` |
| Investments capability | `PlaidItem.investmentsConsent` → capability enum | `deriveInvestmentsCapability` |
| History depth available | `today − MIN(non-deleted Transaction.date)` per account | `spaces/[id]/accounts/route.ts:84-110` |
| Displayed balance freshness | `FinancialAccount.balance` (only Refresh/connect refresh it) | see §4 |
| What the UI reads | server-rendered `SyncStatus` + `/api/sync/status` poll | `ConnectionsList.tsx` |

**Key invariant to preserve:** completion is a persisted field, not a notification. Any UI truthfulness fix must re-derive from the persisted record, never treat "notification arrived" as the completion signal.

---

## 3. Where state goes stale (the UI cadence gap — Phase 1/3)

`ConnectionsList` (`components/connections/ConnectionsList.tsx`):
- Polls `/api/sync/status` every 4s **while building**; hard cap `MAX_POLLS = 45` (~3 min) → `setSlow(true); stop()`.
- Pauses on hidden tab; **refocus already re-arms** the budget, clears `slow`, and polls immediately (`:180-196`).
- On `building: true → false`, calls `router.refresh()` once.

**Residual gaps (all presentation / cadence, no authority change):**
1. A **focused, idle** tab whose historical import genuinely exceeds ~3 min hits the cap and freezes on a `slow` note until the user interacts. Plaid historical ingestion is webhook-driven and *can* outlast 3 min.
2. Card copy **over-promises a push**: `ConnectionCard.tsx:318` "We'll notify you the moment it's ready." The client cannot guarantee that push (notification is best-effort; poller may have stopped). Truthful copy: "This keeps importing in the background — reopen Connections anytime to check progress," and the `slow` state should invite a manual re-check rather than promise a notification.

**Fix design (Phase 1/3, safe):**
- Extend the truthful lifecycle projection (`ConnectionLifecycleStatus`, §5) so the card always renders *which stage* a connection is in from the persisted record — so even a "stopped polling" card shows an honest last-known stage + a "Check again" affordance instead of an ambiguous spinner.
- Fix the over-promising copy.
- Optionally raise the focused-tab budget for connections known to be in the long historical-backfill stage (cadence only — no new record).

---

## 4. Phase 6 — balance/snapshot staleness ROOT CAUSE (investigation only)

**Finding (high confidence):** only the manual **Refresh** button refreshes balances and regenerates today's snapshot.

| Trigger | `accountsGet` (balance)? | today's `SpaceSnapshot`? | historical wealth (≤ yesterday)? |
|---|:--:|:--:|:--:|
| Manual **Refresh** (`/api/plaid/refresh` → `refreshPlaidItem`) | ✅ | ✅ | ❌ |
| Connect (`exchange-token` → `runDeferredHistorySync`) | ❌ | ❌ (new-Space-gated) | ✅ |
| Webhook `SYNC_UPDATES_AVAILABLE` | ❌ | ❌ | ✅ |
| Nightly cron (`sync-banks`) | ❌ | ❌ | ✅ (gated) |
| "Sync Now" (`/api/plaid/sync`) | ❌ | ❌ | ❌ |

`syncTransactionsForItem` writes cursor + transaction rows only — no `accountsGet`, no `FinancialAccount.balance` update. Debt/current-balance projections read the **stored** `FinancialAccount.balance`, so a posted payment shows the *old* balance until Refresh runs `accountsGet` + `regenerateSpaceSnapshot`. This exactly matches the reported "updates only after I hit refresh" symptom. The registry S3 note already documents the deferral: a scheduled snapshot would "stamp stale balances as fresh."

**Not the cause:** projection caching. Perspective read models are pure/deterministic per-request; `unstable_cache` usage is FX/context, not a projection cache. The staleness is in *written data* (balance + today's snapshot), not cache invalidation.

**Recommended fix (deferred — touches financial authority, out of scope for this slice):** route the routine sync paths (webhook + cron) through a balance-refresh + `regenerateSnapshotsForAccounts` step the way `refreshPlaidItem` already does — reusing existing authorities, not adding a new one. Solving the "stale-balance semantics" unblocks a snapshot cron too. **This must be its own focused, tested slice given the constraint against changing financial authorities in CONN-1.**

---

## 5. `ConnectionLifecycleStatus` — the presentation projection (Phase 1)

A **pure, read-only** projection over records that already exist — no new store, no new authority. Per connection:

| Stage | Plaid derivation | Wallet derivation |
|---|---|---|
| `connected` | `PlaidItem.status = ACTIVE` | `Connection.status = ACTIVE` |
| `accountsDiscovered` | `FinancialAccount` rows exist for the item | `ProviderAccountIdentity` rows exist |
| `balancesImported` | balances written at connect (same as discovered for Plaid) | `FinancialAccount.balance` set (post first sweep) |
| `transactionsImported` | `syncIncompleteAt === null` | n/a (or address-tx import complete) |
| `historyReconstructed` | `PLAID_HISTORY_SYNCED` audit row present | wealth snapshots regenerated |
| `intelligenceReady` | alias of `historyReconstructed` (no dedicated marker today) | alias of `historyReconstructed` |

- **Derivable now:** every stage above reads existing records. `intelligenceReady` is an **alias** — CONN-1 must NOT fabricate a new "intelligence ready" marker; if a dedicated signal is wanted later it is a separate, deliberate slice.
- **Contract boundary preserved:** the projection carries state/provider/stage/lastSyncedAt/errorCode only — **no balances, no valuations, no tiers** (PCS-2). Admin health/staleness (`getConnectionHealth`) stays a separate bounded context.
- **Investments caveat:** the holdings "valued" dimension is derived (trust summary), not a tracked stage — surface it as a *derived* fact, not a lifecycle stage.

---

## 6. Phase 2 — multi-account reconstruction (design confirmed, additive)

Per `RECONSTRUCTION_EXPERIENCE_AUDIT.md` (already written): add `includeItemIds?: string[]` to `refreshAllActiveItemsForUser` (one-line `where` filter, inverse of `excludeItemIds`), then a "Rebuild Financial History" multi-select block in the Connections workspace that calls the existing batch authority and reuses `SyncConnectionState` polling for progress. **No `refreshMultipleAccounts()`, no new engine.** "Days available" per account = `today − earliestTxDate`.

---

## 7. Phase 5 — registration "check your inbox" UX (safe, presentation-only)

**Bug (confirmed):** open-mode signups are created unverified (`register/route.ts:191-196`) and *are* emailed a verification link (`:311-317`), but `register/page.tsx:145` routes to `/login?registered=true`, which shows "Account created! Sign in below." (`login/page.tsx:39`) — wrong, since login blocks unverified users (`lib/auth.ts:209-215`). The user only learns of the requirement *after* a failed login (pre-login `reason:"unverified"`).

**Fix design:**
1. New post-success state before `/login` — a "Check your inbox — we sent a verification link to `<email>`" screen using the existing `(auth)` shell primitives (`AuthCard`/`AuthHeader`/`AuthStatus`/`InlineBanner`), with a **resend** control (endpoint `POST /api/auth/verify-email/resend` already exists) + "Back to sign in."
2. **Distinguish invited vs open-mode:** invited signups are created pre-verified with no email — a "check inbox" screen would misdirect them. The register API (`{success, userId}`) must return a `verificationRequired` flag so the client branches correctly.
3. Fix the `/login?registered=true` banner copy so it does not promise immediate sign-in for unverified accounts.

---

## 8. Phase 4 — connection page redesign (scoped, deferred within slice)

The Connections page is a **card grid** on the Liquid/Glass family (`ConnectionsList` + `ConnectionCard`), framed by `SpaceShell variant="utility"`. **None** of the Atlas editorial primitives (Surface/Block/Figure/RightPanel) are wired in `components/connections/` — converging is greenfield. The existing `StageStepper` is already honest and should be *preserved and promoted*, not discarded. Full editorial convergence is a larger presentation slice; it should follow the Phase-1 lifecycle projection so the redesign renders a single truthful status model.

---

## 9. Implementation plan & risk ordering

Ordered safest → riskiest. Given the recent destructive-DB incident, this slice implements only the **presentation-only, zero-financial-authority** foundation; everything touching sync/balance/valuation is documented and deferred to focused slices.

| # | Work | Risk | This slice? |
|---|---|---|---|
| A | `ConnectionLifecycleStatus` pure projection (§5) + unit test | none (read model) | **Yes — foundation** |
| B | Truthful card copy: stop over-promising the notification push (§3) | none (copy) | **Yes** |
| C | Registration "check your inbox" screen + `verificationRequired` flag + login banner copy (§7) | low (presentation + one API field) | **Yes** |
| D | Focused-tab poll budget for long historical imports (§3) | low (cadence only) | Candidate |
| E | `includeItemIds` filter + "Rebuild Financial History" block (§6) | low-med (financial-adjacent path) | Deferred (own slice) |
| F | Phase-6 balance/snapshot freshness fix (§4) | **high (financial authority)** | **Deferred (own slice) — investigation only here** |
| G | Full Atlas editorial redesign of Connections (§8) | med (large presentation) | Deferred |

**Hard constraints honored throughout:** no second sync engine; no change to `syncTransactionsForItem` / valuation / DayFacts / FlowType / aggregation / financial authorities; no fabricated progress (every stage reads a persisted record); `intelligenceReady` stays an alias, not an invented marker.

**Commit for the foundation:** `CONN-1 connection lifecycle experience foundation`.
