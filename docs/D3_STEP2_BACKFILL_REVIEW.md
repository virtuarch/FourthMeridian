# D3 Step 2 — Backfill Design Review

**Status: design only. No schema, migration, route, or application code was modified to produce this document.**

Source context: `docs/D3_SPACE_ACCOUNT_LINK_REVIEW.md` (D3 Step 1 investigation, this branch); `prisma/migrations/20260622221354_d3_space_account_link_additive/migration.sql` (the applied Step 1 migration, read directly for this report); `prisma/seed.ts` (read in full — both halves — for every count and edge case below). Governing docs: `docs/PHASE_2_ARCHITECTURE_FREEZE.md` §9.3, §16-17; `docs/PHASE_2_DECISION_MATRIX.md` D3.

**Confirmed current state** (re-verified this session, not assumed from the prior report): `SpaceAccountLinkKind` enum and `SpaceAccountLink` table exist in Postgres exactly as designed — `kind` column type `"SpaceAccountLinkKind"`, FKs `spaceId → "Workspace"`, `financialAccountId → "FinancialAccount"`, `addedByUserId/revokedByUserId → "User"`, unique on `(spaceId, financialAccountId)`. Zero references to `spaceAccountLink`/`SpaceAccountLink` anywhere in `app/`, `lib/`, or `components/` (`.ts`/`.tsx`, repo-wide grep, zero matches) — confirming the user's stated status that no route reads or writes it yet.

This report resolves D3_SPACE_ACCOUNT_LINK_REVIEW.md §6 Open Decision 1 (the HOME/SHARED collision rule) concretely, and finds one **correction** to that report's own assumption — see §1, Edge Case D. Everything else in this document is new analysis for Step 2.

---

## 1. HOME Link Strategy

**Rule:** for every `FinancialAccount` with `deletedAt IS NULL`, insert exactly one `SpaceAccountLink` row with `kind = HOME`, `spaceId` = the resolved creator's PERSONAL Space.

**Creator resolution:** `COALESCE(createdByUserId, ownerUserId)`, not `createdByUserId` alone. The schema comment at `schema.prisma:548-551` says `createdByUserId` is "set at creation time for every new FinancialAccount going forward" — true for the three production creation routes (`app/api/plaid/exchange-token/route.ts:196`, `app/api/accounts/manual/route.ts:108`, `app/api/accounts/wallet/route.ts`), confirmed by direct read of each. It is **not** true for `prisma/seed.ts`'s `createFullAccount()` helper (`:178-189`) — it sets `ownerUserId` but never `createdByUserId`. Every account in the current seed dataset therefore has `createdByUserId: NULL` even after D11. The `COALESCE` is required both for this seed-fixture gap and for the (currently zero-row, theoretical-only — no `user.delete()` call exists anywhere in `app/`) case where a user is hard-deleted and both fields go `NULL` via their `onDelete: SetNull` FKs.

**Personal-Space resolution:** the exact lookup already used in production — `db.spaceMember.findFirst({ where: { userId, status: 'ACTIVE', space: { type: 'PERSONAL' } } })`, the identical pattern at `lib/space.ts:206-209` (`resolveSpaceContext`'s fallback) and `app/api/accounts/manual/route.ts:76-79`. Reusing this exact rule means the backfill agrees with the one place in the codebase that already answers "what is this user's personal Space" today.

**Verified NOT reliably derivable as originally assumed.** D3_SPACE_ACCOUNT_LINK_REVIEW.md §5 step 3 assumed every account's creation-time `WorkspaceAccountShare` row is already in the creator's personal Space, so the HOME backfill would always be a same-row "claim," never a fresh insert. That holds for `accounts/manual/route.ts` only (`:74-79` explicitly resolves and shares into the personal Space). It does **not** hold for Plaid or wallet accounts: `app/api/plaid/exchange-token/route.ts:250-261` and `app/api/accounts/wallet/route.ts` both share into `ctx.spaceId` — whatever Space the user happened to be active in at the moment they linked the account — confirmed by reading both routes directly. A user who links a bank account while their active Space is a shared "Household" Space gets a `WorkspaceAccountShare` row into Household, not their personal Space, at creation time. **Practical effect on the backfill:** two distinct write shapes are needed, not one:

| Case | Behavior |
|---|---|
| A `WorkspaceAccountShare` row already exists at `(personalSpaceId, financialAccountId)` | Insert HOME, copying that row's `addedByUserId`/`visibilityLevel`/`status`/`revokedAt`/`revokedByUserId`/`createdAt` verbatim. This row is then excluded from the SHARED pass (§2). |
| No such row exists | Insert HOME with synthesized values: `addedByUserId = creatorUserId`, `visibilityLevel = FULL`, `status = ACTIVE`, `createdAt = financialAccount.createdAt`. No existing row is consumed; the SHARED pass is unaffected. |

Both are safe additive inserts; neither changes what any route returns (§4). The synthesized case does mean that once D3 reaches cutover (Step 4, out of scope here), the account becomes newly visible in the creator's personal Space if `getAccounts()` switches to reading `SpaceAccountLink` — worth flagging now for whoever designs cutover, not a Step 2 concern.

**Edge cases:**

- **A — creator has no resolvable PERSONAL-Space membership.** Reachable today: `DELETE /api/spaces/[id]/members/[userId]` (`app/api/spaces/[id]/members/[userId]/route.ts:93-171`) lets the OWNER of a Space self-remove (`isSelf` is allowed even for the `OWNER` role, `:119`), and the route has no `space.type === 'PERSONAL'` guard the way `archive`/`trash` do (`app/api/spaces/[id]/route.ts:88-90`, `:139-141`). A user can self-leave their own personal Space, setting that `SpaceMember` row to `LEFT`, after having already created accounts. The Plaid and wallet routes don't require a personal Space to exist at link time (they only need *some* active Space), so this is reachable for those account types even on day one for a given account; the manual route would have already 500'd at creation (`:81-83`) if no personal Space existed then, but a personal Space present *at creation* and gone *later* is still possible via the self-leave path. **Handling:** skip the HOME insert for these accounts, collect them into an exceptions list, do not abort the run. Exact count: see §3.
- **B — creator field fully NULL** (`createdByUserId` and `ownerUserId` both null). Theoretical only today — no code path sets it. Handling: same as A, skip + log.
- **C — user has more than one ACTIVE membership where `space.type = 'PERSONAL'`.** Nothing in the schema enforces "one personal Space per user" beyond the fact that only `app/api/auth/register/route.ts:98-109` ever creates a `type: PERSONAL` Space, and only for the registering user. Zero known path produces a second one. The backfill query needs a deterministic tiebreaker regardless (oldest `joinedAt`) — this mirrors `resolveSpaceContext()`'s own unordered `findFirst` (`lib/space.ts:206-209`), which has the same latent ambiguity already; D3 inherits, not introduces, this.
- **D — creation-time share not in personal Space.** Covered above; not actually an edge case requiring special-casing, just the normal-path logic.
- **E — personal Space itself archived/trashed/deleted.** Not reachable: `app/api/spaces/[id]/route.ts:88-90` and `:139-141` both explicitly reject archiving or trashing a `type: PERSONAL` Space. Once created, a personal Space is permanently live.

---

## 2. SHARED Link Strategy

**Direct mapping:** every `WorkspaceAccountShare` row not already claimed as HOME (§1) becomes one `SpaceAccountLink` row with `kind = SHARED`, copying `workspaceId→spaceId`, `financialAccountId`, `addedByUserId`, `visibilityLevel`, `status`, `revokedAt`, `revokedByUserId`, `createdAt`, `updatedAt` verbatim. No transformation.

**Conflicts:** the only "conflict" is the HOME claim itself. `WorkspaceAccountShare.@@unique([workspaceId, financialAccountId])` (`schema.prisma:714`) already guarantees at most one source row per `(space, account)` pair, and `SpaceAccountLink` carries the identical constraint (confirmed in the applied migration: `SpaceAccountLink_spaceId_financialAccountId_key`). So the mapping is naturally 1:1 with zero structural duplicate risk, provided the script inserts HOME rows before SHARED rows and excludes any `(spaceId, financialAccountId)` pair already present in `SpaceAccountLink` from the SHARED pass.

**Duplicate scenarios:** none possible from the data shape, but the script must still be safely re-runnable (a second run after a partial failure must not violate the unique constraint). Use `INSERT ... ON CONFLICT (spaceId, financialAccountId) DO NOTHING` for both passes — makes the whole script idempotent rather than relying on "don't run it twice."

**Revoked shares:** map straight across — `status = REVOKED` rows get a `SpaceAccountLink` row with `status = REVOKED` and the original `revokedAt`/`revokedByUserId`, same as an active row. This preserves history symmetry with `WorkspaceAccountShare`'s own "rows are never deleted" model and matches "`SpaceAccountLink` is informational only" (it should reflect reality, not a filtered subset of it). **Gap found:** zero `REVOKED` rows exist anywhere in `prisma/seed.ts` (confirmed — every `ShareStatus` value written by the seed script is `ACTIVE`). The dev/seed environment cannot exercise this path. Recommend manually exercising `DELETE /api/spaces/[id]/members/[userId]` once against a seeded dev DB (or directly flipping one row's status) before relying on dry-run output as a sole signal.

**Visibility levels:** copied verbatim, including the three values nothing in application code ever sets (`PRIVATE`, `SUMMARY_ONLY`, legacy `SHARED` — confirmed dead in D3_SPACE_ACCOUNT_LINK_REVIEW.md §3). No special-casing needed; both columns share the same enum type.

**Status handling:** no filtering at all — every `WorkspaceAccountShare` row, active or revoked, gets exactly one mirrored `SpaceAccountLink` row.

---

## 3. Collision Analysis

Two figures are given for every category below: an **illustrative count**, computed by direct, manual enumeration of `prisma/seed.ts` (not by running a database — this sandbox has no access to the real Preview/Production database; see note at end of section), and a **ready-to-run SQL query** to get the real number against the actual Preview DB.

Aside, low-stakes: `prisma/seed.ts:18` documents "21 accounts" but direct enumeration of the `createFullAccount()` calls counts 9 (Jane, `:428-484`) + 15 (John: 12 Plaid/wallet + 3 manual asset, `:771-871`) + 0 (Alex, no accounts) = **24**. The header comment appears stale; not used for anything load-bearing below.

| # | Category | Illustrative (seed) | Real Preview — run this |
|---|---|---|---|
| a | Account visible (ACTIVE) in 2+ non-personal Spaces — **not an actual HOME ambiguity**, only affects SHARED row count | 7 of 24 accounts: `jCreditCard`, `jDemoHysa` (Jane); `jnMortgage`, `jnHome`, `jnChecking` (3 Spaces), `jnEquipment` is single — recount confirms 5 of John's, 2 of Jane's = 7 total | see Query 1 |
| b | Creator no longer has an ACTIVE membership in any `type=PERSONAL` Space | 0 (Jane and John remain ACTIVE `OWNER` of their own personal Spaces throughout `seed.ts` — no `LEFT`/`REMOVED` `SpaceMember` rows exist in the script) | see Query 2 |
| c | Creator has no personal Space at all | 0 *affected accounts* (Alex Chen has no personal Space, confirmed `prisma/seed.ts:1405-1407`, but also owns 0 accounts, so the FinancialAccount-level count is 0 even though the User-level condition is real) | see Query 3 |
| d | Account soft-deleted/archived (`deletedAt IS NOT NULL`) | 0 (no `deletedAt` assignment anywhere in seed data) | see Query 4 |
| e | Share points at a trashed (`deletedAt IS NOT NULL`) Space | 0 (no Space in seed data has `deletedAt` set) | see Query 5 |
| f | Revoked shares (`status = REVOKED`) | 0 (see §2) | see Query 6 |
| g | Orphaned account — zero `WorkspaceAccountShare` rows at all | 0 in seed data, but **structurally possible in production**: none of the three creation routes wrap `FinancialAccount` + `AccountConnection` + `WorkspaceAccountShare` creation in a `db.$transaction` (confirmed by direct read of `accounts/manual/route.ts:104-149`, `exchange-token/route.ts`, `accounts/wallet/route.ts` — each is a sequence of independent `await`s). A crash between the account insert and the share insert leaves a real, persisted, share-less row. | see Query 7 |
| h | Account needing a *synthesized* HOME row (no existing share at the personal Space — §1's Plaid/wallet case) | 0 (every seed account is created with `spaceId: <personal space>` explicitly passed to `createFullAccount`, so seed data happens not to exercise this even though the production routes can produce it) | see Query 8 |

**Reading this table honestly:** the seed dataset, despite being large (24 accounts, 52 share rows: 24 home-position + 28 cross-space, by direct count of `createFullAccount`/`shareAccount` calls), exercises essentially none of the real risk surface — every illustrative count above is 0 except the benign category (a). This is a property of how the seed script was written (always shares into the personal Space first, never simulates membership churn or revocation), not evidence that these cases don't matter. The SQL below is what actually answers this requirement; treat the table's left column as "what a developer testing locally today would see," not as a substitute for running the right column against Preview.

### Ready-to-run SQL (Preview DB)

```sql
-- Query 1: accounts visible in 2+ non-personal Spaces (category a — informational, not a true collision)
WITH creator AS (
  SELECT fa.id AS facct_id, COALESCE(fa."createdByUserId", fa."ownerUserId") AS creator_id
  FROM "FinancialAccount" fa WHERE fa."deletedAt" IS NULL
),
home AS (
  SELECT c.facct_id, ps."personalSpaceId"
  FROM creator c
  LEFT JOIN LATERAL (
    SELECT wm."workspaceId" AS "personalSpaceId"
    FROM "WorkspaceMember" wm JOIN "Workspace" w ON w.id = wm."workspaceId"
    WHERE wm."userId" = c.creator_id AND wm.status = 'ACTIVE' AND w.type = 'PERSONAL'
    ORDER BY wm."joinedAt" ASC LIMIT 1
  ) ps ON true
)
SELECT was."financialAccountId", COUNT(*) AS non_home_active_shares
FROM "WorkspaceAccountShare" was
JOIN home h ON h.facct_id = was."financialAccountId"
WHERE was.status = 'ACTIVE' AND was."workspaceId" IS DISTINCT FROM h."personalSpaceId"
GROUP BY was."financialAccountId"
HAVING COUNT(*) > 1;

-- Query 2: creators with no ACTIVE personal-Space membership, who still have ≥1 account
SELECT DISTINCT COALESCE(fa."createdByUserId", fa."ownerUserId") AS creator_id
FROM "FinancialAccount" fa
WHERE fa."deletedAt" IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM "WorkspaceMember" wm JOIN "Workspace" w ON w.id = wm."workspaceId"
    WHERE wm."userId" = COALESCE(fa."createdByUserId", fa."ownerUserId")
      AND wm.status = 'ACTIVE' AND w.type = 'PERSONAL'
  );

-- Query 3: same as Query 2 — "no personal Space" and "creator no longer active in it" collapse to the
-- same predicate (NOT EXISTS an ACTIVE PERSONAL membership). Kept as separate rows above because they
-- describe different real-world causes (never had one vs. left one), but the check is identical.

-- Query 4: soft-deleted accounts
SELECT COUNT(*) FROM "FinancialAccount" WHERE "deletedAt" IS NOT NULL;

-- Query 5: ACTIVE shares pointing at trashed Spaces
SELECT was.* FROM "WorkspaceAccountShare" was
JOIN "Workspace" w ON w.id = was."workspaceId"
WHERE was.status = 'ACTIVE' AND w."deletedAt" IS NOT NULL;

-- Query 6: revoked shares
SELECT COUNT(*) FROM "WorkspaceAccountShare" WHERE status = 'REVOKED';

-- Query 7: orphaned accounts (zero WorkspaceAccountShare rows)
SELECT fa.id FROM "FinancialAccount" fa
LEFT JOIN "WorkspaceAccountShare" was ON was."financialAccountId" = fa.id
WHERE fa."deletedAt" IS NULL AND was.id IS NULL;

-- Query 8: accounts requiring a synthesized (non-copied) HOME row
WITH creator AS (
  SELECT fa.id AS facct_id, COALESCE(fa."createdByUserId", fa."ownerUserId") AS creator_id
  FROM "FinancialAccount" fa WHERE fa."deletedAt" IS NULL
),
home AS (
  SELECT c.facct_id, ps."personalSpaceId"
  FROM creator c
  LEFT JOIN LATERAL (
    SELECT wm."workspaceId" AS "personalSpaceId"
    FROM "WorkspaceMember" wm JOIN "Workspace" w ON w.id = wm."workspaceId"
    WHERE wm."userId" = c.creator_id AND wm.status = 'ACTIVE' AND w.type = 'PERSONAL'
    ORDER BY wm."joinedAt" ASC LIMIT 1
  ) ps ON true
)
SELECT h.facct_id
FROM home h
LEFT JOIN "WorkspaceAccountShare" was
  ON was."financialAccountId" = h.facct_id AND was."workspaceId" = h."personalSpaceId"
WHERE h."personalSpaceId" IS NOT NULL AND was.id IS NULL;
```

**No path to real counts from this sandbox.** `.env`/`.env.local` here only contain local Docker Postgres credentials; no Supabase/Preview `DATABASE_URL` is present in this checkout (correctly excluded from source control). Run the eight queries above directly against Preview (`psql`, Prisma Studio's query tab, or a one-off script) to get the real numbers before backfilling.

---

## 4. Backfill Safety

**No user-visible behavior change.** Confirmed by re-grep this session: zero occurrences of `spaceAccountLink`/`SpaceAccountLink` in `app/`, `lib/`, or `components/`. The only three read paths for account visibility — `getAccounts()` and `getHoldings()` (`lib/data/accounts.ts:30-45`, `:115-128`) and `GET /api/spaces/[id]/accounts` — all query `WorkspaceAccountShare` exclusively. A backfill script that only `INSERT`s into `SpaceAccountLink` cannot change what any of them return, because nothing reads the table it writes to.

**`WorkspaceAccountShare` remains source of truth.** The backfill plan contains zero `UPDATE`/`DELETE` statements against `WorkspaceAccountShare` — every row stays exactly as it is. `SpaceAccountLink` is a read-only mirror at this stage, never the other direction.

**`SpaceAccountLink` is informational only.** Not read by any route, not serialized in any API response, not referenced by any type in `types/` or any Zod schema (consistent with the zero-grep-hits finding above).

**Rollback remains simple.** The table is empty before this step and read by nothing. Rollback is a data-only operation (`DELETE FROM "SpaceAccountLink"`), with no cascading impact on any other table and no migration to revert.

---

## 5. Validation Plan

### SQL checks

```sql
-- 1. Every active FinancialAccount has exactly one HOME link
--    (exclude any account intentionally skipped per §1 Edge Cases A/B — see exceptions list)
SELECT fa.id
FROM "FinancialAccount" fa
WHERE fa."deletedAt" IS NULL
  AND (SELECT COUNT(*) FROM "SpaceAccountLink" sal
       WHERE sal."financialAccountId" = fa.id AND sal.kind = 'HOME') != 1;
-- Expect: 0 rows (minus documented exceptions)

-- 2. No duplicate HOME links for the same account across different Spaces
--    NOTE: the DB unique constraint is (spaceId, financialAccountId) — it does NOT prevent two
--    different spaceIds from both holding a HOME row for the same financialAccountId. This is
--    application-level-only today (schema.prisma:153-159 says so explicitly). This query is the
--    only thing actually enforcing "exactly one HOME per account" post-backfill.
SELECT "financialAccountId", COUNT(*) AS home_count
FROM "SpaceAccountLink" WHERE kind = 'HOME'
GROUP BY "financialAccountId" HAVING COUNT(*) > 1;
-- Expect: 0 rows

-- 3. SHARED links match WorkspaceAccountShare — every share row has a corresponding link row
SELECT was.id FROM "WorkspaceAccountShare" was
LEFT JOIN "SpaceAccountLink" sal
  ON sal."spaceId" = was."workspaceId" AND sal."financialAccountId" = was."financialAccountId"
WHERE sal.id IS NULL;
-- Expect: 0 rows

-- 3b. Field-level drift (status/visibilityLevel copied incorrectly)
SELECT was.id FROM "WorkspaceAccountShare" was
JOIN "SpaceAccountLink" sal
  ON sal."spaceId" = was."workspaceId" AND sal."financialAccountId" = was."financialAccountId"
WHERE was.status IS DISTINCT FROM sal.status
   OR was."visibilityLevel" IS DISTINCT FROM sal."visibilityLevel";
-- Expect: 0 rows

-- 4. Orphaned/logically-stale links — link points at a since-soft-deleted account
--    (FK constraints make a literally dangling financialAccountId impossible; this catches the
--    "account was archived after the link was written" case instead)
SELECT sal.id FROM "SpaceAccountLink" sal
JOIN "FinancialAccount" fa ON fa.id = sal."financialAccountId"
WHERE fa."deletedAt" IS NOT NULL;
-- Expect: 0 immediately after backfill; non-zero later is normal (account archived after the fact)
-- and does not need cleanup, since the link is informational-only.
```

### Application checks

Write `scripts/verify-space-account-link-backfill.ts` (companion to the backfill script, same repo location) performing the same four checks via Prisma (`db.financialAccount.count()` / `groupBy`) instead of raw SQL, so the logic is type-checked against the live schema and runnable without a `psql` session. Print a pass/fail summary per check; non-zero exit code on any failure so it can gate a CI step later if desired.

---

## 6. Rollback Plan

The table is additive, currently empty, and read by nothing (§4) — rollback is strictly data-level, not schema-level:

1. **Full wipe:** `DELETE FROM "SpaceAccountLink";` (or `TRUNCATE` — `id` is a `cuid()` text column, not a sequence, so `RESTART IDENTITY` is a no-op either way). Safe at any time; no other table is touched by a `SpaceAccountLink` delete (nothing references it via FK).
2. **Partial-failure handling:** if a run is interrupted partway, do not attempt to patch the partial state — wipe (step 1) and re-run the corrected script from scratch. The script is designed to be idempotent (`ON CONFLICT DO NOTHING`, §2), so a full re-run after a wipe is always safe and cheap at this row count (tens to low thousands of rows in Preview, by the same order of magnitude as `WorkspaceAccountShare`'s own row count).
3. **Out of scope for this rollback:** reverting Step 1 itself (dropping the `SpaceAccountLink` table/`SpaceAccountLinkKind` enum). That migration is already applied and not being revisited here; a schema-level rollback would be a separate, explicitly-approved decision, not a consequence of a bad backfill run.

---

## 7. Implementation Checklist

Exact sequence for whoever implements this next (not yet approved to execute — see closing note):

1. Confirm no pending migrations (`npx prisma migrate status`) — Step 2 needs no new migration; the table and enum already exist from Step 1.
2. Write `scripts/backfill-space-account-link.ts` (new `scripts/` directory — none exists yet in this repo):
   - Resolve `creatorUserId = COALESCE(createdByUserId, ownerUserId)` per `FinancialAccount` (§1).
   - Resolve personal Space per creator via the `lib/space.ts:206-209` pattern, oldest `joinedAt` as tiebreaker (§1, Edge Case C).
   - Skip + log accounts matching Edge Cases A/B into an in-memory exceptions list; never throw, never abort the run for an individual bad row.
   - Insert HOME rows: copy from the matching `WorkspaceAccountShare` row at `(personalSpaceId, financialAccountId)` if one exists, else synthesize (§1 table). Use `ON CONFLICT (spaceId, financialAccountId) DO NOTHING`.
   - Insert SHARED rows for every remaining `WorkspaceAccountShare` row not already claimed as HOME, copying fields verbatim (§2). Same `ON CONFLICT DO NOTHING`.
   - Support `--dry-run` (compute and print counts/exceptions, zero writes) and `--verbose`.
   - Write the companion `scripts/verify-space-account-link-backfill.ts` (§5) alongside it.
3. `npx tsc --noEmit` and `npm run lint` — no schema change in this step, so `prisma generate`/`migrate dev` are not required; these two checks are the relevant gate per the project's working style.
4. Run `npx tsx scripts/backfill-space-account-link.ts --dry-run` against Preview. Compare its printed counts against the eight queries in §3 run on the same database — they must agree exactly before proceeding.
5. **Stop for explicit approval** before any write — per the project's working style, this checklist itself is not authorization to execute it.
6. Run for real: `npx tsx scripts/backfill-space-account-link.ts` against Preview.
7. Run all of §5's SQL checks plus `verify-space-account-link-backfill.ts` against Preview. All must return zero offending rows, excluding the documented exceptions list from step 2.
8. Spot-check in Prisma Studio: one manual account, one Plaid account, one wallet account, and one account from each §3 category that had ≥1 real (non-zero) occurrence in Preview.
9. On any validation failure: rollback (§6), fix the script, return to step 4. Do not proceed to dual-write.
10. On success: replace this document's illustrative §3 counts with the real Preview counts in a short follow-up note, and stop. Dual-write (D3 Step 3) and cutover (D3 Step 4) are separate, later checklists requiring their own approval, per "do not implement all decisions in one branch or one commit."

---

No code, schema, or migration changes were made in producing this document. Stopping here per instruction.
