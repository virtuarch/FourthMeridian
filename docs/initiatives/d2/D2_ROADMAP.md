# D2 Roadmap — Provider & Connection Architecture

> **FROZEN — historical record.** This roadmap is no longer maintained. Residual D2 scope (Step 4D remainder, Step 5 full scope, Step 6 sync-provider selection, Step 7 Stabilization) is tracked in `STATUS.md` §3 (D2 row) at the repository root, the project's sole source of truth for current status.

**Status: frozen implementation record. No code, schema, or migration changes were made to produce this document.**

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
| WALLET dual-write | `dualWriteProviderAccountIdentity(id, ProviderType.WALLET, walletAddress)` wired into `app/api/accounts/wallet/route.ts`'s active-match, archived-match, and fresh-create branches. | ✅ |

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
| WALLET read cutover | Permanently excluded from read cutover by design (D2 Step 1D §5) — not a pending decision. | ⛔ |

**Fallback removal (legacy-field fallback in 3C–3F) is deferred to Step 7 (Stabilization), not tracked as active Step 3 work.** It is not a numbered Step 3 sub-step — see Step 7 below. (An earlier audit report informally referred to this future decision as "Step 3G" before a separate audit task also claimed that label for itself; this roadmap resolves the collision by dropping the "3G" designation entirely and placing the fallback-removal decision under Step 7 instead.)

## Step 4 — Import & History Foundation

🔶 **In progress — 4A investigation complete, 4B schema implemented and migrated, 4C shared fingerprint helper extracted, 4D-1 CSV import MVP implemented. Rest of 4D (Excel, QuickBooks, rollback, optional account-creation) not started, not approved.**

| Sub-step | What | Status |
|---|---|---|
| **4A** | Investigation (read-only) — current-state inventory of `Transaction`/`FinancialAccount`/`Holding` schema, the Plaid transaction sync path, and existing account/transaction fingerprint logic; proposed `ImportBatch` design, transaction provenance design, matching/dedupe strategy, smallest safe implementation slice, and risks/rollback plan. See `docs/initiatives/d2/D2_STEP4A_IMPORT_HISTORY_FOUNDATION_INVESTIGATION.md`. | ✅ |
| **4B** | **ImportBatch Foundation — schema only.** `ImportBatch` model (`financialAccountId` required FK, `createdByUserId` **nullable** — corrected from 4A's draft, mirrors `FinancialAccount.createdByUserId`'s D11 precedent so `onDelete: SetNull` is valid — nullable `connectionId` seam mirroring `AccountConnection`'s pattern, source/status enums, `rowCount`/`importedCount`/`skippedCount`/`errorSummary`). `Transaction.importBatchId` (nullable FK) **plus `@@index([importBatchId])`**. `Transaction.externalTransactionId` (nullable — no unique constraint yet). `Transaction.deletedAt` (nullable — net-new column). No reads, no writes, nothing wired up. Schema additions are in `prisma/schema.prisma`; `npx tsc --noEmit` and `npm run lint` both clean. `npx prisma generate`/`migrate dev` could not run in this sandbox (network-restricted, no `linux-arm64` engine) and were run locally afterward — **migration `20260624110946_d2_4b_importbatch_foundation` is applied.** See `docs/initiatives/d2/D2_STEP4B_IMPORTBATCH_FOUNDATION_INVESTIGATION.md` and `docs/initiatives/d2/D2_STEP4B_IMPLEMENTATION_VALIDATION.md`. | ✅ Schema implemented and migrated. |
| **4C** | **Shared Fingerprint Engine.** Investigated the two existing, independently-implemented fingerprint matchers (`lib/accounts/reconcile.ts`, account-level; `lib/plaid/syncTransactions.ts`, transaction-level via `findByFingerprint`/`normalizeMerchantKey`) — see `docs/initiatives/d2/D2_STEP4C_TRANSACTION_FINGERPRINTING_INVESTIGATION.md`. Implemented the helper-extraction half of that report's recommendation: `findByFingerprint`/`normalizeMerchantKey` moved unchanged into a new shared module, `lib/transactions/fingerprint.ts`; `syncTransactions.ts` re-pointed onto it — behavior-preserving, no new CSV behavior, no schema change. `reconcile.ts`'s account-level fingerprint was left untouched (re-pointing it was explicitly optional and flagged as a smaller win than it sounds, since the two matchers key on disjoint field sets). A persisted `fingerprintHash` column was explicitly recommended against being bundled into this step and was not added. `npx tsc --noEmit` and `npm run lint` both clean. See `docs/initiatives/d2/D2_STEP4C_IMPLEMENTATION_VALIDATION.md`. | ✅ Helper extracted. |
| **4D-1** | **CSV Import MVP.** `POST /api/accounts/[id]/import` — multipart CSV upload, in-memory parse (`papaparse`), header-alias column detection (date / merchant-or-description / amount-or-debit+credit / category / reference), per-row classification into CREATED / MATCHED / SKIPPED / FAILED. MATCH path calls `findByFingerprint`/`normalizeMerchantKey` from the 4C shared helper **unmodified**; an additive CSV-only refinement (`resolveFingerprintOutcome` in new `lib/imports/csv.ts`) re-queries the same candidate shape to detect an ambiguous (>1 candidate) match and downgrades it to SKIPPED rather than silently picking the first one. New `ImportBatch.matchedCount`/`failedCount` counters (additive). No Excel, no QuickBooks, no rollback, no UI, no background jobs, no Step 5 provider-adapter abstraction — see `docs/initiatives/d2/D2_STEP4D1_CSV_IMPORT_MVP_INVESTIGATION.md`. `npx tsc --noEmit` clean except the 3 expected `matchedCount`/`failedCount` errors from the sandbox's stale (pre-this-change) generated Prisma client — same `prisma generate` sandbox gap as 4B, resolved by running it locally. `npm run lint` clean. Pure parsing/classification helpers unit-traced via `tsx` (date/amount/category parsing, column detection, malformed rows, header-only file); the DB-dependent fingerprint-classification path was verified by code trace, not execution — DB and Prisma engine binary are both unreachable in this sandbox. See `docs/initiatives/d2/D2_STEP4D1_IMPLEMENTATION_VALIDATION.md`. | ✅ Implemented. |
| **4D (remainder)** | Excel / QuickBooks-export upload and parsing. Rollback via `ImportBatch.status = ROLLED_BACK` + `Transaction.deletedAt` soft-delete — preceded by a read-path audit (which existing `Transaction` queries need a `deletedAt: null` filter) as its own checklist item before rollback ships, the same investigation-before-cutover pattern Step 3A used for `ProviderAccountIdentity`. Optional create-new-account-from-import flow (explicitly optional/later, not Day-1). Historical backfill beyond Plaid's API retention window. AuditLog entry for CSV imports (deliberately not added in 4D-1 — wasn't part of that slice's approved scope). | ⛔ Deferred (beyond v2.4). |

**4B and 4C are independent of each other — either order, or in parallel — but both must be complete before 4D starts. 4D-1 is complete; the remaining 4D sub-steps are separate, separately-approved slices.**

This formalizes and supersedes the informal "§8 CSV imports — design" sketch in `docs/architecture/D2_PROVIDER_CONNECTION_ARCHITECTURE.md` as an explicit, numbered roadmap step, further refined by `docs/initiatives/d2/D2_STEP4A_IMPORT_HISTORY_FOUNDATION_INVESTIGATION.md` and `docs/initiatives/d2/D2_STEP4_ROADMAP_REFINEMENT.md`. See the note below — **CSV/import history is now explicitly D2 Step 4**, not a loosely-scheduled "later," and is itself now sub-split (4A–4D) for the same reason Steps 1 and 3 are sub-split: each piece has a different risk profile and needs its own approval, per the standing "do not implement all decisions in one branch or one commit" rule.

## Step 5 — Adapter Interface

🔶 **In progress — slice #1 shipped; sync/wallet adapter generalization not started.**

- **Import provider capabilities (slice #1)** — `lib/imports/provider-capabilities.ts` (commit `18f0922`) shipped and in live use (`app/api/accounts/[id]/import/route.ts` and its preview counterpart); validated by Step 6's CSV Import candidate. Its own header is explicit that this is a capability-lookup helper, **not** a sync adapter or wallet adapter — it does not satisfy the bullets below. | ✅
- Sync provider adapter (interface every "pull balances/transactions on a schedule" provider implements — mirrors what `lib/plaid/refresh.ts`/`syncTransactions.ts` do today for Plaid specifically, generalized). | ⛔ Deferred (beyond v2.4).
- Import provider adapter (interface for batch/file-based providers — CSV today, potentially Excel/QuickBooks exports), beyond the capability-lookup slice above. | ⛔ Deferred (beyond v2.4).
- Wallet adapter abstraction (covers both today's single-address tracking and the later xpub/watch-only model from §7 of the architecture doc). | ⛔ Deferred (beyond v2.4).
- Shared normalized transaction format that every adapter maps into, so `Transaction` creation/dedupe logic is written once and reused regardless of provider. | ⛔ Deferred (beyond v2.4).

## Step 6 — First real new provider

🔶 **Two candidates closed; sync-side provider selection deferred beyond v2.4.**

Closed:
- Wallet watch-only single-address provider — ✅ already shipped (`app/api/accounts/wallet/route.ts`; dual-write wired since Step 2). See `docs/initiatives/d2/D2_STEP6_FIRST_PROVIDER_INVESTIGATION.md`.
- CSV Import — ✅ already validated by D2-5 (`lib/imports/provider-capabilities.ts`, commit `18f0922`). See `docs/initiatives/d2/D2_STEP6_FIRST_PROVIDER_INVESTIGATION.md` §3.

Open candidates, not yet selected:
- Wallet xpub / multi-address / signed-message verification (extends the existing single-address BTC tracking into real credential-backed multi-address support — §7 of the architecture doc) — ⏸ Deferred (v2.7).
- Coinbase (would validate the sync adapter shape against a real exchange). — ⛔ Deferred (beyond v2.4).
- Schwab (would validate the sync adapter shape against a real brokerage). — ⛔ Deferred (beyond v2.4).

Selecting the first real **sync**-side provider (Coinbase, Schwab, or wallet xpub) is deferred beyond v2.4 — mirrors Open Decision 2 in the architecture doc, which has carried unresolved since the original investigation; deferred until Steps 4/5 generalization is approved and scoped.

## Step 7 — Stabilization

🔶 **Two distinct initiatives share the "Step 7" label. See the split below — this is the same kind of collision the roadmap already resolved once for "Step 3G" (Step 3's note above); recorded here explicitly rather than silently re-numbered.**

**Step 7A–7G — Production Hardening.** ✅ **Complete.** A separately-scoped initiative (connection health classification, manual refresh cooldown, scheduler/cron wiring, retry/backoff, reconnect flow, provider diagnostics) that also claimed the "Step 7" label, distinct from the original Stabilization bullets below. Shipped across 6 commits (`19456ff`, `1879dab`, `444cb6c`, `ad4415d`, `8e67be2`, `6c28d32`); `npx tsc --noEmit` and `npm run lint` both clean; working tree clean at close. See `docs/initiatives/d2/D2_STEP7A_*` through `D2_STEP7F_*` checklists for implementation detail and `docs/initiatives/d2/D2_STEP7G_PRODUCTION_HARDENING_CLOSEOUT_AUDIT.md` for the closeout verification (code-vs-checklist audit, two minor file-relocation deviations noted, no blockers).

**Step 7 — Stabilization (original scope).** ⛔ **Deferred (beyond v2.4).** None of the bullets below were touched by the Production Hardening initiative above.

- **PLAID fallback removal** — remove the legacy-field fallback added in 3C–3F, once proven stable over a production observation period (zero `[plaid][D2-3C/3D/3E/3F]` fallback-hit warnings). **Does not** remove the `FinancialAccount.plaidAccountId` column itself — legacy columns/tables are never dropped prematurely, per standing project rule. This is the activity formerly referred to informally as "Step 3G"; it is tracked here, not as a Step 3 sub-step (see Step 3's note above).
- Verification scripts (generalizing the pattern established by `scripts/verify-provider-account-identity-backfill.ts` to whatever Steps 4–6 add).
- Provider consistency checks across all live providers by that point, not just PLAID.
- Data integrity audits.
- Documentation/runbooks.
- Read-path audit — a second pass, after Steps 4–6 land, analogous to the 3A investigation but covering every provider then live, not just PLAID.
- Legacy cleanup planning — *planning* only. Still subject to the standing rule that legacy tables/columns (`PlaidItem`, `FinancialAccount.plaidAccountId`, `WorkspaceAccountShare`, etc.) are never removed prematurely; this step plans the eventual cleanup, it does not execute it.

---

## Required notes (canon)

**WALLET identity backfill (1C-C) and read cutover (Step 3) are permanently excluded by design — not pending decisions.** Dual-write (Step 2) is wired: `ProviderAccountIdentity` rows are written for WALLET via `dualWriteProviderAccountIdentity` in `app/api/accounts/wallet/route.ts`. Backfill and read cutover are different — the 1C-C investigation found that `FinancialAccount.walletAddress` does not map onto provider identity the same clean way `plaidAccountId` does once ownership/watch-only/claim semantics are considered (e.g. who "owns" a watched address that isn't the connecting user's own wallet). Per D2 Step 1D §5, WALLET reads stay direct/owner-scoped permanently — a public address can't resolve through a globally-unique identity table without leaking cross-owner existence. This is a resolved architectural exclusion, not an open decision awaiting resolution.

**CSV/import history is now explicitly D2 Step 4, formally split into 4A–4D.** The architecture doc's §8 "CSV imports — design" sketch is real design rationale and is retained as-is, but it was never sequenced as a numbered step until the original roadmap update, and was further refined into 4A (investigation, complete) / 4B (`ImportBatch` + `Transaction` provenance columns, schema only) / 4C (shared fingerprint helper, extracted from `reconcile.ts` and `syncTransactions.ts`) / 4D (the actual import pipeline) after the 4A investigation surfaced enough detail to warrant the split — see `docs/initiatives/d2/D2_STEP4_ROADMAP_REFINEMENT.md` for the rationale. No 4B/4C/4D implementation work starts until each is individually and explicitly approved on its own implementation checklist, per the standing "produce a checklist, wait for approval, then implement only that decision" working style — 4A's completion does not pre-approve 4B, 4C, or 4D.

**Provider Catalog polished UI remains a later v2.7 Provider Ecosystem concern, not D2 foundation.** D6 (`ProviderCatalog` field set reconciliation) and D7 (`ProviderCatalog` ownership + admin UI) are tracked separately in `docs/architecture/PHASE_2_DECISION_MATRIX.md` and `docs/architecture/PHASE_2_ARCHITECTURE_FREEZE.md` §9.2/§14, and the architecture doc already recommends deferring a queryable `ProviderCatalog` table in favor of a code-level `ProviderType` enum + small static registry for D2 itself (§1 of that doc: "Defer to D6/D7"). This roadmap update reaffirms that boundary explicitly: D2 Steps 1–7 build the data model and adapter mechanics; a polished, searchable provider catalog/picker UI is later v2.7 Provider Ecosystem scope, not a D2 deliverable.

---

## What this document does not do

It does not implement, design in detail, or approve any of Steps 4–7 — each still needs its own short implementation checklist, submitted for approval, before any code, schema, or migration work begins, exactly as Steps 1–3 were each individually approved. It does not delete or invalidate the architecture doc's design rationale (§§1–9, §11, §A–§C, §E–§F) — only its phase-sequencing sections (§10, §D) are now superseded for sequencing purposes, with a pointer added there back to this document.
