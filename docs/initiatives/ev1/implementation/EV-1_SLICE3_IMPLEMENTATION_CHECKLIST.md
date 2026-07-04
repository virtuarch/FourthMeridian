# EV-1 — Slice 3 Implementation Checklist

**Status:** Checklist only. No implementation. Awaiting approval.
**Source of truth:** `docs/investigations/EV-1_TYPED_DOMAIN_EVENT_SEAM_INVESTIGATION.md`, `EV-1_SLICE2_IMPLEMENTATION_CHECKLIST.md`
**Completed:** Slice 0 (types), Slice 1 (`emitDomainEvent` + `SpaceRestored`), Slice 2 (`dispatchDomainEvent` + snapshot handler + `AccountShared`/`AccountShareRevoked`).
**Branch context:** `feature/v2.5-spaces-completion`

**Goal:** smallest next slice; one producer family; reuse the proven seam.

---

## 1. Current architecture assessment

The seam is proven end-to-end: a two-phase producer (`emitDomainEvent` persist / `dispatchDomainEvent` dispatch), one registered handler (`regenerateSnapshotOnShareChange`), and canonicalized actions on the share route with full parity. Three candidate producers remain in the "snapshot-touching" cluster: **MemberRemoved**, **ConnectionSynced**, **SnapshotGenerated**. They are *not* equivalent in shape, and that difference drives the scope decision below.

---

## 2. Producer analysis

### 2.1 MemberRemoved — `DELETE /api/spaces/[id]/members/[userId]`

Evidence (`app/api/spaces/[id]/members/[userId]/route.ts:94–187`):

- **Producer:** the `DELETE` handler (the `PATCH` role-change handler in the same file is a *different* producer — `MemberRoleChanged` — and is **out of scope**).
- **Transaction:** `db.$transaction([...])` — **array form** (member soft-update + `SpaceAccountLink.updateMany` revoke). KD-4 guarantees these two commit together. **No audit row is inside this transaction.**
- **AuditLog write:** a standalone `db.auditLog.create` **outside and after** the transaction (line 176), with a **conditional action**: `isSelf ? "SPACE_LEAVE" : "SPACE_REMOVE_MEMBER"` — i.e. **two logical events from one write**. Metadata is identical for both: `{ removedUserId: targetUserId, removedName, newStatus }`.
- **Snapshot regen:** `regenerateSpaceSnapshot(spaceId)` — single-space, **best-effort** (`try/catch`, non-fatal), post-commit, running **before** the audit write (line 166).
- **Fit with the Slice 2 model:** **Good, via the NO-TX emit path** — because today's audit is *already outside* the transaction. The array-form transaction is left **untouched** (tx guarantee preserved), and the post-commit `try/catch snapshot` + `auditLog.create` collapse into a single `emitDomainEvent(event)` (no `tx`) that persists the audit and dispatches the **already-registered** snapshot handler.
- **Two frictions (both small, both must be handled to preserve behavior):**
  1. **Two events, distinct Timeline rendering.** The activity feed renders `SPACE_LEAVE` → "Member left" (LogOut, neutral) and `SPACE_REMOVE_MEMBER`/`MEMBER_REMOVED` → "Member removed" (UserMinus, warning). Collapsing to one action would change rendering → forbidden. Therefore Slice 3 introduces **two** event types: `MemberRemoved` (admin) and `MemberLeft` (self).
  2. **Action canonicalization.** `MEMBER_REMOVED` already exists as a constant, so `MemberRemoved → MEMBER_REMOVED` is a safe canonicalization (Timeline allowlist already contains both spellings, both render "Member removed" — same as Slice 2's approach). **`SPACE_LEAVE` has no constant** (see §3.1 decision point).
- **Payload correction:** the provisional `MemberRemoved` payload in `lib/events/types.ts` currently uses `{ targetUserId, targetName, newStatus }` — it must be corrected to the **actual** metadata keys `{ removedUserId, removedName, newStatus }` to preserve byte parity.

**Verdict: MemberRemoved is the right next family.** Its side effect *reuses the existing handler verbatim*, the diff is small, and the tx boundary is untouched.

### 2.2 ConnectionSynced — `lib/plaid/refresh.ts` (`refreshPlaidItem`)

Evidence (`lib/plaid/refresh.ts`, and call-site grep):

- **Producer:** `refreshPlaidItem` — a **lib pipeline**, not a route. Reused by `POST /api/plaid/refresh`, the Plaid provider adapter (`lib/providers/plaid/adapter.ts`), and reserved for a future cron/webhook.
- **Snapshot regen:** `regenerateSnapshotsForAccounts(updatedAccountIds)` (line 320) — a **fan-out**: resolves *every* space that links the changed accounts and regenerates each. Fundamentally different from `regenerateSpaceSnapshot(spaceId)`.
- **Not best-effort:** it is a plain `await` with **no `try/catch`** — a failure propagates and fails the refresh. Moving it behind `dispatchDomainEvent` (which *swallows* handler errors) would **change error semantics** from fatal to best-effort. ✗
- **Return-value contract:** the result (`spacesSnapshotted: string[]`) is returned and surfaced in `RefreshSummary`. A fire-and-forget dispatch handler **cannot return** that value → breaks the contract. ✗
- **No audit today:** `refreshPlaidItem` writes **no** audit row. Emitting `ConnectionSynced` would be **net-new** behavior (not parity). ✗
- **No transaction; no single spaceId** (spans many spaces). The envelope's single `spaceId` doesn't fit.
- **Entangled family:** `regenerateSnapshotsForAccounts` is called from **~7 sites** (refresh, exchange-token, manual create/restore, wallet create/archive/restore, account restore). A proper migration is really an *"account balances changed → fan out to sharing spaces"* event family with its own handler shape.

**Verdict: ConnectionSynced does not fit the Slice 2 model.** Folding it into Slice 3 would break the return-value contract, flip error semantics, and add non-parity audit rows.

### 2.3 SnapshotGenerated

- **No consumer exists.** The Timeline has no `SnapshotGenerated` case; no brief/search/index reads it. Emitting it now produces audit rows nobody consumes — pure noise, and **not parity** (net-new writes on every `regenerateSpaceSnapshot` call, which fires from many paths).
- **No constant** (`SNAPSHOT_GENERATED` absent from `lib/audit-actions.ts`).
- As a **handler output** it adds no value without a consumer; as a **producer** it is premature.

**Verdict: SnapshotGenerated remains DEFERRED** until a real consumer (e.g. Search indexing, or a brief) needs it — consistent with "smallest additive, no consumer without a use."

---

## 3. Recommended Slice 3 scope

**Recommendation: Option A — Slice 3 migrates the MemberRemoved family only.**
- ConnectionSynced → **Option C**: its own dedicated future slice (Slice 4), designed around the fan-out + return-value + net-new-audit realities in §2.2.
- SnapshotGenerated → **deferred**.

**Option B (MemberRemoved + ConnectionSynced) is rejected**: §2.2 shows ConnectionSynced cannot be parity-migrated alongside MemberRemoved without breaking its return-value contract, changing error semantics, or introducing non-parity audit. Bundling would also blow the "extremely small diff" constraint.

Slice 3 migrates the `DELETE` member handler as **two events** — `MemberRemoved` (self=false) and `MemberLeft` (self=true) — both reusing the existing `regenerateSnapshotOnShareChange` handler via the **no-tx emit path**.

### 3.1 Decision point (needs your approval): the `SPACE_LEAVE` action

`MemberLeft` must keep rendering as "Member left", which the Timeline keys off the action string `SPACE_LEAVE`. That string has **no `AuditAction` constant**. Two ways to map it:

- **(Recommended) Add one line to `lib/audit-actions.ts`:** `SPACE_LEAVE: "SPACE_LEAVE"`. Tiny, codifies an action the Timeline already treats as first-class, keeps `DOMAIN_EVENT_ACTION` fully `AuditActionType`-typed. This is the only touch to `audit-actions.ts`.
- **(Alternative) No `audit-actions.ts` change:** widen `DOMAIN_EVENT_ACTION`'s value type to `AuditActionType | (string & {})` and map `MemberLeft → "SPACE_LEAVE"` as a literal. Avoids the audit-actions edit but weakens the type guarantee.

This checklist assumes the **recommended** option (one-line constant add). Confirm or switch to the alternative before implementation.

---

## 4. Exact files

### Edited
- [ ] `lib/events/types.ts` — correct `MemberRemoved` payload to `{ removedUserId, removedName, newStatus }`; add `MemberLeft` variant with the same payload shape. (Types only.)
- [ ] `lib/audit-actions.ts` — **decision-gated (§3.1):** add `SPACE_LEAVE: "SPACE_LEAVE"` under the Members/Spaces group. (Skip if the alternative mapping is chosen.)
- [ ] `lib/events/emit.ts` — extend `DOMAIN_EVENT_ACTION` with `MemberRemoved → AuditAction.MEMBER_REMOVED` and `MemberLeft → AuditAction.SPACE_LEAVE`; register `regenerateSnapshotOnShareChange` for both `MemberRemoved` and `MemberLeft` in `HANDLERS`.
- [ ] `app/api/spaces/[id]/members/[userId]/route.ts` — **`DELETE` handler only:** build the event (`type` chosen by `isSelf`), replace the post-commit `try/catch regenerateSpaceSnapshot` block **and** the standalone `db.auditLog.create` with a single `await emitDomainEvent(event)` (no `tx`); remove the now-unused `import { regenerateSpaceSnapshot }`. **The `db.$transaction([...])` block, auth, validation, name derivation, and responses are untouched.** The `PATCH` handler is untouched.

**Explicitly NOT touched:** `prisma/schema.prisma`, `lib/snapshots/regenerate.ts`, `lib/events/handlers/snapshot.ts`, `app/api/spaces/[id]/activity/route.ts`, Plaid/refresh, any other producer, the member `PATCH` handler.

**Expected `git diff`:** `lib/events/types.ts`, `lib/audit-actions.ts` (if §3.1 recommended), `lib/events/emit.ts`, `app/api/spaces/[id]/members/[userId]/route.ts`.

---

## 5. Event mappings

| `isSelf` | Event | Canonical action | Was (literal) | Payload (== today's metadata) |
|---|---|---|---|---|
| `false` | `MemberRemoved` | `MEMBER_REMOVED` | `SPACE_REMOVE_MEMBER` | `{ removedUserId, removedName, newStatus }` |
| `true` | `MemberLeft` | `SPACE_LEAVE` (new constant, same string) | `SPACE_LEAVE` | `{ removedUserId, removedName, newStatus }` |

Envelope for both: `spaceId` = route `spaceId`, `actorUserId` = `user.id`, `ipAddress` = `getClientIp(req)`, no `performedByAdminId`, no `occurredAt`.
Handler registration (both events): `regenerateSnapshotOnShareChange` → `regenerateSpaceSnapshot(event.spaceId)`.

---

## 6. Transaction ordering

- [ ] The `db.$transaction([memberUpdate, salRevoke])` array-form block is **preserved exactly** — member soft-update and share revoke still commit together (KD-4). **Do not** convert it to callback form; **do not** move the audit into it.
- [ ] After the transaction commits, call `await emitDomainEvent(event)` **without** `ctx.tx`. The no-tx path persists the audit row on the shared client, then dispatches the snapshot handler inline (post-commit).
- [ ] **Ordering note (immaterial):** today the sequence is *snapshot → audit*; after migration it is *audit persist → snapshot dispatch*. Both are post-commit, both awaited; no consumer depends on their relative order. This is the only ordering change and it is safe.

---

## 7. Row-parity expectations

- [ ] **Action** (intentional canonicalization for the removed case; identical string for leave):
  - self=false: `SPACE_REMOVE_MEMBER` → **`MEMBER_REMOVED`**. Safe — Timeline allowlist + `normalizeLog` already map both to "Member removed".
  - self=true: `SPACE_LEAVE` → **`SPACE_LEAVE`** (unchanged string; now via a constant). Renders "Member left" exactly as today.
- [ ] **Metadata:** identical keys/values — `{ removedUserId, removedName, newStatus }` — for both paths.
- [ ] `userId`, `spaceId` (legacy `workspaceId` column), `ipAddress`: unchanged.
- [ ] `performedByAdminId` = `null`, `userAgent` = `null`, `createdAt` = DB `now()`: unchanged.
- [ ] **Exactly one** `AuditLog` row per removal/leave (dispatch persists nothing).
- [ ] Audit remains **outside** the transaction (same as today) — no atomicity change.

---

## 8. Side-effect parity expectations

- [ ] `regenerateSpaceSnapshot(spaceId)` runs **exactly once** per successful removal/leave — now via the handler, not the inline call.
- [ ] **No double regen:** the inline `regenerateSpaceSnapshot` call and its import are removed in this same slice.
- [ ] Regen runs **post-commit** (after the array-form transaction resolves).
- [ ] **Best-effort preserved:** a handler throw is caught by `dispatchDomainEvent` (warn + swallow) → request still `200`. Verify with an injected throw.
- [ ] Snapshot values for the affected space identical before/after for the same inputs.

---

## 9. Validation plan

- [ ] `npx prisma generate` — no schema drift expected.
- [ ] **No** `npx prisma migrate dev`.
- [ ] `npx tsc --noEmit` — must pass; the union enforces both member events' payloads; `DOMAIN_EVENT_ACTION` must resolve both actions (requires the §3.1 constant if recommended option chosen).
- [ ] `npm run lint` — 0 errors; confirm no unused `regenerateSpaceSnapshot` import remains in the member route.
- [ ] **Row-parity diff:** capture `AuditLog` rows for (a) admin removal and (b) self-leave, before/after. Confirm: removal action canonicalized to `MEMBER_REMOVED`, leave action stays `SPACE_LEAVE`, all other columns/metadata identical, audit still outside the tx (roll back the tx in a test → member/share unchanged AND no audit written for that attempt... note: audit is separate and post-commit, so verify it is only written on the success path, as today).
- [ ] **Side-effect parity:** exactly one regen per action, post-commit, and an injected handler throw yields `200` + `console.warn` + one audit row.
- [ ] **Timeline non-regression:** `GET /api/spaces/[id]/activity` renders "Member removed" and "Member left" identically before/after (consumer accepts both spellings; leave string unchanged).
- [ ] **Manual smoke:** owner removes a member (expect `200`, one `MEMBER_REMOVED` row, one regen); a member leaves (expect `200`, one `SPACE_LEAVE` row, one regen).
- [ ] **`git diff` shows only** the files in §4.

---

## 10. Rollback strategy

- [ ] **Per-file revert.** Restore the member `DELETE` handler to inline `try/catch regenerateSpaceSnapshot` + standalone `db.auditLog.create` (conditional literal actions) + its import; revert `emit.ts` (remove the two member entries from map + registry); revert `types.ts` payload/variant; revert the `audit-actions.ts` one-liner (if added).
- [ ] **Mixed-state safe.** Emitted rows are ordinary `AuditLog` rows; Timeline reads both spellings; a partially reverted state is valid. No data migration/backfill.
- [ ] **No irreversible steps.** No schema/table/data changes. `git revert` + redeploy fully restores prior behavior; `MEMBER_REMOVED`/`SPACE_LEAVE` rows written while live remain valid history under either code state.
- [ ] **Optional kill switch.** The existing `dispatchDomainEvent` isolation already prevents handler failures from affecting requests; no additional switch needed for this slice.

---

## 11. Exit criteria

- [ ] `DELETE` member handler emits `MemberRemoved`/`MemberLeft` via the no-tx path; array-form transaction untouched; inline regen + import removed.
- [ ] Snapshot handler reused (registered for both member events); exactly one post-commit, best-effort regen per action.
- [ ] Row parity (action canonicalized/preserved, all else identical) and side-effect parity confirmed; Timeline unchanged.
- [ ] All validation green; `git diff` limited to §4 files.
- [ ] `ConnectionSynced` designated as its own Slice 4 (Option C); `SnapshotGenerated` deferred; `MemberRoleChanged` and Timeline/consumer cleanup remain deferred.

**Stop after approval of this checklist. No implementation until approved — including the §3.1 decision.**
