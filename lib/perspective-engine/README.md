# Perspective Engine

Deterministic, typed, non-persistent layer that answers financial questions
("lenses") about one Space for one viewing member. Decision record:
`docs/investigations/PERSPECTIVE_ENGINE_FOUNDATION_INVESTIGATION.md`
(implemented 2026-07-03); product definition:
`docs/investigations/PERSPECTIVES_INVESTIGATION.md`.

## What a lens returns

A `LensResult` (types.ts): a one-sentence deterministic **verdict**, a
**headline metric**, supporting metrics, explicit **assumptions** (estimates
are always labeled), and **provenance** — contributing account ids,
per-visibility-tier counts, oldest input freshness (`dataAsOf`), and
name-free redaction lines. Non-`ok` results are still fully shaped:
`empty` carries static safe copy; `error` carries a category code only.

## Invariants (all guard-tested)

- **Deterministic.** Same inputs + injected clock (`ComputeOptions.now`) →
  byte-identical JSON. No `Date.now()` inside lenses; verdicts are string
  templates over computed metrics, never free text.
- **No direct Prisma.** Nothing in this directory imports `@prisma/client`
  values or `@/lib/db` (import-graph tripwire in `engine.test.ts`). Lenses
  read exclusively through the KD-19 visibility-enforced data layer —
  `lib/data/accounts.ts#getAccountsWithVisibility()`, which pairs each
  client-safe `Account` with the `SpaceAccountLink.visibilityLevel` that
  produced it (server-side contract; the tier never rides on the Account
  object itself).
- **No LLM math.** No imports of `lib/ai/provider` or
  `lib/plaid/encryption`. AI may later *narrate or propose* Perspectives
  through D4; it never computes lens numbers.
- **Fail closed, fail shaped.** FULL grants everything; BALANCE_ONLY grants
  the balance alone; SUMMARY_ONLY and any unknown/legacy tier contribute to
  no numeric aggregate anywhere. Lens cores re-gate FULL-only fields as
  defense in depth. A thrown or contract-violating lens becomes a shaped
  `COMPUTE_FAILED` result (raw error text never enters results); the
  structural contract is enforced by `validateLensResult()`.
- **Name-free by construction.** Lens input row types carry no name or
  institution fields — adapters drop them at the boundary, so a lens cannot
  leak what it never receives. Provenance carries account ids only.

## Consumers

`computePerspective(lensId, scope)` / `computePerspectives(scope)`
(index.ts) are THE entry points. `GET /api/spaces/[id]/perspectives` is a
thin, membership-gated **consumer** — auth + JSON framing only, no math —
not the center of the design (gating tripwires: `route.test.ts`). Future
consumers (Daily Brief, D4 AI context, Meridian Analyst, saved
Perspectives) call the engine functions directly. `scope.userId` must
always be the requesting viewer, never a stored or elevated identity.

## Current lenses

| Lens | File | Answers |
|---|---|---|
| Liquidity | `lenses/liquidity.core.ts` (+ `liquidity.ts` binding) | "How much could I get at, and how fast?" — cash now, raisable by selling, other assets, FULL-only unused credit (never counted as liquidity) |
| Debt | `lenses/debt.core.ts` (+ `debt.ts` binding) | "What does my debt cost?" — total debt, estimated monthly interest, blended APR, minimum payments, next promo-APR expiry |

Each lens = pure core (fixture-tested, no I/O) + thin data-binding module
that registers via `registerLens()` at import time (the
`lib/ai/assemblers/*` pattern). Card presentation lives in
`components/dashboard/widgets/PerspectivesWidget.tsx`; the
library-to-lens mapping (`lensId`) lives in `lib/perspectives.ts` with its
own guards in `lib/perspectives.test.ts` (a lens-backed card can never be
`comingSoon`).

## Adding a lens

One approved lens at a time (feasibility matrix, investigation §3). Add the
id to `LensId`, write `lenses/<id>.core.ts` (pure) + `lenses/<id>.ts`
(binding + registration), a `<id>.test.ts` suite covering determinism /
tier privacy / empty state / assumptions, import the binding in the route,
and attach `lensId` in `lib/perspectives.ts`. Bump `lensVersion` whenever a
lens's math changes. Do not generalize this into a query engine — all
flexibility belongs in *scope*, never in what a lens computes.

## Tests

```
npx tsx lib/perspective-engine/engine.test.ts      # registry, shaping, import guards
npx tsx lib/perspective-engine/liquidity.test.ts   # lens math + privacy
npx tsx lib/perspective-engine/debt.test.ts        # lens math + privacy
npx tsx lib/perspective-engine/route.test.ts       # route gating tripwires
npx tsx lib/perspectives.test.ts                   # library/lens invariants
```
