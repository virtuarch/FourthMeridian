# Fourth Meridian — Dead Route Cleanup (history · holdings · investments): Completion Summary

**Date:** 2026-07-13
**Branch:** `feature/v2.5-spaces-completion` (directly on primary — no worktree)
**Source audit:** `FOURTH_MERIDIAN_ROUTE_REACHABILITY_AUDIT_2026-07-13.md` (the Fable page-reachability pass) — Tier 1, "Confirmed dead: no inbound edge of any kind"

---

## 1. What shipped

The three Tier-1 confirmed-dead dashboard routes, plus every component/lib file exclusively used by them, are deleted. **One commit per route, three commits**, each gated with `npx tsc --noEmit` + `npm test` (200/200) before commit.

| # | Commit | Route | Files removed | LOC |
|---|---|---|---|---|
| 1 | `9a5b02d` | `/dashboard/history` | `page.tsx` | 88 |
| 2 | `4e513dd` | `/dashboard/holdings` | `page.tsx` | 85 |
| 3 | `3e89933` | `/dashboard/investments` | `page.tsx` (47) + `InvestmentsClient.tsx` (744) + `AssetDrawer.tsx` (210) + `TradingViewChart.tsx` (122) + `lib/exchangeSymbol.ts` (32) | 1,155 |
| | | | **7 files** | **1,328** |

Superseded by, respectively: the Wealth Perspective + time machine (history), the Investments Perspective holdings view (holdings), and the Investments Perspective (redesigned 2026-07-12) + Investments time machine (investments). The LOC total is **1,328** by `wc -l`; the audit's estimate was 1,335 — the small delta is trailing-newline / rounding in the audit's per-file figures, not a scope difference.

---

## 2. Re-verification discipline — every inbound edge checked before deletion

Per the request (and mirroring every dead-code deletion this week), the audit's dependent list was **not** taken on trust. For each route I re-checked, across `app/ components/ lib/ jobs/ scripts/ prisma/ middleware.ts`, for: static `href`s, template-literal `href`s, `router.push` / `router.replace` / `redirect(...)`, server-side references (API routes, middleware, onboarding/Brief actions, the notification registry), and tests.

**`/dashboard/history`** — zero references outside its own `page.tsx`. Every symbol it imported (`getRecentSnapshots`, `getSpaceContext`, `formatDate`, `NetWorthChart`, `DataCard`) has other live callers → **no exclusive dependents**; only the page file was removed. `NetWorthChart` explicitly stays (the audit flagged "chart stays, page goes").

**`/dashboard/holdings`** — zero references outside its own `page.tsx`. Every import (`getAccounts`/`getHoldings`, `buildSpaceConversionContext`, `convertMoney`, `EstimatedChip`, `DataCard`, lucide icons) has other live callers → **no exclusive dependents**; only the page file was removed.

**`/dashboard/investments`** — zero inbound edges to the path. The exclusive-dependent chain was verified acyclic and self-contained:
- `InvestmentsClient` — imported only by the deleted page.
- `AssetDrawer` — imported only by `InvestmentsClient`.
- `TradingViewChart` — imported only by `AssetDrawer` (a third-party embed nothing else uses).
- `lib/exchangeSymbol.ts` — imported only by `InvestmentsClient`.

**One finding that corrected the audit:** the audit said `lib/exchangeSymbol.ts` "goes entirely," and it does — but my grep surfaced `components/ui/CoinIcon.tsx` naming `exchangeSymbol`. On inspection those are **two comments only, no `import`**, and `CoinIcon` is itself **live** (used by `InvestmentAccountsWidget`). So `CoinIcon` was left untouched and `exchangeSymbol.ts` was still safe to delete. (The two now-stale comment mentions in `CoinIcon` are harmless and were left alone to avoid touching a live file; noted here for the record.)

**Not inbound edges (verified, deliberately left in place):**
- The `?tab=investments` legacy mapper in `app/(shell)/dashboard/page.tsx` resolves a query string to a shell **tab**, not to the deleted route — the audit says prune it during the UX sweep, not now.
- All `/api/spaces/[id]/investments*` routes, `lib/investments/**`, and `InvestmentsPerspective` / `useInvestmentsTimeMachine` are the **live successor stack**, not the dead page chain.

`tsc --noEmit` passing after commit 3 is independent confirmation the four dependents had no other importer — a dangling import would have failed the typecheck.

> Note on the gate: deleting an App Router route leaves Next's **generated** route validators (`.next/types/validator.ts` and the dev-server `.next/dev/types/`, both git-ignored build artifacts) transiently referencing the removed `page.js`. These were regenerated with `npx next typegen` (and the stale dev cache cleared) so each `tsc --noEmit` gate reflects true source state, not a stale build cache. No source file needed changing.

---

## 3. Explicitly out of scope — left untouched

Per the request and the audit's own tiering, the reachable-but-vestigial routes were **not** deleted — they are confirmed live or load-bearing and get retargeted/redesigned as their own decisions:

- **`/dashboard/banking`** — one live inbound edge the audit caught (`` href={`/dashboard/banking?account=${id}`} `` in the current `AccountsPerspective`, with a test asserting it). Retire with Transactions-tab phase 2.
- **`/dashboard/advice`** — reserved for v2.6a Advisor Intelligence; the `OPPORTUNITY_FOUND` notification-registry entry deep-links here. Don't delete without touching the registry.
- **`/dashboard/accounts`** — load-bearing for onboarding: `app/api/brief/route.ts` server-generates 8 hrefs to it. Retire after those + the 2 `BriefNewUser` CTAs are retargeted.

No `banking`, `advice`, or `accounts` file was modified in any of the three commits.

---

## 4. Validation

- `npx tsc --noEmit` — **exit 0** after each of the three deletions (baseline was also 0).
- `npm test` — **200/200 passed** after each of the three deletions. No test referenced any deleted route or component (confirmed by grep before starting; suite count unchanged at 200).
- Working tree: only the intended deletions committed; each commit made with an explicit pathspec (per the concurrent-branch commit discipline).

**Net:** 7 files, **1,328 LOC** removed across 3 commits; typecheck and full suite green throughout; `banking` / `advice` / `accounts` left entirely untouched.
