# Fourth Meridian — Connections Weirdness Investigation (pre-merge gate for v2.5.5)

**Date:** 2026-07-14
**Type:** Investigation only — no code changes in this pass.
**Trigger:** "Connections is acting weird all around" — the 07-13/14 Amex partial-sync incident (~32 transactions, item stuck, purged via `scripts/purge-plaid-connection.ts`), plus two reactive race fixes landed the same night (`b871093`, `e70e9f8`). This document is the gate before merging `feature/v2.5-spaces-completion` → `main` and cutting `v2.5.5`.
**Companion:** `FOURTH_MERIDIAN_CONNECTION_HEALTH_WALLET_CADENCE_INVESTIGATION_2026-07-13.md` (the CH-x design record this pass re-verifies against what actually shipped).

All citations below were re-verified against the working tree at **`cff0b56`** (HEAD of `feature/v2.5-spaces-completion`, 2026-07-14; branch is fully pushed — `git rev-list origin..HEAD` = 0, so STATUS.md §2's "~15 unpushed commits" note (SC-3) is stale). Full diffs of `b871093`, `e70e9f8`, `1f5039c`, `316b54b`, `2cc5b5c`, `2ecdddd`, `5b220f2`, `cff0b56`, `760cf3c` were read, then the current state of every touched file in full.

---

## 1. Executive summary

**The two overnight race fixes are real, correctly implemented, and worth keeping — but they guard only 2 of the 7 paths that run the same sync engine.** `e70e9f8` routed the connect trigger through the `syncLockedAt` guard the webhook already used, and its own doc-comment now (correctly) declares `syncPlaidItemFromWebhook` "the SHARED guarded entry point … Never call runDeferredHistorySync directly from a request path" (`lib/plaid/webhook-sync.ts:38-44`). That rule is enforced nowhere, and the deeper primitive it wraps — `syncTransactionsForItem` — is still called with **no lock** from five live paths: the manual Sync route, the manual Refresh route (single + bulk), the client auto-resume route, the Investments-enable route, and the daily `sync-banks` cron (§3 map; §4.1). Any of these can run concurrently with a webhook/connect pipeline against the same PlaidItem and reproduce the exact "Amex 363 UPSERT_ERROR / stuck-import" signature the fixes were aimed at. The most probable real-world repro is **the resume poller racing a late `HISTORICAL_UPDATE` webhook during a large first import** — precisely the connect-night scenario (§4.1a).

**Verdict on the incident class: fixed-but-incomplete.** Additionally: `b871093`'s clear-on-success is correct for the stuck-importing bug but has two bounded residuals (a lost "new data arrived mid-run" resume signal, and a stamp-after-release window that can re-create a stale "importing" chip for up to ~24h — §4.2); CH-2's transition chokepoint missed three surviving direct `status`/`errorCode` writes, silently regressing the durable-trail goal on exactly the failure paths most likely to fire during an incident (§5.1); CH-3 and S7+CH-1 shipped essentially as designed (§5.2, §5.3); KD-4's caveat is still accurate and unchanged (§5.4). Neither race fix has any regression test — there is **zero** test coverage of `webhook-sync.ts` (§6).

**Merge posture (§8):** nothing found argues for holding the merge itself — every commit examined is a strict improvement over `main`, `tsc --noEmit` is clean, and the test suite has no assertion failures (§7). The blocking items are for **before the next round of real-institution connect testing / before v2.5.5 is declared "connections stable"**: put the five unlocked triggers behind the shared guard (or consciously accept and track each), and close the three chokepoint-bypass writes. Everything else can ride as tracked residuals.

---

## 2. Confirmed / corrected current state (re-verified citations)

### 2.1 The lock mechanism as it exists today

- `lib/plaid/webhook-sync.ts` — `LOCK_TTL_MS = 180_000` (`:27`), atomic claim via conditional `updateMany` (`:51-54`), skipped-locked branch stamps `syncIncompleteAt = now` for the resume path (`:59-61`), and the `finally` release clears `syncIncompleteAt` together with the lock **only on a successful run** (`:80-86`, the `b871093` fix). The lock claim/release pair is sound in isolation: the claim is a single conditional UPDATE (no read-then-write), and every runtime that can hold it runs under `maxDuration = 60` (exchange-token `:54`, webhook `:32`, dispatch `:42`), comfortably under the 180s stale-TTL — a killed invocation's lock is reclaimable, never a live one's.
- `runDeferredHistorySync` (`lib/plaid/backgroundHistorySync.ts:274-341`) now returns `boolean` (`b871093`): `true` after sync + snapshot backfill + recordSyncComplete (`:295`), `false` from the catch, which also stamps `syncIncompleteAt` (via the CH-2 chokepoint co-write at `:318-322` when the error classifies to a health state, or directly at `:326-329` when transient).
- Both guarded callers confirmed: webhook receiver (`app/api/plaid/webhook/route.ts:94`, codes at `:38-43` incl. `HOLDINGS/DEFAULT_UPDATE` at `:73-75`) and connect trigger (`app/api/plaid/exchange-token/route.ts:108-110`, the `e70e9f8` fix). The OAuth return page is NOT a third connect path — it posts to the same `/api/plaid/exchange-token` (`app/plaid-oauth-return/page.tsx:95-103`), so it inherits the fix.

### 2.2 The engine's own writes

- `syncTransactionsForItem` persists `PlaidItem.cursor` after **every** page (`lib/plaid/syncTransactions.ts:495-498`) and, on loop completion, clears `syncIncompleteAt` + stamps `lastSyncedAt` + re-affirms ACTIVE through the CH-2 chokepoint (`:508-512`). `PlaidItem.lastSyncedAt` has exactly this one writer — single-writer confirmed.
- The `jobs/sync-banks.ts` header still claims the job is "Idempotent and safe to overlap with a user-triggered sync of the same item — both paths upsert on the unique Transaction.plaidTransactionId" (`:16-18`). **This claim is now known false by the repo's own commit history**: `e70e9f8`'s message documents that two concurrent pipelines race `PlaidItem.cursor` and collide on `prisma.transaction.create()`. Stale comment; it materially misdescribes the safety property (§4.1c).

### 2.3 The resume machinery (relevant to both fixes)

- Client: `components/connections/ConnectionsList.tsx` polls `GET /api/sync/status` every 4s while building (`:32-33`), and for a Plaid connection importing ≥ 90s POSTs `/api/plaid/resume-sync` every 30s, max 5 attempts (`:39-41`, `driveResume` `:100-136`). The poller only runs while the Connections page is mounted.
- Server: `app/api/plaid/resume-sync/route.ts` gates on `syncIncompleteAt` age ≥ `RESUME_MIN_AGE_MS = 75_000` (`:41`, `:76-79`), re-arms the marker (`:84-87`), then calls `syncTransactionsForItem(item.id)` **directly** (`:90`) — never touching `syncLockedAt`. Its age-gate rationale ("never collides with the in-flight post-connect sync — that runs within the 60s budget", `:37-41`) predates the webhook path entirely: a webhook can (re)claim the lock at ANY time, including mid-resume (§4.1a).
- "Importing" on the Accounts tab / Connections page is derived solely from `status === ACTIVE && syncIncompleteAt !== null` (`lib/sync/status.ts:131-151`), exactly as STATUS.md describes.

### 2.4 Cadence / config

- `vercel.json:5-6` now carries the multi-slot cron `"0,30 0,6,7,12,18 * * *"` → `/api/jobs/dispatch`. This covers every registered slot: sync-crypto `[0,6,12,18]:00` (`lib/jobs/registry.ts:124-130`), sync-banks 06:00 (`:92-97`), fx + security-prices 06:30, deletions 07:00, maintenance 07:30. It also fires at 00:30/12:30/18:30, slots with no registered job — the dispatcher no-ops there (harmless, three wasted invocations/day).
- `app/api/jobs/dispatch/route.ts:4-11` still documents the **Hobby-tier single daily cron as the active schedule** — stale since `2cc5b5c`; the file's own "restored when off Hobby" sentence is now the reality and the header should say so.

---

## 3. Complete current write-site map — `PlaidItem` / `Connection` status·lock·cursor fields

Every write site in `app/ lib/ jobs/` (scripts excluded; they are operator-run). "Guarded" = executes only while holding `syncLockedAt`.

### 3.1 `PlaidItem`

| # | Site | Fields | Safety |
|---|---|---|---|
| 1 | `lib/plaid/webhook-sync.ts:51-54` | `syncLockedAt` (claim) | ✅ atomic conditional update — the guard itself |
| 2 | `lib/plaid/webhook-sync.ts:59-61` | `syncIncompleteAt` (skipped-locked stamp) | ⚠️ by design outside the lock; residual windows in §4.2 |
| 3 | `lib/plaid/webhook-sync.ts:80-86` | `syncLockedAt` + `syncIncompleteAt` (release/clear) | ✅ lock-holder only |
| 4 | `lib/plaid/syncTransactions.ts:495-498` | `cursor` (per page) | ⚠️ safe **only if** the caller holds the lock — true for 2 of 7 callers (§4.1) |
| 5 | `lib/plaid/syncTransactions.ts:508-512` | `status/errorCode` + `cursor/lastSyncedAt/syncIncompleteAt` via `setPlaidItemHealth` | ✅ chokepoint; same caller caveat as #4 |
| 6 | `lib/plaid/exchangeToken.ts:181-198` | upsert: `encryptedToken`, `syncIncompleteAt` (birth/relink stamp) | ✅ single connect flow; benign vs. lock (§4.3) |
| 7 | `lib/plaid/exchangeToken.ts:203` | `status ACTIVE, errorCode null` via chokepoint | ✅ CH-2 |
| 8 | `lib/plaid/exchangeToken.ts:445-455, 546-560` | `investmentsConsent` | ✅ non-health |
| 9 | `lib/plaid/refresh.ts:257-260, 380-393` | `investmentsConsent` | ✅ non-health |
| 10 | `lib/plaid/refresh.ts:671` (batch-failure) | `status/errorCode` via chokepoint | ✅ CH-2 |
| 11 | `app/api/plaid/refresh/route.ts:86` | `status/errorCode` via chokepoint | ✅ CH-2 |
| 12 | `jobs/sync-banks.ts:77` | `status/errorCode` via chokepoint | ✅ CH-2 |
| 13 | `lib/plaid/backgroundHistorySync.ts:318-329` | `status/errorCode` via chokepoint (+`syncIncompleteAt` co-write), or `syncIncompleteAt` alone | ✅ CH-2 |
| 14 | `lib/plaid/disconnect.ts:49` | `status REVOKED` via chokepoint | ✅ CH-2 |
| 15 | **`app/api/plaid/sync/route.ts:109-111`** | **direct** `status/errorCode` | ❌ bypasses CH-2 chokepoint — no transition row (§5.1) |
| 16 | **`app/api/plaid/resume-sync/route.ts:97-100`** | **direct** `status/errorCode` | ❌ bypasses CH-2 chokepoint (§5.1) |
| 17 | **`app/api/plaid/investments/enable/route.ts:87-90`** | **direct** `status/errorCode` | ❌ bypasses CH-2 chokepoint (§5.1) |
| 18 | `app/api/plaid/resume-sync/route.ts:84-87` | `syncIncompleteAt` (re-arm) | ⚠️ unlocked writer to the resume marker; interacts with #3 (§4.2) |
| 19 | `lib/plaid/refreshCooldown.ts:49-52, 58-61` | `lastManualRefreshAt` | ✅ cooldown-only field, two manual routes only (module header `:4-9` confirmed) |
| 20 | `lib/account-deletion/purge.ts:95` | direct `status REVOKED` | ✅-ish: deliberate (row is cascade-deleted moments later, comment `:92-94`); no transition row, acceptable |

`lib/providers/plaid/adapter.ts:22` re-exports `syncTransactionsForItem` but has **zero importers** — a dormant seam, not a live unlocked path.

### 3.2 `Connection`

| # | Site | Fields | Safety |
|---|---|---|---|
| 1 | `lib/connections/health-transitions.ts:123-128` | `status/errorCode/lastSyncedAt` (wallet chokepoint) | ✅ CH-2; both legacy wallet helpers now delegate here (`lib/accounts/wallet-connection.ts:110, 125`) |
| 2 | `lib/plaid/exchangeToken.ts:228-244` | PLAID mirror row: `credential, status ACTIVE, errorCode null` (create/update) | ⚠️ write-only mirror: **no failure path ever flips it**, so it drifts stale-ACTIVE forever. Harmless today because every health read excludes `Connection(provider=PLAID)` (§5.3), but it is a trap for any future reader |
| 3 | `lib/crypto/btc-sync.ts:418` | `cursor` (xpub discovery checkpoint) | ⚠️ no wallet-level lock exists; overlap now possible cron × manual (§4.5) |
| 4 | `lib/accounts/wallet-connection.ts:64-73` | create (WALLET, ACTIVE) | ✅ find-or-create; documented rare double-add accepted (`:44-48`) |

**Bottom line of the map:** health/status writes are now ~90% funneled through the CH-2 chokepoint (3 stragglers), `lastSyncedAt`/`lastManualRefreshAt` are single-purpose and safe, and the remaining raciness is concentrated in exactly one place: **`cursor` + the transaction upserts, whose safety depends entirely on which caller invoked the engine** — the subject of §4.1.

---

## 4. Findings

### 4.1 F1 — the `e70e9f8` lock covers 2 of 7 trigger paths (fixed-but-incomplete; NEW sibling races)

All seven current callers of the sync engine:

| Trigger | Path | Locked? |
|---|---|---|
| Plaid webhook | `webhook/route.ts:94` → `syncPlaidItemFromWebhook` | ✅ |
| Connect (incl. OAuth return) | `exchange-token/route.ts:109` → `syncPlaidItemFromWebhook` | ✅ (e70e9f8) |
| Client auto-resume | `resume-sync/route.ts:90` → `syncTransactionsForItem` | ❌ |
| Manual "Sync Now" | `sync/route.ts:100` → `syncTransactionsForItem` | ❌ |
| Manual "Refresh" (single + bulk) | `refresh/route.ts:70,131` → `refreshPlaidItem` → `syncTransactionsForItem` (`refresh.ts:412`) | ❌ |
| Investments enable | `investments/enable/route.ts:81` → `refreshPlaidItem` | ❌ |
| Daily cron | `jobs/sync-banks.ts:64` → `syncTransactionsForItem` | ❌ |

(The admin Expand-History flow also syncs inline via `performPlaidTokenExchange(deferHistorySync:false)` → `exchangeToken.ts:593` — an eighth, admin-only unlocked path.)

Each unlocked caller can run concurrently with a lock-holding webhook/connect pipeline (the lock is advisory — non-holders don't check it), racing `PlaidItem.cursor` (map #4) and colliding on `transaction.create()`. Concrete reachable scenarios, most→least likely:

- **(a) Resume × late webhook — the highest-probability repro of the original incident.** Large first import blows the 60s connect budget → item stays `importing` (cursor persisted per page). At +90s the ConnectionsList poller fires resume; resume checks only marker-age (75s, `resume-sync/route.ts:76-79`) — the lock is free (the killed run's `finally` released it, or TTL) — and starts a 60s unlocked engine run. Plaid's `HISTORICAL_UPDATE` for a 2-year window routinely lands 1–5 minutes post-connect, i.e. **inside that window**; the webhook claims the (free) lock and runs the full pipeline concurrently. Two engine loops, one item: the Amex signature, still fully reachable after both fixes. The resume route's anti-collision comment (`:37-41`) reasons only about the post-connect run, not about webhooks — it was written before the webhook receiver existed.
- **(b) Investments-enable × HOLDINGS webhook.** Granting Investments consent makes Plaid fire `HOLDINGS/DEFAULT_UPDATE` "once holdings are ready" (webhook route `:66-75`) — seconds after the same consent flow's client calls `/api/plaid/investments/enable`, which runs an unlocked `refreshPlaidItem` (`enable/route.ts:81`). These two are near-synchronized by construction.
- **(c) Cron × webhook.** `sync-banks` iterates every ACTIVE item unlocked at 06:00; any webhook arriving during an item's turn runs concurrently (the webhook's claim succeeds — nobody holds the lock). Its "safe to overlap" header (`jobs/sync-banks.ts:16-18`) is stale and wrong (§2.2).
- **(d) Manual refresh/sync × anything.** The 60-min cooldown (`refreshCooldown.ts:19`) throttles frequency but is orthogonal to concurrency — and a **freshly connected** item has `lastManualRefreshAt = null`, so it is off-cooldown at the exact moment its background history import is running. A user who connects and immediately hits Refresh races their own import. Note `useManualRefresh` will then report "Synced ✓" (§4.6).

**Severity: HIGH (the core "connections acting weird" mechanism).** Consequences when hit: `UPSERT_ERROR` SyncIssue rows, duplicate/lost-page cursor advancement, partial imports needing the purge script. Fix shape is already established by `e70e9f8` itself: route the five paths through `syncPlaidItemFromWebhook` (or extract the claim/release into a `withPlaidItemSyncLock(itemId, fn)` helper so refresh-flavored callers can wrap `refreshPlaidItem` without adopting the full deferred pipeline). The resume route's "skipped-locked" outcome should map to `{ resumed: false, reason: "in-flight" }`; the cron's to skip-and-continue.

### 4.2 F2 — `b871093` residuals: the clear-on-success can eat a real resume signal, and a stamp can still land with no clearer

The skipped-locked stamp (`webhook-sync.ts:59-61`) conflates two meanings: (i) "duplicate delivery of work the holder is already doing" (safe for the holder to clear) and (ii) "a NEW `SYNC_UPDATES_AVAILABLE` arrived after the holder's transactionsSync loop already finished its cursor walk" — new data the holder's run does **not** include (its final pipeline stages — snapshot backfill, reconstruction, price backfill, wealth regen — run for tens of seconds after the cursor walk, `backgroundHistorySync.ts:283-295`). The holder's success clears both indiscriminately (`:80-86`), so in case (ii) the announced data waits for the next trigger (next webhook or the 06:00 cron). No data loss (cursor semantics), but up to ~24h freshness delay with the UI reading "ready". **LOW-MEDIUM.** Textbook fix, if wanted: re-check-before-release ("was a stamp written after my claim? → loop the cursor sync once more"), rather than distinguishing stamp provenance.

Second residual: a loser that fails the claim while the holder is in its `finally` can write its stamp (`:59-61`) **after** the holder's release+clear (`:80-86`) — a stamp with no clearer again. Bounded: the ConnectionsList poller (if the page is open) resumes it in ~90s+, else the 06:00 cron's completing run clears it (`syncTransactions.ts:508-512`); worst case is a wrong "importing" chip for up to ~24h, not forever. **LOW.** (For completeness: `b871093` correctly killed the *unbounded* version of this.)

### 4.3 F3 — three uncoordinated writers to `syncIncompleteAt` outside the lock

Sites #2, #6, #18 of the map (skipped-locked stamp, connect-upsert birth stamp, resume re-arm) all write the resume marker without holding the lock while site #3/#5 clear it from inside. Interleavings are individually benign (worst cases: a resume double-fires one budget later; a marker clears one run early — same shapes as §4.2) but the field now has 5 writers and 2 clearers spread over 4 files, and every new trigger path multiplies interleavings. Not separately actionable beyond F1/F2; recorded so the next change to any of these files sees the whole set. **INFO.**

### 4.4 F4 — duplicate-institution guard (`5b220f2`): correct for its target, two edges noted

Re-verified at `lib/plaid/exchangeToken.ts:155-169`: a fresh Link session for an institution with an ACTIVE item under a different `item_id` throws `DuplicateInstitutionError` → 409 (route `:126-129`), with best-effort `itemRemove` of the just-created item. Two edges, both accepted-by-design but worth knowing during "weirdness" triage:

- The gate is `findFirst`-then-throw (check-then-act) with no unique constraint on (userId, institutionId, ACTIVE) — two truly concurrent connects of the same institution can both pass. Window is a sub-second double-Link; **LOW**, note-only.
- The gate matches `status: ACTIVE` only — deliberately, so a NEEDS_REAUTH/ERROR/REVOKED institution can be freshly reconnected. Side effect: an item **stuck ACTIVE-but-importing** (the Amex state) blocks its own clean reconnect with a 409 pointing at "refresh it instead", whose manual refresh is itself part of the race surface (§4.1d). That is a plausible contributor to why the stuck Amex item "couldn't be cleaned up by a normal disconnect/reconnect" and needed `purge-plaid-connection.ts`. Once F1 lands, the stuck state itself should stop occurring; no separate change recommended.

### 4.5 F5 — wallet sync has no per-wallet lock; CH-3's cron makes overlap newly possible

`syncAllBtcWallets` processes wallets serially within a sweep (`btc-sync.ts:615`), but nothing guards a **cron sweep × manual resync** overlap on the same wallet (manual route `app/api/accounts/[id]/sync/route.ts:58`; cron 4×/day since `2cc5b5c`). Concurrent `syncBtcWallet` runs can interleave the xpub discovery checkpoint read→write on `Connection.cursor` (`btc-sync.ts:418`) — last-writer-wins on a monotonic checkpoint, so progress can be *repeated*, not lost, and balance writes converge. **LOW**; no action needed for v2.5.5, but if wallet triggers multiply, give wallets the same claim-style guard shape.

### 4.6 F6 — user-facing honesty gaps around the same state (the `cff0b56` question answered)

- `useManualRefresh` (`components/plaid/useManualRefresh.ts:89-115`) is now honest about **cooldown** — but cooldown (`lastManualRefreshAt`) is completely disjoint from the lock/import state (`syncLockedAt`/`syncIncompleteAt`). Refreshing during a first import (item off-cooldown — §4.1d) both *races the import* and then reports **"Synced ✓"** while the item is genuinely mid-import/mid-race. The hook can't see this because the refresh route's 200 body carries no per-item importing/in-flight signal. If F1 adds a `skipped: "in-flight"` result shape (mirroring `skipped: "cooldown"`), the hook needs one more branch — that pairing is the honest completion of `cff0b56`. **MEDIUM (UX-honesty).**
- Wallet state divergence: the Accounts/Connections surface derives `ready` for any ACTIVE wallet with a non-null `lastSyncedAt` **before** checking `errorCode` (`lib/sync/status.ts:202-215` — errorCode only matters when `lastSyncedAt` is null, i.e. first sync), while the Platform-Ops widget derives `DEGRADED` for the same row (`lib/connections/health.ts:76-89`). A wallet that synced once and has been failing ever since shows "ready" to the member and DEGRADED to the operator, indefinitely. Deliberate for first-sync UX, but the "persistently failing after first success" case looks unintended. **LOW-MEDIUM.**
- `getConnectionHealth` includes REVOKED PlaidItems forever (`health.ts:141-143` has no status filter; REVOKED ranks severity 4 of 5, `:66-68`) — every normally-disconnected bank permanently occupies the widget's "unhealthy" list. Matches the CH-1 plan's letter; probably not its spirit. **LOW.**

### 4.7 F7 — `setPlaidItemHealth` compare is read-then-write

`health-transitions.ts:61-76` reads prior state, writes, then decides "changed?" from the stale read — two concurrent failure writers can produce a duplicate or missed transition row. The 07-13 investigation §5 explicitly accepted this ("worst case: a duplicate transition row") — confirmed still the right call at this frequency. **INFO, accepted.**

---

## 5. Verdicts on the "already known" items

### 5.1 CH-2 (`316b54b`) — durable transition chokepoint: **fixed-but-incomplete (3 surviving bypass sites)**

The commit converted exactly the nine sites the 07-13 map named (verified in the current tree — map rows 5, 7, 10–14, plus both wallet helpers now delegating at `wallet-connection.ts:110, 125`; the two AuditActions exist at `lib/audit-actions.ts:129-130`). But the 07-13 map itself was incomplete: three pre-existing failure-path writes were never on it and still bypass the chokepoint —

1. `app/api/plaid/sync/route.ts:109-111` (manual Sync Now failure),
2. `app/api/plaid/resume-sync/route.ts:97-100` (resume failure),
3. `app/api/plaid/investments/enable/route.ts:87-90` (investments-enable failure).

Each writes `status/errorCode` with **no transition row**, on precisely the paths that fire during incidents — so the "NEEDS_REAUTH since …" figure the CH-1 widget renders can be silently wrong whenever the flip came via one of these. Three mechanical one-line conversions (`setPlaidItemHealth(...)` — the identical pattern of map rows 11/12). (`lib/account-deletion/purge.ts:95` also bypasses, deliberately and acceptably — map #20.)

### 5.2 CH-3 (`2cc5b5c`) — crypto cadence + manual-resync limit: **confirmed shipped; one config caveat, one stale header**

- Registry entry confirmed (`lib/jobs/registry.ts:124-130`, `hourUTC: [0,6,12,18]`, `expectedEveryHours: 6`); stale R7 "DELIBERATELY NOT HERE" note retired (`:55-56` now lists only run-ai-advice/take-snapshot); `vercel.json:5-6` carries the multi-slot cron and covers every registered slot (§2.4).
- Manual-resync rate limit confirmed: `limitByUser(user.id, "wallet-resync", { limit: 6, windowSec: 3600 })`, SYSTEM_ADMIN exempt (`app/api/accounts/[id]/sync/route.ts:40-43`) — closing the 07-13 doc's "ZERO cooldown, unconditional" finding.
- **The Vercel plan upgrade cannot be verified from the repo** (nothing in `.env.local`/`.env.preview`/`vercel.json` encodes the tier; `.env.preview` carries no cron/BTC/wealth keys at all). The failure mode is not silent, though: per the dispatch route's own research (`dispatch/route.ts:4-11`), Hobby **rejects sub-daily cron at deploy time** — so if the upgrade didn't happen, the first deploy of this branch fails loudly rather than the cadence quietly not firing. Also note the 6-hourly cadence is not live in production until this branch actually deploys, regardless of tier. **Action: confirm plan + watch the first deploy; then fix the stale Hobby-era header comment in `dispatch/route.ts:4-11`.**

### 5.3 Wave 2 S7 + CH-1 (`2ecdddd`) — double-counting: **confirmed handled**

`lib/connections/health.ts` takes Plaid rows **only** from `PlaidItem` and `Connection` rows only where `provider NOT IN (PLAID, MANUAL, CSV)` (`:140-149`); the route is a thin authorized wrapper (`app/api/platform/platform-ops/connection-health/route.ts:26-31`); the widget consumes the normalized shape. The member-facing surface likewise never unions: Plaid from `PlaidItem` (`app/api/sync/status/route.ts:52`), wallets from `Connection(provider=WALLET)` (`lib/sync/wallet-connections.ts:30-35`). The `Connection(provider=PLAID)` mirror row is consumed by **nothing** — it is a write-only drift trap (§3.2 #2); a one-line doc-comment on the mirror write (`exchangeToken.ts:211-216`) saying "never read for health" would cheaply inoculate future readers. Residual widget nits in §4.6.

### 5.4 KD-4 caveat — **confirmed unchanged and still accurately described**

`exchangeToken.ts:364-423`: FinancialAccount resolve/create stays outside the `db.$transaction` that atomically upserts AccountConnection + SpaceAccountLink (`:374-423`), because `resolveAccountByFingerprint` self-manages an interactive transaction (`:365-368`). Orphan window: FA written, then the tx fails → FA with no AC/SAL; self-heals on retry via identity/fingerprint reuse (`:270-321`). Nothing this month made it worse; nothing fixed it. Still low-severity, still correctly caveated in STATUS.md. No action for v2.5.5.

### 5.5 The incident tooling (`760cf3c` → `1f5039c`, untracked scripts) — **consistent with the above diagnosis**

`scripts/dev-reset-test-state.ts` now also discovers/deletes non-Plaid connections (1f5039c's Step 1b — verified in the current file, `provider: { not: "PLAID" }` at `:133`). The untracked `scripts/purge-plaid-connection.ts` header documents exactly why the normal lifecycle couldn't clean the Amex item (soft-delete doesn't cascade transactions; stale partial rows would collide with a clean resync) — consistent with §4.4's observation that a stuck-ACTIVE item also can't be freshly reconnected past the duplicate gate. The recurrence these tools imply is explained by F1: the unlocked-concurrency class was (and partially remains) reachable from everyday triggers. `scripts/dev-reset-after-amex-test.ts` and `purge-plaid-connection.ts` are still **untracked** — commit or discard before cutting v2.5.5 so the release branch is reproducible.

---

## 6. Test coverage of the race fixes: **zero**

There is no `lib/plaid/webhook-sync.test.ts` — no test imports `syncPlaidItemFromWebhook` or exercises `syncLockedAt` claim/skip/release, the skipped-locked stamp, or the `b871093` clear-on-success (repo-wide grep over `*.test.ts`: only `lib/sync/status.test.ts` mentions `syncIncompleteAt`, for chip derivation). Both overnight fixes shipped untested; a regression (e.g. someone "simplifying" the connect trigger back to `runDeferredHistorySync`) would be caught by nothing. The house style supports a cheap guard: a source-scan test asserting no file under `app/` imports `runDeferredHistorySync`/`syncTransactionsForItem` except the sanctioned modules (the `AccountsPerspective.test.ts` pattern), plus a unit test over a fake-db harness for claim/skip/release + the ok/!ok release shapes. **Recommended alongside F1's fix.**

## 7. tsc / test status (merge signal)

- `npx tsc --noEmit`: **clean, 0 errors** (after `prisma generate`; verified at `cff0b56`).
- `npm test` (`scripts/run-tests.ts`, 215 files): **202/215 passed in this sandbox; all 13 failures are environmental, zero assertion failures.** Each failing file dies with `PrismaClientInitializationError` — the generated client needs the `debian-openssl-3.0.x` query engine, and `binaries.prisma.sh` is unreachable from this environment (403), so the darwin-arm64 engine from the dev machine can't be substituted. The 13 are exactly the DB-enum/PrismaClient-touching suites (investments pipeline/ingest/capture, `transactions.kd17`, etc.). **Run `npm test` once locally to confirm 215/215 before tagging** — expected green given the suite was 200/200 on 07-13 and every commit since reports suite-green.

## 8. MERGE-BLOCKING vs SAFE-TO-DEFER

Framing honestly: `main` is strictly behind this branch, and every examined commit improves it, so **merging the branch is not itself risky** — the risk is declaring connections stable and testing more real institutions on v2.5.5 with the F1 surface open. Conservative split:

**Must fix before v2.5.5 is exercised against real institutions (blocking the "connections are fixed" claim, if not the literal merge):**

1. **F1** — route the five unlocked triggers (resume-sync, sync, refresh single+bulk, investments-enable, sync-banks) through the shared `syncLockedAt` guard; map "skipped-locked" to honest per-route results. Without this, last night's incident class remains reachable from the resume poller and the Investments flow on the very next big connect. (§4.1)
2. **§5.1** — the three chokepoint-bypass status writes (three one-line conversions). Cheap, and incident forensics depend on them.
3. **§6** — the source-scan + lock unit tests, landed with (1) so it can't regress silently.
4. **Ops checklist items:** confirm the Vercel plan upgrade before the first deploy of this branch (deploy fails loudly on Hobby — §5.2); run `npm test` locally for the 215/215 confirmation (§7); commit-or-discard the two untracked scripts (§5.5).

**Safe to defer as tracked residuals (none block the tag):**

- F2 lost-resume-signal + stamp-after-release windows (bounded by cron; revisit as "re-check before release" alongside F1). (§4.2)
- F6 UX honesty: `useManualRefresh` "in-flight" phase (pairs naturally with F1's route change); wallet ready-despite-errorCode divergence; REVOKED rows cluttering the ops widget. (§4.6)
- F5 wallet-level lock. (§4.5)
- Stale comments: `jobs/sync-banks.ts:16-18` "safe to overlap" (actively misleading — cheap to fix with F1), `dispatch/route.ts:4-11` Hobby header, STATUS.md SC-3 unpushed-commits note.
- Mirror-row doc-comment (§5.3); duplicate-gate check-then-act note (§4.4); F3/F7 recorded-only items.

---

## 9. What was checked and found NOT wrong (explicitly)

- The lock claim itself (atomic conditional update, TTL vs. every holder's `maxDuration`) — sound. (§2.1)
- OAuth return as a hypothesized third connect path — it isn't one; it posts to the guarded exchange-token route. (§2.1)
- Plaid/wallet double-counting in both health surfaces — correctly normalized everywhere read today. (§5.3)
- `PlaidItem.lastSyncedAt` / `lastManualRefreshAt` — single-writer / two-manual-routes-only, exactly as designed. (§3.1 #19, §2.2)
- CH-3's registry/cron/rate-limit mechanics — shipped as designed, including the dead-job `expectedEveryHours`. (§5.2)
- KD-4 — unchanged, caveat accurate. (§5.4)
- `tsc` and the test suite — no code-level failures. (§7)

*Stop point: investigation only. No code, schema, STATUS, or script changes were made in this pass.*
