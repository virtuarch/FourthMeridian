# MC1 Phase 2 — Read-Time Conversion — Implementation-Ready Plan

**Status:** ✅ **IMPLEMENTED & CLOSED 2026-07-05** — delivered as approved: Slice 1 `030dc07`, Slice 2 `581bf65`, Slices 3–5 in the closing commits. 22 byte-identical golden checks pin behavior neutrality; target remains USD via `identityContext(DEFAULT_DISPLAY_CURRENCY)` at exactly six greppable sites. Exit evidence + Phase 3 entry findings (F-1…F-4): `MC1_PHASE2_CLOSEOUT_REPORT_2026-07-05.md`. Retained as the implementation record; the sections below are point-in-time design.
**Date:** 2026-07-05, verified against the working tree (Phases 0–1 complete and tagged; `FxRate` rows accumulating daily; zero product consumers).
**Governing doc:** `MC1_MULTI_CURRENCY_ROADMAP.md` §4 (approved). This plan turns §4 into slices and resolves its open decision #3 (conversion-context signature), driven by one decisive investigation finding (§1.1).
**Phase 2 goal (restated):** a shared money service converts monetary values at read time over the immutable FxRate archive, threaded through both aggregation families with the **target hardwired to USD** — provably byte-identical behavior. Stored financial facts are never mutated. No UI, no reporting-currency setting, no AI behavior change. Phase 2 builds the machine; Phase 3 turns the dial.

---

## 0. Executive summary

Phase 2 is one new pure module family (`lib/money/`), one async context builder bridging to `lib/fx`, and signature-additive threading through the two aggregation families the roadmap identified (balance family = `classifyAccounts`; transaction family = flow rollups). Zero schema. The load-bearing design decision, forced by investigation: **conversion context is a pre-resolved synchronous rate table** built server-side by an async factory — because every aggregation function is pure and synchronous today, and five of their callers are *client components* that can never call the rate service. The USD-era context is the rate-free `identityContext("USD")`, which any caller (client included) can construct synchronously — making Phase 2 live plumbing with zero behavior change, and isolating the real async/serialization work to exactly where Phase 3 needs it.

## 1. Investigation findings

### 1.1 The aggregators are synchronous and partly client-side (decisive)

- `classifyAccounts<T>()` / `sumBalances()` (`lib/account-classifier.ts`) — pure, sync. Callers: `lib/snapshots/regenerate.ts`, `lib/snapshots/backfill.ts`, `lib/perspective-engine/lenses/liquidity.core.ts`, `lib/ai/assemblers/accounts.ts` (server) **and `components/dashboard/DashboardClient.tsx`, `components/dashboard/widgets/KpiRow.tsx` (client)**.
- Transaction-family rollups — pure, sync: `lib/debt.ts` (`totalDebtPaid`, `rollupDebtPaymentsByAccount`; consumed by `app/api/ai/chat/route.ts` server-side **and `components/dashboard/DebtClient.tsx` client-side**), flow-cost totals in `components/dashboard/BankingClient.tsx` + `components/dashboard/widgets/SpaceTransactionsPanel.tsx` (client), and the AI monthly rollup accumulators in `lib/ai/assemblers/transactions.ts` (~L292–345, per-flowType `+=` over `txn.amount`).

Consequence: an async `convertMoney()` that hits the DB cannot live inside these functions. **Design: conversion happens through a `ConversionContext` — a synchronous resolver over pre-fetched rates.** Server code builds a real context asynchronously (one `lib/fx` pass); the USD identity context needs no rates at all and works everywhere, including client components. The Phase 3 flip inherits a named, pre-solved problem: client callers will need server-computed totals or a serialized rate table — recorded as **Phase 3 entry finding F-1**, not solved here.

### 1.2 Currency fields at the call sites

- `ClassifiableAccount` (`{ type, balance, syncStatus? }`) does **not** declare `currency` — but `classifyAccounts<T>` is generic and callers pass full account rows, which *do* carry `currency` at runtime on every server path (Phase 0 audit). Adding optional `currency?: string` to the interface is signature-additive with zero caller edits.
- Transaction rollup inputs (`DebtPaymentTxnLike`, assembler row selects) do **not** select `currency` today. Phase 2 extends the relevant `select` lists and row-shape types with `currency` (read-only, additive; rows are Phase 0-stamped).
- Absent/`null` currency on a row = pre-backfill residue → treated as **target currency + `estimated`** (identity math, honesty flag) — arithmetic identical to today, provenance-honest.

### 1.3 Seams already in place

`DEFAULT_DISPLAY_CURRENCY` (`lib/currency.ts`) is the designated target-currency source until Phase 3 moves it to the Space. `lib/fx/service.ts` (`createFxService`, `RateMiss` as value, walk-back staleness) is the only rate dependency. `formatCurrency` already accepts a currency override — formatting stays where it is (§2 D-5).

## 2. Decisions of record

| # | Decision | Resolution |
|---|---|---|
| D-1 | **Money domain model** | `Money = { amount: number; currency: string }` (native fact). `ConvertedMoney = { amount, currency /* target */, estimated: boolean, conversion: null \| { rate, from, effectiveDateISO, staleness, source? } }` — `conversion: null` for identity. `estimated` is true when: walk-back was used, a rate was missed, or the row's native currency was null-residue. Aggregates return `ConvertedTotal = { amount, currency, estimated }` (any estimated member taints the total). |
| D-2 | **Context signature** (roadmap open decision #3) | `ConversionContext = { target: string; resolve(from: string, dateISO: string): Resolution }` — synchronous, built ahead of time. Constructors: `identityContext(target)` (rate-free, sync, client-safe — the entire Phase 2 era) and `buildConversionContext({ target, currencies, dates })` (async, server-only, prefetches via `lib/fx` into a plain lookup table; exists in Phase 2 to be tested, consumed in anger by Phase 3). |
| D-3 | **RateMiss / degraded policy** | On miss (or null-currency residue): the native amount passes through unconverted with `estimated: true`. This is deliberately **today's blended behavior made honest** — a gap degrades honesty flags, never correctness of stored facts, and never throws on a read path. Exclusion-from-total rejected (would silently change totals). |
| D-4 | **Precision / rounding** | **No rounding inside `lib/money`.** Full f64 precision end to end; display rounding stays at the existing formatting boundary (`formatCurrency`, 2-dp conventions). Rationale: rounding-then-summing loses cents; the repo's tolerance convention (assembler cent-tolerance) already assumes late rounding. |
| D-5 | **Formatting boundary** | `lib/money` never formats. `lib/currency.ts` / `lib/format.ts` remain the only formatters. |
| D-6 | **Valuation dates** | Live balances convert at `yesterdayUTCISO()` (latest close); transaction rollups convert each row at **its own transaction date** (historical FX per row — roadmap §4.4). The context's `dates` prefetch covers both shapes. In Phase 2 both are identity, so this is contract + tests, not behavior. |
| D-7 | **Target source** | `DEFAULT_DISPLAY_CURRENCY` — one import, the seam already documented for exactly this. No new setting, no env, no per-Space value (Phase 3). |
| D-8 | **Aggregation strategy** | Convert-then-sum, per row (never sum-then-convert across currencies). Single-currency/identity sets short-circuit with zero resolver calls. |
| D-9 | **First consumer** | **The account classifier** (§3.3) — highest leverage, lowest risk. |

## 3. Architecture (implementation blueprint)

### 3.1 `lib/money/` layout

```
lib/money/
  types.ts     Money, ConvertedMoney, ConvertedTotal, ConversionContext
  convert.ts   convertMoney(money, dateISO, ctx) — pure, sync
               convertAndSum(items: {money, dateISO}[], ctx) — convert-then-sum
               identityContext(target) — rate-free context (client-safe)
  context.ts   buildConversionContext({target, currencies, dates}) — async, server-only;
               one lib/fx service pass → frozen lookup table → sync resolve()
  *.test.ts    pure suites (fake contexts/fixtures; no Prisma, no network)
```

`convert.ts` and `types.ts` import nothing from `lib/fx` except types (`Resolution` shapes); `context.ts` is the only fx-service caller and the only async surface. No module in `lib/money` imports `@/lib/db` — no-mutation is structural, not just disciplined.

### 3.2 `convertMoney` semantics (pure)

1. `money.currency == null` → `{ amount, currency: ctx.target, estimated: true, conversion: null }` (null-residue rule, D-3).
2. `money.currency === ctx.target` → identity: same amount, `estimated: false`, `conversion: null`. **The entire Phase 2 era takes this branch.**
3. Else `ctx.resolve(money.currency, dateISO)`:
   - `ResolvedRate` → `amount × rate` (rate is target-per-native via the fx service's cross-rate), `estimated = staleness === "walked-back"`, full conversion metadata attached (rate, effective date, staleness, source when known).
   - `RateMiss` → native amount, `estimated: true`, `conversion: null` (D-3).

`convertAndSum` maps rows through `convertMoney` with per-row dates and sums; total `estimated` = OR of members; deterministic (same archive ⇒ same output, inherited from Phase 1's immutability).

### 3.3 Conversion boundaries — where, and what goes first

| Candidate | Verdict | Why |
|---|---|---|
| **Account classifier** | **First consumer (Slice 3)** | The balance-family chokepoint: hero, lenses, dashboard, snapshot writers, and the AI accounts assembler all inherit from one function. Optional-context signature = zero forced caller edits; USD identity = byte-neutral. |
| Transaction-family rollups (`lib/debt.ts`, Banking/Space flow totals, AI monthly accumulators) | Second (Slice 4) | Same pattern, more call sites + `select` extensions; benefits from the classifier slice having proven the goldens harness. |
| Perspective engine | Not a call site | Consumes classifier output — inherits Slice 3 for free. |
| AI assemblers | Threaded, not converted | They call the two families; their own contract/prompt changes are explicitly out of scope (Phase 4 per the approved roadmap). |
| Dashboard totals (client) | Identity context only in Phase 2 | Real conversion for client-computed totals is Phase 3 finding F-1. |
| Snapshots | Writers inherit the classifier | `regenerateSpaceSnapshot`/backfill already consume `classifyAccounts`; still write USD-stamped totals (identity). Stored snapshot rows are **never re-derived or mutated** — chart readers untouched. |
| Reports/charts | Untouched | Read stored snapshot floats, as today. |

### 3.4 Behavior-neutral staging (the safety design)

- Optional trailing `ctx?: ConversionContext` on `classifyAccounts`/rollups; **absent context ⇒ exactly today's code path** (raw-float arithmetic, not even identity calls) — the permanent kill switch.
- Callers threaded in Phase 2 pass `identityContext(DEFAULT_DISPLAY_CURRENCY)` — arithmetic provably identical (identity branch performs the same `s + a.balance` accumulation on the same numbers).
- **Golden tests are the gate:** classifier output, snapshot writer fields, debt rollups, and the AI assembler section built with-context vs without-context on USD fixtures must be **byte-identical** (`JSON.stringify` equality). Non-USD correctness is proven at unit level only (fixture contexts), touching no product path.
- No UI, no selector, no reporting-currency setting, no AI prompt/contract change, no schema, no migration.

## 4. Validation plan

- **Unit (pure, auto-discovered):** `lib/money/convert.test.ts` — identity, null-residue, real-rate math, walk-back→estimated, miss→native+estimated, convert-then-sum, taint propagation, determinism (byte-equal repeats), no-rounding proof (sum of thirds); `lib/money/context.test.ts` — prefetch shape over a fake `FxArchiveReader`, frozen table, sync resolve parity with the fx service.
- **Golden/neutrality:** the §3.4 byte-identical suites, one per threaded family — these are the slice exit gates.
- **No-mutation proof:** structural (no `@/lib/db` import in `lib/money/convert|types`; `context.ts` read-only via the fx reader seam) + grep at closeout (no `update`/`create`/`delete` anywhere in `lib/money`).
- **Historical-rate behavior:** unit fixtures pin per-row-date resolution (a January row converts at the January rate even when a June rate exists) — the roadmap's §4.4 boundary as an executable test.
- **Full suite** (`npm test`, `tsc --noEmit`, lint) green at every slice; flow/classifier/privacy suites are the regression net for the threading slices.

## 5. Rollback

- **Disable conversion:** stop passing contexts (defaults restore the untouched path), or pass `identityContext` — data-level no-op either way. `lib/money` deletes cleanly below that.
- **Fall back to native values:** automatic and per-row — miss/null ⇒ native amount + `estimated` (D-3); nothing throws, nothing is excluded.
- **Missing FX rates:** totals equal today's blended behavior, flagged. The archive self-heals (Phase 1 backfill), and the next read simply resolves better — nothing stored depends on when conversion ran.
- **Per-slice:** 1–2 delete cleanly (no consumers); 3–4 revert to default-parameter behavior; goldens make any drift a test failure before it is a product change.

## 6. Implementation slices

| Slice | Scope | Files | Validation | Rollback |
|---|---|---|---|---|
| **1 — Money core** | `types.ts`, `convert.ts` (`convertMoney`, `convertAndSum`, `identityContext`) + pure tests. No consumers, no fx imports beyond types. | `lib/money/*` (new) | Unit suite incl. determinism + no-rounding; `tsc`/lint/`npm test` | Delete `lib/money/` |
| **2 — Context builder** | `context.ts` (async prefetch over `lib/fx` service → frozen sync table) + tests via fake archive seam | `lib/money/context.ts` (+test) | Parity test: `resolve()` ≡ fx service over same fixtures; no consumers yet | Delete file |
| **3 — Balance family threading** | `ClassifiableAccount.currency?`; optional `ctx` through `sumBalances`/`classifyAccounts`/liabilities sum; server callers pass `identityContext(DEFAULT_DISPLAY_CURRENCY)` (client callers left context-less — same behavior either way) | `lib/account-classifier.ts` + server call sites | **Byte-identical goldens** (classifier, snapshot writer fields, AI accounts section); full suite | Revert call-site args; default path untouched |
| **4 — Transaction family threading** | Optional `ctx` + `currency` row fields through `lib/debt.ts` rollups, AI monthly accumulators, Banking/Space flow-total helpers; extend the relevant `select`s with `currency` | `lib/debt.ts`, `lib/ai/assemblers/transactions.ts`, flow-total call sites | Byte-identical goldens (debt rollup, assembler summary); flow suites green | Same |
| **5 — Closeout** | No-mutation + neutrality greps, docs (STATUS ledger, roadmap §0.1, this plan → implemented, closeout report), Phase 3 entry findings recorded (F-1 client totals; F-2: snapshot-writer target switch belongs to Phase 3's flip) | docs only | Full suite; grep proofs | n/a |

Ordering rule: pure core → bridge → chokepoint family → wide family → evidence. Every boundary shippable; at every point the product computes exactly what it computes today.

## 7. Open items for approval alongside this plan

1. Confirm **D-3** (miss/null ⇒ native + `estimated`, never exclude, never throw) — it is the continuity-preserving choice and the only one that can't change totals.
2. Confirm **D-9** (classifier first, transaction family second).
3. Confirm client components stay context-less in Phase 2 (identity behavior regardless), deferring client conversion to Phase 3 F-1.

---

## 8. Recommended first-slice prompt

> Implement MC1 Phase 2 Slice 1 per `docs/initiatives/mc1/MC1_PHASE2_READ_TIME_CONVERSION_PLAN.md` §3.1–§3.2 / §6 exactly. Create `lib/money/types.ts` (Money, ConvertedMoney, ConvertedTotal, ConversionContext per D-1/D-2) and `lib/money/convert.ts` (`convertMoney` — identity fast path, null-residue rule, walk-back→estimated, RateMiss→native+estimated per D-3; `convertAndSum` — convert-then-sum with per-row dates and taint propagation per D-6/D-8; `identityContext(target)` — rate-free). Pure modules only: no Prisma, no network, no fx-service calls (types-only imports), no rounding (D-4), no formatting (D-5), no consumers anywhere. Add `lib/money/convert.test.ts` in the house standalone-tsx style covering identity, null-residue, real-rate math via a fixture context, walk-back and miss flagging, taint propagation, per-row-date historical resolution, determinism (byte-equal repeats), and the no-rounding proof. Validate: `npx tsc --noEmit`, `npm run lint`, `npm test` (suite self-discovers), plus a grep proving nothing outside `lib/money/` imports it. Stop after Slice 1 and report before Slice 2.

---

*End of plan. Investigation and checklist only — no implementation, schema, migration, or code change is made or authorized by this document. Phase 2 work begins only upon approval, one slice at a time; Phases 3–4 remain out of scope.*
