# ADR-009 — Transfer resolution stays local: evidence-tiered pairwise matching, never global optimisation

**Status:** proposed (records constraints the code already enforces; owner acceptance
pending) · **Contract:** [systems/transactions.md § Transfer resolution authority](../systems/transactions.md#transfer-resolution-authority)

## Context

Fourth Meridian pairs the two legs of a movement between a user's own accounts so that
transfers stay wealth-neutral, debt payments are attributed to the right liability, and
cash flow excludes internal movement. The authority (`lib/transactions/transfer-maturation.ts`,
reached through `RelationshipResolver.ts` and `transfer-resolution.ts`) is a ladder of
local, pairwise rules: provider-asserted identity, then mutual uniqueness at the same
day, then within five days, then account-certain/leg-unknown, then type, then terminal
leaves, then a named residue. Each rung abstains rather than guesses.

The v2.6 investigation measured this rule and a set of alternatives against
provider-issued ground truth (pairs an institution stamped with one shared reference on
both legs). The local rule made **zero** wrong pairings. Every alternative that raised
recall by optimising made wrong ones.

## Problem

Matching recall looks low next to what a "smarter" matcher could claim, and the obvious
improvements (global assignment, nearest-in-time, a wider window, scored candidates,
multi-hop journeys) are well known from reconciliation literature. Which of them may a
future change adopt, and why not?

## Decision

The transfer authority stays **local, deterministic and evidence-tiered**. Recall is
improved only by better admission, better ordering of the same predicate (stratification),
and new deterministic evidence (provider identifiers), never by optimisation or inference.
The following are **never implemented**:

1. **Global / bipartite (min-cost) matching, and greedy nearest-in-time.** Measured
   worse: each made wrong pairings where the local rule made none. The cause is
   structural, not tuning: these algorithms assume a **closed book** (every item has a
   counterpart; the only question is which). A personal-finance corpus is an **open
   book** — a large share of legs have no counterpart at all (a person, a merchant, cash,
   an unconnected institution) — and an objective that leaves nothing unmatched
   manufactures pairs.
2. **Widening the window beyond about a week.** The settlement-lag histogram decays to
   about six days and then *rises* again: that is recurring same-amount activity (this
   month's payment matching last month's), not slower transfers. A wider window invents
   cross-month pairs. `TRANSFER_MATCH_WINDOW_DAYS = 5`; finer intermediate tiers between 0
   and 5 add nothing measurable. The bound held when matching moved to the economic date.
3. **Persisted probabilities or scores.** A posterior cannot be written to
   `counterpartyAccountId` without asserting a fact that is not one. Nothing below
   account certainty is ever stored, and no ranked candidate list is stored either.
4. **Chain / multi-hop inference as a resolver.** The measured topology is a star (one
   funding hub), the arrival→onward-departure gap rises toward the monthly statement
   cycle (anti-causal), and money in a hub is fungible. Chain inference would produce
   confident fiction. `lib/transactions/transfer-chain.ts` exists only as a strict,
   derived, read-only composition of hops that are already pairwise certain (equal
   amounts, parkable intermediate, mutually unique continuation); it has no production
   consumer, finds no chains on the measured corpus, and must never feed pairing.
5. **Subset-sum / partial-forwarding matching.** No batched or split transfer was
   observed, and the one relaxation tried ("onward amount ≤ arrival") double-counted
   immediately (one arrival funding two payments).
6. **Institution names as a resolver.** An issuer name can denote both a card and a
   savings account at the same institution; name routing resolved nothing on its own.
   Names may only *scope* a candidate set; identifiers (a correlation token, an account
   mask) may resolve. A standing test scans the ladder's logic
   (`transfer-maturation.ts`) for institution and payment-app brand names; correlation
   extractors are keyed by provider institution id, never by display name.
7. **Fee or FX tolerance.** One amount-altered case and no FX case were observed.
   Tolerance without evidence is how false pairs are made; cross-currency pairs stay
   honestly unresolved.
8. **A `TransferChain` table.** There is nothing to store.

Also out of bounds, by the same reasoning: cadence, account-role or topology priors in
tie-breaking (the graph may inform understanding, never resolution), and relaxing the
Plaid PII deny-list to obtain identifiers (the authority reads only the stored
descriptor and keeps only an opaque digest).

## Alternatives considered

| Alternative | Why rejected |
|---|---|
| Optimal assignment (Hungarian / min-cost flow) | Closed-book assumption; measured wrong pairings; maximises matches rather than truth |
| Min-cost matching that abstains on ties | Fewer errors than plain min-cost, still not zero; strictly dominated by stratified local matching |
| Greedy nearest-in-time | Measured wrong pairings; order-dependent |
| Probabilistic record linkage (Fellegi–Sunter style) | Needs a labelled set and yields a posterior; the only labelled set (provider references) *is* the answer where it exists |
| Temporal / hidden-state graph inference | Timing is anti-informative (rising gap histogram) |
| Balance-delta conservation as an arbiter | A balance gap is not a transaction and is not independent of the rows that produced it; it stays supporting evidence only |
| Stratified matching (same day first, then ±5) | **Adopted** — it reorders an existing predicate without weakening it; removing same-day pairs first shrinks the competition that defeated the single ±5 pass |
| Provider identifiers (correlation token, account mask) | **Adopted** — deterministic, validated per claim, abstain on any failure; the architecture stays correct with them disabled |

## Consequences

- **Accepted:** some legs stay honestly unresolved, each with a named reason; recurring
  identical transfers between the same two accounts resolve the account but never the
  leg (`ACCOUNT_CERTAIN_LEG_AMBIGUOUS`).
- **Accepted:** cross-owner and cross-currency transfers are not paired until evidence
  and measurement justify a change; cross-owner matches are detected and named only.
- **Risk retained:** tier ordering creates a cascade — one wrong provider claim removes
  two legs from later tiers. Mitigation: a provider group must pass every validation
  clause and the same `legsQualify` predicate or produce no evidence; no rung emits
  partial credit.
- **Changing any item above needs a new ADR** with fresh measurement against provider
  ground truth, including the identifier-disabled floor, and the standing tests in
  `lib/transactions/transfer-authority.test.ts` and the REQUIRED
  `scripts/audit-transfer-authority.ts` must stay green.
