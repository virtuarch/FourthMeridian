# D2 Roadmap — Provider & Connection Architecture

**Status: documentation canon. This is the live, single source of truth for D2 step sequencing. No code, schema, or migration changes were made to produce this document.**

Branch: `feature/phase-2-architecture`. Baseline: `v2.3.0`.

This document supersedes the step/phase **sequencing** in `docs/architecture/D2_PROVIDER_CONNECTION_ARCHITECTURE.md` §10 ("Migration strategy — five phases") and §D ("Proposed migration phases"). Those sections' design rationale — why each piece exists, the schema sketches, the risk assessment — remains accurate reference material and is not repeated or deleted here; this document tracks **what step we're on and what's next**, not **why**. See that document for design rationale on any step below.

Each step's own investigation/implementation report under `docs/initiatives/d2/` remains the detailed record for that step. This roadmap is the index and the forward plan.

---

## Status legend

✅ complete · 🔶 in progress / partial · ⏳ planned, not started · ⛔ deferred (blocked on an explicit decision)

---

## Step 1 — Foundation (schema, additive only)

✅ **Complete.**

| Sub-step | What | Status |
|---|---|---|
| **1A** | `Connection` model added (provider-agnostic credential: provider, status, cursor). Additive only — nothing reads/writes it yet beyond what later steps wire up. | ✅ |
| **1B** | `ProviderAccountIdentity` model added (`@@unique([provider, externalAccountId])`, FK to `FinancialAccount`, optional FK to `Connection`). Additive only. | ✅ |
| **1C-A** | PLAID backfill script (`scripts/backfill-provider-account-identity.ts`) — populates `ProviderAccountIdentity` from existing `FinancialAccount.plaidAccountId`. Ran live. | ✅ |
| **1C-B** | PLAID verification script (`scripts/verify-provider-account-identity-backfill.ts`) — confirms no missing/duplicate/mismatched identities. Passed. | ✅ |
| **1C-C** | WALLET identity collision investigation (read-only). Found WALLET backfill is **not** a simple copy of `walletAddress` — see "Deferred items" below. WALLET backfill **deferred**, not run. | ✅ (investigation) / ⛔ (WALLET backfill itself) |

## Step 2 — Dual-write

🔶 **In progress — PLAID only.**

| Sub-step | What | Status |
|---|---|---|
| **2A** | PLAID dual-write helper (`lib/accounts/provider-identity.ts`) wired into `app/api/plaid/exchange-token/route.ts`'s create / fingerprint-repoint / exact-match branches. Best-effort, non-fatal. `connectionId` left `null` (Step 1A's `Connection` rows are not yet populated for PLAID — that's an Open Decision, not yet made). | ✅ |
| WALLET dual-write | Not started — blocked on the same WALLET identity semantics question as 1C-C. | ⛔ |

## Step 3 — Read cutover

🔶 **In progress — PLAID exact/identity reads done; fallback not yet removed.**

All read sites identified by the 3A investigation now resolve via `ProviderAccountIdentity` first, falling back to the legacy `FinancialAccount.plaidAccountId` lookup with a warning log on fallback-hit (fallback-first, not a hard replacement — by design, to surface coverage gaps before removing the safety net).

| Sub-step | What | Status |
|---|---|---|
| **3A** | Read-cutover investigation — inventoried every PLAID `plaidAccountId` read site, classified each, proposed cutover order 3B→3G. | ✅ |
| **3B** | Verification gate — re-ran the 1C-B verify script immediately before any read cutover. Passed locally (0 missing, 0 duplicates, 0 mismatches). | ✅ |
| **3C** | `exchange-token/route.ts` exact-match lookup cut over. | ✅ |
| **3D** | `lib/accounts/reconcile.ts`'s `findActiveAccountByIdentity` (PLAID branch) cut over — propagates automatically to both restore routes that call it. | ✅ |
| **3E** | `lib/plaid/refresh.ts` — balance lookup and holdings cross-reference, both cut over together. | ✅ |
| **3F** | `lib/plaid/syncTransactions.ts`'s `resolveFinancialAccountId()` and `exchange-token/route.ts`'s holdings cross-reference, both cut over together. | ✅ |
| WALLET read cutover | Not started — blocked on the same WALLET identity semantics question as 1C-C/Step 2. | ⛔ |

**Fallback removal (legacy-field fallback in 3C–3F) is deferred to Step 7 (Stabilization), not tracked as active Step 3 work.** It is not a numbered Step 3 sub-step — see Step 7 below. (An earlier audit report informally referred to this future decision as "Step 3G" before a separate audit task also claimed that label for itself; this roadmap resolves the collision by dropping the "3G" designation entirely and placing the fallback-removal decision under Step 7 instead.)

## Step 4 — Import & History Foundation

🔶 **In progress — 4A investigation complete, 4B schema implemented and migrated, 4C shared fingerprint helper extracted. 4D not started, not approved.**

| Sub-step | What | Status |
|---|---|---|
| **4A** | Investigation (read-only) — current-state inventory of `Transaction`/`FinancialAccount`/`Holding` schema, the Plaid transaction sync path, and existing account/transaction fingerprint logic; proposed `ImportBatch` design, transaction provenance design, matching/dedupe strategy, smallest safe implementation slice, and risks/rollback plan. See `docs/initiatives/d2/D2_STEP4A_IMPORT_HISTORY_FOUNDATION_INVESTIGATION.md`. | ✅ |
| **4B** | **ImportBatch Foundation — schema only.** `ImportBatch` model (`financialAccountId` required FK, `createdByUserId` **nullable** — corrected from 4A's draft, mirrors `FinancialAccount.createdByUserId`'s D11 precedent so `onDelete: SetNull` is valid — nullable `connectionId` seam mirroring `AccountConnection`'s pattern, source/status enums, `rowCount`/`importedCount`/`skippedCount`/`errorSummary`). `Transaction.importBatchId` (nullable FK) **plus `@@index([importBatchId])`**. `Transaction.externalTransactionId` (nullable — no unique constraint yet). `Transaction.deletedAt` (nullable — net-new column). No reads, no writes, nothing wired up. Schema additions are in `prisma/schema.prisma`; `npx tsc --noEmit` and `npm run lint` both clean. `npx prisma generate`/`migrate dev` could not run in this sandbox (network-restricted, no `linux-arm64` engine) and were run locally afterward — **migration `20260624110946_d2_4b_importbatch_foundation` is applied.** See `docs/initiatives/d2/D2_STEP4B_IMPORTBATCH_FOUNDATION_INVESTIGATION.md` and `docs/initiatives/d2/D2_STEP4B_IMPLEMENTATION_VALIDATION.md`. | ✅ Schema implemented and migrated. |
| **4C** | **Shared Fingerprint Engine.** Investigated the two existing, independently-implemented fingerprint matchers (`lib/accounts/reconcile.ts`, account-level; `lib/plaid/syncTransactions.ts`, transaction-level via `findByFingerprint`/`normalizeMerchantKey`) — see `docs/initiatives/d2/D2_STEP4C_TRANSACTION_FINGERPRINTING_INVESTIGATION.md`. Implemented the helper-extraction half of that report's recommendation: `findByFingerprint`/`normalizeMerchantKey` moved unchanged into a new shared module, `lib/transactions/fingerprint.ts`; `syncTransactions.ts` re-pointed onto it — behavior-preserving, no new CSV behavior, no schema change. `reconcile.ts`'s account-level fingerprint was left untouched (re-pointing it was explicitly optional and flagged as a smaller win than it sounds, since the two matchers key on disjoint field sets). A persisted `fingerprintHash` column was explicitly recommended against being bundled into this step and was not added. `npx tsc --noEmit` and `npm run lint` both clean. See `docs/initiatives/d2/D2_STEP4C_IMPLEMENTATION_VALIDATION.md`. | ✅ Helper extracted. |
| **4D** | **Import Pipeline.** CSV / Excel / QuickBooks-export upload and parsing. User selects an existing `FinancialAccount` before import — no fingerprint-based auto-account-creation from file contents (CSV lacks Plaid's structured `institution_id`/`mask`/`official_name`). Imported-row dedupe via the Step 4C shared helper (`externalTransactionId` exact match first, fingerprint fallback second), filtering `deletedAt: null` once rollback exists. Rollback via `ImportBatch.status = ROLLED_BACK` + `Transaction.deletedAt` soft-delete — preceded by a read-path audit (which existing `Transaction` queries need a `deletedAt: null` filter) as its own checklist item before rollback ships, the same investigation-before-cutover pattern Step 3A used for `ProviderAccountIdentity`. Optional create-new-account-from-import flow (explicitly optional/later, not Day-1). Historical backfill beyond Plaid's API retention window. Will likely need its own sub-lettering once its implementation checklist is requested — the largest, most decision-laden piece of Step 4. | ⏳ Not started. |

**4B and 4C are independent of each other — either order, or in parallel — but both must be complete before 4D starts.**

This formalizes and supersedes the informal "§8 CSV imports — design" sketch in `docs/architecture/D2_PROVIDER_CONNECTION_ARCHITECTURE.md` as an explicit, numbered roadmap step, further refined by `docs/initiatives/d2/D2_STEP4A_IMPORT_HISTORY_FOUNDATION_INVESTIGATION.md` and `docs/initiatives/d2/D2_STEP4_ROADMAP_REFINEMENT.md`. See the note below — **CSV/import history is now explicitly D2 Step 4**, not a loosely-scheduled "later," and is itself now sub-split (4A–4D) for the same reason Steps 1 and 3 are sub-split: each piece has a different risk profile and needs its own approval, per the standing "do not implement all decisions in one branch or one commit" rule.

## Step 5 — Adapter Interface

⏳ **Planned. Not started.**

- Sync provider adapter (interface every "pull balances/transactions on a schedule" provider implements — mirrors what `lib/plaid/refresh.ts`/`syncTransactions.ts` do today for Plaid specifically, generalized).
- Import provider adapter (interface for batch/file-based providers — CSV today, potentially Excel/QuickBooks exports).
- Wallet adapter abstraction (covers both today's single-address tracking and the later xpub/watch-only model from §7 of the architecture doc).
- Shared normalized transaction format that every adapter maps into, so `Transaction` creation/dedupe logic is written once and reused regardless of provider.

## Step 6 — First real new provider

⏳ **Planned. Not started. Candidate, not yet selected:**

- Wallet/xpub (extends the existing single-address BTC tracking into real credential-backed multi-address support — §7 of the architecture doc).
- CSV Import (would validate the Step 4/5 import adapter shape against a real file-based provider).
- Coinbase (would validate the sync adapter shape against a real exchange).
- Schwab (would validate the sync adapter shape against a real brokerage).

Selecting one is itself a decision to be made when Steps 4/5 are far enough along to need a real adapter to validate against — not assumed or pre-selected here (mirrors Open Decision 2 in the architecture doc, which has carried unresolved since the original investigation).

## Step 7 — Stabilization

⏳ **Planned. Not started.**

- **PLAID fallback removal** — remove the legacy-field fallback added in 3C–3F, once proven stable over a production observation period (zero `[plaid][D2-3C/3D/3E/3F]` fallback-hit warnings). **Does not** remove the `FinancialAccount.plaidAccountId` column itself — legacy columns/tables are never dropped prematurely, per standing project rule. This is the activity formerly referred to informally as "Step 3G"; it is tracked here, not as a Step 3 sub-step (see Step 3's note above).
- Verification scripts (generalizing the pattern established by `scripts/verify-provider-account-identity-backfill.ts` to whatever Steps 4–6 add).
- Provider consistency checks across all live providers by that point, not just PLAID.
- Data integrity audits.
- Documentation/runbooks.
- Read-path audit — a second pass, after Steps 4–6 land, analogous to the 3A investigation but covering every provider then live, not just PLAID.
- Legacy cleanup planning — *planning* only. Still subject to the standing rule that legacy tables/columns (`PlaidItem`, `FinancialAccount.plaidAccountId`, `WorkspaceAccountShare`, etc.) are never removed prematurely; this step plans the eventual cleanup, it does not execute it.

---

## Required notes (canon)

**WALLET identities are deferred.** `ProviderAccountIdentity` rows are not backfilled or dual-written for WALLET, and no WALLET read path has been cut over. This is deliberate, not an oversight — the 1C-C investigation found that `FinancialAccount.walletAddress` does not map onto provider identity the same clean way `plaidAccountId` does once ownership/watch-only/claim semantics are considered (e.g. who "owns" a watched address that isn't the connecting user's own wallet). WALLET work across Steps 1C, 2, and 3 stays blocked until those semantics are explicitly resolved as their own decision — not bundled into any PLAID-scoped step, and not assumed resolved by this roadmap update.

**CSV/import history is now explicitly D2 Step 4, formally split into 4A–4D.** The architecture doc's §8 "CSV imports — design" sketch is real design rationale and is retained as-is, but it was never sequenced as a numbered step until the original roadmap update, and was further refined into 4A (investigation, complete) / 4B (`ImportBatch` + `Transaction` provenance columns, schema only) / 4C (shared fingerprint helper, extracted from `reconcile.ts` and `syncTransactions.ts`) / 4D (the actual import pipeline) after the 4A investigation surfaced enough detail to warrant the split — see `docs/initiatives/d2/D2_STEP4_ROADMAP_REFINEMENT.md` for the rationale. No 4B/4C/4D implementation work starts until each is individually and explicitly approved on its own implementation checklist, per the standing "produce a checklist, wait for approval, then implement only that decision" working style — 4A's completion does not pre-approve 4B, 4C, or 4D.

**Provider Catalog polished UI remains a later v2.7 Provider Ecosystem concern, not D2 foundation.** D6 (`ProviderCatalog` field set reconciliation) and D7 (`ProviderCatalog` ownership + admin UI) are tracked separately in `docs/architecture/PHASE_2_DECISION_MATRIX.md` and `docs/architecture/PHASE_2_ARCHITECTURE_FREEZE.md` §9.2/§14, and the architecture doc already recommends deferring a queryable `ProviderCatalog` table in favor of a code-level `ProviderType` enum + small static registry for D2 itself (§1 of that doc: "Defer to D6/D7"). This roadmap update reaffirms that boundary explicitly: D2 Steps 1–7 build the data model and adapter mechanics; a polished, searchable provider catalog/picker UI is later v2.7 Provider Ecosystem scope, not a D2 deliverable.

---

## What this document does not do

It does not implement, design in detail, or approve any of Steps 4–7 — each still needs its own short implementation checklist, submitted for approval, before any code, schema, or migration work begins, exactly as Steps 1–3 were each individually approved. It does not delete or invalidate the architecture doc's design rationale (§§1–9, §11, §A–§C, §E–§F) — only its phase-sequencing sections (§10, §D) are now superseded for sequencing purposes, with a pointer added there back to this document.
