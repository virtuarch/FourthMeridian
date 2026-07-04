> **CHECKLIST ONLY — no code, schema, or migration changes were made to produce this document.** Implementation is not authorized by this file. Governing design: `docs/initiatives/flowtype/P5_READ_CUTOVER_INVESTIGATION.md` (Slice 2). Prior: Slice 0 (import writes) + Slice 1 (read plumbing) complete — `Transaction` DTO now carries `flowType`/`flowDirection`.

# FlowType P5 Slice 2 — Banking & Space Summary Totals (Implementation Checklist)

**Date:** 2026-07-04
**Goal:** compute the two summary chips ("Spend" / "In") on the Banking page and the Space Transactions panel from `flowType` instead of category+sign — fixing the income-inflation bug — while leaving layout, labels, filters, and the transaction list byte-identical.
**Status:** Checklist prepared — awaiting approval. Stop-after-checklist per instruction.

**Surfaces (only these two):** `components/dashboard/BankingClient.tsx`, `components/dashboard/widgets/SpaceTransactionsPanel.tsx`.

---

## 1. Current logic (investigation #1)

Both surfaces compute two client-side totals over the already-filtered rows, then render two conditional chips.

**BankingClient.tsx**
```ts
// :162-164
const totalSpend  = filteredTxs
  .filter((t) => t.amount < 0 && t.category !== "Payment" && t.category !== "Transfer")
  .reduce((s, t) => s + Math.abs(t.amount), 0);
// :165  ← the bug: sums EVERY positive row
const totalCredit = filteredTxs.filter((t) => t.amount > 0).reduce((s, t) => s + t.amount, 0);
```
Display `:415-422`: `Spend: -{totalSpend}` (negative color) / `In: +{totalCredit}` (positive color), each shown only when `> 0`.

**SpaceTransactionsPanel.tsx**
```ts
// :142-144  (identical to totalSpend above)
const totalSpend = filtered.filter((t) => t.amount < 0 && t.category !== "Payment" && t.category !== "Transfer").reduce((s, t) => s + Math.abs(t.amount), 0);
// :145-147  ← same bug
const totalIn    = filtered.filter((t) => t.amount > 0).reduce((s, t) => s + t.amount, 0);
```
Display `:305-314`: same two chips.

**The bug:** "In"/`totalCredit`/`totalIn` sums *all* positive rows, so transfers-in, refunds, debt-payment credits, and investment-sale proceeds all inflate "money in."

**Note:** these surfaces only ever see the 11 banking categories — `lib/data/transactions.ts` filters `category ∈ BANKING_CATEGORIES` (excludes `Buy/Sell/Dividend/Split/Fee`). So **investment-security rows and `Fee`-category rows never reach here** (relevant to #4/#5 below).

---

## 2–6. How each flowType maps to the two chips

Deciding what "Spend" and "In" mean on these glance chips (there are only two — no separate cost/transfer/refund chip; layout must be preserved).

| flowType | Chip effect | Rationale |
|---|---|---|
| `SPENDING` | **+Spend** | consumption (outflow) |
| `FEE` | **+Spend** | a real money-out cost; current logic already counts negative `Fee`-ish rows as spend (#5: count as spending here, no separate chip) |
| `INTEREST` | **+Spend** | interest *charged* is a money-out cost; matches current behavior (negative Interest rows already counted as spend) (#5) |
| `REFUND` | **−Spend (nets)** | reverses spending; **not** income (#3: reduce spend, don't show separately — a separate chip would change layout) |
| `INCOME` | **+In** | earnings — the only thing "In" should show. Interest *earned* classifies as `INCOME`, so it counts here (#4) |
| `TRANSFER` | **excluded from both** | internal/capital movement (#6) |
| `DEBT_PAYMENT` | **excluded from both** | liability reduction, not spend/income (#6) |
| `INVESTMENT` | **excluded from both** | asset conversion; funding a brokerage is not spend (#6) |
| `ADJUSTMENT` / `UNKNOWN` | **excluded from both** | non-economic / unclassified — never guessed |

- **#3 Refunds:** reduce Spend (net), not shown as "In". Layout-preserving (no third chip).
- **#4 Interest/dividends as income:** interest *earned* (`flowType=INCOME`) counts in "In"; dividends never reach these surfaces (filtered out upstream), so no effect.
- **#5 Fees:** count toward Spend (money-out cost); no separate bucket on these chips.
- **#6 Transfers/debt/investments:** excluded from both — this is the core bug fix for "In".

---

## 7. Exact old → new formulas

Applied **identically** to both files (variable names preserved so the JSX is untouched). Define a small local const at the top of each component (no shared module — that would be a refactor, out of scope):

```ts
const COST_FLOWS = new Set(["SPENDING", "FEE", "INTEREST"]);
```

**Spend (was `totalSpend`):**
```ts
// OLD: amount < 0 && category not Payment/Transfer
const grossSpend = filtered
  .filter((t) => t.flowType != null && COST_FLOWS.has(t.flowType))
  .reduce((s, t) => s + Math.abs(t.amount), 0);
const refunds = filtered
  .filter((t) => t.flowType === "REFUND")
  .reduce((s, t) => s + Math.abs(t.amount), 0);
const totalSpend = Math.max(0, grossSpend - refunds);   // clamp: refunds never drive Spend negative
```

**In (was `totalCredit` / `totalIn`):**
```ts
// OLD: t.amount > 0  (all positives → the bug)
const totalCredit /* or totalIn */ = filtered
  .filter((t) => t.flowType === "INCOME")
  .reduce((s, t) => s + Math.abs(t.amount), 0);
```

**Null-tolerance:** Slice 0 + the P4 backfill make `flowType` a non-null invariant, so nulls should not occur. Defensively, a null-`flowType` row matches no branch above and thus contributes to **neither** total (conservative: a stray null under-counts by that row rather than mis-counting). No legacy category fallback is reintroduced (keeps the slice minimal and the cutover clean). *(If belt-and-suspenders is wanted, a per-row legacy fallback is possible but re-adds category logic — not recommended.)*

---

## 8. Behavior changes users will see

- **"In" drops** on any account/space that has transfers-in, refunds, debt-payment credits, or investment proceeds — it now shows **only real income**. This is the headline correctness fix (previously inflated).
- **"Spend" may drop slightly:** refunds now net against it (previously they inflated "In" and left Spend untouched), and any investment cash-out leg previously miscounted as spend is now excluded.
- **"Spend" is unchanged** for an account with only ordinary purchases (SPENDING/FEE/INTEREST outflows, no refunds).
- **Banking and the Space panel now agree** for the same scope (both migrated together).
- **No layout/label/color/filter change** — only the two numbers move.

---

## 9. Risks

- **R1 — "money in" looks smaller.** Users used to the inflated figure may read the drop as "missing money." *Mitigation:* it is the correct number (the P5 investigation predicted this); no copy change in scope, but flag for release notes.
- **R2 — two duplicated implementations.** Both files must change **identically** or Banking and the Space panel will disagree. *Mitigation:* apply the exact same formula; a shared helper is deliberately avoided (refactor out of scope).
- **R3 — Spend-clamp masks a refund-heavy window.** If refunds > gross spend in the filter, Spend shows 0. *Mitigation:* clamp is intentional (negative "Spend" is nonsensical on a chip); rare; documented.
- **R4 — FEE/INTEREST-in-Spend is a judgment call.** If the team later wants Spend = pure `SPENDING`, that changes the number again. *Mitigation:* decision recorded here (§2); chosen to match current behavior.
- **R5 — null `flowType`.** Should not occur post-invariant; if it does, excluded → minor under-count. *Mitigation:* the Slice-0 invariant; the P4 dry-run confirms 0 unclassified.
- **R6 — multi-currency (carried).** Totals still sum mixed currencies; **unchanged** by this slice. MC1 territory.

---

## 10. Rollback plan

- **Code-only, per file.** Revert the ~3 calculation lines in each component to the category+sign version. The JSX/labels/colors were never touched, so rollback is a localized revert with zero layout risk.
- **No data/schema involved.** Reverting restores the exact prior (buggy-but-known) totals. Blast radius: the two summary chips only.

---

## 11. Test / fixture plan (investigation #8)

The repo has **no React test runner** (client components aren't unit-tested; pure logic is tested via standalone `tsx`). Options, smallest first:
- **Fixture table (spec):** define a fixture transaction array covering every flowType with hand-computed expected `Spend`/`In`, embedded in this checklist / a scratch script, to validate the formula by eye and in-browser. Example rows:
  - `SPENDING -50`, `FEE -5`, `INTEREST -3` → gross spend 58
  - `REFUND +10` → Spend = 48; not in "In"
  - `INCOME +200` → In = 200
  - `TRANSFER +500`, `DEBT_PAYMENT +300`, `INVESTMENT +1000` → **excluded from both** (old "In" would have shown 2010; new shows 200)
- **No new component test / no refactor** to make it unit-testable (would exceed "smallest"). If a pure test is desired later, the formula could move to a tiny helper — a *future* slice, not this one.
- **Regression:** P1–P4 pure suites, KD-17/KD-18/output-validator remain green (untouched — no AI/assembler/data change; Slice 1 DTO already merged).

---

## 12. Manual validation checklist (investigation #9)

- [ ] `npx tsc --noEmit` clean · `npm run lint` clean.
- [ ] **In-browser:** an account/space with a known **transfer-in** → "In" no longer includes it.
- [ ] A row that is a **refund** → "Spend" reduced by it; "In" unaffected.
- [ ] An account with **only purchases** → "Spend" matches the pre-Slice-2 figure (no regression).
- [ ] A **debt-payment credit** and an **investment proceed** → excluded from "In".
- [ ] **Banking vs Space panel** for the same Space show **identical** Spend/In.
- [ ] Layout, labels ("Spend"/"In"), colors, and the `> 0` conditional rendering are **visually unchanged**.
- [ ] Account/category/date/search **filters** still recompute totals correctly.
- [ ] Fixture (§11) matches on-screen numbers.

---

## 13. Smallest implementation plan

1. `components/dashboard/BankingClient.tsx`: add the `COST_FLOWS` const; replace `totalSpend` (`:162-164`) and `totalCredit` (`:165`) with the §7 formulas. **Do not touch** the JSX (`:415-422`), filters, list, or category dropdown.
2. `components/dashboard/widgets/SpaceTransactionsPanel.tsx`: same — replace `totalSpend` (`:142-144`) and `totalIn` (`:145-147`); JSX (`:305-314`) untouched.
3. Validate (§12).

**Blast radius:** the two summary chips on two surfaces; numbers change (correctly), nothing else. **Out of scope confirmed:** no AI assembler, Daily Brief, DebtClient/per-liability, serializer/prompt, schema, or import/Plaid changes.
