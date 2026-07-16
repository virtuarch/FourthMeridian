# Debt

## Purpose

The Debt system answers "what do I owe?" — liabilities only — for the Debt Workspace
inside a Space. It composes the debt lens at a historical `asOf` with a Balance-Over-Time
series clipped to the shell window, while every VISIBLE FIGURE (KPI strip, per-account
bars, interest cost, utilization, payoff scenarios, signals) stays presentation-derived
from the visibility-filtered accounts array.

## Authority

Two authorities, deliberately kept apart (the DUAL-AUTHORITY rule):

- FIGURES OF RECORD come from the client `accounts` array — `computeDebtKpis` /
  `computePayoffAggregate` / `renderDebtByAccount` / `buildDebtSignals`. Every number the
  user sees is sourced here.
- PROSE comes from the debt lens (`computePerspective("debt")`) — the verdict sentence
  only. The lens may see `DebtProfile` terms the client array lacks, so the two can
  legitimately disagree; the lens is NEVER a second numeric authority.

`lib/debt-space-data.ts` (`assembleDebtSpaceData`) is the narrow TIME-COMPOSITION
contract that owns only durable composition concerns: the lens@asOf, its completeness
pointer, the window-clipped history, and FICO passthrough. It computes NO KPI, payoff,
utilization, blended APR, or verdict.

Pure debt-math helpers (`lib/debt.ts`) — `estimateMinimumPayment`, `totalDebtPaid`,
`rollupDebtPaymentsByAccount` — are deterministic and DB-free.

## Inputs

- `PerspectiveScope` `{ spaceId, userId }` (visibility is always the requester's).
- `asOf` (required, ISO) and optional `compareTo` — from the SD-0B shell.
- The visibility-filtered `accounts` array (host state) — the figures of record.
- `snapshots` (host `SpaceSnapshot` history) + `snapshotCurrency` — the Balance-Over-Time
  source.
- Optional FICO (`score`, `updatedAt`) — Personal host only in practice.
- Optional `targetCurrency` (MC1 "view as" override).

## Outputs

`DebtSpaceData` (`lib/debt-space-data.ts:69`):

- `asOf`, `compareTo`.
- `lens` — the debt `LensResult` computed AT `asOf` (null on empty/error/absent read).
- `completeness` — `lens.completeness` re-surfaced (a POINTER, not a recompute); null
  when the lens is absent or was computed present-day.
- `history` — a `DebtHistorySlice`: points clipped to `[compareTo ?? earliest, asOf]`,
  fxMiss-dropped, ascending, each `{ date, totalDebt, isEstimated }`; carries its own
  `currency` basis, `windowStart`, `windowAsOf`. null when no usable in-window history.
- `fico` — `{ score, updatedAt }` passthrough.

## Canonical contracts

- `DebtSpaceData`, `DebtHistorySlice`, `DebtHistoryPoint`, `assembleDebtSpaceData` —
  `lib/debt-space-data.ts` (PURE assembly; no DB, clock, or network — composes an
  already-computed `LensResult` + an already-read `Snapshot[]`).
- `convertDebtHistory` — the pure per-date display-currency transform for the history
  slice (`lib/debt/display-conversion.ts`).
- Route binding: `GET /api/spaces/[id]/debt/space-data?asOf=…[&target=…]` serves ONLY the
  as-of lens (a DB read the client cannot do). The client hook `useDebtSpaceData` is the
  composer — it injects the host snapshots + FICO and runs the pure
  `assembleDebtSpaceData`. The route performs NO history clipping, NO KPI math, NO
  composition.

## Persistence

Read-only. The as-of lens reads accounts walked back over transactions
(`getAccountsAsOf` + `buildDebtCompleteness`) through the visibility path; the history
slice consumes host-loaded `SpaceSnapshot` rows. The system defines NO table and NO
migration of its own.

## Consumers

- `components/space/widgets/debt/DebtWorkspace.tsx` via `useDebtSpaceData`. It reads the
  contract for temporal concerns only — lede (`data.lens`), Balance Over Time
  (`data.history`), completeness (`data.completeness`), FICO — and derives every visible
  figure from the `accounts` array.
- The workspace runs `history` through `convertDebtHistory(data.history, ctx)` before
  rendering and emits its on-screen lens's envelope to the shell chip.

## Invariants

- DUAL-AUTHORITY: figures come from the accounts array; the lens is prose-only. A
  figure-computing `DebtSpaceData` is refused precisely because it would reintroduce the
  lens-vs-client contradiction.
- History is clipped to `[compareTo ?? earliest, asOf]`, sorted ascending, and drops any
  point with non-numeric `totalDebt` or `fxMiss === true` (mixed-magnitude points are
  never plotted). Empty in-window ⇒ null (the workspace applies its own "not enough
  history yet" gate on top).
- `completeness` is a pointer to `lens.completeness`, never a second computation; a
  present-day `asOf` yields a byte-identical present branch with null completeness.
- Display-currency conversion of the history is per-date through the one canonical money
  authority (`convertMoney`); a rate miss / walk-back DROPS that point (Wealth's fxMiss-
  drop semantics for a plotted series) rather than blending a native magnitude beside
  converted ones. Identity when `display == reporting` (byte-identical).
- `creditCardSpending` and payment flows are Cash-Flow FLOW facts; current outstanding
  debt is the Debt-domain STOCK fact (balance truth) — the two are never conflated.

## Known limitations

- The snapshot history basis (`snapshotCurrency`) is NOT necessarily the lens/KPI
  currency: a display-currency switch reconverts current figures but historical totals are
  pre-stamped, so `convertDebtHistory` reconverts them per-date. The contract keeps the
  currency explicit so no consumer pretends one currency spans both axes.
- `totalDebtPaid` / `rollupDebtPaymentsByAccount` exclude rows with null `flowType` and
  are sign-agnostic (abs-sum) — they match the legacy computation's shape, and may
  undercount payments made from accounts not connected to Fourth Meridian.
- `estimateMinimumPayment` is a heuristic (max($35, 1% balance + monthly interest)), NOT
  an issuer value — callers must label it "Estimated" and prefer any manually-entered
  minimum.
- The lede `verdict` is left as the engine's self-consistent sentence; the display pass
  converts history numbers, not prose.

## Extension points

- New debt KPIs / signals extend the client-side authorities (`debt-kpis.ts`,
  `debt-signals.ts`) over the accounts array — never the lens, and never
  `DebtSpaceData`, which is intentionally narrow.
- To surface a new time-composed concern, extend `DebtSpaceData` only for genuinely
  temporal data (something the client cannot compute from present accounts + snapshots).
- As-of trust vocabulary lives in `buildDebtCompleteness` / `debtReason` /
  `debtComponent` (`asof-completeness.ts`); a new debt bucket keys off the S2 resolution
  method there.

## Why the architecture is this way

Debt is a temporal Perspective, but before this contract nothing owned the asOf/compareTo
composition — the lens never recomputed as-of on the production path and the balance
series was never clipped to the window. `DebtSpaceData` closes exactly that gap and
nothing more: it is a time-composition boundary, not a KPI DTO. The dual-authority split
is load-bearing — because the merged lens can see DebtProfile terms the visibility-
filtered client array lacks, the two can honestly disagree, so every visible number is
sourced from the client array and the lens is confined to prose. A dedicated narrow route
(rather than widening the shared batch `/perspectives`) keeps the as-of change domain-
local to Debt, and putting the history clip + FICO injection in the client composer keeps
the client KPI authority client-side while the server serves only what the client cannot.
