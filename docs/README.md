# Fourth Meridian — Documentation

This is the **specification of Fourth Meridian**, not the history of building it. A new
engineer or product person should be able to read `docs/` with zero prior context and
understand what the system is, how it is built, why it is built that way, and how to
change it safely. Implementation history lives in git; this tree keeps only the durable
truth.

For what is true **right now** (version, active work, blockers, next steps), read
[`/STATUS.md`](../STATUS.md) — the current-state authority. **If a doc here disagrees
with the code, the code wins; fix the doc.**

## Start here

**[architecture/](architecture/)** — the binding doctrine. Begin with
[architecture/README.md](architecture/README.md), then read
[FOURTH_MERIDIAN_DOCTRINE.md](architecture/FOURTH_MERIDIAN_DOCTRINE.md) (the reader's
guide that ties everything together).

## The four questions the docs answer

| Question | Where |
|---|---|
| **What is Fourth Meridian?** | [architecture/FOURTH_MERIDIAN_DOCTRINE.md](architecture/FOURTH_MERIDIAN_DOCTRINE.md) · [design-system/product-language.md](design-system/product-language.md) |
| **How is it built?** | [architecture/](architecture/) (doctrine) · [systems/](systems/) (subsystems) |
| **Why is it built this way?** | [decisions/](decisions/) (ADRs — decisions + rejected alternatives) |
| **How do I safely change it?** | [architecture/README.md](architecture/README.md) ("where to go when you change a feature") + the relevant systems doc |

## Folders

| Folder | What it holds |
|---|---|
| [`architecture/`](architecture/) | **Binding doctrine.** The doctrine reader's guide, the Financial Truth Spine, Space Architecture, the Security Model, the Time Model, the UI Interaction Model. |
| [`systems/`](systems/) | **Subsystem reference** — why each part exists, its authority, contracts, invariants: transactions, investments, wealth, cash-flow, liquidity, debt, connections, money-and-fx, historical-data, ai-foundation, platform-operations. |
| [`decisions/`](decisions/) | **ADRs** — decisions already made, alternatives rejected. Do not revisit a decision here without a new ADR. Includes the immutable Phase-2 decision matrix. |
| [`operations/`](operations/) | Runbooks, deployment, incident response, admin operations, key rotation, and the living production-readiness doc + checklists. |
| [`design-system/`](design-system/) | The Atlas design authority (glass/liquid material, modal doctrine, material classification) + the product language guide. |
| [`plans/`](plans/) | **Active** roadmap, parked ideas, and open initiative follow-ups. |
| [`releases/`](releases/) | Honest per-version release notes. |
| [`archive/completed-plans/`](archive/completed-plans/) | **Historical decision context only** — security reviews, the frozen Phase-2 baseline, rejected proposals, closed migration plans. Small by design; not a dumping ground. |
| [`bugfixes/`](bugfixes/) | A few closed bug writeups kept for operational reference. |
| [`images/`](images/) | Shared screenshots and diagrams. |

## The documentation contract

- **Doctrine is binding.** `architecture/` and `systems/` state what must be true. A
  change that violates a doctrine is a defect until an ADR says otherwise.
- **Decisions are durable.** A decision recorded in `decisions/` should not be
  re-litigated casually — read the ADR (including its rejected alternatives) first.
- **The archive is small.** We archive *rejected alternatives, security reviews, and
  irreversible-decision context* — never implementation logs. "What changed in July"
  lives in git history, not here.
- **When a slice completes**, its durable conclusions are promoted into `architecture/`,
  `systems/`, or `decisions/`, a release note is updated, and the working artifact is
  deleted. Git preserves the process; the tree keeps only the conclusions.
