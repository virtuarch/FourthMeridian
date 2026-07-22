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

Beyond the ADRs, the immutable **[PHASE_2_DECISION_MATRIX.md](./PHASE_2_DECISION_MATRIX.md)**
records the D1–D14 Phase-2 decisions (duplicate-candidate handling, Connection
evolution, `SpaceAccountLink`, AI context enforcement, encryption key derivation,
`SpaceTemplate`, and more).
