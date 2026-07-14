# Fourth Meridian — Connection Health, Wallet Wiring & Sync Cadence Investigation + Plan

**Date:** 2026-07-13
**Type:** Investigation + implementation plan only — no code changes in this pass.
**Scope:** Platform Ops connection-health visibility · durable status-transition history · crypto/BTC sync cadence + manual-resync cooldown.
**Companion:** `FOURTH_MERIDIAN_GROWTH_SECURITY_PLATFORM_INVESTIGATION_2026-07-13.md` (already complete). **§7 of this document is the final reconciled slice/wave plan merging both scopes — it supersedes that document's §8 wave grouping as the sequencing source of truth.**

All citations below were re-verified against the working tree on 2026-07-13 (fresh snapshot taken for this pass), per the investigation discipline — including every citation supplied in the prompt.

---

## 1. Executive summary

The prompt's corrected picture **holds on re-verification, with two additions**. Wallets are indeed fully wired into the health model at the write layer (`Connection` rows created and status-touched by `lib/accounts/wallet-connection.ts` and `lib/crypto/btc-sync.ts`); the gap is entirely read/surfacing-side — **zero** `PlaidItem`/`Connection` reads exist anywhere under `app/api/platform/` or `components/platform/` (grep: no matches). The two additions:

1. **Plaid connections exist in BOTH tables.** `lib/plaid/exchangeToken.ts:212-227` dual-writes a `Connection(provider=PLAID)` row alongside the authoritative `PlaidItem`. Any health query that naively unions the two tables double-counts every bank. The normalization layer must take `PlaidItem` as authoritative for Plaid and `Connection` rows only for `provider != PLAID` (§4.2).

2. **The real bound on crypto cadence is not the explorer API — it's the deploy tier, and Chris has resolved it.** `app/api/jobs/dispatch/route.ts:4-11` documents that the **Vercel Hobby plan rejects sub-daily cron at deploy time**; the single cron fires once daily at 06:00 UTC and the dispatcher's slot model covers half-hour slots that one daily tick can only reach one of. mempool.space's rate limits are deliberately undisclosed (maintainer: "if you have to ask then you will hit them"; official guidance for applications is to run your own node — which `BTC_EXPLORER_BASE_URL` already supports as an env override), and the code already carries full 429/503 exponential backoff honoring `Retry-After` (`lib/crypto/btc-explorer.ts:139-175`). At beta scale the request volume of even a 4×-daily sweep is trivial against any plausible explorer limit — the recommendation (§6) is **every 6 hours as the target cadence**. **Decided: Chris is upgrading the Vercel plan**, so this ships as a native multi-slot `vercel.json` cron entry — no `CRON_SECRET`-guarded per-job route or external scheduler is needed (that workaround, described in the original investigation, is dropped from scope).

On transition history (§5): `AuditLog` is the right home — new `AuditAction` values written only-on-change from a small chokepoint helper, replacing the seven near-identical `db.plaidItem.update` status writes that today record nothing durable. No new table is justified.

---

## 2. Confirmed / corrected current state (re-verified citations)

### 2.1 Schema — all prompt citations confirmed

- `PlaidItem` (`prisma/schema.prisma:647-688`): `status PlaidItemStatus @default(ACTIVE)`, `errorCode`, `lastSyncedAt`, `syncIncompleteAt` (D2.x resume marker), `syncLockedAt` (webhook concurrency guard), `lastManualRefreshAt` (cooldown-only field, "the scheduler never reads or writes this field"). Enum `PlaidItemStatus` `ACTIVE|NEEDS_REAUTH|ERROR|REVOKED` (`:65-70`).
- `Connection` (`prisma/schema.prisma:702-727`): `provider ProviderType`, `status ConnectionStatus @default(ACTIVE)`, `cursor`, `errorCode`, `lastSyncedAt`. `ConnectionStatus` mirrors the 4-value shape (`:90-95`); `ProviderType` includes `WALLET` (`:100-107`). The authoritative-truth comment is confirmed at `:709-711`: "status / lastSyncedAt / errorCode are the authoritative record of a connection's sync health (WALLET included, v1.5). The AccountConnection.syncStatus / lastSyncedAt fields only MIRROR this."
- **Stale-comment finding:** the enum doc comments at `:87-89` and `:97-99` still say "Not yet used by any application code" — false since v1.5 wallet wiring and the PLAID dual-write. Cosmetic; the implementing slice should fix them in passing.
- `SyncIssue` (`prisma/schema.prisma:2401-2427`): forensic side-table, confirmed; BTC writes it with `provider: "WALLET"` and `detail: { chain: "BTC", stage, … }` (`lib/crypto/btc-sync.ts:400-414` — the prompt's `:118` pointer is the module's usage region; the actual `recordBtcSyncIssue` write body sits at `:400-414` in the current tree).

### 2.2 Wallet wiring — the prompt's correction HOLDS

- `ensureWalletConnection` (`lib/accounts/wallet-connection.ts:48-73`): find-or-create `Connection(provider=WALLET, credential=address)`, `status: ACTIVE`.
- `touchWalletConnectionStatus` (`:99-114`): success → `status ACTIVE, lastSyncedAt now, errorCode null`; failure → **`errorCode` only** — deliberately does NOT flip status to `ERROR` ("that enum means 'unrecoverable'"; a transient explorer failure is recoverable) and does not touch `lastSyncedAt`. This matters for §4/§5: for wallets, "unhealthy" is `errorCode != null`, not `status != ACTIVE`.
- `clearWalletConnectionError` (`:123-132`) clears a stale error during xpub discovery progress without marking synced.
- `alignWalletProviderSpine` (`:163-213`) is the self-healing spine backfill; `lib/crypto/btc-sync.ts:418` persists the xpub discovery cursor onto `Connection.cursor`.

So: **write-side wiring is complete; the gap is 100% read/surfacing** — confirmed.

### 2.3 Platform-side read gap — confirmed exactly as stated

- PO1.2 widgets (`components/platform/PlatformSpaceDashboard.tsx:43-56`): `ops_job_health` (JobRun), `ops_rate_limits` (RateLimit), `ops_env_status` (validateEnv report). None read connection tables.
- PO1.4 `cs_sync_issues` (`app/api/platform/customer-success/sync-issues/route.ts:45-63`): `db.syncIssue` only — count + groupBy(kind) + recent rows with `detail` deliberately excluded from the response.
- Fresh grep across `app/api/platform/**` and `components/platform/**` for `plaidItem`/`.connection.`: **zero matches.** No per-item/per-wallet health surface exists anywhere on the platform side.

### 2.4 State-transition write sites — the complete map (prompt cited one; there are seven Plaid + two wallet)

`PlaidItem.status` is written at:

1. `lib/plaid/refresh.ts:668-671` — multi-item batch failure branch → `health.status` (+ `notifyItemSyncFailed` at `:673`). *(The prompt's `:666-671` citation confirmed, ±2 lines.)*
2. `app/api/plaid/refresh/route.ts:82-89` — manual refresh failure → `health.status` (+ notify).
3. `jobs/sync-banks.ts:73-81` — scheduled job failure → `health.status` (+ notify).
4. `lib/plaid/backgroundHistorySync.ts:302-312` — deferred history-sync failure → `health.status` (+ notify).
5. `lib/plaid/syncTransactions.ts:494-511` — **success/recovery**: `status: ACTIVE, errorCode: null` (`:505`) + `retireItemSyncFailure` (`:511`).
6. `lib/plaid/exchangeToken.ts:182` — relink/update-mode → `ACTIVE, errorCode null` (+ retire at `:198`); the PLAID `Connection` mirror row is reset at `:217-220`.
7. `lib/plaid/disconnect.ts:45` — → `REVOKED`.

Wallet `Connection` health writes: `touchWalletConnectionStatus` and `clearWalletConnectionError` (§2.2) — two sites, one file.

**None of the nine sites writes any durable transition record.** `AuditLog` in the sync domain is written only on successful history-sync completion (`PLAID_HISTORY_SYNCED`, `lib/plaid/backgroundHistorySync.ts:247-255` — confirmed) and by manual-action routes (`PLAID_SYNC`/`PLAID_REFRESH`, `lib/audit-actions.ts:113-114`). A healthy→broken or broken→healthy flip leaves no trace beyond the overwritten live column — confirmed exactly as the prompt states.

**Useful discovery for §5:** the OPS-3 sync-notification pair already *observes* both transition directions — `notifyItemSyncFailed` (suppress-deduped `SYNC_FAILED`, `lib/plaid/sync-notifications.ts:99`) at every failure site, and `retireItemSyncFailure` (`:111-126`) at the two recovery sites. The transition-history writes slot in at exactly the same nine points, and four of the seven Plaid sites are byte-identical `classify → update → notify` triples that a shared helper would also de-duplicate.

### 2.5 Sync cadence — prompt corrections confirmed, plus the tier constraint

- Plaid: daily cron 06:00 UTC — `sync-banks` registered at `lib/jobs/registry.ts:73-78` (the prompt's `:73-80` range confirmed), fired through the single dispatcher cron (`vercel.json` crons: exactly one entry, `/api/jobs/dispatch` at `0 6 * * *`); webhook-triggered syncs serialized by the 3-minute stale-lock TTL (`lib/plaid/webhook-sync.ts:27` `LOCK_TTL_MS = 180_000`, atomic claim at `:43-46`); manual refresh gated by the 1-hour per-item cooldown (`lib/plaid/refreshCooldown.ts:19` `MANUAL_REFRESH_COOLDOWN_MS`, pure check at `:31-40`), which by construction never touches the scheduled job (imported only by the two manual routes — module header `:4-9`).
- Crypto: **no cron entry at all** — `lib/jobs/registry.ts:42-43` "DELIBERATELY NOT HERE (S0 rulings): … run-ai-advice, sync-crypto, take-snapshot (v2.6b / deferred — R7)". `jobs/sync-crypto.ts:9-18` confirms the only triggers are run-on-add and manual re-sync, and that the body is deliberately kept registry-ready ("a future registry entry (one line, same shape as sync-banks…) is trivial").
- Manual wallet re-sync `POST /api/accounts/[id]/sync` (`app/api/accounts/[id]/sync/route.ts:22-59`): `requireUser` + owner check + BTC-only guard, then `syncBtcWallet(id)` **unconditionally — zero cooldown, zero rate limit** (no `limitByUser`/`limitByIp` import anywhere in the file). Confirmed.
- **R7's deferral reason is stale for `sync-crypto`.** The ruling (`docs/initiatives/ops4/OPS4_S0_RULINGS.md:18`) reads: "AI scheduling remains out of scope. run-ai-advice.ts / sync-crypto.ts / take-snapshot.ts **stubs** … No stub gains a body in OPS-4 S1." At ruling time (07-07) `sync-crypto` was an empty stub. It has since become the working BTC wallet-sync body (v1 shipped; STATUS.md's KD-14 row already records this: "not a stub … deliberately unregistered … per R7, not because it is unfinished"). The *reason* — don't give bodies to stubs mid-OPS-4 — no longer applies; only the registry line was ever deferred. Registering it now is a one-line change the job file itself anticipates.
- **The binding scheduling constraint is the Vercel plan, not the registry.** `app/api/jobs/dispatch/route.ts:4-11`: "On the current Vercel Hobby (free) tier, **sub-daily cron is rejected at deploy time**, so the active schedule is once per day… The richer paid-tier schedule ('0,30 6-7 * * *' …) is restored when off Hobby." Any sub-daily crypto cadence therefore cannot come from `vercel.json` today, regardless of registry design. The escape hatch already exists as a pattern: per-job CRON_SECRET-guarded routes (`app/api/jobs/sync-banks/route.ts:11-16` documents the exact auth contract) that anything — including an external scheduler — can hit.

### 2.6 Explorer APIs — actual constraints (researched, not assumed)

`lib/crypto/btc-explorer.ts` calls **two** keyless services:

- **mempool.space** (default, env-overridable `BTC_EXPLORER_BASE_URL`, `:43-46`): per-address confirmed balance (`/api/address/{addr}`), BTC/USD price (`/api/v1/prices`), and transactions. Its public-API rate limits are **deliberately undisclosed** — the maintainer's on-record position is "Our API limits aren't disclosed, basically because if you have to ask then you will hit them," with official guidance that applications should run their own instance/node ([mempool discussion #752](https://github.com/mempool/mempool/discussions/752)); enterprise tiers exist for higher limits. The env override means a self-hosted instance is a config change, not a code change.
- **blockchain.info** (`BTC_BATCH_API_URL`, `:210`) for xpub discovery batches — `/multiaddr` with `BATCH_CHUNK = 50` addresses per request (`:214,246-256`). Its current public docs state no numeric limit ([Blockchain Data API](https://www.blockchain.com/api/blockchain_api)), but 429s are well-documented in practice by consuming projects ([rotki #429](https://github.com/rotki/rotki/issues/429)).
- **The code already defends itself:** `getJson` (`:139-175`) retries HTTP 429/503 with exponential backoff (default 500ms base, doubling, 8s cap), honors `Retry-After`, and throws a typed "rate limited" `BtcSyncError` after N retries; `syncAllBtcWallets` (`lib/crypto/btc-sync.ts`) runs wallets **serially** (a `for` loop, no concurrency) and memoizes the price fetch to one call per batch run. Failures degrade to `SyncIssue` rows + `errorCode` on the Connection — never a crash.

Volume math at beta scale: W single-address wallets ≈ W balance requests + 1 price request per run; steady-state xpub wallets add ~⌈discovered-addresses/50⌉ batch calls each. At W = 50 wallets, a 4-runs/day cadence is ~200-odd requests/day, serialized with built-in backoff — negligible against any plausible public-API limit. **The explorer constraint is real but non-binding at this scale**; the honest bound is "stay polite (serial + backoff, already true), self-host the instance if scale or bans ever make it matter."

---

## 3. Where the health surface belongs: Platform Ops (with the CS reasoning stated)

**Platform Ops — yes.** "Are the platform's provider connections healthy right now, and what's broken" is infrastructure health, the exact register of PO1.2's `ops_job_health` (did last night's jobs run) and `ops_rate_limits`. The widget answers an operator question about the system, not about a customer.

**Customer Success — not now, and here's the actual reasoning rather than a coin flip.** CS's existing `cs_sync_issues` is *forensic* (what data-integrity issues accumulated); a CS connection view would be *per-customer* ("which user is affected by the Chase outage, who do I reach out to") — a support workflow that has no consumers yet (STATUS: no customer-success primitives exist; the beta hasn't started). Building a lighter duplicate now violates the efficiency constraint for a surface nobody would open. The right seam: the Platform Ops route (§4) is written area-agnostically enough that a CS-scoped variant later is a second thin route + widget over the same query module — deferred, explicitly.

One placement nuance: per-connection rows inherently belong to users. PO1's growth route deliberately ships "aggregate counts only (no per-user PII)" (`app/api/platform/growth-revenue/signups/route.ts:9-11`), and the CS route strips `detail` for the same reason. The health widget follows suit: rows carry `institutionName`/`provider`/`status`/`errorCode`/timestamps but **no userId, no email** — an operator sees "Chase item NEEDS_REAUTH, down 2 days," which is actionable at platform level without identifying the owner. (When the CS variant eventually exists, *that* surface is where owner identification belongs, under its own access area.)

---

## 4. Design: `ops_connection_health` widget

### 4.1 Pieces (all existing patterns)

- Section: `{ key: "ops_connection_health", label: "Connection Health", order: 3 }` appended to `PLATFORM_AREAS.PLATFORM_OPS.sections` (`lib/platform/policy.ts:57-76`) — materialized into the existing Space by the `ensurePlatformSections` extension (Slice 0 of the growth/security plan; the `update: {}` seed gap documented there applies here identically).
- Widget: `components/platform/widgets/OpsConnectionHealthWidget.tsx` + one `PLATFORM_WIDGET_REGISTRY` line — the `GrowthSignupsWidget` shape (widget-kit `useWidgetFetch`, honest empty/error states).
- Route: `GET /api/platform/platform-ops/connection-health` behind `requirePlatformAccess("PLATFORM_OPS", "READ")` — the PO1.2 route pattern verbatim.

### 4.2 Query shape — normalize at the query layer, and dedupe the Plaid dual-write

**Decision: the route normalizes both tables into one row shape; the widget never knows there are two tables.** The union-vs-normalize question has a forcing fact: Plaid connections exist in **both** tables (the `Connection(provider=PLAID)` mirror row written at `exchangeToken.ts:212-227`), so a blind union double-counts every bank. Normalization rule:

- From `PlaidItem` (authoritative for Plaid, per its richer state: `syncIncompleteAt`, `syncLockedAt`): `{ source: "PLAID", id, institutionName, status, errorCode, lastSyncedAt, syncIncompleteAt }`.
- From `Connection` where `provider != PLAID` (authoritative for WALLET per `schema.prisma:709-711`; future EXCHANGE/BROKERAGE rows appear automatically): `{ source: provider, id, label: derived from externalConnectionId (e.g. "BTC wallet …abcd"), status, errorCode, lastSyncedAt }`.
- **Wallet health derivation:** because wallet failures set `errorCode` without flipping `status` (§2.2 — deliberate), the normalized `healthState` is computed: `REVOKED/ERROR/NEEDS_REAUTH` from status; else `DEGRADED` when `errorCode != null`; else `STALE` when `lastSyncedAt` is older than a provider-appropriate staleness window (Plaid: >48h given the daily cron; wallet: >2× whatever cadence §6 ships); else `HEALTHY`. This derived field is where the two models' semantics genuinely differ, and computing it server-side is exactly why the query layer normalizes.

Response: summary counts by healthState + the non-healthy rows (worst-first, capped ~20) + total connection count. **No new schema — confirmed still true after designing the query**: every field consumed exists today; "broken since" enrichment arrives with §5 and is additive (nullable `since` field populated from the transition log when available).

---

## 5. Design: durable state-transition history — `AuditLog`, not a new table

**Verdict: `AuditLog` fits; a dedicated history table is not justified.** Reasoning against the efficiency constraint:

- The need is an append-only record of discrete, low-frequency events (a connection flips state at most a few times per item per incident) with time-ordered reads — precisely `AuditLog`'s shape, with `@@index([action, createdAt])` (`prisma/schema.prisma:2312`) serving the "recent transitions" window scan directly. The growth/security investigation already ruled `AuditLog` the event-history home for the adjacent anomaly case; consistency compounds the value (one place to look).
- Both owning models carry `userId`, so rows attach to the owner like every other audit row; `metadata` carries `{ plaidItemId | connectionId, from, to, errorCode, provider }` — the established pointer-contract style.
- A dedicated `ConnectionStatusEvent` table would buy an indexed FK per item (faster "history of THIS item" queries). At current scale that query is a filtered scan over a tiny action-indexed slice — the table would be schema ceremony for a query no surface needs fast today. If per-item history ever becomes a hot drill-down path, migrating is additive. **Stated, not assumed: this is the one place the new-table option would win, and it isn't the workload.**
- The per-day "down for N hours" figure derives at read time: latest transition per broken item (few rows) — no rollup table needed.

**New `AuditAction` values** (`lib/audit-actions.ts`): `PLAID_ITEM_STATUS_CHANGED`, `WALLET_CONNECTION_STATUS_CHANGED`. Two, not one-per-direction — direction lives in `{from, to}` metadata, keeping the vocabulary small (the grammar precedent: one action, discriminating metadata, like `LOGIN_FAILED`'s `reason`).

**Write mechanics — one helper, nine call sites (§2.4 map):** new `lib/connections/health-transitions.ts` exposing `setPlaidItemHealth(itemId, { status, errorCode })` and `setWalletConnectionHealth(connectionId, { ok, errorCode })`. Each reads the current value, writes the live columns, and **only when the effective health state actually changed** appends the audit row (best-effort, non-throwing — a history failure must never fail a sync; the `touchWalletConnectionStatus` posture). Sites 1-4 today repeat an identical `classify → update → notify` triple — swapping in the helper is a de-duplication, not just instrumentation. Sites 5-6 (recovery) and 7 (revoke) swap their inline updates the same way; the wallet pair wraps its two functions' bodies. For wallets the "state" compared is the derived one (errorCode set/cleared), matching §4.2's semantics. Read-then-write raciness is acceptable at this frequency and stake (worst case: a duplicate transition row).

**What this unlocks in the widget:** "NEEDS_REAUTH since Jul 11, 06:04 (2.3 days)" from the latest transition row per broken connection, plus a "transitions this week" strip — the exact "broken since X / down N hours" ask.

---

## 6. Design: crypto sync cadence + manual-resync cooldown

### 6.1 Scheduled cadence — DECIDED: every 6 hours, native `vercel.json` (Vercel plan upgrade confirmed)

Baseline corrected: crypto has **zero** scheduled sync today (§2.5) — the direction ("free blockchain sync should run more often than daily paid-aggregator sync") is right, but the starting point is below Plaid, not above it.

**Chris has decided to upgrade the Vercel plan**, which removes the Hobby-tier sub-daily cron restriction (§2.5) entirely. This simplifies the mechanics below — no external scheduler or `CRON_SECRET`-guarded workaround route is needed; the sub-daily ticks come natively from `vercel.json`, the same way the richer schedule the dispatch route already documents (`app/api/jobs/dispatch/route.ts:4-11`, "the richer paid-tier schedule … is restored when off Hobby") was always designed to work.

- **Target cadence: every 6 hours (4 runs/day).** Grounding unchanged by the plan upgrade: (a) explorer constraints are undisclosed-but-real, and the client is already serial + backoff-guarded; at beta scale 4 sweeps/day is noise (§2.6 volume math) — 6h is chosen as *meaningfully fresher than daily* while staying far from any plausible politeness threshold, not as a precise limit-derived number (no such number exists — the APIs don't publish one); (b) on-chain BTC balances move at most with ~10-minute block cadence, so sub-hourly freshness has no product value for a net-worth app; (c) if scale ever makes the public APIs balk, the documented remedies are already wired: `BTC_EXPLORER_BASE_URL` → self-hosted mempool instance (the maintainers' own guidance for applications), and the retry/backoff keeps partial sweeps honest meanwhile.
- **Mechanics, simplified now that Hobby's wall is gone:**
  1. **Register the job** — `{ name: "sync-crypto", hourUTC: [0,6,12,18], run: dynamic-import }` (or the registry's existing per-slot shape, four entries at 00/06/12/18 UTC) in `lib/jobs/registry.ts` (the one-line entry `jobs/sync-crypto.ts:16-18` was designed for; dynamic import per the registry's import-light rule). Co-locate the 06:00 tick with `sync-banks`/`fetch-fx-rates` as before — the dispatcher ledgers jobs per-slot individually, so co-tenancy is fine.
  2. **Update `vercel.json`** to the richer multi-slot cron entry `app/api/jobs/dispatch/route.ts` already documents as the paid-tier target — this is a config change, not new code, and the dispatch route's own comment describes exactly this restoration path. **No `CRON_SECRET`-guarded per-job route or external scheduler needed** — dropped from scope now that the plan upgrade is confirmed.
  3. **Dead-job detection:** set `expectedEveryHours: 6` on the registry entry (the field exists for exactly this, `lib/jobs/registry.ts:63-67`), so `ops_job_health` — already shipped — surfaces a stalled crypto sweep for free.
  4. **Retire the stale R7 line** — update the registry's "DELIBERATELY NOT HERE" comment (`:42-43`) to remove `sync-crypto`, citing that R7's stub-rationale no longer applies (§2.5); `run-ai-advice`/`take-snapshot` remain deferred.
- The scheduled path deliberately does **not** touch `lastManualRefreshAt`-style cooldowns — same separation the Plaid job keeps by construction (`refreshCooldown.ts:4-9`).

### 6.2 Manual re-sync cooldown — recommendation: yes, a light one, and here's why it's not Plaid's

Plaid's 1-hour cooldown exists because manual refreshes hit a **metered, paid** aggregator. Crypto's explorer calls are free to Fourth Meridian — so a cost-protection cooldown would be cargo-culting. But "no cooldown" is not "no risk": every explorer call leaves **one shared server IP**, so one user hammering re-sync can get that IP throttled or banned by mempool.space, degrading wallet sync for *every* user (shared-fate). The existing 429-backoff mitigates but also *amplifies* a hammer (each spammed request retries up to N times with sleeps, holding serverless invocations open).

- **Recommendation:** per-user rate limit, not a per-item hour: `limitByUser(user.id, "wallet-resync", { limit: 6, windowSec: 3600 })` at the top of `POST /api/accounts/[id]/sync` — one line, zero schema, the established KD-3 pattern (`lib/rate-limit.ts` usage doc `:33-41`), generous enough that no legitimate user ever notices (6 manual syncs/hour) while capping the shared-IP blast radius. SYSTEM_ADMIN exempt per the house call-site idiom. A Plaid-style 1-hour per-item cooldown is explicitly **not** recommended — it would make free, instant on-chain data *less* fresh than the user expects for no protective gain beyond what the per-user limit already provides.

---

## 7. FINAL reconciled slice/wave plan (supersedes §8 of the growth/security document)

### 7.1 New slices from this scope

- **CH-1 — Connection-health widget** (§4): new route + widget files; one-line edits to `lib/platform/policy.ts`, `components/platform/PlatformSpaceDashboard.tsx`. Depends on Slice 0 (`ensurePlatformSections`). No schema.
- **CH-2 — Transition history** (§5): new `lib/connections/health-transitions.ts`; edits `lib/audit-actions.ts` + the nine call-site files (`lib/plaid/{refresh,backgroundHistorySync,syncTransactions,exchangeToken,disconnect}.ts`, `jobs/sync-banks.ts`, `app/api/plaid/refresh/route.ts`, `lib/accounts/wallet-connection.ts`). No schema. CH-1 consumes its data when present (additive nullable field) — no hard ordering between them.
- **CH-3 — Crypto cadence** (§6): edits `lib/jobs/registry.ts`, edits `vercel.json` (native multi-slot cron, Vercel plan upgrade decided — no `CRON_SECRET` route needed), edits `app/api/accounts/[id]/sync/route.ts` (per-user cooldown). No schema.

### 7.2 New conflict overlaps introduced (the flag the prompt asked for)

- **Platform section/registry files** (`lib/platform/policy.ts`, `lib/platform/seed.ts`, `PlatformSpaceDashboard.tsx`): CH-1 joins the growth/security plan's S3 (`growth_beta_requests`), S6 (`sec_anomalies`), S7 (`ops_api_usage`) — now **four** slices each adding a section + registry line. Mechanical one-liners, but concurrent sessions will conflict; resolution below is co-scheduling CH-1 with S7 (both Platform Ops widgets, same three files, same wave).
- **`lib/audit-actions.ts`**: CH-2 adds two actions; S3 adds `BETA_ACCESS_REQUESTED`-class actions and S6 adds `SECURITY_ANOMALY_DETECTED` — append-only one-liners; trivially mergeable but flagged. Wave placement below keeps CH-2 (Wave 1) ahead of S6 (Wave 3); the CH-2/S3 same-wave overlap is accepted as an append-merge.
- **`lib/plaid/refresh.ts` and the other CH-2 call-site files**: touched by **nothing** in the growth/security plan (its slices live in auth/register/platform/marketing files) — CH-2 is disjoint from that entire plan. (Chris should note the *other* pending prompt `plaid_webhook_and_refresh_staleness_fix` may touch these files — outside these two documents' scope, but don't run it concurrently with CH-2.)
- **`lib/auth.ts` / register route / schema migrations**: CH-1/2/3 touch none of them, and add **zero migrations** — the S3→S7(→S5B) migration queue is unchanged.

### 7.3 The reconciled waves — the final word on sequencing

**Wave 1 — up to five parallel sessions:**
① **S1** Landing page (marketing files only).
② **S0 + S2 + S3** Section-seed extension + registration mode + beta-access system (register route + schema + growth section files; owns the first migration).
③ **S8** 2FA nudge (banner + DashboardChrome).
④ **CH-3** Crypto cadence (jobs registry + `vercel.json` + wallet sync route — disjoint from everything; simpler now that the Vercel-upgrade decision drops the external-scheduler route).
⑤ **CH-2** Transition history (plaid/wallet sync files + audit-actions — disjoint except the `lib/audit-actions.ts` append shared with ②; both sides treat it as append-only and merge trivially, or ⑤ rebases last).

**Wave 2 — two parallel sessions:**
⑥ **S4** CAPTCHA (register route after ②; `lib/auth.ts` + pre-login; `lib/rate-limit.ts` peek helper).
⑦ **S7 + CH-1** — one session owning all Platform Ops additions: API-usage counter (schema §5.2 of the growth/security plan — migration rebased after ②'s) + usage widget + connection-health widget/route. Both touch the same three platform section/registry files; co-scheduling eliminates the conflict rather than sequencing it. CH-1 renders "broken since" from ⑤'s data, already landed in Wave 1.

**Wave 3 — one session:**
⑧ **S5** (only if lockout Option B is chosen) then **S6** anomalies — both queue behind ⑥ on `lib/auth.ts`; S6 last so its inline hook sees the final failure-branch shape, and its `sec_anomalies` section line lands after ⑦'s platform-file edits. S6's detector may additionally consume CH-2's transition audit rows (e.g. flapping connections) — noted as an available signal, not a scope change.

Migration order across both documents: **② (BetaAccessRequest) → ⑦ (ApiUsageCounter).** The lockout decision (growth/security §7.1) landed on Option A — no `User` lockout columns, so that migration step no longer exists. CH slices contribute none.

This wave table is the sequencing source of truth for implementation. The growth/security document's §8 remains correct in its slice *contents*; where its wave grouping differs from this table, **this table wins.**

---

## 8. What was checked and dropped

- **Dedicated `ConnectionStatusEvent` table** — dropped for `AuditLog` (§5, with the one workload stated where a table would win).
- **CS-side lighter health widget** — deferred with reasoning (§3), not silently skipped.
- **Sub-daily via `vercel.json` alone** — impossible on the Hobby tier at investigation time (deploy-time rejection, dispatch route header); **superseded by decision** — Chris is upgrading the Vercel plan, so this is now the shipped approach directly, and the originally-scoped `CRON_SECRET`-guarded external-trigger route is dropped (§6.1).
- **Plaid-style 1-hour per-item cooldown on wallet re-sync** — rejected in favor of a per-user rate limit, with the cost-model reasoning (§6.2).
- **New schema for current-state health** — confirmed unnecessary *after* designing the real query (§4.2), including the wallet `DEGRADED`/staleness derivation.
- **Explorer-API-derived exact cadence number** — no such number exists to derive (limits undisclosed); cadence grounded in freshness value + politeness + the self-hosting escape hatch instead (§6.1).

Sources for §2.6's external claims: [mempool/mempool discussion #752](https://github.com/mempool/mempool/discussions/752) (undisclosed limits; run-your-own-node guidance), [Blockchain Data API docs](https://www.blockchain.com/api/blockchain_api) (no published numeric limits), [rotki #429](https://github.com/rotki/rotki/issues/429) (blockchain.info 429s in practice).

---

*Stop point: plan only. No code, schema, or STATUS/ROADMAP changes were made in this pass.*
