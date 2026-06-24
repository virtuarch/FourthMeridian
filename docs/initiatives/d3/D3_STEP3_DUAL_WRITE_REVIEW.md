# D3 Step 3 — Dual-Write Review

Status: **design only — no code changed in this step.**

Scope: every code path that mutates `WorkspaceAccountShare` must, going forward, also
write the equivalent `SpaceAccountLink` row — while `WorkspaceAccountShare` stays the
only table any read path (UI, snapshots, audit) consults. No schema change. No read-path
change. No removal of `WorkspaceAccountShare`. No change to `ownerUserId` /
`ownerSpaceId` / `ownerType`. No UI change. No visibility-behavior change.

Prior state this builds on:
- D3 Step 1 (schema): `SpaceAccountLinkKind` enum + `SpaceAccountLink` model, additive, migration applied.
- D3 Step 2 (backfill): `SpaceAccountLink` now mirrors every existing `WorkspaceAccountShare` row 1:1 (verified — see `docs/initiatives/d3/D3_STEP2_BACKFILL_REVIEW.md` and `scripts/verify-space-account-link-backfill.ts`). HOME = the link at the account creator's personal-space pair; SHARED = every other link.
- Nothing in `app/`, `lib/`, or `components/` reads `SpaceAccountLink` yet. That fact is load-bearing for the transaction strategy in §4.

---

## 1. Current mutation map

17 `WorkspaceAccountShare` mutation call sites were found across 11 files (grep for
`workspaceAccountShare\.(create|update|upsert|updateMany|delete|deleteMany|createMany)`
over `**/*.ts`), plus one cross-cutting helper (`mergeArchivedDuplicateIntoCanonical`)
called from four of those sites. No raw SQL (`$executeRaw`/`$queryRaw`) and nothing
under `jobs/` touches this table — Prisma Client is the only access path, so this list
is exhaustive. No site anywhere in the repo uses `db.$transaction` (repo-wide search
confirms zero usage of `$transaction` in this codebase today).

Two of the user's 12 named paths turned out to be **generic**, not Plaid-specific —
flagged in §7 (Open Decision 6):

- "Plaid account archive" → `app/api/accounts/[id]/route.ts` `DELETE`, which archives
  any non-manual `FinancialAccount` (Plaid- or wallet-sourced) the caller has a share
  on, with a Plaid-specific side effect (disconnecting the item) only when one applies.
- "Generic account restore" → `app/api/accounts/[id]/restore/route.ts`, which is
  explicitly documented in its own header as covering "Plaid-linked accounts in
  particular" but not exclusively.

| # | User's path | File : line | Op | Trigger |
|---|---|---|---|---|
| 1 | Plaid link / relink | `app/api/plaid/exchange-token/route.ts:250-261` | `upsert` (per account, in a loop) | `POST /api/plaid/exchange-token` |
| 2 | Plaid account archive | `app/api/accounts/[id]/route.ts:163-166` | `updateMany` (status→REVOKED, scoped to `financialAccountId`) | `DELETE /api/accounts/:id` |
| 3 | Generic account restore | `app/api/accounts/[id]/restore/route.ts:157-160` | `updateMany` (status→ACTIVE, inside `Promise.all`) | `POST /api/accounts/:id/restore` |
| 3b | — (duplicate-merge branch of #3) | `lib/accounts/reconcile.ts:329-340` via `restore/route.ts:130` | `upsert` (loser shares re-pointed to winner) | same route, when a duplicate is found |
| 4 | Manual account create | `app/api/accounts/manual/route.ts:132-148` | `upsert` (looped over personal + additional space IDs) | `POST /api/accounts/manual` |
| 5 | Manual account archive | `app/api/accounts/manual/[id]/route.ts:135-142` | `updateMany` (status→REVOKED, scoped to `financialAccountId`, **not** status-filtered) | `DELETE /api/accounts/manual/:id` |
| 6 | Manual account restore | `app/api/accounts/manual/[id]/restore/route.ts:96-103` | `updateMany` (status→ACTIVE, inside `Promise.all`) | `POST /api/accounts/manual/:id/restore` |
| 6b | — (duplicate-merge branch of #6) | `lib/accounts/reconcile.ts:329-340` via `manual/[id]/restore/route.ts:69` | `upsert` | same route, when a duplicate is found |
| 7 | Manual permanent delete | `app/api/accounts/manual/[id]/permanent/route.ts:70` | `deleteMany` (hard delete, all rows for the account) | `DELETE /api/accounts/manual/:id/permanent` |
| 8a | Wallet create/reactivate — active duplicate | `app/api/accounts/wallet/route.ts:59-70` | `upsert` | `POST /api/accounts/wallet` |
| 8b | Wallet create/reactivate — archived duplicate | `app/api/accounts/wallet/route.ts:112-123` | `upsert` | same route |
| 8c | Wallet create/reactivate — brand-new wallet | `app/api/accounts/wallet/route.ts:173-182` | `create` | same route |
| 8d | — (duplicate-merge branch of #8a) | `lib/accounts/reconcile.ts:329-340` via `wallet/route.ts:83` | `upsert` | same route, archived-dup-alongside-active-match case |
| 9 | Space account share | `app/api/spaces/[id]/accounts/share/route.ts:73-92` | `upsert` | `POST /api/spaces/:id/accounts/share` |
| 10 | Space account revoke | `app/api/spaces/[id]/accounts/share/route.ts:153-160` | `update` (by `id`, not `updateMany`) | `DELETE /api/spaces/:id/accounts/share` |
| 11 | Member removal cascade | `app/api/spaces/[id]/members/[userId]/route.ts:142-154` | `updateMany` (status→REVOKED, scoped to `{spaceId, addedByUserId, status: ACTIVE}`) | `DELETE /api/spaces/:id/members/:userId` |
| 12a | Seed — full-account create | `prisma/seed.ts:200` (`createFullAccount`) | `create` | `npx prisma db seed` |
| 12b | Seed — cross-space share | `prisma/seed.ts:219` (`shareAccount`) | `create` | same script |
| 12c | Seed — wipe | `prisma/seed.ts:255` | `deleteMany` (full table wipe) | same script, start of `main()` |
| 13 | *(not in original 12 — discovered)* | `lib/accounts/reconcile.ts:329-340` (`mergeArchivedDuplicateIntoCanonical`) | `upsert` (looped over every share the loser account had) | shared helper — called by #3b, #6b, #8d, and indirectly by `resolveAccountByFingerprint`'s sibling-consolidation path used from `exchange-token/route.ts` and both restore routes |

Row #13 is genuinely new information, not one of the 12 named paths — it is a shared
utility, not a user-triggered action in its own right, but it does write
`WorkspaceAccountShare` independently of the route that called it. See Open Decision 5.

**Transaction context per site** (relevant to §4): only #3 and #6 use `Promise.all`
(not `$transaction` — no rollback semantics, just concurrency). Every other site is
plain sequential `await`. None use `db.$transaction`.

**`addedByUserId` / `revokedByUserId` source per site** — already exactly the fields
needed for the dual-write field mapping in §2:

- #1: `addedByUserId: userId` (the linking user) on create; revoke fields untouched (this route never revokes).
- #2: `revokedByUserId: user.id` (the caller, who must hold an active share).
- #3 / #3b: revoke fields cleared to `null` on restore; merge branch copies `s.addedByUserId` verbatim from the loser's row.
- #4: `addedByUserId: userId` on create; on `upsert.update` branch, revoke fields cleared but `addedByUserId` is **not** reasserted (stays whatever it was).
- #5: `revokedByUserId: userId` (caller — same as owner, since this route requires `ownerUserId === userId`).
- #6 / #6b: revoke fields cleared to `null`.
- #7: hard delete — no field mapping applies.
- #8a/8b: revoke fields cleared to `null`; `addedByUserId` reasserted to the current `userId` only in the `create` branch, not the `update` branch.
- #8c: `addedByUserId: userId`.
- #8d: copies `s.addedByUserId` verbatim from loser.
- #9: `addedByUserId: userId` reasserted on **both** create and update branches (the only route that does this on update).
- #10: `revokedByUserId: userId`.
- #11: `revokedByUserId: isSelf ? targetUserId : user.id` — the only site where revoker ≠ caller is possible (self-leave records the leaving member as their own revoker).
- #12a/#12b: `addedByUserId: userId` param, no revocation ever (seed data is always created ACTIVE).
- #13: copies `s.addedByUserId` verbatim from loser's row.

---

## 2. Proposed dual-write rules

**Rule 1 — compute `kind` dynamically; never copy it from another row.**
Before every dual-write, resolve `creatorPersonalSpaceId` for the account in play:
`creatorUserId = financialAccount.createdByUserId ?? financialAccount.ownerUserId`,
then the same lookup Step 2 uses (`spaceMember.findFirst({ userId: creatorUserId,
status: ACTIVE, space: { type: PERSONAL, archivedAt: null, deletedAt: null } })`).
`kind = targetSpaceId === creatorPersonalSpaceId ? HOME : SHARED`. This must be
recomputed per write, every time — including inside `mergeArchivedDuplicateIntoCanonical`,
where naively copying the loser's `kind` onto the winner would be wrong (see Rule 1
note under #13 in §3) and could put a second HOME row on the winner.

**Rule 2 — upsert keyed on `spaceId_financialAccountId`, same compound key
`WorkspaceAccountShare` uses (`workspaceId_financialAccountId`).** Every dual-write is
a `prisma.spaceAccountLink.upsert(...)`, even where the `WorkspaceAccountShare` side
is `create`, `update`, or `updateMany` — this makes every dual-write idempotent and
self-healing if a link row is ever found missing for a pair that should already exist.

**Rule 3 — field mapping is verbatim except `kind`:** `addedByUserId`,
`visibilityLevel`, `status`, `revokedAt`, `revokedByUserId` all copy straight across
from whatever is being written to `WorkspaceAccountShare` in that same call. `createdAt`
is left to its `@default(now())` on first insert — Step 3 is a live mirror, not a
historical reconstruction, so (unlike Step 2's backfill) there is no reason to backdate it.

**Rule 4 — account-creation paths must independently ensure a HOME link exists at the
creator's personal-space pair, even when the `WorkspaceAccountShare` write in that same
call targets a different space.** This applies to `exchange-token/route.ts`'s
"create new row" branch and `wallet/route.ts`'s "create new wallet" branch — both call
`getSpaceContext()` for `spaceId`, which can resolve to any space the user is currently
active in, not necessarily personal. Manual create (`#4`) already targets the personal
space first by construction (`shareTargets = [personalSpaceId, ...additionalIds]`), so
it satisfies this automatically with no extra step. For the other two, satisfying it
requires resolving the creator's personal space and upserting a HOME link there
*independently* of the SHARED-or-HOME link being written for the actual `spaceId` in
scope — otherwise an account first linked while the user is active in a SHARED space
would have **zero** HOME link, silently breaking the "exactly one HOME per account"
invariant Step 2 just established for every account that exists today. Flagged as Open
Decision 1 — this is more than pure 1:1 mirroring and needs explicit sign-off.

**Rule 5 — best-effort, non-fatal, sequential after the canonical write.** A
`SpaceAccountLink` write failure must never affect the `WorkspaceAccountShare` result
returned to the caller. This is safe specifically because nothing reads
`SpaceAccountLink` yet (confirmed in Step 2). Pattern: reuse the same idiom this
codebase already has for `regenerateSpaceSnapshot` / `regenerateSnapshotsForAccounts` —
wrap in `try/catch`, `console.warn` on failure, never re-throw.

**Rule 6 — do not join an existing `Promise.all`.** `#3` and `#6` fire several writes
concurrently via `Promise.all`. Adding the dual-write as one more array entry would let
a `SpaceAccountLink`-only failure reject the whole `Promise.all` and turn an otherwise-
successful restore into an apparent 500 — `Promise.all` provides no rollback of the
entries that already succeeded, so this is strictly worse, not safer. The dual-write
must run sequentially *after* that `Promise.all` resolves, exactly where the existing
(also best-effort) snapshot-regen call already sits in both of those routes.

**Rule 7 — no `db.$transaction` in this step.** No route in the codebase uses it today.
Introducing it for the first time, solely to protect a mirror table nothing reads yet,
adds a new failure mode (a `SpaceAccountLink` error rolling back an otherwise-successful
canonical write) with no offsetting benefit. Recommendation: sequential, non-transactional
writes everywhere in Step 3. This recommendation is specific to Step 3's circumstances —
it should be revisited once/if a future step makes `SpaceAccountLink` load-bearing for
reads.

**Rule 8 — member-removal cascade scope is not expanded.** `#11`'s dual-write mirrors
its existing `where` clause exactly — `{ spaceId, addedByUserId: targetUserId, status:
ACTIVE }` — translated field-for-field onto `SpaceAccountLink`. No additional cascade
(e.g., touching the removed member's links in other spaces, or links they didn't add
themselves) is introduced.

**Rule 9 — audit log and snapshot-regeneration behavior do not change.** Every existing
`auditLog.create` call and every existing `regenerateSpaceSnapshot` /
`regenerateSnapshotsForAccounts` call is left exactly as-is in this step — both continue
to read/describe `WorkspaceAccountShare` only. `SpaceAccountLink` stays invisible to
snapshots, audit metadata, and the UI until a future cutover step.

---

## 3. Route-by-route implementation checklist

Each item below is "add a best-effort `spaceAccountLink.upsert` call," not a rewrite of
existing logic. None of these are implemented yet.

### #1 — Plaid link / relink (`app/api/plaid/exchange-token/route.ts:250-261`)
- [ ] After the existing `workspaceAccountShare.upsert`, add a `spaceAccountLink.upsert` at `(spaceId, fa.id)` with `kind` computed per Rule 1, fields per Rule 3.
- [ ] Per Rule 4: in the `create` branch just above (the "no resolution found" `else` at line 187), additionally resolve the creator's (=`userId`'s, since `createdByUserId: userId` here) personal space and upsert a HOME link there if it differs from `spaceId`. The `update` branches (existing-account and fingerprint-reuse) do not need this — the account already has a HOME link from a prior creation.
- [ ] Status: this route only ever sets `ACTIVE` (no revoke path) — straightforward.
- [ ] Wrap in try/catch, non-fatal (Rule 5), placed right after the existing upsert, inside the same per-account loop.
- [ ] No snapshot/audit change (Rule 9).

### #2 — Plaid (generic, non-manual) account archive (`app/api/accounts/[id]/route.ts:163-166`)
- [ ] After the `updateMany`, for each `spaceId` in `affectedSpaceIds` (already computed at line 174 from `fa.workspaceShares`, captured pre-revocation — reuse it instead of re-querying), `spaceAccountLink.upsert` with `status: REVOKED, revokedAt: now, revokedByUserId: user.id`.
- [ ] `kind` recomputed per Rule 1 per space (cheap — resolve the creator's personal space once per request, reuse across the loop).
- [ ] Best-effort, placed near the existing snapshot-regen loop (lines 175-181) — can share the same try/catch block or use its own; either is fine since both are already non-fatal.
- [ ] No audit change.

### #3 — Generic account restore (`app/api/accounts/[id]/restore/route.ts`)
- [ ] Duplicate-merge branch (line 130, `canonical` found): the dual-write lives inside `mergeArchivedDuplicateIntoCanonical` itself — see #13 below. Nothing extra needed at this call site.
- [ ] Normal-restore branch (lines 145-161, inside `Promise.all`): per Rule 6, do **not** add a 4th array entry. Instead, after the `Promise.all` resolves (right before or alongside the existing `regenerateSnapshotsForAccounts` try/catch at lines 168-172), add a sequential, best-effort `updateMany`-equivalent — since `SpaceAccountLink` has no native `updateMany` keyed scenario here, this means looking up the affected `(spaceId, financialAccountId)` pairs (every space this account has a `REVOKED` `WorkspaceAccountShare` row in, which `Promise.all`'s 3rd entry just reactivated) and `upsert`-ing each to `ACTIVE`/cleared-revoke fields.
- [ ] No audit change (audit log at lines 175-182 already fires after this point and does not need to know about `SpaceAccountLink`).

### #4 — Manual account create (`app/api/accounts/manual/route.ts:132-148`)
- [ ] After the `Promise.all(shareTargets.map(...))` upsert loop, add a second best-effort loop over the same `shareTargets` doing `spaceAccountLink.upsert`. `shareTargets[0]` is always `personalSpaceId` → HOME by construction (Rule 1 will also derive HOME here naturally, since `createdByUserId: userId` and `personalSpaceId` is by definition that same user's personal space); every entry in `additionalIds` → SHARED.
- [ ] No Rule-4 gap here — personal space is always the first target.
- [ ] No audit change.

### #5 — Manual account archive (`app/api/accounts/manual/[id]/route.ts:135-142`)
- [ ] Note: this `updateMany` is **not** filtered to `status: ACTIVE` like #2's is — it revokes unconditionally (`where: { financialAccountId: id }`). The dual-write should match that same (unfiltered) scope for consistency, even though in practice every link should already be `ACTIVE` by the time this fires.
- [ ] Need the list of affected `spaceId`s before revoking — fetch `workspaceAccountShare.findMany({ where: { financialAccountId: id } })` (or capture from an existing `fa` lookup, if extended) before the `updateMany`, since unlike #2 this route doesn't already load `workspaceShares`.
- [ ] `revokedByUserId: userId` (caller, who is verified `ownerUserId === userId` above).
- [ ] Best-effort, after the existing sequence, before or alongside the audit log at lines 157-164.

### #6 — Manual account restore (`app/api/accounts/manual/[id]/restore/route.ts`)
- [ ] Duplicate-merge branch (line 69): handled inside `mergeArchivedDuplicateIntoCanonical` — see #13.
- [ ] Normal-restore branch (lines 84-104, inside `Promise.all`): same Rule 6 treatment as #3 — sequential, best-effort, after the `Promise.all`, alongside the existing snapshot-regen try/catch (lines 111-115).
- [ ] No audit change.

### #7 — Manual permanent delete (`app/api/accounts/manual/[id]/permanent/route.ts:70`)
- [ ] This is a **hard delete**. Add `db.spaceAccountLink.deleteMany({ where: { financialAccountId: id } })` immediately alongside the existing `workspaceAccountShare.deleteMany` (same FK-safe ordering — before `accountConnection.deleteMany` and `financialAccount.delete`).
- [ ] This is the one site where "best-effort" framing doesn't really apply — a hard delete of the canonical row should not leave a dangling mirror row behind on purpose. Still keep it non-fatal per Rule 5 (wrap in try/catch so a `SpaceAccountLink` error doesn't block the FK-required cleanup of the rows that actually block deletion), but there's no real "drift" risk either way since the account itself is about to be gone.
- [ ] No audit change (the existing audit log at lines 60-67 already fires before any of the deletes).

### #8a/8b — Wallet active/archived duplicate re-share (`app/api/accounts/wallet/route.ts:59-70, 112-123`)
- [ ] Same `spaceAccountLink.upsert` mirroring as #1, right after each existing `workspaceAccountShare.upsert`.
- [ ] 8b additionally calls `regenerateSnapshotsForAccounts` afterward (lines 127-131) — the dual-write should sit before that, alongside the existing `workspaceAccountShare.upsert` it mirrors, not after.
- [ ] 8a's `mergeArchivedDuplicateIntoCanonical` call (lines 83-89, for the archived-duplicate-alongside-active-match case) is handled by #13, not here.

### #8c — Wallet brand-new create (`app/api/accounts/wallet/route.ts:173-182`)
- [ ] Same Rule 4 treatment as #1's create branch: `spaceId` here is `getSpaceContext().spaceId`, which may not be personal. After the existing `workspaceAccountShare.create`, add the SHARED-or-HOME link at `spaceId` per Rule 1, **and** independently ensure a HOME link exists at the creator's (`userId`'s, since `createdByUserId: userId`) personal space if it differs from `spaceId`.

### #9 — Space account share (`app/api/spaces/[id]/accounts/share/route.ts:73-92`)
- [ ] Mirror the `upsert` 1:1 — including that this route, uniquely among the upsert-sites, reasserts `addedByUserId` on the `update` branch too (line 88) — the dual-write's `update` branch should do the same.
- [ ] `kind` per Rule 1 — since the caller chooses an arbitrary `spaceId` here (any space they're an ACTIVE member of), this is the clearest "could be HOME or SHARED depending on which space" case; no shortcut available, must always resolve dynamically.
- [ ] No audit change (existing `ACCOUNT_SHARE` log at lines 94-102 unaffected).

### #10 — Space account revoke (`app/api/spaces/[id]/accounts/share/route.ts:153-160`)
- [ ] This is an `update` by `id` (not `updateMany`) — the dual-write needs the `(spaceId, financialAccountId)` pair to upsert against, which is available from the `share` object already fetched at lines 134-142 (`workspaceId: spaceId` from the route param, `financialAccountId` from the request body).
- [ ] `revokedByUserId: userId`.
- [ ] No audit change.

### #11 — Member removal cascade (`app/api/spaces/[id]/members/[userId]/route.ts:142-154`)
- [ ] Mirror the `updateMany`'s exact `where` (`{ spaceId, addedByUserId: targetUserId, status: ACTIVE }`) onto `SpaceAccountLink` — same scope, no expansion (Rule 8).
- [ ] `revokedByUserId: isSelf ? targetUserId : user.id` — preserve the self-leave-records-self-as-revoker behavior exactly.
- [ ] Since this is an `updateMany`-shaped operation and `SpaceAccountLink` doesn't have a single-call `updateMany` keyed the same way that's also idempotent-safe against missing rows, this needs a `findMany` (to get the exact pairs) + per-pair `upsert` loop, same pattern as #5.
- [ ] No audit change (existing `SPACE_LEAVE`/`SPACE_REMOVE_MEMBER` log at lines 160-168 unaffected).

### #12a/#12b/#12c — Seed script (`prisma/seed.ts`)
- [ ] `createFullAccount()` (line 200): add a `spaceAccountLink.create` matching the existing `workspaceAccountShare.create` — always HOME here, since every call site passes the account owner's own personal space as `spaceId` (verified: every `createFullAccount` call in `main()` uses `janeSpace.id`/`johnSpace.id` paired with that same user's `userId`).
- [ ] `shareAccount()` (line 219): add a `spaceAccountLink.create` matching the existing `workspaceAccountShare.create` — always SHARED here, since every call site targets a different (non-owner) space (`householdSpace`, `debtSpace`, `japanSpace`, `investmentSpace`, `businessSpace`, `propertySpace`).
- [ ] Wipe (line 255): add `prisma.spaceAccountLink.deleteMany()` immediately alongside the existing `prisma.workspaceAccountShare.deleteMany()`, same position in the reverse-dependency wipe order (before `accountConnection`/`financialAccount`, since both reference `FinancialAccount`). Without this, re-running the seed would leave stale `SpaceAccountLink` rows pointing at the *previous* run's now-deleted `FinancialAccount` ids — harmless (nothing reads them) but unnecessary drift, and cheap to avoid.
- [ ] Flagged in Open Decision 3 — whether this belongs in the same commit as the 11 live-route changes, or its own follow-up commit within this same Step-3 branch, per the "don't implement everything in one commit" rule.

### #13 — `mergeArchivedDuplicateIntoCanonical` (`lib/accounts/reconcile.ts:291-358`, share loop at 327-341)
- [ ] For each `s` in `loserShares`, alongside the existing `workspaceAccountShare.upsert` (which re-points the share from `loserId` to `winnerId` at the same `s.workspaceId`), add a `spaceAccountLink.upsert` at `(s.workspaceId, winnerId)`.
- [ ] **`kind` must be recomputed against `winnerId`'s own creator, not copied from whatever kind the loser's link happened to have.** This is the one site in the whole review where copying would be actively wrong: if winner already has a HOME link at its own personal-space pair (a different `spaceId` than `s.workspaceId`), and the loser's link at `s.workspaceId` happened to be HOME (relative to the *loser's* creator), blindly copying `kind: HOME` onto `(s.workspaceId, winnerId)` would give winner two HOME-kind rows at two different spaces — violating the exactly-one-HOME-per-account invariant. Recomputing per Rule 1 against winner's identity avoids this; it will only land as HOME if `s.workspaceId` happens to equal winner's own resolved personal space.
- [ ] This function is called from 4 places (#3b, #6b, #8d, plus internally from `pickCanonicalAndMerge`/`resolveAccountByFingerprint`, which `exchange-token/route.ts` also calls) — fixing it once here covers all of them. No per-call-site change needed beyond what's already listed for #3, #6, #8a.
- [ ] Best-effort per Rule 5 — this function currently has no try/catch of its own around the share loop; the dual-write addition should get its own inner try/catch so one space's `SpaceAccountLink` hiccup doesn't stop the loop from re-pointing the remaining spaces' canonical shares.
- [ ] Flagged in Open Decision 5 — confirm this in-scope-for-Step-3 vs. its own follow-up, since it's shared infrastructure rather than a single named path.

---

## 4. Transaction strategy

No site uses `db.$transaction` today (repo-wide, not just these 17). Recommendation —
**no `$transaction` anywhere in Step 3.** Reasoning:

- `SpaceAccountLink` is not read by any application code yet. A dual-write failure has
  zero user-visible blast radius today — at worst, `SpaceAccountLink` is briefly stale
  for that one pair until the next backfill-style reconciliation or the next successful
  write to the same pair self-heals it (Rule 2's upsert makes every future write
  self-healing).
- Wrapping the canonical `WorkspaceAccountShare` write and the new `SpaceAccountLink`
  write in a shared `$transaction` would mean a `SpaceAccountLink`-side error (a brand
  new code path, by definition less battle-tested than the share write it's mirroring)
  could roll back an otherwise-correct, user-facing canonical write. That is a strictly
  worse failure mode than today's status quo.
- This codebase's established idiom for "secondary, derived effect that must not block
  the primary write" is already best-effort try/catch + `console.warn` —
  `regenerateSpaceSnapshot` / `regenerateSnapshotsForAccounts` use exactly this pattern
  in 5 of these same routes already. The dual-write should be one more instance of that
  same idiom, not a new pattern.

Two routes (#3, #6) use `Promise.all` for unrelated reasons (parallelizing three
independent canonical writes). Per Rule 6, the dual-write must **not** become a fourth
entry in either `Promise.all` — it runs sequentially after, like the snapshot-regen call
already does in both routes. This is not a transaction-strategy exception; it's the same
best-effort idiom, just placed correctly relative to existing non-transactional
concurrency.

If a future step (cutover / Step 4+) ever makes `SpaceAccountLink` a read source, this
recommendation should be revisited — at that point a real correctness argument for
`$transaction` (or at least synchronous-and-checked rather than best-effort) would exist.
Not before.

---

## 5. Validation plan

No schema change in this step, so `npx prisma migrate dev` does not apply. Standard
checks:

- [ ] `npx prisma generate` — sanity check only (no schema touched).
- [ ] `npx tsc --noEmit` — clean.
- [ ] `npm run lint` — clean.
- [ ] Targeted route testing, one pass per route in §3 — for each: perform the action,
      then assert the resulting `SpaceAccountLink` row(s) match the
      `WorkspaceAccountShare` row(s) on `status`, `visibilityLevel`,
      `addedByUserId`/`revokedByUserId`, and that `kind` is HOME iff the target space is
      the account creator's personal space.
- [ ] Re-run `scripts/verify-space-account-link-backfill.ts` after exercising every
      route once. Its Check 3 ("every `WorkspaceAccountShare` row has a matching
      `SpaceAccountLink` row with matching `status`/`visibilityLevel`") and Checks 1/2
      (HOME cardinality) are exactly the regression checks Step 3 needs — no new script
      required, this one already asserts the post-condition Step 3 is supposed to
      maintain going forward. Recommend running it as a manual post-deploy smoke check
      until/unless it's wired into CI.
- [ ] Specifically exercise the Rule 4 gap: link a brand-new Plaid item (or add a brand-
      new wallet) while the active space is a non-personal SHARED space, and confirm a
      HOME link is created at the personal space *in addition to* the SHARED link at the
      active space — this is the one behavior that isn't pure 1:1 mirroring and is the
      easiest to accidentally skip during implementation.
- [ ] Confirm a deliberately-forced `SpaceAccountLink` write failure (e.g., a temporary
      bad `financialAccountId`) does not change the HTTP response or status code of any
      of the 12 routes — proves Rule 5's non-fatal framing actually holds in practice,
      not just in code review.

---

## 6. Rollback plan

Step 3 is additive only — new write side effects, no schema change, no read-path
change. Rollback is just reverting the application-code change (remove or feature-flag
off the dual-write calls).

`SpaceAccountLink` rows written during a rollout-then-rollback window are harmless
leftovers — nothing reads the table, so stale or duplicate-but-idempotent rows in it
have zero user-visible effect. If a fully clean slate is wanted anyway, the same
pattern Step 2 already established applies: `DELETE FROM "SpaceAccountLink";` followed
by re-running `scripts/backfill-space-account-link.ts` to resynchronize from
`WorkspaceAccountShare`'s current state. No migration or schema reversion needed either
way.

A feature flag (e.g., a single exported boolean/env var gating every dual-write call)
would make rollback a one-line change instead of a multi-file revert, at the cost of one
more conditional in each of the ~13 call sites. Whether that's worth it is Open
Decision 2 — not assumed here either way.

---

## 7. Open decisions requiring approval

1. **Rule 4 (HOME synthesis on creation paths).** Confirm that Plaid-link and wallet-
   create's "create new account" branches should *independently* ensure a HOME link at
   the creator's personal space, even when their primary `WorkspaceAccountShare` write
   targets a different (active, non-personal) space. This is the one piece of this
   design that is more than pure 1:1 mirroring — without it, any account first created
   while the user is active in a SHARED space would end up with no HOME link at all,
   regressing the invariant Step 2 just finished establishing for every existing
   account.

2. **Feature flag.** Should the dual-write calls be gated behind a single flag/env var
   for a fast kill-switch, or shipped unconditionally? No strong reason either way given
   how low-risk (best-effort, unread table) this is, but it's a one-line decision worth
   making explicitly rather than defaulting silently.

3. **Seed script timing.** `prisma/seed.ts` (#12a/b/c) is dev-only and isolated from the
   11 live-route changes. Confirm whether it ships in the same commit as the route-level
   dual-write, or as its own follow-up commit within this same Step 3 branch — per the
   "don't implement everything in one commit" project rule, splitting it out is
   reasonable but adds a small window where local dev seeding produces
   `SpaceAccountLink` data that's missing relative to what the live routes are now
   producing.

4. **Verify-script reuse vs. extension.** `scripts/verify-space-account-link-backfill.ts`
   already asserts the exact post-condition Step 3 needs to hold continuously (every
   share has a matching, field-accurate link). Confirm whether to just keep running it
   as-is post-deploy (no code change), or invest in wiring it into CI / a scheduled job
   as part of this step rather than a later one.

5. **`mergeArchivedDuplicateIntoCanonical` (#13).** This was not one of the originally
   named 12 paths — it's shared infrastructure called from 4 different places. Confirm
   whether its dual-write lands in this same Step 3 pass (recommended, since it's a
   single ~15-line change that covers 4 call sites at once) or gets carved out as its
   own follow-up given it's cross-cutting rather than a single named user action.

6. **Scope-naming correction.** "Plaid account archive" (#2) and "Generic account
   restore" (#3) are, in the actual codebase, generic non-manual archive/restore routes
   that also cover wallet accounts — not Plaid-exclusive. Confirm this matches intent
   before implementation; no behavior change is implied either way, just a naming/scope
   clarification for the checklist in §3.

---

**Stop here.** No code has been changed in this step. Implementation should proceed
decision-by-decision per the project's standing working style (checklist → approval →
implement → validate), not as one combined change across all 13 sites.
