# MC1 — Multi-Currency Architecture — Initiative Charter

**Status:** APPROVED (planning; no implementation yet) · 🏛️ **foundational architecture initiative**
**Approved:** 2026-07-03 · **Amended 2026-07-05:** the phase structure below is superseded by the approved 5-phase roadmap — `docs/initiatives/mc1/MC1_MULTI_CURRENCY_ROADMAP.md` (see the amendment note at §"Approved implementation order") · **Phase 0 delivered 2026-07-05** (`298ef56` → `bf53507` + closeout; see `MC1_PHASE0_CLOSEOUT_REPORT_2026-07-05.md`) · **Phase 1 delivered 2026-07-05** (`8689e2d` → closing commits; see `MC1_PHASE1_CLOSEOUT_REPORT_2026-07-05.md`)
**Track/ID:** `MC1` — first initiative on the new **`MC-x` (multi-currency / money-model)** track. Allocated per the STATUS.md §4 namespace rule (track prefix + number, folder created at allocation so the ID cannot be squatted). Deliberately *not* a frozen matrix integer (D1–D14 are frozen per `PHASE_2_DECISION_MATRIX.md`) and *not* an `AI-x`/`UI-x`/`L-x` slot.
**Queue position:** a long-term architectural initiative that **follows** the D2.x Initial Sync Experience work and the Snapshot Backfill initiative, and **precedes** future provider expansion (Coinbase, Kraken, Interactive Brokers, Schwab, Fidelity, richer CSV imports, wallet providers). This is **not** a v2.5 deliverable.
**Evidence / source:** `docs/investigations/MULTI_CURRENCY_ARCHITECTURE_INVESTIGATION.md` (authoritative design input — completed and approved).

---

## Purpose

Evolve Fourth Meridian from a USD-first platform into a **first-class multi-currency financial system without future rewrites.** The investigation established that the product is single-currency *by construction* but multi-currency-*aware* by intention: a `currency` column already exists on `Account` and `FinancialAccount`, Plaid's `iso_currency_code` is already captured at account creation, and explicit "replace when multi-currency lands" seams already exist (`lib/currency.ts`, `lib/ai/types.ts`). The gap is that currency codes are captured and then discarded at exactly one layer — aggregation — where `sumBalances()` (`lib/account-classifier.ts`) adds raw balances across currencies with zero conversion.

This initiative is a **foundational architecture initiative.** Future provider integrations depend on it: they should build on the currency architecture rather than precede it, because the model's hardest requirement (row-level currency) is validated precisely by the providers that would otherwise be built first.

## Approved architectural direction (from the investigation)

The following decisions are **approved** and govern all phases of this initiative:

1. **Phase 0 provenance stamping is approved** — even during the USD-only era. Currency provenance must be captured first because it **cannot be reconstructed later**. Stamping is additive and behavior-neutral (everything defaults to `USD`).
2. **Option B is the approved storage model** — store **original values** (native currency, as reported by the provider) **plus normalized values** (converted into the reporting currency, frozen at write time). Originals are never discarded; normalized values are computed once against the rate in effect and frozen.
3. **Reporting currency belongs to the Space.** Spaces are already the aggregation and snapshot boundary. Different Spaces may carry different reporting currencies (e.g. Personal → USD, Saudi Business → SAR, Rental Property → GBP). Chart/AI-session currency is an *ephemeral display override* only, never the system of record.
4. **Currency must exist at the row level** — on transactions, holdings, and snapshots — **not only on accounts.**
5. **Historical reporting must use historical FX**, never today's rate. Converted values are frozen into snapshots at write time using the rate then in effect; today's-rate conversion of history is explicitly rejected because it silently rewrites the past.
6. **Crypto is modeled as an asset with a fiat valuation**, not as a simple cash currency. This resolves the current wallet-hardcodes-USD ambiguity before exchange/wallet providers arrive.

## Interactive Brokers validates row-level currency

**A single Interactive Brokers brokerage account can hold positions denominated in multiple currencies** (e.g. USD, EUR, and JPY holdings inside one account). An account-level currency model cannot represent this; only **row-level (per-holding, per-transaction) currency** can. IBKR is therefore the concrete stress test that validates approved decision #4 — the requirement for row-level currency support is not speculative, it is demanded by a named future provider.

## Provenance vs. conversion — the load-bearing separation

> **This initiative intentionally separates *currency provenance* from *currency conversion*. Provenance must be captured first because it cannot be reconstructed later.**

Provenance (which currency a number is in) is stamped in Phase 0 and is irreversible if skipped — every monetary row written without a currency stamp is forever "assumed USD with no proof." Conversion (turning one currency into another) is deferred to later phases and is fully reversible/recomputable. Sequencing provenance ahead of conversion is the single decision that prevents a painful future migration.

## Architectural rules

- **Additive before subtractive.** Provenance columns are added and trivially populated (`USD`) before any behavior changes.
- **No schema, code, or migration work under this charter** — it is planning only. Each phase gets its own approved implementation checklist first.
- **The classifier is the single cutover point.** `sumBalances()` / `classifyAccounts()` (`lib/account-classifier.ts`) is the aggregation chokepoint; the conversion cutover is isolated to it (and `regenerateSpaceSnapshot`) rather than scattered across readers.
- **Never discard originals.** Retaining native values preserves historical accuracy, audit trail, and the ability to re-report in another currency.
- **Historical FX only** for history; never re-convert the past at today's rate.
- **Every phase independently shippable and revertible.**

## Approved implementation order

> **Amended 2026-07-05 — the 8-phase outline below is SUPERSEDED** by the approved 5-phase structure in `MC1_MULTI_CURRENCY_ROADMAP.md` (§2 there maps old→new): **0** currency provenance (unchanged — provenance only: `Transaction.currency`, `Holding.currency`, `SpaceSnapshot.reportingCurrency`, writer stamping, backfill; no FX conversion, no UI, no normalized values) → **1** FX provider layer (rate archive + deterministic service) → **2** read-time conversion via a shared money service → **3** Space/User reporting currency → **4** currency selector & UX. **Recorded revision to decision #2 above:** read-time conversion over an immutable dated rate archive is preferred over Option B's write-time normalized columns for now (normalized columns stay available later as an additive cache); conversion must never mutate stored financial facts; snapshots remain frozen computed totals stamped with `reportingCurrency`. Historical FX remains a core capability (delivered by the Phase 1 archive); FX P&L (realized/unrealized) is a future capability gated on a cost-basis/lot model, outside MC1. Old phases 4–6 are absorbed into the new Phase 4 or parked as optional enhancements; old phase 7 (provider expansion) moves out of MC1 to the provider track. The table below is retained as historical record only.

| Phase | Scope | Schema |
|---|---|---|
| **0** | **Currency provenance.** Stamp currency onto transactions, holdings, and snapshots (Plaid already sends `iso_currency_code` for transactions and holdings; it is currently dropped). All default `USD`; zero behavior change. Eliminates the only irreversible migration risk. | Additive (currency-stamp columns); planned separately, not in this charter |
| **1** | **FX infrastructure.** Introduce an FX rate source + historical rate archive with a versioned rate identity. No conversion in totals yet; Space reporting currency defaults to `USD`. | Additive, if built |
| **2** | **Currency-aware transactions & holdings.** Persist normalized values at write time (Option B) for new rows; backfill historical rows as `estimated` where rate history allows. | Additive |
| **3** | **Space reporting currency.** `Space.reportingCurrency` becomes selectable (default `USD`). Flip `classifyAccounts()` + `regenerateSpaceSnapshot` to sum normalized values — the single highest-leverage cutover. | Additive |
| **4** | **Snapshot evolution.** Snapshots become immutable currency snapshots: normalized totals + original per-currency breakdown + reporting currency + FX rate version + estimation flag. Charts read normalized values and gain a currency axis label. | Additive |
| **5** | **AI context evolution.** Assembler contract emits converted totals + per-account originals + reporting-currency label + estimation flag. Retire the "summed without conversion" limitation note in `lib/ai/types.ts`. Fixed once at the assembler; every AI surface (Daily Brief, Financial Story, Meridian Analyst, future agents) inherits. | None |
| **6** | **UX & reporting.** Native-per-item vs. reporting-per-aggregate rules: itemized views (accounts, transactions, individual holdings) show native currency; aggregated views (net worth, charts, portfolio totals, brief) show reporting currency with an explicit label. Ephemeral chart/session re-report override. | None |
| **7** | **Provider expansion.** Coinbase, Kraken, Schwab, Fidelity, Interactive Brokers, richer CSV imports, wallet providers. The model is provider-agnostic by design; this phase is per-provider adapter work built **on** the currency architecture. | Per-provider, additive |

## Dependencies

- **D2.x — Initial Sync Experience & Historical Pipeline** — MC1 follows this work; it should not compete with the v2.5 flagship onboarding initiative.
- **Snapshot Backfill initiative** — MC1's snapshot work builds on the backfill's additive snapshot provenance (`SpaceSnapshot.isEstimated` — *erratum fixed 2026-07-05: an earlier version of this line cited a `SpaceSnapshot.source` column that does not exist*); currency provenance on snapshots is a sibling of that provenance work.
- **Future provider initiatives depend on MC1**, not the reverse. Provider expansion (Coinbase, Kraken, Interactive Brokers, Schwab, Fidelity, CSV, wallets) should build on the currency architecture rather than precede it.

## Open decisions requiring approval before their phase

Carried from the investigation; each is resolved at the entry to the relevant phase, not now:

1. FX rate **source** and required historical **depth/granularity** (daily close vs. intraday) — Phase 1.
2. **Backfill policy** for snapshots/transactions predating rate coverage (estimate-and-flag vs. leave null) — Phase 2/4.
3. Crypto asset-with-quote **modeling details** (valuation currency, quote frequency) — before Phase 7 wallet/exchange work.
4. Row-level currency **granularity confirmation** against the first multi-currency provider adapter (IBKR) — Phase 7 entry.

## Working style

Per standing project rule: each phase gets its own short implementation checklist, submitted for approval, before any code/schema/migration work. Phase 0 approval does not pre-approve Phases 1–7. Validation each phase: `npx prisma generate` (+ `npx prisma migrate dev` only when a phase is additive-schema), `npx tsc --noEmit`, `npm run lint`, and targeted route/UI testing where applicable.
