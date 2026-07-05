# D2.x — Slice 2: Background History Continuation — Investigation + Checklist

**Status:** Investigation complete. Implementation NOT started — awaiting approval of the checklist in §12.
**Scope goal:** Smallest safe post-response continuation so first-run 730-day history actually loads after the Slice 1 fast return, without blocking the user and without breaking Link success.
**Builds on:** Slice 1 (shipped) — `performPlaidTokenExchange` accepts `deferHistorySync`; `POST /api/plaid/exchange-token` passes `deferHistorySync: true` and returns `historyPending: true`; full history no longer runs inline.

---

## 1. Continuation mechanism (Q1)

**Chosen: `after()` from `next/server`.**

Evidence:
- `next` is **16.2.7** (`node_modules/next/package.json`). `after()` is a **stable** export — `node_modules/next/server.d.ts:21` re-exports it from `next/dist/server/after`; signature `after<T>(task: AfterTask<T>): void` (`.../after/after.d.ts:6`). No `unstable_` prefix, no config flag needed.
- The `exchange-token` route runs on the **Node.js runtime** (no `export const runtime` override → Next's default for route handlers), where `after()` is fully supported. It also runs in local `next dev`, so the flow is testable without deploying.
- `after()` executes its callback **after the response is sent to the client**, within the same server invocation. The fast Slice-1 response is unaffected.

Alternatives considered and rejected for this slice:
- **`waitUntil` via `@vercel/functions`** — Vercel-specific import; `after()` is the framework-native equivalent and also works in dev. No reason to couple to the Vercel package.
- **Separate route / fetch-to-self / cron-only** — heavier; a self-fetch needs auth plumbing and a public endpoint; cron-only is exactly the ≤24h latency Slice 2 exists to remove. Rejected.
- **In-process scheduler (`jobs/scheduler.ts`)** — dormant (`startScheduler()` never invoked) and not request-scoped. Out of scope.

**Critical constraint — `after()` work counts against the route's `maxDuration`.** On Vercel the function instance is kept alive to drain `after()` callbacks, but only up to `maxDuration`. Slice 1 set `maxDuration = 30` sized to the *fast slice*. The background history sync needs a larger budget, so **Slice 2 must raise `maxDuration`** (proposed 60, parity with the `sync-banks` cron). Anything exceeding that budget is safely finished by the cron (see §6). This is the one unavoidable knock-on change.

---

## 2. Where to schedule the deferred work (Q2)

**In the route handler (`POST /api/plaid/exchange-token`), after `performPlaidTokenExchange` resolves successfully — NOT inside the `exchangeToken` helper.**

Reasoning:
- `after()` is request-scoped; it must be called from within the request (the route), not from the shared library function.
- `performPlaidTokenExchange` is **also called by the admin Expand History flow** (`app/api/admin/plaid/exchange-expanded-history-token/route.ts`), which deliberately runs history **inline** (`deferHistorySync` defaults to `false`). Putting `after()` inside the helper would either background the admin flow (wrong) or require branching there. Keeping scheduling in the normal route leaves the admin flow completely untouched.
- The actual work goes in a **new tiny helper** `lib/plaid/backgroundHistorySync.ts` so the route stays thin, the logic is unit-testable, and Slice 6 (webhook) can reuse it. The helper is a thin wrapper over the existing engine — it does **not** duplicate sync logic.

Schedule only when history was actually deferred: gate on `result.historyPending === true` (equivalently, the route passed `deferHistorySync: true`). This keeps the primitive off the admin path even if that route were ever pointed here.

---

## 3. Calling `syncTransactionsForItem` without blocking (Q3)

```ts
// in the route, on the success path, before returning the fast response:
if (result.historyPending) {
  after(() => runDeferredHistorySync(result.plaidItemId));
}
return NextResponse.json({ success: true, /* …Slice 1 fields… */ });
```

`runDeferredHistorySync(plaidItemId)` (new helper) calls the **existing** `syncTransactionsForItem(plaidItemId)` unchanged. Because Slice 1 left the item's `cursor` at `null`, this is the exact "first sync ever = full available history" path Plaid already documents — no new behavior, no engine change. The user already has the fast response in hand; this runs after it.

**No change to `syncTransactionsForItem` internals is required** (Rule honored). The investigation found nothing that forces it: the function already takes only a `plaidItemDbId`, self-loads the token, pages `has_more`, and persists cursor/`lastSyncedAt`/`status` itself.

---

## 4. Snapshot regeneration after history (Q4)

**Finding: re-running `regenerateSnapshotsForAccounts(...)` after history is a provable no-op in Slice 2 → OMIT it (keep minimal).**

Evidence: `SpaceSnapshot` rows are **balance-derived, not transaction-derived**. `regenerateSpaceSnapshot` (`lib/snapshots/regenerate.ts`) computes every field from `getAccounts` balances via `classifyAccounts` — it never reads `Transaction`. Slice 1 already writes **today's** snapshot from the final balances during the fast path, and balances do not change while background transaction history imports. So calling it again after `syncTransactionsForItem` would upsert an **identical** row for `[spaceId, today]`.

Consequences for the checklist:
- Slice 2 does **not** call `regenerateSnapshotsForAccounts` and does **not** need the changed-account ids (which `syncTransactionsForItem` does not return anyway — obtaining them would add coupling for a no-op).
- Meaningful **multi-day** snapshot history (what actually lights up the 30-day chart and Daily Brief/AI) is the **30-day backfill = Slice 4**, dependent on the Snapshot Backfill initiative. Slice 2 does not attempt it.
- *Optional belt-and-suspenders (flagged, not recommended):* if the approver wants a snapshot re-run anyway, the cheapest safe source of ids is the already-imported accounts — expose `importedIds` on `ExchangeTokenResult` and pass them to the after() task. Listed as an optional add in §12; default is to skip.

---

## 5. Failure semantics (Q5)

- **Must background failure affect the Link response? No.** The response is already sent before `after()` runs; an exception in the callback cannot change it. We additionally wrap the whole task in `try/catch` so a throw never becomes an unhandled rejection.
- **Logging:** on failure, log with full context — `plaidItemId`, institution name, and the Plaid error summary — using the existing `plaidErrorSummary`/`console.error` conventions already used across `lib/plaid/*`. Prefix `[plaid][D2x-slice2]` for greppability.
- **PlaidItem status/error fields:** on failure, reuse the **existing** `classifyPlaidErrorForHealth(err)` (`lib/plaid/errors.ts`) — the same helper `POST /api/plaid/sync` and `refreshAllActiveItemsForUser` already use — and, when it returns non-null, update `PlaidItem.status` + `errorCode`. These fields already exist (no schema change), and setting them means Slice 3's status UI and the cron behave correctly for a genuinely broken item (e.g. `ITEM_LOGIN_REQUIRED` → `NEEDS_REAUTH`). Transient/rate-limit errors return `null` from the classifier and are left as-is for the cron to retry. On **success**, `syncTransactionsForItem` already sets `status = ACTIVE`, `errorCode = null`, `lastSyncedAt`, and advances `cursor` — no extra write needed.

---

## 6. Idempotency (Q6)

The engine is idempotent by construction, so overlap is safe (wasteful at worst). No lock/queue is added (that would be SyncJob territory — out of scope).

- **Repeated Link calls / relink:** `exchange-token` upserts `PlaidItem` by `externalItemId`; update-mode relink preserves the same item, so a second connect schedules a second background sync for the same item. Both call `transactionsSync` and upsert on `plaidTransactionId` (+ fingerprint fallback) → duplicates impossible.
- **Cron overlap:** `jobs/sync-banks.ts` explicitly documents itself as safe to overlap with a user-triggered sync of the same item (same upsert key). The background task and the 06:00 cron can run concurrently without corruption.
- **Manual refresh overlap:** `refreshPlaidItem`/`/api/plaid/sync` call the same engine — same idempotency.
- **Cursor behavior:** `syncTransactionsForItem` persists `next_cursor` only **after** the full `has_more` loop completes. If the background task is cut off by `maxDuration` mid-loop, already-processed pages are persisted but the cursor stays `null`; the cron then re-runs from `null` and re-processes (upserts dedupe). Concurrent runs from the same cursor both advance it; last write wins, pages overlap, upserts dedupe. Safe in all cases.

---

## 7. Response fields (Q7)

**No new response fields.** `historyPending: true` (Slice 1) already tells the client history is arriving out-of-band; the background scheduling is fire-and-forget. Progress/state (`Importing history → Categorizing → chart ready`) is **Slice 3** (a pollable status endpoint inferred from `PlaidItem` fields). Adding fields now would be speculative.

---

## 8. Files affected (Q8)

| File | Change | Type |
|------|--------|------|
| `app/api/plaid/exchange-token/route.ts` | `import { after } from "next/server"`; raise `maxDuration` 30 → 60; on `result.historyPending`, `after(() => runDeferredHistorySync(result.plaidItemId))`. | Edit (in scope) |
| `lib/plaid/backgroundHistorySync.ts` | **New** thin helper `runDeferredHistorySync(plaidItemId)`: try/catch around `syncTransactionsForItem`, failure logging, `classifyPlaidErrorForHealth`-based status update. | New |
| `lib/plaid/exchangeToken.ts` | **No change** (unless the optional §4 snapshot add is approved → expose `importedIds`). | None |
| `lib/plaid/syncTransactions.ts` | **No change.** | None |
| `lib/plaid/refresh.ts` | **No change.** | None |
| `jobs/sync-banks.ts`, `vercel.json` | **No change** (cron preserved as safety net). | None |
| `context/PlaidContext.tsx` | **No change** (no new response fields). | None |

---

## 9. Open decision for approval

Single explicit choice, defaulted:
- **`maxDuration` value:** propose **60** (parity with cron). Larger institutions whose full history exceeds 60s are finished by the cron; raising higher (Vercel allows up to 300 on paid tiers) is possible but not needed for a minimal slice. Confirm 60 or specify otherwise.
- **Optional snapshot re-run (§4):** default **omit** (proven no-op). Approve only if belt-and-suspenders is wanted despite the no-op.

---

## 10. Validation plan (Q9)

- `npx prisma generate` (expect no schema delta; sandbox may 403 on engine fetch — environment-only, not a code signal).
- `npx tsc --noEmit` — 0 errors.
- `npm run lint` — no new errors in scoped files.
- Dev sandbox Link run:
  - Connect a sandbox institution → confirm the fast response still returns promptly with `historyPending: true` (Slice 1 unchanged).
  - Observe logs: `[plaid][D2x-slice2]` background start, then `[plaid sync] item … created N …` from the engine after the response.
  - After the background task, confirm `PlaidItem.cursor` is non-null, `lastSyncedAt` set, `status = ACTIVE`, and `Transaction` rows exist for the item — **without** any manual Refresh.
  - Force-failure path: point at an item/token that yields a Plaid error → confirm the Link response was still success, the error is logged with context, and `PlaidItem.status/errorCode` reflect `classifyPlaidErrorForHealth` (or are untouched for transient/null).
- Admin Expand History regression: confirm it still runs history **inline** (no `after()` on that route) and returns a real `transactionsSynced` count.
- `git diff` limited to the two scoped files.

## 11. Rollback plan (Q10)

- Pure code, no schema/migration → revert the commit to restore Slice 1 behavior exactly (fast response + cron-only history completion). No data migration, no orphan risk.
- The new helper is additive and only referenced from the one `after()` call; removing that call fully disables the slice.
- Even with Slice 2 reverted, first-run history still completes via the 06:00 cron (unchanged throughout) — degraded latency, never data loss.
- `maxDuration` revert 60 → 30 is a one-line change with no side effects (fast response never approached 30s).

---

## 12. Slice 2 implementation checklist — for approval

**Decision:** Add an `after()`-based background continuation to `POST /api/plaid/exchange-token` that runs the existing `syncTransactionsForItem` for the newly connected item, post-response, best-effort.

**Steps (no code until approved):**
1. Create `lib/plaid/backgroundHistorySync.ts` exporting `runDeferredHistorySync(plaidItemId: string): Promise<void>`:
   - `try`: `await syncTransactionsForItem(plaidItemId)`; log a success line with item id + counts.
   - `catch (e)`: `console.error("[plaid][D2x-slice2] …", plaidErrorSummary(e))` with context; `const health = classifyPlaidErrorForHealth(e); if (health) await db.plaidItem.update({ where:{id}, data: health })`.
   - Never rethrow.
2. In `app/api/plaid/exchange-token/route.ts`:
   - `import { after } from "next/server"`.
   - Raise `export const maxDuration = 60`.
   - After a successful `performPlaidTokenExchange`, before returning: `if (result.historyPending) after(() => runDeferredHistorySync(result.plaidItemId));`
   - Response body unchanged (still Slice 1 fields incl. `historyPending`).
3. Leave `exchangeToken.ts`, `syncTransactions.ts`, `refresh.ts`, cron, and `PlaidContext.tsx` unchanged. (Optional §4 snapshot re-run only if explicitly approved.)

**Schema:** none. **Migrations:** none. **New response fields:** none.

**Validation:** per §10. **Rollback:** per §11.

**Impact map / rollback / validation are the §8 / §11 / §10 sections above.**

**Stop — await approval before writing code.**
