# D2.x — First-Run Sync Experience — Investigation

**Status:** Investigation only. No implementation. No schema.
**Scope:** Design the smallest first-run flow so that after Plaid connect, balances appear quickly, history imports automatically, snapshots update, and Daily Brief/AI become useful without a manual Refresh.
**Alignment:** This investigation confirms and details, from the current code, the direction already approved in `docs/initiatives/d2x/D2X_INITIAL_SYNC_EXPERIENCE_CHARTER.md` and `docs/investigations/INITIAL_SYNC_UX_PIPELINE_INVESTIGATION.md`. It does **not** re-litigate that approved phasing; it grounds each phase in the exact files/functions involved and produces the Phase-1 slice checklist.

---

## 1. Current flow map

### 1.1 Connect → exchange (the monolith)

```
User clicks Connect
  └─ ConnectAccountButton / PlaidLinkButton → usePlaid().openLink()          [context/PlaidContext.tsx]
       └─ GET /api/plaid/link-token                                          [app/api/plaid/link-token/route.ts]
            • detects existing credential (Connection → PlaidItem fallback) → update mode
            • linkTokenCreate({ products:[Transactions], transactions:{ days_requested:730 } })
       └─ usePlaidLink opens Link UI; onSuccess fires with public_token
            └─ POST /api/plaid/exchange-token   ◀── SINGLE BLOCKING REQUEST  [app/api/plaid/exchange-token/route.ts]
                 └─ performPlaidTokenExchange(...)                            [lib/plaid/exchangeToken.ts]
                      1. duplicate-institution check (log only)
                      2. itemPublicTokenExchange  → access_token, item_id
                      3. encrypt token
                      4. upsert PlaidItem
                      5. dual-write Connection (best-effort)
                      6. accountsGet  → balances
                      7. per account: resolve/create FinancialAccount + ProviderAccountIdentity
                                       + AccountConnection + SpaceAccountLink   (balances persisted here)
                      8. investmentsHoldingsGet → Holding rows (consent-gated, best-effort)
                      9. syncTransactionsForItem(plaidItem.id)  ◀── FULL 730-DAY PAGED SYNC (best-effort)
                      9b. regenerateSnapshotsForAccounts(importedIds)  → TODAY's SpaceSnapshot only (best-effort)
                      10. audit log
                 └─ returns { imported, holdingsImported, transactionsSynced }
            └─ onSuccess: router.refresh()                                    [context/PlaidContext.tsx]
```

The client `onSuccess` (`context/PlaidContext.tsx`) sets a single `importing` boolean, `await`s the entire POST, then calls `router.refresh()`. The only user feedback is a spinner reading "Opening Plaid…" / "Opening…".

### 1.2 The reusable engine (already webhook/cron-ready)

- **`syncTransactionsForItem(plaidItemDbId)`** (`lib/plaid/syncTransactions.ts`) — cursor-based `/transactions/sync`, loops on `has_more`, persists `next_cursor` only after the full loop, upserts on `plaidTransactionId` with a fingerprint fallback. A null cursor = "first sync ever" = full available history. This is the canonical engine; every entry point reuses it.
- **`refreshPlaidItem(id)`** (`lib/plaid/refresh.ts`) — balances → holdings → `syncTransactionsForItem` → `regenerateSnapshotsForAccounts`. Idempotent. Backs the manual Refresh button, and is the intended cron/webhook call site.
- **`regenerateSnapshotsForAccounts(faIds)`** (`lib/snapshots/regenerate.ts`) — upserts **today's** `SpaceSnapshot` row (per `[spaceId,date]`) for every space linked via an ACTIVE `SpaceAccountLink`. Writes one day only.

### 1.3 Automatic continuation that exists today

- **Cron:** `vercel.json` → `/api/jobs/sync-banks` daily at `06:00`, `maxDuration = 60`, calls `syncBanks()` → `syncTransactionsForItem` for every ACTIVE PlaidItem.
- **In-process scheduler:** `jobs/scheduler.ts` + `jobs/sync-banks.ts` exist but `startScheduler()` is never invoked (no `instrumentation.ts` hook) — dormant.
- **Manual:** `POST /api/plaid/refresh` and `POST /api/plaid/sync` (no UI wired to `/sync`), both cooldown-gated (`lib/plaid/refreshCooldown.ts`).

### 1.4 What reads the synced data

- Balances / account cards: `getAccounts` (live `FinancialAccount` rows) — available the moment step 7 commits.
- Cash/Banking/Net-Worth history charts: `getRecentSnapshots` / `getPortfolioHistory` (`lib/data/snapshots.ts`) — read `SpaceSnapshot` **exclusively**.
- Daily Brief / AI: `lib/ai/assemblers/snapshot.ts` — a **pure read** over `SpaceSnapshot` history; it does not recompute. No snapshot history → no trend, no insight.

---

## 2. Gaps — where first-run currently breaks

| # | Gap | Evidence | Impact |
|---|-----|----------|--------|
| G1 | **Balances gated behind full history.** The whole import — including the 730-day paged transaction sync (step 9) — runs inside the one `exchange-token` request the client `await`s. Balances (step 7) are already committed but the user sees nothing until step 10 returns. | `lib/plaid/exchangeToken.ts` steps 7→10; `PlaidContext.onSuccess` awaits the POST then `router.refresh()`. | "Connect → long wait" even though balances were ready in the first second. |
| G2 | **No request timeout budget.** `exchange-token/route.ts` sets no `maxDuration` (compare `sync-banks` = 60s). The 730-day paged loop is the long pole and can exceed the platform default. | No `maxDuration` export in the route; `syncTransactionsForItem` `while(has_more)` loop. | On a large/slow institution the function is killed → client shows "Import failed" despite accounts/balances having persisted. |
| G3 | **Partial success looks like total failure.** Steps 9 (tx) and 9b (snapshot) are best-effort/non-fatal *inside* the function, but a hard timeout (G2) kills the request; the client only knows `res.ok === false` → generic "Import failed". No "balances in, history still loading" state. | `PlaidContext.onSuccess` catch → `setError("Import failed")`; route returns 500 on thrown Plaid error. | User distrust; likely disconnect/retry. |
| G4 | **Manual Refresh is effectively required.** If the inline sync is cut short, the only automatic completion is the 06:00 cron (≤24h latency). To see history sooner the user must hit Refresh. | Cron at `0 6 * * *`; scheduler dormant; no background continuation. | Violates the "no manual refresh on first run" goal. |
| G5 | **Snapshot history is a single point.** `regenerateSnapshotsForAccounts` writes only *today's* row. First-run produces ≤1 `SpaceSnapshot`. | `lib/snapshots/regenerate.ts`. | 30-day chart is flat/empty on day one regardless of imported history. |
| G6 | **Daily Brief / AI stay dark.** The snapshot assembler is a pure read over `SpaceSnapshot`; with ≤1 row there is no trend/history to reason over. | `lib/ai/assemblers/snapshot.ts` (reads, never recomputes). | AI/brief "useless without manual refresh" — actually useless until multi-day snapshots exist (G5 blocks this). |
| G7 | **No progress contract.** UI has one boolean (`importing`) and one label. There is no state to distinguish accounts-connected vs balances-ready vs importing-history vs chart-ready. | `PlaidContext.tsx` `isLoading = fetching \|\| importing`. | Nothing to reveal progressively; perceived latency = worst case. |
| G8 | **No pollable status.** Nothing exposes per-item sync progress; `PlaidItem` already carries `cursor`, `lastSyncedAt`, `status`, `errorCode` but no endpoint surfaces them for first-run. | No sync-status route. | Client cannot light up surfaces as data lands. |

---

## 3. Recommended first-run architecture

Direction is the approved charter's progressive-reveal contract, **reusing the existing engine — no second transaction pipeline, no schema unless forced.** Restated concretely against the code:

**A. Split the fast path (the core fix).** `exchange-token` should return as soon as the *fast slice* is durable: token exchanged, accounts + balances persisted (steps 1–7), holdings attempted (step 8), and **today's `SpaceSnapshot` written**. Full historical transaction import moves out of the request.

**B. Continue history in the background.** After the fast response, continue `syncTransactionsForItem(plaidItem.id)` via a supported post-response continuation (Next.js `after()` / `waitUntil`). It is the *same* engine call — the cursor semantics already make "finish the rest of history" identical to "first sync ever." No queue, no `SyncJob`.

**C. Make state inferable, then pollable.** State is derived from existing `PlaidItem` fields (`cursor` null→set, `lastSyncedAt`, `status`, `errorCode`) plus presence of `SpaceSnapshot`/`Transaction` rows — no schema. A thin read-only status endpoint surfaces: `Accounts connected → Balances ready → Importing history → Categorizing → Building 30-day chart → Insights ready`. UI polls and reveals surfaces as each dependency lands.

**D. Backfill snapshots after history completes.** Once background history finishes, trigger the 30-day `SpaceSnapshot` backfill (owned by the Snapshot Backfill initiative; its additive provenance fields live there). This is what unblocks charts (G5) and Daily Brief/AI (G6). Must not block the user.

**E. Cron stays the safety net.** The 06:00 `sync-banks` cron remains the fallback for any item whose background continuation didn't finish. Later, the Plaid `SYNC_UPDATES_AVAILABLE` webhook becomes the event-driven path; cron still backstops.

Every layer is independently shippable and revertible; nothing here may break Link success (fast path stays best-effort for holdings/snapshot exactly as today).

---

## 4. Smallest implementation slices

Ordered smallest-first. Each is its own approval-gated checklist per project working style; **this investigation delivers only the Phase-1 checklist below.**

- **Slice 1 — Fast-path split (highest value, no schema).** Move step 9 (full history sync) out of the awaited path; return after balances + holdings + today's snapshot. Add an explicit `maxDuration` to the route sized to the fast slice. Fixes G1, G2, G3 immediately even before any background/UI work.
- **Slice 2 — Background historical continuation.** Wrap the moved `syncTransactionsForItem` call in `after()`/`waitUntil`. Reuses the engine; no queue/`SyncJob`. Fixes G4.
- **Slice 3 — Sync-status endpoint + UI polling.** Read-only status inferred from `PlaidItem` fields; client polls and reveals progressive states. Fixes G7, G8.
- **Slice 4 — 30-day snapshot backfill trigger.** Fire backfill after history completes (depends on Snapshot Backfill initiative). Unblocks G5, and thereby G6.
- **Slice 5+ (deferred).** Optional `SyncJob` model; Plaid `SYNC_UPDATES_AVAILABLE` webhook; retry/backoff hardening. Only if a concrete need emerges.

### 4.1 Phase-1 (Slice 1) implementation checklist — for approval

**Decision:** Fast-path split of `POST /api/plaid/exchange-token`. Balances-ready response; full history deferred to a follow-up slice.

**Impact map**
- `app/api/plaid/exchange-token/route.ts` — add `maxDuration`; response shape may gain a `historyPending` flag (additive, optional).
- `lib/plaid/exchangeToken.ts` — `performPlaidTokenExchange` returns after step 8 + 9b (today's snapshot); step 9 (full `syncTransactionsForItem`) is separated behind a param/hook so Slice 2 can attach background continuation. Interim (Slice 1 alone): run a **bounded** initial slice or skip inline history and rely on cron until Slice 2 lands — decision to confirm at approval.
- `context/PlaidContext.tsx` — `onSuccess` unchanged in contract; may read `historyPending` to keep messaging honest.
- No change to `syncTransactionsForItem`, `refreshPlaidItem`, `regenerate.ts`, snapshot readers, or the cron.

**Schema:** None. (Confirmed: state is inferable from existing `PlaidItem.cursor` / `lastSyncedAt` / `status` / `errorCode`.)

**Rollback plan**
- Pure code change on a feature branch, no migration → revert the commit to restore the current monolithic behavior.
- The engine (`syncTransactionsForItem`) and cron are untouched, so even mid-rollback, history still completes via the 06:00 cron — no data loss, no orphaned items.
- Response-shape additions are additive/optional; reverting them cannot break the client (it already tolerates the current fields).

**Validation checklist**
- `npx prisma generate` (no schema change expected — confirm clean).
- `npx tsc --noEmit`.
- `npm run lint`.
- Targeted dev Link run: connect a sandbox institution → assert balances/accounts appear on `/dashboard/accounts` within the fast-path budget; assert today's `SpaceSnapshot` row exists; assert no client "Import failed" on a slow/large institution.
- Confirm history still completes (inline-bounded now, or via cron until Slice 2) — verify `PlaidItem.cursor` advances and `Transaction` rows land.
- Confirm Link failure/cancel paths (`onExit`) and holdings-consent gating are unchanged.

**Stop here — await approval before any code or schema changes.**

---

## 5. Constraints honored

- Reuses the existing sync engine; introduces no parallel transaction pipeline.
- No schema in the recommended path (existing `PlaidItem` fields carry state); any future `SyncJob` is deferred and additive.
- Daily cron preserved as the fallback throughout.
- Additive/orchestration only; nothing may break Link success (holdings + snapshot remain best-effort/non-fatal, as today).
- Does not re-litigate the approved D2.x charter phasing; this doc is the code-grounded confirmation plus the Phase-1 slice checklist.
