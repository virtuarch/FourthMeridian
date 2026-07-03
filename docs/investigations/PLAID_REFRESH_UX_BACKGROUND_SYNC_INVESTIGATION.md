# Plaid Refresh UX / Background Sync — Investigation

**Status:** Investigation only. No code changed. Scope excludes KD-4 files and STATUS.md.
**Date:** 2026-07-02 · **Branch:** feature/phase-2-architecture

## Scope

Diagnose why "Refresh Data" feels like it crashes/destabilizes the app when the user navigates during a long Plaid sync, and why cooldown produces fast 200s the UI labels "Synced." No implementation.

## Files reviewed

- `app/api/plaid/refresh/route.ts` — the manual refresh handler
- `app/api/plaid/sync/route.ts` — sibling "Sync Now" handler (same cooldown pattern)
- `lib/plaid/refresh.ts` — `refreshPlaidItem` / `refreshAllActiveItemsForUser` pipeline
- `lib/plaid/refreshCooldown.ts` — cooldown check + mark helpers
- `components/dashboard/RefreshButton.tsx` — topbar button
- `components/ui/Sidebar.tsx` — `SidebarRefreshButton` (bottom-rail button)
- `vercel.json`, `app/api/jobs/sync-banks/route.ts` — cron/runtime context

---

## Diagnosis

### 1. Refresh is foreground and fully blocking

`POST /api/plaid/refresh` `await`s the entire pipeline before responding. `refreshAllActiveItemsForUser` iterates active PlaidItems **sequentially** (`for` loop, `await refreshPlaidItem(item.id)` per item — `refresh.ts:429`). Each item runs, in order: balances (`accountsGet`), investment holdings (delete-then-recreate per account and per holding), transaction sync, and snapshot regeneration. For a multi-item user this is many seconds to minutes of serial Plaid + DB work inside one request. There is no job record, no background handoff — the HTTP request *is* the sync.

### 2. The client fetch is a bare `fetch` with no abort wiring

Both `RefreshButton` and `SidebarRefreshButton` do `await fetch("/api/plaid/refresh", { method: "POST" })` with **no `AbortController`/`signal`** (confirmed: no `abort`/`signal` references in either component). On success they call `router.refresh()`.

Consequence on soft navigation (clicking a sidebar `Link` / `router.push`): React unmounts the button, but the in-flight `fetch` promise is **not** aborted — it keeps running and later calls `setStatus(...)` on an unmounted component (dev-only React warning, harmless but noisy). The refresh request continues regardless of where the user navigated.

### 3. Server sync continues after navigation — and that is what looks like a "crash"

Next.js route handlers do not cancel on client disconnect by default, so in local dev the Node process runs the whole pipeline to completion even after the user navigates or the tab's fetch is discarded. Two things then destabilize the UI *while it runs*:

- **Transient empty state from non-transactional holdings rewrite.** `refresh.ts:255` does `db.holding.deleteMany(...)` and then recreates rows in a loop (`refresh.ts:268`), with **no `db.$transaction`** wrapper. During that window the holdings table for an account is empty. If the user navigates to a page that reads holdings mid-sync, they see zero holdings / wiped balances — which reads as a crash. (This is the same *class* of defect as KD-4 but in `refresh.ts`, a non-KD-4 file; KD-4 concerns the WAS↔SAL dual-write path.)
- **Dev-server contention.** The long serial handler holds DB connections and CPU in the single `next dev` process; concurrent RSC navigation fetches queue behind it and feel janky/unresponsive.

### 4. Local dev vs production diverge sharply

The refresh route sets **no `maxDuration`**. The daily batch route explicitly sets `export const maxDuration = 60` (`sync-banks/route.ts:30`); the manual refresh route inherits the platform default (short — on the order of ~10–15s on Vercel).

- **Local dev:** no function timeout → the sync runs to completion in-process even after navigation. Symptom: "feels unstable but it does finish."
- **Production (Vercel, `sin1`):** a long multi-item refresh will be **killed at the platform timeout** mid-pipeline. The client `fetch` then sees a 504/aborted response → error state, and the sync is left **partially applied** (e.g. holdings deleted-but-not-recreated for later items). So the very failure mode that merely looks bad in dev becomes real data truncation in prod. This gap is currently untested and undocumented.

### 5. Cooldown returns a success-shaped 200 the UI reads as "Synced"

The "refresh all items" path never fails the request. On cooldown it pushes `skipped: "cooldown"` result objects and returns `{ ok: true, ...summary }` with HTTP 200 (`refresh/route.ts:101–124, 145`). Only the **single-item** path returns a hard 429 (`refresh/route.ts:51`).

The client checks `res.ok` only (`RefreshButton.tsx:33`, `Sidebar.tsx:315`) and on any 200 sets status `"done"` → shows a green check and **"Synced"**. So hitting Refresh within the 60-minute window returns instantly and is mislabeled as a successful sync, even though every item was skipped and nothing was fetched. The response body already carries the truth (`results[].skipped === "cooldown"`, `retryAfterSeconds`) — the UI just ignores it.

---

## Risks

- **Prod data truncation (high):** unbounded serial refresh with no `maxDuration` will time out in production, leaving holdings/transactions partially written. Currently silent.
- **Perceived instability / trust (high):** mid-sync empty holdings + dev contention make the app look broken during a normal action.
- **False "Synced" (medium):** cooldown mislabeling teaches users the data is fresh when it is not; erodes trust in every future "Synced."
- **State-after-unmount noise (low):** `setStatus` on unmounted button — cosmetic in dev, but a signal that lifecycle isn't managed.
- **Change-safety (medium):** the pipeline is shared with the future cron/webhook (`refresh.ts` header); any fix must not fork refresh logic or alter the batch path.

---

## Minimal safe fix — checklist (v2.4.5 candidate)

UX-only, additive, no schema, no pipeline rewrite. Each item still needs its own impact map / rollback / validation before code per project rules.

- [ ] **Read the response body, not just `res.ok`.** In both `RefreshButton` and `SidebarRefreshButton`, parse the JSON; if every result is `skipped === "cooldown"` (or a 429), render a distinct "On cooldown — try again in Nm" state instead of "Synced." Show `retryAfterSeconds`.
- [ ] **Distinguish "nothing synced" from "synced."** Use `summary.totalAccountsUpdated + totals...` / non-skipped count to choose the success label; "Synced" only when real work happened.
- [ ] **Abort on unmount / guard setState.** Add an `AbortController` tied to the component (or an `ignore` flag) so navigation cancels the client fetch and no `setStatus` fires after unmount. (Cancels the *client* wait only — see long-term for the server side.)
- [ ] **Set an explicit `maxDuration` on the refresh route** matching or below the batch job, so prod behavior is defined rather than defaulted — as a stopgap only; it does not make the work backgroundable.
- [ ] **Copy/affordance:** while loading, message that closing/navigating is safe and sync continues server-side (once #3 long-term makes that actually true) — do not promise it before the background job exists.
- [ ] Validation: `npx tsc --noEmit`, `npm run lint`, manual test of cooldown path (expect "cooldown" label) and fresh path (expect "Synced"), plus navigate-mid-refresh smoke test.

## Long-term fix — checklist (v2.5, background job/status architecture)

- [ ] **Introduce a refresh-job record** (e.g. `PlaidRefreshJob` / reuse a generic job table) with status (`queued|running|succeeded|partial|failed`), per-item progress, timestamps, and userId. Additive migration; do not remove legacy tables.
- [ ] **Make the manual refresh route enqueue, not execute.** Return a `jobId` immediately (202); move the pipeline to a worker/queue invocation. Reuse `lib/plaid/refresh.ts` unchanged as the pipeline; only the *trigger* changes, keeping the cron/webhook call sites intact.
- [ ] **Status endpoint + client polling / stream** (`GET /api/plaid/refresh/status?jobId=`); the button reflects real server progress and survives navigation because state lives server-side, not in a mounted component.
- [ ] **Wrap the holdings delete-then-recreate in `db.$transaction`** (or upsert-diff) so no reader ever observes an empty holdings window. Coordinate with, but keep separate from, KD-4's WAS↔SAL transaction work — do not modify KD-4 files here.
- [ ] **Align runtime + retries with the batch job** so manual and scheduled refresh share timeout/retry semantics.
- [ ] **Global refresh indicator** (chrome-level) driven by job status, decoupled from any single button instance.

## Version placement

- **Minimal UX fix → v2.4.5.** It is a stabilization/correctness fix (false "Synced," navigation feedback, defined prod timeout), which is exactly v2.4.5's production-readiness remit. It touches only two client components plus one route constant, adds no surface, and needs no schema.
- **Background job/status architecture → v2.5.** It requires a new table, a queue/worker path, and a status API — new surface and a migration seam, which belongs with v2.5 seam-closure, not the v2.4.5 stabilization gate.

## Out of scope (not touched, not changed here)

- KD-4 files (`lib/accounts/reconcile.ts`, `lib/accounts/space-account-link.ts`, `app/api/accounts/manual/route.ts`, KD4 docs) — the WAS↔SAL `$transaction` work is separate.
- `STATUS.md` — not edited (per instruction); a KD entry for this can be added later by the owner.
- `lib/plaid/refresh.ts` pipeline logic and `jobs/sync-banks.ts` batch path — no behavior changes proposed to the shared sync internals beyond the holdings-transaction wrap noted for v2.5.
- Cooldown *duration/config* (60-min constant, provider-level config) — explicitly deferred in the module header; not revisited here.
- Any new provider adapter, encryption, or schema-modernization work (Phase 2 D-decisions) — unrelated.
- Rate limiting (KD-3), billing, marketplace, notifications — deferred per project rules.
