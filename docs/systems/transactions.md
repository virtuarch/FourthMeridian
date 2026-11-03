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

## Resolved transaction nature (narration and filtering)

**IMPLEMENTED** — PR #62 (contract), PR #58 (the transfer-authority write rule it
complements), PR #63 (owner rulings on unconfirmed destinations); later label fixes in
v2.7-B. Code: `lib/transactions/resolved-nature.ts`. Status markers as in the
[documentation lifecycle](../README.md#documentation-lifecycle).

**The rule (owner-approved):** a transfer between two owned depository accounts is
never described as reducing debt.

The persisted `flowType` cannot carry that rule alone: a provider can tag an ACH pull
initiated by a bank-and-card issuer as a loan payment, the context-free classifier then
persists `DEBT_PAYMENT`, and only the transfer authority (which sees the other leg)
knows the money went to the owner's own savings. The write rule fixes new rows after
each sync; historical rows keep `DEBT_PAYMENT` until an owner-approved repair
(`scripts/repair-transfer-debt-payment.ts`) is applied. `resolveTransactionNature`
makes every narrating or filtering reader correct before and after that repair.

**Contract.** `resolveTransactionNature(evidence)` is pure and total, and reads no
descriptor, merchant, institution or category string — every input is another
authority's verdict, an account type, or provenance. It returns a `nature`, the `flow`
to filter and narrate as (`DEBT_PAYMENT` only for a liability payment; any other
movement of a stored `DEBT_PAYMENT`/`TRANSFER` row is `TRANSFER`), the `basis`, the
`leg`, and `betweenOwnAccounts`.

| Nature | Meaning | Reduces debt |
|---|---|:-:|
| `LIABILITY_PAYMENT` | payment toward an owned card or loan | ✓ (the only one) |
| `INTERNAL_SAVINGS_TRANSFER` / `INTERNAL_CHECKING_TRANSFER` / `BROKERAGE_TRANSFER` | to an owned savings / checking or cash-management / investment or crypto account | – |
| `INTERNAL_TRANSFER` | between owned accounts, destination type not named | – |
| `EXTERNAL_TRANSFER` | positive evidence the other side is not owned | – |
| `TRANSFER_DESTINATION_UNCONFIRMED` | to a bank account not connected here, inferred only from the provider's generic bank-transfer venue; still a transfer, never claimed external (owner ruling) | – |
| `CASH_MOVEMENT` | cash withdrawal or deposit | – |
| `UNCLASSIFIED_MOVEMENT` | purpose not established; narrated only as "money moved" | – |
| `SPENDING` / `INCOME` / `REFUND` / `ISSUER_CREDIT` / `INVESTMENT_ACTIVITY` / `ADJUSTMENT` / `UNCLASSIFIED` | economic kinds from the stored flowType | – |

**Precedence — the first rung that speaks wins:**

1. **USER** — `categorySource ∈ {USER_OVERRIDE, USER_RULE}`: the human's flowType
   decides; a human "Payment" is a liability payment and a human category is never
   relabelled.
2. **TRANSFER_AUTHORITY** — `flowAuthority = TRANSFER_AUTHORITY`: the persisted flowType
   is the cross-row verdict.
3. **TRANSFER_EVIDENCE** — the transfer maturity (internal kinds vs external leaves),
   the owned counterparty's account type, and the debt-payment attestation rule
   (`isDebtPaymentAttested`: liability counterparty or `DEBT_PAYMENT` maturity); a
   liability-side leg is a payment because that is structurally certain.
4. **PROVIDER** — nothing established the purpose, so a movement is
   `UNCLASSIFIED_MOVEMENT`. A provider `DEBT_PAYMENT` alone never establishes a liability
   payment. An owned counterparty whose type the viewer cannot resolve is not enough to
   call a provider `DEBT_PAYMENT` internal — the unseen account could be the card.

**Invariant (tested in `resolved-nature.test.ts`).** For every non-USER row,
`reducesDebt && leg === "CASH"` holds exactly when the debt-payment authority
(`selectDebtPaymentCashLegs`) counts the row, so no sentence built from the contract can
claim a debt reduction the money totals do not contain. The one deliberate divergence:
a human "Payment" is honoured in narration while money totals keep the attestation rule.

**No parallel authority.** `debt-payment-attestation.ts` stays the liability-payment
admission rule; `transfer-maturation.ts` supplies maturities;
`transfer-debt-payment-correction.ts` stays the write rule; `describeRowNature`
(`flow-presentation.ts`) stays the UI label authority; `liquidity.ts`,
`debt-payment-authority.ts` and `debt-service.ts` stay the money authorities.

**Consumers routed through it** (**IMPLEMENTED**): the AI assembler's refused-payment
transfer total (`lib/ai/assemblers/transactions.ts`); the `get_transactions` tool's
`card_payments` / `transfers` sets, which read both movement flows to exhaustion and
filter by `RESOLVED_FLOW_MEMBERSHIP` so the count equals the list
(`lib/ai/conversation/tools/transactions.ts`, bounded by the 5,000-row ceiling, which is
reported as incomplete when hit); per-row `nature` + `natureNote` from
`NATURE_DESCRIPTION`, the only per-row phrasing AI surfaces may use; Daily Brief recent
activity, classes touched, and the `describesTransferAsDebtReduction` guard that drops a
debt-reduction observation citing only non-payment movements (`lib/ai/brief/`).

**Daily Brief policy (owner, 2026-10-27).** The prompt change did not bump
`BRIEF_GENERATION_VERSION`; stored Briefs stay valid and are never mutated. The prompt
revision is tracked separately (`BRIEF_PROMPT_REVISION`, folded into the stored
`promptVersion` string; `promptRevisionOf` reads it back), and the material digest keeps
its pre-change flow input (`digestFlowOf`), so the deploy alone regenerated nothing.
**IMPLEMENTED** (`lib/ai/brief/policy.ts`, `lifecycle.ts`, `digest.ts`). A display-time
notice on older Briefs was **not** built — a stored Brief does not keep the package rows
it cited, so affectedness cannot be determined. Storing a compact snapshot of cited rows
per generation ("Brief versioning") is **PROPOSED**.

**Residual gaps (current behaviour):**

- The Transaction Explorer's flow filter (the "Debt" quick pill) filters the stored
  `flowType` in a keyset-paged WHERE, which cannot express a cross-row verdict; an
  unrepaired historical row still appears under "Debt" (its row label already reads as a
  transfer). Depends on the repair.
- Stored category "Payment" still shows in exports and category filters for unrepaired
  rows; the drawer and the AI relabel it (`categoryForNature`). Depends on the repair.
- `describeRowNature` labels a provider `DEBT_PAYMENT` with **no** transfer maturity and
  no attestation "Debt payment"; one the transfer authority assessed without attesting a
  liability destination reads as a transfer (v2.7-B). Money totals refuse both.
- The AI assembler does not select `categorySource`, so a human "Payment" on a
  savings-paired row is not counted as a transfer there — consistent with the money layer.

## Refund economics

**IMPLEMENTED** — REFUND-1 (`382897e`) and NET-BASELINE-1 (`74b2f46`); classifier
version 5.

**A refund is never income, and nets the category it reverses.** `REFUND` is a
first-class `FlowType`; the one economic fold (`foldEconomicRow` / `clampEconomicSpend`,
`lib/transactions/cash-flow.ts`) nets refunds out of spending and `categorySpendLedger`
nets them per category.

**Liability-inflow income veto.** A provider can file a merchant's money-back on a credit
card as `INCOME_*` (it picks the detail from the merchant's brand). A liability account
cannot receive earnings, so `classifyFlow` vetoes `INCOME` on a liability inflow on both
income paths (provider family and `Income` category) — the mirror of "a liability outflow
is never a debt payment". **IMPLEMENTED** (`incomeUnlessLiabilityInflow`,
`lib/transactions/flow-classifier.ts`).

**Category attribution is evidence-based and conservative.** Which category such a
credit reverses comes from the ledger, not the provider label: the same merchant's
**prior purchases on the same account**, where "same merchant" is exact equality on the
provider merchant entity id, the stored merchant name, or the raw issuer descriptor.
Unanimous in one genuine spend category ⇒ that category, `REFUND`, confidence 0.6 /
`ACCOUNT_TYPE_CONTEXT` (below a provider-labelled refund). Silent, split or only
`Other` ⇒ `Other`, which the classifier sends to the honest `UNKNOWN` valve. Merchant
history never decides that a row *is* a refund — account structure and provider family
did; history only picks the category. `categorySource` is left null (provenance not
claimed). **IMPLEMENTED** (`lib/transactions/merchant-credit.ts`,
`merchant-credit-evidence.ts`, wired in `lib/plaid/syncTransactions.ts` in the order
`mapPlaidCategory → payment rescue → payroll rescue → merchant credit → classifyFlow`).

**Category-level netting, not purchase pairing.** No refund is paired to a purchase:
providers give no refund flag and no original-transaction reference
(`pending_transaction_id` links a row only to its own pending observation), and a
category's cost is `gross − refunds` whichever purchase a refund belonged to.
**DECIDED** and **IMPLEMENTED**.

| Kind | Treatment |
|---|---|
| purchase refund / merchant credit / reversal | `REFUND` in the purchase's category; a same-day pair nets to 0 |
| card payment | `DEBT_PAYMENT` — never reduces a category |
| account transfer | `TRANSFER` — never |
| cashback / reward / statement credit on a card | not a purchase refund: `Other` / `UNKNOWN`, out of income and refunds |
| reimbursement | never silently a refund: a person's transfer is `TRANSFER`, an employer's is `INCOME` |
| chargeback / dispute credit | no provider dispute flag: filed in the purchase's family ⇒ treated as that category's refund; a lost dispute re-bills as a new charge in its own month; no family ⇒ `UNKNOWN` |
| refund exceeding same-window purchases | category net floors at 0; the excess is named `refundsUnapplied` |

**Arithmetic and periods** (`categorySpendLedger`): `gross` = Σ cost flows dated in the
window; `refunds` = Σ `REFUND` rows dated in the window; `net = max(0, gross − refunds)`;
`refundsUnapplied = max(0, refunds − gross)`; conserved as
**Σgross − Σrefunds = Σnet − ΣrefundsUnapplied**. A refund counts in the period it is
dated, never the purchase's period; closed periods are not rewritten. Pending and posted
observations classify identically, and a refund's economic date stays pinned to its first
observation. **IMPLEMENTED** (pinned by `lib/transactions/refund-economics.test.ts`).

**Which figures are net and which are gross** (**IMPLEMENTED**):

| Consumer | Basis |
|---|---|
| Cash Flow headline and Spending by category (a category with refunds shows "charged · refunded" under its net value) | **NET** |
| Measured expense baseline (`computeAverageMonthlySpending`, `get_baselines` MEASURED rung), and everything divided by it: surplus, savings rate, runway, N-months-of-expenses thresholds, Liquidity "months of expenses", the Brief's monthly expenses | **NET** — per whole month, gross less refunds dated that month, floored at 0, then the mean (`meanMonthlyEconomicSpend`); a 0 baseline is a refusal (`resolveExpenseBaseline`), never infinite runway |
| Cash projection spending rate (`project_cash`, scenario tools) and the scenario liquid floor | **NET** |
| Spending trend metric `expense` | **NET**, so `income − expense = net` reconciles |
| `measure_flows(spending).total`, `get_spending`, AI `byCategory.total` | **GROSS** ("how much was charged"), with `netOfRefunds` / `netTotal` / `refundTotal` beside it and `changeNetOfRefunds` on comparisons |
| `measure_flows(economicNet)` | `income − max(0, spending − refunds)` per month |
| Stated / declared baselines | the user's own figure; unchanged |

When refunds move a monthly figure by at least `MATERIAL_MONTHLY_REFUND_EFFECT` ($1), the
tool output also carries `gross` and `refundEffect` with `gross − refundEffect = net`
exactly, so the model quotes the gap instead of subtracting. Guards: the AI assembler may
not re-inline refund arithmetic (`lib/ai/fold-enrolment.test.ts`); the category ledger is
pinned by source scan (`lib/transactions/cash-flow-convergence.test.ts`).

**Limitations (current behaviour):**

- A merchant's first-ever credit on a card has no purchase history ⇒ `UNKNOWN`; a user
  category correction is the escape hatch and is preserved.
- A credit whose only matching purchase is itself `Other` stays unattributed (a positive
  `Other` is never a refund).
- CSV / manual imports get the veto but not the category attribution (no evidence read on
  that path): an `Income` row on a card becomes `UNKNOWN` with its category unchanged.
- A category refunded in a month with no purchases is dropped from the AI's monthly
  `byCategory`; the Cash Flow ledger shows it as `refundsUnapplied`.
- A positive interest or fee row on a card (a reversal) keeps its `INTEREST` / `FEE` flow
  and is not attributed to a spend category; the economic fold nets it as a credit and
  the UI labels it "Refund" (`describeRowNature`, FM-AUDIT-006).
- Rewards deposited to a depository account under an income family remain income.

**Operator repair for rows stored before the veto** (**IMPLEMENTED**, operator-run):
`scripts/repair-liability-income-credits.ts` — dry run by default, `--apply` after a
backup; updates category / categorySource / flow columns only, ownership-gated, never
touches a user-corrected row, prints a rollback line per row, idempotent. After any
classifier bump, `scripts/backfill-flowtype.ts`'s default predicate
(`classifierVersion < current`) lists every older row; that is the normal
version-migration behaviour.

## Persistence

- `Transaction` rows carry the flow columns above plus captured Plaid metadata.
  Classification is written by the Plaid sync/import paths
  (`lib/plaid/syncTransactions.ts`, `app/api/accounts/[id]/import/route.ts`) via
  `buildFlowWriteFields`; classification failure writes `NULL_FLOW_WRITE_FIELDS`
  so the row still persists and never blocks the sync.
- `classifierVersion` is stamped per row (`FLOW_CLASSIFIER_VERSION`, currently
  `5` — REFUND-1's liability-inflow veto). Bumping the constant lets a later classifier re-run over only stale rows
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
