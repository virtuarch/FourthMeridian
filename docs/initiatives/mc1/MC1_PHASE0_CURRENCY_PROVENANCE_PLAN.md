# MC1 Phase 0 — Currency Provenance — Implementation-Ready Plan

**Status:** ✅ **IMPLEMENTED & CLOSED 2026-07-05** — delivered exactly as specified: Slice 1 `298ef56`, Slice 2 `1aa342b`, Slice 3 `bf53507`, Slice 4 closeout. Exit evidence and residual debt: `MC1_PHASE0_CLOSEOUT_REPORT_2026-07-05.md`. Retained as the implementation record; the sections below are point-in-time design.
**Roadmap approval (2026-07-05):** the 5-phase MC1 structure this plan anchors is approved (`MC1_MULTI_CURRENCY_ROADMAP.md` §0.1). **Phase 0 scope is confirmed exactly as specified here — provenance only** (`Transaction.currency`, `Holding.currency`, `SpaceSnapshot.reportingCurrency`, writer stamping, backfill): no FX conversion, no UI selector, no normalized converted values.
**Date:** 2026-07-05, verified against the working tree at STATUS.md checkpoint `f22de52` (FlowType P5 complete).
**Position:** Final pre-Merchant-Intelligence item. MC1 charter: `docs/initiatives/mc1/MC1_MULTI_CURRENCY_ARCHITECTURE_CHARTER.md`. Prior design input: `docs/investigations/MULTI_CURRENCY_ARCHITECTURE_INVESTIGATION.md` (re-evaluated below — not assumed correct).
**Scope discipline:** provenance only. No FX engine, no conversion logic, no rate source, no UI, no AI change, no reporting change. Currency begins existing; nothing begins reading it.

---

## 0. Executive summary

The original MC1 investigation's core finding **still holds** after FlowType P5, D2 imports, D2.x snapshot backfill, and DB1: **no row-level monetary record carries a currency.** `Transaction.amount`, `Holding.price/value`, and every `SpaceSnapshot` float are bare numbers; Plaid's `iso_currency_code` is captured once (account creation) and dropped everywhere else. What has changed since that investigation is the **writer inventory** (two new writers exist: the import pipeline and the snapshot backfill engine) and the **precedent library** (D4 and FlowType P3 Phase A established the house pattern for additive provenance columns — a pattern this plan adopts, refining one detail of the approved charter direction: nullable-without-default on row tables instead of blanket `DEFAULT 'USD'`, with a derivation backfill instead of an assertion backfill).

Phase 0 is exactly three columns, six writer touch-points, one backfill script, and zero readers:

| Model | New column | Type |
|---|---|---|
| `Transaction` | `currency` | `String?` — nullable, no default |
| `Holding` | `currency` | `String?` — nullable, no default |
| `SpaceSnapshot` | `reportingCurrency` | `String @default("USD")` — NOT NULL |

---

## 1. Current monetary model — audit (verified 2026-07-05)

Every stored monetary value in `prisma/schema.prisma`, with its currency status:

| Model / field(s) | Schema line | Currency today | Phase 0 action |
|---|---|---|---|
| `Account.balance / availableBalance / creditLimit / nativeBalance` | ~633–648 | ✅ `currency String @default("USD")` (L636). Legacy model — frozen, "do not add new features" | None |
| `FinancialAccount.balance / availableBalance / creditLimit / nativeBalance / minimumPayment` | ~698–736 | ✅ `currency String @default("USD")` (L701), captured from Plaid `iso_currency_code` at creation (`lib/plaid/exchangeToken.ts:298`), never re-asserted on refresh | None (re-assert-on-refresh noted §8 as deferred) |
| `DebtProfile.apr / minimumPayment` | 783–784 | ❌ Implied by parent account currency | None — account-implied is correct; no independent denomination |
| `SpaceGoal.targetAmount / currentAmount / targetReductionAmount / snapshotBalance` | 952–969 | ❌ Implied USD (user-entered against USD-displayed balances) | None — deferred (see §2.3); goals denominate in the Space's reporting currency, which is a Phase 3 concept |
| `GoalContribution.amount` | ~1008+ | ❌ Implied by linked account | None — same reasoning |
| `Holding.quantity / price / value` | 1082–1084 | ❌ **None. Plaid sends `iso_currency_code` per holding; dropped** | **Add `currency`** |
| `Transaction.amount` | ~1167 | ❌ **None. Plaid sends `iso_currency_code` per transaction; dropped** | **Add `currency`** |
| `SpaceSnapshot.stocks/crypto/total/cash/savings/debt/netWorth/totalAssets/cashOnHand/netLiquid` | 1375–1388 | ❌ **None. Ten floats frozen daily in an undeclared unit** | **Add `reportingCurrency`** |
| `ImportBatch` counters | 1262+ | n/a — row counts, not money | None |

Where currency is currently **implied** rather than stored: the aggregation layer (`sumBalances()` / `classifyAccounts()`, `lib/account-classifier.ts:97–138`) sums raw floats; `lib/space-hero.ts`, perspective-engine lenses, `lib/snapshots/regenerate.ts`, chart readers (`lib/data/snapshots.ts`), and the AI assemblers all inherit that implicit single-unit assumption. `lib/ai/types.ts:243–245, 696–697` documents it as a known limitation. `lib/currency.ts` (`DEFAULT_DISPLAY_CURRENCY = "USD"`) remains the designated display-currency swap point. The one currency-correct precedent is unchanged: `lib/account-privacy.ts` keys BALANCE_ONLY aggregation on currency.

**None of this changes in Phase 0.** The audit exists to bound the stamp set (§2) and to confirm behavior-neutrality (§5).

### 1.1 Re-evaluation of the prior investigation — what held, what moved

- **Held:** the three persistence gaps (Transaction, Holding, SpaceSnapshot); Plaid sends the codes and the sync paths drop them; the classifier chokepoint; manual accounts already accept `currency`; CSV import has no currency column (`lib/imports/csv.ts:168`); wallets hardcode USD (`app/api/accounts/wallet/route.ts:194`).
- **Moved — new writers the prior investigation could not have enumerated:** (1) the **D2 import pipeline** (`app/api/accounts/[id]/import/route.ts`) creates and update-on-match rewrites transactions; (2) the **snapshot backfill engine** (`lib/snapshots/backfill.ts`) mass-creates estimated historical `SpaceSnapshot` rows. Both must stamp (§4).
- **Moved — schema drift:** all line references in the old doc are stale (FlowType columns, `merchantEntityId`, import columns landed since); `SpaceSnapshot` gained `isEstimated` (D2.x Slice 4); DB1 renamed the physical table to `"SpaceSnapshot"` (migration `20260705134641`), so Phase 0's migration targets the new physical name.
- **Charter erratum:** the charter's Dependencies section cites `SpaceSnapshot.source` — **no such column exists**; the backfill provenance that shipped is `isEstimated` only. Correct in the charter when Phase 0 lands (Slice 4).
- **Refined (deliberate deviation):** the charter phrase "all default `USD`" is refined to *nullable, no default* on `Transaction`/`Holding` — see §3.2 for why. The snapshot column keeps `DEFAULT "USD"`. The spirit (additive, behavior-neutral, USD-era) is unchanged; what improves is the honesty of the stamp.

---

## 2. Design — exactly what Phase 0 contains

### 2.1 The three columns

```prisma
// Transaction (after merchantEntityId, before createdAt)
// MC1 Phase 0 — currency provenance (additive, nullable). ISO 4217 code of
// `amount`, from Plaid iso_currency_code at write time, or the parent
// account's currency for imports/fallback. Null = pre-Phase-0 row whose
// denomination was never recorded (backfilled from parent account where
// derivable). Nothing reads this until MC1 Phase 2+.
currency String?

// Holding (after isCash)
// MC1 Phase 0 — ISO 4217 code of `price` and `value` (the fiat valuation
// unit — for crypto positions this is the quote currency, not the asset;
// quantity stays unitless). Same null semantics as Transaction.currency.
currency String?

// SpaceSnapshot (after isEstimated)
// MC1 Phase 0 — the currency all ten totals on this row were computed and
// presented in. NOT NULL DEFAULT "USD": unlike row-level stamps this is a
// property of the computation, and every historical row was computed by
// USD-presenting code, so the default is a true statement about old rows.
reportingCurrency String @default("USD")
```

Naming: `currency` matches the existing `Account.currency` / `FinancialAccount.currency`; `reportingCurrency` matches the approved MC1 vocabulary and pre-aligns with Phase 3's `Space.reportingCurrency`.

### 2.2 Candidate fields evaluated and excluded

| Candidate | Verdict | Why |
|---|---|---|
| `currencyCode` | **In**, named `currency` | Consistency with the two existing columns beats ISO pedantry |
| `reportingCurrency` (on `SpaceSnapshot`) | **In** | A snapshot must declare its unit or history is frozen in an unknown denomination |
| `reportingCurrency` (on `Space`) | **Out** | Phase 3. In Phase 0 it would be a dead user-facing setting; snapshots self-describe without it |
| `assetCurrency` | **Out** | Charter decision #6: crypto is an asset with a fiat valuation. The asset is `symbol`/`quantity`/`nativeBalance`; the valuation unit is `Holding.currency`. A second column models a distinction the schema already expresses |
| `valuationCurrency` | **Out** (folded in) | It *is* the semantics of `Holding.currency` — documented in the column comment rather than duplicated |
| `exchangeRateSource` / `fxRateVersion` | **Out** | Phase 1 (FX infrastructure). No conversion happens in Phase 0, so a rate identity would be a permanently-null column with no writer. Adding it later is equally additive — deferral costs nothing |
| `currencySource` provenance enum (PROVIDER / ACCOUNT / ASSUMED) | **Out** | Scope creep. The null-vs-set distinction plus write-path rules carry the essential signal; a full source enum can be added in a later phase if a real consumer appears |
| CSV per-row currency column | **Out** | Import-format expansion, not provenance. Imports stamp the target account's currency (§4.4); a mappable currency column is Phase 7 territory |
| `unofficial_currency_code` capture | **Out** (documented) | Writing "BTC" into a currency column contradicts decision #6. Rule: stamp `iso_currency_code` only; when null, fall back to account currency. Revisit at Phase 7 wallet/exchange work |

### 2.3 Boundary call: goals and debt profiles are not stamped

`SpaceGoal` / `GoalContribution` / `DebtProfile` amounts are user-intent values against a Space-level or account-level frame, not provider-reported monetary facts. Their denomination is *derivable* (account currency; Space reporting currency once Phase 3 exists) and — unlike transactions/holdings — no provider is currently handing us a code that we are dropping. Stamping them now would front-run the Phase 3 reporting-currency decision. Excluded, recorded here so the exclusion is a decision rather than an oversight.

---

## 3. Migration strategy

### 3.1 The migration

One migration, additive only, three statements (physical names post-DB1):

```sql
-- MC1 Phase 0 — Currency Provenance. Additive only; no backfill in-migration.
ALTER TABLE "Transaction"   ADD COLUMN "currency" TEXT;
ALTER TABLE "Holding"       ADD COLUMN "currency" TEXT;
ALTER TABLE "SpaceSnapshot" ADD COLUMN "reportingCurrency" TEXT NOT NULL DEFAULT 'USD';
```

Answers to the standing questions:

- **Additive?** Yes — `ADD COLUMN` only. No renames, no type changes, no constraint changes to existing columns.
- **Nullable?** `Transaction.currency` and `Holding.currency`: yes. `SpaceSnapshot.reportingCurrency`: no (defaulted).
- **Default USD?** Only on the snapshot column (§3.2). On Postgres 11+ a defaulted `ADD COLUMN` is metadata-only — no table rewrite even on the largest table, and `SpaceSnapshot` is small (one row per space per day) regardless.
- **Backfill required?** Yes for `Transaction` and `Holding` — as a **separate idempotent script, not in-migration** (house pattern: FlowType P4 `scripts/backfill-flowtype.ts`; migrations stay schema-only). No backfill for `SpaceSnapshot` (the default *is* the backfill, and it is accurate — §2.1).
- **Indexes?** **None.** No Phase 0 read path exists; nothing filters or groups by currency until Phase 2/3. Adding e.g. `@@index([financialAccountId, currency])` now would be speculative write overhead on the hottest table. Indexes are a Phase 2/3 decision made against real queries.
- **Rollout order?** Schema → writers → backfill → verify (§7). Writers before backfill so the null population stops growing before it is drained.

### 3.2 Why nullable-no-default instead of the charter's "all default USD"

Three reasons, all grounded in shipped precedent:

1. **Null must mean "unknown," not "USD."** D4 set the exact precedent on `FinancialAccount.balanceLastUpdatedAt`: *"null means provenance unknown, not balance is current"* — and deliberately never backfilled. A schema default of `'USD'` would stamp every historical row with an assertion Phase 0 exists to stop making. Worse, provider-confirmed USD and assumed USD would become permanently indistinguishable — destroying the very provenance signal being built.
2. **Writer gaps stay detectable.** With no default, any writer this plan missed (or any future writer added without reading it) produces nulls that a one-line count surfaces. With a default, a forgotten writer silently manufactures "USD" provenance forever. Nullable-no-default is the design that *fails loudly in the safe direction*.
3. **The backfill can do better than USD.** Every transaction/holding has a parent account whose `currency` is real, provider-captured evidence. Deriving the stamp from the parent (§3.3) is strictly more honest than a blanket constant — and in today's data produces the same values (all accounts are USD) while being *correct by construction* rather than by coincidence.

The snapshot column is the exception because its unit is a property of the computing code, not of provider data — and that code has only ever computed-and-presented USD. `DEFAULT 'USD'` on `SpaceSnapshot` is a true historical statement; on `Transaction` it would be an unprovable one.

### 3.3 Backfill design — `scripts/backfill-currency.ts`

House pattern (FlowType P4): dry-run by default, `--apply` to write, batched, idempotent, re-runnable.

- **Transaction:** `UPDATE ... SET currency = fa.currency FROM "FinancialAccount" fa WHERE t."financialAccountId" = fa.id AND t."currency" IS NULL`, plus the legacy leg joining `Account` for rows still carrying `accountId` (the dual-FK pattern — exactly one FK is set per row).
- **Holding:** same two-leg derivation. Low stakes: Plaid holdings are delete-and-recreated on every refresh, so synced rows re-stamp themselves within one cycle; the backfill matters only for rows on accounts that never refresh again.
- **Idempotence:** `WHERE currency IS NULL` guard; safe to re-run; safe to run while syncs are live (post-Slice-2 writers stamp their own rows).
- **Report:** counts stamped per leg + remaining nulls (expected 0; orphaned rows with neither FK resolvable stay null by design — that *is* their provenance).

### 3.4 Rollback

Every step is independently trivial: the columns are dropped (`DROP COLUMN` ×3) with zero reader impact because zero readers exist; writer changes revert as ordinary code reverts (already-stamped rows are harmless residue); the backfill inverts with `SET currency = NULL` (and would not even need inverting). Phase 0 is the lowest-rollback-risk migration in the MC1 sequence — by design, since it precedes all consumers.

---

## 4. Write path — every writer that must populate provenance

Verified by exhaustive grep for `transaction.create|createMany|update`, `holding.create|upsert`, `spaceSnapshot.create|upsert|createMany` across `lib/ app/ jobs/ scripts/ prisma/`:

| # | Writer | Location | Stamp rule |
|---|---|---|---|
| 1 | **Plaid transaction sync** | `lib/plaid/syncTransactions.ts` — the shared `fields` object (~L267) feeds all three outcomes (update-by-plaidId, fingerprint update, create). **One insertion point.** | `currency: txn.iso_currency_code ?? meta.currency ?? null`. Extend `resolveAccountMeta`'s select (~L150) with `currency`. Note: `meta` currently resolves inside the flow-classification `try` (~L237); the account fallback must not depend on that try succeeding — either hoist the meta resolution or accept provider-code-only stamping on the degraded path (provider code is present on essentially all Plaid rows) |
| 2 | **Plaid holdings — refresh** | `lib/plaid/refresh.ts` holdings loop (~L316–338), `db.holding.create` | `currency: h.iso_currency_code ?? sec.iso_currency_code ?? <account currency> ?? null` |
| 3 | **Plaid holdings — initial import** | `lib/plaid/exchangeToken.ts` (~L445), `db.holding.create` | Same rule as #2 (account currency is in hand at ~L298) |
| 4 | **Import pipeline — CREATE** | `app/api/accounts/[id]/import/route.ts` (~L366) | `currency: fa.currency` (target account, already loaded by the route). Files carry no currency column (`lib/imports/csv.ts:168` — unchanged; no format creep) |
| 5 | **Import pipeline — update-on-match** | Same route (~L387–420), QuickBooks exact-externalId path | Include `currency: existing.currency ?? fa.currency` in the update write so a matched pre-Phase-0 row gets stamped opportunistically. Keep `currency` **out** of `computeQuickBooksUpdateDiff` — it must never *trigger* an update |
| 6 | **Snapshot regenerate** | `lib/snapshots/regenerate.ts` upsert (~L74), both `create` and `update` branches | Explicit `reportingCurrency: DEFAULT_DISPLAY_CURRENCY` (import from `lib/currency.ts` — the designated seam) rather than leaning on the DB default: makes the writer's declaration visible and greppable for the Phase 3 cutover |
| 7 | **Snapshot backfill engine** | `lib/snapshots/backfill.ts` row assembly (~L250) → `createMany` | Same explicit stamp as #6 |

**Writers audited and exempt:** manual assets (`app/api/accounts/manual/*`) already persist account-level `currency` and write no monetary rows; wallet route (`app/api/accounts/wallet`) hardcodes account `currency: "USD"` — stands as-is per the crypto-as-asset decision, writes no holdings today; account/manual update+restore routes touch balances only, never rows; `scripts/backfill-merchant-categories.ts` and `scripts/backfill-flowtype.ts` rewrite category/flow, never amounts — no obligation; `jobs/take-snapshot.ts` is an empty stub. **Two edge writers, handled cheaply:** `lib/sync/computeCashResidual.ts` upserts a synthetic CASH holding — currently has **zero callers** (dormant), but stamp its create branch (`currency: "USD"` or the passed account currency) so revival can't reopen the gap; `prisma/seed.ts` (dev-only) — stamp for hygiene in the same pass, non-blocking.

---

## 5. Read path — behavior-neutrality confirmation

Phase 0 is behavior-neutral by construction, verified surface by surface:

- **Aggregation:** `sumBalances()` / `classifyAccounts()` untouched — still sums raw floats. The conversion cutover remains Phase 3, isolated to the classifier + `regenerateSpaceSnapshot` per the charter.
- **UI:** no component reads the new columns. Account-level `currency` already flows to a few surfaces (holdings page, connections, manual assets) exactly as before. No new UI, no labels, no toggles.
- **AI:** assemblers (`lib/ai/assemblers/accounts.ts`, `transactions.ts`) select explicit field lists — new columns aren't even fetched. The `lib/ai/types.ts` "summed without conversion" limitation comments remain true and remain in place (retired in Phase 5).
- **Reporting/charts:** `lib/data/snapshots.ts` readers select existing floats; `reportingCurrency` is written, never read.
- **Mechanical blast radius:** Prisma client regeneration adds optional fields to generated types — additive-optional, so `tsc --noEmit` passes without touching any consumer. Queries using `select` are unaffected; queries returning full rows carry an extra ignored field.

The Phase 0 acceptance statement: **after landing, every screen, chart, brief, and chat answer is byte-identical to before — but every new monetary row knows its denomination, and every old one that could be derived has been stamped.**

---

## 6. Why Phase 0 precedes Merchant Intelligence

Honest framing first (aligned with `NEXT_INITIATIVE_AND_ROUTER_E668_INVESTIGATION_2026-07-05.md` §A.5): MI writes category/identity data, not monetary rows — **nothing in MI breaks without Phase 0. This is a soft prerequisite, sequenced deliberately, not a hard blocker.** The reasons to sequence it first:

1. **The unstamped surface only grows.** Provenance is the one thing in MC1 that cannot be reconstructed later (charter's load-bearing separation). Every sync cycle and — more importantly — every MI backfill that lands before Phase 0 adds rows whose denomination is forever "assumed USD with no proof." MI's persisted tier explicitly plans row-rewriting backfills at scale; running those over stamped rows costs nothing, running them before stamping enlarges the archaeology.
2. **Serialized small migrations.** Phase 0 is one tiny additive migration. MI opens its own schema (`MerchantRule`, `categorySource`, category-enum expansion). Landing Phase 0 first keeps the migration ledger one-initiative-at-a-time, each independently rollback-trivial — the same discipline that made FlowType P3→P5 safe.
3. **MI's future analytics are sums over amounts.** Merchant spend rollups, cadence/subscription detection, and price-change detection all aggregate and compare `Transaction.amount` over time. Built on currency-stamped rows, those features can later become currency-aware at the assembler (Phase 2/3) without rework; built on bare floats, MI would bake a second generation of currency-blind aggregation into exactly the layer MC1 exists to fix — and a recurring-charge detector that can't distinguish an FX-driven amount wobble from a price change is quietly wrong in a way no one will trace for months.
4. **It is small enough to not delay MI.** Three columns, six writer touch-points, one script. The cost of sequencing it first is days; the cost of retro-fitting provenance after MI's backfills is a data-archaeology project.

What becomes easier because provenance exists: MC1 Phases 1–3 become pure column-activation (no historical repair step); MI merchant rollups inherit a currency dimension for free when Phase 2 lands; future provider adapters (IBKR's mixed-currency accounts, Coinbase/Kraken) land on a schema that already answers "what unit is this row in"; and every future backfill — MI's included — preserves rather than launders denomination.

---

## 7. Implementation slices

Four slices, each independently shippable and revertible, in strict order.

### Slice 1 — Schema + migration (the provenance columns exist)

- **Files:** `prisma/schema.prisma` (3 columns + comments per §2.1); new `prisma/migrations/<ts>_mc1_phase0_currency_provenance/migration.sql` (§3.1).
- **Schema changes:** `Transaction.currency String?`, `Holding.currency String?`, `SpaceSnapshot.reportingCurrency String @default("USD")`.
- **Migration changes:** the one additive migration; nothing else.
- **Validation:** `npx prisma migrate dev` + `npx prisma generate`; `npx tsc --noEmit` (must pass with zero consumer edits — this *is* the neutrality proof); `npm run lint`; `npm test`; spot-query: snapshot rows read `reportingCurrency = 'USD'`, transaction/holding rows read `NULL`.
- **Rollback:** trivial — drop 3 columns; no reader exists.

### Slice 2 — Write-path population (new rows are born stamped)

- **Files:** `lib/plaid/syncTransactions.ts` (fields object + `resolveAccountMeta` select + try-scope note, §4#1); `lib/plaid/refresh.ts` (§4#2); `lib/plaid/exchangeToken.ts` (§4#3); `app/api/accounts/[id]/import/route.ts` (§4#4–5); `lib/snapshots/regenerate.ts` (§4#6); `lib/snapshots/backfill.ts` (§4#7); `lib/sync/computeCashResidual.ts` + `prisma/seed.ts` (edge/dev hygiene).
- **Schema/migration changes:** none.
- **Validation:** `tsc` + lint + `npm test` (flow suites must stay green — the fields-object change rides next to FlowType writes); sandbox Plaid sync then assert `currency IS NOT NULL` on newly-synced transactions and holdings; run an import and assert created rows stamped with the target account's currency; trigger a snapshot regenerate and confirm the explicit stamp; confirm update-on-match diff behavior unchanged (currency never triggers an update).
- **Rollback:** revert commits; stamped rows persist harmlessly (correct data, no reader).

### Slice 3 — Backfill (historical rows stamped where derivable)

- **Files:** new `scripts/backfill-currency.ts` (register in `scripts/run-tests.ts`-adjacent tooling conventions if applicable); no production code changes.
- **Schema/migration changes:** none.
- **Validation:** dry-run report reviewed before `--apply`; post-apply counts — expected `currency IS NULL` = 0 on both tables in current data (all rows have a resolvable parent); any residue must be explainable (orphaned FKs) and is left null deliberately; re-run to prove idempotence (0 writes).
- **Rollback:** unnecessary in practice; mechanically `SET currency = NULL` where desired. No behavior at stake.

### Slice 4 — Verification + ledger closeout

- **Files:** `STATUS.md` (MC1 entry: Phase 0 → complete; verification checkpoint); `docs/initiatives/mc1/MC1_MULTI_CURRENCY_ARCHITECTURE_CHARTER.md` (mark Phase 0 delivered — the `SpaceSnapshot.source` erratum of §1.1 was already fixed 2026-07-05 in the roadmap-approval doc pass); this document (mark implemented).
- **Schema/migration changes:** none.
- **Validation:** the full-suite pass (`tsc`, lint, `npm test`); a written null-count snapshot recorded in the STATUS entry as the Phase 0 exit evidence; explicit spot-check that UI/AI/chart outputs are unchanged (§5 acceptance statement).
- **Rollback:** n/a (documentation).

**Ordering rationale:** columns must exist before writers reference them (1→2); writers must stamp before the backfill so the null population is draining, not refilling (2→3); evidence last (4). Each boundary is a safe stopping point — a repo left at Slice 1 or 2 for a week is fully healthy.

---

## 8. Deferred with intent (recorded so deferral is a decision)

- **FX rate source, archive, versioning** — Phase 1. **Normalized columns** — Phase 2. **`Space.reportingCurrency` + classifier cutover** — Phase 3. **Snapshot original-per-currency breakdown + rate version + currency estimation flags** — Phase 4. **AI contract + comment retirement** — Phase 5. **UI** — Phase 6. **CSV currency column, `unofficial_currency_code`, IBKR-class adapters, crypto valuation detail** — Phase 7.
- **Re-asserting `FinancialAccount.currency` on Plaid refresh** (today captured only at creation) — small write-path fidelity improvement, but it *changes* an existing column's behavior rather than adding provenance; take at Phase 1/2 entry, not in the behavior-neutral phase.
- **Currency-source enum, currency indexes, goal/debt stamping** — see §2.2/§2.3/§3.1.

---

*End of plan. No implementation, schema, migration, code, or roadmap change is made by this document. Next step per project rule: approval of this plan, then Slice 1.*
