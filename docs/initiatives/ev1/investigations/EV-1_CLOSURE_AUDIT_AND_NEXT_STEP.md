# EV-1 — Closure Audit and Next-Step Recommendation

**Status:** Investigation only. No code, no schema, no Timeline cleanup, no producer migration.
**Scope covered:** Slices 0–5B (typed `DomainEvent` union, `emitDomainEvent`, `dispatchDomainEvent`, snapshot handler, and 9 migrated events across 6 producers).
**Branch context:** `feature/v2.5-spaces-completion`

---

## 1. EV-1 current state summary

The seam is proven and in production use across the core mutating domain actions. Nine event types flow through `emitDomainEvent`, six of them exercised by live producers:

| Producer (file) | Event(s) | Canonical action | Handler |
|---|---|---|---|
| `spaces/[id]/restore` | `SpaceRestored` | `SPACE_RESTORED` | none |
| `spaces/[id]/accounts/share` (POST/DELETE) | `AccountShared` / `AccountShareRevoked` | `ACCOUNT_SHARED` / `ACCOUNT_REVOKED` | snapshot (in-tx emit + post-commit dispatch) |
| `spaces/[id]/members/[userId]` (DELETE) | `MemberRemoved` / `MemberLeft` | `MEMBER_REMOVED` / `SPACE_LEAVE` | snapshot (no-tx) |
| `spaces/[id]/members/[userId]` (PATCH) | `MemberRoleChanged` | `MEMBER_ROLE_CHANGED` | none |
| `spaces/[id]/goals` (POST) | `GoalCreated` | `GOAL_CREATED` | none |
| `lib/plaid/refresh.ts` | `ConnectionSynced` | `PLAID_REFRESH` | none (audit-only) |

The seam has demonstrated all three of its intended shapes: **in-transaction persist + post-commit dispatch** (share), **no-tx audit-only** (restore, role change, goal create), and **fan-out-adjacent audit-only** (connection sync). The two-phase `emit`/`dispatch` split and the best-effort handler isolation both held up.

**Original EV-1 objective — a typed seam plus elimination of Timeline-visible action drift — is met.** Slices 5A/5B closed the last two drifted producers.

---

## 2. Producer inventory (post-5B)

### 2.1 Q1 — Are all live Timeline-visible producers canonical? **Yes (drift fully resolved).**

Every Timeline-visible action a live producer writes is now either seam-routed canonical or a canonical constant with no competing spelling:

- Seam-routed canonical: `ACCOUNT_SHARED`, `ACCOUNT_REVOKED`, `MEMBER_REMOVED`, `SPACE_LEAVE`, `MEMBER_ROLE_CHANGED`, `GOAL_CREATED`.
- Direct but canonical (constant, **not drift**): `SPACE_CREATE`, `SPACE_UPDATE` (+ archive/unarchive). These match their `AuditAction` constants; the `SPACE_CREATED` Timeline alias is dead (never produced).
- Direct bare literals, **not drift** (no competing canonical constant): `GOAL_DELETE`, `MANUAL_ASSET_ADD` / `MANUAL_ASSET_DELETE` / `MANUAL_ASSET_RESTORE`.

No live producer writes a legacy spelling that competes with a canonical constant. The three retired legacy literals (`ACCOUNT_SHARE`, `ACCOUNT_SHARE_REVOKE`, `SPACE_REMOVE_MEMBER`) plus the two just-retired ones (`MEMBER_ROLE_CHANGE`, `GOAL_CREATE`) exist only in historical rows.

### 2.2 Q2 — Producers that bypass `emitDomainEvent` but are **not** drifted

- **Space lifecycle:** `SPACE_CREATE`, `SPACE_UPDATE`/`SPACE_ARCHIVED`/`SPACE_UNARCHIVED`, `SPACE_TRASHED`, `SPACE_PERMANENT_DELETE`. (Canonical constants; `SpaceCreated`/`SpaceUpdated` events declared but not routed.)
- **Goal lifecycle:** `GOAL_UPDATE`, `GOAL_DELETE`, `GOAL_PURGE`.
- **Manual assets:** `MANUAL_ASSET_ADD` / `_UPDATE` / `_DELETE` / `_PERMANENT_DELETE` / `_RESTORE` (bare literals, no constants).
- **Account/connection lifecycle:** `ACCOUNT_RENAMED`, `ACCOUNT_REMOVE`, `ACCOUNT_RESTORE`, `ACCOUNT_ADD`, `WALLET_ADD`, `DEBT_PROFILE_UPDATED`.
- **Platform / security / auth / AI / import (non-domain):** `LOGIN`, `LOGOUT`, `PASSWORD_*`, `TWO_FACTOR_*`, `SESSION_*`, `SPACE_SWITCH`, `REGISTER`, `PLAID_SYNC`, `PLAID_REFRESH` (manual route), `IMPORT_BATCH_*`, `AI_*`, `PLATFORM_SETTINGS_UPDATED`, `RECOVERY_CODE_*`.

### 2.3 Q3 — Which should remain direct for now

- **Permanently direct (not domain events):** all auth/2FA/session/password/AI/platform/import producers. They are personal/security/platform records with no Timeline/Jobs/Planner/Notifications consumer; routing them through the seam adds indirection for zero benefit.
- **Direct until a consumer needs them:** space lifecycle (create/update/trash/delete), account/manual-asset lifecycle. Non-drifted and stable; migrate only when a concrete consumer (e.g. Timeline "asset added", a job, a notification) justifies it — not as internal-consistency busywork.

### 2.4 Q4 — Remaining event gaps (business actions with no producer)

| Gap | Action site | Current behavior | Timeline consumer ready? |
|---|---|---|---|
| **MemberInvited** | `spaces/[id]/invite`, `spaces/[id]/invites` (POST) | writes **no** audit/event | **Yes** — `MEMBER_INVITED` is in `ALLOWED_ACTIONS` + `normalizeLog` ("Member invited") |
| **MemberJoined** | `spaces/[id]/invites/[inviteId]` (accept) | sets member `ACTIVE` + invite `ACCEPTED` in a `$transaction`; **no** audit/event | **Yes** — `MEMBER_JOINED` rendered ("Member joined") |
| **GoalCheckedIn** | `spaces/[id]/goals/[goalId]/check-in` | `$transaction([checkIn create, goal update])`; **no** audit/event | **No** — not yet in the Timeline vocabulary |
| TransactionsImported | D2 import pipeline | deferred by standing D2 decision | partial |
| SnapshotGenerated | `regenerate.ts` | deferred (no consumer) | n/a |
| Preview-only types | `timeline-placeholder.ts` | document_upload, wallet_added, recurring_payment, investment_milestone, reminder, ai_recommendation — no producers | placeholder only |

The first two are the notable ones: the Timeline was **built to show member invitations and joins**, but nothing has ever produced those rows. `GoalCheckedIn` is a real business action that currently vanishes (no audit at all).

### 2.5 Q5 — Is Slice 5C (Timeline dual-spelling cleanup) safe now?

**No — wait for observation.** 5A established two preconditions: (a) all live producers canonical, and (b) legacy-spelling rows aged out of the Timeline's rolling ~100-row window (or accepted). (a) is now **true**. (b) is **not**: `ACCOUNT_SHARE`, `ACCOUNT_SHARE_REVOKE`, `SPACE_REMOVE_MEMBER`, `MEMBER_ROLE_CHANGE`, and `GOAL_CREATE` were live until their respective slices shipped **very recently**, so recent history still contains them. Removing the aliases now would blank those rows in active feeds. The upside of 5C is purely cosmetic (normalizer simplification); the downside is broken recent-history rendering. Low reward, real risk → defer until an observation window confirms legacy rows are gone from active windows.

---

## 3. Risks

- **Premature 5C** blanks recent historical activity rows. Mitigation: defer; re-run the §2.1 audit + a read-only "are legacy spellings still in recent rows?" check before cleanup.
- **Gap-fill is a *visible* behavior change, not parity.** Emitting `MemberInvited`/`MemberJoined` will make new rows **appear** in the Timeline (the consumer already renders them). That is desirable and was the original design intent, but it is not a byte-parity migration like Slices 2–5B — it must be approved as an intentional product change.
- **Transaction boundaries at the gap sites.** Invite-accept and goal-check-in both mutate inside `$transaction`. Filling them must use the established in-tx `emitDomainEvent(…, { tx })` + post-commit `dispatchDomainEvent` pattern (or emit post-commit) to preserve atomicity — exactly the care taken on the share route.
- **Scope creep into non-domain producers.** Migrating auth/lifecycle producers "for completeness" would add churn with no consumer. Avoid.
- **`GoalCheckedIn` has no consumer yet** (not in Timeline vocabulary). Emitting it now is net-new audit with no immediate reader — lower priority than the two member gaps, unless the Timeline (or Planner) is extended to show it in the same slice.

---

## 4. Recommended decision: **Pause the canonicalization track; pivot to Timeline foundation.**

EV-1's internal-consistency objective is **complete** — declare the canonicalization phase closed. Do **not** continue migrating non-drifted lifecycle/security producers (no consumer, no drift, pure busywork), and do **not** rush 5C (must wait for observation).

The seam now exists precisely so new domain events can reach consumers cheaply. The highest-value next move is to **start using it for the Timeline product**, beginning with the gaps the Timeline was already designed to show but that no producer feeds. This is where EV-1 converts from internal plumbing into user-visible value.

Concretely: **continue to more producers, but only the ones with a waiting consumer** — `MemberJoined` and `MemberInvited` (Timeline handlers already exist), then `GoalCheckedIn` (paired with extending the Timeline vocabulary to render it).

---

## 5. Recommended next checklist

**Slice T-1 — Timeline Producer Gap-Fill (member lifecycle).**
- Scope: emit `MemberInvited` (invite create) and `MemberJoined` (invite accept) via the seam — net-new, audit-only, no handler.
- Investigate first: the transaction boundary at invite-accept (member→ACTIVE + invite→ACCEPTED runs in a `$transaction`) → use in-tx persist + post-commit dispatch, or emit post-commit; finalize the provisional `MemberInvited`/`MemberJoined` payloads against the real available fields (invited email/role; joining user id); confirm `MEMBER_INVITED`/`MEMBER_JOINED` require no `AuditAction` additions (they exist as constants) .
- Explicit acknowledgment: unlike prior slices this **adds visible Timeline rows** (intended product change, not parity) — validate that the invited/joined events render correctly and that no duplicate rows arise from invite→accept flows.
- Defer: `GoalCheckedIn` (needs Timeline vocabulary work — a follow-on **Slice T-2**), 5C dual-spelling cleanup (after observation), and all non-drifted lifecycle/security producer migrations.

**Then, on a later cadence:**
- **Slice T-2 — GoalCheckedIn** (producer + Timeline vocabulary entry), if check-ins should surface in activity.
- **Slice 5C — Timeline dual-spelling cleanup** (consumer-only), gated on an observation window confirming legacy spellings have aged out.

---

## 6. One-line verdict

EV-1's typed-seam-and-drift objective is **done** — pause it, and open a **Timeline foundation** phase whose first slice fills the `MemberInvited` / `MemberJoined` producer gaps the activity feed was already built to display.

**Stop after recommendation.**
