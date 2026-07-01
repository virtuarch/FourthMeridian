# Fourth Meridian — Documentation

Index of everything under `docs/`. For current project status, roadmap, initiative ledger, and known defects, see [`/STATUS.md`](../STATUS.md) — the only document allowed to describe current state.

## Documentation layers

| Layer | Location | Mutability | Authority |
|---|---|---|---|
| Canonical operational | `/STATUS.md` | Living — updated by any behavior-changing PR | Current state, roadmap, defects, initiative status |
| Decision records | `architecture/` | Immutable — superseded, never edited | What was decided and why, as of their date |
| Initiative history | `initiatives/<id>/` | Immutable once the initiative closes | How something was built |
| Cross-cutting investigations | `investigations/` | Immutable | Design reasoning not owned by one initiative |
| Operational references | `operations/` | Living | How to deploy and operate |
| Archive | `archive/` | Immutable | Superseded material kept for history |

## Folders

- `architecture/` — Governing design records: Phase 2 architecture freeze, decision matrix, database architecture review, D2 connection/provider architecture. The Decision Matrix is the sole authority for D-numbers D1–D14.
- `initiatives/<id>/` — One folder per initiative, holding its investigations, checklists, validations, and closeout. Folders stay flat under 15 docs; past that they split into `investigations/`, `implementation/`, `validation/`, `closeout/` with an `INDEX.md` (see `initiatives/d2/`).
- `investigations/` — Cross-cutting or alias-mapped investigations (see STATUS.md §4 for D-number aliasing).
- `bugfixes/` — Closed point-in-time bug writeups. Never edited after the fix ships.
- `releases/` — Per-version release notes.
- `operations/` — Deployment process and hydration rules.
- `design-system/` — Design language reference and assets.
- `images/` — Shared screenshots and diagrams.
- `archive/` — Retired or superseded docs. Never edit archived docs; copy forward instead.
