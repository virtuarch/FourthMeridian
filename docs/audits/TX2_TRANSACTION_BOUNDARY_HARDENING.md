# TX-2 — Transaction Read Boundary Hardening

**Status:** IMPLEMENTED. Containment slice — no Transactions-workspace redesign, no server pagination, no new projection model.
**Date:** 2026-07-20.
**Source:** `docs/audits/TX1_TRANSACTION_READ_AUTHORITY_AUDIT.md`. TX-2 removes unbounded raw transaction loading from the shared loaders and their leaky consumers, copying the AI assembler's proven `cap + window + truncation sentinel` pattern.

---

## 1. The new loader contract

`getTransactions` / `getDebtTransactions` (`lib/data/transactions.ts`) are now **bounded** and return a result object instead of a bare array:

```ts
getTransactions({ spaceId?, windowDays?, limit? }): Promise<BoundedTransactions>
interface BoundedTransactions { rows: Transaction[]; truncated: boolean; limit: number; windowDays: number | null }
```

- **Default `limit = DEFAULT_TX_LIMIT` (5000)** — the same cap the AI assembler uses. The query fetches `take: limit + 1` and `capFetched` derives `truncated` without a second query.
- **Optional `windowDays`** — a UTC date floor (`windowFloorDate`); `null` (default) applies no date floor (the row cap still bounds the read).
- **Ordering preserved** (`date desc`), so the returned slice is the **most-recent** window; only the oldest tail is dropped when truncated.
- **Semantics preserved:** for a population **at or under the cap** the returned rows are byte-identical to the old unbounded read (`truncated: false`, same array). So DayFacts / Cash Flow / FlowType folds over the returned rows are unchanged. Above the cap, `truncated: true` is an **honest** signal — no silent fake completeness.
- The population + KD-15 visibility + soft-delete filters are extracted into one shared **`bankingTransactionWhere(spaceId, { debtOnly? })`** so the loaders and cheap aggregate readers can never disagree on the population.
- The pure primitives (`DEFAULT_TX_LIMIT`, `capFetched`, `windowFloorDate`) live in `lib/data/transaction-bounds.ts` (server-only-free) so they are unit-testable, and are re-exported from `transactions.ts`.

**Success criterion met:** a new engineer can no longer write `getTransactions(spaceId)` and unknowingly load five years of history — the default is a bounded page, and the source-scan tripwire (`transactions.population.test.ts`) fails CI if a loader drops `take: limit + 1`.

---

## 2. Callers changed

| Caller | Classification | Change |
|---|---|---|
| `app/api/spaces/[id]/transactions/route.ts` | Browser (future pagination candidate) | Unwrap `.rows`; surface `truncated` in the payload so the UI can honestly say "showing the most recent N". Default cap applies. |
| `lib/export/assemble.ts` | Export/batch | **TX-2E** — pass `limit: EXPORT_TRANSACTION_CAP` so the per-space query caps (no per-space full-history materialization). The existing combined `capTransactions` still trims to the same total; result is identical (global most-recent N ⊆ each space's most-recent N). |
| `app/(shell)/dashboard/credit/page.tsx` | Browser + intelligence (Debt) | Unwrap `.rows` from `getDebtTransactions` (default cap). |
| `lib/ai/intelligence/debt-payments.ts` | Intelligence (bounded window) | **TX-2B** — unwrap `.rows`; the in-memory window filter is unchanged. The AI debt intel now inherits the loader bound automatically (no separate AI fix). |
| `app/api/accounts/[id]/transactions/route.ts` | Browser (per-account modal) | **TX-2D** — `take: DEFAULT_TX_LIMIT + 1` + `capFetched`; returns `truncated`. A heavy multi-year account no longer returns thousands of rows to the modal. |
| `app/api/money/view-context/route.ts` | Intelligence (FX coverage) | **TX-2C** — replaced the full `getTransactions` load with two cheap `groupBy` aggregates (distinct `currency`, distinct `date`) over `bankingTransactionWhere`. Loads NO transaction rows; coverage is equivalent (same distinct currency/date sets), bounded by calendar days not transaction count. |

**Blast radius:** 6 callers + one route response shape (`truncated` added). Cash Flow and the Calendar heatmap consume the route's `transactions` array unchanged — they are transparently bounded by the route's now-capped fetch, with no fold change.

---

## 3. Callers intentionally deferred

- **The Transactions workspace UI** (`SpaceTransactionsPanel` / `use-space-data`) — still client-heavy (loads the payload array, filters/searches/paginates in the browser). TX-2 caps the *payload* so it can never exceed 5000 rows; **server-side pagination + filter/search is TX-3** (see §5). Intentionally untouched here.
- **The `truncated` UI banner** — the route now returns `truncated`, but wiring a "showing the most recent N — [see all]" banner into the panel is part of the TX-3 browsing work (the user asked not to redesign the workspace in TX-2).
- **Export streaming** — TX-2E moved the cap into the query (removing the per-space memory cliff); true streaming of a larger export remains **TX-3/4**.
- **`merchant-merge-review` full-table `groupBy`** (admin) and the dead `getInvestmentTransactions` — **TX-4** cleanup (out of TX-2 scope).

---

## 4. Tests

- **`lib/data/transactions-bounding.test.ts`** (new) — BOUNDARY (default is a finite cap; both loaders default to `DEFAULT_TX_LIMIT`), TRUNCATION (fetched `limit+1` → `rows == limit`, `truncated == true`; exactly `limit` → false), SEMANTIC (under-cap returns the SAME array reference → fold input byte-identical; truncation keeps the most-recent front slice), WINDOW (`windowDays 800` → correct UTC floor; `null` → no floor), plus consumer tripwires (account route bounded; view-context uses `groupBy` not `getTransactions`; export passes the explicit cap).
- **`lib/data/transactions.population.test.ts`** (updated) — the population/visibility/soft-delete invariants now assert on the shared `bankingTransactionWhere` builder + that each loader delegates to it, plus a new `take: limit + 1` bounded-read tripwire.
- **Semantic guards unchanged and green:** `financial-doctrine-oracle.test.ts` (265 checks — classifier v4 FROZEN), `serialize.golden.test.ts`, cash-flow tests — proving FlowType + DayFacts + serialization semantics are untouched.
- **Suite:** 301/302 in a clean env (the 1 failure is the pre-existing marketing-boundary check on concurrent-session files). tsc + eslint clean.

---

## 5. Why TX-3 is separate

TX-2 is a **backend containment slice**: it caps what the loaders return and moves the FX-coverage read to aggregates. That removes the reliability/cost cliff (the response can no longer exceed 5000 rows) with a tiny blast radius and **zero semantic change** for every user under the cap.

**TX-3 is a UI-architecture slice**: the Transactions workspace still fetches an array and does all filter/search/sort/paginate in the browser. Making *browsing* scale to 100k+ rows needs a **server-paged API** (cursor + server-side filter/search) and a client migration off the "one array in React state" model — a larger, higher-risk change that touches the workspace UX. Keeping them separate lets TX-2 close quickly and de-risk beta *now*, while TX-3 is scheduled once real usage confirms the browser (not the intelligence loads TX-2 already fixed) is the bottleneck. They do not conflict: TX-3 builds on TX-2's bounded loader contract.

**Deferred, unchanged:** Transactions UI redesign, TimelineLens migration, PO-4B, CONN, financial ontology.
