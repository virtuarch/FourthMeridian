# v2.5-A Phase 0 — Seam Retirement Readiness Audit

**Status:** Investigation only — no code, no schema, no migrations. Awaiting approval + count-gate results.
**Date:** 2026-07-03
**Branch:** `feature/v2.5-spaces-completion` (HEAD `232f7f7`, KD-19 committed)
**Parent doc:** `docs/investigations/V25A_SEAM_CLOSURE_INVESTIGATION.md` (pre-KD-19). This audit re-verifies its findings post-KD-19 and adds the items it missed.
**Scope:** WorkspaceAccountShare (WAS) retirement readiness · legacy `Account` retirement readiness · deletion inventory · migration order · rollback · validation · phases.

---

## 1. Question-by-question findings

### Q1 — Do Holding rows still reference Account?

**Code:** yes, structurally. `Holding.accountId` FK is live in schema (`prisma/schema.prisma:1134`), and `getHoldings()` keeps a legacy read branch (`lib/data/accounts.ts:212` — `where: { accountId: { not: null }, account: { spaceId } }`).

**Writes:** none at runtime. Every runtime holding write uses `financialAccountId` (`lib/plaid/refresh.ts:255,268`; `lib/plaid/exchangeToken.ts:411,423`). The only code writing `Holding.accountId` is `prisma/seed.ts:529-543` and the **dead** helper `lib/sync/computeCashResidual.ts` (zero callers — verified by grep; missed by the parent investigation).

**Data:**
- **Dev: non-zero by construction.** `seed.ts` anchors all seeded holdings to legacy `acct.id`. Any seeded dev DB fails the gate until the seed is rewritten. (Mitigating detail: seed creates each `FinancialAccount` with `id: acct.id` — the same id — so a dev re-anchor is a trivial column copy.)
- **Prod: unknown from code — this is the gate.** Cannot be answered from the repo; requires the read-only queries in §2. Whether the D11 chain re-anchored pre-migration rows is exactly what the counts resolve.

### Q2 — Do Transaction rows still reference Account?

Same shape. `Transaction.accountId` FK live (`schema:1176`); legacy OR-arms read it at `lib/ai/assemblers/transactions.ts:215,938`, `lib/data/transactions.ts`, and `app/api/accounts/[id]/transactions/route.ts`. No runtime writes set it (Plaid sync writes `financialAccountId`; import pipeline writes `financialAccountId`). Seed anchors ~360 dev transactions to legacy `accountId`. Prod counts unknown — gated on §2.

### Q3 — Does production runtime still depend on Account IDs?

Four accessors, unchanged post-KD-19, all reads, all benign:

| # | Site | What | Breakage if Account vanished without cleanup |
|---|---|---|---|
| L1 | `app/admin/page.tsx:56` | `db.account.count()` | Admin page crashes |
| L2 | `app/api/admin/overview/route.ts:73` | `db.account.count()` | Admin API 500s |
| L3 | `app/api/accounts/[id]/transactions/route.ts:30` | existence fallback when no SAL link | Route errors on legacy ids |
| L4 | `lib/imports/authorize.ts:74` | existence fallback → 400 | Import auth errors |

Plus the legacy **read branches** (Q1/Q2 sites) and the schema relations `User.ownedAccounts` (:328), `Space.accounts` (:396), `PlaidItem.accounts` (:542). No runtime creates/updates/deletes of `Account` exist anywhere (`grep account.create|update|delete` → seed only).

### Q4 — Can WorkspaceAccountShare be removed today?

**Code-wise: yes.** Zero runtime reads or writes in `app/`, `lib/`, `jobs/` — re-verified post-KD-19; every app/lib match is a comment. Actual client calls exist only in:

- `prisma/seed.ts:201,231,280` (create ×2, deleteMany)
- `scripts/backfill-space-account-link.ts:170,214`
- `scripts/correct-home-links.ts:110,141,235`
- `scripts/verify-space-account-link-backfill.ts:125`

**Gates before the drop:** (a) seed rewritten first, (b) one final GREEN run of the backfill-verification scripts against prod (confirms no un-mirrored WAS row), (c) `pg_dump` of the table attached to the PR.

**One coupling the parent doc under-weighted — `VisibilityLevel.SHARED`:** the enum value is documented as "kept for backward compat with **Account** (legacy) rows" (`schema:180`). If legacy `Account` survives Phase 5 (likely — see Q1), `Account.visibilityLevel` may still hold `SHARED` rows, so the enum value **cannot be removed with the WAS drop**; it is coupled to the *Account* retirement, not the WAS retirement. Additionally, Postgres cannot drop an enum value in place — Prisma will generate a type-recreate + column-cast migration. **Recommendation: split the parent plan's Phase 4c — drop the WAS model + 4 relations now; move `SHARED` enum-value removal into Phase 5 (Account drop), gated on a zero-`SHARED` audit across both `SpaceAccountLink` AND `Account`.** `ShareStatus` stays regardless (SAL uses it).

### Q10 — What breaks unexpectedly if either model disappeared?

1. `prisma db seed` — compiles against WAS *and* creates legacy `Account` rows (seed breaks on either drop until rewritten).
2. The three WAS scripts — compile errors; archive after final green run.
3. `lib/sync/computeCashResidual.ts` — dead, but uses `db.holding as any`, so **`tsc` will NOT catch** its reference to the removed `accountId_symbol` unique; it must be deleted explicitly, not left to the compiler.
4. Admin dashboards (L1/L2) — runtime crash, not compile-time-obvious if accessors are missed.
5. `@@unique([accountId, symbol])` on Holding disappears with the FK — anything relying on that upsert shape (only computeCashResidual; dead) must go in the same commit.
6. Prisma's auto-generated down-migration for the `SHARED` enum recreate is unreliable — hand-verify before applying.
7. Snapshot regeneration (`lib/snapshots/regenerate.ts`) consumes `getAccounts()`; if legacy-anchored holdings/transactions are dropped while rows still exist (gate violated), net-worth totals silently change. The Phase 6 "totals unchanged" check is the tripwire.
8. Comments in ~18 files reference WAS — cosmetic, but truth-up (Phase 3) keeps the drop commit purely mechanical.

Non-issues verified: `lib/mock-data.ts` / `lib/widget-registry.ts` / `app/(shell)/dashboard/holdings/page.tsx` use `accountId` as a normalized UI field, not the Prisma FK; all Plaid identity lookups run through `FinancialAccount`/`ProviderAccountIdentity`.

---

## 2. Count gates (Q1/Q2/Q3 data half — must be run before any subtractive work)

> **Update 2026-07-03:** gates are now scripted — read-only, no writes:
> `npx tsx scripts/phase0-seam-gates.ts` (dev) · `DATABASE_URL=<prod-url> npx tsx scripts/phase0-seam-gates.ts` (prod).
> The script also checks WAS→SAL mirror *drift* (status/visibility disagreement on mirrored pairs), which the raw Gate D below does not.
> SAL's physical column is `spaceId` (verified against `20260622221354_d3_space_account_link_additive/migration.sql`) — the Gate D SQL below is corrected accordingly.

Reference SQL (equivalent to the script), read-only:

```sql
-- Gate A: legacy-anchored holdings
SELECT COUNT(*) FROM "Holding" WHERE "accountId" IS NOT NULL AND "financialAccountId" IS NULL;
-- Gate B: legacy-anchored transactions
SELECT COUNT(*) FROM "Transaction" WHERE "accountId" IS NOT NULL AND "financialAccountId" IS NULL;
-- Gate C: legacy Account rows
SELECT COUNT(*) FROM "Account";
SELECT COUNT(*) FROM "Account" WHERE "deletedAt" IS NULL;
-- Gate D: WAS rows not mirrored into SAL (must be 0 before WAS drop)
SELECT COUNT(*) FROM "WorkspaceAccountShare" was
WHERE NOT EXISTS (SELECT 1 FROM "SpaceAccountLink" sal
  WHERE sal."spaceId" = was."workspaceId"              -- SAL column is "spaceId" (no @map)
    AND sal."financialAccountId" = was."financialAccountId");
-- Gate E: SHARED enum residue (blocks enum-value removal, not the WAS model drop)
SELECT COUNT(*) FROM "SpaceAccountLink" WHERE "visibilityLevel" = 'SHARED';
SELECT COUNT(*) FROM "Account" WHERE "visibilityLevel" = 'SHARED';
```

Also re-run `scripts/audit-visibility-levels.ts` for the SAL audit.

**Decision rule:** Gates A–C zero in prod → Phase 5 (Account drop) is in-scope for v2.5-A. Any non-zero → Phase 5 deferred (§5). Gate D zero → Phase 4 (WAS drop) proceeds. Gate E non-zero on `Account` → `SHARED` enum removal rides with Phase 5 regardless.

---

## 3. Exact deletion inventory

### 3.1 WAS retirement (Phase 4)

| Item | Location |
|---|---|
| `model WorkspaceAccountShare` | `schema:876-897` |
| `FinancialAccount.workspaceShares` relation | `schema:~770` |
| `User.addedShares` / `User.revokedShares` | `schema:351-352` |
| `Space.accountShares` | `schema:406` |
| Seed WAS writes (rewrite to SAL-only) | `seed.ts:201,231,280` + helper at `225-244` |
| Scripts (archive after final green run) | `backfill-space-account-link.ts`, `correct-home-links.ts`, `verify-space-account-link-backfill.ts`, `audit-visibility-levels.ts` (WAS arms) |
| WAS comments (truth-up, pre-drop) | ~18 files in `app/`, `lib/` |
| **NOT deleted:** `ShareStatus` enum (SAL uses it); `SHARED` enum value (coupled to Account, §1-Q4) | — |

### 3.2 Legacy Account retirement (Phase 5 — conditional on Gates A–C)

| Item | Location |
|---|---|
| Accessors L1–L4 | `app/admin/page.tsx:56`, `app/api/admin/overview/route.ts:73`, `app/api/accounts/[id]/transactions/route.ts:30`, `lib/imports/authorize.ts:74` |
| `getHoldings()` legacy branch | `lib/data/accounts.ts:211-213` |
| Transaction legacy OR-arms | `lib/ai/assemblers/transactions.ts:215,938`; `lib/data/transactions.ts`; `app/api/accounts/[id]/transactions/route.ts` |
| Dead helper | `lib/sync/computeCashResidual.ts` (delete outright — `as any` hides it from tsc) |
| Seed legacy-Account creation + legacy-anchored holdings/transactions | `seed.ts:169,288,529+` |
| `model Account` + relations `User.ownedAccounts`, `Space.accounts`, `PlaidItem.accounts` | `schema:644-682,328,396,542` |
| `Holding.accountId` FK + `@@unique([accountId, symbol])` + 2 indexes | `schema:1134-1157` |
| `Transaction.accountId` FK + 2 indexes | `schema:1174-1240` |
| `VisibilityLevel.SHARED` enum value (type-recreate migration) | `schema:180` |

---

## 4. Migration order, rollback, validation

### 4.1 Order (one commit = one checklist → approval → implement → validate)

1. **Phase 0 (this doc):** run §2 gates dev + prod; record; go/defer decision for Phase 5. *(Phases 1–2 of the parent plan — KD-19 fix + extended two-user proof — are complete and committed, `232f7f7`.)*
2. **Phase 3:** comment truth-up (mechanical, no behavior).
3. **Phase 4a:** rewrite `seed.ts` — SAL-only sharing; **also stop creating legacy `Account` rows and anchor seeded holdings/transactions to `financialAccountId`** (parent plan scoped this to WAS only; without the Account half, dev Gates A–C stay non-zero forever). `prisma db seed` green on clean dev DB.
4. **Phase 4b:** final GREEN run of WAS verification scripts against prod; archive them.
5. **Phase 4c:** subtractive migration — drop WAS model + 4 relations. **No enum change.** `pg_dump` of WAS attached to PR.
6. **Phase 5 (only if Gates A–C zero in prod):** remove L1–L4 + legacy branches + `computeCashResidual` → drop `model Account`, both FKs, relations, and the `SHARED` enum value (hand-written type-recreate). Pre-drop `pg_dump` of `Account`.
7. **Phase 6:** exit verification (§4.3) + STATUS.md truth-up (D3 → Complete; seam exit criteria).

### 4.2 Rollback

- Phases 3–4a/4b: plain `git revert`; no schema, no data.
- Phase 4c: zero runtime readers → forward-only is safe; recovery = re-create model (verified down-migration) + restore the `pg_dump`. WAS is also 1:1 reconstructable from SAL `kind=SHARED` rows (dual-write provenance).
- Phase 5: only runs at zero rows, so down-migration recreates empty structures; `pg_dump` is belt-and-suspenders. Enum recreate must have a hand-verified down path.
- Each phase is an independent commit; nothing subtractive lands before the (already-green) extended two-user proof re-passes on that commit.

### 4.3 Validation checklist

Standing gate every phase: `npx prisma generate` · `npx prisma migrate dev` (schema phases) · `npx tsc --noEmit` · `npm run lint` · two-user visibility proof (KD-1/KD-15/KD-19) green.

- **Phase 0:** Gates A–E recorded dev + prod; decision logged.
- **4a:** clean-DB seed succeeds; seeded dev DB now passes Gates A–C.
- **4b:** scripts green against prod; archived.
- **4c:** migrate clean; `grep -rn "workspaceAccountShare" app lib jobs prisma/seed.ts` → zero; two-user proof green; dashboard smoke.
- **5:** Gates A–C re-confirmed zero immediately before; `grep "db\.account\.\|prisma\.account\."` → zero; `computeCashResidual` gone; two-user proof + dashboard smoke (accounts/banking/credit/investments/holdings) green; snapshot regenerate → net-worth totals byte-identical to pre-drop baseline.
- **6:** STATUS.md v2.5 seam exit criteria ticked or deferral documented.

---

## 5. If Account retirement must be deferred

**Why it would be:** Gates A or B non-zero in prod means real user holdings/transactions are still anchored to legacy `Account` rows. Dropping the table would cascade-delete them (`onDelete: Cascade` on both FKs) — irreversible data loss. The fix is a **data re-anchor migration** (map each legacy `accountId` to its `FinancialAccount` and copy into `financialAccountId`, then null the legacy FK), which is D11-adjacent data-migration work, not v2.5-A's subtractive scope.

**Milestone ownership:** a dedicated **v2.5-B slice ("legacy Account re-anchor + drop")** inside v2.5 — seam closure is v2.5's charter, so it should not leak past the release if avoidable. Contents: re-anchor script + verification script (same pattern as the SAL backfill/verify pair) → re-run Gates → Phase 5 as specified. If v2.5 timeline forces it out, it rides **v2.5.5** alongside the transaction-cleanup tooling (same data-hygiene family), with the four benign accessors and the `SHARED` enum value explicitly documented as surviving until then. WAS retirement (Phase 4) is **not** blocked either way.

---

## 6. Decision record (2026-07-03, Phase 0/4 preparation approved)

- **Legacy `Account` retirement: DEFERRED.** Production Account deletion is explicitly not approved; prod Gate A–C counts are pending. Retirement is owned by a v2.5-B follow-up slice (or v2.5.5 if it slips), per §5. No drop of `Account`, `Holding.accountId`, `Transaction.accountId`, or `VisibilityLevel.SHARED` in this slice.
- **WAS retirement: PREPARATION IN PROGRESS.** Approved direction: retire if verification passes. Completed in this pass (no schema, no migrations):
  - `scripts/phase0-seam-gates.ts` added — read-only Gates A–E + WAS→SAL drift check.
  - `prisma/seed.ts` rewritten (Phase 4a): no legacy `Account` creation, no WAS writes; FinancialAccount + AccountConnection + SpaceAccountLink only; holdings/transactions anchored to `financialAccountId`. The `prisma.account.deleteMany()` wipe is retained deliberately so a re-seed clears pre-rewrite legacy rows (dev then passes Gates A–C); remove it with the Phase 5 model drop. Section-config `accountId` JSON keys and `SpaceGoal.linkedAccountId` (soft ref, already FA ids) intentionally unchanged.
  - Validation: `tsc --noEmit` clean; `lint` clean (0 errors). `prisma generate` and `prisma db seed` could not run in this sandbox (no platform engine / no DB) — run locally before commit.
- **Still blocked, in order:** (1) gate script run on dev + prod, results recorded above; (2) `prisma db seed` green on clean dev DB; (3) final GREEN run of WAS verification scripts against prod, then archive (Phase 4b); (4) approval for the WAS schema-drop migration (Phase 4c). **Stopped before any migration or schema change.**

### Phase 4c executed (2026-07-03, approved after dev gates A–E all PASS)

- **Schema:** `model WorkspaceAccountShare` dropped, plus its 4 back-relations (`User.addedShares`/`revokedShares`, `Space.accountShares`, `FinancialAccount.workspaceShares`). Adjacent schema comments truthed-up (ShareStatus doc, SpaceMember revocation note, legacy Account note, SAL header). Untouched, per approved scope: `Account`, `Holding.accountId`, `Transaction.accountId`, `VisibilityLevel.SHARED`, `ShareStatus`, `PlaidItem`, `ProviderAccountIdentity`, `FinancialAccount`, `SpaceAccountLink`, `ImportBatch`.
- **Migration:** `prisma/migrations/20260703120000_v25a_retire_workspace_account_share/migration.sql` — hand-written in Prisma style (KD-5 precedent): 4 DropForeignKey + DropTable. Not yet applied anywhere.
- **Scripts:** `backfill-space-account-link.ts`, `verify-space-account-link-backfill.ts`, `correct-home-links.ts` removed (git history preserves them; tsconfig compiles `**/*.ts`, so an archive dir would break `tsc` post-regeneration). `audit-visibility-levels.ts` reduced to its SAL arm. `phase0-seam-gates.ts` Gate D converted to raw SQL with a 42P01 fallback so it runs both pre-drop (prod) and post-drop (reports RETIRED).
- **Validation (sandbox):** `tsc --noEmit` clean; `lint` 0 errors; zero WAS references remain in `app/ lib/ jobs/ scripts/ prisma/seed.ts prisma/schema.prisma`. `prisma migrate dev` / `generate` / seed / two-user proof / gate re-run require the local DB + engines — run list below.
- **Local run list (in order):** `pg_dump -t '"WorkspaceAccountShare"' <dev-db> > was-predrop-dev.sql` (recovery artifact; repeat for prod at deploy time) → `npx prisma migrate dev` (applies `20260703120000…`) → `npx prisma generate` → `npx tsc --noEmit` → `npm run lint` → `npx prisma db seed` → two-user privacy proof (`scripts/test-visibility-two-user-space.ts`) → `npx tsx scripts/phase0-seam-gates.ts` (expect Gate D: RETIRED).
- **Before prod deploy:** run the gate script against prod (Gate D must PASS on prod data — dev-only results exist so far) and take the prod `pg_dump` of the table. The migration is irreversible without the dump.

## 7. Bottom line

WAS can be retired now — subtractive-only, zero runtime readers, gated on seed rewrite + final verification run + Gate D. Legacy `Account` retirement is gated entirely on the §2 prod counts, which cannot be determined from code; dev will fail the gates by construction until the seed rewrite (4a) also de-anchors seed data — a scope addition to the parent plan. The `SHARED` enum value moves from the WAS drop to the Account drop. Next action: **run §2 against dev + prod and record the numbers here; then approve Phase 3/4a.**
