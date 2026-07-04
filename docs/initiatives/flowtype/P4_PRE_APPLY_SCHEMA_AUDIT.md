> **INVESTIGATION ONLY — no code, schema, migration, or script changes were made to produce this document.** Governing design: `docs/investigations/FLOWTYPE_FOUNDATION_INVESTIGATION.md`, `docs/initiatives/flowtype/P3_SCHEMA_DESIGN_INVESTIGATION.md`.

# FlowType — Pre-`--apply` Schema Audit (Investigation)

**Date:** 2026-07-03
**Branch:** `feature/v2.5-spaces-completion`
**Question:** Is `Transaction` missing any column that should be added **before** the P4 historical backfill (`--apply`) or **before** the P5 read cutover?
**Status:** Investigation complete — recommendation only.
**Dry-run signal:** all 9 legacy-vs-classifier disagreements are Dividend inflows → `INCOME` via `CATEGORY_INVESTMENT_VALUE`; **zero UNKNOWN** rows.

---

## 1. Current `Transaction` columns (actual, `schema.prisma:1170-1244`)

Identity/lineage: `id`, `accountId`→`account`, `financialAccountId`→`financialAccount`, `plaidTransactionId` (unique), `importBatchId`→`importBatch`, `externalTransactionId`, `deletedAt`, `createdAt`, `updatedAt`.
Economic facts: `date`, `merchant`, `description`, `category`, `amount`, `pending`.
FlowType (P3A): `flowType`, `flowDirection`, `counterpartyAccountId`→`counterpartyAccount`, `classificationConfidence`, `classificationReason`, `classifierVersion`, `pfcPrimary`, `pfcDetailed`, `pfcConfidenceLevel`, `merchantEntityId`.
Indexes: `[accountId]`, `[accountId,date]`, `[financialAccountId]`, `[financialAccountId,date]`, `[date]`, `[importBatchId]`, `[financialAccountId,flowType,date]`, `[flowType,date]`, `[counterpartyAccountId]`.

**Bottom line up front:** the classifier writes `flowType/flowDirection/confidence/reason/version`; preserves `pfc*/merchantEntityId`; leaves `counterpartyAccountId` null. Every column the backfill and the P5 rollups need already exists. The audit below finds **nothing to add before `--apply` and nothing to add before P5.**

---

## 2. Missing-column audit

Verdict key: **1** add before P4 apply · **2** add before P5 · **3** Merchant Engine · **4** Recurring Engine · **5** Tax/Business · **6** Double-entry/Ledger · **7** Do not add. Strictness applied: a column earns a slot only if it is *needed* by the phase named and *honestly backfillable*; "might be useful" is a reject.

| Dimension | Candidate column(s) | Verdict | Strict rationale |
|---|---|---|---|
| **User review / override** | `userFlowType`, `reviewedByUserId`, `reviewedAt` | **7 (defer to a Review UI feature)** | No writer, no UI in P4/P5 → dead column. Real trap it would create: re-classification (`classifierVersion < N`) must never clobber a human override, which requires a *guard added with the feature*, not an empty column now. Fully additive when the review UI lands. |
| **Classification source** | `classificationSource` (sync/backfill/import) | **7** | `classificationReason` already records the *signal* used and `classifierVersion` the *logic*; provenance of the row itself is already derivable (`plaidTransactionId` ⇒ Plaid, `importBatchId` ⇒ import, neither ⇒ manual/seed). Nothing consumes "which run classified it." |
| **Auditability** | `classifiedAt` | **7** | `classifierVersion` + `classificationReason` + `classificationConfidence` already answer "how/why/how-sure," which is the project's audit need (defending an AI figure). No staleness gap exists: Phase B re-classifies on every `modified` update, so classification never lags `updatedAt`. A timestamp adds nothing checkable. |
| **Merchant Engine** | `merchantId` FK; `merchantDisplayName`, `logoUrl`, `website` | **3** | `merchantEntityId` already seeds the join. `merchantId` FK has no table to point at yet (dangling). Merchant *attributes* are explicitly barred from `Transaction`. When the Merchant table exists, `merchantId` backfills from distinct `merchantEntityId` — additive, no Plaid re-fetch. |
| **Recurring** | `recurrenceGroupId`, `isRecurring` | **4** | Recurrence is a cross-row *pattern*, not a per-row fact — it cannot be backfilled honestly per row now. `isRecurring` would be invented data and a boolean the engine will supersede. Belongs to a Recurring/Subscription table + nullable FK later. |
| **Tax / category** | `taxCategory`, `deductible`, `taxYear` | **5** | `flowType` already makes `INTEREST`/`FEE`/`INCOME`/dividend selectable — the tax *primitives* exist. Deductibility/tax-category need business context we do not have; adding them now is dead/invented data. |
| **Reimbursement / business use** | `isReimbursable`, `businessUse`, `reimbursedByTransactionId` | **5 (linking part → 6)** | Pure user/business annotation with no deterministic source and no UI. The offset-link (`reimbursedBy…`) is ledger-shaped and belongs with double-entry. Nothing to backfill. |
| **Double-entry / ledger** | `ledgerEntryId`, `entryGroupId` | **6** | Deferred by design (foundation §4 Option F). No pairing logic exists; an empty column is inert and additive later. `counterpartyAccountId` already provides the lighter attribution seam. |
| **Internal transfer pairing** | `pairedTransactionId` | **6** | Row↔row leg-pairing needs the matching algorithm (date skew, fees) that is explicitly deferred. `counterpartyAccountId` points at the paired *account* (best-effort), which is the intended interim seam; the row-level pair is a Ledger concern. |
| **Debt attribution** | (none) | **— already covered** | `counterpartyAccountId` is the destination-aware seam; the P5 per-liability rollup runs off `[financialAccountId, flowType, date]` (index present). Principal/interest split → **7** (insufficient provider signal; cannot backfill honestly). |
| **Investment lots** | `lotId`, `costBasis`, `quantity`, `securityId` | **7 (future Lots/Position table)** | Lot/cost-basis accounting (FIFO/specific-ID) is a dedicated domain referencing `Holding`/`Transaction`, not per-row columns, and cannot be backfilled honestly. The dividend finding needs none of this: a dividend is already `flowType=INCOME`. |
| **Multi-currency (MC1)** | `isoCurrencyCode`, `originalAmount`, `fxRate` | **7 (defer to MC1)** | A real latent correctness gap (mixed-currency sums), but it is **MC1's** gap, not FlowType's — and FlowType does not worsen it. Historical rows never stored currency; defaulting to USD would be invented data. FlowType columns are currency-agnostic and do **not** conflict with a future `isoCurrencyCode` (additive). See §4 R2. |
| **CSV / manual imports** | `source` enum | **7** | The classifier already handles import/manual rows (category+sign, graceful no-PFC). Provenance is derivable (see "Classification source"). An explicit provider `source` is Provider-Adapter (D2) scope, not this. |
| **Provider metadata** | `authorizedDate`, `paymentChannel`, `location*`, `counterparties`, `logoUrl`, `website`, `providerMetadata JSON` | **7 (defer to Metadata-Depth / Detail-Drawer initiative)** | None are needed for classification, rollups, or the read cutover. Several are PII (location, counterparties) requiring the deny-list/gating that investigation already scoped. The one overlapping field, `pfcDetailed`, is already captured. |
| **AI / Perspective / Daily Brief** | (none) | **— already covered** | These are P5 *read* consumers of `flowType`/`flowDirection`/`counterpartyAccountId`/`classificationConfidence` — all present. `confidence` already lets them express uncertainty. No new column. |

---

## 3. Recommended actions

### Before P4 `--apply`: **none.**
Every column the backfill writes (`flowType`, `flowDirection`, `classificationConfidence`, `classificationReason`, `classifierVersion`) and preserves (`pfc*`, `merchantEntityId`) exists. `counterpartyAccountId` is correctly left null. Nothing is *populatable now but missing*, so no pre-apply migration is warranted. The backfill is re-runnable via a `classifierVersion` bump, so even a hypothetical later column would get its own pass — there is no "now or never" column here.

### Before P5 read cutover: **none.**
P5 needs: read `flowType` (present), the per-liability rollup over `[financialAccountId, flowType, date]` (index present), and `counterpartyAccountId` (present). No schema gap. Two items that look like they might need a column but **do not** — both are *query-design decisions for P5, resolvable from existing columns*:
- **Dividend-as-INCOME (the 9 disagreements).** At cutover, a `flowType=INCOME` rollup will include investment-category `Dividend` rows that the legacy banking query filtered out. This is correct by doctrine, but P5 must decide whether "banking cash-flow income" and "total income" treat them identically. Fully derivable from `flowType` + `category` + account type — **no column needed**, a P5 filter decision (§4 R3).
- **Excluding investment/transfer/debt from spend.** Derivable from `flowType` alone. No column.

---

## 4. Risks if we proceed on the current schema

- **R1 — User overrides not yet modeled.** When a review/override feature lands, re-classification must exclude overridden rows (an additive `userFlowType` + a guard in the version predicate). *Not a blocker:* purely additive later; running `--apply` now creates no obstacle (overrides would simply take precedence when introduced).
- **R2 — Multi-currency (MC1).** P5's flow-based totals will sum mixed currencies where present — a *pre-existing* bug (STATUS §6), neither caused nor worsened by FlowType. *Mitigation:* MC1 adds `isoCurrencyCode` additively; keep the two initiatives separate. Do not paper over it with an invented default now.
- **R3 — Dividend-in-income visibility change.** The correct new behavior (dividends = income) is a *visible* change from the legacy banking totals. *Mitigation:* a P5 read-design decision (which surface counts dividends), fully expressible from existing columns; call it out in the P5 checklist, not here.
- **R4 — `counterpartyAccountId` stays null after `--apply`.** Source-side attribution and row-pairing are deferred; the KD-18 per-liability capability at P5 runs off destination-side legs (`financialAccountId`), which works. *Risk is expectation, not schema:* document that `counterpartyAccountId` is intentionally unpopulated until a later pairing/attribution slice.
- **R5 — Re-runnability hinges on `classifierVersion` discipline.** Any future logic change must bump the constant. *Mitigation:* already documented next to `FLOW_CLASSIFIER_VERSION`.

None of R1–R5 is a missing column; each is either a future additive column tied to its own initiative or a P5 read-design note.

---

## 5. Final recommendation

**GO for P4 `--apply`.** The schema is complete for this initiative: no column should be added before `--apply` or before P5. Every audited candidate is either already covered (`counterpartyAccountId`, `classificationReason/Version/Confidence`, `merchantEntityId`, the three rollup indexes) or correctly belongs to a **future table/initiative** (Merchant, Recurring, Tax/Business, Double-entry/Ledger, Investment Lots, MC1, Metadata Depth) where it is fully additive when that work begins. Adding any of them now would create dead columns, denormalize merchant/entity attributes onto `Transaction`, duplicate `flowType` with booleans, or invent data that cannot be honestly backfilled — each a violation of the initiative's own rules.

Proceed with `--apply` (dry-run already clean: 0 UNKNOWN, 9 expected Dividend→INCOME improvements). Carry R2 (MC1) and R3 (dividend read-semantics) into the P5 checklist as read-design items, not schema changes.
