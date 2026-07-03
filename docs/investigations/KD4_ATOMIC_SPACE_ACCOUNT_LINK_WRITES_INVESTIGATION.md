# KD-4 — Atomic `SpaceAccountLink` Writes: Investigation

**Status:** Investigation only. No code changed. Stops at the implementation checklist.
**Branch:** `feature/phase-2-architecture`
**Scope:** KD-4 only. KD-5 (HOME uniqueness enforcement) is documented for interaction, not implemented.
**Grounding:** Every claim below cites a file and line range read directly from the current repository on this branch. Nothing is proposed from memory.

---

## 1. Executive summary

`SpaceAccountLink` (SAL) is now the **sole** runtime write target for account↔space visibility. The `WorkspaceAccountShare` (WAS) dual-write has already been fully retired from every runtime path — confirmed by repo-wide grep, `workspaceAccountShare.{create,update,delete,upsert}` appears only in `prisma/seed.ts`. So the KD-4 register line ("WAS↔SAL mirrors can desync on partial failure", `STATUS.md:139`) describes a hazard that **no longer exists in the form stated**: there is no live WAS mirror left to desync against.

The real, current KD-4 hazard is narrower and still real: **multi-statement write sequences that mutate `SpaceAccountLink` alongside sibling rows (`FinancialAccount`, `AccountConnection`, `Transaction`, `GoalContribution`, `DebtProfile`, `ProviderAccountIdentity`, `DuplicateAccountCandidate`, `AuditLog`) run outside any `db.$transaction`.** A failure partway through leaves a partially-applied mutation with no rollback. This matters most in two places:

1. **The merge pipeline** (`lib/accounts/reconcile.ts`) — the single most statement-dense mutation in the codebase (7+ sequential writes across 5 tables per merge), with zero transactional boundary.
2. **Account create/restore/archive routes** — each performs 3–5 dependent writes in sequence with no atomicity.

A second, independent defect is entangled here: `computeLinkKind()` does a **count-then-write** with no lock or constraint (`lib/accounts/space-account-link.ts:100-120`). That is KD-5. Wrapping writes in a transaction is a **prerequisite** for a clean KD-5 fix but does **not by itself** close KD-5 (a transaction alone does not serialize two concurrent counters under Postgres' default `Read Committed` isolation).

**One hard constraint that shapes the entire proposal:** the merge pipeline reaches `disconnectPlaidItemIfOrphaned()`, which makes an **external Plaid API call** (`plaidClient.itemRemove`, `lib/plaid/disconnect.ts:39`). External I/O must never be held inside a DB transaction. Any atomicity design must keep the DB writes and the Plaid call on opposite sides of the transaction boundary.

**Recommended smallest-safe direction (detail in §6):** thread an optional Prisma transaction client (`tx`) through the SAL/reconcile helpers, wrap the *DB-only* portion of each mutation in `db.$transaction(async (tx) => …)`, and lift external side-effects (Plaid disconnect, snapshot regen — already best-effort/non-fatal) to run *after* the transaction commits. Do **not** attempt KD-5's uniqueness enforcement in the same change.

---

## 2. Impact map

| Area | Files touched by a KD-4 fix | Nature of change |
|---|---|---|
| SAL write helpers | `lib/accounts/space-account-link.ts` | Add optional `tx` param threading to `dualWriteSpaceAccountLink`, `computeLinkKind`, `dualWriteFromShare(s)`, `dualDeleteSpaceAccountLinks`. Additive — default to `db` when no `tx` passed. |
| Merge pipeline | `lib/accounts/reconcile.ts` | Wrap DB-only portion of `mergeArchivedDuplicateIntoCanonical` in a transaction; thread `tx` into its `dualWriteSpaceAccountLink` calls; keep `closeOutAccountConnections`/Plaid disconnect outside. |
| Create paths | `app/api/accounts/manual/route.ts`, `app/api/accounts/wallet/route.ts`, `lib/plaid/exchangeToken.ts` | Wrap the FinancialAccount + AccountConnection + SAL write group per account in a transaction. |
| Restore paths | `app/api/accounts/[id]/restore/route.ts`, `app/api/accounts/manual/[id]/restore/route.ts` | The existing `Promise.all([...])` restore trio becomes a `$transaction([...])`. |
| Archive/revoke paths | `app/api/accounts/[id]/route.ts` (DELETE), `app/api/spaces/[id]/accounts/share/route.ts` (DELETE), `app/api/spaces/[id]/members/[userId]/route.ts` (DELETE) | Group the soft-delete/revoke `updateMany`s with their bookkeeping into a transaction. |
| Permanent delete | `app/api/accounts/manual/[id]/permanent/route.ts` | Group `dualDeleteSpaceAccountLinks` + connection delete + account delete. |
| **Not touched** | AI assemblers, data layer, UI, snapshot generator internals, `WorkspaceAccountShare` model, all scripts | Read paths and legacy tables are out of scope. Additive-before-subtractive. |

**No schema change and no migration is required for KD-4** (see §8). The `@@unique([spaceId, financialAccountId])` on `SpaceAccountLink` already exists (`prisma/schema.prisma`). Adding the HOME partial-unique index is KD-5 and explicitly out of scope here.

---

## 3. Current call graph

### 3.1 Helper layer (`lib/accounts/space-account-link.ts`)

```
computeLinkKind(spaceId, faId)                     [reads: count() + findFirst()]
  └─ (no writes; pure decision)

dualWriteSpaceAccountLink({...})
  ├─ computeLinkKind(...)                           ← 2 reads
  └─ db.spaceAccountLink.upsert(...)                ← 1 write

dualWriteFromShare(share)  → dualWriteSpaceAccountLink(...)      [NO runtime callers found]
dualWriteFromShares(shares)→ loop dualWriteFromShare(...)        [NO runtime callers found]

dualDeleteSpaceAccountLinks(faId) → db.spaceAccountLink.deleteMany(...)   ← 1 write

ensureHomeLink(...)  → db.spaceAccountLink.upsert(...)   [DEAD CODE — documented unused, self-catches]
```

> Grep note: `dualWriteFromShare` / `dualWriteFromShares` have **no importers** outside their own module in the current tree. They are effectively dead-but-live helpers; a KD-4 change should thread `tx` through them for consistency but they carry no live risk today. `ensureHomeLink` is explicitly dead (its own doc comment, lines 230-253) and self-swallows errors — leave it alone.

### 3.2 Merge pipeline (`lib/accounts/reconcile.ts`)

```
resolveAccountByFingerprint(fp, excludeId?, spaceId?)
  ├─ findCandidatesByFingerprint(active)            ← read
  ├─ findCandidatesByFingerprint(archived)          ← read
  ├─ pickCanonicalAndMerge(activeCandidates)
  │    ├─ per candidate: transaction.count()        ← read
  │    ├─ mergeArchivedDuplicateIntoCanonical(...)   ← WRITE GROUP (see below)
  │    ├─ financialAccount.update(deletedAt)         ← write
  │    └─ closeOutAccountConnections(loserId)        ← writes + **PLAID API CALL**
  └─ for each archived: mergeArchivedDuplicateIntoCanonical(...) + closeOutAccountConnections(...)

mergeArchivedDuplicateIntoCanonical(loserId, winnerId, source, spaceId?)   [WRITE GROUP]
  ├─ transaction.updateMany  (re-point ALL loser txns)              ← write
  ├─ goalContribution loop   (per-row move w/ collision skip)       ← reads + writes
  ├─ debtProfile.updateMany  (conditional 1:1 move)                 ← read + write
  ├─ resolveAccountCreatorUserId(winnerId)                          ← read
  ├─ spaceAccountLink.findMany (loser links)                        ← read
  ├─ loserLinks loop → dualWriteSpaceAccountLink(...)               ← N × (2 reads + 1 write)
  └─ duplicateAccountCandidate.upsert                               ← write

closeOutAccountConnections(faId)
  ├─ accountConnection.findMany(live)                               ← read
  ├─ accountConnection.updateMany(soft-delete)                      ← write
  └─ disconnectPlaidItemIfOrphaned(plaidItemDbId)  → **plaidClient.itemRemove** + plaidItem.update
```

### 3.3 Route call sites (every mutation touching SAL)

| Route / file | Verb | SAL operation | Adjacent writes in same handler (no tx today) |
|---|---|---|---|
| `app/api/spaces/[id]/accounts/share/route.ts` | POST | `dualWriteSpaceAccountLink` (share / re-activate) | `auditLog.create`, snapshot regen (best-effort) |
| `app/api/spaces/[id]/accounts/share/route.ts` | DELETE | `spaceAccountLink.update` (revoke) | `auditLog.create`, snapshot regen (best-effort) |
| `app/api/accounts/manual/route.ts` | POST | loop `dualWriteSpaceAccountLink` (sequential, HOME→SHARED) | `financialAccount.create`, `accountConnection.create`, snapshot regen |
| `app/api/accounts/wallet/route.ts` | POST (3 branches) | `dualWriteSpaceAccountLink` in each | `financialAccount.create/update`, `accountConnection.create/updateMany`, `dualWriteProviderAccountIdentity`, `mergeArchivedDuplicateIntoCanonical` (active-reuse branch), `auditLog.create`, snapshot regen |
| `lib/plaid/exchangeToken.ts` | (per-account loop) | `dualWriteSpaceAccountLink` | `financialAccount.create/update`, `dualWriteProviderAccountIdentity`, `accountConnection.create/update` |
| `app/api/accounts/[id]/restore/route.ts` | POST | `spaceAccountLink.updateMany` (reactivate) **or** merge | `financialAccount.update`, `accountConnection.updateMany` (in a `Promise.all`), `auditLog.create`, snapshot regen |
| `app/api/accounts/manual/[id]/restore/route.ts` | POST | `spaceAccountLink.updateMany` (reactivate) **or** merge | `financialAccount.update`, `accountConnection.updateMany` (in a `Promise.all`), `auditLog.create`, snapshot regen |
| `app/api/accounts/manual/[id]/permanent/route.ts` | DELETE | `dualDeleteSpaceAccountLinks` | `auditLog.create` (before), `accountConnection.deleteMany`, `financialAccount.delete` |
| `app/api/accounts/[id]/route.ts` | DELETE | `spaceAccountLink.findMany` + `spaceAccountLink.updateMany` (revoke) | `financialAccount.update` (soft-delete), `accountConnection.updateMany`, snapshot regen loop, `disconnectPlaidItemIfOrphaned` (**Plaid call**), `auditLog.create` |
| `app/api/spaces/[id]/members/[userId]/route.ts` | DELETE | `spaceAccountLink.updateMany` (revoke member's links) | `spaceMember.update`, snapshot regen, `auditLog.create` |

---

## 4. Current transaction boundaries (grounded, not assumed)

**Every `db.$transaction` in the repo** (`grep '\$transaction'`), and whether it touches SAL:

| File | Form | Touches SAL? |
|---|---|---|
| `app/api/auth/register/route.ts:83` | interactive `async (tx) =>` | No (User + personal Space + member) |
| `app/api/imports/[id]/rollback/route.ts:128` | interactive `async (tx) =>` | No (ImportBatch + Transaction soft-delete + AuditLog) |
| `app/api/spaces/[id]/goals/[goalId]/check-in/route.ts:66` | array `[...]` | No |
| `app/api/spaces/[id]/invites/[inviteId]/route.ts:40` | array | No |
| `app/api/admin/security/users/[userId]/2fa-reset/route.ts:65` | array | No |
| `app/api/admin/security/users/[userId]/sessions/route.ts:53` | array | No |
| `app/api/user/sessions/[sessionId]/route.ts:44` | array | No |
| `app/api/user/totp/{disable,setup}/route.ts` | array | No |
| `lib/recovery-codes.ts:50,89` | array | No |
| `lib/auth.ts:187` | array | No |

**Conclusion:** **No SAL write path currently executes inside a transaction.** The codebase already uses **both** transaction forms fluently (interactive callback and array), so KD-4 introduces no new pattern — only new call sites. The interactive `async (tx) => {…}` form is the right one here because SAL writes are conditional and read-dependent (computeLinkKind).

### 4.1 Which helpers assume an existing transaction — *none*
Every helper in `space-account-link.ts` and `reconcile.ts` binds directly to the module-level singleton `db` (`lib/db.ts` — global-guarded `PrismaClient`). None accept or thread a `tx` client. So today:

- **No helper assumes it is inside a transaction.**
- **Every helper opens its own implicit "transaction"** in the trivial sense that each individual Prisma call is its own auto-commit statement.
- The module header of `space-account-link.ts` states this as **Rule 7 — "no `db.$transaction` … none used anywhere in this codebase today"** (lines 40-41). That comment is now stale (transactions *are* used elsewhere) and will need updating as part of the fix.

### 4.2 Where nested transactions would become a problem
Prisma does **not** support nested interactive transactions. If `mergeArchivedDuplicateIntoCanonical` is wrapped in `db.$transaction(async (tx) => …)` but its inner `dualWriteSpaceAccountLink(...)` calls keep using the global `db`, **those writes execute outside the transaction** — the exact desync KD-4 is meant to remove, silently reintroduced. Therefore:

- A `tx` client **must be threaded** from `mergeArchivedDuplicateIntoCanonical` down into `dualWriteSpaceAccountLink` and `computeLinkKind`.
- `closeOutAccountConnections` → `disconnectPlaidItemIfOrphaned` **must stay outside** the transaction (external Plaid call + it does its own reads/writes that are semantically post-commit cleanup).

### 4.3 Where a transaction client should be threaded through
`computeLinkKind(spaceId, faId, client = db)` → `dualWriteSpaceAccountLink({…, client})` → called by `mergeArchivedDuplicateIntoCanonical(…, client)` and by the create/share routes. `dualDeleteSpaceAccountLinks(faId, client = db)` similarly. Default parameter = `db` keeps every existing call site working unchanged (additive).

---

## 5. Failure analysis (partial-failure scenarios)

Each scenario assumes a crash / thrown error / connection drop **between** the numbered statements, with no transaction (current state).

### 5.1 Share (POST `/accounts/share`)
1. `dualWriteSpaceAccountLink` upsert succeeds → **2.** `auditLog.create` fails.
- **DB state:** SAL row ACTIVE; no audit trail.
- **Downstream:** account is visible in the space; compliance/audit gap only.
- **Recovery today:** none automatic. Re-issuing the share is idempotent (upsert), so user-retry self-heals the SAL row but never backfills the missing audit row.

### 5.2 Manual account create (POST `/accounts/manual`)
1. `financialAccount.create` ok → **2.** `accountConnection.create` ok → **3.** first `dualWriteSpaceAccountLink` (HOME) ok → **4.** second `dualWriteSpaceAccountLink` (SHARED) fails.
- **DB state:** account exists, is HOME-linked into personal space, but **not** shared into the requested additional space(s). Orphaned-partial visibility.
- **Downstream:** account shows in personal space only; the user's explicit "also share to X" silently dropped.
- **Recovery today:** none. There is no retry loop; the POST returns 500 but the FinancialAccount + partial links persist. A subsequent identical create would **not** dedupe (manual accounts have no provider identity) → risk of a second account row.
- **Worse variant:** crash between **1** and **3** leaves a FinancialAccount with an AccountConnection but **zero** SAL rows → account is invisible in every space and unreachable through normal UI (all list reads filter on SAL), effectively orphaned until a script intervenes.

### 5.3 Merge (reconcile) — the highest-risk path
`mergeArchivedDuplicateIntoCanonical` order: (a) re-point transactions → (b) move goal contributions → (c) move debt profile → (d) re-point loser links via `dualWriteSpaceAccountLink` → (e) upsert `DuplicateAccountCandidate`. Then caller: (f) `financialAccount.update` archive loser → (g) `closeOutAccountConnections` (+ Plaid call).

- **Fail after (a), before (d):** loser's **transactions already moved to winner**, but loser's **SAL links not yet re-pointed**. Loser is still active/visible (not archived — that's step f) and now shows **zero transactions**; winner shows doubled history but may not yet be linked into the loser's spaces. User sees an empty duplicate + a partial canonical.
- **Fail after (d), before (e):** history + links moved, but **no `DuplicateAccountCandidate` audit row**. The D1 audit invariant ("every automatic merge leaves a CONFIRMED_DUPLICATE row") is violated silently.
- **Fail after (e), before (f):** everything migrated and audited, but **loser never archived** (`deletedAt` still null in the sibling-consolidation active-loser branch, `reconcile.ts:297-301`). Result: **two active rows**, one now empty, exactly the visible-duplicate state the merge exists to prevent.
- **Fail during (g) Plaid call:** DB fully consistent; Plaid `itemRemove` may or may not have fired. Orphaned PlaidItem keeps syncing (the pre-existing bug the lifecycle fix targets, `reconcile.ts:55-104`). **This is why (g) must be outside, and idempotent-retryable independently.**
- **Recovery today:** merges are *largely* idempotent on replay (transaction re-point is a no-op once moved; `DuplicateAccountCandidate.upsert` bumps `detectedAt`; `dualWriteSpaceAccountLink` upserts). BUT the **active-loser archive (f)** is *not* reached on a failed earlier step, and re-running the exact same route is not guaranteed (restore routes 404 once the loser looks merged). So a mid-merge failure can strand a half-merged pair that no user action re-triggers.

### 5.4 Restore (POST `/accounts/[id]/restore`)
Current restore uses `Promise.all([fa.update, connection.updateMany, sal.updateMany])` (`restore/route.ts:145-161`). `Promise.all` is **concurrent, not atomic** — if the SAL `updateMany` rejects, the FinancialAccount may already be un-deleted while its links stay REVOKED.
- **DB state:** account active (`deletedAt: null`) but invisible (links REVOKED).
- **Downstream:** account exists, syncs, but appears in no space — a "ghost" active account.
- **Recovery today:** re-running restore is idempotent and would fix it, but the route returns 500 and the user isn't told to retry.

### 5.5 Archive (DELETE `/accounts/[id]`)
1. `financialAccount.update` soft-delete ok → **2.** `accountConnection.updateMany` ok → **3.** `spaceAccountLink.updateMany` revoke fails.
- **DB state:** account soft-deleted, connections closed, but SAL rows still ACTIVE.
- **Downstream:** reads that filter on `deletedAt` hide it, but any read that trusts SAL ACTIVE without re-checking `financialAccount.deletedAt` could leak a "deleted" account into a space view. (Worth a targeted check of the assemblers/data layer during validation — see §9.)
- **Recovery today:** none automatic.

### 5.6 Member removal (DELETE `/members/[userId]`)
1. `spaceMember.update` (LEFT/REMOVED) ok → **2.** `spaceAccountLink.updateMany` revoke fails.
- **DB state:** member gone, but the accounts they shared remain ACTIVE-linked into the space.
- **Downstream:** **privacy-relevant** — a departed member's accounts stay visible to remaining members. This is the most user-facing partial-failure of the set.
- **Recovery today:** none automatic.

---

## 6. Atomicity proposal

Ordered by leverage. Each item is the *smallest* change that removes the corresponding partial-failure window. This section is a proposal for the checklist — **not implemented here**.

### 6.1 Design rules
- **DB-only inside; side-effects outside.** Every transaction contains *only* Prisma writes. Snapshot regen (already best-effort/non-fatal) and Plaid disconnect (external) run **after** commit, unchanged.
- **Thread `tx`, never nest.** Add `client: Prisma.TransactionClient | typeof db = db` as a trailing optional param to `computeLinkKind`, `dualWriteSpaceAccountLink`, `dualWriteFromShare(s)`, `dualDeleteSpaceAccountLinks`, and `mergeArchivedDuplicateIntoCanonical`. Inside, use `client` instead of `db`. Default `= db` makes every existing call site compile and behave identically.
- **Interactive form.** Use `await db.$transaction(async (tx) => {…})` at each route/handler boundary, matching the existing `register` and `rollback` precedents.
- **Keep merges idempotent.** Do not change merge logic; only wrap it. Idempotency is the safety net if a transaction still fails.

### 6.2 What must be atomic
- **Merge write-group (a)–(e)** in `mergeArchivedDuplicateIntoCanonical` — the transaction re-point, contribution moves, debt move, link re-points, and the `DuplicateAccountCandidate` upsert must all commit or all roll back. This is the top priority.
- **The loser-archive (f)** should be **inside the same transaction** as (a)–(e) (it's a pure DB write), closing the 5.3 "two active rows" window.
- **Create trios** (FinancialAccount + AccountConnection + SAL) in manual/wallet/exchangeToken — atomic per account.
- **Restore trio** — replace `Promise.all([...])` with `db.$transaction([...])` (array form is sufficient; the three writes are independent updates). This is a near-mechanical swap.
- **Archive/revoke groups** (`/accounts/[id]` DELETE, member removal, share revoke) — group the account/link state changes with nothing else DB-relevant.

### 6.3 What is safely idempotent (may remain outside, or be retried independently)
- `dualWriteSpaceAccountLink` upsert (keyed on `@@unique([spaceId, financialAccountId])`).
- `DuplicateAccountCandidate.upsert` (keyed on `@@unique([accountAId, accountBId])`, bumps `detectedAt`).
- `dualWriteProviderAccountIdentity` (idempotent, self-catching, non-fatal by design — `provider-identity.ts`). **Leave outside** the transaction; it's a mirror.
- `transaction.updateMany` re-point (no-op once moved).

### 6.4 What must stay outside the transaction
- `disconnectPlaidItemIfOrphaned` / `closeOutAccountConnections` — external Plaid `itemRemove`. Run post-commit. It already self-catches Plaid errors (`disconnect.ts:37-42`).
- All `regenerateSpaceSnapshot` / `regenerateSnapshotsForAccounts` calls — already best-effort/non-fatal, already post-write. Keep post-commit.
- `auditLog.create` — *judgment call.* Including it inside the transaction gives "no state change without an audit row"; but a transaction rollback then also discards the audit of the attempt. Recommendation: **include** audit writes that record the successful mutation inside the transaction (so success ⇒ audited), matching the `imports/rollback` precedent which audits inside its `$transaction`.

### 6.5 Explicit KD-5 boundary
KD-4 makes `computeLinkKind`'s count+write execute against a single consistent snapshot *within one caller's* transaction, but **two concurrent transactions under Read Committed can still both count 0** and both write HOME. Closing that requires either a partial-unique index (`WHERE kind = 'HOME'`), `Serializable` isolation on this path, or an advisory lock — **all KD-5**. KD-4 should ship with a one-line note that it is a *prerequisite enabler* for KD-5, not a fix for it. The sequential-loop mitigation already in `manual/route.ts:131-159` remains the interim guard and must not be removed by KD-4.

---

## 7. Merge pipeline atomicity map (§4 requirement, itemized)

| Operation in `mergeArchivedDuplicateIntoCanonical` | Must be atomic? | Idempotent on replay? | Can stay outside tx? |
|---|---|---|---|
| `transaction.updateMany` (re-point) | Yes (with the rest) | Yes (no-op once moved) | No |
| goalContribution per-row move + collision skip | Yes | Yes (collision check makes re-run safe) | No |
| debtProfile conditional move | Yes | Yes (guarded by winner-has-none check) | No |
| loser `spaceAccountLink.findMany` (read) | Read only | n/a | Read may be inside for snapshot consistency |
| loser-links loop → `dualWriteSpaceAccountLink` | Yes | Yes (upsert) | No — thread `tx` |
| `duplicateAccountCandidate.upsert` | Yes | Yes (bumps detectedAt) | No |
| **caller:** `financialAccount.update` archive loser | Yes (fold into same tx) | Yes | No — move inside tx |
| **caller:** `closeOutAccountConnections` (+Plaid) | **No** | Partially (DB parts yes; Plaid call self-catches) | **Yes — must stay outside** |

---

## 8. Rollback plan

- **Migration impact: none.** KD-4 as scoped adds no columns, no indexes, no enum values. `npx prisma generate` and `npx tsc --noEmit` are the relevant gates; `npx prisma migrate dev` is **not** needed unless the change unexpectedly touches schema (it should not). If any schema edit appears necessary, that is a signal the change has drifted into KD-5 — stop and re-scope.
- **Code rollback strategy:** the change is purely a control-flow wrapper plus additive optional params. Reverting the commit restores exact prior behavior; no data written under the new code is shaped differently (SAL rows, merge outputs, and audit rows are byte-identical — only *when they commit together* changes). Therefore **no data backfill or down-migration is required to roll back.**
- **Forward/backward compatibility:** because helper signatures gain a **defaulted trailing param**, older call sites and any in-flight branches compile unchanged. A partially-deployed state (some routes wrapped, some not) is safe — each route's atomicity is independent; there is no cross-route protocol.
- **Data written pre-fix:** any half-applied states already in the DB from before the fix (e.g. a stranded half-merge from §5.3) are **not** repaired by KD-4 — that is a separate data-correction concern. `scripts/correct-home-links.ts` and `scripts/verify-space-account-link-backfill.ts` already exist for SAL data audits and are the right tools to survey for pre-existing damage. Register as a follow-up, do not fold in.

---

## 9. Validation plan

### 9.1 Existing tests that must continue passing
- `lib/ai/assemblers/transactions.privacy.test.ts` — BALANCE_ONLY / SAL visibility filter (KD-1 regression guard).
- `lib/data/transactions.privacy.test.ts` — data-layer visibility predicate.
- Any run of `scripts/test-visibility-two-user-space.impl.ts` (referenced by `STATUS.md` as the two-user visibility check).
- Full `npm run lint` + `npx tsc --noEmit` clean (the additive `tx` param must not break inference at any call site).

### 9.2 New transaction-atomicity tests that should exist
- **Merge rollback:** force a thrown error injected after the transaction re-point but before `DuplicateAccountCandidate.upsert`; assert **all** of loser's transactions are still on the loser (nothing moved) and loser is **not** archived — i.e., full rollback, no half-merge.
- **Merge success invariants:** after a successful merge, assert exactly one `DuplicateAccountCandidate` row for the pair, winner holds all history, loser archived, and Plaid disconnect attempted exactly once (mock).
- **Create-trio rollback:** inject failure on the 2nd `dualWriteSpaceAccountLink` in `manual/route.ts`; assert the FinancialAccount and AccountConnection are **also** rolled back (no orphaned invisible account per §5.2 "worse variant").
- **Restore atomicity:** inject failure on the SAL reactivate; assert `financialAccount.deletedAt` is **not** cleared (no ghost active account per §5.4).
- **Member-removal atomicity:** inject failure on SAL revoke; assert `spaceMember` status is **not** changed (departed member's links can't be stranded ACTIVE per §5.6).
- **HOME race (KD-5 guard, keep as xfail/documented):** a concurrency test that two simultaneous first-links produce ≥2 HOME rows — expected to still fail after KD-4, proving KD-4 alone doesn't close KD-5. Mark clearly so it isn't read as a KD-4 regression.

### 9.3 Manual validation scenarios
1. Create a manual asset shared to Personal + 2 additional spaces; confirm exactly one HOME + two SHARED links (existing sequential-loop behavior preserved).
2. Reconnect a Plaid institution that fingerprint-matches an archived duplicate; confirm single canonical account, one `DuplicateAccountCandidate`, orphaned PlaidItem revoked once.
3. Restore a soft-deleted Plaid account that has an active duplicate; confirm fold-into-canonical, no second visible row.
4. Remove a member who shared accounts into a shared space; confirm their links flip REVOKED and the accounts vanish from remaining members' views.
5. Permanent-delete a manual asset; confirm SAL + connection + account all gone, audit row present.

---

## 10. Risks

- **R1 — Silent transaction escape (highest).** If `tx` is threaded incompletely (e.g. `computeLinkKind` still reads via `db` while the upsert uses `tx`), the read sees pre-transaction state and correctness *looks* fine in tests but the atomicity guarantee is hollow. Mitigation: thread `client` through **every** DB call inside a wrapped helper, and add a lint/review check that no `db.` literal remains inside a `$transaction` callback body.
- **R2 — Transaction holding an external call.** Accidentally leaving `disconnectPlaidItemIfOrphaned` or a snapshot regen inside the transaction would hold a DB connection across a network round-trip and risk pool exhaustion / timeouts. Mitigation: §6.4 explicit outside-list; assert in review.
- **R3 — Scope creep into KD-5.** The HOME race is *right there* and tempting to "just fix." Doing so requires a schema/index change and changes the rollback profile (§8). Mitigation: hard stop — KD-5 is a separate branch/commit per project rules.
- **R4 — Interactive transaction timeout on large merges.** A merge folding a very large transaction history (`transaction.updateMany` over thousands of rows) inside an interactive transaction could exceed Prisma's default `timeout` (5s). Mitigation: measure on the largest real account before shipping; if needed, raise `maxWait`/`timeout` on that specific `$transaction` call rather than globally.
- **R5 — Audit-inside-tx semantics.** Putting `auditLog.create` inside the transaction means a rolled-back attempt leaves no trace it was attempted. Accepted trade-off (§6.4), but flag for reviewer sign-off since it changes audit semantics slightly.
- **R6 — Documentation drift already present.** `space-account-link.ts` Rule 7 ("no `$transaction` anywhere") and the module header's "WAS remains live at its final mutation site" are both **stale** vs. current code (WAS writes fully retired; transactions used elsewhere). KD-4 must update these comments or it will re-anchor future readers on a false model.

---

## 11. Additional defects discovered (registered, NOT in scope)

Classified and kept separate per project rules. **None expand KD-4 scope.**

- **FD-1 — Stale KD-4 register description.** `STATUS.md:139` frames KD-4 as "WAS↔SAL mirrors can desync." WAS runtime writes are fully retired (only `seed.ts` writes WAS). The true hazard is multi-table non-atomic SAL sequences. *Separate because:* it's a documentation-accuracy fix, not code. **Recommendation:** correct the register line when KD-4 lands.
- **FD-2 — Stale invariants in `space-account-link.ts`.** Rule 7 and the WAS-mirror header comment are outdated (see R6). *Separate because:* comment-only. **Recommendation:** fold the comment corrections into the KD-4 commit since that file is being edited anyway (still additive, still in-file).
- **FD-3 — Dead-but-live helpers.** `dualWriteFromShare` / `dualWriteFromShares` have no runtime callers; `ensureHomeLink` is documented-dead. *Separate because:* removal is subtractive and the project mandates additive-before-subtractive. **Recommendation:** leave in place; register for a later cleanup pass after WAS retirement (v2.5).
- **FD-4 — Archive→SAL read trust (potential leak).** §5.5: a read path trusting SAL `status: ACTIVE` without re-checking `financialAccount.deletedAt` could surface a soft-deleted account. *Separate because:* it's a read-path audit, orthogonal to write atomicity. **Recommendation:** targeted grep/audit of assemblers + data layer for `deletedAt` filtering; likely already covered by the KD-1 canonical predicate but not verified here.
- **FD-5 — Pre-existing half-merged data.** Any strandings from §5.3 that predate KD-4 are not repaired by it. *Separate because:* data correction, not code. **Recommendation:** run `scripts/verify-space-account-link-backfill.ts` / `scripts/correct-home-links.ts` as a survey once an engine is available.

---

## 12. Explicit stopping point

This document is the KD-4 investigation and the basis for an implementation checklist. **No code has been modified.** Per the stated implementation principles, work stops here — after investigation and before any edit to schema, migrations, helpers, routes, or tests.

**Awaiting approval** of the atomicity proposal (§6) and the in/out-of-scope split before producing the per-decision implementation checklist and beginning the smallest surgical change. KD-5 remains explicitly out of scope and is documented only for its interaction with KD-4.
