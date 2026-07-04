# EV-1 — Slice 2 Implementation Checklist

**Status:** Checklist only. No implementation. Awaiting approval.
**Source of truth:** `docs/investigations/EV-1_TYPED_DOMAIN_EVENT_SEAM_INVESTIGATION.md`
**Predecessors:** Slice 0 (`lib/events/types.ts`) + Slice 1 (`lib/events/emit.ts`, `restore` migrated) — merged.
**Branch context:** `feature/v2.5-spaces-completion`

**Goal of this slice:** wake the (currently inert) handler registry with its **first real handler — snapshot regeneration — and perform the first side-effect collapse**, replacing the duplicated inline `regenerateSpaceSnapshot` calls in the account-share route with a single subscriber.

**Hard constraints (unchanged from prior slices):**
- No schema changes. No migration.
- No event bus. No queue. No async fan-out / background processing.
- No `lib/audit-actions.ts` changes (the constants this slice needs already exist).
- No Timeline / consumer cleanup (that is Slice 5).
- Preserve behavior: same rows, same snapshot output, same best-effort semantics, same HTTP responses.
- Stop after this checklist is approved — do not code yet.

---

## 0. Scope decision — which producers/handlers this slice touches

The investigation (§6, Slice 2) tentatively grouped **four** trigger events (`AccountShared`, `AccountShareRevoked`, `MemberRemoved`, `ConnectionSynced`) under the snapshot handler. **This checklist narrows Slice 2 to the two share-route events only**, and defers `MemberRemoved` and `ConnectionSynced` to Slice 3. Rationale:

- **Independent validatability.** A handler can only be proven in the slice where a producer actually emits its trigger. Registering a handler for `MemberRemoved`/`ConnectionSynced` now — while their producers still write inline audit + inline regen — would be dead code that this slice cannot exercise or parity-check.
- **`ConnectionSynced` uses a *different* regen function.** The share route uses `regenerateSpaceSnapshot(spaceId)` (single space); the Plaid path uses `regenerateSnapshotsForAccounts(accountIds)` (fan-out). Folding both into one handler in one slice mixes two side-effect shapes. Keep them separate.
- **Smallest additive collapse.** The share route is the cleanest first collapse: two verbs, identical `regenerateSpaceSnapshot(spaceId)` side effect, identical best-effort wrapper.

**In scope:** `AccountShared`, `AccountShareRevoked` → one snapshot handler; migrate `POST` + `DELETE /api/spaces/[id]/accounts/share`.
**Deferred to Slice 3:** `MemberRemoved` (members route), `ConnectionSynced` (Plaid refresh, fan-out), `SnapshotGenerated` emission.

---

## 1. The central design decision — transaction ordering (read first)

The share route today does two things in a deliberate order (KD-4):

1. **Inside** `db.$transaction`: write `SpaceAccountLink` **and** the `AuditLog` row — they "commit together."
2. **After** the transaction commits: `regenerateSpaceSnapshot(spaceId)`, best-effort (`try/catch`, non-fatal). It must run **post-commit** because it re-reads committed balances via `getAccounts`.

Slice 1's `emitDomainEvent` couples persistence **and** dispatch in one call. That coupling is wrong for a transactional producer: if emit dispatched the snapshot handler while still inside the transaction, it would regenerate from **uncommitted** data. Slice 2 therefore **splits emit into two phases**:

- [ ] **`emitDomainEvent(event, ctx?)` — persist phase.** Writes the `AuditLog` row (tx-aware, as today). Behavior:
  - If `ctx.tx` is **provided** → persist only; **do not** run handlers. The caller is responsible for dispatch after commit.
  - If `ctx.tx` is **absent** → persist, then dispatch inline (post-persist == post-commit when there is no surrounding transaction). This preserves Slice 1 producers (e.g. `restore`) unchanged.
- [ ] **`dispatchDomainEvent(event)` — dispatch phase (new export).** Runs the registered handlers for `event.type`, each wrapped in its own `try/catch` (best-effort, non-fatal). This is what the transactional share route calls **after** its `$transaction` block — occupying the exact position the old `try/catch regenerateSpaceSnapshot` occupied.

This yields a clean 1:1 structural mapping for the share route:

```
// BEFORE
await db.$transaction(async (tx) => {
  ...SAL write...
  await tx.auditLog.create({ action: "ACCOUNT_SHARE", metadata: {...} });
});
try { await regenerateSpaceSnapshot(spaceId); } catch (e) { console.warn(...); }

// AFTER
const event = { type: "AccountShared", spaceId, actorUserId: userId, ipAddress, payload: {...} };
await db.$transaction(async (tx) => {
  ...SAL write...
  await emitDomainEvent(event, { tx });        // persists canonical AuditLog row in-tx
});
await dispatchDomainEvent(event);               // best-effort snapshot handler, post-commit
```

---

## 2. Exact files

### New
- [ ] `lib/events/handlers/snapshot.ts` — the snapshot handler function only. Imports `regenerateSpaceSnapshot` from `@/lib/snapshots/regenerate`. Exports an async handler that calls `regenerateSpaceSnapshot(event.spaceId)`. **Imports nothing from `lib/events/emit.ts`** (one-directional dependency; emit registers it).

### Edited
- [ ] `lib/events/emit.ts`:
  - Extend `DOMAIN_EVENT_ACTION` with `AccountShared → AuditAction.ACCOUNT_SHARED` and `AccountShareRevoked → AuditAction.ACCOUNT_REVOKED` (both constants already exist in `lib/audit-actions.ts` — **no edit there**).
  - Change the handler type to allow async: `(event) => void | Promise<void>`.
  - Register the snapshot handler for `AccountShared` and `AccountShareRevoked` (import the fn from `./handlers/snapshot`).
  - Split dispatch out into `dispatchDomainEvent(event)` with per-handler `try/catch` + `console.warn` isolation.
  - Wire `emitDomainEvent`'s no-tx branch to call `dispatchDomainEvent`; the tx branch persists only.
- [ ] `app/api/spaces/[id]/accounts/share/route.ts`:
  - `POST`: replace the in-tx `tx.auditLog.create({ action: "ACCOUNT_SHARE", … })` with `emitDomainEvent(event, { tx })`; replace the `try/catch regenerateSpaceSnapshot` block with `await dispatchDomainEvent(event)`.
  - `DELETE`: same, for `AccountShareRevoked` / `ACCOUNT_SHARE_REVOKE`.
  - Remove the now-unused `import { regenerateSpaceSnapshot }` line; add imports for `emitDomainEvent`, `dispatchDomainEvent`.
  - Nothing else changes — `dualWriteSpaceAccountLink`, authorization, ownership checks, validation, and responses are untouched.

**Explicitly NOT touched:** `prisma/schema.prisma`, `lib/audit-actions.ts`, `lib/events/types.ts` (union already declares both variants), `lib/snapshots/regenerate.ts`, `app/api/spaces/[id]/activity/route.ts`, members route, Plaid route, any other producer.

---

## 3. Event mapping (this slice)

| Event | Emitted from | Canonical action (already exists) | Payload (== today's metadata) |
|---|---|---|---|
| `AccountShared` | `POST /accounts/share` (in-tx) | `ACCOUNT_SHARED` (was literal `ACCOUNT_SHARE`) | `{ financialAccountId, accountName: fa.name, visibilityLevel }` |
| `AccountShareRevoked` | `DELETE /accounts/share` (in-tx) | `ACCOUNT_REVOKED` (was literal `ACCOUNT_SHARE_REVOKE`) | `{ financialAccountId, accountName: link.financialAccount?.name ?? null }` |

Envelope: `spaceId` = route `spaceId`, `actorUserId` = `userId`, `ipAddress` = `getClientIp(req)`, no `performedByAdminId`, no `occurredAt` (DB default).

**Handler registration (in `emit.ts`):** `AccountShared` → snapshot handler; `AccountShareRevoked` → snapshot handler. Both resolve to `regenerateSpaceSnapshot(event.spaceId)`.

---

## 4. Row-parity expectations

**Not byte-for-byte on `action` — this is an intentional canonicalization.** Everything else is identical.

- [ ] `action`: `ACCOUNT_SHARE` → **`ACCOUNT_SHARED`**, `ACCOUNT_SHARE_REVOKE` → **`ACCOUNT_REVOKED`**. This is the intended drift correction (§2.1 of the investigation). **Safe because** the Timeline consumer's `ALLOWED_ACTIONS` and `normalizeLog` already handle *both* spellings, so the activity feed renders identically; consumer cleanup stays deferred to Slice 5.
- [ ] `metadata`: **identical** keys/values to today (POST: `{ financialAccountId, accountName, visibilityLevel }`; DELETE: `{ financialAccountId, accountName }`).
- [ ] `userId`, `spaceId` (legacy `workspaceId` column), `ipAddress`: unchanged.
- [ ] `performedByAdminId` = `null`, `userAgent` = `null`, `createdAt` = DB `now()`: unchanged.
- [ ] **Atomicity preserved:** the `AuditLog` row is still written **inside** the `$transaction` (via `emitDomainEvent(event, { tx })`), committing together with the `SpaceAccountLink` write — KD-4 guarantee intact.
- [ ] **Exactly one** `AuditLog` row per share/revoke (no duplicate from dispatch — dispatch only regenerates snapshots, it does not persist).

---

## 5. Snapshot-parity expectations (the side-effect collapse)

- [ ] `regenerateSpaceSnapshot(spaceId)` runs **exactly once** per successful share and per successful revoke — same as today — now via the handler instead of the inline call.
- [ ] No **double** regeneration: the inline `regenerateSpaceSnapshot` call **and its import** are removed in this same slice (per the investigation's double-side-effect mitigation).
- [ ] Regen runs **post-commit** (after the `$transaction` resolves), reading committed balances — same ordering as today.
- [ ] **Best-effort preserved:** a thrown error inside the handler is caught by `dispatchDomainEvent`, logged via `console.warn`, and does **not** fail the request (still `201`/`200`). Verify by injecting a temporary throw in the handler and confirming the response code + a single audit row still commit.
- [ ] Snapshot values (`netWorth`, `totalAssets`, etc.) for the affected space are identical before/after the change for the same inputs.

---

## 6. Validation (run after this slice)

- [ ] `npx prisma generate` — no schema drift expected.
- [ ] **No** `npx prisma migrate dev` — this slice introduces no migration.
- [ ] `npx tsc --noEmit` — must pass; the discriminated union guarantees the two emitted events are well-formed and the handler signature type-checks.
- [ ] `npm run lint` — 0 errors (confirm no unused `regenerateSpaceSnapshot` import remains in the share route).
- [ ] **Row-parity diff (§4):** capture `AuditLog` rows from share + revoke before/after; confirm only the `action` string changed to the canonical form and all other columns/metadata are identical; confirm the row is written inside the transaction (roll back the tx in a test → no orphan audit row).
- [ ] **Snapshot-parity (§5):** confirm exactly one regeneration per action, correct values, and that an injected handler failure yields a 2xx + `console.warn` + committed audit row.
- [ ] **Timeline non-regression:** `GET /api/spaces/[id]/activity` renders the share/unshare events identically before/after (consumer accepts both spellings).
- [ ] **Manual smoke:** as an ACTIVE member, share an owned account into a space (expect `201`, one `ACCOUNT_SHARED` row, snapshot regenerated once); revoke it (expect `200`, one `ACCOUNT_REVOKED` row, snapshot regenerated once).
- [ ] **`git diff` shows only:** `lib/events/handlers/snapshot.ts`, `lib/events/emit.ts`, `app/api/spaces/[id]/accounts/share/route.ts`.

---

## 7. Risks

- **Transaction ordering (highest).** Handler must run **post-commit**, never inside the tx. Mitigation: two-phase `emitDomainEvent` (persist-in-tx) + `dispatchDomainEvent` (post-commit) — §1.
- **Dispatch-forgotten footgun.** Because the tx path persists without dispatching, a producer that emits in-tx but forgets `dispatchDomainEvent` would silently skip the side effect. Mitigation: the dispatch call sits in the exact line position the old `regenerateSpaceSnapshot` occupied (structural 1:1), and review checks for a `dispatchDomainEvent` after every in-tx `emitDomainEvent`. (A stronger compile-time guard — e.g. emit returning a required dispatch thunk — is deliberately *not* added in this slice to keep it minimal; revisit if a second in-tx producer lands.)
- **Handler failure changing request semantics.** Today's regen is best-effort. Mitigation: per-handler `try/catch` + warn inside `dispatchDomainEvent`; verified via injected throw.
- **Double regeneration.** Mitigation: remove the inline call + import in the same slice; snapshot upsert is idempotent regardless.
- **Action canonicalization visible in audit history.** New rows use `ACCOUNT_SHARED`/`ACCOUNT_REVOKED`; historical rows keep the old literals. Intended and harmless — Timeline reads both; Slice 5 removes the dual-spelling handling only after an observation window.
- **Circular import.** `emit.ts → handlers/snapshot.ts → regenerate.ts` is one-directional; `snapshot.ts` must not import `emit.ts`. Mitigation: emit imports and registers the handler; the handler stays dependency-light.

---

## 8. Rollback

- [ ] **Per-file revert.** Restore `share/route.ts` to inline `tx.auditLog.create` (literal actions) + inline `try/catch regenerateSpaceSnapshot` + its import; revert `emit.ts` to the Slice 1 state (empty registry, single-phase, `SpaceRestored`-only map); delete `lib/events/handlers/snapshot.ts`.
- [ ] **Mixed-state safe.** Because emitted rows are ordinary `AuditLog` rows and the Timeline reads both spellings, a partially reverted state (e.g. emit reverted but route not) is still valid; no data migration or backfill is involved.
- [ ] **No irreversible steps.** No schema/table/data changes. `git revert` + redeploy fully restores prior behavior. New `ACCOUNT_SHARED`/`ACCOUNT_REVOKED` rows written while the slice was live remain valid history under either code state.
- [ ] **Optional kill switch.** If desired, guard `dispatchDomainEvent`'s handler loop behind an env flag so handlers can be disabled in production without reverting producers (persistence — the audit row — always runs, so no audit/timeline loss). Persist is never gated.

---

## 9. Exit criteria

- [ ] `lib/events/handlers/snapshot.ts` added; handler calls `regenerateSpaceSnapshot(event.spaceId)` only.
- [ ] `emit.ts` split into persist (`emitDomainEvent`) + dispatch (`dispatchDomainEvent`); snapshot handler registered for the two share events; map extended to `ACCOUNT_SHARED`/`ACCOUNT_REVOKED`.
- [ ] Share route (both verbs) emits in-tx and dispatches post-commit; inline regen + import removed.
- [ ] Row-parity (action canonicalized, all else identical, in-tx) and snapshot-parity (once, post-commit, best-effort) confirmed.
- [ ] All validation green; `git diff` limited to the three files.
- [ ] `MemberRemoved` / `ConnectionSynced` / `SnapshotGenerated` remain deferred to Slice 3; Timeline cleanup remains deferred to Slice 5.

**Stop after approval of this checklist. No implementation until approved.**
