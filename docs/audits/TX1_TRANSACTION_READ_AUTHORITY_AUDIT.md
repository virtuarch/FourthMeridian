# TX-1 — Transaction Read Authority & Scale Investigation

**Status:** INVESTIGATION COMPLETE. **No code changed** — audit + design only.
**Date:** 2026-07-19.
**Method:** four parallel adversarial read-only investigations — (1) exhaustive reader inventory, (2) semantic-boundary verification, (3) transaction-workspace architecture at scale, (4) indexes / export / AI / jobs / provider-scale. Every claim is `file:line`-cited.

---

## 1. Executive summary

**Is there a real beta risk?** **Yes — but it is localized, and it is not a "millions of transactions" problem.** The user-facing transactions browser ships the **entire** transaction dataset over the wire and does 100% of filter/search/sort/paginate in the browser. On serverless (Vercel), the `GET /api/spaces/[id]/transactions` response hits the **~4.5 MB body limit at roughly 10–15k rows** — long before "250k". A realistic power user (10 banks + 2 brokerages + crypto, 5 years ≈ **28–35k rows**) is **already over that line**. So the risk surfaces with the **first heavy multi-institution / multi-year user**, potentially in the first cohort — not at 1,000 users.

**Is it a transaction-model problem, or right boundaries with a few leaky consumers?** **The latter, decisively.** The projection architecture is correct almost everywhere: Wealth reads `SpaceSnapshot`, Investments read the `PositionObservation` spine, the Daily Brief reads the assembled AI context, and the AI assembler reads a **capped** window (5,000 rows + truncation sentinel + 800-day clamp). The risk is concentrated in **one function** — `getTransactions` (unbounded) — plus its twin `getDebtTransactions` and the per-account modal route. It is **not** an architecture overhaul; it is a handful of unbounded raw loaders.

**Is it urgent? Priority?** **Medium–high, staged.** Not a launch blocker for a *small, supervised* beta with modest-history users. But the cheap fix (bound the shared loaders) should land **early in beta, before onboarding power users**. Full browser pagination can follow once real usage confirms it. Indexes are **not** the problem and need no additions.

**One-line answer:** Fourth Meridian has the right projection boundaries; a small number of unbounded raw-transaction loaders — chiefly `getTransactions` — and a fully client-side transactions browser are the entire risk. Fix by *bounding the loaders* (cheap) and *server-paging the browser* (targeted), not by re-architecting the transaction model.

---

## 2. Findings table

| # | Area | Current state | Risk | Recommendation |
|---|---|---|---|---|
| A | **`getTransactions`** (`lib/data/transactions.ts:132`) | `findMany`, no `take`/`cursor`/`date`; loads a Space's entire banking history. Fans into: Space transactions API, view-context (FX), export, Cash Flow, Calendar heatmap. | **Future scale blocker** — widest blast radius | Add cap + date-window + truncation sentinel (copy the AI assembler). **TX-2** |
| B | **Transactions workspace** (`SpaceTransactionsPanel` + `use-space-data` + `/api/spaces/[id]/transactions`) | Fully client-heavy: server ships the whole dataset; browser owns filter/search/sort/paginate. `page` is `Array.slice`. No server pagination primitives. | **Future scale blocker** — breaks at ~10–15k rows (serverless body limit) | Server-paged browsing API (cursor + server filter/search) + client migration off "one array in state". **TX-3** |
| C | **`getDebtTransactions`** (`lib/data/transactions.ts:220`) | Same unbounded shape; feeds the Credit page + AI debt-payments intel. | **Needs fixing before beta** | Same bounding as A. **TX-2** |
| D | **Per-account modal** (`app/api/accounts/[id]/transactions/route.ts:49`) | `findMany` by `financialAccountId`, no `take`/`date`. | **Needs fixing before beta** | Cap + date-window. **TX-2** |
| E | **`/api/money/view-context`** (`:39`) | Loads all transactions on every dashboard mount just to enumerate currency/date pairs for FX. | **Needs fixing before beta** | Derive coverage from a cheap `groupBy`/`distinct`; short-circuit single-currency Spaces. **TX-2** |
| F | **Export** (`lib/export/assemble.ts:128`) | Loads N × full-history (per membership) into memory, then caps at 5,000; ZIP built fully in memory (no streaming). | Acceptable pre-beta (on-demand, 3/day) | Push the 5,000 cap into the query; consider streaming later. **TX-2 (query cap) / TX-3 (stream)** |
| G | **Calendar heatmap** (`TransactionsCalendarHeatmap.tsx:10`) | Own inline `bucketNetByDay` fold over the in-memory full list; ignores `projectDailyFacts`. | Acceptable pre-beta (reuses loaded rows) | Consume the canonical daily projection. **TX-4 (cleanup)** |
| H | **AI debt-payments** (`lib/ai/intelligence/debt-payments.ts:41`) | Calls uncapped `getDebtTransactions`, windows in memory — bypasses the assembler cap. | Acceptable pre-beta | Use the bounded loader (auto-fixed by C). **TX-2** |
| I | **`merchant-merge-review`** (`lib/transactions/merchant-merge-review.ts:72`) | `groupBy` with **no `where`** = full-table scan across ALL users. Output bounded. | Future scale blocker (admin-only → low urgency) | Scope the `groupBy` or defer; admin surface. **TX-4** |
| J | **`getInvestmentTransactions`** (`lib/data/transactions.ts:269`) | Unbounded, but **zero live consumers (dead)**. | Acceptable (dead) | Add cap before it's ever revived, or delete. **TX-4** |
| K | **Indexes** (`Transaction`, schema `:1901-1912`) | `[financialAccountId, date]` backs the hot shapes; aggregates are DB-side. `deletedAt`/`pending` unindexed (low selectivity). `[counterpartyAccountId]` has no reader. | **Safe** — not the bottleneck | **Add none.** Optionally drop the unused `[counterpartyAccountId]` index (write-cost only). |
| L | Wealth · Investments · Brief · AI assemblers · background jobs | Consume `SpaceSnapshot` / `PositionObservation` / assembled context / capped windows; jobs push aggregation into Postgres + keyset-paginate. | **Safe** — correct boundaries | None. These are the model to copy. |

---

## 3. Reader inventory (condensed)

The exhaustive inventory found **49 Transaction readers**. The safe majority: single-row (`findFirst`/`findUnique`), DB-side aggregates (`groupBy`/`count`/`aggregate` — all wealth/snapshot/diagnostic reads), explicitly capped (`take: 300`/`5000`/`5000+1`), narrow equality-`where` dedupe reads (Plaid/CSV/BTC import), and keyset/cursor-paginated batch scripts. **The complete unbounded set is just five readers:**

| Reader | file:line | Classification | Rating |
|---|---|---|---|
| `getTransactions` | `lib/data/transactions.ts:132` | user-browsing + intelligence | **Future scale blocker** |
| `getDebtTransactions` | `lib/data/transactions.ts:220` | user-browsing + intelligence | **Needs fixing before beta** |
| account-modal route | `app/api/accounts/[id]/transactions/route.ts:49` | user-browsing | **Needs fixing before beta** |
| `merchant-merge-review` (no `where`) | `lib/transactions/merchant-merge-review.ts:72` | operations (admin) | Future blocker (low urgency) |
| `getInvestmentTransactions` (dead) | `lib/data/transactions.ts:269` | intelligence | Acceptable (dead) |

Everything else — 44 readers — is **Safe**. The AI assembler (`lib/ai/assemblers/transactions.ts:352,1322`) is the reference pattern: `take: TRANSACTION_FETCH_LIMIT + 1` (5,000) with a truncation sentinel and a `date` floor/ceiling (`MAX_EXPLICIT_WINDOW_DAYS = 800`).

---

## 4. Semantic boundary review

**`DayFacts` is NOT a persisted model** — it is a pure read-time fold (`aggregateDayFacts`/`projectDailyFacts`, `lib/transactions/cash-flow-projection.ts:172,182`) over host-loaded transactions. That is fine *in shape*; the weakness is that its **input load is unbounded** (`getTransactions`). The durable projection tier that *does* exist — `SpaceSnapshot` (wealth) and `PositionObservation` (investments) — is consumed correctly.

| Surface | Consumes | Input bounded? | Verdict |
|---|---|---|---|
| Cash Flow | read-time DayFacts fold over `getTransactions` | ❌ no cap/window | Weak boundary (unbounded input) |
| Calendar heatmap | own inline day-fold over the in-memory list | ❌ (reuses loaded rows) | **Violation** — ignores `projectDailyFacts` |
| Daily Brief | assembled `SpaceContext_AI` | n/a (no direct financial query) | ✅ Correct |
| AI assemblers | capped raw → summary; `SpaceSnapshot`; `PositionObservation` | ✅ 5,000 + 800-day | ✅ Correct (reference) |
| AI debt-payments | uncapped `getDebtTransactions` | ❌ | Weak — bypasses cap |
| Wealth / Net Worth | `SpaceSnapshot` via `getRecentSnapshots` | ✅ `take: -days` | ✅ Correct |
| Debt page | `lib/debt.ts` fold over `getDebtTransactions` | ❌ no cap/window | Weak boundary |
| Investments | `getCurrentPositions` (spine) | n/a — spine, not raw | ✅ Correct |

**Verdict:** no consumer is *architecturally* wrong (each correct surface reads the right projection). The only true violation is the Calendar heatmap re-folding raw rows instead of `projectDailyFacts`, and it's mitigated (no new query). The Cash Flow / Debt "weakness" is entirely the unbounded input load — fixed by bounding `getTransactions`/`getDebtTransactions`, not by changing the fold.

---

## 5. Database / index review

Indexes on `Transaction` (`schema.prisma:1901-1912`): `[financialAccountId]`, `[financialAccountId, date]`, `[date]`, `[importBatchId]`, `[financialAccountId, flowType, date]`, `[flowType, date]`, `[counterpartyAccountId]`, `[merchantId]`, `[categoryRuleId]`, plus unique `plaidTransactionId`.

- **The hot shapes are already backed.** Per-account sort (`[financialAccountId, date]`) and the `financialAccountId IN + date` groupBys (wealth/snapshot/diagnostics) are served by index `1902` as skip/range scans that aggregate in the DB. The `getTransactions` pain is **unbounded row count + full sort**, which **no index can fix** — an index can't limit "load the whole table". A secondary non-sargable factor (`flowType != INVESTMENT` negation, `deletedAt` unindexed) is dominated by the row-count problem.
- **Add no indexes.** A partial `[financialAccountId, date] WHERE deletedAt IS NULL AND pending = false` would help two aggregate walks, but `deletedAt`/`pending` are low-selectivity, so `1902` already captures ~99% of the benefit — not worth the write-amplification on the highest-insert table.
- **Only data-supported index *change* is a removal:** `[counterpartyAccountId]` (`1909`) has **no observed reader** (pure write cost today). Flagged, not urgent — it may be forward-looking (KD-18).

---

## 6. Export / AI / jobs / provider scale

- **Export** — no streaming/pagination at the DB level: `assembleUserExport` loops every ACTIVE membership and calls unbounded `getTransactions` per space, materializing N × full history before applying the 5,000-row cap; the ZIP is built fully in memory. On-demand + 3/day rate limit keep it low-urgency, but it shares root cause A.
- **AI** — bounded and safe (the reference): rolling 30/90-day window, explicit ranges clamped to 800 days, `take: 5000+1` sentinel. Reads snapshots + position spine for the rest.
- **Jobs** — **none scan the raw table**. sync-banks is cursor/incremental (Plaid); wealth/snapshot regen uses DB-side `groupBy`/`aggregate` over account-id sets + date windows; reconcile uses indexed `count`. Backfill scripts are keyset-paginated. No checkpoint machinery is needed because nothing walks raw rows.
- **Provider scale** — a 10-bank + 2-brokerage + crypto + 5-year user ≈ **28–35k `Transaction` rows** (~28k banking). Paths touching all of them in one request: `getTransactions` (A), `getDebtTransactions` (C), the per-account route (D), export (F). **Worst single path: `GET /api/spaces/[id]/transactions`** — full fetch + full sort + full serialize + full network payload, and it fires on **initial dashboard render** for flow-category Spaces (not just the Transactions tab), plus on display-currency change via view-context (E).

---

## 7. Recommended architecture & roadmap

**Do NOT build a new dedicated transaction projection read model (Option B).** The projections already exist and are correct; the DayFacts fold is fine — only its input is unbounded. A new read model is over-engineering. **Do NOT blanket-add cursor pagination everywhere (Option A alone)** — the intelligence surfaces (Cash Flow/Debt) don't need pagination, they need a **bounded window** for their fold; only the user-facing browser needs true pagination. The minimum correct solution is **per-consumer bounding + targeted pagination (Option C, in two moves):**

**TX-2 — Bound the shared raw loaders (small, low-risk, do EARLY in beta).**
Copy the proven AI-assembler pattern into the offenders:
- `getTransactions` / `getDebtTransactions`: add a `take` cap + default date-window + truncation sentinel (a bounded-history signal the intelligence folds already tolerate). This transparently fixes Cash Flow, Debt, the Calendar heatmap (its input list), and AI debt-payments in one move.
- `/api/money/view-context`: derive currency/date coverage from a cheap `groupBy`/`distinct`; short-circuit single-currency Spaces.
- Per-account modal route + export: query-level cap.
This raises the breaking point dramatically and removes the "full history on a normal page load" behavior — the cheap, high-value fix that matches the "few leaky consumers" reality.

**TX-3 — Server-paged transaction browsing (larger, schedule after TX-2).**
The Transactions workspace genuinely needs it (it's the only place that does): a cursor/offset browsing API with **server-side filter + search + sort**, and a client migration off the "one array in React state" model. This is the real fix for the user-facing browser at 100k+ rows. Gate it on observed need once beta usage confirms the browser (not just the intelligence loads) is the bottleneck.

**TX-4 — Boundary cleanup (low priority, opportunistic).**
Calendar heatmap → consume `projectDailyFacts`; scope `merchant-merge-review`'s `groupBy` (or defer — admin-only); cap/delete dead `getInvestmentTransactions`; consider dropping the unused `[counterpartyAccountId]` index.

**Sequencing rationale:** TX-2 is the evidence-justified pre-beta fix (bounds the blast radius of the one function that fans everywhere, cheaply). TX-3 is justified but larger and can be scheduled once a real user's browsing (not their dashboard's intelligence loads) proves it. TX-4 is polish. No index work, no read-model rebuild, no transaction-model change.

---

## 8. Adversarial notes — where a future engineer could re-introduce the problem

- **`getTransactions` looks innocent** (it's "just the space's transactions") but has the widest fan-out in the codebase; any new dashboard widget that imports it inherits a full-history load. After TX-2, keep the cap + sentinel in the ONE function so new consumers are bounded by default.
- **The DayFacts fold invites full loads** — because the projection is read-time, a new intelligence surface will naturally reach for "load all transactions and fold." The bounded loader must be the only supported input.
- **Client-side filter/search feels free** at 500 rows and silently becomes a main-thread freeze at 50k. TX-3's server-side filter/search is what prevents that recurrence.
- **Export scales with membership count × history** — a future "export all my data" for a heavy multi-space user is a memory cliff even with the payload cap; the query cap (TX-2) is the real guard.

**No files were modified. This document is the TX-1 deliverable.**
