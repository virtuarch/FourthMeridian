# Fourth Meridian — Documentation

Index of everything under `docs/`. Each top-level folder has one job; keep new docs in the matching folder rather than back at the root.

## Architecture

`architecture/` — Governing design records: the Phase 2 architecture freeze, the Phase 2 decision matrix, the database architecture review, cross-cutting connection/provider architecture docs, and the historical workspace→space rename plan. Treat these as the architecture decision record — read before starting new implementation work, don't re-litigate without a concrete blocker.

## Operations

`operations/` — Day-to-day operational references: deployment process, hydration rules, and the current project state snapshot. Update these as the running system changes, not as a historical log.

## D1–D12 Initiatives

`initiatives/d1/` … `initiatives/d12/` — One folder per Phase 2 decision (D1 DuplicateAccountCandidate, D2 Provider Adapter/Connection, D3 SpaceAccountLink, D4 AI Context Builder, etc.), holding that decision's investigation, implementation, and review docs together. Folders stay flat under 15 docs; split into `investigations/`, `implementations/`, `verification/` only once a folder crosses that threshold. Empty folders are placeholders for decisions not yet started.

## Bugfixes

`bugfixes/` — Point-in-time writeups of specific bugs and their fixes. Each file is a closed investigation; don't edit after the fix ships, file a new doc instead.

## Releases

`releases/` — Per-version release notes, named by version number (e.g. `v2.0.1.md`).

## Archive

`archive/` — Retired or superseded docs kept for history only. Gitignored — not part of the tracked source tree. Never edit archived docs; if something here becomes relevant again, copy it forward into an active folder instead.

## Design System

`design-system/` — The Fourth Meridian design language reference and its image assets.

## Images

`images/` — Shared screenshots and diagrams referenced from docs, including `images/architecture/` for the architecture diagrams used in `architecture/DATABASE_ARCHITECTURE_REVIEW.md`.
