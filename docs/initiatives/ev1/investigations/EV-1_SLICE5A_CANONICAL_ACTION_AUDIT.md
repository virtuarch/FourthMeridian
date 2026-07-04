# EV-1 — Slice 5A: Canonical Action Audit

**Status:** Investigation only. No implementation. No schema. No data migration. No Timeline cleanup.
**Source of truth:** `docs/investigations/EV-1_TYPED_DOMAIN_EVENT_SEAM_INVESTIGATION.md` + Slice 0–4 checklists.
**Branch context:** `feature/v2.5-spaces-completion`

**Goal:** determine whether any *live* code path still writes legacy/drifted `AuditLog.action` strings, and decide the strategy for the eventual consumer-side (Timeline) dual-spelling cleanup. Dual-spelling support is **not** removed here.

**Method:** enumerated all 56 `db.auditLog.create` sites, all 6 `emitDomainEvent` producers, the `DOMAIN_EVENT_ACTION` map, the `AuditAction` constants, every literal `action:` string, and the Timeline `ALLOWED_ACTIONS` + `normalizeLog` alias pairs. Cross-checked with git to confirm which legacy spellings were genuinely live in production before their migration slice.

---

## 1. Producers now emitting canonical actions (via the seam)

All six `emitDomainEvent` producers resolve to canonical `AuditAction` values through `DOMAIN_EVENT_ACTION`:

| Producer (file) | Event type | Canonical action written |
|---|---|---|
| `app/api/spaces/[id]/restore/route.ts:47` | `SpaceRestored` | `SPACE_RESTORED` |
| `app/api/spaces/[id]/accounts/share/route.ts:73` | `AccountShared` | `ACCOUNT_SHARED` |
| `app/api/spaces/[id]/accounts/share/route.ts:166` | `AccountShareRevoked` | `ACCOUNT_REVOKED` |
| `app/api/spaces/[id]/members/[userId]/route.ts:174` (DELETE) | `MemberRemoved` / `MemberLeft` | `MEMBER_REMOVED` / `SPACE_LEAVE` |
| `lib/plaid/refresh.ts:331` | `ConnectionSynced` | `PLAID_REFRESH` |

Additionally, several **direct** `db.auditLog.create` sites already write the canonical `AuditAction` **constant** (they are simply not seam-routed yet, and carry no drift): `SPACE_CREATE`, `SPACE_UPDATE`, `SPACE_ARCHIVED`, `SPACE_UNARCHIVED`, `SPACE_TRASHED`, `SPACE_PERMANENT_DELETE`, `ACCOUNT_RENAMED`, `ACCOUNT_RESTORE`, `DEBT_PROFILE_UPDATED`, `PLAID_SYNC`, `PLAID_REFRESH` (manual route), `ACCOUNT_ADD`, `IMPORT_BATCH_*`, and the auth/2FA/session/AI families. These are outside EV-1's migrated scope but are **not** drifted.

---

## 2. Producers still emitting legacy literals

Two categories. Only the first is true, Timeline-visible drift that blocks consumer cleanup.

### 2.1 Live legacy producers WITH a distinct unused canonical constant (Timeline-visible drift)

| Producer (file:line) | Legacy literal written | Canonical constant (exists, never written) | Timeline renders |
|---|---|---|---|
| `app/api/spaces/[id]/members/[userId]/route.ts:86` (PATCH) | `"MEMBER_ROLE_CHANGE"` | `MEMBER_ROLE_CHANGED` | "Role changed" |
| `app/api/spaces/[id]/goals/route.ts:144` (POST) | `"GOAL_CREATE"` | `GOAL_CREATED` | "Goal created" |

These are the **only two remaining live producers of a Timeline-visible drifted action** that have not been migrated. Both are natural next-slice targets (mirror the Slice 2/3 canonicalization pattern).

### 2.2 Live literals with NO canonical counterpart (uncodified, but not "drift")

Written as bare strings but there is no competing canonical spelling — they are simply not codified as `AuditAction` constants:

- Goals: `"GOAL_UPDATE"` (goals/[goalId]:90), `"GOAL_DELETE"` / `"GOAL_PURGE"` (goals/[goalId]:138). Note the goals family writes `GOAL_UPDATE`/`GOAL_DELETE`, while constants `GOAL_UPDATED`/`GOAL_ARCHIVED`/`GOAL_TRASHED` exist and are unused.
- Manual assets: `"MANUAL_ASSET_ADD"`, `"MANUAL_ASSET_DELETE"`, `"MANUAL_ASSET_UPDATE"`, `"MANUAL_ASSET_RESTORE"`, `"MANUAL_ASSET_PERMANENT_DELETE"` (no `AuditAction` constants at all).
- Misc: `"ACCOUNT_REMOVE"`, `"WALLET_ADD"`, `"SPACE_SWITCH"`, `"REGISTER"`, `"LOGIN"`, `"LOGOUT"`, `"PROFILE_UPDATE"`, `"PASSWORD_*"`, `"PLATFORM_SETTINGS_UPDATED"`, `"PASSWORD_RESET_REQUESTED"`, `"PASSWORD_RESET_COMPLETE"`.

These are hygiene items, not EV-1 drift, and are out of scope for the seam.

### 2.3 Retired legacy literals — NO live producer remains

Confirmed by grep (zero live writes) and git (they were live from the Workspace→Space rename `82c45aa` until their EV-1 slice):

| Legacy literal | Replaced by (live canonical) | Migration commit |
|---|---|---|
| `ACCOUNT_SHARE` | `ACCOUNT_SHARED` | `4b85c34` (Slice 2) |
| `ACCOUNT_SHARE_REVOKE` | `ACCOUNT_REVOKED` | `4b85c34` (Slice 2) |
| `SPACE_REMOVE_MEMBER` | `MEMBER_REMOVED` | `4d042cd` (Slice 3) |

Because these were live in production for months, **historical `AuditLog` rows carrying these legacy spellings provably exist.**

---

## 3. Timeline aliases still required (historical rows)

The activity consumer (`app/api/spaces/[id]/activity/route.ts`) carries dual-spelling in both `ALLOWED_ACTIONS` and `normalizeLog`. Classifying every alias pair:

| Timeline pair (canonical / legacy) | Live producer writes | Alias still needed? | Why |
|---|---|---|---|
| `ACCOUNT_SHARED` / `ACCOUNT_SHARE` | canonical (Slice 2) | **Legacy needed — history only** | pre-Slice-2 rows exist |
| `ACCOUNT_REVOKED` / `ACCOUNT_SHARE_REVOKE` | canonical (Slice 2) | **Legacy needed — history only** | pre-Slice-2 rows exist |
| `MEMBER_REMOVED` / `SPACE_REMOVE_MEMBER` | canonical (Slice 3) | **Legacy needed — history only** | pre-Slice-3 rows exist |
| `MEMBER_ROLE_CHANGED` / `MEMBER_ROLE_CHANGE` | **legacy (not migrated)** | **Legacy needed — live + history**; canonical alias is currently dead | producer still writes `MEMBER_ROLE_CHANGE` |
| `GOAL_CREATED` / `GOAL_CREATE` | **legacy (not migrated)** | **Legacy needed — live + history**; canonical alias is currently dead | producer still writes `GOAL_CREATE` |
| `SPACE_CREATED` / `SPACE_CREATE` | `SPACE_CREATE` (canonical constant) | **`SPACE_CREATED` is a DEAD alias** | no producer, past or present in code, writes `SPACE_CREATED`; the constant/live spelling is `SPACE_CREATE` |
| `SPACE_LEAVE` (single) | canonical (Slice 3, constant added) | single spelling | no drift |
| `SPACE_UPDATE` (single) | canonical constant | single spelling | no drift |
| `GOAL_ARCHIVED`, `GOAL_RESTORED` (in allowlist) | **no producer** | **DEAD aliases** | goals routes log archive/restore as `GOAL_UPDATE`, never these constants |
| `GOAL_DELETE` (single) | live literal | single spelling (used for completion/removal) | no canonical competitor |
| `MEMBER_INVITED`, `MEMBER_JOINED` (in allowlist) | **no producer at all** | **DEAD aliases (feature gaps)** | invite-create and invite-accept write no audit row |
| `MANUAL_ASSET_ADD/DELETE/RESTORE` (single) | live literals | single spelling | no canonical competitor |

**Summary of alias status:**
- **Needed for history (retired legacy, safe to drop only after history ages out or is migrated):** `ACCOUNT_SHARE`, `ACCOUNT_SHARE_REVOKE`, `SPACE_REMOVE_MEMBER`.
- **Needed for live + history (cannot drop until the producer is migrated):** `MEMBER_ROLE_CHANGE`, `GOAL_CREATE` — and here it is the *canonical* halves (`MEMBER_ROLE_CHANGED`, `GOAL_CREATED`) that are currently dead.
- **Dead aliases (no live or in-code historical producer):** `SPACE_CREATED`, `GOAL_ARCHIVED`, `GOAL_RESTORED`, `MEMBER_INVITED`, `MEMBER_JOINED`. (Caveat: whether *old* DB rows exist for these cannot be confirmed without a query, which is out of scope.)

---

## 4. Recommendation for Slice 5B

**Recommend: simplify consumers only after observation — and NOT yet. Do NOT keep dual-spelling permanently as a design stance, and do NOT perform a data migration.**

Reasoning:

- **Not "keep permanently."** Dual-spelling is transitional debt, not an intended contract. Retiring it is the goal; the question is only *when*.
- **Not a one-time data migration.** Rewriting historical `AuditLog.action` values is (a) explicitly out of scope, (b) contrary to append-only audit-log principle — the rows should reflect what the system actually wrote at the time, and (c) unnecessary: the activity feed reads only the latest ~100 rows per space, so legacy-spelling rows naturally age out of the visible window as new activity accrues. A migration buys nothing the rolling window doesn't give for free, at real risk.
- **"Simplify after observation" — with a hard precondition.** Two live producers (`MEMBER_ROLE_CHANGE`, `GOAL_CREATE`) still write legacy strings. Their aliases can *never* be removed while those producers run. So consumer cleanup must be **gated on first migrating those producers**, then waiting out an observation window in which legacy-spelling rows have fallen out of the Timeline's 100-row window (or become acceptably rare).

**Therefore the ordering is:**
1. Migrate the last two Timeline-visible drifted producers (`MemberRoleChanged`, `GoalCreated`) → all live producers emit canonical.
2. Observe: confirm no live path emits any legacy Timeline action (re-run this §1–2 audit; optionally a one-off `AuditLog` query to see whether legacy spellings still appear in recent rows — read-only, not a migration).
3. Consumer cleanup: remove the dual-spelling + dead aliases from `activity/route.ts`.

Consumer cleanup is the *last* step, exactly as the original investigation sequenced Slice 5.

---

## 5. Recommended next checklist

**The next slice should be a producer-migration slice, not the Timeline cleanup.** Name it **Slice 5B — Remaining Canonical Producers**:

- Migrate `MEMBER_ROLE_CHANGE` (members PATCH) → `MemberRoleChanged` event → `MEMBER_ROLE_CHANGED`, mirroring Slice 3 (audit is outside any tx here; no snapshot side effect → audit-only, no handler; payload `{ targetUserId, targetName, oldRole, newRole }` already matches the provisional type).
- Migrate `GOAL_CREATE` (goals POST) → `GoalCreated` event → `GOAL_CREATED`, audit-only, no handler; correct the provisional payload to the actual metadata `{ goalId, name, goalType, targetAmount }`.
- Both are drift-canonicalizing, byte-parity-except-action migrations exactly like Slices 2–3; Timeline keeps rendering identically because it already aliases both spellings.
- Explicitly **defer**: `SpaceCreated`/`SpaceUpdated` seam-routing (no drift — already canonical constants, low value), goal `archive/update/delete` canonicalization, manual-asset codification, `MEMBER_INVITED`/`MEMBER_JOINED` producer gaps (feature work, not cleanup), and the Timeline consumer cleanup itself.

Then a subsequent **Slice 5C — Timeline Dual-Spelling Cleanup** (consumer-only) after the observation window, removing: the retired legacy aliases (`ACCOUNT_SHARE`, `ACCOUNT_SHARE_REVOKE`, `SPACE_REMOVE_MEMBER`), the now-retired `MEMBER_ROLE_CHANGE`/`GOAL_CREATE`, and the dead aliases (`SPACE_CREATED`, `GOAL_ARCHIVED`, `GOAL_RESTORED`) — while **retaining** `MEMBER_INVITED`/`MEMBER_JOINED` (reserved for the future producer, not drift).

---

## 6. Rules honored

No code, no schema, no data migration, no Timeline cleanup performed. Audit only. Dual-spelling support left fully intact.

**Stop after the audit.**
