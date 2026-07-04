> **INVESTIGATION ONLY — no code, schema, migration, or refactor was performed.** Governing design: `docs/investigations/FLOWTYPE_FOUNDATION_INVESTIGATION.md`. Prior phases P1–P4 complete; DB fully populated with FlowType (0 UNKNOWN, 99.8% legacy agreement, 9 expected Dividend→INCOME improvements).

# FlowType P5 — Read Cutover (Investigation)

**Date:** 2026-07-04
**Branch:** `feature/v2.5-spaces-completion`
**Question:** What is the *smallest* safe read cutover from category+sign heuristics to `Transaction.flowType` / `flowDirection`?
**Status:** Investigation complete — plan + go/no-go only. No implementation.

---

## 1. Executive summary

Transaction semantics are re-derived in **~8 root sites** from `category` + `amount` sign, and consumed by a larger set of downstream readers that never touch raw category. The database now carries the canonical answer (`flowType`, `flowDirection`) on every row, so the cutover is mostly mechanical — **except** three things that make it *not* a blind find-replace:

1. **A write gap:** the CSV/manual import path (`app/api/accounts/[id]/import/route.ts`) still creates transactions **without** `flowType` (P3B wired Plaid sync only). Until that's closed, new imported rows are null-`flowType`, so no reader may trust the column as a non-null invariant. **This is the #1 prerequisite.**
2. **A behavior change** at the AI assembler: migrating its partition to `flowType` *intentionally* changes numbers (the 9 dividends move into income; `Fee` becomes reachable; refunds net structurally). This needs an explicit sign-off, not a silent swap.
3. **The income bug** in `BankingClient`/`SpaceTransactionsPanel` (`totalCredit` = sum of all positives) is *fixed* by the cutover — a user-visible correctness win that also changes displayed numbers.

**Recommendation: GO, strictly sequenced.** Do the write-completion prerequisite and additive read-plumbing first (pure, reversible), then the isolated dashboard bug-fixes, then the assembler cutover behind a behavior sign-off, then serializer/guardrail alignment, and finally — only once no reference remains — delete the legacy helpers as a separate gated slice (honoring "no opportunistic cleanup").

---

## 2. Legacy logic inventory (every derivation site)

**Root classifiers — derive flow semantics from `category` + sign:**

| # | Site | What it derives |
|---|---|---|
| L1 | `lib/ai/assemblers/transactions.ts:83` `BANKING_CATEGORIES` | query filter `category: { in: … }` (`:231,:928`) — which rows the AI sees |
| L2 | `…transactions.ts:98` `INCOME_CATEGORIES` = {Income, Interest} | income partition (`:300,:537,:763`) |
| L3 | `…transactions.ts:110` `MERCHANT_EXCLUDED_CATEGORIES` = {Income, Interest, Transfer, Payment} | merchant-rollup exclusion (`:459`) |
| L4 | `…transactions.ts:124` `SPENDING_CATEGORIES` = banking − excluded | drilldown default (`:929`) |
| L5 | `…transactions.ts:282-317` window partition | `incomeTotal/expenseTotal/debtPaymentTotal/transferTotal` + `byCategory` from category+sign |
| L6 | `…transactions.ts:749-767` monthly partition | same, per month |
| L7 | `lib/ai/intelligence/annotations.ts:755` `SPENDING_EXCLUDED` = {Income, Interest, Transfer, Payment} | expense-opportunity gate (`classifySpendingCategory`) |
| L8 | `lib/data/transactions.ts:48` `BANKING_CATEGORIES` | banking/debt/investment read split (`:71,:102,:133`) |
| L9 | `components/dashboard/BankingClient.tsx:163-165` | `totalSpend` (excl Payment/Transfer) + **`totalCredit` = Σ all positives (BUG)** |
| L10 | `components/dashboard/widgets/SpaceTransactionsPanel.tsx:143-147` | duplicate of L9 |
| L11 | `components/dashboard/DebtClient.tsx:430` | `totalDebtPaid` = Σ|amount| where `category==='Payment'` |
| L12 | `app/api/ai/chat/route.ts:415,686` `NON_SPENDING(_CATEGORY_SET)` = {Income, Interest, Transfer, Payment} | serialization + drilldown re-filter of `byCategory` |

**Duplication:** the set `{Income, Interest, Transfer, Payment}` is hand-written **four times** (L3, L7, L12×2), and `BANKING_CATEGORIES` **three times** (L1, L8, `SpaceTransactionsPanel:35`). "What is spending" has ~5 independent definitions — exactly the drift the initiative removes.

---

## 3. Complete impact map + A/B/C/D classification

Legend: **A** safe to migrate immediately · **B** small adapter · **C** behavior discussion · **D** leave unchanged.

### 3.1 AI
| Surface | Reads | Class | Notes |
|---|---|---|---|
| Transaction assembler `transactions.ts` (L1–L6) | category+sign | **C** | The semantic heart. Migrating changes numbers (dividends→income, `Fee` reachable, refunds net). Needs sign-off; drives all AI + Brief. |
| `annotations.ts` `SPENDING_EXCLUDED` gate (L7) | category | **B** | Gate → `flowType ∉ {SPENDING,REFUND}` (P1 harness proved parity over banking cats). Sequence *after* assembler. |
| `annotations.ts` discretionary/semi/fixed sub-classing (`:757-765`) | category | **D** | `flowType` does **not** encode discretionary-ness; this stays category-based. |
| Serializer `serializeContextBlock` (route.ts) | assembler output | **D** (auto-benefits) | Reads `byCategory`/totals; improves for free. Except the `NON_SPENDING` re-filter (L12) → **C**, tied to `byCategory` shape post-cutover. |
| KD-17 `checkSpendingCategoryInvariant` | assembler `byCategory`/`expenseTotal` | **B** | Keep the checked invariant; re-express the population as `flowType=SPENDING` (equal by construction). |
| KD-18 guardrail (`ATTRIBUTION_DISCLOSURE/RULE`) | prompt text | **C** | *Relax* the per-liability carve-out once the rollup exists (§6); keep the generalized disclosure for still-unbacked dimensions. |
| Output validator | reply figures (membership) | **D** | Flow-agnostic. Benefits indirectly; no migration for minimal cutover. |
| Prompts (advisor principles, debtPaymentTotal prose `:1023`) | prose | **D** | Copy references the assembler field name; unchanged. |

### 3.2 Dashboard
| Surface | Reads | Class | Notes |
|---|---|---|---|
| Banking `BankingClient` `totalSpend/totalCredit` (L9) | category+sign | **B** | Needs `getTransactions` to expose `flowType` (Slice 1). **Fixes the income bug.** |
| `SpaceTransactionsPanel` totals (L10) | category+sign | **B** | Same fix; migrate with Banking. |
| Category-filter dropdown (`SpaceTransactionsPanel:35,264`) | category list | **D** | UI filter over the merchant taxonomy; orthogonal to flow. |
| Credit/Debt `DebtClient` `totalDebtPaid` (L11) | category | **B** | → `flowType=DEBT_PAYMENT`; also the home of the new per-liability rollup (§6). |
| Investments `InvestmentsClient` (Buy/Sell/Dividend display) | investment category | **D** | Security-activity view via `getInvestmentTransactions`; `flowType` is parallel, not a replacement. (Dividend→INCOME lives in the *banking* income rollup, not here.) |
| Overview / NetWorth / Cash cards | account balances | **D** | Not transaction-flow readers. |
| Daily Brief `app/api/brief/route.ts:383` | `txn.incomeTotal/expenseTotal` | **D** (auto-benefits) | Reads assembler output; improves for free. |
| Row credit/debit tinting (`isCredit = amount>0`, many files) | sign | **D** | Presentational sign, not flow semantics. Leave. |

### 3.3 Spaces
| Surface | Reads | Class | Notes |
|---|---|---|---|
| Perspective Engine lenses (`debt.core`, `liquidity.core`) | **account balances** (`Math.abs(r.balance)`) | **D** | Confirmed: read no transaction category/sign. Never migrate. |
| Timeline (`timeline-types.ts`) | event `amount` for display | **D** | No transaction-flow derivation. |
| Analytics / future rollups | (n/a today) | — | Build new rollups on `flowType` directly (don't add legacy logic). |

### 3.4 API / Admin / Imports / Reports / Exports / Search
| Surface | Reads | Class | Notes |
|---|---|---|---|
| `app/api/spaces/[id]/transactions` | `getTransactions` passthrough | **D** | Inherits Slice 1 (flowType exposed additively). |
| `app/api/accounts/[id]/transactions` | raw row passthrough (`:71-72`) | **D** | Returns raw fields; optionally expose flowType additively later. |
| `app/api/accounts/[id]/import` **(write)** | — | **BLOCKER** | Creates rows **without** `flowType` (§8). Must be closed before readers trust the column. |
| Admin (`app/api/admin/**`) | security/plaid diagnostics | **D** | No transaction flow. |
| Reports / Exports / Search | **none found** | **D** | No dedicated report/export/transaction-search surface exists today. |

---

## 4. Readers that should NOT migrate (and why)

- **Perspective Engine, Timeline, Overview/NetWorth/Cash, Investments tab** — they read *balances* or *security activity*, not banking flow. Migrating would be a category error.
- **Output validator** — membership-based by design; flow-agnostic.
- **Row credit/debit color tinting** — cosmetic sign, not economics.
- **`annotations` discretionary/fixed sub-classing** — `flowType` doesn't carry discretionary-ness; keep category-based.
- **`lib/data/transactions.ts` banking/investment query split (L8)** — this is *list membership* (which rows appear in the Banking tab), a display decision orthogonal to the totals cutover. Leave for the minimal P5; revisit only if a deliberate "what shows in Banking" change is wanted (a `flowType`-based split would change which rows appear — a **C** discussion, out of minimal scope).
- **Category-filter dropdowns** — UI over the merchant taxonomy.

---

## 5. Per-area audit summary (objective 5)

- **AI:** assembler = the one **C**; annotations gate = **B**; serializer/validator/prompts = **D**/auto-benefit; KD-17 invariant kept (re-expressed); KD-18 guardrail relaxed only for the now-backed debt dimension.
- **Dashboard:** Banking/Space totals + Debt = **B** (and the income bug fix); Investments/Overview/Brief = **D**/auto-benefit.
- **Spaces:** Perspectives/Timeline = **D**; new analytics build on `flowType` directly.
- **API/Admin/Imports/Reports/Exports/Search:** all **D** except the **import write blocker**.

---

## 6. Liability rollups — replacing the debt-payment heuristics (objective 6)

**Old heuristic (three copies):** `category === 'Payment' [&& amount < 0]` → `Σ|amount|`, a **source-side scalar with no attribution** — appears in the assembler (`debtPaymentTotal`, L5/L6), `DebtClient.totalDebtPaid` (L11), and is the reason **KD-18** had to add a guardrail (per-card attribution was impossible).

**New model with `flowType`:**
- **`debtPaymentTotal`** = `Σ|amount| WHERE flowType = DEBT_PAYMENT AND amount < 0` — no string matching.
- **Per-liability rollup (the KD-18 capability, finally):** group **destination-side** legs — `flowType = DEBT_PAYMENT` rows that sit on a debt account (`financialAccount.type = 'debt'`) — **by `financialAccountId`**, using the `[financialAccountId, flowType, date]` index built in P3A. This answers "how much was paid toward each card," deterministically, from data that already existed on the card's own account.

**What becomes simpler:** one predicate replaces three hand-written category filters; the per-liability breakdown becomes a single `GROUP BY` that had no prior implementation.

**What disappears:** the `category==='Payment'` heuristics (L11 + the Payment branches in L5/L6); the KD-18 **per-liability** guardrail carve-out (`ATTRIBUTION_DISCLOSURE`/`ATTRIBUTION_RULE` for debt payments) — because the data now exists. **What stays:** the generalized attribution disclosure for dimensions still without a rollup (per-card *interest*, source-side transfer attribution), and `counterpartyAccountId` remains null until a later pairing slice, so source↔destination reconciliation is still not claimed.

---

## 7. Duplicated semantic logic deletable *after* cutover (not now)

Once every consumer reads `flowType`, these become dead and removable in the final cleanup slice: `INCOME_CATEGORIES` (L2), `MERCHANT_EXCLUDED_CATEGORIES` (L3), `SPENDING_CATEGORIES` (L4), `SPENDING_EXCLUDED` (L7), both `NON_SPENDING` sets (L12), and the `category==='Payment'/'Transfer'` filters (L9–L11). `BANKING_CATEGORIES` (L1/L8) is *list-membership* — keep unless the membership question is deliberately migrated (§4). Per the rules, **no deletion happens during migration slices** — it is a separate, final, gated slice.

---

## 8. Blockers before removing `SPENDING_EXCLUDED` et al.

1. **Write completion (hard blocker).** CSV/manual import (`app/api/accounts/[id]/import/route.ts:324,358`) and any future non-Plaid writer must populate `flowType`, or fresh rows are null and every migrated reader miscounts. Resolution: a "P3B-for-imports" slice mirroring the sync write path (via `buildFlowInputFromRow` + `buildFlowWriteFields`). *(Seed data and reconcile/rollback updates don't create economic rows needing flow, but confirm during the slice.)*
2. **All consumers migrated.** SPENDING_EXCLUDED can't be deleted while `annotations` (or anything) still references it.
3. **Null-tolerance during transition.** Between write-completion and full backfill coverage, readers must either tolerate `flowType = null` (fallback to legacy) **or** the non-null invariant must hold. Recommended: establish the invariant (writes + backfill) first, then migrate readers, so no read-time fallback classifier is needed.
4. **Behavior sign-off.** The dividend→income and `Fee`-reachability changes (P4 audit R3) must be accepted before the assembler cutover.

---

## 9. Implementation plan — smallest reviewable slices

Ordered low-risk → high-risk. Each is independently shippable and reversible.

**Slice 0 — Write completion (prerequisite).**
- *Files:* `app/api/accounts/[id]/import/route.ts` (+ possibly a tiny CSV input builder beside `buildFlowInputFromRow`).
- *Blast:* new imported rows gain `flowType`; nothing reads it yet.
- *Rollback:* revert the write hunk; rows go back to null flow (harmless pre-read-cutover).
- *Validation:* import a CSV; assert new rows have non-null `flowType`; re-run P4 dry-run → 0 remaining.
- *Regression:* import pipeline tests; P1–P4 suites.

**Slice 1 — Additive read plumbing.**
- *Files:* `lib/data/transactions.ts` (return `flowType`/`flowDirection`), `@/types` Transaction DTO (+ optional fields). No consumer logic changes.
- *Blast:* fields available; every existing reader ignores them.
- *Rollback:* revert; additive-only.
- *Validation:* `tsc`; existing dashboards render identically.
- *Regression:* build + existing UI smoke.

**Slice 2 — Banking/Space income-bug fix.**
- *Files:* `BankingClient.tsx`, `widgets/SpaceTransactionsPanel.tsx`.
- *Change:* `totalCredit` = Σ(`flowType=INCOME`) with `REFUND` netting against `SPENDING`; `totalSpend` = Σ(`flowType=SPENDING`).
- *Blast:* two dashboards; **displayed income/credit numbers change (correctly)**.
- *Rollback:* revert to category+sign.
- *Validation:* totals reconcile with the assembler; spot-check a known account.
- *Regression:* none automated (UI); manual visual + a fixture.

**Slice 3 — Debt view + per-liability rollup (KD-18 capability).**
- *Files:* `DebtClient.tsx` (+ a data helper for the grouped query).
- *Change:* `totalDebtPaid` → `flowType=DEBT_PAYMENT`; add per-liability rollup (destination-side, grouped by `financialAccountId`).
- *Blast:* Credit/Debt surface; new per-card breakdown appears.
- *Rollback:* revert.
- *Validation:* per-card sums reconcile to `debtPaymentTotal` within timing tolerance (§6 caveat); the historical 100%/0% fabrication case now deterministic.
- *Regression:* debt lens tests; KD-18 suite.

**Slice 4 — AI assembler cutover (the C slice).**
- *Files:* `lib/ai/assemblers/transactions.ts` (L1–L6), `checkSpendingCategoryInvariant` population.
- *Change:* partition by `flowType`/`flowDirection`; `expenseTotal := Σ|amount| WHERE flowType=SPENDING`; income/transfer/debt likewise; merchant/income rollups by `flowType`.
- *Blast:* **all AI numbers + Daily Brief**; dividends now in income, `Fee` reachable, refunds net.
- *Rollback:* revert (single file); reverts every downstream number.
- *Validation:* before/after context diff on a snapshot Space; the 9 dividends are the expected income delta; KD-17 invariant still green (equal by construction).
- *Regression:* `transactions.kd17.test.ts`, assembler tests, output-validator suite, a full context-assembly snapshot.
- *Gate:* behavior sign-off (§8.4) required before merge.

**Slice 5 — `annotations` gate.**
- *Files:* `lib/ai/intelligence/annotations.ts` (L7 gate only; keep sub-classing).
- *Blast:* expense-opportunity selection; parity-proven over banking cats.
- *Rollback:* revert one predicate.
- *Validation:* opportunity output unchanged on fixtures.
- *Regression:* annotations/assessment tests.

**Slice 6 — Serializer/guardrail alignment.**
- *Files:* `app/api/ai/chat/route.ts` (L12 `NON_SPENDING` alignment; relax KD-18 per-liability carve-out).
- *Blast:* prompt text + serialization; per-card debt answers now permitted (backed by Slice 3 rollup).
- *Rollback:* revert prompt/serializer hunks.
- *Validation:* prompt snapshot; a per-card question returns the real breakdown, not a disclosure.
- *Regression:* `attribution-guardrail.kd18.test.ts` (update expectations), output-validator.

**Slice 7 — Legacy cleanup (final, gated, no logic change).**
- *Files:* remove now-unreferenced `INCOME_CATEGORIES`/`MERCHANT_EXCLUDED_CATEGORIES`/`SPENDING_CATEGORIES`/`SPENDING_EXCLUDED`/`NON_SPENDING`.
- *Blast:* dead-code removal only.
- *Rollback:* revert.
- *Validation:* `grep` proves zero references before deletion; `tsc`/lint/build green.
- *Regression:* full suite.

---

## 10. Risks

- **R1 — Assembler number changes (Slice 4).** Dividends→income, `Fee`, refund-netting are visible. *Mitigation:* behavior diff on a snapshot; the P4 diagnostic already enumerated the 9; sign-off gate.
- **R2 — Import write gap (Slice 0).** Skipping it leaves fresh imports null. *Mitigation:* Slice 0 is the ordered prerequisite; readers migrate only after the non-null invariant holds.
- **R3 — KD-17 invariant.** Must stay checked. *Mitigation:* re-express population as `flowType=SPENDING` (equal by construction); keep the test.
- **R4 — Multi-currency (carried from P4 audit R2).** Totals still sum mixed currencies; **not worsened** by P5, but Slice 2/4 make totals more prominent. *Mitigation:* MC1 initiative; note, do not fix here.
- **R5 — Debt source/destination reconciliation (Slice 3).** Per-card (destination) and `debtPaymentTotal` (source) differ by timing/external payments. *Mitigation:* present destination-side as canonical per-card; never claim they reconcile exactly; `counterpartyAccountId` stays null.
- **R6 — Dashboard totals are client-computed.** Bug fix changes on-screen numbers (Slice 2). *Mitigation:* isolated slice, reversible, fixture-checked.

---

## 11. Final recommendation

**GO for P5 — sequenced, not monolithic.** The database is ready (0 UNKNOWN, backfill idempotent). The smallest *safe* cutover is: **Slice 0 (write completion) + Slice 1 (additive plumbing) first** — both pure, additive, reversible, and consumer-invisible — which establishes the "every row has `flowType`" invariant the rest depends on. Then land the isolated dashboard fixes (Slices 2–3, including the KD-18 per-liability win), then the assembler cutover (Slice 4) **behind an explicit behavior sign-off**, then serializer/guardrail alignment (Slices 5–6). **Do not delete any legacy helper until Slice 7**, gated on a zero-reference grep — honoring "no opportunistic cleanup."

Blocker to clear before *any* reader migrates: **Slice 0**. Everything else is low-risk until Slice 4, which is the single surface needing a numbers sign-off. No schema, migration, or refactor is required by this plan beyond the additive read plumbing.
