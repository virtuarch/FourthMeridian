# Fourth Meridian — A7 Historical Investment Import Investigation

**Date:** 2026-07-12
**Branch:** `feature/v2.5-spaces-completion` (HEAD `30dd557` — shared Perspective shell)
**Type:** Architecture investigation only. No code written, no files modified besides this report, no migrations created, nothing committed.
**Governing inputs:** the Investment History Progressive Evidence plan (2026-07-11), the A5 Shared Perspective Engine investigation (2026-07-11), the A6/A7/A8/P5 parallelization investigation (2026-07-12), superseded where noted by the direct repository audit in §2.
**Governing principle:** *"Did the data earn this?"*

**Canonical roadmap labels used throughout:**

| Label | Meaning | Status |
|---|---|---|
| A1 | Investment Observation Foundation | ✅ |
| A2 | Holding Writer Modernization | ✅ |
| A3 | Investment Event Foundation | ✅ |
| A4 | Position Reconstruction | ✅ |
| A5 | Shared Perspective Engine (asOf) | ✅ |
| A6 | Cash Flow / Liquidity / Debt / Partial Wealth Time Machine | ✅ |
| **A7** | **Historical Investment Import — this investigation** | next |
| A8 | Historical Price Foundation & Valuation | future |
| A9 | Wealth Regeneration | future |
| A10 | Investments Time Machine | future |
| A11 | Financial Timeline & Simulation | future |
| A12 | Financial Conversation Layer | future |

**Label mapping caution:** the 2026-07-12 parallelization investigation predates this roadmap and uses older labels. Its "A6 Historical Prices" and "A7 Historical Valuation" are both canonical **A8**; its "A8 Wealth Regeneration" is canonical **A9**; its "P5 Investments Time Machine" is canonical **A10**. Canonical **A7 (this document)** corresponds to the progressive-evidence plan's Track C (C1 opening-position assertion + C2 brokerage CSV import), expanded to the full historical-import architecture. Every ruling in those documents is honored below under the canonical labels.

---

## 1. Executive recommendation

**A7 should be built as an investment extension of the existing D2 import framework — not a parallel import system.** The repository already owns a production-hardened import spine: `ImportBatch` with counters, mapping snapshots, and `ROLLED_BACK` soft-delete rollback; a DB-free parse→resolve→normalize pipeline; a read-only preview route; saved space-scoped mapping profiles; and a claim-based, idempotent, audited rollback route. Every one of those was designed with investment imports explicitly in mind (the `ImportBatch.investmentEvents` relation and its "rollback soft-deletes them" comment have existed since A3). A7 adds the investment-shaped halves that are missing: an investment column contract and event-type mapping profiles, an investment dedupe classifier, opening-position handling, the rollback extension the schema comment already promises, bounded-reconstruction repair on commit and rollback, and the product's **first import UI** (the banking import framework is API-only today — no component calls it).

The five load-bearing decisions:

1. **Import model: both transactions and positions, with events as the canonical substance.** Imported activity rows become `InvestmentEvent` rows (append-only, deduped, rollback-able). Imported holdings statements become `PositionObservation(origin: IMPORTED)` anchor rows. Opening positions are both at once: an `OPENING_BALANCE` event plus an `IMPORTED`/`USER_ASSERTED` observation. A4 reconstruction consumes both without core rewrites — events extend the backward walk, observations anchor and checkpoint it (§6, §7).
2. **First-class adapters: generic investment CSV + named broker profiles (Schwab first, Fidelity second) + manual opening-position entry.** Broker profiles are *data* (header aliases + action-string→canonical-type tables), not code-per-broker. Excel rides the existing `excel.ts` path. OFX/QFX is a designed-for second wave; API providers are Connections, not imports; PDF statements are deferred (§3.2).
3. **Provenance is already 90% solved; one additive migration completes it.** `InvestmentEvent` already carries `source`, `externalEventId`, `providerType/Subtype`, `description`, `mapperVersion`, `importBatchId`, `supersededById`, `deletedAt`; `ImportBatch` already snapshots `resolvedColumnMapping` and `originalFilename`. The migration adds: `ImportBatch.kind`, `PositionObservation.importBatchId` + `deletedAt`, `InvestmentEvent.importedRaw Json?` (verbatim original row values), and `ImportBatch.userDecisions Json?` (recorded per-row overrides) (§4).
4. **Rollback closes the loop the banking rollback couldn't:** soft-delete the batch's events *and* observations, clear supersession pointers that point into the batch, then run bounded reconstruction repair — residuals re-widen automatically because `gatherReconstructionInputs` already filters `deletedAt: null, supersededById: null`. Batch-level only; partial rollback is refused this wave — row exclusion belongs at preview time (§8).
5. **A7 and A8 parallelize cleanly.** A7 never touches A8's files (`lib/prices/**`, the price-capture hooks in `position-capture.ts`/`investment-event-ingest.ts`); A8 never touches A7's (`lib/imports/investments/**`, the import route family). The only shared surface is `prisma/schema.prisma`, serialized by landing each stream's single additive migration on primary in merge order. A7 needs nothing from A8 — imports are quantity/event evidence; valuation is A8's concern and picks up imported history automatically because it is pure (§11).

Recommended sequence: seven slices (§14) — schema/provenance spine first, then manual opening-position assertion (the cheapest residual-closer, shippable immediately), then the pure CSV lib, routes, rollback, UI, and finally corporate-action/checkpoint depth. Slices 2 and 3 parallelize.

---

## 2. Repository audit

### 2.1 Landed state relevant to A7 (verified at HEAD `30dd557`)

| Concern | Where | Findings |
|---|---|---|
| **ImportBatch** | `prisma/schema.prisma:1932` | `financialAccountId` (Cascade), `createdByUserId`, `connectionId?`, `mappingProfileId?` (SetNull — profiles never retro-edit history), `source ImportSource`, `originalFilename`, `status`, counters (`rowCount/importedCount/skippedCount/matchedCount/failedCount`), `errorSummary Json?`, `resolvedColumnMapping Json?` (snapshot written on every import), `completedAt`. **Already has `investmentEvents InvestmentEvent[]`** with the comment "rollback soft-deletes them" — a promise the rollback route does not yet keep (see below). No `kind` discriminator — every batch is implicitly a banking-transaction batch. |
| **ImportSource / status** | `schema.prisma:1917/1923` | `CSV \| EXCEL \| QUICKBOOKS`; `PENDING \| PROCESSING \| COMPLETED \| COMPLETED_WITH_ERRORS \| ROLLED_BACK \| FAILED`. |
| **ImportMappingProfile** | `schema.prisma:2006` | Space-scoped saved `CsvColumnMap` (`@@unique([spaceId, name])`), `lastUsedAt`/`useCount`, informational `source`/`institutionLabel`. Reusable as-is for investment column maps (the `mapping Json` is shape-free). |
| **CSV framework** | `lib/imports/csv.ts` (622 lines) | 8-key banking `CsvColumnMap` (`date, merchant, description, amount, debit, credit, category, reference`), `HEADER_ALIASES`, `normalizeHeader`, `resolveColumns` (explicit → auto-detect → saved profiles, trial-applied in recency order), `normalizeRow`, `resolveFingerprintOutcome` (MATCH via externalId or unambiguous fingerprint / CREATE / SKIP-ambiguous), `computeQuickBooksUpdateDiff`. Banking-shaped throughout — **no investment columns, no quantity/symbol/action concepts**. |
| **Pipeline** | `lib/imports/pipeline.ts` | DB-free `runImportPipeline(file, opts)`: format sniff (xlsx/legacy-xls/CSV-fallback) → parse → resolve → normalize → `NormalizedTransaction[]` + `resolvedColumnMapping` + `matchedProfileId`. Returns `{error, rawHeaders?}` for the preview suggestion engine. Deliberately excludes profile fetching, fingerprint classification (sequential-write invariant), and persistence. |
| **Excel / suggest / authorize / capabilities** | `lib/imports/excel.ts`, `suggest.ts`, `authorize.ts`, `provider-capabilities.ts` | Excel converges on the same normalized rows; `suggest.ts` scores raw headers against `HEADER_ALIASES` for the preview; `resolveImportableFinancialAccount` is the shared authz (ACTIVE SpaceAccountLink); capabilities registry is one flag (`supportsUpdateOnMatch`, QuickBooks-only). |
| **Import routes** | `app/api/accounts/[id]/import/route.ts` (610), `…/import/preview/route.ts` (346) | Confirm: multipart upload → pipeline → **sequential** per-row classify-and-write loop (later rows must see earlier rows' commits — the within-file duplicate invariant) → ImportBatch finalize + profile usage bump. `importBatchId` is written **only on CREATE** — matched rows are never claimed by a batch, which is what makes rollback safe. Preview: identical pipeline + classification, zero writes. |
| **Rollback route** | `app/api/imports/[id]/rollback/route.ts` (192) | `requireFreshUser`, Space-link authz with 404-not-403 (no existence leak), creator-or-canManage permission, claim via conditional `updateMany` (concurrent-safe), idempotent already-rolled-back success, audit row. **Soft-deletes `Transaction` rows only** — `InvestmentEvent`/`PositionObservation` are untouched, and there is no reconstruction-repair hook. Explicitly documents "No SpaceSnapshot regeneration" (imports never touch `FinancialAccount.balance`). |
| **Transaction fingerprint** | `lib/transactions/fingerprint.ts` | (account, date, amount, pending) DB scope + normalized-merchant in-memory narrowing; excludes `deletedAt` rows (the D2 Step 4D-R lesson: rolled-back rows must never be adopted as matches). **Banking-shaped — unusable for investment events** (no merchant on most, quantity/type axes missing). |
| **Import UI** | — | **Does not exist.** No component in `components/**` or `app/**` calls the import, preview, or rollback routes ("any UI" was explicitly out of scope in D2 4D). A7's UI slice is the product's first import surface. |
| **Provider identities** | `ProviderAccountIdentity`, `ProviderType` (`PLAID \| MANUAL \| WALLET \| CSV \| EXCHANGE \| BROKERAGE`) | Account resolution solved; import batches pre-select the account (`ImportBatch.financialAccountId`) — no auto-account-creation, a ratified constraint A7 keeps. |
| **Holding** | `schema.prisma:1188` region; `lib/investments/sync-current-holdings.ts` (A2) | Stable per-holding upsert replaced the destructive rewrite. Holding remains the current-state read model; **A7 never writes Holding** — imported history is invisible to it by design. |
| **InvestmentEvent** | `schema.prisma:1385` | Exactly the plan §5.4 shape plus A3 hardening: `providerSecurityId`, `mapperVersion`, corporate-action fields (`relatedInstrumentId`, `ratio`), `OPENING_BALANCE` and `SYMBOL_CHANGE` in the enum ("imports / corporate-action data only — never from Plaid"), `importBatchId` (SetNull), `createdByUserId`, `supersededById`, `deletedAt`, `@@unique([source, externalEventId])` (nulls exempt). **The import target table exists and is import-ready.** |
| **PositionObservation** | `schema.prisma:1310` | `origin PositionOrigin` includes `IMPORTED` and `USER_ASSERTED` (reserved since A1, never yet written); observed-only valuation facts (`institutionPrice/Value/PriceAsOf`, `costBasis`, `vestedQuantity`); derived-only reconstruction fields; `supersededById`; `@@unique([financialAccountId, instrumentId, date, origin, source])`. **No `importBatchId`, no `deletedAt`** — the two gaps rollback needs (§4, §8). |
| **PositionReconstruction** | `schema.prisma:1456` | Per-(account, instrument) summary: `earliestDefensibleDate`, `openingQuantity`, `unexplainedOpeningQuantity` (never forced to 0), `reconciliation` (job outcome) vs `completeness` (canonical A5-S1 tier, write-time guarded), `conflicted`, `reconstructionVersion`, `evidenceRefs`, upserted on rerun. |
| **Reconstruction core** | `lib/investments/reconstruction-core.ts` | Backward walk; deterministic total order (date, source, externalEventId, id); CANCEL netting with `conflicted` flag; cash-only events route to the currency's CASH instrument; **SPLIT with known ratio divides backward (`q = q / ratio`) — already import-ready**; SPLIT without ratio, MERGER, SPIN_OFF stop with `UNSUPPORTED_CORPORATE_ACTION`; material UNKNOWN quantity stops with `UNKNOWN_EVENT`. `OPENING_BALANCE` is not special-cased — it routes as a signed quantity event, which is exactly right: an opening event dated at the walk's boundary "explains" its quantity and shrinks the residual arithmetically. |
| **Reconstruction runner / repair** | `lib/investments/reconstruction-runner.ts` | `gatherReconstructionInputs` filters events by **`deletedAt: null, supersededById: null`** — rollback soft-deletes will re-widen residuals with zero additional code; `reconstructAccount` + `repairReconstructionForAccount({financialAccountId, instrumentIds})` (A4-3 bounded repair, non-fatal, gated on `INVESTMENT_RECONSTRUCTION_ENABLED`); `assertCanonicalCompleteness` write-guard. |
| **Reconstruction read** | `lib/investments/reconstruction-read.ts` (A4-4, committed `4b6af85`) | `resolvePositionAsOf` origin precedence **OBSERVED > IMPORTED > DERIVED > USER_ASSERTED** — imported rows already rank second; `IMPORTED` and `USER_ASSERTED` rows read as tier `observed` (with source attribution downstream); gap ⇒ `incomplete`, never a fabricated 0. `getPositionQuantityAsOf`, `describeReconstruction`, `toPositionHonesty`. **The read model was built expecting A7's rows.** |
| **Ingestion hook precedent** | `lib/investments/investment-event-ingest.ts` (A3-3/A4-3) | Dedupe by `[source, externalEventId]`; restatement = append + supersede (`isMaterialInvestmentEventChange`); after ingest, bounded repair fires per touched (account, instruments), wrapped non-fatal with `recordSyncIssue` on failure. **This is A7's commit-path template.** |
| **Instrument resolution** | `lib/investments/instrument-resolver.ts` | Pure `decideResolution` core + `resolveInstrumentForPlaidSecurity` binding (alias → CUSIP → ISIN → SEDOL → create-weak-key; `strongIdsConflict` refuses merges, `recordSyncIssue` on conflict). **Plaid-shaped binding only** — A7 needs a sibling binding for (symbol, cusip?, name?) import identity that reuses the same pure core (§3.4). |
| **Perspective/UI substrate** | A5/A6 landed; shell as-of control at HEAD | Canonical `CompletenessTier` vocabulary + `worstTier` helpers; badges and as-of control conventions exist for the UI slice to reuse. |
| **Flags** | env-based | `INVESTMENT_OBSERVATIONS_ENABLED`, `INVESTMENT_EVENTS_ENABLED`, `INVESTMENT_RECONSTRUCTION_ENABLED`. A7 adds `INVESTMENT_IMPORTS_ENABLED`. |
| **A8 state** | — | `lib/prices/` does not exist; no `PriceObservation`. A8 has not started — consistent with the canonical roadmap, and confirming A7 must not depend on it. |

### 2.2 Gaps A7 must close (the delta, exactly)

1. No investment column contract, header aliases, or action-string mapping — `CsvColumnMap` is banking-only.
2. No investment dedupe classifier — the banking fingerprint's axes (merchant, pending) don't exist on investment events.
3. `PositionObservation` cannot participate in rollback (`importBatchId`/`deletedAt` missing) and `origin: IMPORTED`/`USER_ASSERTED` rows have no writer.
4. The rollback route ignores `InvestmentEvent` despite the schema's promise, and triggers no reconstruction repair.
5. No import commit path for investment batches (the banking route writes `Transaction` rows).
6. No import UI of any kind.
7. No user-decision (override) record on `ImportBatch`; no `kind` discriminator.
8. Reconstruction has no mid-history checkpoint comparison (imported statement anchors are stored but not reconciled against the walk).
9. Merger/spin-off inversion: the core stops even when an imported ratio is known (only SPLIT inverts).

---

## 3. Canonical import architecture

### 3.1 Import model ruling: **both — events canonical, positions as anchors**

| Option | Verdict |
|---|---|
| Transactions only | Rejected. Brokerage exports frequently predate available transaction history with a positions statement ("holdings as of 2019-12-31"); refusing those refuses the single most common piece of paper users actually have. And an unexplained residual can often *only* be closed by a position assertion. |
| Positions only | Rejected. Positions without events give anchors with no walk between them — no flow history, no contribution/withdrawal facts for A9/A10, no dividend history. |
| **Both** | **Adopted.** Events (`InvestmentEvent`) are the canonical imported substance; position statements are `PositionObservation(origin: IMPORTED)` anchors; opening positions are the composite (§6). This is precisely the evidence-class model the progressive-evidence plan ratified (§3.1–§3.2 there): *imported brokerage event* and *imported opening position* are distinct evidence classes with distinct representations, and A4 was built to consume both. |

One `ImportBatch` may carry both kinds of rows (a Schwab "full history" export contains transactions; a statement import contains positions; a combined flow imports each file as its own batch). The batch-level discriminator is `kind: INVESTMENT_HISTORY` (vs the implicit banking `TRANSACTIONS`), not per-row.

### 3.2 Supported sources and adapter tiers

| Source | Tier | Ruling |
|---|---|---|
| **Brokerage transaction CSV — Schwab profile** | **First-class, first** | Highest evidence value (dated events with quantities, amounts, fees) for the one real connected brokerage in the dataset. Ships as a built-in profile: header aliases + action-string table (`"Buy" → BUY`, `"Reinvest Shares" → REINVESTMENT`, `"Stock Split" → SPLIT`, …). |
| **Brokerage transaction CSV — Fidelity profile** | First-class, second | Same mechanism, second table. Profiles are data; each additional broker is a table + fixtures, not code. |
| **Generic investment CSV** | **First-class** | The canonical column contract (§3.3) + the existing explicit-mapping / saved-`ImportMappingProfile` UX. Any broker not yet profiled imports through this. |
| **Brokerage statement export (positions CSV)** | First-class | The positions-as-of import: symbol/quantity/(basis) at a statement date → `IMPORTED` observations (§6.3). |
| **Manual historical entry** | **First-class** | Opening-position assertion (instrument, quantity, as-of date, optional basis) — no file at all. The cheapest residual-closer; ships before any CSV parsing exists (§14, slice A7-2). |
| **Excel** | Rides free | `runImportPipeline`'s sniff already converges Excel onto normalized rows; the investment pipeline reuses it. |
| **OFX/QFX (`<INVTRAN>`)** | Second wave, designed-for | Structured and dedupe-friendly (`FITID` → `externalEventId`). The A7 normalizer contract (§3.4) is format-neutral so an OFX parser slots in as a third producer of `NormalizedInvestmentRow[]` with **zero** downstream change. Adds `OFX` to `ImportSource` when built — not in A7's migration (don't manufacture enum values nothing writes). |
| **Future API providers (Coinbase, brokers)** | **Not imports** | They are Connections (credentialed, syncing) — the D2 Step 6 first-provider architecture. Their events enter through ingestion adapters like Plaid's, sharing the `InvestmentEvent` table and dedupe keys but none of the import pipeline. |
| **PDF statements** | Deferred | OCR reliability is below the provenance bar ("original values preserved verbatim" cannot be promised through OCR). Revisit only with a concrete need. |

### 3.3 Canonical investment column contract

New `InvestmentCsvColumnMap` in a new module family `lib/imports/investments/` — the banking `CsvColumnMap` is **not** widened (its 8 keys and alias table are load-bearing for existing imports; the D2 architecture review explicitly kept formats from being forced into one shape):

```
account        — pre-selected (ImportBatch.financialAccountId; never auto-created)
rowKind?       — TRANSACTION | POSITION (statement imports; default TRANSACTION)
tradeDate      — required for transactions; statement date for positions
settlementDate?
action         — raw broker action string (mapped per profile; preserved verbatim)
symbol         — required identity input (ticker)
cusip?         — strong identity when present
description?   — security name / institution text (verbatim)
quantity       — signed or unsigned per profile (sign convention per action table)
price?
grossAmount?   — cash leg
fees?
currency?      — default: account currency
reference?     — broker transaction/confirm number → externalEventId when present
costBasis?     — positions/openings: aggregate basis
lotData?       — preserved verbatim into importedRaw; NEVER interpreted (tax lots out of scope)
```

Header aliases live in `lib/imports/investments/columns.ts` (the `HEADER_ALIASES` pattern); broker profiles supply both column aliases and the action table. `ImportMappingProfile` is reused unchanged for user-saved column maps — its `mapping Json` is shape-free and `resolvedColumnMapping` snapshots whatever shape was used.

### 3.4 Module architecture (all new; the banking framework is touched at exactly two seams)

```
lib/imports/investments/
  types.ts        — InvestmentCsvColumnMap, NormalizedInvestmentRow, profile interfaces
  columns.ts      — canonical aliases + resolveInvestmentColumns (mirrors csv.ts resolveColumns)
  profiles.ts     — built-in broker profiles (Schwab, Fidelity, generic): column aliases +
                    action→InvestmentEventType tables + sign conventions; versioned (profileVersion)
  normalize.ts    — pure row normalizer: raw row → NormalizedInvestmentRow (canonical type,
                    signed quantity, FM cash-leg sign, verbatim raws) — total: unmappable
                    action ⇒ type UNKNOWN with raws intact, never a dropped row
  row-identity.ts — externalEventId derivation: broker reference when mapped, else
                    deterministic content hash + within-file ordinal (§5.2)
  dedupe.ts       — pure dedupe classifier core (§5): decideInvestmentRowOutcome
  pipeline.ts     — runInvestmentImportPipeline (format sniff reused from lib/imports/pipeline.ts
                    internals; DB-free; returns rows + resolved mapping + profile match)
lib/investments/
  instrument-resolver-import.ts — binding for import identity (symbol/cusip/name), reusing
                    decideResolution + strongIdsConflict from instrument-resolver.ts (read-only import)
  investment-import-commit.ts   — the commit path: batch write + dedupe + supersession +
                    bounded-repair hook (the investment-event-ingest.ts template)
  opening-position.ts           — manual assertion writer (event + observation pair)
app/api/accounts/[id]/import/investments/
  preview/route.ts — read-only preview (authorize.ts reused; zero writes)
  route.ts         — confirm (sequential write loop; ImportBatch kind INVESTMENT_HISTORY)
app/api/imports/[id]/rollback/route.ts — EXTENDED (§8; the one edited shared file)
app/api/investments/opening-position/route.ts — manual assertion endpoint
```

Seam rulings: separate investment routes (not a `kind` param on the banking route) because the banking confirm route's 610 lines are single-purpose and stable — forking its body around a kind switch risks the framework A7 wants to inherit; both route families share `authorize.ts`, `ImportMappingProfile` loading, and the batch/counter/status conventions. Instrument resolution for imports is a **sibling binding, not an edit** to `instrument-resolver.ts` (which the A8 stream reads): resolution order for imports is provider alias (`csv:<profileKey>` aliases learned from prior imports) → CUSIP → weak key `(tickerSymbol, currency)` match against existing instruments → create-with-weak-key + alias. Ambiguity (two instruments match the weak key) refuses and surfaces in preview — never guesses (the `MerchantAlias` doctrine).

---

## 4. Evidence and provenance model

Every imported row must answer, forever: where did this come from, what did the file actually say, and how was it interpreted. The canonical model, per layer:

**Batch level (`ImportBatch`, existing + additive):**

| Field | Status | Content |
|---|---|---|
| `source` | exists | `CSV \| EXCEL` (file format) |
| `kind` | **new** — `ImportBatchKind @default(TRANSACTIONS)`: `TRANSACTIONS \| INVESTMENT_HISTORY` | what the batch imported; default keeps every existing row honest with zero backfill |
| `originalFilename` | exists | verbatim |
| `financialAccountId`, `createdByUserId`, timestamps, `completedAt` | exist | who/where/when |
| `resolvedColumnMapping` | exists | the actual column map used (snapshot — profiles edited later never retro-change history) |
| `mappingProfileId` | exists | which saved profile matched, if any |
| **mapping version** | via snapshot + row `mapperVersion` | the built-in broker profile's `profileVersion` is recorded inside `resolvedColumnMapping` (`{profileKey, profileVersion, columns…}`) and per-row as `InvestmentEvent.mapperVersion` — both interpretation layers are pinned |
| `userDecisions` | **new** — `Json?` | the per-row overrides the user made at preview (force-create, exclude, type remap), keyed by row identity — the batch's audit of human intervention (§5.5) |
| counters + `errorSummary` | exist | immutable facts about what the import did (the rollback route's ratified posture) |

**Row level (`InvestmentEvent`, existing + one additive column):**

- `source` — `"csv:schwab" | "csv:fidelity" | "csv:generic" | "user"` (profile-keyed; never a bare `"csv"`, so `[source, externalEventId]` cannot collide across brokers).
- `externalEventId` — broker reference when present, else the deterministic row identity (§5.2).
- `providerType`/`providerSubtype` — the **raw action string** verbatim (and sub-action where the profile distinguishes one), exactly the `Transaction.pfc*` pattern.
- `description` — verbatim institution text.
- `mapperVersion` — the profile version that produced the canonical mapping.
- `importedRaw Json?` — **new**: the complete original row values (header→cell, untyped strings), including `lotData`. Null = not an import (MC1: null is never a manufactured claim; Plaid rows already preserve their raws in the provider columns). This is what makes "re-interpret under a corrected profile" and "show the user exactly what their file said" possible forever, and it is the honest home for lot detail we refuse to interpret.
- `importBatchId`, `createdByUserId`, `supersededById`, `deletedAt` — exist; the append/supersede/rollback machinery.

**Observation level (`PositionObservation`, two additive columns):**

- `importBatchId String?` (SetNull relation) — imported/asserted rows join their batch; required for exact rollback (§8).
- `deletedAt DateTime?` — rollback soft-delete, mirroring `InvestmentEvent`. Read paths that consume observations gain a `deletedAt: null` filter (enumerated in §8.2 — there are four).
- `origin: IMPORTED, source: "csv:<profileKey>"` for statement rows; `origin: USER_ASSERTED, source: "user"` for manual assertions; `costBasis` carries imported/asserted aggregate basis (field exists).

This one migration (batch kind + userDecisions, observation importBatchId + deletedAt, event importedRaw) is **A7's only schema change** — everything else the provenance contract needs already landed in A1/A3.

---

## 5. Deduplication strategy

### 5.1 The layered decision procedure (deterministic, in order)

For each normalized row, `decideInvestmentRowOutcome` (pure core, DB candidates injected):

1. **Within-source exact:** a live (`deletedAt: null`) `InvestmentEvent` with the same `[source, externalEventId]` ⇒ **MATCH** (re-import of the same file, or overlapping exports from the same broker). Never mutates the existing row — `supportsUpdateOnMatch: false` for all investment sources (QuickBooks-style overwrite has no earned investment counterpart).
2. **Cross-source fingerprint** (vs Plaid, other broker profiles, manual rows): candidates = live, non-superseded events for the same `financialAccountId` and `date`, narrowed in memory by:
   - security rows: same `instrumentId`, same canonical `type`, `|quantityΔ| ≤ QUANTITY_EPSILON`, `||amount|Δ| ≤` monetary epsilon (amount compared absolute — sign conventions differ across sources; null amounts compare as wildcards, null-vs-null only);
   - cash-only rows (`instrumentId: null`): same canonical `type` + `||amount|Δ| ≤` epsilon;
   - corporate actions: same `instrumentId`, `type`, and `ratio` (exact or both-null);
   - transfers: same `instrumentId`, `type` (`TRANSFER_IN`/`TRANSFER_OUT` directional), `|quantityΔ| ≤ ε`.
   Exactly **one** candidate ⇒ **MATCH** (`matchedCount++`, no write, no batch claim — the banking rule that makes rollback safe). More than one ⇒ **SKIP** (`AMBIGUOUS`, recorded in `errorSummary`, surfaced in preview). Zero ⇒ continue.
3. **Opening/position special case (§6.4):** an opening assertion or statement row for an (account, instrument, date) that already has a same-date observation of equal or stronger origin ⇒ MATCH; weaker existing evidence that the new row explains ⇒ CREATE + supersede (§5.4).
4. Otherwise ⇒ **CREATE**.

Rows dated outside any existing evidence (typically before the Plaid 24-month window) will simply find zero candidates and CREATE — this is the "extend the event log backward" case and needs no special path. Within the Plaid window, step 2 is the load-bearing guard against double-counting the same buy from both Plaid and a Schwab export.

Candidate fetching is **batched** (one `findMany` per account over the file's date range, grouped in memory) — not the banking loop's per-row queries; investment files are routinely thousands of rows (§13 performance). The sequential-write invariant is preserved where it matters: rows are *written* sequentially in file order so within-file duplicates land on MATCH against the earlier row's just-committed insert (identical rows in one file are additionally disambiguated by the ordinal in §5.2, so true duplicates in the source file import as distinct events only when the broker genuinely listed them twice with distinct references).

### 5.2 Row identity (`externalEventId` derivation)

Priority: (1) the broker reference/confirm number when the profile maps one — durable across re-exports; (2) else `h = sha256(canonical(tradeDate, rawAction, symbol, quantity, grossAmount, price))` + `-n` ordinal suffix for the nth identical tuple within the file. Properties: re-importing the same file is a full-MATCH no-op; re-importing an overlapping longer export MATCHes the overlap and CREATEs the extension; the hash never includes filename or import date (re-exports stay stable); identical-tuple rows are preserved (two real same-day same-size buys import as two events — the ordinal keys them — while re-imports of both still MATCH).

### 5.3 Dedupe against each evidence class (the brief's list, explicitly)

| Against | Mechanism |
|---|---|
| Plaid events | Fingerprint layer 2 (source differs, so layer 1 never fires). |
| Future providers | Same — provider adapters write their own `source`; fingerprints are source-blind. |
| Manual entries | Layer 2/3; a manual `OPENING_BALANCE` that an import now explains is superseded, not duplicated (§5.4). |
| Existing InvestmentEvents (prior imports) | Layer 1 within the same profile; layer 2 across profiles. |
| PositionObservations | Position/statement rows dedupe on the observation unique key `[account, instrument, date, origin, source]` (same-source re-import upserts the same row); cross-origin same-date handled by precedence, not dedupe — an IMPORTED row coexisting with an OBSERVED row on one date is *correct* (two evidence classes), and `resolvePositionAsOf`'s origin ranking already picks OBSERVED. |
| Opening positions | §6.4. |
| Corporate actions | Layer 2 corporate-action fingerprint (instrument, date, type, ratio). |
| Cash movements | Layer 2 cash fingerprint (date, type, \|amount\|) routed against the account's cash-instrument walk. |
| Transfers | Layer 2 directional fingerprint; the Chase→Schwab funding link remains a read-time resolver concern (never persisted), so no transfer-pairing rows are created at import. |

### 5.4 Supersession (evidence improving evidence, never erasing it)

On CREATE, the committer checks whether the new row *explains* existing weaker evidence: an imported buy history for (account, instrument) whose walk now covers a `USER_ASSERTED` opening assertion ⇒ the assertion's event/observation rows get `supersededById` pointed at the batch's evidence (append + supersede, the A3 restatement machinery reused verbatim). Precedence follows the plan's §3.3 per-claim rules: provider observation > imported > derived > user-asserted for "what was held on D"; imported > user-asserted for pre-provider history. Supersession is recorded (row pointer + note in `errorSummary`) so preview/commit summaries can say "your manual estimate for AAPL was replaced by your Schwab history."

### 5.5 Ambiguity handling and user override philosophy

- **FM never guesses.** Ambiguous fingerprints SKIP; ambiguous instrument identity refuses and surfaces (§3.4); unmappable actions become `UNKNOWN` events with raws intact (which the reconstruction core will treat as a stop if they carry material quantity — honest, visible, fixable).
- **The user resolves at preview, explicitly and per-row:** force-create a SKIPPED/MATCHED row ("these really are two transactions"), exclude any row, remap an action string to a canonical type (optionally saving it into their profile). Overrides are the *correction-of-FM's-interpretation* claim type, where the ratified MI `USER_OVERRIDE` rule applies: the human correction dominates the classifier.
- **Overrides are provenance, not mutation:** recorded in `ImportBatch.userDecisions` keyed by row identity, applied at commit, visible in history. The user can never edit imported *values* in the preview (fix the file and re-import) — the imported row must remain what the file said.
- **Overrides are batch-scoped, not rules:** a force-create decision never generalizes into a matching rule; only explicit action-type remaps saved to a profile persist beyond the batch (and bump the profile version).

---

## 6. Opening position strategy

### 6.1 The composite representation (ratified in the plan §8.1.3, now made exact)

An opening position — "I held Q of X on date D, (optionally) with basis B" — writes **two rows atomically**:

1. `InvestmentEvent { type: OPENING_BALANCE, date: D, quantity: +Q, price: unit basis when known else null, source: "user" | "csv:<profile>", createdByUserId | importBatchId }` — the event the reconstruction walk consumes. The core needs **zero changes**: `OPENING_BALANCE` routes as a signed quantity event, so the backward walk subtracts Q at D and the opening residual shrinks by exactly Q. If the walk's residual was Q, the summary flips PARTIAL → COMPLETE.
2. `PositionObservation { origin: USER_ASSERTED | IMPORTED, date: D, quantity: Q, costBasis: B?, source, importBatchId? }` — the anchor/read-path row: `resolvePositionAsOf` answers "what did I hold on D" from it directly (tier `observed`, attributed), independent of whether reconstruction has run.

### 6.2 Basis, lots, fractions, unknowns

| Concern | Ruling |
|---|---|
| Cost basis | Aggregate basis on `PositionObservation.costBasis` (field exists); unit basis on the event's `price` when the source states it. Provider basis (Plaid aggregate `costBasis`) keeps its provider-derived labeling; imported basis is imported-observed; manual is user-asserted — the plan's §12 tier table, unchanged. |
| Lots / partial lots | **Preserved verbatim in `importedRaw.lotData`, never interpreted.** Tax-lot semantics (method elections, wash sales, jurisdiction) are the plan's explicitly-out-of-scope capability 4. Refusing to interpret lots is not losing them — they are on-row forever for the future capability that earns them. |
| Fractional shares | Floats under `QUANTITY_EPSILON` (existing core constant); no new precision machinery. |
| Unknown basis | `null` — MC1, never a manufactured 0 or an inferred market price. Downstream unrealized-gain displays already refuse null-basis rows (A10's ratified refusal). |
| Manual basis correction | A new assertion supersedes the old (append + supersede); the user's latest statement wins among user-asserted rows. |

### 6.3 Statement imports (positions-as-of mid-history)

A brokerage statement's holdings table imports as one `PositionObservation(origin: IMPORTED)` row per (instrument, statement date) — **anchors, not events**. Read paths consume them immediately (origin rank 2). Reconstruction treats them as **checkpoints** (slice A7-7): after the walk, each IMPORTED anchor inside the walk window is compared against the walk's quantity at that date; disagreement beyond epsilon sets `conflicted` on the summary with the checkpoint in `evidenceRefs` — sources disagree, and the UI must say so rather than average. Checkpoints deliberately do **not** re-anchor the walk in A7 (multi-anchor segmented walks are a core rewrite the data hasn't earned; a conflict flag is the honest first step).

### 6.4 Dedupe/precedence for openings

Same (account, instrument): an existing `OPENING_BALANCE` from the same source at the same date+quantity ⇒ MATCH. An existing *user* assertion when an *import* arrives that explains or restates it ⇒ import CREATEs and supersedes (imported > user-asserted for pre-provider history). An import arriving *under* an existing stronger observation (provider OBSERVED on that same date) ⇒ the observation already wins at read time; the imported row still CREATEs (it is distinct evidence, and its basis may be the only basis we have) — precedence is a read-time ranking, not a write-time rejection.

---

## 7. Corporate action strategy

**Ruling: imported files become canonical corporate-action evidence — the first and only source of it** (Plaid supplies subtype labels but never ratios or related instruments; the A3 mapper stops at labeling).

| Action | Import representation | Reconstruction behavior |
|---|---|---|
| Split / reverse split | `InvestmentEvent { type: SPLIT, ratio (new:old, e.g. 4.0 or 0.25), instrumentId }` | **Already works:** the core divides backward through ratio-known splits (`q = q / ratio`) and stops only when ratio is null. An imported ratio converts a FAILED walk into a walk-through — the single highest-leverage import for long-held positions. |
| Merger (stock) | `MERGER` on the acquired instrument with `relatedInstrumentId` (acquirer) + `ratio` (shares-received per share-held) | Core currently stops at MERGER unconditionally. Slice A7-7 extends inversion: with ratio + related instrument known, the acquired walk ends at the action date (quantity → 0) and the acquirer's walk reverses the received quantity. Without both, stop as today — never guess merger terms. |
| Cash merger | `MERGER` with a cash `amount` leg and no `relatedInstrumentId` | Position walk ends at action date; the cash leg routes to the CASH instrument's walk (existing cash-routing). Ratio-less by nature — invertible because the position goes to zero. |
| Spin-off | `SPIN_OFF` on the parent with `relatedInstrumentId` (child) + `ratio` | Same A7-7 extension shape as merger (child's walk gains its opening from the action; parent's quantity unchanged). Without terms, stop. |
| Symbol / ticker change | `SYMBOL_CHANGE` event linking old→new + an `InstrumentAlias` addition on the surviving Instrument; instrument merge (alias repointing + `supersededById` on the loser) **only** when strong identifiers agree or the user confirms — `strongIdsConflict` refusal + `recordSyncIssue` otherwise | No quantity effect; identity is an Instrument concern, invisible to the walk (the plan §4.1 rule, unchanged). |

Corporate-action rows dedupe on (instrument, date, type, ratio) (§5.3), carry full provenance like every imported row, and roll back with their batch — a rollback that removes an imported split ratio correctly re-FAILs the affected walk (the honest state before the evidence existed). Sequencing: A7-4 imports corporate-action rows as evidence (splits immediately improve walks; mergers/spin-offs recorded but still stops); A7-7 adds merger/spin-off inversion with fixtures.

---

## 8. Rollback strategy

### 8.1 Batch rollback (extend the existing route — same claim, authz, idempotency)

The existing route's machinery (fresh-session requirement, Space-link 404-not-403, creator-or-canManage, conditional-updateMany claim, idempotent re-rollback, audit row) is reused unchanged. Inside the claimed transaction, an `INVESTMENT_HISTORY` batch additionally:

1. Soft-deletes `InvestmentEvent` rows: `{ importBatchId, deletedAt: null } → { deletedAt: now }` — finally keeping the A3 schema comment's promise.
2. Soft-deletes `PositionObservation` rows the batch created: `{ importBatchId, deletedAt: null } → { deletedAt: now }` (the new columns, §4).
3. **Un-supersedes:** any live row whose `supersededById` points at a row in this batch gets the pointer cleared — the user assertion the import had superseded honestly *comes back* (its evidence-class standing was never erased, only outranked; the outranking evidence is now gone).
4. Records per-table counts in the audit metadata.

After commit (outside the transaction, non-fatal — the ingestion hook's exact posture): bounded reconstruction repair per affected (account, distinct instrumentIds of the batch's rows) via `repairReconstructionForAccount`. Because `gatherReconstructionInputs` already filters `deletedAt: null, supersededById: null`, **residuals re-widen with zero core changes** — the repair simply recomputes without the batch's evidence, and `unexplainedOpeningQuantity` grows back. This symmetry (import shrinks residuals, rollback re-widens them, both through the same repair path) is the load-bearing honesty property and gets a dedicated round-trip test (§13).

### 8.2 The `deletedAt` read-path closure

Adding `PositionObservation.deletedAt` obligates a `deletedAt: null` filter at every observation consumer. Enumerated (complete list at HEAD): `reconstruction-runner.gatherReconstructionInputs` (observation anchor fetch), `reconstruction-read.getPositionQuantityAsOf`/`getPositionReconstructions` (row fetches), `position-capture.computeDisappearedInstrumentIds` (prior-observation scan), and `brokerage-cash.ts` (residual derivation reads). Four sites, all filter additions, all in A7-owned or A7-editable files this wave (none is touched by the A8 stream — verified against the parallelization matrix, §12).

### 8.3 Partial rollback — refused this wave

Row-level rollback is refused: the batch is the atomic evidence unit; counters/`errorSummary`/`userDecisions` are immutable facts about what the import did; and per-row un-import invites inconsistent supersession states (a row that superseded an assertion is removed but its sibling remains — which assertion state is honest?). The preview's per-row *exclude* is where row granularity lives — before evidence is committed, not after. A user who imported the wrong file rolls back the batch and re-imports. Re-import after rollback works because every dedupe path excludes soft-deleted rows (the D2 Step 4D-R lesson, already enforced in `fingerprint.ts` and carried into `dedupe.ts`).

### 8.4 Repair scope after rollback

- **Reconstruction:** bounded repair as above — DERIVED rows regenerate for affected (account, instrument) walks only.
- **Snapshots:** none in A7. Imports never touch `FinancialAccount.balance` (the rollback route's documented invariant holds — investment history feeds valuation only through A8/A9, which don't exist yet). When A9 lands, its affected-window trigger subscribes to the same post-rollback hook (§9).
- **Timeline:** the activity timeline doesn't render imports (nothing to repair); the financial Timeline (A11) doesn't exist. The affected-window computation exported for A9 (§9) is the same contract A11 will consume — no A7 work beyond exporting it.

---

## 9. Regeneration strategy

| Interaction | Ruling |
|---|---|
| **A4 Position Reconstruction** | **Immediate, synchronous, bounded, non-fatal** — on commit and on rollback, fire `repairReconstructionForAccount` per affected (account, instruments), exactly the `investment-event-ingest.ts` hook (append events → repair touched walks). Volumes are small (one account per batch, tens of instruments); the ingestion precedent is synchronous and has held in production; a queue is machinery the data hasn't earned. Failure is logged + `recordSyncIssue`, never fails the import; `scripts/run-reconstruction.ts` is the manual recovery path. |
| **A8 Historical Valuation** | **No trigger needed, ever.** The A8 design (parallelization investigation §4, canonical-A8 valuation) is pure/runtime — arithmetic over `PositionObservation`/`PriceObservation`/`FxRate` at read time. Imported quantities improve valuations automatically the moment they exist. A7 must simply not break A8's inputs: imported observations carry no `institutionPrice`/`institutionValue` (those are observed-only facts; an imported statement's stated value could arguably qualify — deferred, recorded as an open question in §14 slice A7-7, defaulting to null per MC1). |
| **A9 Wealth Regeneration** | **Deferred wiring, exported contract now.** `investment-import-commit.ts` exports `computeAffectedWindow(batch): { financialAccountIds, instrumentIds, fromDate: min(event/observation dates), toDate: today }` — the exact shape A9's bounded regeneration takes (instruments → accounts → SpaceAccountLink spaces × [min affected date, next frozen row]). A9's integration commit subscribes both the commit hook and the rollback hook to it. A7 wires nothing into `lib/snapshots/**` (A9-owned; frozen-row rules are A9's to enforce). |
| Immediate vs queued vs manual | Reconstruction: immediate (above). Wealth regeneration: A9's decision — its investigation already rules bounded/explicit-window with dark runs; A7 just feeds the window. Manual: existing script for reconstruction; A9's script for snapshots. Nothing in A7 is fire-and-forget without a manual recovery path. |

---

## 10. UI workflow

A7 ships the product's **first** import UI (the banking framework never got one). Design once, shaped so the banking import can adopt the same wizard later.

**Entry points:** "Import history" on the Investments account card / account detail (investment-type accounts with an ACTIVE link, FULL visibility); "Explain this position…" affordance on any position row showing an unexplained residual (opens the manual opening-position form directly — the honesty badges from A4-4's `describeReconstruction` are the natural doorway).

**Wizard (one route-family consumer, four steps):**

1. **Create Import** — file drop (CSV/XLSX) + broker profile select (Schwab / Fidelity / Generic / saved profiles) + import kind (transaction history / positions statement) + sign convention where the profile needs it. Account is fixed by the entry point (never chosen mid-flow; never auto-created).
2. **Preview** (the read-only preview route; zero writes) —
   - **Mapping panel:** resolved columns with per-header suggestions on failure (the `suggest.ts` pattern); action-string table preview showing raw → canonical type with counts; "save as profile" (name, Space-scoped).
   - **Row table:** every row with its outcome — CREATE / MATCH (with the matched event's source: "already in your Plaid history") / SKIP-ambiguous (candidates shown) / FAILED (parse reason) / UNKNOWN-type (raw action shown).
   - **Warnings:** unmapped actions, unresolvable symbols (with the refuse-don't-guess identity explanation), rows predating the account, splits without ratios, lot data detected ("preserved, not interpreted").
   - **Duplicates & conflicts:** the MATCH/SKIP groups with per-row override controls — force-create, exclude, remap type. Every override is explicit and listed in a "your decisions" summary.
   - **Honesty preview:** per-instrument projected effect — "AAPL: 20 shares unexplained today → 0 after import" — computed by a dry-run of the walk over (existing + would-create) events. This is the number that makes the import feel like what it is: evidence.
3. **Commit** — progress, then the result: counters, per-instrument residual before → after (from the actual post-commit repair), superseded assertions ("your manual estimate was replaced"), link to the batch.
4. **History & rollback** — per-account import history (batch list: filename, kind, source/profile, date, counters, status), rollback with a consequence-stating confirm ("removes 214 imported events; 3 positions return to unexplained"), rolled-back batches remain visible (history, not erasure).

**Presentation rules (inherited, not new):** imported evidence renders with source attribution ("from your Schwab import"), never styled as provider-observed (the pixel rule); completeness copy is user-facing ("Reconstructed", "N shares unexplained before …"), never tier names; the S4 badge/control conventions are reused. The manual opening-position form is the same evidence flow at n=1: instrument (search existing + create-by-symbol), quantity, as-of date, optional basis, and an honest preview of the residual effect.

---

## 11. Parallelization analysis

**Can A7 implement safely alongside A8? Yes — by construction, with one serialized surface.**

- **No data dependency either way.** A7 consumes quantities/events (A1–A4, all landed). A8 consumes instruments + observations (landed) and its own price rows. A7's imported history improves A8's valuation *coverage* at runtime, but neither stream imports the other's modules. A8's observed-anchor valuation and fixture-tested price service are green with zero imported rows; A7's residual arithmetic is green with zero price rows.
- **No shared writable files.** A7's new modules (`lib/imports/investments/**`, `lib/investments/{instrument-resolver-import, investment-import-commit, opening-position}.ts`, the investment import routes) collide with nothing in A8's plan (`lib/prices/**`, `jobs/fetch-security-prices*`, vendor adapters). The two files A8 hooks for same-day price capture — `position-capture.ts` and `investment-event-ingest.ts` — are exactly the two investment files **A7 must not edit** (A7's commit path is its own module precisely so the ingest file stays A8's). A7's four `deletedAt` filter edits (§8.2) touch `reconstruction-runner.ts`, `reconstruction-read.ts`, `position-capture.ts`, `brokerage-cash.ts` — of which `position-capture.ts` overlaps A8's hook file. **Resolution:** the filter edit in `position-capture.ts` lands in A7-1 (the spine slice, on primary, before fan-out) so the worktree streams never both hold it. Same for the rollback route (A7-owned exclusively; A8 never touches routes).
- **Schema serialization.** Both streams carry one additive migration (A7-1's provenance columns; A8's `PriceObservation`). Migrations land on primary serialized — A7-1 first (it is smaller and unblocks A7's whole stream), A8's spine second, or in whichever order primary sequences them; the tables are disjoint so order is a formality, not a risk.
- **Shared contracts (read-only for both):** `Instrument`/`InstrumentAlias` + the pure `decideResolution` core; `InvestmentEvent` (A7 writes rows, A8's canonical-A8 valuation never reads events — flows are A10's concern); `PositionObservation` (A7 writes IMPORTED rows; A8 valuation reads them through `getPositionQuantityAsOf`, which handles origins already); the canonical `CompletenessTier` vocabulary; `repairReconstructionForAccount` (A7 calls; A8 doesn't).
- **Merge order:** A7-1 spine on primary → A7 stream in worktree `fm-a7-imports`, A8 streams per the ratified topology in the parallelization investigation. A7's merges are independent of A8's vendor gate — the one external blocker of the wave blocks neither A7 slice. A9 integration (trigger wiring) remains one post-merge commit on primary, now subscribing both A8 backfill completion *and* A7 batch commit/rollback to regeneration (§9).
- **A9/A10 conflict forecast:** A9 touches `lib/snapshots/**` (A7 never does) plus the integration commit (primary-owned). A10 touches investment widgets + `SpaceDashboard.tsx` (primary-owned, serialized) and reads `reconstruction-read.ts` (frozen after A7-1's filter edit). The A7 UI slice (A7-6) is primary-branch work by the same single-owner rule the shell has always had.

---

## 12. File ownership matrix

Legend: **P** = primary branch · **A7** = this stream (worktree after A7-1) · **A8/A9/A10** = future streams · R = read-only.

| Surface | Files | Owner | Others | Conflict risk |
|---|---|---|---|---|
| Schema + A7 migration | `prisma/schema.prisma`, `prisma/migrations/*_a7_import_provenance` | **P (A7-1 spine)** | A8's migration serialized after | none (serialized, disjoint tables) |
| `deletedAt` read-path filters | `lib/investments/{reconstruction-runner,reconstruction-read,position-capture,brokerage-cash}.ts` | **P (A7-1, one-time filter edits, then frozen)** | A8 hooks `position-capture.ts` *after* A7-1 lands; A10 reads `reconstruction-read.ts` | **the wave's one ordering constraint — A7-1 lands before A8's capture hooks** |
| Investment import lib | `lib/imports/investments/**` (all new) | **A7** | A8/A9/A10: never | none |
| Import commit / opening / import resolver | `lib/investments/{investment-import-commit,opening-position,instrument-resolver-import}.ts` (+tests, new) | **A7** | A9 imports `computeAffectedWindow` post-merge (R) | none |
| Banking import framework | `lib/imports/{csv,excel,pipeline,suggest,authorize,provider-capabilities}.ts` | — | A7: **R only** (pipeline internals reused via export, not edit; if a needed export is missing, add the export in A7-1 on primary) | none |
| Investment import routes | `app/api/accounts/[id]/import/investments/**`, `app/api/investments/opening-position/route.ts` (new) | **A7** | nobody | none |
| Rollback route | `app/api/imports/[id]/rollback/route.ts` | **A7 (sole writer this wave)** | banking behavior byte-identical for `kind: TRANSACTIONS` | low (guard-tested) |
| Banking import routes | `app/api/accounts/[id]/import/{route,preview/route}.ts` | — | A7: R only | none |
| Instrument resolver (Plaid) | `lib/investments/instrument-resolver.ts` | — | A7: R (pure core imported by the sibling) | none |
| Ingest / capture hooks | `lib/investments/investment-event-ingest.ts` | — | **A8-owned** (price hooks); A7: R (template + repair-hook pattern) | none if A7 keeps out — enforced by forbidden-files lists |
| Reconstruction core | `lib/investments/reconstruction-core.ts` | **A7 (A7-7 only: checkpoint + merger/spin-off inversion)** | A8/A9/A10: R | low (A7-7 merges late; pure + fixture-gated) |
| Import UI | new wizard components, `InvestmentAccountsWidget.tsx` touchpoints, `SpaceDashboard.tsx` threading | **P (A7-6 phase)** | A10 UI serialized after on primary | (M) single-owner rule |
| Snapshots | `lib/snapshots/**` | — | A7: never; A9-owned | none |
| Prices | `lib/prices/**` (future) | — | A7: never; A8-owned | none |
| Scripts | `scripts/` (A7 adds none; reuses `run-reconstruction.ts`) | — | — | none |
| Tests/fixtures | `lib/imports/investments/fixtures/**`, per-module test files | **A7** | A8 fixtures live in `lib/prices/` — disjoint | none |

---

## 13. Validation strategy

- **Fixture strategy:** committed CSV fixtures in `lib/imports/investments/fixtures/` modeled on real export shapes — `schwab-transactions.csv` (buys/sells/dividends/reinvest/fees/transfer, a split, a merger), `fidelity-transactions.csv`, `generic.csv`, `positions-statement.csv`, `opening-with-lots.csv` (lot columns → `importedRaw` preservation asserted), `ambiguous.csv` (rows that must SKIP), `overlap-plaid.csv` (rows that must MATCH a seeded Plaid event set), `unknown-actions.csv` (mapper totality: every unmappable action → UNKNOWN with raws, never dropped). Fixtures are the shared truth for the normalizer, dedupe core, commit path, and UI preview tests — never forked per layer (the S2 fixture doctrine).
- **Real brokerage CSV testing:** post-merge on primary, an actual export from the connected brokerage (16 live positions): import → per-instrument residuals shrink; overlap with the Plaid 24-month window fully MATCHes (zero double-counting — the audit invariant: event count for the window unchanged); rows before the window CREATE; second import of the same file is a 100%-MATCH no-op.
- **Duplicate testing:** the dedupe matrix as unit tests over the pure core — every §5.3 row class × (exact / fingerprint-unique / fingerprint-ambiguous / none), null-amount wildcards, absolute-amount sign blindness, ordinal-suffixed identical tuples, re-import stability of the content hash, rolled-back rows excluded from candidacy.
- **Rollback testing:** the round-trip invariant, asserted end-to-end: snapshot `PositionReconstruction` summaries → import fixture → repair → assert residuals shrank → rollback → repair → assert summaries **byte-identical to the pre-import snapshot** (residuals re-widened, supersessions cleared, walks identical); re-import after rollback recreates rows (no silent no-op); banking-batch rollback byte-identical to today (guard test on `kind: TRANSACTIONS`); concurrent-rollback claim test inherited.
- **Repair testing:** commit-hook and rollback-hook both fire bounded repair for exactly the batch's (account, instruments) — no whole-account storms; repair failure is non-fatal + `recordSyncIssue` (fault-injection test); imported split ratio converts a FAILED walk to walk-through in fixtures; A7-7's checkpoint conflict fixture (statement anchor disagreeing with the walk ⇒ `conflicted: true`, never averaged).
- **Performance testing:** a 5,000-row fixture file through preview and commit with query counting — candidate fetching must be one windowed `findMany` per (account, table) resolved in memory (no per-row N+1; the banking loop's per-row pattern is explicitly not inherited), sequential writes bounded and timed; preview (zero writes) must stay interactive on the same file.
- **Kill-switch / byte-identity:** `INVESTMENT_IMPORTS_ENABLED` absent ⇒ routes 404/no-op, zero writes, full suite byte-identical; enabling it changes zero bytes of Cash Flow / Liquidity / Debt / Wealth results (non-contamination, re-run at every merge).

---

## 14. Recommended implementation slices

Each slice = one commit boundary, additive, kill-switched under `INVESTMENT_IMPORTS_ENABLED` (absent ⇒ byte-identical), full suite green.

| # | Slice | Content | Depends on | Stop condition |
|---|---|---|---|---|
| **A7-1** | **Provenance spine (primary — before A8's capture hooks)** | The one migration (`ImportBatch.kind` + `userDecisions`, `PositionObservation.importBatchId` + `deletedAt`, `InvestmentEvent.importedRaw`); the four `deletedAt: null` read-path filters; any missing exports from `lib/imports/pipeline.ts` internals | — | Migration additive+reversible; all reads filter-hardened; existing suites byte-identical |
| **A7-2** | Manual opening-position assertion | `opening-position.ts` writer (event + observation, atomic) + API route + repair hook + the "Explain this position…" form | A7-1 | Assertion shrinks a real residual; supersedable; rollback-free (assertions are user rows, deletable by their own affordance later) |
| **A7-3** | Investment CSV lib (pure) | `lib/imports/investments/{types,columns,profiles,normalize,row-identity,dedupe,pipeline}.ts` + fixtures; Schwab + generic profiles (Fidelity fast-follow) | A7-1 (parallel with A7-2) | Normalizer total; dedupe matrix green; zero DB, zero routes |
| **A7-4** | Preview + commit routes | The two investment routes; `investment-import-commit.ts` (batched candidates, sequential writes, supersession, counters, `userDecisions`, repair hook); `instrument-resolver-import.ts` | A7-2, A7-3 | Fixture import end-to-end: residuals shrink; re-import no-ops; overlap MATCHes; splits walk through |
| **A7-5** | Rollback extension | Route extension (events + observations soft-delete, un-supersede, audit counts) + post-claim repair hook + round-trip test | A7-4 | §13 round-trip byte-identity; banking rollback untouched |
| **A7-6** | Import UI (primary branch) | Wizard (upload/preview/mapping/warnings/duplicates/overrides/commit) + history + rollback + honesty previews | A7-5, S4 conventions | Browser pass on real CSV; overrides recorded; pixel rule holds |
| **A7-7** | Corporate-action & checkpoint depth | Merger/spin-off inversion with known terms (core, fixture-gated); IMPORTED-anchor checkpoint conflicts; symbol-change alias/merge tooling; decide the statement-value-as-valuation-anchor open question with A8's valuation contract in view | A7-4 (mergeable last; independent of A7-6) | Inversion fixtures green; conflicts surfaced never averaged; no regression on ratio-less stops |

---

## 15. Copy-paste Claude Code prompts

### 15.1 — A7-1 Provenance spine

```
Fourth Meridian — A7-1: Historical Investment Import provenance spine. Branch
feature/v2.5-spaces-completion, directly. ONE commit. This is A7's only migration and
must land BEFORE any A8 price-capture hook touches lib/investments/position-capture.ts.

Read first: FOURTH_MERIDIAN_A7_HISTORICAL_INVESTMENT_IMPORT_INVESTIGATION_2026-07-12.md
§4, §8.2, §12; prisma/schema.prisma (ImportBatch :1932, PositionObservation :1310,
InvestmentEvent :1385); app/api/imports/[id]/rollback/route.ts (do NOT edit yet).

Schema (one additive migration):
- enum ImportBatchKind { TRANSACTIONS, INVESTMENT_HISTORY }; ImportBatch.kind
  ImportBatchKind @default(TRANSACTIONS); ImportBatch.userDecisions Json?
- PositionObservation.importBatchId String? + ImportBatch relation (onDelete: SetNull)
  + @@index([importBatchId]); PositionObservation.deletedAt DateTime?
- InvestmentEvent.importedRaw Json?
All nullable/defaulted — zero backfill, MC1 doctrine (null = never provided).

Code: add deletedAt: null observation filters at EXACTLY four sites —
lib/investments/reconstruction-runner.ts (gatherReconstructionInputs),
lib/investments/reconstruction-read.ts (both row fetches),
lib/investments/position-capture.ts (computeDisappearedInstrumentIds's prior-observation
scan), lib/investments/brokerage-cash.ts (observation reads). Nothing else.

Forbidden: lib/imports/**, app/api/**, components/**, lib/prices/**, lib/snapshots/**,
reconstruction-core.ts, investment-event-ingest.ts, instrument-resolver.ts.

Stop: migration reversible; every existing test byte-identical; new guard tests assert
soft-deleted observations are invisible to all four read paths. No writer of the new
columns exists yet — that is A7-2/A7-4.
```

### 15.2 — A7-2 Manual opening-position assertion

```
Fourth Meridian — A7-2: manual opening-position assertion (the plan's C1). Branch/worktree
per the wave topology; prerequisite: A7-1 on primary.

Read first: the A7 investigation §6; lib/investments/reconstruction-core.ts (OPENING_BALANCE
routes as a signed quantity event — NO core changes); reconstruction-runner.ts
(repairReconstructionForAccount — your post-write hook); investment-event-ingest.ts (the
non-fatal hook posture to mirror, READ ONLY).

Owned (new): lib/investments/opening-position.ts (+test) — assertOpeningPosition({
financialAccountId, instrumentId | {symbol, name?}, date, quantity, costBasis?, userId }):
atomically writes InvestmentEvent { type: OPENING_BALANCE, quantity: +Q, source: "user",
createdByUserId } AND PositionObservation { origin: USER_ASSERTED, source: "user", costBasis }.
Re-assertion supersedes the prior assertion pair (supersededById), never edits in place.
Instrument by id from existing positions, or create-by-symbol via the decideResolution pure
core (new sibling binding — do NOT edit instrument-resolver.ts). Then bounded repair for
(account, [instrumentId]), non-fatal. app/api/investments/opening-position/route.ts:
requireFreshUser, ACTIVE SpaceAccountLink + FULL visibility, flag INVESTMENT_IMPORTS_ENABLED.
Minimal UI: "Explain this position…" on rows with unexplained residual (describeReconstruction
copy) → form → residual before/after readback.

Forbidden: lib/imports/**, reconstruction-core.ts, investment-event-ingest.ts,
position-capture.ts, the rollback route, lib/prices/**, lib/snapshots/**.

Stop: fixture test — walk with residual Q + assertion of Q at the boundary ⇒ COMPLETE,
residual 0; re-assertion supersedes; flag off ⇒ 404 + zero writes; full suite green.
```

### 15.3 — A7-3 Investment CSV lib (pure)

```
Fourth Meridian — A7-3: investment CSV parsing/normalization/dedupe lib — PURE, zero DB,
zero routes. Parallel with A7-2; prerequisite: A7-1.

Read first: the A7 investigation §3.3–§3.4, §5; lib/imports/csv.ts (resolveColumns/
HEADER_ALIASES/normalizeRow — the patterns to MIRROR in your own files, never edit);
lib/imports/pipeline.ts (format sniff — reuse via export); plaid-investment-events.ts
(the total-mapper precedent).

Owned (all new): lib/imports/investments/{types,columns,profiles,normalize,row-identity,
dedupe,pipeline}.ts + tests + fixtures/ (schwab-transactions.csv, generic.csv,
positions-statement.csv, opening-with-lots.csv, ambiguous.csv, overlap-plaid.csv,
unknown-actions.csv; fidelity fast-follow).

Rules: InvestmentCsvColumnMap per §3.3 (rowKind TRANSACTION|POSITION; lotData preserved
verbatim, never interpreted). Profiles are DATA (column aliases + action→InvestmentEventType
tables + sign conventions + profileVersion) — Schwab and generic in this slice. Normalizer
is TOTAL: unmappable action ⇒ type UNKNOWN with raws intact, never a dropped row; raw
action verbatim into providerType/description fields of the normalized row; full original
row into importedRaw. row-identity.ts: broker reference else
sha256(date,rawAction,symbol,quantity,grossAmount,price) + within-file ordinal for
identical tuples — filename/import-date NEVER hashed. dedupe.ts: pure
decideInvestmentRowOutcome(row, candidates) per §5.1 (exact [source,externalEventId] ⇒
MATCH; fingerprint per row class — security/cash/corporate-action/transfer — exactly one
candidate ⇒ MATCH, >1 ⇒ SKIP ambiguous, 0 ⇒ CREATE; |amount| compared absolute; null
amounts wildcard only against null).

Forbidden: everything outside lib/imports/investments/** (banking csv.ts/excel.ts/
pipeline.ts are READ ONLY — if pipeline.ts needs an export, report, don't patch here).

Stop: mapper totality test (every fixture action → canonical or UNKNOWN); dedupe matrix
green; hash stability test (same file twice ⇒ identical ids); zero imports of db.
```

### 15.4 — A7-4 Preview + commit routes

```
Fourth Meridian — A7-4: investment import preview + confirm routes and the commit path.
Prerequisites: A7-2, A7-3.

Read first: the A7 investigation §3.4, §5, §9; app/api/accounts/[id]/import/{route,
preview/route}.ts (the conventions to mirror: authorize.ts reuse, sequential writes,
importBatchId only on CREATE, counters, profile bump — READ ONLY);
lib/investments/investment-event-ingest.ts (dedupe/supersede/repair-hook template, READ ONLY).

Owned (new): lib/investments/investment-import-commit.ts (+test),
lib/investments/instrument-resolver-import.ts (+test),
app/api/accounts/[id]/import/investments/{preview/route.ts, route.ts}.

Rules: preview = pipeline + resolution + dedupe classification with ZERO writes, returning
per-row outcomes, warnings (unmapped actions, unresolved symbols, ratio-less splits, lot
data), and the per-instrument residual dry-run ("before → after"). Confirm: ImportBatch
{ kind: INVESTMENT_HISTORY, source, resolvedColumnMapping incl. {profileKey,
profileVersion}, userDecisions } → batched candidate fetch (ONE windowed findMany per
table per account — no per-row N+1) → sequential per-row writes in file order (CREATE
writes importBatchId + importedRaw + mapperVersion; MATCH never mutates and never claims;
SKIP/FAILED into errorSummary) → user overrides from the request applied and recorded in
userDecisions (force-create / exclude / type remap; remaps may save to an
ImportMappingProfile) → supersession pass (imported evidence explaining USER_ASSERTED
openings ⇒ supersededById) → counters/status finalize → bounded repair per (account,
distinct instrumentIds), non-fatal, recordSyncIssue on failure. Position rows (rowKind
POSITION) write PositionObservation { origin: IMPORTED, importBatchId } upserted on the
observation unique key. Flag INVESTMENT_IMPORTS_ENABLED gates both routes. Export
computeAffectedWindow(batch) for A9 (called by nobody yet).

Forbidden: the banking routes, the rollback route (A7-5), lib/imports/{csv,excel,
pipeline}.ts, reconstruction-core.ts, investment-event-ingest.ts, position-capture.ts,
components/**, lib/prices/**, lib/snapshots/**.

Stop: schwab fixture end-to-end — residuals shrink, split walks through, overlap-plaid
fixture fully MATCHes (event count unchanged), re-import 100% MATCH no-op, 5000-row
fixture within the query budget (§13); flag off ⇒ 404 + zero writes; full suite green.
```

### 15.5 — A7-5 Rollback extension

```
Fourth Meridian — A7-5: investment rollback — the promise the A3 schema comment made.
Prerequisite: A7-4.

Read first: the A7 investigation §8; app/api/imports/[id]/rollback/route.ts (your ONE
edited file — every existing behavior for kind TRANSACTIONS must stay byte-identical:
claim, authz, idempotency, audit, counters-untouched).

Tasks: inside the claimed transaction, for kind INVESTMENT_HISTORY batches additionally
(1) soft-delete InvestmentEvent { importBatchId, deletedAt: null }; (2) soft-delete
PositionObservation { importBatchId, deletedAt: null }; (3) clear supersededById on any
live row whose pointer targets a row in this batch (un-supersede — the outranked
assertion honestly returns); (4) per-table counts into the audit metadata. After commit:
bounded repair per (account, batch's distinct instrumentIds), non-fatal — residuals
re-widen through gatherReconstructionInputs' existing deletedAt/superseded filters with
zero core changes.

Forbidden: everything else. No snapshot regeneration (the route's documented invariant
holds — A9 subscribes later via computeAffectedWindow).

Stop: the round-trip test — snapshot PositionReconstruction summaries → import fixture →
repair → rollback → repair → summaries BYTE-IDENTICAL to the snapshot; re-import after
rollback recreates rows; banking rollback guard test byte-identical; concurrent-claim
test still green.
```

### 15.6 — A7-6 Import UI (primary branch)

```
Fourth Meridian — A7-6: the import UI — the product's first. PRIMARY branch (single-owner
rule for all components). Prerequisites: A7-5 merged; S4 shell conventions.

Read first: the A7 investigation §10; the S4 as-of control + CompletenessBadge conventions;
describeReconstruction/toPositionHonesty (reconstruction-read.ts) for honesty copy;
TransactionSliceDrawer for the drawer pattern.

Build: entry points ("Import history" on investment account surfaces; "Explain this
position…" → the A7-2 form). Wizard over the A7-4 routes: Upload (file + profile + kind +
sign convention) → Preview (mapping panel with suggestions + save-profile; row table with
CREATE/MATCH/SKIP/FAILED/UNKNOWN outcomes and per-row override controls — force-create,
exclude, remap type — plus a "your decisions" summary; warnings; per-instrument residual
before → after) → Commit (result: counters, actual residual deltas, superseded assertions,
batch link) → History (batch list per account with status + rollback behind a
consequence-stating confirm; rolled-back batches stay visible).

Rules: imported evidence always source-attributed ("from your Schwab import"), never
styled as provider-observed (pixel rule); user-facing completeness copy only; no new date
state (shell owns time); flag off ⇒ entry points absent, everything byte-identical.

Forbidden: lib/** except additive exports in lib/data/investment-accounts.ts;
reconstruction/import cores; prisma/**.

Stop: browser pass on a real brokerage CSV through the full wizard including an override,
a rollback, and a re-import; existing widgets byte-identical with the flag off.
```

### 15.7 — A7-7 Corporate-action & checkpoint depth

```
Fourth Meridian — A7-7: corporate-action inversion + statement checkpoints. Mergeable
last; prerequisite A7-4; independent of A7-6.

Read first: the A7 investigation §6.3, §7; lib/investments/reconstruction-core.ts (SPLIT
ratio inversion at :276, stopReasonFor at :171 — your ONLY core edit sites);
reconstruction-runner.ts (summary writes).

Tasks: (1) MERGER/SPIN_OFF inversion when terms are known — MERGER with ratio +
relatedInstrumentId: acquired walk ends at the action date, acquirer's walk reverses the
received quantity; cash MERGER (amount leg, no related instrument): position → 0, cash leg
already routes; SPIN_OFF with ratio + related: child gains its opening at the action;
terms missing ⇒ stop exactly as today (never guess). Pure, fixture-gated, deterministic.
(2) Checkpoints: after each walk, compare every live IMPORTED PositionObservation anchor
inside the window against the walk's quantity at that date; disagreement beyond
QUANTITY_EPSILON ⇒ conflicted: true + checkpoint ref in evidenceRefs — surfaced, never
averaged, never re-anchored. (3) SYMBOL_CHANGE tooling: alias addition + instrument merge
via supersededById only when strong identifiers agree or the user confirms;
strongIdsConflict refusal + recordSyncIssue otherwise. (4) Decide (with the A8 valuation
contract in view) whether an imported statement's stated market value may populate
observed-only valuation fields on IMPORTED rows — default NO per MC1; document the ruling.

Forbidden: routes, UI, lib/imports/** (fixtures excepted), lib/prices/**, snapshots.

Stop: inversion fixtures green (stock merger, cash merger, spin-off, terms-missing stops
unchanged); checkpoint conflict fixture green; ratio-less behavior byte-identical; full
suite green.
```

---

*End of investigation. No code was written, no files modified besides this report, no migrations created, nothing committed.*
