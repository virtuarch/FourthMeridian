# KD-4 — Atomic `SpaceAccountLink` Writes: Implementation Checklist

**Status:** Checklist only. No code changed. Approved direction locked (see header).
**Companion:** `docs/investigations/KD4_ATOMIC_SPACE_ACCOUNT_LINK_WRITES_INVESTIGATION.md`
**Branch:** `feature/phase-2-architecture`

**Approved framing:** KD-4 is **not** WAS↔SAL mirror desync (WAS runtime writes are already retired). KD-4 is **atomicity for multi-table `SpaceAccountLink`-related DB write sequences.**

**Approved direction (constraints):**
- Thread an optional Prisma transaction client through the SAL helpers.
- Wrap DB-only write groups in `db.$transaction`.
- Keep external side-effects (Plaid `itemRemove`, snapshot regen) outside transactions.
- Do **not** implement KD-5 (HOME uniqueness). Do **not** add schema or migrations. Do **not** remove dead helpers. Do **not** touch read paths.

**Sequencing rule:** implement in the phase order below; each phase compiles and passes validation on its own before the next begins. Additive-before-subtractive throughout.

---

## Phase 0 — Shared client type (foundation)

- [ ] **0.1** In `lib/accounts/space-account-link.ts`, add the transaction-client type at the top of the module:
  - Import: `import { Prisma } from "@prisma/client";`
  - Define: `type DbClient = Prisma.TransactionClient | typeof db;`
  - Rationale: every helper below accepts this union so a call site may pass either the singleton `db` (default) or a `tx` handle from `db.$transaction(async (tx) => …)`.
- [ ] **0.2** In `lib/accounts/reconcile.ts`, add the same `import { Prisma } from "@prisma/client";` and reuse `DbClient` (either re-declare locally or export from `space-account-link.ts` and import — prefer **export** from `space-account-link.ts` to avoid two definitions).

---

## Phase 1 — Thread `tx` through SAL helpers (additive, no behavior change)

File: `lib/accounts/space-account-link.ts`. Every change is a **defaulted trailing/added param** so all existing call sites compile unchanged.

### Exact signature changes

- [ ] **1.1** `computeLinkKind`
  - From: `export async function computeLinkKind(spaceId: string, financialAccountId: string): Promise<SpaceAccountLinkKind>`
  - To:   `export async function computeLinkKind(spaceId: string, financialAccountId: string, client: DbClient = db): Promise<SpaceAccountLinkKind>`
  - Body: replace both `db.spaceAccountLink.count(...)` and `db.spaceAccountLink.findFirst(...)` with `client.spaceAccountLink.*`. **Both reads must use `client`** (Risk R1 — a read left on `db` sees pre-transaction state and hollows the guarantee).

- [ ] **1.2** `dualWriteSpaceAccountLink`
  - Add `client?: DbClient` to the params object:
    `params: { spaceId; financialAccountId; creatorUserId?; create; update; client?: DbClient }`
  - Body: `const client = params.client ?? db;` then `await computeLinkKind(params.spaceId, params.financialAccountId, client)` and `client.spaceAccountLink.upsert(...)`.

- [ ] **1.3** `dualWriteFromShare`
  - From: `(share, creatorUserId?)`
  - To:   `(share, creatorUserId?, client?: DbClient)`
  - Body: pass `client` through to `dualWriteSpaceAccountLink({ …, client })`.

- [ ] **1.4** `dualWriteFromShares`
  - From: `(shares, creatorUserId?)`
  - To:   `(shares, creatorUserId?, client?: DbClient)`
  - Body: forward `client` into each `dualWriteFromShare(share, creatorUserId, client)`.
  - Note: no runtime callers today (FD-3) — threaded only for consistency.

- [ ] **1.5** `dualDeleteSpaceAccountLinks`
  - From: `(financialAccountId: string)`
  - To:   `(financialAccountId: string, client: DbClient = db)`
  - Body: `client.spaceAccountLink.deleteMany(...)`.

- [ ] **1.6** `resolveAccountCreatorUserId` (read used inside merge tx)
  - From: `(financialAccountId: string)`
  - To:   `(financialAccountId: string, client: DbClient = db)`
  - Body: `client.financialAccount.findUnique(...)`. Threaded so the merge tx reads a consistent snapshot.

- [ ] **1.7** `ensureHomeLink` — **do not touch.** Documented dead code (self-catching). Out of scope (FD-3).

### Comment corrections (in-file, additive, FD-1/FD-2/R6)

- [ ] **1.8** Update the module header: **Rule 7** ("no `db.$transaction` … none used anywhere in this codebase today") is now false. Rewrite to state that helpers accept an optional transaction client and that callers wrap DB-only write groups; note external side-effects stay outside.
- [ ] **1.9** Update the header note claiming "WorkspaceAccountShare remains live at its final mutation site … mirrored here" — WAS runtime writes are retired; SAL is the sole write target. Correct to reflect current reality.

---

## Phase 2 — Merge pipeline atomicity (highest leverage)

File: `lib/accounts/reconcile.ts`. This is the core of KD-4.

### 2.1 `mergeArchivedDuplicateIntoCanonical` — wrap DB-only group, thread `tx`

- [ ] **2.1a** Signature:
  - From: `(loserId, winnerId, source, spaceId?)`
  - To:   `(loserId, winnerId, source, spaceId?, client: DbClient = db)`
- [ ] **2.1b** Wrap the **DB-only write group (a)–(e)** in `await client.$transaction(async (tx) => { … })` **only when called at the top level** (i.e. when `client === db`). If a `tx` was already passed in, reuse it directly (never nest — Prisma forbids nested interactive tx). Pattern:
  ```
  const run = async (tx: DbClient) => { /* steps a–e using tx */ };
  if (client === db) { await db.$transaction(async (tx) => run(tx)); }
  else { await run(client); }
  ```
- [ ] **2.1c** Inside the transaction body, route **every** write through `tx`:
  - `tx.transaction.updateMany` (re-point loser transactions)
  - goalContribution loop: `tx.goalContribution.findUnique` + `tx.goalContribution.update`
  - `tx.debtProfile.findUnique` + `tx.debtProfile.updateMany`
  - `resolveAccountCreatorUserId(winnerId, tx)` (threaded read)
  - `tx.spaceAccountLink.findMany` (loser links)
  - loser-links loop → `dualWriteSpaceAccountLink({ …, client: tx })`
  - `tx.duplicateAccountCandidate.upsert`
- [ ] **2.1d** **Do NOT** move `closeOutAccountConnections` into this function's transaction — it stays at the **caller** level and outside any tx (external Plaid call). It is already invoked by the callers, not by `mergeArchivedDuplicateIntoCanonical` itself. Confirm this remains true after the edit.

### 2.2 `pickCanonicalAndMerge` — fold loser-archive into the merge tx

- [ ] **2.2a** Signature: add `client: DbClient = db` trailing param.
- [ ] **2.2b** The pairing that must be atomic together is: `mergeArchivedDuplicateIntoCanonical(c.id, canonical.id, …)` **and** the subsequent `financialAccount.update({ deletedAt })` that archives an active loser (`reconcile.ts:296-301`). Close the §5.3 "two active rows" window by performing the loser-archive **inside the same transaction** as the merge write-group. Implementation: extend the `run(tx)` body from 2.1 to also perform `tx.financialAccount.update({ where:{id:c.id}, data:{deletedAt:new Date()} })` when the loser was active — i.e. pass an "archiveLoserIfActive" intent into the merge, OR wrap merge+archive in one `db.$transaction` at this call site. **Prefer** wrapping at this call site so `mergeArchivedDuplicateIntoCanonical` stays single-responsibility:
  ```
  await db.$transaction(async (tx) => {
    await mergeArchivedDuplicateIntoCanonical(c.id, canonical.id, SIBLING_CONSOLIDATION, spaceId, tx);
    if (!c.deletedAt) await tx.financialAccount.update({ where:{id:c.id}, data:{deletedAt:new Date()} });
  });
  ```
- [ ] **2.2c** `closeOutAccountConnections(c.id)` stays **after/outside** the transaction, unchanged (Plaid call).
- [ ] **2.2d** The per-candidate `db.transaction.count(...)` history tally that chooses the canonical row stays **outside** the transaction (read-only selection step; wrapping it buys nothing).

### 2.3 `resolveAccountByFingerprint` — archived-fold loop

- [ ] **2.3a** Signature: add `client: DbClient = db` trailing param (thread into the `pickCanonicalAndMerge` and merge calls).
- [ ] **2.3b** The active-branch loop that folds each archived sibling (`reconcile.ts:345-353`): wrap **each** `mergeArchivedDuplicateIntoCanonical(a.id, canonical.id, FINGERPRINT_MATCH, spaceId)` in its own `db.$transaction` (per-merge atomicity), keeping the following `closeOutAccountConnections(a.id)` outside.
- [ ] **2.3c** `findCandidatesByFingerprint` (read only) — no change required; optionally thread `client` for snapshot consistency, but not mandatory. Leave as-is to minimize diff.

---

## Phase 3 — Route write-group wrapping

Each route wraps only its **DB-only** writes. Snapshot regen and Plaid disconnect stay outside (post-commit). Audit rows that record the *successful* mutation go **inside** the transaction (matches `imports/rollback` precedent; Risk R5 accepted).

### 3.1 `app/api/accounts/manual/route.ts` (POST — create)

- [ ] Wrap in one `db.$transaction(async (tx) => { … })`:
  - `tx.financialAccount.create` (the manual FinancialAccount)
  - `tx.accountConnection.create`
  - the **sequential** `for (const wsId of shareTargets)` loop → `dualWriteSpaceAccountLink({ …, client: tx })`
- [ ] **Keep the loop sequential inside the tx** (do not parallelize — the HOME→SHARED ordering guard from `manual/route.ts:131-159` must be preserved; KD-5 interim mitigation).
- [ ] **Outside** the tx (unchanged): `regenerateSnapshotsForAccounts([fa.id])` (best-effort/non-fatal).

### 3.2 `app/api/accounts/wallet/route.ts` (POST — 3 branches)

- [ ] **Active-reuse branch:** wrap `dualWriteSpaceAccountLink({…,client:tx})`. `dualWriteProviderAccountIdentity` stays **outside** (mirror, self-catching, non-fatal). `mergeArchivedDuplicateIntoCanonical(archivedDup…)` — call at top level (it wraps its own tx per Phase 2); do **not** nest it inside a wallet-branch tx.
- [ ] **Archived-reactivate branch:** wrap together `tx.financialAccount.update(deletedAt:null)` + `tx.accountConnection.updateMany` + `dualWriteSpaceAccountLink({…,client:tx})`. Keep `dualWriteProviderAccountIdentity`, snapshot regen, and `auditLog` per §6.4 (audit inside if it records success).
- [ ] **New-create branch:** wrap `tx.financialAccount.create` + `tx.accountConnection.create` + `dualWriteSpaceAccountLink({…,client:tx})`. `dualWriteProviderAccountIdentity` and snapshot regen stay outside.

### 3.3 `lib/plaid/exchangeToken.ts` (per-account loop)

- [ ] Per `acct` iteration, wrap the DB-only account write group in `db.$transaction(async (tx) => { … })`:
  - the resolve/create/update on `tx.financialAccount` (all three branches)
  - `tx.accountConnection.create` / `tx.accountConnection.update`
  - `dualWriteSpaceAccountLink({ …, client: tx })`
- [ ] **Outside** each iteration's tx: `dualWriteProviderAccountIdentity` (mirror, non-fatal), and the pre-loop Plaid `accountsGet` fetch. The `resolveAccountByFingerprint` call in the else-branch manages its own tx per Phase 2 — call it at top level, not nested.
- [ ] **Scope guard:** wrap per-account, **not** the whole loop, to avoid one long-running interactive tx across many accounts (Risk R4 timeout).

### 3.4 `app/api/accounts/[id]/restore/route.ts` (POST)

- [ ] Replace the existing `await Promise.all([ fa.update, accountConnection.updateMany, spaceAccountLink.updateMany ])` (`restore/route.ts:145-161`) with **`await db.$transaction([ … ])`** (array form — three independent updates, no read-dependency).
- [ ] The merge branch (`mergeArchivedDuplicateIntoCanonical`) already wraps its own tx per Phase 2 — leave that call at top level.
- [ ] **Outside** the tx (unchanged): snapshot regen, `auditLog` (or inside per R5 decision — keep consistent across routes).

### 3.5 `app/api/accounts/manual/[id]/restore/route.ts` (POST)

- [ ] Same swap as 3.4: the `Promise.all([...])` restore trio (`manual/[id]/restore/route.ts:84-100`) → `db.$transaction([...])`.

### 3.6 `app/api/accounts/[id]/route.ts` (DELETE — archive)

- [ ] Wrap the DB-only state changes in one tx:
  - `tx.financialAccount.update(deletedAt)`
  - `tx.accountConnection.updateMany(deletedAt)`
  - the `spaceAccountLink.findMany` (capture affected spaces) + `tx.spaceAccountLink.updateMany(REVOKE)`
  - (audit inside per R5 decision)
- [ ] **Outside** the tx (unchanged, post-commit): snapshot regen loop, and the `disconnectPlaidItemIfOrphaned(plaidItemDbId)` loop (**Plaid call — must stay outside**).

### 3.7 `app/api/spaces/[id]/members/[userId]/route.ts` (DELETE — member removal)

- [ ] Wrap together (closes §5.6 privacy window):
  - `tx.spaceMember.update(LEFT/REMOVED)`
  - `tx.spaceAccountLink.updateMany(REVOKE member's links)`
  - (audit inside per R5 decision)
- [ ] **Outside** the tx: snapshot regen (best-effort).

### 3.8 `app/api/spaces/[id]/accounts/share/route.ts` (POST + DELETE)

- [ ] **POST:** wrap `dualWriteSpaceAccountLink({…,client:tx})` + `auditLog.create` in one tx. Snapshot regen outside.
- [ ] **DELETE:** wrap `tx.spaceAccountLink.update(REVOKE)` + `auditLog.create` in one tx. Snapshot regen outside.

### 3.9 `app/api/accounts/manual/[id]/permanent/route.ts` (DELETE — hard delete)

- [ ] Wrap the FK-safe delete group in one tx (keep order):
  - `dualDeleteSpaceAccountLinks(id, tx)`
  - `tx.accountConnection.deleteMany`
  - `tx.financialAccount.delete`
- [ ] The pre-delete `auditLog.create` (written before deletion to retain the name) may stay just before the tx or move inside as the first statement — keep it so the audit survives (it currently precedes deletion by design).

---

## Phase 4 — What goes inside vs. outside (consolidated reference)

**Inside each transaction (DB-only writes):**
`financialAccount.{create,update,delete}`, `accountConnection.{create,update,updateMany,deleteMany}`, `spaceAccountLink.{upsert,update,updateMany,deleteMany}` (via helpers with `client:tx`), `transaction.updateMany` (merge re-point), `goalContribution.*`, `debtProfile.*`, `duplicateAccountCandidate.upsert`, `spaceMember.update`, and `auditLog.create` rows that record a successful mutation.

**Outside every transaction (post-commit / external / non-fatal):**
- `disconnectPlaidItemIfOrphaned` / `closeOutAccountConnections` — external Plaid `itemRemove` (Risk R2).
- `regenerateSpaceSnapshot` / `regenerateSnapshotsForAccounts` — already best-effort/non-fatal.
- `dualWriteProviderAccountIdentity` — mirror table, self-catching, non-fatal by design.
- Per-candidate `transaction.count` canonical-selection reads (merge) — read-only.

---

## Phase 5 — Validation

Run after **each phase** compiles, and fully before opening the PR:

- [ ] `npx prisma generate` — must succeed (no schema change expected; this confirms the client is intact).
- [ ] `npx prisma migrate dev` — **NOT run** for KD-4. If it ever appears necessary, STOP: the change has drifted into KD-5/schema territory (out of scope).
- [ ] `npx tsc --noEmit` — must be clean. Watch for inference breaks where a `tx` handle is passed where `PrismaClient` was expected (the `DbClient` union should absorb these).
- [ ] `npm run lint` — clean.
- [ ] Targeted manual route testing (per investigation §9.3): manual create to Personal+2 spaces; Plaid reconnect against archived fingerprint match; restore-with-active-duplicate fold; member removal revokes shared links; permanent-delete removes SAL+conn+account.

---

## Phase 6 — Tests to add

New atomicity tests (co-located with existing suites; use the same harness as `lib/data/transactions.privacy.test.ts`):

- [ ] **Merge rollback:** inject a thrown error after the transaction re-point but before `duplicateAccountCandidate.upsert`; assert **nothing** moved (all loser transactions still on loser) and loser **not** archived — full rollback.
- [ ] **Merge success invariants:** exactly one `DuplicateAccountCandidate` for the pair, winner holds all history, active-loser archived in the same commit, Plaid disconnect attempted exactly once (mock, post-commit).
- [ ] **Create-trio rollback (`manual/route.ts`):** fail the 2nd `dualWriteSpaceAccountLink`; assert FinancialAccount + AccountConnection also rolled back (no orphaned invisible account, §5.2 worse-variant).
- [ ] **Restore atomicity:** fail the SAL reactivate inside the `$transaction([...])`; assert `financialAccount.deletedAt` **not** cleared (no ghost active account, §5.4).
- [ ] **Member-removal atomicity:** fail SAL revoke; assert `spaceMember` status **not** changed (§5.6).
- [ ] **KD-5 guard (documented xfail):** two concurrent first-links still able to produce ≥2 HOME rows after KD-4 — mark clearly as expected-fail proving KD-4 alone does not close KD-5. Not a KD-4 regression.

**Regression tests that must stay green:**
`lib/ai/assemblers/transactions.privacy.test.ts`, `lib/data/transactions.privacy.test.ts`, and the two-user visibility script.

---

## Phase 7 — Rollback plan

- **Migration impact:** none. No schema, no columns, no indexes, no enum values. Reverting the commit fully restores prior behavior.
- **Data compatibility:** rows written under the new code are byte-identical to before — only *commit grouping* changes. No backfill or down-migration to roll back.
- **Partial deploy safety:** helper signatures gain **defaulted** params, so a mixed state (some routes wrapped, some not) compiles and behaves per-route-independently; there is no cross-route protocol.
- **Pre-existing half-merged data** (from before KD-4) is **not** repaired by this change — survey separately with `scripts/verify-space-account-link-backfill.ts` / `scripts/correct-home-links.ts` (FD-5). Do not fold into KD-4.
- **Commit hygiene:** land as phased commits (helpers → merge → routes → tests) so any single phase can be reverted in isolation.

---

## Explicit out-of-scope (do NOT do in KD-4)

- **KD-5** — HOME uniqueness enforcement (partial-unique index / serializable isolation / advisory lock). KD-4 is only a *prerequisite enabler*. The sequential-loop guard in `manual/route.ts` stays as the interim mitigation and must not be removed.
- **Schema changes / migrations** — none. `npx prisma migrate dev` is not part of KD-4.
- **Removing dead helpers** — `ensureHomeLink`, `dualWriteFromShare`, `dualWriteFromShares` stay (additive-before-subtractive; FD-3). Thread `tx` for consistency only where trivial; no deletion.
- **Read paths** — AI assemblers, data layer, UI, snapshot generator internals: untouched.
- **`WorkspaceAccountShare` model / legacy tables** — untouched (retirement is v2.5).
- **FD-4 read-trust audit** (SAL ACTIVE vs `financialAccount.deletedAt`) — separate read-path audit; register, do not fix here.
- **Behavior changes to merge logic** — only wrapping/threading; merge decisions, ordering, and idempotency are preserved exactly.

---

## Stopping point

This is the implementation checklist. **No code has been modified.** Awaiting go-ahead to begin **Phase 0/1 only** (helper threading), validate, and return before proceeding to Phase 2.
