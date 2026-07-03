> **POINT-IN-TIME RECORD — immutable.** For current project status see `STATUS.md` at the repository root.

# Initial 30-Day DailySnapshot Backfill — Investigation Report

**Date:** 2026-07-03
**Branch:** feature/v2.5-spaces-completion
**Status:** Investigation complete. No code, schema, migration, route, or UI modified.
**Scope:** Feasibility and smallest safe design for backfilling ~30 days of history into the snapshot table immediately after a Space's first successful transaction sync.

---

## 0. TL;DR

- "DailySnapshot" is now the **`SpaceSnapshot`** model (`@@map("WorkspaceSnapshot")`). The only production writer is `regenerateSpaceSnapshot()`, which upserts **today's** row from **current** balances. It cannot produce history.
- After the first Plaid sync we have **current balances only** (a scalar per account) plus a **transaction history** whose depth is institution-dependent and currently often **shallow (~24–99 days observed, no `days_requested` set)**.
- **No historical balances are stored anywhere.** A 30-day series must be **reconstructed**, and it is only honestly reconstructable for **cash (checking/savings)** and partially for **credit-card debt**. Investments, crypto, manual assets, and loans **cannot** be reconstructed and can only be carried **flat** — i.e. estimated.
- Duplicates are already prevented by `@@unique([spaceId, date])`; a backfill just needs create-if-absent semantics and must never overwrite the authoritative "today" row.
- Recommended path: additive `source`/`isEstimated` flags on `SpaceSnapshot`, a dark, best-effort, new-space-gated backfill function that reconstructs cash from daily transaction sums and holds everything else flat-and-flagged, floored at the earliest available transaction date. Smallest safe plan is four independently-shippable, independently-revertible phases.

---

## 1. Where current snapshot creation happens

**Model** — `prisma/schema.prisma`, `model SpaceSnapshot` (formerly `DailySnapshot`), still stored as table `WorkspaceSnapshot`:

- `date DateTime @db.Date`, `@@unique([spaceId, date])`, `@@index([spaceId, date])`.
- Stored figures: `stocks, crypto, total, cash, savings, debt, netWorth, totalAssets, cashOnHand, netLiquid`, plus `createdAt`.
- **No `source`, `isEstimated`, or `isBackfilled` field exists today.**

**Sole production writer** — `lib/snapshots/regenerate.ts`:

- `regenerateSpaceSnapshot(spaceId, date = todayUTC())` reads **current** balances via `getAccounts({ spaceId })` → `classifyAccounts()` (the single source of truth every live dashboard total uses), then **upserts** the `[spaceId, date]` row. It is idempotent for a given day and always operates on **today** only.
- `regenerateSnapshotsForAccounts(faIds)` resolves the **ACTIVE `SpaceAccountLink`s** for those accounts and regenerates the today-row for **every** space each account is shared into.

**Call sites:**

- `lib/plaid/exchangeToken.ts` step 9b — initial import, best-effort / non-fatal (`try/catch`, never blocks Link).
- `lib/plaid/refresh.ts` step 4 — manual "Refresh" button, and the future cron/webhook that reuse the same pipeline.
- `prisma/seed.ts` — the **only** code that has ever written multi-day history, and it does so with **synthetic** `buildHistory()` generators (365/120/90-day demo curves). There is no production history writer.

**Read sites:** `lib/data/snapshots.ts` (`getRecentSnapshots`, `getPortfolioHistory`, `getSpaceNetWorthSummaries`), `GET /api/spaces/[id]/snapshots`, and the dashboard charts. The single-point day-one state is handled honestly by `components/charts/ChartFirstDayPlaceholder.tsx` ("Started tracking today… Check back tomorrow"), which explicitly renders a **real** number and never fabricates a trend.

**Consequence:** a brand-new real Space has exactly one snapshot row (today) after its first sync, so every trend chart shows the day-one placeholder rather than a curve. That is the gap a backfill would close.

---

## 2. What data is available after the initial Plaid/provider sync

| Source | Shape after first sync | Historical? |
|---|---|---|
| `FinancialAccount.balance` | Single current scalar (+ `availableBalance`, `creditLimit`, `balanceLastUpdatedAt` provenance, usually null) | **No** — point-in-time only |
| `Transaction` rows | First sync uses a null cursor → Plaid returns the **full available** history in one `/transactions/sync` pass. Each row: `date @db.Date`, signed `amount` (FM convention **+in / −out**), `category`, `pending`, `merchant`, FK `financialAccountId` | **Yes, but bounded** by institution depth |
| `Holding` rows | Current positions only; **delete-then-recreate** every sync (`exchangeToken.ts`, `refresh.ts`). `computeCashResidual` adds a synthetic `CASH` row so the donut sums to balance | **No** — no historical positions or prices |

**Transaction-depth caveat (material):** `app/api/plaid/link-token/route.ts` sets `products: [Products.Transactions]` with **no `transactions.days_requested`**. Per `docs/investigations/PLAID_TRANSACTION_HISTORY_DEPTH_INVESTIGATION.md`, observed depth was **~24 days (checking), ~67 (savings), ~99 (credit)** — i.e. for some accounts **less than the 30-day window we want to backfill**. A meaningful 30-day cash reconstruction is therefore **data-starved on exactly the accounts that reconstruct best** until that link-token config is addressed. This is a **dependency, not a blocker to investigate**, but it caps the honest output.

---

## 3. Do historical balances exist, or must they be reconstructed?

**They must be reconstructed. Only the current balance is persisted.** Plaid's `/transactions/sync` does not return historical daily balances, and Holdings carry no price history.

**Reconstructable (transactions fully explain the balance delta):**

- **Cash — checking + savings.** Walk backward from today's real balance: `balance(dayₙ₋₁) = balance(dayₙ) − Σ amount(transactions posted on dayₙ)`. Sound for depository accounts.
- **Credit-card debt — partial.** Card spend/payments are captured, so day-to-day movement is approximable, but interest accrual and fees that post as balance changes without a transaction introduce drift.

**Not reconstructable (carry flat, must be flagged estimated):**

- **Investments & crypto.** Value moves with **market price**, not transactions. No historical prices are stored (holdings are current-only, wiped each sync). Any backfilled value would be a flat line at today's value — wrong for every prior day.
- **Manual / real assets (`AccountType.other`).** No transactions at all. Only a current balance the user typed. Prior values are unknowable.
- **Loans (non-card debt).** Amortization/interest are not transaction-driven → drift.

**Hard floor:** reconstruction can only reach back as far as transactions exist for each account. Beyond the earliest transaction date, there is no data — the series must stop or carry flat, never fabricate.

---

## 4. How to backfill 30 days safely

Design principles, each traceable to an existing repo convention (honesty of `ChartFirstDayPlaceholder`, additive-before-subtractive from D11, best-effort/non-fatal from the snapshot call sites):

1. **Anchor on the real today-row.** `regenerateSpaceSnapshot` already wrote an authoritative snapshot for today. Reconstruct **backward** from it; never re-derive today.
2. **Reconstruct only what transactions explain.** Recompute **cash** (and optionally card debt) per prior day from summed daily transaction nets. Hold **investments, crypto, realAssets, and loan debt flat** at today's value across the window.
3. **Recompute derived fields with the same formula.** For each backfilled day, recompute `netWorth / totalAssets / netLiquid / cashOnHand` using the `classifyAccounts()` arithmetic so the series stays internally consistent with live totals (`realAssets` included in `totalAssets`/`netWorth`, excluded from `netLiquid` — matching `regenerate.ts`).
4. **Respect data floors.** Stop reconstructing an account before its earliest transaction date **and** before `FinancialAccount.createdAt` / the space's `SpaceAccountLink.createdAt`. Never imply an account existed in the Space earlier than it did.
5. **Additive & idempotent.** Only write a `[spaceId, date]` row when none exists. Skip today. Never overwrite a row (see §6).
6. **Best-effort / non-fatal.** Wrap in `try/catch` exactly like step 9b in `exchangeToken.ts`; a backfill failure must never break the Link flow.
7. **Gate to genuinely new Spaces.** Only run when the Space has **≤ 1** existing snapshot, so there is no real history to corrupt.

---

## 5. How to mark snapshots as estimated / backfilled

There is **no flag today**, and one is required — because the output is part-real (cash) and part-estimate (everything else), "estimated" is the honest label, not merely "backfilled."

- **Minimal additive schema:** `source SnapshotSource @default(LIVE)` (enum `LIVE | BACKFILL`) and/or `isEstimated Boolean @default(false)`. Nullable/defaulted so **all existing rows read as LIVE with zero migration risk**.
- **UI honesty:** badge estimated points distinctly (precedent: `isPreview` badging in `lib/timeline-placeholder.ts`; the "never fabricated" contract of `ChartFirstDayPlaceholder`). A tooltip such as "Cash reconstructed from transactions; investments/assets held flat" keeps the promise the placeholder already makes.

---

## 6. How to avoid duplicate snapshots

Already structurally prevented — `@@unique([spaceId, date])`. Backfill needs only:

- `createMany({ data: rows, skipDuplicates: true })`, **or** a per-day create-if-absent guard.
- **Never** an upsert that overwrites — specifically the today-row is authoritative/`LIVE` and must be excluded from the backfill set.
- Because writes are create-if-absent, re-running the backfill is inherently idempotent and cannot duplicate.

---

## 7. Interaction with manual accounts, investments, debts, and Space visibility

- **Manual accounts (`other`):** no transactions → flat estimate only, floored at `createdAt`. Backfilling before their creation date would falsely assert they existed.
- **Investments / crypto:** flat carry-back at today's value; genuinely estimated. Real historical value is impossible without a price-history store (explicitly out of scope / deferred — do **not** add price tables for this).
- **Debts:** card debt partially reconstructable; loans flat. Estimated.
- **Space visibility — the subtle one.** `regenerateSpaceSnapshot` computes from `getAccounts({ spaceId })`, which already respects **ACTIVE `SpaceAccountLink` + `visibilityLevel`**. But **link/visibility state is not versioned over time** — an account visible in the Space today may not have been linked 30 days ago. Reconstructing space-level aggregates with *today's* membership is an anachronism. Combined with the fact that one account can be shared into multiple Spaces (`regenerateSnapshotsForAccounts` iterates them), backfill must be **per-Space** and restricted to Spaces that are **themselves new** (≤ 1 snapshot). Personal Space and shared Spaces must be evaluated independently.

**Net:** backfill is only defensible for a brand-new Space with a fresh connection, over the window where transaction data exists, holding non-cash components flat and flagged estimated.

---

## 8. Proposed schema impact

**Additive only, aligned with the project's additive-before-subtractive rule:**

- `SpaceSnapshot.source SnapshotSource @default(LIVE)` — enum `LIVE | BACKFILL`.
- *(optional)* `SpaceSnapshot.isEstimated Boolean @default(false)`.

Both defaulted, so existing rows and every current writer implicitly resolve to `LIVE` / not-estimated with no data migration. **No new tables. No column removal. No renames.** No changes to `SpaceAccountLink`, `WorkspaceAccountShare`, or any legacy table. Explicitly **not** adding price-history or any deferred (billing/messaging/marketplace) models.

---

## 9. Smallest safe implementation plan

Four phases, each independently shippable and independently revertible. **This document is Phase 0 (investigation only).**

**Phase 1 — Schema, additive.** Add `source` (+ optional `isEstimated`) to `SpaceSnapshot`, defaulted `LIVE`/`false`. Validate: `npx prisma generate`, `npx prisma migrate dev`, `npx tsc --noEmit`, `npm run lint`. No behavior change; all existing writes are implicitly `LIVE`. Ship alone.

**Phase 2 — Backfill function, dark (not yet called).** Add e.g. `backfillSpaceSnapshots(spaceId)` that: gates on new-Space (≤ 1 existing snapshot); reconstructs **cash** from summed daily transaction nets walking back from today's `LIVE` snapshot; holds investments/crypto/realAssets/loan-debt flat; floors at earliest transaction date and account/link `createdAt`; writes rows with `source = BACKFILL` (`isEstimated = true`) via `createMany({ skipDuplicates: true })`, excluding today. Pure addition, unwired. Unit-test the reconstruction math.

**Phase 3 — Wire + gate.** Call it once from `exchangeToken.ts` **after** the initial `syncTransactionsForItem` + `regenerateSnapshotsForAccounts`, best-effort / non-fatal, only when the Space had no prior history. Validate with a targeted Link-flow run in dev.

**Phase 4 — UI honesty (optional, last).** Badge `isEstimated` points; adjust `ChartFirstDayPlaceholder` so a backfilled series renders a trend but is clearly labeled estimated.

**Dependency to sequence first:** the link-token `days_requested` gap (§2). Without it, Phase 3's honest output is often **< 30 days** for the very accounts that reconstruct best. Addressing transaction depth (tracked separately in `PLAID_TRANSACTION_HISTORY_DEPTH_INVESTIGATION.md`) should precede or accompany Phase 3.

**Rollback:** the flag defaults keep all pre-existing rows `LIVE`; a full data reversal is `DELETE FROM "WorkspaceSnapshot" WHERE source = 'BACKFILL'`; each phase reverts on its own without touching the others.

---

## 10. Open questions for approval (not decided here)

1. Reconstruct **card debt** in v1, or restrict v1 strictly to **cash** and hold all debt flat?
2. `source` enum alone, or `source` + `isEstimated` boolean?
3. Backfill on **every** new connection, or only the **first** connection of a brand-new Space?
4. Should Phase 3 wait on the `days_requested` link-token change, or ship reconstructing only the depth currently available?
