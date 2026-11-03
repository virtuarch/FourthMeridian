# Decisions (ADRs)

Architectural Decision Records. Each ADR captures a decision that **should not be
revisited without a new ADR** — not just *what* was decided, but the *problem*, the
*alternatives that were rejected*, and the *consequences* we accepted.

An ADR exists so a future engineer understands not only what exists, but **why the
obvious-looking alternative was not taken**. If you are about to "simplify" something
an ADR describes, read the ADR first — the simplification was probably considered and
rejected for a reason still true today.

## Format

Every ADR has: **Context** · **Problem** · **Decision** · **Alternatives considered**
(and why rejected) · **Consequences**. ADRs are append-only in spirit: to change a
decision, write a new ADR that supersedes the old one (note it at the top of both).

## Index

| ADR | Decision | Canonical doctrine |
|---|---|---|
| [ADR-001](./ADR-001-space-model.md) | The Space is the universal container primitive (not a per-domain app or an authz layer) | [SPACE_ARCHITECTURE](../architecture/SPACE_ARCHITECTURE.md) |
| [ADR-002](./ADR-002-financial-authority.md) | One authority per financial truth; consumers project, never re-decide | [FINANCIAL_TRUTH_SPINE](../architecture/FINANCIAL_TRUTH_SPINE.md) |
| [ADR-003](./ADR-003-visibility-model.md) | Per-account visibility tiers behind one `[FULL]` predicate; three authz axes never merge | [SECURITY_MODEL](../architecture/SECURITY_MODEL.md) |
| [ADR-004](./ADR-004-time-doctrine.md) | `asOf` is a persistent anchor; presets are backward windows; one time authority | [TIME_MODEL](../architecture/TIME_MODEL.md) |
| [ADR-005](./ADR-005-numeric-precision.md) | Money representation audit + Float→Decimal migration roadmap | — |
| [ADR-006](./ADR-006-provider-abstraction-timing.md) | Introduce a provider-neutral abstraction from the *second* provider, not the first | [FINANCIAL_TRUTH_SPINE §12](../architecture/FINANCIAL_TRUTH_SPINE.md) |
| [ADR-008](./ADR-008-documentation-lifecycle.md) | Documentation is update-first, indexed (`plans/INDEX.md`) and archived at release; evidence is never deleted | [docs/README.md](../README.md#documentation-lifecycle) |
| [ADR-009](./ADR-009-transfer-resolution-local-matching.md) | Transfer resolution stays local and evidence-tiered; global/greedy matching, wider windows, persisted scores, chain inference, subset-sum, name routing and fee/FX tolerance are never implemented | [systems/transactions.md § Transfer resolution authority](../systems/transactions.md#transfer-resolution-authority) |

Beyond the ADRs, the immutable **[PHASE_2_DECISION_MATRIX.md](./PHASE_2_DECISION_MATRIX.md)**
records the D1–D14 Phase-2 decisions (duplicate-candidate handling, Connection
evolution, `SpaceAccountLink`, AI context enforcement, encryption key derivation,
`SpaceTemplate`, and more).

## Parked (decided, not built)

Deliberately parked product and architecture ideas, each with its unpark condition (moved from `parked-ideas.md` (removed; see git history), 2026-11-03). Status of every row: **DECIDED BUT NOT IMPLEMENTED** (parked). Unparking one needs an owner decision; record it as a new ADR or plan.

| Idea | Why parked | Unpark condition |
|---|---|---|
| Marketplace / SpaceTemplate (matrix D9) | Zero users; no demand signal; distracts from launch | Real users requesting templates post-launch |
| Internal-ops Spaces (matrix D12) | No internal team; privileged ops data inside customer tenancy would weaken the strongest boundary. Dogfood via a normal BUSINESS Space instead | Internal headcount whose workflows outgrow the Admin Console; then `isInternal` + separate authz gate |
| ProviderAdapter abstraction | A generic interface before a second provider is speculation | A second sync provider committed (also unparks the `Connection` cutover) |
| PublishedAccountView | Public trust boundary over financial data; the private boundary isn't hardened yet | External security review of the private sharing boundary passed |
| Second sync provider / investment transactions / wallet providers | Launch doesn't require them; Plaid-only launch is fine | Post-launch, ranked by usage evidence |
| Agents / automation workflows | An assistant must never misstate a number when asked before it acts unprompted | Post-launch + validator track record |
| Billing / payouts / messaging / support tables (D10) | Ratified out of Phase 2 | Billing only: lifts at v3.0 |
| Decimal / int-cents money migration | High-churn schema period; migration is large. Precision debt is inventoried in [../architecture/decisions/DEC-0.md](../decisions/ADR-005-numeric-precision.md) | Plan during v2.5; execute post-v2.6b |
| Liquid / real-refraction glass material (backdrop lens) | **Evaluated and rejected** — backdrop refraction (`backdrop-filter: url(#svg)`) is Chromium-only. The *content-lens* Atlas Liquid card shipped; only the browser-wide *backdrop*-refraction direction is parked. Atlas stays on the CSS material simulation | A cross-browser true-backdrop-refraction primitive becomes viable |
| Mobile-auth flow (from the CASHFLOW_AND_MOBILE_AUTH plan) | The cash-flow half shipped under SD-6C; the mobile-auth half was never scheduled | A mobile-native auth requirement lands |
| Receipt Intelligence | Read-time posture satisfies most of the demand; the binding constraint is demand-side (gated on OPS-1 S10 / beta) | Beta users demonstrably need receipt capture |
| AI advice writer surfacing loop; Space clustering / financial topology; Meridian Analyst | Parked product ideas — decision still open | Revisit at a post-launch planning pass |
