# Fourth Meridian — Documentation

Index of everything under `docs/`. For what is happening **right now** (version, active work, blockers, next steps), see [`/STATUS.md`](../STATUS.md). `docs/` holds the durable intent; the code is the source of truth.

## The documentation lifecycle

Investigations and initiatives are **temporary decision inputs**, not permanent documentation:

> **Investigation → Decision → Knowledge extraction → Deletion.**

When work closes, its durable conclusions are merged into `doctrine/` / `systems/` / `architecture/`, a release note is updated, and the working artifacts are deleted. **Git preserves the process; the working tree keeps only the conclusions.**

## Folders

| Folder | What it holds | Nature |
|---|---|---|
| [`doctrine/`](doctrine/) | The **rules that bind the code** — financial-semantics, money-and-fx, historical-data, spaces, platform-and-security, intelligence | Durable, evolving |
| [`systems/`](systems/) | **Why each subsystem exists** + its authority, contracts, invariants — investments, wealth, cash-flow, liquidity, debt, transactions, spaces, connections, platform-ops, ai | Durable, evolving |
| [`architecture/`](architecture/) | **Decision records** — PHASE_2_DECISION_MATRIX (sole D1–D14 authority), PHASE_2_DOCTRINE, PHASE_2_ARCHITECTURE_FREEZE, `decisions/DEC-0`, `initiative-naming` | Immutable decisions |
| [`plans/`](plans/) | **Active** roadmap, plans, and parked ideas | Living, active-only |
| [`operations/`](operations/) | Runbooks (jobs, keys, incident), deployment, release + security checklists | Living |
| [`releases/`](releases/) | Honest per-version release notes (what shipped · gaps · migration · readiness) | One per version |
| [`audits/`](audits/) | The living audits — architecture, security, production-readiness. Category expires at first production release | Point-in-time |
| [`design/`](design/) & [`design-system/`](design-system/) | Design language, Atlas material doctrines, product language, assets | Durable |
| [`bugfixes/`](bugfixes/) | Remaining closed bug writeups (operational lessons folded into runbooks) | Historical |
| [`images/`](images/) | Shared screenshots and diagrams | — |

There is no permanent `initiatives/` or `investigations/` home: an initiative gets one active plan in `plans/` while open, and its durable rules land in `doctrine/` / `systems/` at close.
