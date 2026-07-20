# TX-3.1b — Transaction Query Contract Hardening

**Type:** Contract slice. Pure core + server authorities only — **no consumer, no UI, no schema migration, no index.**
**Date:** 2026-07-20.
**Closes:** the seven must-fix findings in `TX3_QUERY_CONTRACT_REVIEW.md`.

---

## 1. What shipped

| Finding | Resolution |
|---|---|
| **M1** amount sorting is a different sort | **Removed.** `TransactionSort = "newest" \| "oldest"`. |
| **M2** cursor not sort-tagged | `TransactionCursor.sort` + `resolveCursor` + `cursorReset` on the result. |
| **M3** no input validation | `parseTransactionQuery` — a pure, injected-vocabulary parser boundary. |
| **M4** sort keys are mutable | Documented in the contract; `cursorReset` gives consumers the reset signal. |
| **M5** derived filters | `sources` added (SQL-expressible). `transferDisposition` / `needsClassification` **deferred** — see §3. |
| **M6** `merchantId` dead filter | `merchantId` added to the shared list DTO. |
| **M7** no aggregate concept | `aggregateTransactions` — a sibling authority sharing `buildFilterWhere`. |

Plus one latent bug found while implementing: `text` was assigned to a top-level `where.OR`. Adding `sources` (also OR-shaped) would have **silently clobbered one of them**. `buildFilterWhere` now composes an `AND` array of independent fragments, making key collision structurally impossible. Pinned by a test.

---

## 2. M1 — why amount sorting was removed rather than documented

```
product:  Math.abs(convert(amount, row.date))     ← absolute, FX-converted
SQL:      ORDER BY amount                          ← signed, native
```

Two independent divergences: **sign** (which disagrees even in a single-currency Space, where FX is the identity) and **FX**. Prisma has no expression ordering, so `ORDER BY abs(amount)` is unreachable without raw SQL plus a functional index — and there is no index on `amount` at all.

Option B (document native behavior) would ship a sort that is wrong for every user and call it documented. Option C (a persisted reporting amount) is a schema + FX-doctrine slice explicitly out of scope.

**The intended replacement primitive is amount RANGE FILTERING** (`amountMin` / `amountMax` on magnitude): it answers most of what the sort was used for ("show me the big ones"), it is exact, it needs no FX, and it is indexable. Not built here — no consumer needs it yet.

Guarded by tripwires: the pure core cannot regain an amount-keyed `orderBy`, a `largest`/`smallest` vocabulary, or a `lastAmount` cursor field without failing tests.

---

## 3. M5 — the derived-filter deferral (doctrine, not omission)

`transferDisposition` and `needsClassification` are **not columns**. The schema says so explicitly:

```
schema.prisma:1710   "TransferDisposition is derived downstream, not persisted."
schema.prisma:1881   "TransferDisposition is computed at read time, never persisted."
```

They are computed *after* the query by `contextFields` → `deriveTransactionContext` (`lib/data/transactions.ts:258-284`) from ~10 raw columns **plus** `isOwnedCounterparty`, which itself depends on a read-time transfer-match query run over the fetched page.

The mission's rule was: recreate them only if a persisted authority already exists. **It does not.** Pushing them into SQL would require reimplementing the derivation as a Prisma predicate *and* the counterparty resolution as a join — a second derivation authority, exactly the fork TX-3.0 was built to avoid. Filtering them client-side over a page would render 4 rows of 50 and call it a page.

**Deferred as a future intelligence projection.** The correct shape, when demand justifies it: a CF-1 follow-up materializes both as columns at classification/write time (one write authority, one derivation), after which they become ordinary indexed filters and drop into `buildFilterWhere` unchanged. Until then the explorer does not offer them.

`source` was the opposite case and **is** shipped: `deriveSource` is pure precedence over two real columns (`importBatchId`, `plaidTransactionId`), so `sourceWhere` mirrors it exactly and the DTO field and the filter cannot disagree.

---

## 4. M7 — the aggregate authority

`aggregateTransactions({ spaceId, query }) → { count, totalsByFlowType, currency, estimated }`.

**Parity by construction.** It shares `bankingTransactionWhere` and `buildFilterWhere` verbatim with `queryTransactions`, so the count and the list are the same population structurally, not by convention. The only intentional difference: an aggregate never applies the keyset — a total is a property of the filtered SET, not of a page through it. Tripwired.

**Exactness.** A naive `SUM(amount)` would repeat M1's mistake. Instead: group by `(flowType, currency, date)` **split by sign**, then convert each group at its own date.

```
Σ |convert(aᵢ, d, c)| = convert(Σ|aᵢ|, d, c)      [rate > 0 ⇒ linear, sign-preserving]
positives → Σ|aᵢ| =  Σaᵢ ;  negatives → Σ|aᵢ| = −Σaᵢ    i.e. |Σaᵢ| in both cases
```

This reproduces the client's per-row `Math.abs(convertMoney(...))` **exactly** — asserted by a test that computes both ways over a mixed two-currency, two-rate, two-sign dataset and compares. The sign split is load-bearing: netting inflows against outflows gives `|1000 − 300| = 700` where the product shows `1300`; there is a dedicated test for that.

Cost: one `count` + two `groupBy` in parallel. A single-currency Space resolves through the identity fast path with **zero** FX archive lookups. The response is a handful of numbers regardless of range.

`estimated: true` when any contributing group hit a rate miss or a null-currency residue — so presentation can degrade honestly rather than present an estimate as exact.

---

## 5. M4 — mutable sort keys (documented, not "fixed")

`lib/plaid/syncTransactions.ts:383/445/463` updates `date`, `amount`, and `pending` **in place on the same row id** during a pending→posted transition. Keyset's no-duplicate/no-skip guarantee holds for an *immutable* key; the pure test proves it over a static dataset.

This is not fixable in the query layer and does not argue against keyset (offset is strictly worse here). Consequences, now stated in the contract:

- Date sorts are low-risk — posted dates move by days, and a `newest` scroll moves away from the volatile recent edge.
- Amount sorts were the high-risk case; they are gone (M1), for this reason among others.
- **Consumers must dedupe appended pages by `id`.** Rows may also legitimately disappear mid-scroll via soft-delete, which only shrinks the result.

No as-of snapshot pin was added — that would reintroduce the Perspective-time coupling TX-3.0 correctly rejected.

---

## 6. Verification

- `transaction-query-core.test.ts` — scale clamp, ordering, keyset comparators, **M1 doctrine tripwires**, **M2 cursor safety** (mismatch rejected, stale-cursor reset always raised, opaque-token round-trip + tamper/truncation/unknown-sort → null), **M3 parser safety** (malformed dates, impossible calendar dates, inverted ranges, unknown enums, non-boolean pending, clamped limits, error accumulation), filter mapping, source precedence, **OR-collision**, and the pagination invariants (no dup / no missing / same-day contiguity) at page sizes 2 and 1.
- `transaction-aggregate-core.test.ts` — magnitude folding, the sign-split proof, the **exactness proof** vs per-row conversion, per-date rate application, honesty flags, edge cases.
- `transaction-query.test.ts` — source-scan: single population authority, no offset, cursor resolution + reset on every return path, no amount ordering, aggregate/query filter parity, aggregate applies no keyset and returns no rows, merchant pivot has a DTO source.
- `merchant-schema.test.ts` — `transaction-query-core.ts` added to the MI `READ_SURFACES` allowlist (it holds a `merchantId:` WHERE fragment and has no db handle; same category as the three modules already listed). The guard itself was not weakened.
- **tsc clean, eslint clean, `309/310` unit** — the one failure is the pre-existing `marketing-boundary` break from a concurrent session's `MarketingNav.tsx` / `Reveal.tsx`, unrelated to this slice (baseline before the slice was `306/307` with the same single failure).

---

## 7. What TX-3.1b deliberately did NOT do

No consumer, no route, no UI, no index migration, no schema change, no reporting-amount column, no FX persistence, no `pg_trgm`, no amount range filter (no consumer yet), no `transferDisposition` / `needsClassification` filters (§3).
