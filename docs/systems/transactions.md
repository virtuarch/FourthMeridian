# Transactions

## Purpose

The transactions system owns how individual money-movement rows are read,
what economic meaning is attached to each row, and which rows a given Space is
allowed to see. It is the row-level foundation beneath Cash Flow, DayFacts, the
Transactions perspective, exports, the AI assemblers, and the liquidity axis.
Its two central jobs are (1) a single canonical row-loader that every banking
read routes through, and (2) a single classifier that answers "what economic
KIND of movement is this, in what DIRECTION" so that no downstream consumer has
to re-derive that from provider category strings.

## Authority

- `lib/data/transactions.ts` — the canonical server-only row readers:
  `getTransactions` (banking list), `getDebtTransactions` (debt-account
  banking activity), `getInvestmentTransactions` (investment partition, no live
  consumers today), and `getTransactionDetail` (single-row detail). These are
  the only sanctioned entry points into the `Transaction` table for read.
- `lib/transactions/flow-classifier.ts` — `classifyFlow`, the single source of
  truth for FlowType/FlowDirection semantics. Pure, deterministic, Prisma-free,
  never throws.
- `lib/transactions/flow-predicates.ts` — the single authority for FlowType
  *membership* predicates (`isBankingPopulation`, `isCostFlow`, `isSpendLedgerFlow`,
  `isNonEconomicResidue`, `isDebtPayment`, …) and the per-flow aggregation
  (`sumByFlowType`). Zero-import, value-only, so any layer can call it.
- `lib/ai/visibility.ts` — `TRANSACTION_DETAIL_VISIBILITY` /
  `grantsTransactionDetail`, the single predicate deciding which
  `SpaceAccountLink.visibilityLevel` values may expose transaction-level detail.

## Inputs

- The `Transaction` rows themselves, reachable to a Space only through the
  canonical `FinancialAccount.spaceAccountLinks` path (D3 SpaceAccountLink).
- The Space context (`spaceId`) — supplied by the caller or resolved via
  `getSpaceContext()`.
- For classification (write path): fields already in memory — `category`,
  `amount` (FM sign convention: `+` into the row's own account, `−` out of it),
  account type / `debtSubtype`, merchant/description, and Plaid
  `personal_finance_category` primary/detailed **only when already present** on
  the synced/imported payload. The classifier never fetches.

## Outputs

- `Transaction[]` DTOs (banking list, debt list) — serialized once through
  `lib/transactions/serialize.ts`, carrying resolved merchant presentation,
  a KD-15-gated `counterpartyAccountId`, read-time context fields
  (`transferDisposition`, `needsClassification`), and a derived provenance
  `source` (`import` › `plaid` › `manual`).
- `TransactionDetail` — the single-row detail DTO: display-safe account block,
  provenance, a fail-closed counterparty block, an optional read-time reporting-
  currency conversion (`reporting`), and read-time relationship resolution
  (pending→posted, duplicate, owned-account transfer candidate).
- Persisted flow columns on write: `flowType`, `flowDirection`,
  `classificationConfidence`, `classificationReason`, `classifierVersion`,
  and captured PFC fields (`buildFlowWriteFields` in
  `lib/transactions/plaid-flow-input.ts`).

## Canonical contracts

- **Banking population = FlowType, not category.** The DB fragment is
  `BANKING_POPULATION = { flowType: { not: FlowType.INVESTMENT } }`
  (`lib/data/transactions.ts`). Every banking read admits every flow except
  pure investment security-activity — including `UNKNOWN` and unclassified
  (`null`) rows, which Prisma scalar `not` returns. The row-level statement is
  `isBankingPopulation(flowType)` (`flow-predicates.ts`); the two are pinned in
  lockstep by `lib/data/transactions.population.test.ts`.
- **FlowType write/read split.** `classifyFlow` decides KIND+DIRECTION at write
  time; the persisted `flowType` VALUE (a plain string at runtime) is what
  every read predicate consumes. Predicates never re-run the classifier.
- **Non-economic residue.** `isNonEconomicResidue` (`null | UNKNOWN | ADJUSTMENT`)
  names the rows that are IN the banking population (visible for review) but
  carry no economic bucket — they must never fold into income/spend/transfer/
  debt totals.
- **Provenance source precedence** is defined once (`deriveSource`) and shared
  by the list read and the detail read; the two callers must not diverge.

## Persistence

- `Transaction` rows carry the flow columns above plus captured Plaid metadata.
  Classification is written by the Plaid sync/import paths
  (`lib/plaid/syncTransactions.ts`, `app/api/accounts/[id]/import/route.ts`) via
  `buildFlowWriteFields`; classification failure writes `NULL_FLOW_WRITE_FIELDS`
  so the row still persists and never blocks the sync.
- `classifierVersion` is stamped per row (`FLOW_CLASSIFIER_VERSION`, currently
  `2`). Bumping the constant lets a later classifier re-run over only stale rows
  (`WHERE classifierVersion < FLOW_CLASSIFIER_VERSION`) without disturbing
  higher-confidence ones.
- `counterpartyAccountId` is deliberately NOT persisted by the classifier
  (Phase B writes `null`) — destination attribution is resolved read-side.
- Rows carry their own `deletedAt` soft-delete (independent of the account-level
  `deletedAt`); both must be null for a row to be visible.

## Consumers

Read through the canonical loaders: `app/api/spaces/[id]/transactions/route.ts`,
`app/api/transactions/[id]/route.ts` (+ `/correct`),
`app/api/money/view-context/route.ts`, `app/api/ai/chat/route.ts`,
`app/(shell)/dashboard/page.tsx`, `app/(shell)/dashboard/credit/page.tsx`,
`components/dashboard/widgets/SpaceTransactionsPanel.tsx` and sibling panels,
`lib/debt.ts`, and `lib/export/assemble.ts`. Membership predicates in
`flow-predicates.ts` are consumed by the dashboard banking widgets, the AI
assemblers, `lib/debt.ts`, and the Cash Flow engine (`lib/transactions/`).

## Invariants

- **Visibility is a hard, fail-closed invariant.** A banking read only returns
  rows from accounts whose `SpaceAccountLink` is `ACTIVE` **and** whose
  `visibilityLevel ∈ TRANSACTION_DETAIL_VISIBILITY` (currently `FULL` only).
  `BALANCE_ONLY` / `SUMMARY_ONLY` accounts contribute a balance total elsewhere
  but their transaction rows, merchants, and amounts must NEVER leak. The same
  predicate gates the AI assemblers (`lib/ai/assemblers/transactions.ts`), the
  counterparty-id/name exposure seams, and `getTransactionDetail`
  (`transactionDetailWhere`, which returns null → 404). Absence of a grant
  always excludes, never leaks.
- The UI read path and the AI read path import the **same** predicate constant
  so they can never disagree.
- The classifier is an honesty valve: when signals conflict or are insufficient
  it returns `UNKNOWN` with low confidence rather than forcing `SPENDING`.
- Both `deletedAt` guards (row and account) are ANDed with visibility and date.

## Known limitations

- `SHARED` is a legacy `VisibilityLevel` that "maps to FULL" per the schema but
  is deliberately EXCLUDED from `TRANSACTION_DETAIL_VISIBILITY`; the predicate
  fails closed (over-redacts) if such a row ever appears. Re-audit before
  widening the list.
- `getInvestmentTransactions` still gates on a `category ∈ {Buy,Sell,Dividend,
  Split,Fee}` allow-list rather than FlowType, and currently has no live
  consumers; it is owned by the investment truth-spine track and left untouched.
- The Plaid PFC classification branch (`classifyFromPfc`) is exercised only on
  the write path where PFC is in memory; no persisted read path passes PFC.
- `counterpartyAccountId` is resolved read-time (persisted provider-confirmed
  links win; a bounded-window transfer match fills in only where none exists),
  which means owned-account transfer attribution is best-effort, not stored.

## Extension points

- New economic meaning: add a rule in `classifyFlow` and bump
  `FLOW_CLASSIFIER_VERSION`; add the matching membership predicate in
  `flow-predicates.ts` (a new flow kind is admitted once, not per consumer).
- New per-flow aggregation: build it on `sumByFlowType` so the summary bar and
  any grouped view cannot diverge.
- New read surface: call the canonical loaders; never query `Transaction`
  directly, so the visibility and population invariants come for free.

## Why the architecture is this way

The recurring failure mode this system prevents is *definition drift* — the
same "which rows count as spend / which rows can this Space see" question being
answered slightly differently at every call site. Two prior instances motivated
the current shape: a provider `category` allow-list silently omitted legitimate
banking rows (cash dividends, card fees) it hadn't hand-listed, so the rule was
re-expressed as a single FlowType exclusion that also keeps unclassified rows
visible for review; and transaction detail could reach a Space (both UI and AI)
that was only granted balance visibility, so a single fail-closed predicate now
governs every read path. Keeping classification pure and versioned, and keeping
membership predicates zero-import, means the meaning of a row is defined exactly
once and can be safely called from the data layer, API routes, and tests alike.
