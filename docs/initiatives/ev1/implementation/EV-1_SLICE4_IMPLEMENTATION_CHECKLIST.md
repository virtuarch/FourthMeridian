# EV-1 — Slice 4 Implementation Checklist (ConnectionSynced)

**Status:** Checklist only. No implementation. Awaiting approval.
**Source of truth:** `docs/investigations/EV-1_TYPED_DOMAIN_EVENT_SEAM_INVESTIGATION.md`, `EV-1_SLICE3_IMPLEMENTATION_CHECKLIST.md`
**Completed:** Slices 0–3 (types, `emitDomainEvent`, `dispatchDomainEvent`, snapshot handler, `SpaceRestored`, `AccountShared`, `AccountShareRevoked`, `MemberRemoved`, `MemberLeft`).
**Branch context:** `feature/v2.5-spaces-completion`

**Goal:** migrate the first fan-out producer (`ConnectionSynced`) with the *smallest* change that preserves today's behavior exactly.

---

## 1. Current architecture assessment

`ConnectionSynced` is unlike every producer migrated so far. Slices 1–3 each had an **existing inline `auditLog.create`** to canonicalize and (2–3) a **duplicated best-effort snapshot side effect** to collapse. `refreshPlaidItem` has **neither**: it writes **no audit row at all**, and its snapshot step is a **single-call-site, return-carrying, fatal-on-error fan-out** — not a duplicated best-effort call. This inverts the usual migration: there is nothing to canonicalize and nothing to de-duplicate. That shapes the entire recommendation.

---

## 2. Producer analysis

Traced in `lib/plaid/refresh.ts`, `app/api/plaid/refresh/route.ts`, `lib/providers/plaid/adapter.ts`.

**Entry points / callers of `refreshPlaidItem(plaidItemDbId)`:**
- `app/api/plaid/refresh/route.ts` — single-item path (`body.plaidItemId`) and, via `refreshAllActiveItemsForUser`, the all-items path.
- `refreshAllActiveItemsForUser(userId, opts)` — loops items with a **per-item `try/catch`**; a failure becomes an `ok:false` `RefreshItemResult`, it does **not** throw.
- `lib/providers/plaid/adapter.ts` — the D2 provider adapter exposes `refreshItem: refreshPlaidItem`.

**Exact execution order inside `refreshPlaidItem` (success path):**
1. Load `PlaidItem` (throws if missing → propagates).
2. `accountsGet` (with retry) → update `FinancialAccount` balances → collect `updatedAccountIds`.
3. Investment holdings — **best-effort** (`try/catch`, consent-gated).
4. Transactions — `syncTransactionsForItem` (awaited).
5. **Snapshot fan-out** — `const spacesSnapshotted = await regenerateSnapshotsForAccounts(updatedAccountIds)` (line ~320). **No `try/catch` — fatal on error.**
6. `return { plaidItemId, institution, ok:true, accountsUpdated, holdingsUpdated, transactions*, spacesSnapshotted }`.

**Return contract:** `RefreshItemResult` (incl. `spacesSnapshotted: string[]`) → aggregated into `RefreshSummary` (deduped `spacesSnapshotted` union, totals) by both `refreshAllActiveItemsForUser` and the route's single-item branch → serialized in the refresh route's JSON response.

**Transaction boundaries:** **none** wrap the snapshot step. `refreshPlaidItem` is a sequence of awaited DB writes, not a `$transaction`. (The per-account balance updates are individual `update`s.)

**Current error handling:**
- Steps 1, 2, 4, 5 are fatal within `refreshPlaidItem` (a throw propagates).
- Step 3 (holdings) is best-effort.
- The fatal throw is caught **one level up** (in `refreshAllActiveItemsForUser` or the route), which marks the item `ok:false` (+ health status) and continues/returns 500. **A snapshot-fan-out failure therefore currently fails that item's refresh.**

**No `auditLog.create` anywhere in `refresh.ts`.** (`AuditAction.PLAID_REFRESH` exists but is unused — the gap noted in the investigation §2.5.)

---

## 3. Fan-out analysis — `regenerateSnapshotsForAccounts(accountIds)`

(`lib/snapshots/regenerate.ts`)

- **Why it differs from `regenerateSpaceSnapshot(spaceId)`:** it resolves *every* space that has an ACTIVE `SpaceAccountLink` to the changed accounts, then regenerates each — one connection's refresh keeps **all** sharing spaces current. `regenerateSpaceSnapshot` targets exactly one space.
- **Spaces touched:** `0..N` (N = distinct spaces linking those accounts). Real deployments: small, but unbounded in principle.
- **Ordering:** irrelevant — `Promise.all(spaceIds.map(regenerateSpaceSnapshot))`, independent per space.
- **Duplicates:** impossible within a call — `[...new Set(links.map(l => l.spaceId))]` dedupes; each `regenerateSpaceSnapshot` upserts on `[spaceId, date]` (idempotent).
- **Should it stay synchronous:** **yes** — the caller consumes its return value synchronously and its failure currently participates in refresh error handling. No evidence for async.
- **Failures fail the sync:** **yes, today** — no `try/catch` around it in `refresh.ts` (unlike the share/member routes where snapshot regen is best-effort). This is a *different* failure contract from Slices 2–3.
- **Call-site breadth:** `regenerateSnapshotsForAccounts` is invoked from ~7 places (refresh, exchange-token, manual create/restore, wallet create/archive/restore, account restore). It is **not** unique to the Plaid refresh — so it is *not* a "duplicated side effect local to this producer" the way share/member snapshot regen was.

---

## 4. Recommended event model

**`ConnectionSynced` only. No secondary events.** The codebase expresses exactly one business action: *a connection was refreshed*. Balances, holdings, transactions, and snapshots are **steps** of that one sync, not distinct business actions — inventing `BalancesRefreshed`/`HoldingsRefreshed`/`TransactionsSynced` events would violate "do not invent events." (`TransactionsImported` remains deferred per the standing D2 decision.)

Finalize the provisional `ConnectionSynced` payload (currently `{ provider, connectionId, updatedAccountIds }`) to compact, faithful fields:

```
ConnectionSynced: { provider: string; plaidItemId: string; accountsUpdated: number; spacesSnapshotted: number }
```

Envelope: `actorUserId` = `item.userId` (the item owner; system-on-behalf for cron/webhook), **no `spaceId`** (the sync spans many spaces — it is not single-space scoped), no `ipAddress` (lib context, no request), no `occurredAt`. Action mapping: `ConnectionSynced → AuditAction.PLAID_REFRESH` (existing constant; provider-neutral renaming deferred, producer is Plaid-specific today).

---

## 5. Dispatch strategy

**`dispatchDomainEvent` is NOT sufficient to host the fan-out — and the fan-out should therefore NOT be moved behind the seam in Slice 4.**

Evidence: the Slice 2 dispatcher is `Promise<void>` and **swallows** handler errors (best-effort). The snapshot fan-out (a) **returns** `spacesSnapshotted`, consumed by `RefreshItemResult`/`RefreshSummary`/the route response, and (b) is **fatal-on-error** today (a failure marks the item failed). Routing it through `dispatchDomainEvent` would **lose the return value** and **flip error semantics** from fatal to swallowed — both forbidden by the rules.

Preserving those two properties *while* moving the call behind the seam would require a **new, specialized dispatch contract** — a synchronous, result-collecting, error-propagating variant (e.g. `dispatchDomainEventCollect<T>()`). That is a **new abstraction**, which the rules say to avoid "unless required." It is **not required**, because:

- There is **no side-effect duplication** to collapse here (single call site with a return contract; the fan-out helper is shared by ~7 unrelated sites — §3).
- Moving it yields **no parity or consumer benefit** and adds risk to a load-bearing pipeline.

**Therefore: `ConnectionSynced` is an audit-only producer with no registered handler.** `regenerateSnapshotsForAccounts` stays exactly where and how it is (direct, synchronous, returning, fatal-on-error). `emitDomainEvent` persists the event; its no-tx path invokes `dispatchDomainEvent`, which is a **no-op** for `ConnectionSynced` (no handlers registered). No new abstraction, no handler, no queue, no async.

---

## 6. Exact files

### Edited
- [ ] `lib/events/types.ts` — finalize the `ConnectionSynced` payload to `{ provider, plaidItemId, accountsUpdated, spacesSnapshotted }`; mark EXERCISED (Slice 4). (Types only.)
- [ ] `lib/events/emit.ts` — add `ConnectionSynced → AuditAction.PLAID_REFRESH` to `DOMAIN_EVENT_ACTION`. **No `HANDLERS` entry.**
- [ ] `lib/plaid/refresh.ts` — after the fan-out (line ~320), emit `ConnectionSynced` **best-effort** (wrapped in `try/catch` + `console.warn`) using `item.userId` and the counts already in scope; add imports for `emitDomainEvent` and the `DomainEvent` type. **Nothing else changes** — the fan-out, its return value, the `RefreshItemResult`, and all error handling are untouched.

**Explicitly NOT touched:** `prisma/schema.prisma`, `lib/audit-actions.ts` (`PLAID_REFRESH` already exists), `lib/snapshots/regenerate.ts`, `lib/events/handlers/snapshot.ts`, `app/api/plaid/refresh/route.ts`, `refreshAllActiveItemsForUser`, `lib/providers/plaid/adapter.ts`, the activity route, any other producer.

**Expected `git diff`:** `lib/events/types.ts`, `lib/events/emit.ts`, `lib/plaid/refresh.ts`.

---

## 7. Row-parity expectations

This slice **adds one audit row** per successful sync — the single intentional, additive change (there is no prior audit row to match; this closes the §2.5 coverage gap and gives `ConnectionSynced` a canonical record for future consumers). It changes **no existing observable behavior**:

- [ ] `action` = `PLAID_REFRESH`; `metadata` = `{ provider:"PLAID", plaidItemId, accountsUpdated, spacesSnapshotted }`; `userId` = `item.userId`; `spaceId` = `null`; `ipAddress`/`performedByAdminId`/`userAgent` = `null`; `createdAt` = DB `now()`.
- [ ] Emitted **only on the success path** (after the fan-out, before `return`), so a failed refresh writes no `ConnectionSynced` row (matches: sync did not complete).
- [ ] The emit is **best-effort** (wrapped): a `PLAID_REFRESH` insert failure is warned and swallowed, so adding audit **cannot** newly fail a refresh that previously succeeded — preserving failure semantics.
- [ ] **Timeline:** the activity route filters `PLAID_*` as platform noise, so this row does **not** surface there — confirming no consumer-visible change and no Timeline work needed.

> Decision point: if strict "zero new rows" is preferred over closing the audit gap, the alternative is to **defer `ConnectionSynced` entirely** (no emit) — but then Slice 4 is a no-op. This checklist recommends emitting the audit-only event.

---

## 8. Side-effect parity expectations

- [ ] `regenerateSnapshotsForAccounts(updatedAccountIds)` is **unchanged**: same call site, same synchronous await, same fan-out, same fatal-on-error behavior, same dedup/idempotency.
- [ ] **No** snapshot handler registered for `ConnectionSynced` → no double regeneration, no change to how many spaces are touched.
- [ ] Snapshot outputs identical before/after for the same inputs.

---

## 9. Return-value parity expectations (the critical one)

Preserved **trivially and completely**, because the fan-out is not moved:

- [ ] `refreshPlaidItem` still returns `RefreshItemResult` with the **same** `spacesSnapshotted` array (from the untouched fan-out) and the same counts.
- [ ] `refreshAllActiveItemsForUser` still aggregates the identical `RefreshSummary` (deduped `spacesSnapshotted`, totals).
- [ ] `POST /api/plaid/refresh` response JSON is **byte-identical**.
- [ ] `lib/providers/plaid/adapter.ts` (`refreshItem`) contract unchanged.
- [ ] Error semantics unchanged: a fan-out failure still propagates and marks the item `ok:false` (audit is emitted only after the fan-out succeeds, and even then non-fatally).

---

## 10. Validation plan

- [ ] `npx prisma generate` — no schema drift expected.
- [ ] **No** `npx prisma migrate dev`.
- [ ] `npx tsc --noEmit` — union enforces the finalized `ConnectionSynced` payload; `DOMAIN_EVENT_ACTION` resolves `PLAID_REFRESH`.
- [ ] `npm run lint` — 0 errors.
- [ ] **Row check:** a successful single-item refresh writes **exactly one** `PLAID_REFRESH` row with the specified metadata + `userId = item.userId`, `spaceId = null`; an all-items refresh writes **one per successfully synced item**; a failed item writes **none**.
- [ ] **Return-value parity:** capture the refresh route JSON before/after for the same fixture — `spacesSnapshotted`, totals, and per-item results are byte-identical.
- [ ] **Side-effect parity:** snapshot fan-out runs exactly as before (same spaces, same values); confirm no handler fires for `ConnectionSynced`.
- [ ] **Failure semantics:** inject a throw in `regenerateSnapshotsForAccounts` → the item is still marked `ok:false`/500 as today, and **no** `ConnectionSynced` row is written; inject a throw in the audit insert → refresh still returns success (best-effort warn).
- [ ] **`git diff` shows only** the three files in §6.

---

## 11. Rollback strategy

- [ ] **Per-file revert.** Remove the best-effort emit block (+ imports) from `refresh.ts`; remove the `ConnectionSynced` map entry from `emit.ts`; revert the `types.ts` payload finalization. The fan-out and all return values are already untouched, so reverting affects only the additive audit row.
- [ ] **Mixed-state safe.** `PLAID_REFRESH` rows written while live are ordinary, consumer-less audit rows; a partial revert leaves no broken reads (nothing consumes them yet).
- [ ] **No irreversible steps.** No schema/table/data changes; no migration. `git revert` + redeploy fully restores prior behavior.
- [ ] **No kill switch needed** — the emit is best-effort and handler-less; it cannot affect refresh success or the response.

---

## 12. Recommended Slice 4 implementation checklist

1. [ ] `lib/events/types.ts`: finalize `ConnectionSynced` payload to `{ provider, plaidItemId, accountsUpdated, spacesSnapshotted }`; mark EXERCISED (Slice 4).
2. [ ] `lib/events/emit.ts`: add `ConnectionSynced: AuditAction.PLAID_REFRESH` to `DOMAIN_EVENT_ACTION`; **do not** add a `HANDLERS` entry.
3. [ ] `lib/plaid/refresh.ts`: import `emitDomainEvent` + `DomainEvent`; after `const spacesSnapshotted = await regenerateSnapshotsForAccounts(updatedAccountIds)`, add a best-effort emit:
   `ConnectionSynced` with `actorUserId: item.userId`, payload `{ provider:"PLAID", plaidItemId: plaidItemDbId, accountsUpdated, spacesSnapshotted: spacesSnapshotted.length }`, wrapped in `try/catch` + `console.warn`. Leave the fan-out, return object, and error handling untouched.
4. [ ] Run §10 validation; confirm `git diff` limited to the three files.
5. [ ] Confirm deferrals hold: no snapshot handler for `ConnectionSynced`, no `SnapshotGenerated`, no `dispatchDomainEventCollect` abstraction, no Timeline/consumer cleanup, no other producer migrations.

**Stop after approval of this checklist. No implementation until approved — including the §7 decision (emit audit-only vs. defer entirely).**
