# Initiative Naming — Alias Table

*Immutable reference. Historical commits, code comments, and docs use several overlapping initiative labels; this table is the single map from those labels to their canonical meaning. The D-number collision was resolved by **freezing, not renumbering** — `PHASE_2_DECISION_MATRIX.md` is the sole authority for D1–D14, forever, and historical commits/docs are never edited.*

## Track prefixes

New initiatives get a **track prefix + number**, allocated only here, so an ID can never be squatted twice:

| Prefix | Track |
|---|---|
| `AI-x` | Intelligence / advisor |
| `UI-x` | Design system (Atlas) |
| `UX-CUST-x` | User customization of Space surfaces |
| `L-x` | Launch / ops |
| `MC-x` | Multi-currency / money model (first member `MC1`) |
| `PE-x` | Deterministic perspective / lens layer (first member `PE1`) |
| `DB-x` | Physical database schema hygiene (first member `DB1`) |
| `OPS-x` | Platform operations foundation — email, observability, legal, beta gate (first member `OPS-1`) |
| `MI-x` | Merchant intelligence — persisted merchant identity, aliases, rules (first member `MI1`) |
| `A-x` | Investment / wealth intelligence — observation, holdings, position reconstruction, historical price, time machine (allocated retroactively for the `A1`…`A10` commit labels) |
| `SD-x` | Space Dashboard decomposition (SpaceShell → workspaces) |
| `KD-x` | Known-defect tickets |

The flat D-namespace is exactly what collided — unrelated tracks competed for adjacent integers. Prefixes make the track self-evident in a commit message.

## Alias map

| Historical label (commits, code, docs) | Canonical ID | Note |
|---|---|---|
| "D6", "D6.3", "D6.3A–D" in AI/intelligence contexts | **AI-3** | Collision victim: matrix D6 = ProviderCatalog. AI-3 investigations were filed under `d6/` because that folder was already owned by ProviderCatalog |
| "D4 Slice 1", "D4 chat", "D4 provider lifecycle", "D4 Balance Freshness" | **AI-1 / AI-2** (AI work) + **D2** (provider lifecycle) | Code used "D4" as an era label broader than matrix D4 (enforcement + agentScope) |
| "D6/D7 Provider Catalog — Slice 1" (`lib/providers/catalog.ts`) | **D6/D7** | Correct usage — matrix meaning |
| "D6 Institution Catalog investigation" | **D6** | Correct usage |
| "UX-1" (Settings information-architecture refactor) | **(ad-hoc, unallocated)** | A separate use of "UX-x" in commit vocabulary, distinct from the design-system `UI-1`; never formally allocated |

## Lifecycle

An initiative gets **one active plan** in `docs/plans/` while open; at close, its **durable conclusions merge into `doctrine/` / `systems/` / `architecture/`**, a release note is updated, and the active plan is deleted. Git preserves the implementation history — the working tree does not keep closeout folders forever.
