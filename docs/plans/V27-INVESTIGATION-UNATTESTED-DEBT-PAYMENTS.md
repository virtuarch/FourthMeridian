# Investigation — the 18 unattested Debt Payments

**READ-ONLY.** Nothing implemented, no doctrine changed, no data mutated.
**Probe:** `scripts/audit-unattested-debt-payments.ts`.
**Corpus:** `Chris' Space`, 2026-08-05. 119 carded rows, of which 18 ($34,500)
carry no structurally resolved counterparty.

---

## Verdict up front

**All 18 are bucket A.** B = 0, C = 0, D = 0.

Every one carries, from the canonical transfer authority:

```
transfer maturity      DEBT_PAYMENT
evidence level         TYPE_CERTAIN_ACCOUNT_AMBIGUOUS
destination evidence   TYPE = debt
```

The authority **proves the destination is a liability**. What it refuses to name
is *which* liability. That is a different — and much weaker — kind of ignorance
than "we don't know if this was a debt payment".

---

## The 18

| # | transaction id | event id | account · institution | amount | date | descriptor | pfcPrimary / pfcDetailed | match reason |
|---|---|---|---|---|---|---|---|---|
| 1 | `cmrrmeofj01pa7znwnmxzttba` | `cmsg0o6o403i7dxfcmky1wv63` | Rewards Checking ••0985 · Amex | −$4,500 | 2026-04-10 | Online Transfer / Payment: Debit | TRANSFER_OUT / TRANSFER_OUT_ACCOUNT_TRANSFER | NOT_MUTUALLY_UNIQUE |
| 2 | `cmrrmmzc7080u7znwm4t23xr9` | `cmsg0oe230c01dxfcs9pj9py9` | CHASE COLLEGE ••2058 · Chase | −$2,000 | 2025-12-24 | AMERICAN EXPRESS ACH PMT M3496 | LOAN_PAYMENTS / …CREDIT_CARD_PAYMENT | TYPE_CERTAIN_ACCOUNT_AMBIGUOUS |
| 3 | `cmrrmmzck080z7znwvoya5mvp` | `cmsg0oe250c05dxfcebszwndy` | CHASE COLLEGE · Chase | −$2,000 | 2025-12-24 | Payment to Chase card ending in 0202 | LOAN_PAYMENTS / …CREDIT_CARD_PAYMENT | NOT_MUTUALLY_UNIQUE |
| 4 | `cmrrmmzdj081h7znw34mcuxxf` | — | CHASE COLLEGE · Chase | −$2,000 | 2025-12-17 | Payment to Chase card ending in 0202 | LOAN_PAYMENTS / …CREDIT_CARD_PAYMENT | NOT_MUTUALLY_UNIQUE |
| 5 | `cmrrmmzda081c7znw9ob9w6w7` | — | CHASE COLLEGE · Chase | −$2,000 | 2025-12-17 | AMERICAN EXPRESS ACH PMT M0960 | LOAN_PAYMENTS / …CREDIT_CARD_PAYMENT | TYPE_CERTAIN_ACCOUNT_AMBIGUOUS |
| 6 | `cmrrmn1kk08k27znwq1s8uzi7` | — | CHASE COLLEGE · Chase | −$2,000 | 2025-04-25 | AMERICAN EXPRESS ACH PMT M4082 | LOAN_PAYMENTS / …CREDIT_CARD_PAYMENT | TYPE_CERTAIN_ACCOUNT_AMBIGUOUS |
| 7 | `cmrrmn1ku08k77znwsjtv5ea8` | — | CHASE COLLEGE · Chase | −$2,000 | 2025-04-25 | Payment to Chase card ending in 0202 | LOAN_PAYMENTS / …CREDIT_CARD_PAYMENT | NOT_MUTUALLY_UNIQUE |
| 8 | `cmrrmn5jq096m7znwrw838ama` | — | CHASE COLLEGE · Chase | −$2,000 | 2024-08-09 | AMERICAN EXPRESS ACH PMT M8716 | LOAN_PAYMENTS / …CREDIT_CARD_PAYMENT | TYPE_CERTAIN_ACCOUNT_AMBIGUOUS |
| 9 | `cmrrmn5ka096r7znwvlkj3lxn` | — | CHASE COLLEGE · Chase | −$2,000 | 2024-08-09 | Payment to Chase card ending in 0202 | LOAN_PAYMENTS / …CREDIT_CARD_PAYMENT | NOT_MUTUALLY_UNIQUE |
| 10 | `cmrrmn5kv096w7znw4vaykf7g` | — | CHASE COLLEGE · Chase | −$2,000 | 2024-08-09 | AMERICAN EXPRESS ACH PMT M2178 | LOAN_PAYMENTS / …CREDIT_CARD_PAYMENT | TYPE_CERTAIN_ACCOUNT_AMBIGUOUS |
| 11 | `cmrrmn5q809807znwa1hxlz3l` | — | CHASE COLLEGE · Chase | −$2,000 | 2024-07-25 | Payment to Chase card ending in 0202 | LOAN_PAYMENTS / …CREDIT_CARD_PAYMENT | NOT_MUTUALLY_UNIQUE |
| 12 | `cmrrmn5pw097y7znwwiruy3gx` | — | CHASE COLLEGE · Chase | −$2,000 | 2024-07-25 | AMERICAN EXPRESS ACH PMT M4776 | LOAN_PAYMENTS / …CREDIT_CARD_PAYMENT | TYPE_CERTAIN_ACCOUNT_AMBIGUOUS |
| 13 | `cmrrmeoib01pm7znwav7h4w13` | — | Rewards Checking · Amex | −$1,500 | 2025-12-01 | Online Transfer / Payment: Debit | TRANSFER_OUT / TRANSFER_OUT_ACCOUNT_TRANSFER | NOT_MUTUALLY_UNIQUE |
| 14 | `cmrrmmzoj084p7znw264pj855` | — | CHASE COLLEGE · Chase | −$1,500 | 2025-10-10 | Payment to Chase card ending in 0202 | LOAN_PAYMENTS / …CREDIT_CARD_PAYMENT | NOT_MUTUALLY_UNIQUE |
| 15 | `cmrrmmznj084k7znw0ypub7cv` | — | CHASE COLLEGE · Chase | −$1,500 | 2025-10-10 | AMERICAN EXPRESS ACH PMT M2618 | LOAN_PAYMENTS / …CREDIT_CARD_PAYMENT | TYPE_CERTAIN_ACCOUNT_AMBIGUOUS |
| 16 | `cmrrmmzt408727znwcucs5gzw` | — | CHASE COLLEGE · Chase | −$1,500 | 2025-09-10 | Payment to Chase card ending in 0202 | LOAN_PAYMENTS / …CREDIT_CARD_PAYMENT | NOT_MUTUALLY_UNIQUE |
| 17 | `cmrrmmzsu086x7znwx5ug1uvr` | — | CHASE COLLEGE · Chase | −$1,500 | 2025-09-10 | AMERICAN EXPRESS ACH PMT M8044 | LOAN_PAYMENTS / …CREDIT_CARD_PAYMENT | TYPE_CERTAIN_ACCOUNT_AMBIGUOUS |
| 18 | `cmrrmeoeq01p47znw3c5kat5v` | — | Rewards Checking · Amex | −$500 | 2026-05-11 | Online Transfer / Payment: Debit | TRANSFER_OUT / TRANSFER_OUT_ACCOUNT_TRANSFER | NOT_MUTUALLY_UNIQUE |

All 18: maturity `DEBT_PAYMENT`, evidence `TYPE_CERTAIN_ACCOUNT_AMBIGUOUS`,
destination `TYPE = debt`, one live transaction per event. Full per-row output
(including all event ids) in the probe.

## Why the counterparty is unresolved — proven, not assumed

**15 of 18 are the same structural collision.** You pay two cards on the same day
for the same amount:

```
2025-12-24   CHASE COLLEGE  −$2,000  ×2   (one Amex, one Chase)
2025-12-24   destinations   +$2,000  ×2   (CREDIT CARD, Platinum Card®)
```
…repeated on 2025-12-17, 2025-10-10, 2025-09-10, 2025-04-25, 2024-08-09
(3 sources × 2 destinations) and 2024-07-25.

Either source could be either destination. **No evidence that exists
distinguishes them.** Both candidates are liabilities, so the destination TYPE is
certain and the destination ACCOUNT is unknowable — the authority's
`TYPE_CERTAIN_ACCOUNT_AMBIGUOUS` rung, exactly as documented.

**The 3 Rewards Checking rows** are the same shape from the other side. For
#1 (−$4,500, 2026-04-10) the Platinum Card's +$4,500 leg has **three** rival
sources in window:

| candidate source | account | descriptor |
|---|---|---|
| `cmrrmeofj01pa7znwnmxzttba` | Rewards Checking | Online Transfer / Payment: Debit |
| `cmrrmeop601qk7znwr6f67xfw` | High Yield Savings | Requested transfer to AMEX checking account |
| `cmrrmmmr007047znwg8ya1iwc` | CHASE SAVINGS | Online Transfer to CHK …2058 |

⚠️ **A human could disambiguate these by reading the descriptors — and that is
precisely the move that caused the $4,000 defect.** "Requested transfer to AMEX
checking account" *looks* decisive, but "AMERICANEXPRESS TRANSFER" looked
decisive too, and it was a savings deposit. The authority's refusal is correct.

## Why DEBT_PAYMENT is still asserted

Two independent paths, and they do not overlap the way the earlier summary
implied:

- **15 rows** — provider category `LOAN_PAYMENTS_CREDIT_CARD_PAYMENT` **and** the
  authority's destination-type proof.
- **3 rows** (Rewards Checking) — provider category is `TRANSFER_OUT`, and the
  flow was classified via `ACCOUNT_TYPE_CONTEXT`, **not** the provider. For these
  the debt-payment claim rests **entirely on the authority**, not on the provider
  at all.

So "supported only by provider evidence" (bucket B) is empty in both directions:
no row leans on the provider alone, and 3 rows do not lean on it whatsoever.

## Buckets

| Bucket | Rows | Amount |
|---|---|---|
| **A** — structurally proven debt payment, destination account unknowable | **18** | **$34,500.00** |
| B — supported only by provider evidence | 0 | $0.00 |
| C — ambiguous, should not remain DEBT_PAYMENT | 0 | $0.00 |
| D — genuine bug | 0 | $0.00 |

---

## What each rule would count

| Rule | Rows | Total |
|---|---|---|
| 1. structural destination certainty only | 101 | $207,092.37 |
| 2. structural **OR** authority attestation | **119** | **$241,592.37** |
| 3. current rule (count unless contradicted) | 119 | $241,592.37 |

## Recommendation — rule 2, stated precisely

> **A row enters Debt Payments when the destination is an owned liability
> ACCOUNT, or when the canonical transfer authority attests the destination
> TYPE is a liability. Absence of contradiction is not attestation.**

Rules 2 and 3 return **identical numbers on this corpus** — because every carded
row happens to carry positive attestation from one authority or the other. They
are not the same rule, and the difference is the one that matters:

- **Rule 3 counts on silence.** A row whose provider category says card-payment
  and whose destination the authority cannot resolve *at all*
  (`TYPE_AMBIGUOUS`, `UNRESOLVED_TRANSFER`, or no candidates in window) is
  counted today, because nothing contradicts it. **That is the same failure mode
  as the $4,000 defect** — which was caught only by the accident that its
  destination *was* resolvable. A sparser window, or a new institution, and the
  next one is invisible.
- **Rule 2 counts on evidence.** It admits every one of the 18, because the
  authority genuinely proves their destination type, and refuses the silent case.

**Cost of adopting it today: zero rows, zero dollars, one predicate.** It is the
smallest rule that closes the hole, and it fabricates nothing: it never invents a
counterparty, it only declines to assume one.

## Why rule 1 would reduce correctness

It would drop **18 genuine debt payments, $34,500 — 14.3% of the total** —
reporting $207,092.37 for a household that actually paid $241,592.37.

The reason those 18 lack a counterparty is not weak evidence. It is that the user
**paid two cards on the same day for the same amount**, which is ordinary
behaviour and permanently unresolvable. Rule 1 therefore penalises a real-world
pattern that has nothing to do with truth: pay one card a month and your total is
right; pay two on the same day and $34,500 silently disappears.

It also inverts the arc's own doctrine. `ACCOUNT_CERTAIN_LEG_AMBIGUOUS` exists in
this repository precisely because a gate applied at LEG level to a claim made at
ACCOUNT level discarded 75 legs and $103,000 of true movement. Requiring account
certainty for a claim that is only about the destination *type* is the same
mistake one rung further down — and the header of `DestinationEvidenceLevel`
already says so: *"the type names the movement; the account does NOT."*

**Debt Payments asks "how much did I pay toward debt", not "which card".** The
per-creditor breakdown asks the second question, and it correctly declines to
name an account it cannot prove. Those are two questions, and only one of them
needs the account.

---

## Not recommended, for the record

- **Descriptor disambiguation** (reading "ending in 0202") — the exact error class
  this arc removed. Would resolve most of the 18 and would eventually be wrong in
  the same way the $4,000 was.
- **Proportional splitting** across candidate liabilities — fabricates a
  counterparty distribution no evidence supports.
- **Widening the match window** — would create more rivals, not fewer.

## One residual worth naming

The Debt Payments card's **per-creditor breakdown** groups by normalized
descriptor, so these 18 land under headings like "American Express Ach …" and
"Payment To Chase Card". Those headings read as creditors but are descriptor
labels — the accounts are, by this investigation, unknowable. The card total is
right; the group heading claims slightly more precision than the evidence carries.
Worth a disclosure line rather than a rule change, and out of scope here.
