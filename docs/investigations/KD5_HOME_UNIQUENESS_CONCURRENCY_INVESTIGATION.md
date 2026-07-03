> **INVESTIGATION — read-only.** No code, schema, migration, or STATUS.md changes were made producing this document. For current project status see `STATUS.md` at the repository root.

# KD-5 — HOME Uniqueness Under Concurrency: Investigation

**Scope:** KD-5 only — enforcement of the "exactly one HOME `SpaceAccountLink` per `FinancialAccount`" invariant under concurrent writes. This is investigation and recommendation only; no implementation. KD-4 (multi-table SAL write atomicity) is already fixed & committed and is referenced only where it interacts.

**Branch:** `feature/phase-2-architecture` · **Baseline:** v2.4.0+ (`v2.4.0-13-g297bdf4`)

---

## 1. Impact map

| Area | File / symbol | Role in KD-5 |
|---|---|---|
| Invariant owner | `prisma/schema.prisma` — `SpaceAccountLinkKind` enum doc (`~L190-200`), `SpaceAccountLink` model (`~L909-932`) | Declares "exactly one HOME per `financialAccountId`" but only as a comment. DB has `@@unique([spaceId, financialAccountId])` — **not** keyed on `kind`. No partial index. |
| Decision logic | `lib/accounts/space-account-link.ts` → `computeLinkKind()` (`L130-151`) | The count-then-write that decides HOME vs SHARED. **Root cause.** Called by every write helper. |
| Write helper | same file → `dualWriteSpaceAccountLink()` (`L169-204`), `dualWriteFromShare(s)` (`L212-267`) | Wraps `computeLinkKind()` + `upsert`. All HOME/SHARED assignment funnels here. |
| Write path — manual create | `app/api/accounts/manual/route.ts` (`L146-164`) | Fans links across `[personalSpaceId, ...additionalIds]`. **Intra-request race already mitigated** (sequential `for` loop inside a KD-4 `db.$transaction`). |
| Write path — wallet | `app/api/accounts/wallet/route.ts` (`L67, L141, L213`) | Account create / link. Single target per call. |
| Write path — Plaid import | `lib/plaid/exchangeToken.ts` (`L330`) | One SAL write per imported account, inside a per-account `tx`. `faId` is **resolved** (fingerprint/provider identity), so two requests can target the same existing account. |
| Write path — share | `app/api/spaces/[id]/accounts/share/route.ts` POST (`L79`) | Single-target upsert of an existing account into one space, inside a `tx`. |
| Write path — merge | `lib/accounts/reconcile.ts` → `mergeArchivedDuplicateIntoCanonical()` (`L482-503`) | Re-points loser links onto the winner; loop recomputes `kind`, so the winner's first re-pointed link can become HOME. |
| Non-`kind` writes (state only) | share DELETE / revoke (`share/route.ts:173`), member revoke (`spaces/[id]/members/[userId]/route.ts:147`), archive/restore (`accounts/[id]/route.ts:173`, `accounts/[id]/restore/route.ts:161`, `accounts/manual/[id]*`), permanent delete (`accounts/manual/[id]/permanent/route.ts` → `dualDeleteSpaceAccountLinks`) | Never create HOME, but change/remove rows — relevant because `computeLinkKind` counts **all** rows regardless of status, and hard-delete can return an account to the zero-row precondition. |
| Detection tooling | `scripts/verify-space-account-link-backfill.ts` — **CHECK 2** (`L119-122`) | Already enumerates accounts with >1 HOME via `groupBy`. Reusable as the KD-5 pre-flight gate. |
| Prior data-correction | `scripts/correct-home-links.ts` | HOME *semantics* correction (personal-space synthesized rows). Not a duplicate-HOME deduper, but the promote-one / adjust-rest pattern is the template for cleanup. |
| Migrations | `prisma/migrations/` | A new raw-SQL migration is the delivery vehicle for the fix (see §5–§6). |

---

## 2. Current behavior

The invariant is **application-enforced only**. `computeLinkKind(spaceId, financialAccountId)`:

1. `count(*)` of `SpaceAccountLink` rows for `financialAccountId` — **status-agnostic** (revoked rows count). If `0` → `HOME`.
2. Else, if an existing `HOME` row is at this same `spaceId` → `HOME` (idempotent re-assert).
3. Else → `SHARED`.

The only DB constraint is `@@unique([spaceId, financialAccountId])`, which prevents duplicate *rows per (space, account) pair* but places **no limit on how many rows carry `kind = HOME`** across different spaces. The enum doc comment states this explicitly: *"Not yet enforced by a DB constraint — Prisma has no partial-unique-index syntax, so this invariant is application-level only."*

Two mitigations exist, both **insufficient for KD-5**:

- **Sequential loop** in manual-create (D3 stabilization): serializes the multiple writes *within one request* so `personalSpaceId` commits HOME first. Gives zero protection across separate requests.
- **KD-4 transaction wrapping**: makes each caller's multi-table write group atomic. But under Postgres' default `Read Committed`, two *separate* transactions each still see `count = 0` and both write HOME. KD-4's own docs call it a *prerequisite enabler*, not a fix (`docs/investigations/KD4_...INVESTIGATION.md` §6.5).

`STATUS.md` (L140) records KD-5 as **Open**, High severity, targeted v2.4.5.

---

## 3. Race condition proof

**Isolation:** Postgres default `Read Committed`. **Precondition:** an account with **zero** `SpaceAccountLink` rows (because step 1 counts all rows including revoked, the precondition is a genuinely link-less account — see triggers below).

Two concurrent transactions, same `financialAccountId = X`, distinct spaces `A ≠ B`:

```
T1 (write at space A)                     T2 (write at space B)
--------------------------------          --------------------------------
BEGIN                                      BEGIN
count(*) SAL where faId=X  -> 0
                                          count(*) SAL where faId=X  -> 0   -- T1's insert not yet committed → invisible
kind := HOME                              kind := HOME
upsert (A, X) kind=HOME
                                          upsert (B, X) kind=HOME           -- (B,X) ≠ (A,X): unique(spaceId,faId) NOT violated
COMMIT                                     COMMIT
--------------------------------------------------------------------------
RESULT: two rows with kind=HOME for account X  → invariant violated
```

`upsert` is keyed on `(spaceId, financialAccountId)`, so with `A ≠ B` neither insert conflicts and both succeed. The existing unique index cannot catch this because it does not include `kind`.

**Why the existing mitigations don't help:**
- The sequential loop only orders writes inside a *single* request; T1 and T2 here are different requests.
- KD-4's `db.$transaction` does not serialize the two counts: under `Read Committed` each `count()` reads a snapshot in which the other transaction's uncommitted insert is invisible. Even `Repeatable Read` would not help — there is no existing row to produce a write-write conflict on an *insert of a new predicate*. Only `Serializable` (SSI) would abort one transaction, or a real constraint / lock.

**Concrete triggers present in this codebase (precondition reachable):**
1. **Double-submitted / retried Plaid connect** — `exchangeToken` resolves an existing `faId` via fingerprint/provider identity; two near-simultaneous imports of the same institution account, each carrying a different active `spaceId`, both see zero links. (Same-space collapses via upsert; different-space produces dual HOME.)
2. **Concurrent share of a legacy / un-backfilled account** (zero SAL rows) into two different spaces via the share route.
3. **Concurrent merge** (`reconcile`) re-pointing loser links onto a winner that currently has zero links, racing another writer for that winner.
4. **Hard-delete then re-add** — `dualDeleteSpaceAccountLinks` removes all rows, returning the account to the zero-row precondition for a subsequent concurrent re-share.

KD-4's checklist already carries this as a **documented xfail** ("two concurrent first-links still able to produce ≥2 HOME rows after KD-4"), confirming the race is understood and intentionally left for KD-5.

---

## 4. Is a partial unique index needed? Can Prisma express it?

**Needed:** Yes. Serializing within a request (done) and wrapping in a transaction (done) do not close a cross-request insert race on a predicate. The durable options are (a) a **partial unique index** `WHERE kind = 'HOME'`, (b) `Serializable` isolation on every HOME-writing path, or (c) a Postgres **advisory lock** keyed on `financialAccountId`. Option (a) is the smallest, always-on, defense-in-depth fix: it makes the invariant a DB truth independent of application code, and every future write path inherits it for free. (b) is heavy and easy to regress (one un-migrated path reintroduces the bug); (c) adds lock-management complexity and only protects paths that remember to take the lock. **Recommend (a).**

**Prisma expressibility:** **No.** Prisma schema has no syntax for a filtered/partial index — `@@unique`/`@@index` cannot carry a `WHERE`. Therefore a **raw-SQL migration is required**:

```sql
CREATE UNIQUE INDEX "SpaceAccountLink_one_home_per_account"
  ON "SpaceAccountLink" ("financialAccountId")
  WHERE "kind" = 'HOME';
```

Delivery technique (Prisma-safe, drift-free):
- Scaffold with `npx prisma migrate dev --create-only`, then hand-write the `CREATE UNIQUE INDEX ... WHERE` into that migration's `migration.sql`. The repo already hand-writes raw SQL in migrations (e.g. the D11 and `financial_account_tables` migrations contain `UPDATE ... WHERE` blocks), so this is an established pattern.
- Because the statement lives in a migration file, it is replayed into Prisma's **shadow DB** on every `migrate dev`, so subsequent runs see **no drift** and Prisma will **not** try to drop the unmanaged index.
- Keep the schema's enum doc comment (already present) as the human-readable pointer; optionally update its wording to "now enforced by partial unique index `SpaceAccountLink_one_home_per_account`." No structural schema change and no Prisma Client shape change result, so `prisma generate` is a no-op for types.
- Known, acceptable caveat: `prisma db pull` will not round-trip the partial index, and `prisma migrate diff` against a live DB may list it as an unmanaged index. Expected for partial indexes; not a blocker.

**Predicate decision to settle first:** `computeLinkKind` is status-agnostic, so the index should be too — `WHERE kind = 'HOME'` (covering ACTIVE *and* REVOKED HOME rows), matching the count logic. This means at most **one row ever** may carry `kind = HOME` per account, including revoked ones. That is consistent with current revoke behavior (revoke changes `status`, never `kind`), but it must be verified against live data before applying (see §5) because a revoked-HOME plus a later re-homed HOME would collide.

---

## 5. Cleanup / backfill required before the constraint

`CREATE UNIQUE INDEX` **fails outright** if any account already violates the predicate. Two pre-flight conditions:

1. **No account with >1 HOME row.** Detection already exists — `scripts/verify-space-account-link-backfill.ts` CHECK 2. Equivalent SQL:
   ```sql
   SELECT "financialAccountId", count(*)
   FROM "SpaceAccountLink"
   WHERE "kind" = 'HOME'
   GROUP BY "financialAccountId"
   HAVING count(*) > 1;
   ```
2. **No account with a revoked HOME coexisting with another HOME** (only relevant to the status-agnostic predicate chosen in §4).

If either returns rows, a **dedupe/backfill step** is required *before* the migration:
- Choose the canonical HOME per account — earliest `createdAt` / true owning space, the same heuristic `correct-home-links.ts` uses.
- **Demote** the extra HOME rows to `SHARED` (do **not** delete — they may be legitimate shares). This is additive-before-subtractive and reversible.
- A dedicated script (`scripts/dedupe-home-links.ts`, mirroring `correct-home-links.ts`'s dry-run/verbose/idempotent structure) should perform this; run `--dry-run` first, then live, then re-run CHECK 2 to confirm zero.

This cleanup is a **separate, prior step** from the migration and must be green before the index is created.

---

## 6. Files / migrations likely affected (implementation phase — not this task)

- **New:** `prisma/migrations/<timestamp>_kd5_home_partial_unique_index/migration.sql` — the raw-SQL partial unique index.
- **New:** `scripts/dedupe-home-links.ts` (+ dry-run) — duplicate-HOME cleanup, if pre-flight finds any.
- **Edit (small, recommended):** `lib/accounts/space-account-link.ts` — teach `dualWriteSpaceAccountLink` / `computeLinkKind` to catch the unique-violation (`P2002`) on a HOME insert and retry the row as `SHARED` (graceful "someone else won the HOME race"), rather than surfacing a 500. Optional alternative/addition: advisory lock on `financialAccountId` around the count+write.
- **Edit (doc only):** `prisma/schema.prisma` enum comment — note the constraint is now enforced. No structural change.
- **Reused:** `scripts/verify-space-account-link-backfill.ts` — pre-flight and post-migration gate.
- **Deferred:** `STATUS.md` — flip KD-5 to Fixed once shipped (explicitly out of scope here).

Per project rules this must be its **own branch/commit**, not bundled with any other decision, and staged: **(1)** cleanup script + CHECK 2 green → **(2)** raw-SQL migration → **(3)** code `P2002`→SHARED handling.

---

## 7. Rollback plan

- **Migration:** single statement, no data change —
  ```sql
  DROP INDEX "SpaceAccountLink_one_home_per_account";
  ```
  Purely additive constraint; dropping it restores prior behavior exactly.
- **Code (`P2002`→SHARED retry):** harmless if the index is absent — the branch simply never fires. Safe to leave in place or revert independently.
- **Cleanup script demotions:** the only real data change. The dedupe script must log every `(spaceId, financialAccountId)` it demoted from HOME→SHARED so the set is reversible; keep the dry-run output as the record.
- **Sequencing for rollback:** drop index → (optionally) revert code retry → restore demoted rows from the logged set if a full revert is wanted. No `FinancialAccount` or `WorkspaceAccountShare` data is touched at any point.

---

## 8. Validation checklist (for the implementation step)

- [ ] Pre-flight: `npx tsx scripts/verify-space-account-link-backfill.ts --verbose` → **CHECK 2 PASS** (zero duplicate-HOME) and no revoked/active HOME coexistence. If not, run dedupe script `--dry-run`, review, run live, re-verify.
- [ ] `npx prisma generate` — no client/type change expected (no-op for shapes).
- [ ] `npx prisma migrate dev` — applies the raw-SQL partial index; **re-run once more** to confirm the shadow DB shows **no drift** and Prisma does not attempt to drop the index.
- [ ] `npx tsc --noEmit` — clean.
- [ ] `npm run lint` — clean (allow only the known pre-existing `no-img-element` warnings).
- [ ] **Concurrency test (the KD-4 xfail, now expected PASS):** fire two simultaneous first-link writes for the same `faId` at two different spaces → exactly one HOME row; the loser resolves to SHARED (or fails gracefully with the retry handler), never two HOMEs.
- [ ] Regression: manual create, wallet create, Plaid import, share, and merge each still produce exactly one HOME and correct SHARED rows.
- [ ] Confirm `CREATE UNIQUE INDEX` completed without error (i.e., pre-flight data was genuinely clean).
- [ ] Post-migration: re-run CHECK 2 → still PASS.

---

## 9. Final recommendation

KD-5 is a **real, currently-open** defect: the "one HOME per account" invariant lives only in `computeLinkKind`'s count-then-write, which two concurrent transactions can both pass under `Read Committed`, producing duplicate HOME rows. The sequential-loop and KD-4 transaction work were prerequisites and interim guards — neither closes the cross-request race.

**Adopt the partial unique index** `ON "SpaceAccountLink"("financialAccountId") WHERE "kind" = 'HOME'` as the minimal, always-on fix. Prisma cannot express it, so ship it as a **hand-written raw-SQL migration** using the `--create-only` technique (drift-free via the shadow DB). Gate it behind a **duplicate-HOME cleanup** (detection already exists in CHECK 2; add a demote-extras dedupe script) and pair it with a small **`P2002`→SHARED** handler in `dualWriteSpaceAccountLink` so the loser of a race degrades gracefully instead of erroring. Rollback is a one-line `DROP INDEX` with no data impact.

Deliver as its **own branch/commit**, staged cleanup → migration → code, per the Phase 2 working rules. Severity High but blast radius small and rollback cheap — this is low-risk to land once the pre-flight is green.

**Recommended next deliverable:** a D11-style implementation checklist for KD-5 (cleanup script → migration → code handler → validation), for approval before any code/schema/migration change.
