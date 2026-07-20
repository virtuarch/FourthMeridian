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

- `lib/data/transaction-query.ts` — `queryTransactions`, the canonical filtered,
  paginated transaction read authority. It owns account-scope resolution
  (`resolveVisibleAccountIds`), filtering semantics, and keyset pagination. It
  does NOT re-derive population or visibility: it composes `bankingTransactionWhere`
  (below) and the pure filter/keyset core (`lib/data/transaction-query-core.ts`),
  returning a bounded page of DTOs plus a continuation cursor. Every filtered read
  surface routes through it, so no consumer builds a parallel query.
- `lib/data/transactions.ts` — the shared population/visibility authority plus the
  bounded loaders that consume it. `bankingTransactionWhere` is the ONE WHERE
  fragment (banking population + KD-15 transaction-detail visibility + soft-delete)
  that every read composes. `getTransactions` (banking list) and
  `getDebtTransactions` (debt-account activity) are BOUNDED loaders over it;
  `getTransactionDetail` is the single-row detail read. Together with
  `queryTransactions` these are the only sanctioned entry points into the
  `Transaction` table for read — no consumer queries the table directly.
- `lib/transactions/flow-classifier.ts` — `classifyFlow`, the single semantic
  authority for FlowType / FlowDirection / classificationReason. Pure,
  deterministic, Prisma-free, never throws.
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
- **Flow classification is the single semantic authority.** `classifyFlow`
  decides KIND + DIRECTION at write time and persists `flowType`, `flowDirection`,
  `classificationReason`, and `classifierVersion`. That persisted verdict is the
  economic meaning of the row. No consumer re-derives meaning from provider
  categories, merchant names, or raw transaction metadata — those are inputs to
  the classifier, resolved once, never re-interpreted downstream.
- **FlowType write/read split.** `classifyFlow` decides KIND+DIRECTION at write
  time; the persisted `flowType` VALUE (a plain string at runtime) is what
  every read predicate consumes. Predicates never re-run the classifier.
- **The on-chain (btc-sync) classifier exception.** `lib/crypto/btc-sync.ts` is
  the ONE sanctioned path that persists flow classification WITHOUT
  `classifyFlow` (and so stamps a null `classifierVersion`, marking a distinct
  authority — not a stale row). It is allowed because on-chain movements carry
  none of the banking evidence the classifier's ladder needs (no PFC, no
  descriptor, no counterparty name), so routing them through `classifyFlow` would
  yield only `UNKNOWN`. The exception is executable policy, not a comment: it is
  fenced by `lib/transactions/flow-classifier-authority.test.ts`, which fails if
  the marker is removed OR if any OTHER file begins hand-writing `flowType`
  off-classifier. It must never become a second uncontrolled authority; any future
  exception requires the same explicit, guarded treatment.
- **Non-economic residue.** `isNonEconomicResidue` (`null | UNKNOWN | ADJUSTMENT`)
  names the rows that are IN the banking population (visible for review) but
  carry no economic bucket — they must never fold into income/spend/transfer/
  debt totals.
- **Provenance source precedence** is defined once (`deriveSource`) and shared
  by the list read and the detail read; the two callers must not diverge.
- **One read path, composed not copied.** Every consumer reads through the same
  pipeline:

  ```
  provider transaction data (Plaid sync / import / manual / on-chain)
      ↓
  canonical Transaction model (persisted flow columns)
      ↓
  bankingTransactionWhere  (population + visibility, one authority)
      ↓
  queryTransactions        (account scope + filters + keyset pagination)
      ↓
  consumers: Transaction Explorer · Cash Flow · Liquidity ·
             Calendar / activity · future analytics
  ```

  A consumer must NOT: query the `Transaction` table directly; recreate the
  visibility predicate (`TRANSACTION_DETAIL_VISIBILITY`); or build a parallel
  transaction population. New meaning is added in the classifier and read back
  through `queryTransactions` / the bounded loaders — never re-derived at the
  call site.

## Persistence

- `Transaction` rows carry the flow columns above plus captured Plaid metadata.
  Classification is written by the Plaid sync/import paths
  (`lib/plaid/syncTransactions.ts`, `app/api/accounts/[id]/import/route.ts`) via
  `buildFlowWriteFields`; classification failure writes `NULL_FLOW_WRITE_FIELDS`
  so the row still persists and never blocks the sync.
- `classifierVersion` is stamped per row (`FLOW_CLASSIFIER_VERSION`, currently
  `4`). Bumping the constant lets a later classifier re-run over only stale rows
  (`WHERE classifierVersion < FLOW_CLASSIFIER_VERSION`) without disturbing
  higher-confidence ones.
- `counterpartyAccountId` is deliberately NOT persisted by the classifier
  (Phase B writes `null`) — destination attribution is resolved read-side.
- Rows carry their own `deletedAt` soft-delete (independent of the account-level
  `deletedAt`); both must be null for a row to be visible.

## Consumers

Read through the canonical loaders: `app/api/spaces/[id]/transactions/route.ts`,
`app/api/spaces/[id]/transactions/query/route.ts` (the Transaction Explorer,
via `queryTransactions`), `app/api/transactions/[id]/route.ts` (+ `/correct`),
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
- There is no investment-partition row loader. The former
  `getInvestmentTransactions` was removed as dead, unbounded code (no consumer,
  no `take` or window); its pure `serializeInvestmentTransactionRow` is retained
  under frozen golden coverage for the investment truth-spine track to re-express.
  Investment security-activity (`FlowType.INVESTMENT`) is deliberately outside the
  banking population every read here serves.
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
