# Fourth Meridian — Transactions Tab Redesign Phase 1: Completion Summary

**Date:** 2026-07-12
**Branch:** `feature/v2.5-spaces-completion`
**Plan of record:** `FOURTH_MERIDIAN_TRANSACTIONS_TAB_REDESIGN_IMPLEMENTATION_PLAN_2026-07-12.md`
**Investigation:** `FOURTH_MERIDIAN_TRANSACTIONS_TAB_REDESIGN_INVESTIGATION_2026-07-12.md`

Phase 1 shipped exactly as scoped — pivot the existing ledger over data
`getTransactions()` already computes for every row, plus one cheap pure `source`
derivation and rendering an already-computed drawer signal. **No schema
migration, no new query, no batched-query design.** Delivered as six small,
independently revertible commits (S1–S6).

---

## What shipped, per slice

- **S1 — Flow Type filter + `FLOW_TYPE_LABEL`** (`b27c418`)
  - `lib/transactions/flow-predicates.ts`: added `FLOW_TYPE_LABEL` — a humanized
    label per `FlowType` enum value (additive; no predicate/set touched, module's
    ZERO-IMPORTS contract preserved).
  - `SpaceTransactionsPanel.tsx`: Flow Type filter control (direct equality over
    the `flowType` already on every row) + active chip + clear-all wiring.
  - `flow-predicates.test.ts`: source-scan test pinning `FLOW_TYPE_LABEL` to the
    `@prisma/client` `FlowType` enum (one non-empty label per value, no extras).

- **S2 — Needs-review filter + transfer-disposition filter/badge** (`20281b6`)
  - UI-only (both fields already on every list row, CF-1 / TE-2B).
  - "Needs review" toggle reuses the existing `needsClassification` boolean as-is
    — no confidence tiers, no new copy.
  - "Movement" filter over the canonical `TransferDisposition` + a small per-row
    disposition badge (renders only on TRANSFER rows). Labels are humanized
    presentations of the existing canonical concept — no new terminology.

- **S3 — Source derivation + Source filter** (`e30a554`) — the one real data change.
  - `lib/data/transactions.ts`: extracted a single shared `deriveSource()`
    (import batch → Plaid → manual) reused by **both** `getTransactions()` (new
    list-level `source` field) and `getTransactionDetail()`'s provenance building,
    so list and drawer cannot diverge on what "source" means. Pure — reads flat
    columns already selected; no new query, no new column.
  - `types/index.ts`: added optional `source` to the base `Transaction` type
    (additive; omitting reads leave it undefined).
  - `SpaceTransactionsPanel.tsx`: Source filter (All / Plaid / Import / Manual).

- **S4 — Merchant filter + Group By pivot** (`ba70dd6`)
  - Merchant filter over distinct resolved-merchant names present in the fetched
    list (client-side; no new query).
  - Single **Group By** control (No grouping / Flow type / Merchant / Account /
    Category) — a pure client-side reduce over the already-filtered list. **Group
    By subsumes the vision's "Perspective toggle"**: "No grouping" is the flat
    List perspective, so no second redundant control ships.

- **S5 — Render `transferCandidate` in the drawer** (`f9f6f04`)
  - `lib/transactions/detail-sections.ts`: `relationshipIntelligence()` now
    renders a hedged, account-name-free note ("Appears to match a transfer
    between your own accounts.") when TI4 Slice 1's deterministic owned-account
    match resolves (KD-15-gated upstream). Fixed the stale header comment that
    claimed both `transferCandidate` and `refundCandidate` were reserved-null —
    only `refundCandidate` still is.
  - `detail-sections.test.ts`: transferCandidate renders hedged + id/name-free;
    refundCandidate stays reserved-null even when transferCandidate resolves.

- **S6 — Validation gate + this summary.**

---

## Validation gate (plan §8)

| Gate | Result |
|---|---|
| `npx tsc --noEmit` | **Clean** (0 errors). |
| `npx eslint` (`npm run lint`) | **0 errors.** 7 pre-existing warnings, all in files not touched here (`AccountModal`, `SpaceDashboard`, `TotpSection`, `CoinIcon`, `time-range.test`). None introduced by this work. |
| `npm test` | **192/192 passed** — including `flow-predicates`, `transaction-context` (transferDisposition/needsClassification derivation), `serialize.golden` (list-DTO byte-identity), and `detail-sections` (transferCandidate rendering, refundCandidate-still-null). |
| `git diff --name-only` (this work: `b27c418^..HEAD`) | **Matches plan §3 exactly** — see below. |
| `npm run dev` manual pass | **Partial — see note.** |

**`git diff --name-only b27c418^..HEAD`** (exactly the 7 files in §3; 5 modified +
2 test files extended):

```
components/dashboard/widgets/SpaceTransactionsPanel.tsx
lib/data/transactions.ts
lib/transactions/detail-sections.test.ts
lib/transactions/detail-sections.ts
lib/transactions/flow-predicates.test.ts
lib/transactions/flow-predicates.ts
types/index.ts
```

`serialize.ts`, `RelationshipResolver.ts`, `transaction-context.ts`,
`prisma/schema.prisma`, and `TransactionDetailContent.tsx` were left untouched, as
§3 requires.

**Manual dev-pass note (honest scope).** A dev server (the user's) is running on
`:3000` and responds without a compile error — the transactions route returns
`307 → /login` (auth-gated) rather than a 500, confirming the changed module
graph compiles and serves. The full interactive click-through in the plan's §8
checklist (visually confirming each filter narrows the list, Group By buckets
render, and the drawer shows the transfer-pair note) was **not** completed here:
the Chrome automation extension could not load `localhost:3000` (the tab reverts
to `newtab` — a site-permission grant), and the checklist additionally requires an
authenticated session plus seed data containing import/Plaid/manual rows and a
resolved `transferCandidate`. The underlying logic for every checklist item is
covered by the passing unit tests above; the remaining item is a visual spot-check
for the user against a logged-in Space with representative data.

---

## Stop conditions (plan §9) — none triggered

1. **Raw confidence tier / reason codes / provider strings in the UI.** Not
   triggered. The UI surfaces only `flowType` (humanized), `transferDisposition`
   (humanized canonical concept), the `needsClassification` boolean as-is, and
   `source` (the provenance enum already surfaced by the drawer's Provenance
   "Source" row). No `classificationConfidence` numbers, no `classificationReason`
   codes, no ontology terms.
2. **Batched duplicate-detection query.** Not triggered. No query was added
   anywhere; the list-level duplicate flag remains deferred to Phase 2. Duplicate
   stays per-row/drawer-only.
3. **`source` derivation reimplemented differently from the drawer.** Not
   triggered. A single shared `deriveSource()` is the sole definition, called by
   both the list read and the detail read.
4. **Group By and Perspective toggle as two redundant controls.** Not triggered.
   One Group By control ships; "No grouping" is the List perspective.
5. **Drift toward Explain-extended / Coverage / Compare / NLU / Saved Views /
   refundCandidate / recurring detection.** Not triggered. None were touched;
   `refundCandidate` remains correctly reserved-null.
