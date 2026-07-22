# ADR-002 — One authority per financial truth; consumers project, never re-decide

**Status:** accepted (Phase 2 convergence) · **Doctrine:** [FINANCIAL_TRUTH_SPINE](../architecture/FINANCIAL_TRUTH_SPINE.md)

## Context

Fourth Meridian answers the same financial question from many surfaces — a widget, an
AI chat reply, a CSV export, the Daily Brief. Each asks "what did I spend?", "what
moved?", "what is this worth?". Early in the product's life, several of these surfaces
computed their own answer: a widget had its own cost set, an assembler had its own
refund clamp, an export re-summed rows.

## Problem

When many surfaces each decide a financial truth locally, they **drift**. The same
month's "spending" reads differently in the dashboard, the chat, and the export — and
none is wrong-by-a-bug; they are wrong-by-design, because there is no single
definition. This is the most expensive class of defect: silent, plausible, and
everywhere.

## Decision

**Every financial truth has exactly one authority, forever. Consumers project it and
never re-decide it.** Every number flows through one funnel — Providers → canonical
identity/evidence → canonical semantics → canonical facts/projections → consumers —
and there is exactly **one aggregate transaction fold: `DayFacts`.** A consumer that
re-classifies a row, re-folds a total, re-converts a currency, or re-ranks in native
balances is a **defect**, not a feature. The 14 authorities are enumerated in the
Financial Truth Spine; the behavioral contract is frozen by the Doctrine Oracle test.

## Alternatives considered

- **LLM-over-raw-data** (pour transactions into a prompt, let the model compute).
  Rejected as the central failure mode the platform refuses: figures would drift
  between answers and no figure would have a home. AI is a **consumer** of computed
  facts, never an authority (see [systems/ai-foundation](../systems/ai-foundation.md)).
- **A shared "utils" library of calculation helpers.** Rejected: helpers do not
  prevent a second call site from computing the truth a different way. The fix is *one
  authority module per truth*, not reusable arithmetic.
- **Category allow-lists for transaction population.** Rejected: a taxonomy
  allow-list silently drops rows (an unmapped category disappears from spend). The
  population gate is `flowType != INVESTMENT`, and `UNKNOWN`/`ADJUSTMENT`/`null` rows
  stay in the population for review with no economic bucket.
- **Deriving balance truth from period flows** (e.g. "unpaid balance = charges −
  payments"). Rejected: money is fungible; charges predate the window, payments settle
  earlier statements, interest/fees move the balance with no flow. Flow truth and
  balance truth are separate authorities that must never be conflated.

## Consequences

- Adding a new financial kind/tier/rule means extending its *single* authority, never
  re-inlining it at a consumer. "Add a truth once."
- Facts hold numbers; labels/ordering/rows live in projections. A fact record never
  carries presentation.
- Every cross-currency comparison uses reporting currency; native balances are detail
  facts only.
- Sanctioned, value-coincident *exceptions* exist (an inline spend chip, transitional
  `Holding` bridges, `btc-sync` as a second flow-fact author scoped by classifier
  version). These are compatibility residue, explicitly **not** rival authorities, and
  are listed in the Spine §12 — they may be paid down but never reopen the contract.
- The Doctrine Oracle test is load-bearing: a change that moves a pinned behavior is a
  *deliberate doctrine change*, documented — never a silent drift.
