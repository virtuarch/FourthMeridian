# KD-15 — UI Transaction Privacy Leak: Implementation Checklist

**Status:** Checklist only — awaiting approval. No schema, migration, route, UI, or application code changes in this deliverable.
**Branch:** `feature/phase-2-architecture` (baseline v2.3.0)
**Sibling defect:** KD-1 (2026-07-02) closed the AI-context path only. KD-15 owns the **UI read paths**.
**Governing predicate:** `TRANSACTION_DETAIL_VISIBILITY` in `lib/ai/visibility.ts` (currently `[FULL]`) — the single source of truth KD-1 established. KD-15 reuses it; it does **not** define a second predicate.

---

## 1. Summary of the defect

A `SpaceAccountLink` grants an account into a Space at a `visibilityLevel`
(`FULL`, `BALANCE_ONLY`, `SUMMARY_ONLY`, `PRIVATE`, legacy `SHARED`). Under the
privacy contract, only `FULL` may expose transaction-level detail (rows,
merchants, amounts). `BALANCE_ONLY` exposes a balance total; `SUMMARY_ONLY`
exposes a qualitative summary; neither may leak transaction rows.

KD-1 enforced this on the AI-context queries by adding
`visibilityLevel: { in: TRANSACTION_DETAIL_VISIBILITY }` to the
`spaceAccountLinks.some` filter in `lib/ai/assemblers/transactions.ts`.

The **UI read paths were never fixed**. They filter the link on `status: ACTIVE`
only and ignore `visibilityLevel`. This is documented, unfixed, in
`docs/initiatives/d3/D3_STEP4C_CORE_DASHBOARD_REVIEW.md` §"Notes" (line 48):

> "None of these six query paths filter on `visibilityLevel` today — a space with
> a `BALANCE_ONLY` share still gets full fields back … preserved unchanged by a
> 1:1 relation swap."

Result: in a shared Space, any member can see the **full transaction history** of
a `BALANCE_ONLY` / `SUMMARY_ONLY` account via the dashboard, banking, credit, and
investments lists, and via the account-detail modal.

---

## 2. Impact map

```
                        SpaceAccountLink (status=ACTIVE, visibilityLevel=BALANCE_ONLY|SUMMARY_ONLY)
                                            │  (leaks transaction rows today)
        ┌───────────────────────────────────┼───────────────────────────────────┐
        │                                   │                                   │
lib/data/transactions.ts            app/api/accounts/[id]/            (already fixed: KD-1)
  getTransactions()                   transactions/route.ts           lib/ai/assemblers/transactions.ts
  getDebtTransactions()               GET handler                       assembleTransactions()
  getInvestmentTransactions()           │                               assembleDrilldown()
        │                               │                                   │
   server components               AccountModal.tsx (fetch)            AI context builder
        │                               │                              (NOT in KD-15 scope)
  ┌─────┼─────┬───────────────┐         │
  dashboard  banking  credit  investments   account-detail transaction list
  page.tsx   page.tsx page.tsx page.tsx      (modal on any dashboard page)
        │
  DashboardClient / BankingClient / DebtClient / widgets
  (render already-fetched arrays as props — NO own query, NO new call site)
```

**Downstream consumers that render props only (no query, no change needed):**
`DashboardClient.tsx`, `components/dashboard/widgets/RecentTransactionsPanel.tsx`,
`components/dashboard/widgets/SpaceTransactionsPanel.tsx`, and the dashboard
`page.tsx` files. They receive arrays already filtered by the two source paths
above; fixing the sources fixes them transitively.

**Blast radius of the fix:** transaction rows sourced from `BALANCE_ONLY` /
`SUMMARY_ONLY` linked accounts disappear from these UI surfaces. Rows from
`FULL` links and from the Space's own legacy `Account` rows are unaffected.
Balance totals for `BALANCE_ONLY` accounts continue to flow through the separate
accounts path (`lib/account-privacy.ts` / `/api/spaces/[id]/accounts`) and are
**not** touched.

---

## 3. Affected files

**Must change (2 read paths):**

| # | File | Function / handler | Surface |
|---|------|--------------------|---------|
| 1 | `lib/data/transactions.ts` | `getTransactions()` | Banking + dashboard lists |
| 2 | `lib/data/transactions.ts` | `getDebtTransactions()` | Credit page list |
| 3 | `lib/data/transactions.ts` | `getInvestmentTransactions()` | Investments page list |
| 4 | `app/api/accounts/[id]/transactions/route.ts` | `GET` | Account-detail modal (`AccountModal.tsx:201`) |

**New file (tests):**

| # | File | Purpose |
|---|------|---------|
| 5 | `lib/data/transactions.privacy.test.ts` | Source-tripwire test mirroring `lib/ai/assemblers/transactions.privacy.test.ts` |

**Reused, unchanged (import only):**
`lib/ai/visibility.ts` — `TRANSACTION_DETAIL_VISIBILITY`, `grantsTransactionDetail`.

**Explicitly NOT changed:**
`lib/data/accounts.ts` (`getAccounts`), `lib/data/holdings.ts` (`getHoldings`),
schema, migrations, `WorkspaceAccountShare`, `lib/account-privacy.ts`, any UI
component. Holdings leak of the same shape is a **separate defect** (see §10
Risks / out-of-scope) and must not be bundled here.

---

## 4. Current read paths (as-is)

**`lib/data/transactions.ts` — all three functions share this shape:**

```ts
where: {
  OR: [
    { account:          { spaceId } },                       // legacy = FULL by definition
    { financialAccount: { deletedAt: null,
        spaceAccountLinks: { some: { spaceId, status: ShareStatus.ACTIVE } } } },
    //                                    ^^^^^^^^^^^^^^^^^^^ no visibilityLevel filter → LEAK
  ],
  deletedAt: null,
  category:  { in: BANKING_CATEGORIES },   // or debt type / investment categories
}
```

`getDebtTransactions()` adds `type: "debt"` on both branches;
`getInvestmentTransactions()` swaps the category list and takes no `ctx` arg.
None filters `visibilityLevel`.

**`app/api/accounts/[id]/transactions/route.ts` — GET:**

```ts
const link = await db.spaceAccountLink.findFirst({
  where: { spaceId, financialAccountId: id, status: ShareStatus.ACTIVE },  // no visibilityLevel → LEAK
  select: { id: true },
});
// ... existence check, then:
const rows = await db.transaction.findMany({
  where: { OR: [{ accountId: id }, { financialAccountId: id }], deletedAt: null },
  orderBy: { date: "desc" },
});
```

Here the link is used purely as an authorization gate. Because it accepts any
`ACTIVE` link regardless of visibility, a `BALANCE_ONLY` account passes the gate
and the handler returns every transaction for that account.

**Reference — the AI path that is already correct (KD-1):**

```ts
spaceAccountLinks: { some: {
  spaceId, status: ShareStatus.ACTIVE,
  visibilityLevel: { in: TRANSACTION_DETAIL_VISIBILITY },   // ← the missing clause
} }
```

---

## 5. Privacy rule (the contract KD-15 enforces)

Transaction-level detail (rows, merchants, amounts, descriptions) may enter a UI
read path for a Space **only** from accounts whose link to that Space grants full
visibility:

| visibilityLevel | Transaction rows in UI? | Source of truth |
|-----------------|-------------------------|-----------------|
| `FULL`          | **Yes** | `TRANSACTION_DETAIL_VISIBILITY` |
| `BALANCE_ONLY`  | No — balance total only (accounts path) | — |
| `SUMMARY_ONLY`  | No — qualitative summary only | — |
| `PRIVATE`       | No — should not appear on a link row | — |
| `SHARED` (legacy) | No — **fails closed**, excluded | audit-confirmed zero rows |

The Space's own legacy `Account` rows (`account.spaceId` branch) are `FULL` by
definition and remain visible. **Absence of a grant always fails closed.** KD-15
must not introduce a second predicate — it imports the KD-1 constant so the UI
and AI paths can never disagree.

---

## 6. Proposed implementation (for approval — do not code yet)

**Step A — `lib/data/transactions.ts` (one commit):**

1. `import { TRANSACTION_DETAIL_VISIBILITY } from "@/lib/ai/visibility";`
   (If importing from `lib/ai/` into `lib/data/` is judged undesirable at review,
   the fallback is to relocate the constant to a neutral `lib/visibility.ts` and
   re-export from `lib/ai/visibility.ts` — a mechanical move, still a single
   source. Default recommendation: import as-is to keep the change minimal.)
2. In each of the three functions, add
   `visibilityLevel: { in: TRANSACTION_DETAIL_VISIBILITY }` inside the
   `spaceAccountLinks.some` clause, ANDed with the existing `spaceId` + `status`.
3. Leave the legacy `account: { spaceId }` branch, `deletedAt` guards, category
   filters, `type: "debt"`, and mapping/return shapes untouched.
4. Update the module header comment to record KD-15 and cite `lib/ai/visibility.ts`,
   mirroring the KD-1 note in the assembler.

**Step B — `app/api/accounts/[id]/transactions/route.ts` (same commit):**

1. Import the same constant (or `grantsTransactionDetail`).
2. Add `visibilityLevel: { in: TRANSACTION_DETAIL_VISIBILITY }` to the
   `spaceAccountLink.findFirst` where-clause **used to authorize row access**.
   - Recommended behavior when the account is linked but not `FULL`: the link
     lookup returns null → the legacy `Account` fallback (by `id` + `spaceId`)
     will not match a `FinancialAccount` id → respond `{ transactions: [] }`
     rather than 404, so the modal renders an empty list instead of erroring.
     **Decision point for approval:** return `200 { transactions: [] }` (keeps
     modal functional, recommended) vs. `404` (treat as not found). Pick one and
     make it explicit; the tests in §8 assert whichever is chosen.
3. Do not change the legacy `Account` authorization branch or the row mapping.

**Ordering:** Steps A and B ship together in **one commit** — they answer the
same visibility question for the same data and must not diverge mid-rollout
(same reasoning D3 Step 4C used to keep the read-cutover queries together).
Keep this commit **additive** (adds a filter clause); it removes no tables and
touches no unrelated UI.

---

## 7. Rollback plan

- **Mechanism:** single self-contained commit → `git revert <sha>` restores the
  prior behavior exactly. No migration, no data change, no schema state to
  unwind, so revert is safe at any time.
- **Feature-flag alternative (only if a staged rollout is required):** none
  recommended — the change is a pure query-narrowing with no user-facing toggle
  and no data migration; a flag would add surface area for the leak to persist.
- **Post-revert state:** the leak returns (known, pre-KD-15 behavior); no
  corrupted or orphaned data, because nothing was written.
- **Detection trigger for rollback:** legitimate `FULL` transactions disappearing
  from dashboards (over-redaction) — see §10. If observed, revert and re-audit the
  `visibilityLevel` values on live `SpaceAccountLink` rows before re-applying.

---

## 8. Validation plan

Run from repo root, in order (the project's standard gate):

1. `npx prisma generate` — no schema change expected; confirms the client still
   builds. (No `prisma migrate dev` — KD-15 does not touch schema.)
2. `npx tsc --noEmit` — type-check the two edited files and the new test.
3. `npm run lint` — including the existing eslint-disable lines are preserved.
4. **Predicate + source tripwire:** `npx tsx lib/data/transactions.privacy.test.ts`
   (new — see §9). Exits 0 on pass, 1 on failure; CI-wireable like the KD-1 test.
5. **Existing KD-1 test still green:**
   `npx tsx lib/ai/assemblers/transactions.privacy.test.ts` (regression guard —
   must be unaffected).
6. **DB-backed end-to-end, two-user shared Space:**
   `npx tsx scripts/test-visibility-two-user-space.ts` — extend it (or add a
   sibling assertion block) so it asserts that, for a `BALANCE_ONLY` and a
   `SUMMARY_ONLY` linked account, **all four** UI read paths
   (`getTransactions`, `getDebtTransactions`, `getInvestmentTransactions`, and the
   `[id]/transactions` route handler) return **zero** rows from that account,
   while a `FULL` account's rows are still returned.
7. **Targeted manual UI check:** in a two-user Space with one `BALANCE_ONLY`
   share, confirm dashboard, `/dashboard/banking`, `/dashboard/credit`,
   `/dashboard/investments`, and the account modal show the balance but **no
   transactions** for that account; confirm a `FULL` share still shows its
   transactions and the owner's own view is unchanged.

**Exit criteria:** items 1–6 pass; item 7 shows no transaction leakage for
`BALANCE_ONLY`/`SUMMARY_ONLY` and no regression for `FULL`.

---

## 9. Exact tests to add

**New file: `lib/data/transactions.privacy.test.ts`** — dependency-free,
`tsx`-runnable, mirroring `lib/ai/assemblers/transactions.privacy.test.ts`
(no jest/vitest in this repo). Two layers:

**Layer 1 — predicate reuse (pure):**
- `TRANSACTION_DETAIL_VISIBILITY` imported here is the same constant used by the
  AI path (identity/equality check against `lib/ai/visibility.ts`).
- `grantsTransactionDetail(FULL) === true`.
- `grantsTransactionDetail(BALANCE_ONLY) === false`.
- `grantsTransactionDetail(SUMMARY_ONLY) === false`.
- `grantsTransactionDetail(PRIVATE) === false`.
- `grantsTransactionDetail(SHARED) === false` (legacy fails closed).

**Layer 2 — source tripwires (read the source files, assert structure):**
- `lib/data/transactions.ts` contains **no** `spaceAccountLinks: { some: … }`
  block that lacks a `visibilityLevel` reference (regex/scan: every `some` that
  mentions `status:` must also mention `visibilityLevel`).
- `lib/data/transactions.ts` imports `TRANSACTION_DETAIL_VISIBILITY` and does not
  inline a hardcoded visibility literal (`"FULL"`, `VisibilityLevel.FULL`) in a
  query where-clause.
- `app/api/accounts/[id]/transactions/route.ts`'s `spaceAccountLink.findFirst`
  where-clause mentions `visibilityLevel` / `TRANSACTION_DETAIL_VISIBILITY`.
- Count check: exactly the expected number of SAL query sites carry the predicate
  (fails loudly if a future edit adds an unguarded one).

**Extend `scripts/test-visibility-two-user-space.impl.ts`** (DB-backed):
- Seed a Space B that has, from user A: one `FULL`, one `BALANCE_ONLY`, one
  `SUMMARY_ONLY` linked account, each with ≥1 banking, debt, and investment txn.
- Assert `getTransactions`, `getDebtTransactions`, `getInvestmentTransactions`
  called with Space B's context return rows for the `FULL` account only.
- Assert the `[id]/transactions` route returns rows for the `FULL` account and
  the chosen empty/404 response (per §6 Step B decision) for the `BALANCE_ONLY`
  and `SUMMARY_ONLY` accounts.
- Assert the owner (user A, in their own Space) still sees all rows — the fix
  does not over-redact the owner.

---

## 10. Risks

- **Over-redaction (highest):** if any live `SpaceAccountLink` that should be
  `FULL` carries a non-`FULL` `visibilityLevel` (or the legacy `SHARED`), its
  transactions vanish from the UI after the fix. **Mitigation:** run
  `scripts/audit-visibility-levels.ts` against dev **and** prod before merge (the
  same audit KD-1 relied on to confirm zero `SHARED` rows); confirm the
  distribution of link visibility matches expectations. Fails closed is the
  correct safety posture, but verify no legitimate data is caught.
- **`[id]/transactions` UX ambiguity:** returning `404` vs. empty list for a
  `BALANCE_ONLY` account changes modal behavior. Must be decided at approval
  (§6 Step B) so the modal and tests agree.
- **Import direction (`lib/data` → `lib/ai`):** minor architectural smell.
  Accepted for minimal diff; note the neutral-location fallback in §6 if review
  objects.
- **Out-of-scope sibling leaks (do NOT fix here):**
  `lib/data/holdings.ts` (`getHoldings`) and `lib/data/accounts.ts` field
  exposure exhibit the same `visibilityLevel`-blind pattern for holdings/account
  fields. These are real but separate; bundling them would violate the project
  rule against multi-decision commits. **Recommend filing KD-16 (holdings) /
  KD-17 (account fields)** and leaving them untouched in KD-15.
- **Test-runner absence:** repo has no jest/vitest; new tests must stay
  `tsx`-runnable and dependency-free, matching the KD-1 test harness (incl. the
  `server-only` shim launcher for DB-backed runs).

---

## 11. Stopping point

This deliverable ends at the **approved checklist**. No schema, migration, route,
UI, or application code has been or will be modified until this checklist is
approved. On approval, implementation proceeds as the **single additive commit**
described in §6 (Steps A + B together) plus the new/extended tests in §9,
followed by the validation gate in §8. Holdings/account-field leaks are deferred
to separate KD items and are explicitly not part of this work.
