# EV-1 — Typed Domain Event Seam (Investigation)

**Status:** Investigation only. No implementation. No code changes. No schema changes.
**Branch context:** `feature/v2.5-spaces-completion`
**Predecessors assumed complete:** SP-2 authorization, FlowType write-side, Security KD-6, Spaces Overview redesign, Daily Brief cleanup.
**Scope discipline:** This document determines the *smallest additive seam* that lets important domain actions be represented once and reused by future systems. It explicitly does **not** propose an event bus, queue, broker, pub/sub infrastructure, or asynchronous processing. Those are out of scope by direction.

---

## 0. Executive summary

Fourth Meridian already has two of the three pieces a domain-event seam needs, and they are already wired to each other by convention rather than by contract:

1. A **de facto event log** — the `AuditLog` table, written from **59 call sites** across routes, `lib`, and jobs. Every write is a hand-rolled `db.auditLog.create({ data: { action, metadata, ... } })`.
2. A **normalized consumer contract** — `TimelineEvent` (`lib/timeline-types.ts`), consumed by the Space activity timeline and reserved for the Daily Briefing engine and Notifications.

What is missing is the **seam between them**: a single typed producer surface. Because there is no typed producer, each of the 59 sites invented its own `action` string and its own `metadata` shape, and the timeline consumer now defensively accepts *both* the constant and the drifted literal for nearly every event (`SPACE_CREATE`/`SPACE_CREATED`, `ACCOUNT_SHARE`/`ACCOUNT_SHARED`, `MEMBER_ROLE_CHANGE`/`MEMBER_ROLE_CHANGED`, …). Several actions the timeline *renders* (`MEMBER_JOINED`, `MEMBER_INVITED`) have **no producer at all**, and meaningful actions (goal check-in) emit **nothing**.

The recommended seam is therefore deliberately small: a **typed `DomainEvent` discriminated union** plus one **`emitDomainEvent()` helper** that (a) persists the canonical `AuditLog` row and (b) synchronously fans out to a tiny, in-process handler registry (starting with the *already-duplicated* snapshot-regeneration side effect). No new tables. No new infrastructure. The timeline stays a pure reader. Every future consumer (Timeline enrichment, JOB-1/JOB-2 background jobs, Planner promotion, Notifications, Search indexing) attaches to the same typed event without any producer changing again.

The single most valuable outcome is not decoupling for its own sake — it is **ending action-string drift and side-effect duplication** by giving every domain action exactly one typed place to be declared and emitted.

---

## 1. Current architecture assessment

### 1.1 How domain actions propagate today

Every important domain action follows the same hand-assembled shape inside its route (or, for sync, inside `lib`/`jobs`):

1. Authorize (`requireSpaceRole` / `requireSpaceAction` / `withApiHandler`).
2. Mutate one or more tables, often inside a `db.$transaction`.
3. **Optionally** perform a downstream side effect inline (most commonly `regenerateSpaceSnapshot`).
4. **Optionally** write an `AuditLog` row inline via `db.auditLog.create`.

There is no shared producer. Steps 3 and 4 are copy-pasted per route, and whether they happen at all is decided ad hoc per site.

### 1.2 Inventory of domain action sites (as-found)

| Domain action | Where it happens | Writes AuditLog? | Action string used | Side effects wired inline |
|---|---|---|---|---|
| Space created | `app/api/spaces/route.ts:131` | ✅ | `SPACE_CREATE` (constant) | creates `AiAgent`, dashboard sections (inside txn) |
| Space updated | `app/api/spaces/[id]/route.ts:110` | ✅ | `SPACE_UPDATE` | — |
| Space archive/trash/restore/delete | `app/api/spaces/[id]/route.ts`, `.../permanent/route.ts`, `.../restore/route.ts` | ✅ | mixed constants | — |
| Member invited | `app/api/spaces/[id]/invite/route.ts`, `.../invites/route.ts` | ❌ **none** | — (timeline expects `MEMBER_INVITED`) | — |
| Member joined (invite accept) | `app/api/spaces/[id]/invites/[inviteId]/route.ts` | ❌ **none** | — (timeline renders `MEMBER_JOINED`, nothing emits it) | member→ACTIVE, invite→ACCEPTED |
| Member removed / left | `app/api/spaces/[id]/members/[userId]/route.ts:176` | ✅ | **literal** `SPACE_REMOVE_MEMBER` / `SPACE_LEAVE` (not the `MEMBER_REMOVED` constant) | `$transaction` (member flip + SAL revoke) **then** `regenerateSpaceSnapshot` (best-effort) |
| Member role changed | `app/api/spaces/[id]/members/[userId]/route.ts:81` | ✅ | **literal** `MEMBER_ROLE_CHANGE` (not `MEMBER_ROLE_CHANGED`) | — |
| Account shared | `app/api/spaces/[id]/accounts/share/route.ts:91` | ✅ (inside txn) | **literal** `ACCOUNT_SHARE` (not `ACCOUNT_SHARED`) | `regenerateSpaceSnapshot` (best-effort, outside txn) |
| Account share revoked | `app/api/spaces/[id]/accounts/share/route.ts:175` | ✅ (inside txn) | **literal** `ACCOUNT_SHARE_REVOKE` (not `ACCOUNT_REVOKED`) | `regenerateSpaceSnapshot` (best-effort, outside txn) |
| Account edited / archived | `app/api/accounts/[id]/route.ts:187` | ✅ | `MANUAL_ASSET_*` literals | `regenerateSpaceSnapshot` (best-effort) |
| Goal created | `app/api/spaces/[id]/goals/route.ts:140` | ✅ | **literal** `GOAL_CREATE` (not `GOAL_CREATED`) | — |
| Goal updated / archived / completed | `app/api/spaces/[id]/goals/[goalId]/route.ts:86,134` | ✅ | mixed (`GOAL_DELETE` reused for completion) | — |
| Goal checked in | `app/api/spaces/[id]/goals/[goalId]/check-in/route.ts` | ❌ **none** | — | `$transaction` (create `GoalCheckIn` + update goal) |
| Transactions imported | `app/api/imports/[id]/rollback/route.ts:154`, D2 import pipeline | ✅ (rollback + match only) | `IMPORT_BATCH_ROLLED_BACK`, `IMPORT_BATCH_UPDATED_ON_MATCH` (create/complete deliberately deferred) | — |
| Plaid sync / refresh | `lib/plaid/refresh.ts`, `lib/plaid/exchangeToken.ts:483` | ⚠️ partial (exchange audits; **refresh does not** write `PLAID_REFRESH`) | — | `regenerateSnapshotsForAccounts` (fan-out over shared spaces) |
| Snapshot generated | `lib/snapshots/regenerate.ts` (`regenerateSpaceSnapshot`, `regenerateSnapshotsForAccounts`) | ❌ (silent) | — | is itself the side effect |
| Connection lifecycle | `Connection` model + `lib/plaid/*` | ⚠️ partial | — | status transitions inline |

### 1.3 What already exists that the seam should reuse

- **`AuditLog`** (`prisma/schema.prisma:1459`) — `userId?`, `spaceId?` (still mapped to legacy column `workspaceId`), `action: String`, `metadata: Json?`, `ipAddress?`, `userAgent?`, `performedByAdminId?`, `createdAt`. Indexed on `[userId, createdAt]`, `[spaceId, createdAt]`, `[action, createdAt]`. This is already an append-only event store in everything but name.
- **`AuditAction`** constants + `AUDIT_ACTION_GROUPS` (`lib/audit-actions.ts`) — the intended canonical vocabulary. Underused: routes bypass it with literals.
- **`TimelineEvent` / `TimelineTone`** (`lib/timeline-types.ts`) — the normalized consumer contract, already documented as source-agnostic and reserved for Daily Briefing + Notifications.
- **`FUTURE_TIMELINE_EVENTS`** (`lib/timeline-placeholder.ts`) — preview rows enumerating the *intended* future event vocabulary (transaction, document_upload, account_linked, ai_recommendation, wallet_added, recurring_payment, investment_milestone, reminder). This is effectively an informal event backlog and should anchor naming.
- **Snapshot regeneration** (`lib/snapshots/regenerate.ts`) — already idempotent (upsert on `[spaceId, date]`) and already fan-out capable (`regenerateSnapshotsForAccounts`). This is the ideal first *event handler* because it is already the most-duplicated side effect.

**Conclusion:** EV-1 is not greenfield. The store exists, the consumer contract exists, the canonical vocabulary exists, and the first handler exists. The seam is the missing 20%.

---

## 2. Existing coupling analysis

Five concrete coupling problems, all evidenced above.

### 2.1 Action-string drift (producer ↔ consumer coupling with no contract)
The canonical constants in `lib/audit-actions.ts` say `MEMBER_REMOVED`, `MEMBER_ROLE_CHANGED`, `ACCOUNT_SHARED`, `ACCOUNT_REVOKED`, `GOAL_CREATED`. The routes actually write `SPACE_REMOVE_MEMBER`, `MEMBER_ROLE_CHANGE`, `ACCOUNT_SHARE`, `ACCOUNT_SHARE_REVOKE`, `GOAL_CREATE`. The timeline consumer (`app/api/spaces/[id]/activity/route.ts`) has therefore been forced to accept **both variants of nearly every action** in both its `ALLOWED_ACTIONS` allowlist and its `normalizeLog` switch. Every new producer risks inventing a third spelling. This is the textbook symptom a typed event contract removes.

### 2.2 Metadata-shape drift
Because there is no typed payload, the same logical field is written under different keys by different routes, and the consumer coalesces them defensively: `meta.removedName || meta.targetName`, `meta.goalName || meta.name`, `meta.visibilityLevel || meta.visibility`. The consumer is coupled to the *union of all historical producer habits*.

### 2.3 Duplicated side effects (snapshot regeneration)
`regenerateSpaceSnapshot` / `regenerateSnapshotsForAccounts` is manually re-wired at **five+ call sites** (`accounts/share` ×2, `members/[userId]`, `accounts/[id]`, `plaid/refresh`), each as a best-effort `try/catch` with a near-identical comment pointing at `BUGFIX_ARCHIVED_ACCOUNT_SNAPSHOT_STALENESS.md`. Any *future* balance- or share-mutating route must remember to replicate this. Forgetting it is precisely the class of bug those bugfix docs record. This is duplicated side-effect logic crying out for a single subscriber.

### 2.4 Missing producers for consumed events (Timeline requiring custom wiring)
The timeline renders `MEMBER_JOINED` and `MEMBER_INVITED`, but grep shows **no route emits either** — invite-create and invite-accept write no audit row at all. Goal check-in writes `GoalCheckIn` + updates the goal but emits nothing, so it can never appear in the timeline, a brief, or a notification. The consumer and producer are coupled only by hope; there is no compile-time or runtime guarantee that a rendered event type is ever produced.

### 2.5 Inconsistent audit coverage across the same concern
`lib/plaid/exchangeToken.ts` writes an audit row; `lib/plaid/refresh.ts` regenerates snapshots but writes **no** `PLAID_REFRESH` row even though the constant exists. Audit vs. side effect vs. nothing is decided per site with no rule. A single emit point makes "what happens when X occurs" answerable in one place.

**Net:** today, "one feature knowing too much about another" manifests as the *consumer* knowing every producer's historical spelling and key habits, and as *side effects* being copy-pasted into every producer. Both dissolve if producers emit one typed event and consumers subscribe.

---

## 3. Recommended typed event model

Principle: **only events that correspond to a meaningful business action that already exists** (or, in two cases, that the timeline already tries to render but nobody emits). No speculative events. Preview-only rows in `timeline-placeholder.ts` that have no backend action yet (document_upload, recurring_payment, investment_milestone, reminder) are **not** promoted to real events in EV-1 — they remain previews until a real producer exists.

### 3.1 Tier 1 — emit in EV-1 (a real producer already exists)

| Event | Emitted from | Replaces literal(s) |
|---|---|---|
| `SpaceCreated` | `POST /api/spaces` | `SPACE_CREATE`/`SPACE_CREATED` |
| `SpaceUpdated` | `PATCH /api/spaces/[id]` | `SPACE_UPDATE` |
| `MemberRemoved` | `DELETE /api/spaces/[id]/members/[userId]` | `SPACE_REMOVE_MEMBER`/`SPACE_LEAVE`/`MEMBER_REMOVED` |
| `MemberRoleChanged` | `PATCH /api/spaces/[id]/members/[userId]` | `MEMBER_ROLE_CHANGE`/`MEMBER_ROLE_CHANGED` |
| `AccountShared` | `POST /api/spaces/[id]/accounts/share` | `ACCOUNT_SHARE`/`ACCOUNT_SHARED` |
| `AccountShareRevoked` | `DELETE /api/spaces/[id]/accounts/share` | `ACCOUNT_SHARE_REVOKE`/`ACCOUNT_REVOKED` |
| `GoalCreated` | `POST /api/spaces/[id]/goals` | `GOAL_CREATE`/`GOAL_CREATED` |
| `GoalCheckedIn` | `POST /api/spaces/[id]/goals/[goalId]/check-in` | (nothing today) |
| `ConnectionSynced` | `lib/plaid/refresh.ts` (and future cron/webhook reuse) | (nothing today) |
| `SnapshotGenerated` | `lib/snapshots/regenerate.ts` | (nothing today) |

### 3.2 Tier 2 — close the two producer gaps (consumer already exists)

| Event | Emitted from | Note |
|---|---|---|
| `MemberInvited` | `POST /api/spaces/[id]/invite` | timeline already handles `MEMBER_INVITED`; no producer today |
| `MemberJoined` | `POST /api/spaces/[id]/invites/[inviteId]` (accept) | timeline already renders `MEMBER_JOINED`; no producer today |

### 3.3 Deferred (do **not** create in EV-1)
`TransactionsImported` as a first-class event is *deferred* to match the existing D2 decision to defer `IMPORT_BATCH_CREATED`/`IMPORT_BATCH_COMPLETED` (see `D2_STEP4D3_IMPORT_ROLLBACK_INVESTIGATION.md §8`). Re-litigating that is out of scope. Preview-only timeline types stay previews.

### 3.4 Shape of the contract (illustrative, not code to merge)

A single discriminated union keyed on `type`, each variant carrying a **typed, minimal payload** whose keys become the canonical metadata (ending §2.2 drift). Common envelope fields mirror what `AuditLog` already stores, so persistence is a direct mapping:

```
DomainEvent =
  | { type: "SpaceCreated";        spaceId; actorUserId; payload: { name; isPublic; category } }
  | { type: "MemberRemoved";       spaceId; actorUserId; payload: { targetUserId; targetName; newStatus } }
  | { type: "AccountShared";       spaceId; actorUserId; payload: { financialAccountId; accountName; visibilityLevel } }
  | { type: "GoalCheckedIn";       spaceId; actorUserId; payload: { goalId; goalName } }
  | { type: "ConnectionSynced";    actorUserId?; payload: { provider; connectionId; updatedAccountIds } }
  | { type: "SnapshotGenerated";   spaceId; payload: { date; netWorth } }
  | ...  // one variant per Tier-1/Tier-2 event above
```

Envelope (shared): `type`, `spaceId?`, `actorUserId?` (→ `AuditLog.userId`), `ipAddress?`, `performedByAdminId?`, `occurredAt` (→ `createdAt`). The `type` maps 1:1 to a canonical `AuditAction` value; the `payload` maps 1:1 to `AuditLog.metadata`. **No AuditLog schema change is required** — the union is purely a compile-time discipline over the existing untyped columns.

---

## 4. Smallest additive seam

Two new files, no schema change, no new dependency, no new table, no infrastructure.

### 4.1 `lib/events/types.ts` — the `DomainEvent` discriminated union (§3.4)
Pure types. Zero runtime cost. Establishes the canonical vocabulary and payload shapes, importing the existing `AuditAction` constants so `type` values and audit strings can never diverge again.

### 4.2 `lib/events/emit.ts` — one `emitDomainEvent(event, ctx?)` helper
Responsibilities, in order, all **synchronous and in-process**:

1. **Persist** the canonical `AuditLog` row (maps envelope → columns, `type` → `AuditAction`, `payload` → `metadata`). This *is* the existing behavior, centralized once. Accepts an optional Prisma `tx` so a caller can emit inside its existing `$transaction` (preserving the KD-4 atomicity guarantees at the share/member sites).
2. **Dispatch** to a small static handler registry: `Record<DomainEvent["type"], Handler[]>`. Handlers run in-process, after commit for non-transactional emits, best-effort (each wrapped so one handler failing never fails the request — exactly the current `try/catch` snapshot semantics, but written once).

The **first and only handler shipped in EV-1** is the snapshot-regeneration handler, subscribing to `AccountShared`, `AccountShareRevoked`, `MemberRemoved`, and `ConnectionSynced` — collapsing the five duplicated call sites (§2.3) into one subscriber. `SnapshotGenerated` is *emitted by* that handler's target (`regenerate.ts`) so downstream consumers (future briefs, search) can observe snapshots without re-deriving them; it does **not** re-trigger regeneration (no cycles).

### 4.3 What the seam explicitly is NOT
No queue, no Redis, no Kafka, no broker, no cross-process pub/sub, no event-sourcing/replay, no new `Event`/`Notification`/`Job` table. Dispatch is a synchronous function call through a typed map. If a future workstream needs async, it adds a handler that enqueues — the seam does not change.

### 4.4 Why this is the minimum
- Reuses `AuditLog` as the store → **0 migrations**.
- Reuses `AuditAction` + `TimelineEvent` → **0 new consumer contracts**.
- Timeline stays a pure reader over `AuditLog` → **0 consumer changes required** to benefit; it simply stops needing dual-spelling handling as producers migrate.
- Adds exactly one producer surface and one handler registry.

---

## 5. Example event flow

**Account shared into a Space** (today vs. with the seam).

**Today** (`POST /api/spaces/[id]/accounts/share`):
1. Authorize.
2. `db.$transaction`: upsert `SpaceAccountLink` + `db.auditLog.create({ action: "ACCOUNT_SHARE", metadata: { financialAccountId, accountName, visibilityLevel } })`.
3. Separately, `try { regenerateSpaceSnapshot(spaceId) } catch { console.warn(...) }`.
4. Timeline later reads the row and must match *either* `ACCOUNT_SHARE` or `ACCOUNT_SHARED`, coalescing `visibilityLevel || visibility`.

**With the seam:**
1. Authorize.
2. `db.$transaction`: upsert `SpaceAccountLink`, then `emitDomainEvent({ type: "AccountShared", spaceId, actorUserId, payload: { financialAccountId, accountName, visibilityLevel } }, { tx })` — which writes the canonical `AuditLog` row (`action = AuditAction.ACCOUNT_SHARED`) inside the same transaction.
3. After commit, the emit helper dispatches to the snapshot handler → `regenerateSpaceSnapshot(spaceId)` (best-effort, centralized). That regeneration in turn emits `SnapshotGenerated`.
4. Timeline reads a **single canonical action** with a **single payload shape**. Future Notifications/Search subscribe to `AccountShared` with no producer change.

Net change at the route: the two hand-rolled blocks (audit create + snapshot try/catch) collapse into one typed `emitDomainEvent` call. Behavior is identical; the wiring moves behind the seam.

---

## 6. Recommended implementation slices

Each slice is independently shippable, additive-before-subtractive, and independently reversible. **Checklist first, approval, then implement — one slice at a time.** No slice removes a legacy literal until §7's observation gate passes.

**Slice 0 — Types only (zero runtime).**
- [ ] Add `lib/events/types.ts` (`DomainEvent` union, Tier-1 + Tier-2 variants) importing `AuditAction`.
- [ ] No emit, no callers. `tsc --noEmit` proves the union compiles and maps to existing constants.

**Slice 1 — Emit helper + persistence parity (no behavior change).**
- [ ] Add `lib/events/emit.ts` with `emitDomainEvent` that *only* writes the `AuditLog` row (empty handler registry), `tx`-aware.
- [ ] Migrate **one** low-risk site (`SpaceUpdated`) from inline `auditLog.create` to `emitDomainEvent`. Verify identical row shape.

**Slice 2 — Snapshot handler (collapse the duplication).**
- [ ] Register the snapshot handler for `AccountShared` / `AccountShareRevoked` / `MemberRemoved` / `ConnectionSynced`.
- [ ] Migrate the share route (both verbs) to emit; the inline `regenerateSpaceSnapshot` calls become the handler. Keep the legacy literal *readable* by the timeline (additive).

**Slice 3 — Remaining Tier-1 producers.**
- [ ] Migrate members (remove/role), goals (create/checked-in), spaces (create), plaid refresh (`ConnectionSynced`), and `regenerate.ts` (`SnapshotGenerated`).

**Slice 4 — Tier-2 gap closure.**
- [ ] Emit `MemberInvited` (invite create) and `MemberJoined` (invite accept) — new producers for already-rendered timeline events.

**Slice 5 — Consumer simplification (subtractive, gated).**
- [ ] Once producers emit only canonical actions and an observation window confirms no drifted literals are being written, remove the dual-spelling branches from `activity/route.ts` `ALLOWED_ACTIONS` + `normalizeLog`, and the metadata-key coalescing.

---

## 7. Risks

- **Transaction boundary regressions (highest).** The share and member routes rely on KD-4 atomicity (audit row commits with the mutation). `emitDomainEvent` **must** accept and use the caller's `tx` for the persistence step, or it silently breaks that guarantee. Mitigation: `tx`-aware signature from Slice 1; the snapshot handler stays *outside* the transaction (post-commit), exactly as today.
- **Handler failure changing request semantics.** Today snapshot regen is best-effort (`try/catch`, non-fatal). The dispatcher must preserve per-handler isolation so an emit never fails a request that previously succeeded. Mitigation: wrap each handler; log-and-continue.
- **Double side effects during migration.** If a route both emits (handler regenerates) *and* still calls `regenerateSpaceSnapshot` inline, the snapshot regenerates twice. Harmless (idempotent upsert) but wasteful. Mitigation: remove the inline call in the *same* slice that adds the emit for that site.
- **Action-string ambiguity during transition.** While some sites emit canonical actions and others still write literals, the timeline must keep accepting both. Mitigation: consumer cleanup is deliberately the *last* slice (§6 Slice 5), gated on observation.
- **Scope creep into an event bus.** The registry is a temptation to add async, retries, ordering. Mitigation: this doc is the guardrail — synchronous in-process dispatch only; async is a *handler's* concern, never the seam's.
- **Legacy column naming.** `AuditLog.spaceId` still maps to `workspaceId` and `WorkspaceAccountShare` remains the write system of record for shares (D3). The seam must not rename either. Mitigation: envelope uses `spaceId`; persistence maps to the existing column; no rename.

---

## 8. Rollback strategy

The seam is additive, so rollback is proportional and staged:

- **Slices 0–1:** delete `lib/events/*`; revert the single migrated call site back to inline `auditLog.create`. No data migration, no schema change, nothing to undo in the DB.
- **Slices 2–4:** per-site revert — restore the inline `auditLog.create` + inline `regenerateSpaceSnapshot` for any route that regresses. Because emits write the *same* `AuditLog` rows, historical data is unaffected either way; a mixed state (some sites emitting, some inline) is fully valid because the timeline still reads both spellings.
- **Slice 5 (only subtractive slice):** revert is restoring the dual-spelling branches in `activity/route.ts`. Keep that diff isolated and small precisely so it can be reverted alone. Do not enter Slice 5 until the observation window (below) is green.
- **Kill switch:** an optional env-guarded no-op in `emitDomainEvent`'s dispatch step lets handlers be disabled in production without redeploying producers (persistence still runs, so audit/timeline are never lost). Emit-persistence itself is never switched off.
- **No irreversible steps:** no table is created, altered, or dropped; no legacy table removed; no data backfilled or rewritten. There is nothing that a `git revert` plus redeploy cannot fully undo.

---

## 9. Validation plan

Per project working style, run after **each** slice, not once at the end:

- [ ] `npx prisma generate` — sanity (no schema change expected; confirms nothing drifted).
- [ ] *No* `npx prisma migrate dev` — EV-1 introduces **no** migration. If a slice appears to need one, stop: that slice has left scope.
- [ ] `npx tsc --noEmit` — the discriminated union is the primary safety net; this must pass with zero errors and is the main proof that producers emit well-formed events.
- [ ] `npm run lint`.
- [ ] **Row-parity check (Slices 1–4):** for each migrated site, diff the `AuditLog` row written by `emitDomainEvent` against the pre-migration inline row (action string, metadata keys/values, `userId`, `spaceId`, `ipAddress`). They must match except for the *intended* canonicalization of the action string.
- [ ] **Snapshot-parity check (Slice 2–3):** confirm `SpaceSnapshot` is regenerated exactly once per share/revoke/member-removal/refresh and that values match the pre-seam output; confirm handler failure does not fail the request (inject a throw, assert 2xx + warn log).
- [ ] **Timeline non-regression:** hit `GET /api/spaces/[id]/activity` before/after each producer migration; the rendered events must be unchanged (same titles/tones/order) because the consumer still reads both spellings until Slice 5.
- [ ] **Gap-closure check (Slice 4):** invite + accept now produce `MEMBER_INVITED` / `MEMBER_JOINED` rows that render in the timeline (previously absent).
- [ ] **Observation window before Slice 5:** confirm via `AuditLog` query that no drifted literals (`ACCOUNT_SHARE`, `GOAL_CREATE`, `MEMBER_ROLE_CHANGE`, `SPACE_REMOVE_MEMBER`, `SPACE_LEAVE`) are being *written* by any live path; only then remove the consumer's dual-spelling handling.
- [ ] Targeted manual UI test of the Space activity timeline and the share/member/goal flows after each producer slice.

---

## 10. Future compatibility (no redesign required)

The same typed event, once emitted, serves every named future workstream by *adding a handler or a reader* — never by changing a producer:

- **Timeline** — already a reader; benefits immediately as spellings/payloads canonicalize. Real events replace `timeline-placeholder.ts` entries one-for-one as producers appear.
- **JOB-1 / JOB-2 (background jobs)** — register a handler that enqueues work (the *handler* owns async; the seam stays synchronous). `ConnectionSynced` / `SnapshotGenerated` are natural triggers.
- **Planner promotion** — subscribe to `GoalCheckedIn` / `GoalCreated` without touching the goal routes.
- **Notifications** — subscribe to `MemberInvited` / `MemberJoined` / `AccountShared`; the `TimelineEvent` contract already reserves this consumer.
- **Search indexing** — subscribe to create/update events to keep an index fresh; no producer change.
- **Audit history** — already the store; now guaranteed consistent action strings and payloads.
- **Ambient Intelligence / future integrations** — attach as additional handlers/readers on the existing union.

Because the store (`AuditLog`), the consumer contract (`TimelineEvent`), and the vocabulary (`AuditAction`) are all reused, none of these require a schema change or a producer rewrite. That is the definition of the seam succeeding.

---

## 11. Recommendation

Proceed to a **D-style implementation checklist for Slice 0 + Slice 1 only** (types + emit-with-persistence-parity, one migrated site). This is the smallest possible step that proves the seam end-to-end with zero behavior change and zero schema change, and it is fully revertible with a single `git revert`. Hold Slices 2–5 for separate approval, one at a time, per project working style.

**Stop here — investigation only. No implementation performed.**
