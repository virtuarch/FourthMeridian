# Bugfix investigation: archived accounts still affect Space-level aggregates

Status: **investigation complete, fix proposed, awaiting approval — no code changed yet.**
Treated as a Phase 2 accounting-correctness blocker per project rules (concrete-blocker exception). D2 is on hold until this is resolved.

## 1. Data source map

| Surface | Component / route | Data source | Live or cached |
|---|---|---|---|
| Spaces index cards ($ value + sparkline) | `app/(shell)/dashboard/spaces/page.tsx` → `getSpaceNetWorthSummaries()` in `lib/data/snapshots.ts:49` | `db.spaceSnapshot.findMany` | **Cached** (`SpaceSnapshot` table) |
| Spaces index cards (account count) | same page, `_count.accounts` with `where: { deletedAt: null }` | `Space._count` via Prisma | Live |
| Individual Space dashboard (PERSONAL space, e.g. "Chris' Space") — KPI numbers | `app/(shell)/dashboard/page.tsx:42-50` → `getAccounts()` / `lib/account-classifier.ts` → `DashboardClient.tsx` → `KpiRow`/`NetWorthCard` | `db.workspaceAccountShare` joined to `financialAccount: { deletedAt: null }` (`lib/data/accounts.ts:33-39`) | **Live** |
| Individual Space dashboard — Net Worth chart | same page, `getRecentSnapshots(365, …)` (`lib/data/snapshots.ts:16`) → `NetWorthChart` | `db.spaceSnapshot.findMany` | **Cached** |
| Individual Space dashboard (SHARED space) — `net_worth` section | `components/dashboard/SpaceDashboard.tsx` (`renderNetWorth`, line 878), fetches `/api/spaces/[id]/accounts` client-side | `app/api/spaces/[id]/accounts/route.ts:38-45`, filters `financialAccount: { deletedAt: null }` | **Live** (no historical chart on this view at all) |
| Banking/Investments history charts | `lib/data/snapshots.ts:85` `getPortfolioHistory()` | `db.spaceSnapshot.findMany` | **Cached** |
| Daily Brief — current net worth/assets/debt | `app/api/brief/route.ts:348-390` | `db.workspaceAccountShare` joined to `financialAccount: { deletedAt: null }` (independent re-implementation of the same live query) | **Live** |
| Daily Brief — "change since last visit" baseline only | `app/api/brief/route.ts:392-401` | `db.spaceSnapshot.findFirst` (used only as the prior-day comparison point) | **Cached**, but only feeds a delta, not the current total |
| Daily Brief — AI summary text | `app/api/brief/route.ts:404-410` (`db.aiAdvice`) | Cached, generated text | Cached |
| Allocation widget (`AllocationChart.tsx`) | pure presentational, takes `cash/investments/crypto/debt` as props | Whatever caller passes in — every caller found feeds it from the same live `getAccounts()`/`SpaceDashboard` account list | **Live** (inherits correctness from its caller) |

## 2. Root cause

There are two independent, parallel net-worth computations in this codebase:

1. **Live path** — `getAccounts()` (`lib/data/accounts.ts`) and the brief's inline equivalent both join through `WorkspaceAccountShare` with `status: ACTIVE` and `financialAccount: { deletedAt: null }`. Every reader on this path (KPI row, NetWorthCard, SummaryWidget, the Space's own `net_worth` section, Allocation widget, Daily Brief's current totals) is correct today — archiving immediately drops the account everywhere on this path, with no code changes needed.

2. **Cached path** — `SpaceSnapshot`, one row per space per day, written by `regenerateSpaceSnapshot()` / `regenerateSnapshotsForAccounts()` (`lib/snapshots/regenerate.ts`). A repo-wide search found exactly **two** call sites for these functions:
   - `lib/plaid/refresh.ts:193` (manual "Refresh" button / future cron)
   - `app/api/plaid/exchange-token/route.ts:352` (Plaid Link / relink)

   **No account-archive or account-restore route calls either function.** `app/api/accounts/[id]/route.ts` `DELETE` (archive), `app/api/accounts/[id]/restore/route.ts`, `app/api/accounts/manual/[id]/restore/route.ts`, and the reactivation branch of `app/api/accounts/wallet/route.ts` all mutate `FinancialAccount` / `AccountConnection` / `WorkspaceAccountShare` directly and never touch `SpaceSnapshot`. So today's `SpaceSnapshot` row keeps whatever totals existed at the last regeneration, indefinitely, until some unrelated Plaid refresh happens to recompute it from scratch.

This exactly matches the observed symptom: the Spaces index card and the Net Worth chart both read `SpaceSnapshot` (cached, stale); the individual Space dashboard's KPI numbers read live `FinancialAccount` rows (correct); and running Plaid refresh "fixed" both, because `regenerateSpaceSnapshot()` always recomputes the day's row from a fresh `getAccounts()` call — a full overwrite, not an increment — so any refresh of any active item in that space happens to drag the whole snapshot back into sync as a side effect.

## 3. Answers to the specific investigation questions

**Q3 — which queries fail to filter `deletedAt`:** none of the *query* paths do. The live paths all filter correctly. The problem isn't a missing filter — it's a cached table that was never wired into the archive/restore lifecycle at all.

**Q4 — is the archived account still reachable via a join:** No. `WorkspaceAccountShare` is correctly revoked (`status: REVOKED`) on archive, so no live join surfaces it. `AccountConnection` is soft-deleted in parallel and isn't read for aggregates. `Holding` (FinancialAccount-anchored rows) already filters `deletedAt: null` + active share, confirmed in `lib/data/accounts.ts:119-127` (D11 work). `Transaction` isn't summed into net-worth/asset/liability totals anywhere in this path. `SpaceSnapshot` is the one implicated table, but it's not a "leak via join" — it's a stale cached row with no relation back to `FinancialAccount` at all, so nothing tells it the underlying data changed.

**Q — should archiving trigger snapshot regeneration, or should the dashboard override today's chart point with live totals at render time:** Regeneration-on-mutation is the smaller and more correct fix. Reasons:
- `SpaceSnapshot` has four independent readers (Spaces index card, NetWorth chart, portfolio history charts, brief's delta baseline). A render-time override would need to be duplicated in every one of those call sites and would still leave the stored row wrong for any future reader.
- The brief's "change since last visit" feature specifically depends on `SpaceSnapshot` rows being historically accurate as-of-the-day — a render-time patch over today's chart point wouldn't fix that.
- The regeneration helper already exists, is already idempotent (upsert on `[spaceId, date]`), and is already proven by the Plaid refresh/exchange-token call sites. This is wiring, not new logic.

## 4. Proposed smallest safe fix

Call the **existing, unmodified** `lib/snapshots/regenerate.ts` helpers from the archive/restore routes, best-effort and non-fatal (same pattern already used for the holdings step in `lib/plaid/refresh.ts:176-181`). No schema changes, no changes to `regenerate.ts` itself, no UI changes.

One subtlety: `regenerateSnapshotsForAccounts(ids)` finds spaces via **ACTIVE** `WorkspaceAccountShare` rows for that account id. On restore, the share is reactivated *before* we'd call it, so the existing helper works unmodified. On archive, the share is revoked, so calling the same helper *after* revocation would find zero shares and regenerate nothing. The fix is to capture the affected space ids *before* revoking (the archive route already fetches them: `fa.workspaceShares` is pre-filtered to `status: ACTIVE` at the top of the route), then call `regenerateSpaceSnapshot(spaceId)` directly for each captured id.

| File | Change |
|---|---|
| `app/api/accounts/[id]/route.ts` (`DELETE`) | After step 3 (revoke shares), loop the **pre-revocation** `fa.workspaceShares` list and call `regenerateSpaceSnapshot(spaceId)` for each distinct `workspaceId`. Wrap in try/catch, log-and-continue on failure — never block the archive itself. |
| `app/api/accounts/[id]/restore/route.ts` | In the non-merge restore branch only (after the `Promise.all` that reactivates shares), call `await regenerateSnapshotsForAccounts([id])`. Skip in the duplicate-merge branch (canonical account's balance doesn't change on merge). |
| `app/api/accounts/manual/[id]/restore/route.ts` | Same: add `await regenerateSnapshotsForAccounts([id])` after the restore `Promise.all`, non-merge branch only. |
| `app/api/accounts/wallet/route.ts` | In the `archivedFa` reactivation branch only (the "no active match, reactivate archived wallet" path), add `await regenerateSnapshotsForAccounts([archivedFa.id])` after the share upsert. The `activeFa` branch and the brand-new-wallet branch don't change any space's dollar total (merge doesn't move balance; new wallets start at $0), so no regen needed there. |

Total: 4 files, ~4-6 lines each, all additive, all calling functions that already exist and are already exercised by the Plaid paths. No new exports, no new tables, no touching `WorkspaceAccountShare` rename rules, no billing/messaging tables — fully within the standing guardrails.

### Impact map
- **Affected:** today's `SpaceSnapshot` row for any space containing an account that gets archived or restored. Recomputed via the same `getAccounts()` + `classifyAccounts()` formula already used by Plaid refresh — no formula change.
- **Not affected:** historical `SpaceSnapshot` rows (prior days are untouched, matching "historical snapshots may remain historical"). `FinancialAccount`, `WorkspaceAccountShare`, `AccountConnection` mutation logic is unchanged. No Prisma schema/migration involved — this is pure application code wiring.
- **Blast radius:** archive route (`DELETE /api/accounts/[id]`), 3 restore code paths. Nothing else calls these functions today, so no other surface is touched.

### Rollback plan
- Pure code change, no migration. Revert is a plain `git revert` of the 4 files.
- If `regenerateSpaceSnapshot` throws for any space, the try/catch ensures the archive/restore itself still succeeds (matches existing "best-effort, non-fatal" convention) — worst case is the old bug persists for that one request, not a new failure mode.

### Validation checklist (to run after approval + implementation)
- `npx tsc --noEmit`
- `npx prisma generate` (no schema change expected, but cheap to confirm)
- `npm run lint`
- Manual/route exercise: archive a sandbox Plaid account → confirm `SpaceSnapshot` row for that space updates immediately (query it directly) → confirm Spaces index card and Net Worth chart reflect the new total without needing a Plaid refresh.
- Restore the same account → confirm the snapshot updates again, and confirm the duplicate-merge branch (restoring into an existing canonical account) still skips regen correctly (no regression there — covered by D1's existing merge-path tests).
- Confirm a Space with multiple accounts, where only one is archived, still nets out correctly (no double-counting, no other account dropped).

## 5. Holding pattern

Per project rules, this stays a proposal until approved — no schema/migration/route edits have been made. Once approved, I'll implement exactly the 4 files above, run the validation checklist, and report back before D2 resumes.

## 6. Implementation summary (approved + implemented)

Status: **implemented exactly as proposed in §4. No schema, migration, formula, or UI changes.**

| File | Change made |
|---|---|
| `app/api/accounts/[id]/route.ts` (`DELETE`) | Added step "3b": loops the pre-revocation `fa.workspaceShares` list, calls `regenerateSpaceSnapshot(spaceId)` per distinct space, try/catch + `console.warn`, non-fatal. |
| `app/api/accounts/[id]/restore/route.ts` | Added `await regenerateSnapshotsForAccounts([id])` after the restore `Promise.all`, non-merge branch only, try/catch + `console.warn`. |
| `app/api/accounts/manual/[id]/restore/route.ts` | Same pattern, non-merge branch only. |
| `app/api/accounts/wallet/route.ts` | Added `await regenerateSnapshotsForAccounts([archivedFa.id])` in the archived-wallet reactivation branch, after the share upsert. |

No edits to `lib/snapshots/regenerate.ts`, formulas, UI components, or D2/provider files.

### Validation results

| Gate | Result |
|---|---|
| `npx tsc --noEmit` | **Pass** — exit 0, zero output. |
| `npx prisma generate` | **Blocked by sandbox network policy** (same pre-existing limitation as D1/D11: engine binaries fetch from `binaries.prisma.sh` returns 403 in this sandbox, including with `PRISMA_ENGINES_CHECKSUM_IGNORE_MISSING=1`). No schema change in this fix, so this gate is informational only — not a sign-off blocker. |
| `npm run lint` | **Pass** — exit 0, 0 errors. 4 pre-existing warnings, all `@next/next/no-img-element` in unrelated files (`AccountModal.tsx`, `TotpSection.tsx`, `CoinIcon.tsx`), untouched by this change. |
| Manual archive/restore exercise | Not run — sandbox has no live Postgres connection (established limitation). Logic mirrors the already-proven Plaid refresh/exchange-token call sites exactly, and the share-status timing subtlety (capture-before-revoke on archive) is handled per §4. |

Total diff: 4 files, ~6 lines added each, all additive, all calling pre-existing helpers. D2 may resume.
