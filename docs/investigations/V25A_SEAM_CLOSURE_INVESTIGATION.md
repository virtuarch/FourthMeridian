# v2.5-A — Seam Closure Investigation & Checklist

**Status:** Investigation only — no code, schema, migrations, or file regeneration. Plan for approval.
**Date:** 2026-07-03
**Branch:** `feature/v2.5-spaces-completion`
**Scope (fixed by request):** WorkspaceAccountShare (WAS) retirement · SpaceAccountLink (SAL) as sole read path · legacy `Account` read-path removal · visibility-tier enforcement in every assembler/read surface · two-user BALANCE_ONLY proof test.
**Authority:** Defers to `STATUS.md` (D3 = SAL migration; KD-1/KD-15 = visibility leaks; v2.5 exit criteria) and `PHASE_2_DECISION_MATRIX.md`.

---

## 0. Headline finding

The seam is **much closer to closed than STATUS.md's prose implies, with one concrete exception that changes the risk profile.**

- **WAS:** there are **zero runtime WorkspaceAccountShare reads or writes** left in `app/`, `lib/`, or `jobs/`. The dual-write was already removed (KD-4 Phase 1). Every remaining WAS reference is a code comment, the dev seed, migration/verification scripts, or the schema model itself. WAS retirement is now a **subtractive-only** exercise (schema + seed + scripts), not a code-cutover.
- **Legacy `Account`:** only **4 runtime accessor call sites** remain, all benign (2 admin `count()`s, 2 guarded existence-only fallbacks). The real legacy coupling is not those call sites — it is the **dual-FK data model**: `Holding.accountId` and `Transaction.accountId` still anchor pre-migration rows to legacy `Account`, and `getHoldings()`/`getTransactions()` keep a legacy branch to read them. Legacy `Account` cannot be dropped until those rows are confirmed migrated to `financialAccountId`.
- **Visibility enforcement:** every *transaction-detail* surface correctly enforces `TRANSACTION_DETAIL_VISIBILITY` (KD-1/KD-15 closed). **But one balance surface does not: `lib/data/accounts.ts::getAccounts()` filters SAL on `status: ACTIVE` only, with no `visibilityLevel` branch** — so a BALANCE_ONLY-shared account's institution name and debt metadata (APR, minimum payment, subtype, credit limit) are returned to every dashboard page of the space it's shared into. This is a **latent BALANCE_ONLY metadata leak of the same class as KD-1/KD-15**, not yet covered by the existing two-user test. It is the single most important thing this investigation surfaces, and it is exactly what the v2.5-A two-user proof must be extended to catch.

The implication for sequencing: **v2.5-A's real work is (1) fix the `getAccounts()` visibility gap, (2) extend the two-user proof to cover account metadata, and only then (3) perform the subtractive WAS/`Account` retirement.** The migration seam is safe to close; the metadata leak must be closed *first* because retirement work should not happen on top of an unproven privacy surface.

---

## 1. Current read-path inventory

Every read of account-sharing/visibility data, classified by whether it makes a **visibility decision** (privacy-critical) or only an **ownership/existence** check.

### 1.1 SAL read sites (canonical path — 14 total)

| # | Site | Purpose | Visibility filter | Class |
|---|---|---|---|---|
| 1 | `lib/ai/assemblers/accounts.ts:126` | AI account context | `status: ACTIVE`; branches FULL vs BALANCE_ONLY/SUMMARY_ONLY, sanitizes metadata | ✅ Enforcing |
| 2 | `lib/ai/assemblers/holdings.ts:121` | AI holdings context | `status: ACTIVE`; FULL shows positions, BALANCE_ONLY aggregate-only | ✅ Enforcing |
| 3 | `lib/ai/assemblers/transactions.ts:223` (summary) | AI transaction context | `status: ACTIVE` + `visibilityLevel: { in: TRANSACTION_DETAIL_VISIBILITY }` | ✅ Enforcing (KD-1) |
| 4 | `lib/ai/assemblers/transactions.ts:945` (drilldown) | AI drilldown | same as #3 | ✅ Enforcing (KD-1) |
| 5 | `lib/data/transactions.ts:66` `getTransactions` | Dashboard txn list | `status: ACTIVE` + `TRANSACTION_DETAIL_VISIBILITY` | ✅ Enforcing (KD-15) |
| 6 | `lib/data/transactions.ts:98` `getDebtTransactions` | Debt txn list | same as #5 | ✅ Enforcing (KD-15) |
| 7 | `lib/data/transactions.ts:129` `getInvestmentTransactions` | Investment txn list | same as #5 | ✅ Enforcing (KD-15) |
| 8 | `app/api/spaces/[id]/accounts/route.ts:42` | Shared-Space accounts API | `status: ACTIVE`; BALANCE_ONLY sanitized + aggregated | ✅ Enforcing |
| 9 | `app/api/accounts/[id]/transactions/route.ts:24` | Account modal txns | `grantsTransactionDetail(link.visibilityLevel)` guard | ✅ Enforcing (KD-15) |
| 10 | **`lib/data/accounts.ts:43` `getAccounts`** | **Dashboard account list (all pages)** | **`status: ACTIVE` ONLY — no `visibilityLevel` branch** | ⚠️ **GAP — see §4-R1** |
| 11 | `lib/data/accounts.ts:160` `getHoldings` (FA branch) | Dashboard holdings | `status: ACTIVE` (balance/holding aggregate — value only) | ◻︎ Review (§4-R2) |
| 12 | `lib/snapshots/regenerate.ts:108` | Net-worth snapshot | `status: ACTIVE` (consumes `getAccounts` at :55; aggregates balance only) | ◻︎ Inherits #10 |
| 13 | `app/api/accounts/[id]/route.ts:138,169` | Account detail / unshare | ownership/link enumeration | ◻︎ Non-visibility |
| 14 | `app/api/imports/[id]/rollback/route.ts:113`, `lib/imports/authorize.ts:68`, `app/api/spaces/[id]/accounts/share/route.ts:149`, `lib/accounts/reconcile.ts:482`, `lib/accounts/space-account-link.ts:135,142` | import auth / share mutation / merge / link-kind compute | existence / `kind` / count | ◻︎ Non-visibility |

### 1.2 Legacy `Account` read sites (4 runtime accessors)

| # | Site | Purpose | Privacy exposure |
|---|---|---|---|
| L1 | `app/admin/page.tsx:56` | `db.account.count()` admin stat | None (count) |
| L2 | `app/api/admin/overview/route.ts:73` | `db.account.count()` admin stat | None (count) |
| L3 | `app/api/accounts/[id]/transactions/route.ts:30` | Fallback existence check when no SAL link; `select: { id }` | None directly; downstream txn query matches `OR [{accountId},{financialAccountId}]` and treats legacy row as FULL ("Space's own account") |
| L4 | `lib/imports/authorize.ts:74` | Fallback existence check; returns 400 "does not support import" | None (existence) |

### 1.3 Legacy `Account` data-model coupling (the real blocker — not call sites)

| Coupling | Location | Note |
|---|---|---|
| `Holding.accountId` → `Account` | schema `1134`; read at `lib/data/accounts.ts:151-153` (`getHoldings` legacy branch, `account: { spaceId }`) | Pre-migration holdings still anchored to legacy `Account`; read by direct `spaceId` (bypasses SAL) |
| `Transaction.accountId` → `Account` | schema `1176`; read at `getTransactions`/drilldown via `OR [{accountId},{financialAccountId}]` | Legacy/manual txns carry `accountId` |
| `Account.holdings` / `Account.transactions` back-relations | schema `671-672` | Removed only with the model |
| Relations: `User.ownedAccounts` (328), `Space.accounts` (396), `PlaidItem.accounts` (542) | schema | Must be dropped with the model |

---

## 2. Every remaining WorkspaceAccountShare usage

**Runtime (app/lib/jobs): NONE.** Confirmed by `grep -rnE "\.workspaceAccountShare\.|workspaceShares" app lib jobs` → only comment lines. The Prisma accessor `db.workspaceAccountShare` is not called anywhere in application code.

### 2.1 Non-runtime references (all that remain)

| Category | Files | Disposition in v2.5-A |
|---|---|---|
| **Schema model + relations** | `prisma/schema.prisma`: `model WorkspaceAccountShare` (876); `FinancialAccount.workspaceShares` (770); `User.addedShares`/`revokedShares` (351-352); `Space.accountShares` (406); `VisibilityLevel.SHARED` enum value (180, legacy, tied to `Account`) | Subtractive migration (last commit) |
| **Dev seed** | `prisma/seed.ts:201,231,280` (`workspaceAccountShare.create`/`deleteMany`) | Rewrite to seed SAL directly (before schema drop) |
| **Migration/verification scripts** | `scripts/backfill-space-account-link.ts` (170,214), `scripts/correct-home-links.ts` (110,141,235), `scripts/verify-space-account-link-backfill.ts` (125), `scripts/audit-visibility-levels.ts` (34,62) | These *verify the backfill*; run them GREEN one last time, then archive. They become no-ops post-drop |
| **Comments** (already-cutover documentation) | `lib/data/*`, `lib/ai/assemblers/*`, `lib/snapshots/regenerate.ts`, ~18 route files, `lib/space-nav.ts:83` | Update wording when the model is dropped (non-blocking) |

**Conclusion:** WAS retirement carries **no code-cutover risk** — there is no runtime reader to break. Risk is confined to (a) seed continuing to compile, (b) the `SHARED` enum value being safe to remove, (c) confirming no un-backfilled WAS rows exist before dropping the table.

---

## 3. Every remaining legacy `Account` usage

### 3.1 Runtime accessors (4) — see §1.2 (L1–L4). All benign: 2 counts, 2 existence fallbacks.

### 3.2 Read branches that still touch legacy `Account` data
- `lib/data/accounts.ts:151-153` — `getHoldings()` legacy branch reads `holding.account.spaceId` directly (no SAL, no visibility tiering). Reachable only for holdings whose `accountId` is still set.
- `lib/data/transactions.ts` + `app/api/accounts/[id]/transactions/route.ts:66` — `OR [{accountId}, {financialAccountId}]` includes legacy-anchored transactions.

### 3.3 Schema coupling — see §1.3.

### 3.4 The gating question (must be answered before any `Account` drop)
**Are there still `Holding` / `Transaction` rows with `accountId` set and `financialAccountId` null?** This is a live-data question, not a code question — it requires a read-only count against dev + prod:
```
Holding:     count where accountId != null           (and financialAccountId == null)
Transaction: count where accountId != null           (and financialAccountId == null)
Account:     count (total, non-deleted)
```
If any are non-zero, legacy `Account` removal is **blocked** on a data migration (re-anchor those rows to `financialAccountId`) which is D11-adjacent and out of v2.5-A's subtractive scope. **Recommendation: v2.5-A retires WAS (clean) and fixes the visibility gap, but defers the legacy-`Account` *table drop* to a follow-up gated on the counts being zero.** Keep the 4 benign accessors until then; they are additive fallbacks and harmless.

---

## 4. Risk map — privacy regressions

Ordered by severity. "Fail-closed" = absence of a grant hides data; "fail-open" = absence exposes data.

### R1 — BALANCE_ONLY metadata leak via `getAccounts()` — **HIGH, currently reachable**
`lib/data/accounts.ts::getAccounts()` returns `institution`, `name`, `creditLimit`, `debtSubtype`, `interestRate`, `minimumPayment`, and full `debtProfile` for **every** active SAL link, with no `visibilityLevel` branch. The POST share route (`app/api/spaces/[id]/accounts/share/route.ts:56`) explicitly permits `BALANCE_ONLY` shares. Reachability: User A shares an account into shared Space S at BALANCE_ONLY → User B (member of S) sets S active → every dashboard page (`accounts`, `banking`, `credit`, `investments`, `holdings`, main `page.tsx`) calls `getAccounts(spaceId=S)` → B sees A's institution + debt metadata. The BALANCE_ONLY contract ("balance total only; no institution, no transactions, no debt metadata") is violated for metadata. Balance itself is permitted, so this is metadata-only — but institution + APR + credit limit are exactly what the tier exists to hide. **The AI assembler and the `/api/spaces/[id]/accounts` route both sanitize correctly; only the data-layer `getAccounts()` does not** — a classic "one read path disagrees" defect, same family as KD-1/KD-15. Not caught by the current two-user test (which asserts on transactions and the AI accounts *assembler*, not `getAccounts()`). **Fix must fail closed** and mirror the assembler's sanitization. Recommend logging as **KD-19** before implementation.

### R2 — `getHoldings()` FA branch has no visibility branch — **MEDIUM, needs confirmation**
`lib/data/accounts.ts:160` filters `status: ACTIVE` only. Holdings under a BALANCE_ONLY account: the tier contract says individual positions/symbols must be hidden, aggregate value may contribute. If `getHoldings()` returns per-position rows for a BALANCE_ONLY-linked account, that leaks positions. The AI holdings assembler enforces this; the data layer may not. Confirm and, if leaking, fix alongside R1.

### R3 — legacy `Account` fallback treats rows as FULL — **LOW, by design but worth a guard**
L3/L4 treat a legacy `Account` in the current space as FULL ("the Space's own accounts"). Correct today (legacy rows are HOME/own-space), but the fallback ignores `Account.visibilityLevel`. Low risk because it only matches `spaceId == current space`; note it and let it die with the table.

### R4 — `SHARED` enum removal — **LOW, fail-closed already**
`visibility.ts` already excludes `SHARED` and documents a dev+prod audit showing zero `SHARED` rows on SAL. Removing the enum value is safe *if* re-audited immediately before the migration (see validation §6). Fails closed if a stray row ever appeared.

### R5 — subtractive migration ordering — **MEDIUM, process risk**
Dropping WAS/`Account` before confirming zero readers/rows would be an irreversible data loss. Mitigated entirely by additive-before-subtractive (§5) and the count gates (§3.4, §6).

### R6 — seed drift — **LOW**
`prisma/seed.ts` still writes WAS. If the model is dropped before the seed is updated, `prisma db seed` breaks in dev. Sequence seed rewrite before schema drop.

### R7 — snapshot aggregates — **LOW**
`regenerate.ts` consumes `getAccounts()`; once R1 is fixed to sanitize metadata, snapshot balance aggregates are unaffected (balance is permitted under BALANCE_ONLY). No separate fix, but re-run a snapshot after R1 to confirm net-worth totals are unchanged.

---

## 5. Additive-before-subtractive implementation plan

Six ordered phases. **No table or enum is dropped until every reader is gone and every count gate is zero.** Each phase = one checklist → approval → implement → validate cycle (project working style).

**Phase 0 — Prove the current state (no code).**
Run the three count queries (§3.4) and a fresh `SpaceAccountLink.visibilityLevel` audit (`scripts/audit-visibility-levels.ts`) against dev + prod. Record results in the checklist. These are the entry gates: they decide whether the `Account` table drop is in-scope or deferred.

**Phase 1 — Close the visibility gap (additive, privacy-critical). [KD-19]**
Add a `visibilityLevel` branch to `getAccounts()` (and, if R2 confirmed, `getHoldings()`) that sanitizes BALANCE_ONLY/SUMMARY_ONLY exactly as the AI accounts assembler does (generic name, balance only, no institution, no debt metadata, no positions). Reuse a shared predicate/helper so the data layer and assembler can never disagree — extend `lib/ai/visibility.ts` or add `lib/account-privacy.ts` sanitizer usage (the latter already exists for WAS-era rows). Pure-additive: no schema, no deletion.

**Phase 2 — Extend the two-user proof (additive test). [gate for everything after]**
Extend `scripts/test-visibility-two-user-space.impl.ts` to assert on `getAccounts()` and `getHoldings()`: seed X FULL / Y BALANCE_ONLY / Z SUMMARY_ONLY / W REVOKED with a canary institution + APR, assert the dashboard data layer redacts Y/Z institution/debt-metadata/positions while still reporting Y's balance, and no over-redaction of X. This test must go green on Phase 1's fix and becomes the merge gate for Phases 4–5.

**Phase 3 — Documentation truth-up (additive).**
Update the "used to query WorkspaceAccountShare" comments to "reads SpaceAccountLink (WAS retired vN)". No behavior change. Do this before the drop so the drop commit is purely mechanical.

**Phase 4 — Retire WAS (subtractive, safe — no runtime readers).**
(a) Rewrite `prisma/seed.ts` to seed SAL directly. (b) Run the WAS verification scripts GREEN one last time; archive them under `scripts/archive/` or delete per STATUS.md §10. (c) Additive migration removing `model WorkspaceAccountShare` + relations (`FinancialAccount.workspaceShares`, `User.addedShares/revokedShares`, `Space.accountShares`) + the `SHARED` enum value (after R4 re-audit). `prisma migrate dev`. Because there are zero runtime readers, this cannot break request paths.

**Phase 5 — Retire legacy `Account` (subtractive) — ONLY IF Phase 0 counts are zero.**
If `Holding.accountId`/`Transaction.accountId`/`Account` counts are all zero: remove the 4 accessors (L1–L4) and the legacy read branches (`getHoldings` legacy branch, the `accountId` OR-arm), then drop `model Account` + relations + the `Holding.accountId`/`Transaction.accountId` FKs. **If any count is non-zero: STOP.** Legacy `Account` drop is deferred to a data-migration follow-up; v2.5-A ships with WAS retired, the visibility gap closed, and the 4 benign fallbacks intact. This preserves "additive before subtractive" — do not delete a table with live rows.

**Phase 6 — Exit verification.**
Re-run Phase 2 test, the visibility audit, and a snapshot regeneration; confirm net-worth totals unchanged. Confirm `grep` shows zero WAS references outside archive; confirm zero legacy-`Account` readers (or documented deferral).

---

## 6. Validation checklist

Per-phase, in addition to the standing gate (`npx prisma generate` · `npx prisma migrate dev` when schema changes · `npx tsc --noEmit` · `npm run lint`):

**Phase 0**
- [ ] `Holding` count where `accountId != null AND financialAccountId == null` — dev & prod (record numbers)
- [ ] `Transaction` count where `accountId != null AND financialAccountId == null` — dev & prod
- [ ] `Account` total non-deleted count — dev & prod
- [ ] `SpaceAccountLink.visibilityLevel` audit shows **zero `SHARED`** rows — dev & prod
- [ ] Decision recorded: is Phase 5 (Account drop) in-scope or deferred?

**Phase 1 (KD-19)**
- [ ] `getAccounts()` returns sanitized metadata (no institution/debt) for BALANCE_ONLY & SUMMARY_ONLY links; balance still present
- [ ] `getHoldings()` hides positions for BALANCE_ONLY/SUMMARY_ONLY (if R2 confirmed) — else documented as non-leaking
- [ ] Sanitizer is a shared predicate/helper — data layer and AI assembler reference the same source
- [ ] No FULL-link over-redaction (X still full)

**Phase 2**
- [ ] Extended two-user test asserts `getAccounts()` redaction (Y/Z institution + APR absent; Y balance present)
- [ ] Test asserts `getHoldings()` position redaction
- [ ] Test green on Phase 1 build; fails on a deliberately reverted Phase 1 (proves it guards)

**Phase 4 (WAS retirement)**
- [ ] `prisma/seed.ts` seeds SAL only; `prisma db seed` succeeds on a clean dev DB
- [ ] WAS verification scripts run GREEN pre-drop; then archived/removed
- [ ] Migration drops WAS model + 4 relations + `SHARED` enum; `migrate dev` clean; `tsc`/`lint` clean
- [ ] `grep -rn "workspaceAccountShare\|workspaceShares" app lib jobs` → zero (comments updated in Phase 3)
- [ ] Full two-user test still green post-drop

**Phase 5 (Account retirement — conditional)**
- [ ] Phase 0 counts all zero (re-confirmed immediately before)
- [ ] L1–L4 accessors removed; legacy read branches removed
- [ ] Migration drops `Account` model + `Holding.accountId` + `Transaction.accountId` + relations; `migrate dev` clean
- [ ] Two-user test + dashboard smoke (accounts/banking/credit/investments/holdings) green
- [ ] Snapshot regenerate → net-worth totals unchanged vs pre-drop baseline

**Phase 6 (exit criteria — from STATUS.md v2.5)**
- [ ] Zero reads of `WorkspaceAccountShare`
- [ ] Zero legacy-`Account` queries in AI/read paths (or documented deferral with the 4 fallbacks isolated)
- [ ] BALANCE_ONLY guarantee proven by the extended two-user test, end to end (transactions **and** account metadata)

---

## 7. Rollback plan

The plan is engineered so rollback is cheap at every phase; the only irreversible steps are the two migrations, which come last and behind gates.

- **Phases 1–3 (additive code/test/comments):** revert the commit. No schema, no data change. Zero-risk rollback.
- **Phase 4 migration (WAS drop):** WAS has zero runtime readers, so a forward-only posture is safe, but keep a reversal path: (a) the down-migration re-creates `model WorkspaceAccountShare` + relations + the `SHARED` enum (Prisma generates the inverse; verify it before applying); (b) **data recovery**: because SAL was dual-written from WAS and SAL `kind=SHARED` rows mirror WAS rows 1:1, WAS data is *reconstructable from SAL* if ever needed — but take a `pg_dump` of the WAS table immediately before the drop and attach it to the migration PR as the authoritative recovery artifact. Roll back = restore the dump into the re-created table.
- **Phase 5 migration (Account drop):** only runs with zero rows (Phase 0 gate), so the down-migration re-creates empty structures — nothing to restore. If counts were non-zero the phase never ran. Still take a `pg_dump` of `Account` + affected `Holding`/`Transaction` FKs pre-drop as belt-and-suspenders.
- **Feature-flag option (recommended for Phase 1):** gate the new `getAccounts()` sanitization behind an env flag (`ACCOUNT_METADATA_VISIBILITY_ENFORCED`, default **on**) for one release so it can be disabled without a redeploy if it over-redacts a real Space — mirrors the KD-2/KD-3 flag pattern already in the codebase. Remove the flag once the two-user test + a production smoke confirm no over-redaction.
- **General:** each phase is its own PR/commit; `git revert` of any single phase leaves the others intact because the ordering keeps additive work independent of the subtractive drops.

---

## 8. Exact proposed order of commits

Each line is one commit = one checklist → one approval → one implement → one validation cycle. Do not batch; do not reorder (later commits depend on earlier gates).

1. **`chore(v2.5-A): seam-closure readiness audit` (Phase 0)** — read-only count queries + visibility audit recorded in the checklist doc; no code. Produces the go/defer decision for commit 8–9.
2. **`fix(privacy): enforce visibility tiers in getAccounts() [KD-19]` (Phase 1)** — additive sanitizer branch, shared predicate, flag-gated (default on). Privacy-critical; lands first of the code changes.
3. **`fix(privacy): redact positions in getHoldings() for BALANCE_ONLY [KD-19]` (Phase 1b)** — only if R2 confirmed leaking; else skip with a note.
4. **`test(privacy): extend two-user proof to account metadata + holdings` (Phase 2)** — the merge gate for all subtractive work below. Must be green here and provably fail on reverted commits 2–3.
5. **`docs: truth-up SAL/WAS comments to post-retirement wording` (Phase 3)** — mechanical, so the drop commits stay pure.
6. **`refactor(seed): seed SpaceAccountLink directly, drop WAS from seed` (Phase 4a)** — seed compiles/runs on clean dev DB before the model is removed.
7. **`chore(scripts): run WAS backfill-verification green, then archive` (Phase 4b)** — last green run recorded; scripts archived.
8. **`feat(schema)!: retire WorkspaceAccountShare (model + relations + SHARED enum)` (Phase 4c)** — subtractive migration; safe (zero runtime readers); `pg_dump` attached to PR; SHARED re-audit in the same PR.
9. **`feat(schema)!: retire legacy Account (model + Holding/Transaction FKs)` (Phase 5)** — **conditional on commit 1's counts being zero.** If deferred, this commit is not made in v2.5-A; instead file a follow-up ticket "legacy Account data re-anchor + drop" and note the 4 fallbacks remain.
10. **`chore(v2.5-A): exit verification` (Phase 6)** — re-run test + audit + snapshot; tick STATUS.md v2.5 seam exit criteria; update STATUS.md §3 (D3 → Complete) and §7 (KD-19 closed, KD-15 note).

**Gate summary:** commits 2–3 close the leak; commit 4 proves it; commits 6–8 retire WAS (always safe); commit 9 retires `Account` only if data-clean; commit 10 certifies the exit criteria. Nothing subtractive (8, 9) merges before the extended proof (4) is green.

---

## 9. Answers to the five scoped questions, in one line each

- **WAS retirement:** no runtime readers remain; it is subtractive-only (schema + seed + scripts), safe once seed is rewritten and a pre-drop dump is taken.
- **SAL as sole read path:** already true for every runtime read; the remaining work is dropping the dead WAS model, not cutting over readers.
- **Legacy `Account` removal:** 4 benign accessors + a dual-FK data model; the table can be dropped only after confirming zero `Holding`/`Transaction` rows still anchor to `accountId` (Phase 0 gate) — otherwise deferred.
- **Visibility enforcement:** enforced everywhere *except* `getAccounts()` (and possibly `getHoldings()`) — a real, reachable BALANCE_ONLY metadata leak (KD-19) that must be fixed and proven before retirement work.
- **Two-user BALANCE_ONLY proof:** exists for transactions/AI context; must be *extended* to cover account metadata and holdings, and becomes the merge gate for all subtractive commits.
