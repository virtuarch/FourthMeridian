# Resolved transaction nature contract (2026-10-27)

**Status:** v2.7 Workstream A (P0, release blocker). Branch `fix/v2.7-p0-debt-semantics`, based on develop `ff62cb7`.
**Rule (already approved):** Fourth Meridian never describes a transfer between two owned depository accounts as reducing debt.
**Production:** unchanged. No DB, Plaid, model call or Brief row was touched.

## 1. Why a contract

PR #58 made the transfer authority write `TRANSFER` onto new depository legs that Plaid tagged `LOAN_PAYMENTS`. That covers rows after each sync. Historical rows stay `flowType = DEBT_PAYMENT, category = Payment` until the owner-approved repair (`scripts/repair-transfer-debt-payment.ts`) runs, and on Production that is 16 rows (−$24,372.67).

Readers that trusted the stored column therefore kept saying "debt payment":
- the Brief prompt said any `betweenOwnAccounts` row "lowers what is owed";
- `get_transactions` filtered `card_payments` / `transfers` on the stored column.

This contract makes every narrating or filtering reader correct **before and after** the repair.

## 2. The contract

**Location:** `lib/transactions/resolved-nature.ts`, function `resolveTransactionNature(evidence)`. It is pure and total, reads no descriptor, merchant, institution or category string, and is pinned by a source probe.

### Natures

| Nature | Meaning | `reducesDebt` |
|---|---|:-:|
| `LIABILITY_PAYMENT` | payment toward an owned card or loan (`leg` = CASH or LIABILITY) | ✓ (liability leg only when money arrives on it) |
| `INTERNAL_SAVINGS_TRANSFER` | to an owned savings account | – |
| `INTERNAL_CHECKING_TRANSFER` | to an owned checking or cash-management account | – |
| `BROKERAGE_TRANSFER` | to an owned investment or crypto account | – |
| `INTERNAL_TRANSFER` | between owned accounts, destination type not named | – |
| `EXTERNAL_TRANSFER` | positive evidence the other side is not owned (a person, external bank, venue) | – |
| `CASH_MOVEMENT` | cash withdrawal or deposit | – |
| `UNCLASSIFIED_MOVEMENT` | purpose not established; never narrated as more than "money moved" | – |
| `SPENDING` / `INCOME` / `REFUND` / `ISSUER_CREDIT` / `INVESTMENT_ACTIVITY` / `ADJUSTMENT` / `UNCLASSIFIED` | economic kinds, from the stored flowType (income refined by the income taxonomy) | – |

Each result carries:
- `flow`: the FlowType to filter and narrate as. It is `DEBT_PAYMENT` only for a liability payment; any other movement of a stored DEBT_PAYMENT or TRANSFER row is `TRANSFER`.
- `basis`.
- `leg`.
- `betweenOwnAccounts`.

### Precedence (the first rung that speaks wins)

1. **USER.** `categorySource ∈ {USER_OVERRIDE, USER_RULE}`: the human's flowType decides. A human "Payment" is a liability payment, and a human category is never relabelled.
2. **TRANSFER_AUTHORITY.** `flowAuthority = TRANSFER_AUTHORITY`: the persisted flowType is the cross-row verdict. Its `DEBT_PAYMENT` is a payment. Its `TRANSFER` is named from the evidence, or is `UNCLASSIFIED_MOVEMENT` (the low-confidence `AMBIGUOUS_UNKNOWN 0.2` write).
3. **TRANSFER_EVIDENCE.**
   - Maturity `SAVINGS_TRANSFER`, `CASH_TRANSFER`, `INVESTMENT_TRANSFER` or `INTERNAL_TRANSFER` means an internal kind. An external leaf means `EXTERNAL_TRANSFER`.
   - The owned counterparty's account type names the kind.
   - A stored `DEBT_PAYMENT` cash leg is a liability payment only when **attested**, through the existing `isDebtPaymentAttested` (liability counterparty, or `DEBT_PAYMENT` maturity).
   - A liability-own `DEBT_PAYMENT` leg is a payment, because it is structurally certain.
   - A `TRANSFER` cash leg from a liquid account into an owned liability is a payment, matching `classifyTransfer`.
4. **PROVIDER.** Nothing establishes the purpose, so the row is `UNCLASSIFIED_MOVEMENT`. A provider `DEBT_PAYMENT` alone never establishes a liability payment.

An owned counterparty whose type the viewer cannot resolve is not enough, on a provider `DEBT_PAYMENT`, to call the row internal: the unseen account could be the card.

### Invariant (tested)

For every non-USER row on a liquid account, `reducesDebt && leg === "CASH"` holds exactly when `selectDebtPaymentCashLegs` counts the row. So no sentence built from the contract can claim a debt reduction that the money totals do not contain.

The only deliberate divergence: a USER "Payment" is honoured in narration, while money totals keep the attestation rule. That rule is unchanged, so this PR makes no financial policy change.

### Helpers

- `categoryForNature`: provider `Payment` becomes `Transfer` on a resolved non-payment movement; a human category is untouched.
- `natureEvidenceFromRow`: builds the evidence from a list-row DTO plus the caller's visibility-gated account-type lookup.
- `NATURE_DESCRIPTION`: the only per-row phrasing AI surfaces may use.

### Relationship to the existing authorities (no parallel authority)

| Authority | Role |
|---|---|
| `debt-payment-attestation.ts` | Reused as-is: the liability-payment admission rule |
| `transfer-maturation.ts` | Supplies the maturity and `EXTERNAL_MATURITIES` |
| `transfer-debt-payment-correction.ts` | Supplies the user-category set. It stays the WRITE rule; its read helpers `resolvedFlowType` / `resolvedCategory` remain only for the drawer (`detail-sections.ts`) and are a subset of this contract |
| `flow-presentation.ts` `describeRowNature` | Stays the presentation LABEL authority. Its maturity rung agrees with this contract; see residual risk R3 |
| `liquidity.ts` / `debt-payment-authority.ts` / `debt-service.ts` | Stay the MONEY authorities; the invariant ties the contract to them |

## 3. Consumer audit (stored flowType / category "Payment" / PFC deciding "debt payment")

| # | Consumer | Before | After |
|---|---|---|---|
| 1 | `lib/transactions/plaid-category.ts:86` (`LOAN_PAYMENTS` → `Payment`) | provider guess, account-blind | unchanged by design (ingest stays context-free) |
| 2 | `lib/transactions/flow-classifier.ts:298` (`debtPaymentUnlessLiabilityOutflow`) | persists `DEBT_PAYMENT` | unchanged by design; corrected downstream by the write rule (new rows) and this contract (all rows) |
| 3 | `lib/transactions/transfer-debt-payment-correction*.ts` (PR #58 write rule) | writes TRANSFER for proven own-account legs | unchanged; fixture-tested here end to end (`applyCorrection`). No defect found |
| 4 | `lib/transactions/liquidity.ts:208` (DEBT_PAYMENT branch) | attestation-gated (v2.6-DEBT-1) | unchanged; the contract's invariant test proves agreement |
| 5 | `lib/transactions/debt-payment-authority.ts`, `debt-service.ts:130` (netPaydown) | `classifyLiquidity`-based | unchanged; before/after identity test (payments 750, netPaydown identical) |
| 6 | `lib/debt.ts:125` (`rollupDebtPaymentsByAccount`) | debt-account legs only | unchanged; fixture rollup `autoLoan:450, chaseCard:300` identical before and after |
| 7 | `lib/transactions/cash-flow-projection.ts:350` (Debt payments tile) | `reason DEBT_PAYMENT` via liquidity | unchanged |
| 8 | `lib/transactions/cash-flow.ts` `foldEconomicRow` | DEBT_PAYMENT and TRANSFER both ignored | unchanged; income and spending identical |
| 9 | `lib/ai/assemblers/transactions.ts:823` (`transferTotal` for refused DEBT_PAYMENT rows) | `isTransferLeafMaturity` (PR #58) | **the contract**: established non-payment movement (maturity **or** counterparty type); unclassified stays out. `debtPaymentTotal` is still the authority's counted set |
| 10 | `lib/ai/assemblers/transactions.ts:1574` (monthly fold) | authority sets | unchanged (consumes #9's set) |
| 11 | `lib/ai/measures/measure.ts:156` `cardAndDebtPayments` (measure_flows / get_baselines) | `debtPaymentTotal` from the authority | unchanged |
| 12 | `lib/ai/conversation/tools/transactions.ts:66` `FLOW_SETS` card_payments / transfers | stored `flowType` WHERE (unrepaired Amex pulls listed as card payments) | **the contract**: reads both movement flows to exhaustion and filters by `RESOLVED_FLOW_MEMBERSHIP`. The count and the list come from one predicate (count === list) |
| 13 | `lib/ai/conversation/tools/transactions.ts:258` (row presentation) | raw category, `movementKind` | adds `nature` + `natureNote` (the AI transaction explanation), `categoryForNature`; the tool description says to describe rows only by `natureNote` |
| 14 | `lib/ai/brief/recent-activity.ts:121` | `resolvedFlowType` (maturity only), `betweenOwnAccounts` from counterparty | **the contract**: `flow` is resolved (own and counterparty account types from the loader's lookup), with new `nature`, `otherLegAccount` by nature, and `betweenOwnAccounts` also from evidence |
| 15 | `lib/ai/brief/contract.ts:187` `classesTouched` | any own-accounts leg touched every class, LIABILITY included | an internal nature touches only its own and named classes, never LIABILITY by default |
| 16 | `lib/ai/brief/contract.ts` `describesTransferAsDebtReduction` (new) and `generate.ts` | none | drops an observation whose every cited row is a non-payment movement **and** whose text uses debt-reduction wording (`MISLABELED_MOVEMENT`) |
| 17 | `lib/ai/brief/digest.ts:58` `SIGNAL_FLOWS` | read `row.flow` | now reads the resolved flow (an internal transfer is no longer a DEBT_PAYMENT signal) |
| 18 | `lib/ai/brief/prompt.ts:44-45` | "DEBT_PAYMENT is paying down debt…"; "any row marked betweenOwnAccounts … lowers what is owed" | only `LIABILITY_PAYMENT` lowers what is owed. Internal transfers are "moved between their accounts", never a payment or a debt reduction. Unclassified or external: only "money moved". "A transfer between the user's own accounts never changes what is owed" |
| 19 | `lib/transactions/serialize.ts` / `types/index.ts` | no provenance on the DTO | emits `flowAuthority` / `categorySource` when the read selected them (golden fixtures byte-identical) |
| 20 | `lib/transactions/detail-sections.ts:93` (drawer category) | `resolvedCategory` (maturity) | unchanged (PR #58); a subset of the contract for maturity rows |
| 21 | `lib/transactions/flow-presentation.ts:232,301` `describeRowNature` (drawer, slice drawer, panel, CSV `row_nature`) | maturity > flowType label | unchanged; see R3 |
| 22 | `lib/data/transaction-query-core.ts:275` + `QuickFlowPills.tsx:40` (UI explorer "Debt" pill) | stored `flowType` WHERE | unchanged; see R1 |

## 4. Daily Brief (owner policy 2026-10-27)

1. **No regeneration.** `BRIEF_GENERATION_VERSION` stays `brief-generation-5`. Every existing DailyBrief row, today's included, stays valid and is reused.
2. **Future generations are corrected:** the prompt (§3 #18), the package `nature`, and the guards (#15, #16).
3. **Prompt revision tracked independently.** This needs no schema change.
   - New `BRIEF_PROMPT_REVISION = 'debt-semantics-1'` (`policy.ts`), folded into the stored string as `promptVersion = <generation>+prompt-<hash>+rev-<revision>` (`lifecycle.ts`).
   - The reuse gate still compares only `generationVersionOf` (the part before the first `+`).
   - `promptRevisionOf()` reads the revision back.
   - Tests (`lifecycle.test.ts` §14):
     - a row stored as `brief-generation-5+prompt-08fbac9b9cb7` (the exact pre-change shape) is FRESH, CACHED, with no model call, and its row is byte-identical;
     - a new generation records `+rev-debt-semantics-1` and the new hash.
   - The prompt-hash pin moved from `08fbac9b9cb7` to `dfb26bf3e8ae`, deliberately and without a generation bump.
   - **Side effect:** today's material digest can change for a Space whose 7-day window contains a mislabelled row. Its `flow` changes, so CHECK_MATERIAL may regenerate that Space's Brief for today once on its next visit. This is the ordinary material-change path, not a version bump, and only reachable where the old package actually held a mislabelled row. Earlier days are never touched.
4. **Display-time notice for previously generated Briefs: NOT implemented.** Affectedness cannot be determined reliably:
   - `DailyBrief.content` stores only the narration (headline; observations with kind, title, body, importance and evidence paths such as `recentActivity.top.0`);
   - the package those paths point into is **not stored**, so a stored Brief cannot be resolved back to the row it cited or that row's nature;
   - rebuilding the package at view time would describe today's data, not the data the Brief was written from;
   - judging by prose alone ("paid down") cannot tell a genuine card payment from a savings transfer.

   Per the owner policy no blanket notice is shown, and no Brief is labelled inaccurate for being old. Stored content is never mutated.
5. **Proposed safe treatment for existing misleading Briefs** (owner decision, not implemented):
   - **(a)** Leave them. They age out of the page: only today's and the latest prior Brief are shown.
   - **(b)** If a specific Space is known to be affected (Production has 16 mislabelled legs since 2025-09), the owner may use the existing operator path to regenerate *today's* Brief for that Space only, after the historical repair is applied.
   - **(c)** Future improvement (not built, per owner instruction): **Brief versioning**, i.e. store a compact snapshot of the cited package rows (date, amount, resolved nature) with each generation. A later display could then mark exactly the observations whose cited rows' resolved nature changed, without prose matching.

## 5. Tests

| Suite | Checks | Covers |
|---|---:|---|
| `lib/transactions/resolved-nature.test.ts` | 21 | Production-pattern fixture BEFORE (historical, unrepaired) and AFTER (the write rule applied), covering: <br>• Chase→Amex HYSA (paired, and unpaired pending), Chase→Amex checking, Chase→Schwab checking: internal, no debt, not spending/income; <br>• Chase→Chase card and auto loan: still reduce debt, cash leg once; <br>• Apple Cash: external; <br>• the provider-mislabelled historical row resolves to an internal transfer; <br>• partial/unmatched rows and the TA 0.2 write: unclassified; <br>• user-override precedence; TA precedence; <br>• pending equals posted; resync stability; <br>• the invariant against `selectDebtPaymentCashLegs`; <br>• income, spending, net cash, debt paid, payments, netPaydown, netNewBorrowing and per-liability rollup identical before and after; <br>• purity probe |
| `lib/ai/brief/debt-semantics.test.ts` | 21 | Package carries the resolved `nature`/`flow` (no internal transfer reaches the model as DEBT_PAYMENT). Prompt sentences. Serialized package. A "paid down" observation citing a savings transfer is dropped by `acceptNarration`; a correct "moved to savings" observation and a genuine card-payment observation are kept |
| `lib/ai/conversation/tools/transactions.nature.test.ts` | 6 | card_payments and transfers via the resolved predicate; partition; count === list; `natureNote` (the AI explanation) never calls an internal transfer a debt payment; no account lookup means nothing is invented |
| `lib/ai/brief/lifecycle.test.ts` §14 | 8 | prompt revision recorded; a pre-change cached Brief is reused, no regeneration |
| Updated pins | — | `generate.test.ts` (prompt sentences), `recent-activity.test.ts` (key allowlist + `nature`), `baseline.test.ts` (get_transactions source shape: one extra exhaustive read with the same `filters`; `searchComplete`), `tool-schemas.json` (tool description), `merchant-schema.test.ts` (contract registered as a pure read surface) |

## 6. Residual risks (what still depends on the historical repair)

- **R1. UI explorer "Debt" pill** (`QuickFlowPills` → `transaction-query-core` WHERE `flowType IN (DEBT_PAYMENT)`).
  - Until the repair runs, the 16 Production rows still appear under "Debt" and not under "Transfer".
  - A keyset-paged WHERE cannot express a cross-row verdict, and post-filtering pages would break the count-equals-list guarantee.
  - Their row label already reads "Internal transfer" (`describeRowNature`, maturity rung). **Depends on the repair.**
- **R2. Stored category "Payment"** in exports and UI category filters for the same rows. The drawer and the AI already relabel it. **Depends on the repair.**
- **R3. `describeRowNature` rung 4.**
  - A provider `DEBT_PAYMENT` row with **no** maturity and no attestation still labels "Debt payment" in the UI and CSV.
  - The money totals already refuse it. Changing UI labels needs account types in those components and is out of this PR's scope.
  - The audited Production rows all carry a maturity, so they are not affected.
- **R4. Assembler user overrides.** The AI assembler does not select `categorySource`, so a human "Payment" on a savings-paired row is not counted as a transfer there. That matches the money layer, which also ignores it.
- **R5. Materiality-driven same-day regeneration** for Spaces whose 7-day window holds a mislabelled row (§4.3). This is ordinary change detection, and limited to today.
- **R6. Exhaustive read cost.** `get_transactions` flow `transfers` / `card_payments` now reads the window to exhaustion (bounded by the 5,000-row ceiling, which is reported as incomplete when hit).
