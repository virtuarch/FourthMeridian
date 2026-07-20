# ADR-004 — `asOf` is a persistent anchor; presets are backward windows; one time authority

**Status:** accepted · **Doctrine:** [TIME_MODEL](../architecture/TIME_MODEL.md)

## Context

Every financial Perspective (Wealth, Cash Flow, Investments, Debt, Liquidity) reads
the past: "what was true on date D, and how did the trailing period into D look?".
Users move a vantage point in time and choose how much history to see. Multiple
surfaces historically each carried their own idea of "now" and "the window."

## Problem

Two temporal concepts get conflated: *where you are standing* (the anchor) and *how
far back you are looking* (the window). If choosing a window silently moves the anchor,
then a "Month to date" selection means different things by deep-link versus by click,
historical links break, and the balance lenses lose their one historical workflow.
And if each workspace owns its own time state, they drift out of sync.

## Decision

**`asOf` is a persistent temporal anchor; relative presets are window lengths measured
backwards from the anchor, not from the present; and there is exactly one canonical
time authority.**

- `asOf` decides *what is true* (which snapshot, price, FX rate). It moves **only** by
  explicit user action.
- A preset decides *how much history is shown* — nothing more.
  `asOf = 2026-03-31, preset = MTD → 2026-03-01…2026-03-31` (not "this month").
- One authority: `shellTimeReducer` / `usePerspectiveShellState` owns
  `{preset, asOf, compareTo}`. The `TimelineLens` UI **emits intents** and cannot read
  a clock, do calendar math, or name a preset — structurally incapable of becoming a
  second authority. One adapter serves all five Perspectives.

## Alternatives considered

- **Anchor resets to today on preset change** (the intuitive "pick a range" model).
  Rejected in the TIME-1 analysis: it breaks reducer/hydrate identity (the same
  `{preset, asOf}` resolves differently by link vs click, breaking historical deep
  links), and it destroys Wealth's only historical-window workflow ("net worth on D +
  the trailing quarter into D"), which the balance lenses have no escape hatch for.
- **Per-Perspective time adapters.** Rejected: the differences between lenses live
  *downstream* of time selection, never in how time is chosen. One adapter, five
  lenses.
- **Silently coercing an emptied As-of field to today.** Rejected: an anchor you can
  enter but not leave is a trap; there must be exactly **one** explicit return to the
  present (`returnToPresent → setAsOf(today)`). Two paths to "now" — one deliberate,
  one accidental — make the deliberate one noise. An emptied field is *rejected with a
  message*, not coerced.
- **Labels that assert "this month."** Rejected: a label may not claim "this" of a
  window that does not contain today. To-date presets are "Month to date," and the
  lens always names the vantage point ("As of Mar 31, 2026" / "As of today").

## Consequences

- Every financial Perspective participates in the one canonical `{preset, asOf,
  compareTo}` model (`consumesShellTime`); no workspace owns time.
- Deep links round-trip: `{asOf, compareTo, preset}` serialize to the URL and rebuild
  identically by link or click.
- Forward comparison is legitimate (`compareTo` is not constrained to precede `asOf` —
  Wealth depends on it); the strictly-earlier rule is a *derivation*
  (`historicalCompareTo`), not an invariant.
- The doctrine is test-enforced (mutation-verified: flipping the reducer to reset
  produces 27 failures). Changing it requires answering the reducer/hydrate divergence
  and Wealth's workflow — neither has a cheap answer, which is why the doctrine is what
  it is.
