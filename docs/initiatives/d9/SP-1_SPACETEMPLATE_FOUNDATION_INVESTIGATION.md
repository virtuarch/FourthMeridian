# SP-1 — SpaceTemplate Foundation (Investigation)

**Status:** Investigation only. No implementation, no schema, no data migration.
**Governing decision:** Phase 2 Decision Matrix **D9 = Option B** — *"build `SpaceTemplate` alone, early and small, decoupled from the other four [marketplace] tables — seed it with Fourth Meridian's own built-in category presets (replacing `lib/space-presets.ts`'s hardcoded mapping with data-driven rows), with no `Framework`/`CreatorProfile`/marketplace UI attached."*
**Owning branch (per matrix):** `feature/space-template-foundation`.

**Prime directive:** identify the **absolute smallest additive seam** that turns the hardcoded category→dashboard mapping into a data-backed template model **without changing runtime behavior, redesigning the dashboard/widgets, building marketplace, or migrating existing data.**

---

## 1. Current architecture assessment

### 1.1 The one seam that matters
Every dashboard a Space has ever gotten flows through a **single function** whose output is a plain `SectionPreset[]`:

```
category (string)
   │
   ▼
getPresetsForCategory(category)            ── lib/space-presets.ts:377
   │   • look up PRESET_MAP[category]      ── hardcoded Record<SpaceCategory, SectionPreset[]>
   │   • merge UNIVERSAL_SECTIONS (Goals/Accounts/Activity), preset-wins dedupe
   │   • re-number `order` per tab
   ▼
SectionPreset[]  { key, label, tab, enabled, order, config? }
   │
   ▼
POST /api/spaces  ── app/api/spaces/route.ts:81,100
   │   sectionPresets.map(s => create SpaceDashboardSection { key,label,tab,enabled,order,config })
   ▼
SpaceDashboardSection rows (materialized, per-space)   ── prisma model, @@unique([spaceId,key])
   │
   ▼
Dashboard render ── section.key resolved by widget-registry.ts (SectionRegistry → renderer)
```

**Key property:** the dashboard is **materialized at create time** — the sections are *copied* into `SpaceDashboardSection` rows. Nothing re-reads the preset after creation. Editing a preset never retroactively changes an existing Space. This snapshot semantics is what makes the foundation safe: templates need only feed the *creation* path.

### 1.2 Exact files responsible

| Concern | File | Role |
|---|---|---|
| `PRESET_MAP` | `lib/space-presets.ts:262` | `Record<SpaceCategory, SectionPreset[]>` — the hardcoded category→sections table. |
| `SectionPreset` | `lib/space-presets.ts:57` | `{ key, label, tab, enabled, order, config? }` — the section contract. |
| Resolver | `lib/space-presets.ts:377` `getPresetsForCategory` | merges category + universal sections, dedupes, re-orders. **The seam.** |
| Category metadata | `lib/space-presets.ts:413,434,455,474,484` | `CATEGORY_LABELS / _DESCRIPTIONS / _ICONS / PRIMARY_ / SECONDARY_CATEGORIES` — drive the template picker UI. |
| Dashboard section generation | `app/api/spaces/route.ts:81,100` | the only runtime consumer — maps `SectionPreset[]` → `SpaceDashboardSection` creates inside the create transaction. |
| Widget registry | `lib/widget-registry.ts` | `SectionRegistry`: maps a section `key` → its renderer/widget. Keys with no renderer show "coming soon". Imports only `SpaceDashboardTab` from presets. |
| Persisted per-space sections | `prisma` `SpaceDashboardSection` (`WorkspaceDashboardSection`) | `{ key,label,tab,enabled,order,config }`, `@@unique([spaceId,key])`. |
| Space category | `prisma` `Space.category SpaceCategory` | the input to the resolver. No `templateId` today. |

### 1.3 What D9 originally intended
From the Freeze doc §9.4 sketch (verbatim shape) and the Decision Matrix D9-B:
- `SpaceTemplate` is *"the concrete, installable scaffold (default dashboards, starter widgets, starter goals, AI prompt presets)"* — the **"what got installed"** to a future `Framework`'s **"that it was installed."**
- The sketch coupled it to `frameworkId` and bundled five config blobs (`templateJson`, `defaultPerspectiveConfig`, `defaultWidgetConfig`, `defaultGoalConfig`, `defaultAiPromptConfig`), `version`, `createdByUserId`, `visibility`.
- **D9-B explicitly decouples it from `Framework`** and the other four marketplace tables. So the minimal foundation must **drop `frameworkId`** (there is no `Framework` table) and **defer the config blobs it doesn't need yet** — Phase-1 only needs the section list.
- `category` **reuses the existing `SpaceCategory` enum** (not a parallel type) so templates and Spaces grow their categories in the same place.

---

## 2. The smallest seam (design)

### 2.1 The invariant that guarantees zero behavioral change
Preserve the **`SectionPreset[]` contract end-to-end.** A `SpaceTemplate`'s content is *exactly* an ordered `SectionPreset[]` stored as JSON. The resolver returns `SectionPreset[]`. `app/api/spaces/route.ts`'s `.map(...)` — the real "dashboard generation" — is **never touched**. Everything downstream (materialization, widget registry, rendering) is byte-identical because the data crossing the seam is byte-identical.

> The seam is **not** the dashboard, the widgets, or the section model. It is only *where the `SectionPreset[]` comes from*: today a hardcoded map; tomorrow a data row that currently holds the same values.

### 2.2 Storage: **hybrid** (relational envelope + JSON payload)
- **Relational (Prisma `SpaceTemplate`):** identity, category, ownership, visibility, version — the fields the future ecosystem must *query/filter/authorize* on (list public templates, my templates, fork lineage).
- **JSON (`sections` column):** the ordered `SectionPreset[]` — a variable-length, evolving structure we must **not** normalize into child tables prematurely (the same reason `SpaceDashboardSection.config` is already `Json`). Pure-Prisma normalization would over-engineer; pure-JSON (a config file) would forfeit query/authorization/versioning. Hybrid is the fit, and matches both the Freeze sketch and the existing `SpaceDashboardSection` precedent.

### 2.3 Fields the minimal `SpaceTemplate` should own

| Field | Type | Phase 1 use | Rationale |
|---|---|---|---|
| `id` | `String @id` | yes | identity |
| `name` | `String` | yes | template name (built-ins: category label) |
| `description` | `String?` | yes | from `CATEGORY_DESCRIPTIONS` |
| `category` | `SpaceCategory` | yes | **reuse existing enum** (Freeze §9.4) |
| `icon` | `String?` | yes | from `CATEGORY_ICONS`; lets a template carry its own icon |
| `sections` | `Json` | **yes — the payload** | ordered `SectionPreset[]` = "ordering + default widgets + per-widget config" (sections reference widget keys; `config` is per-section) |
| `visibility` | `TemplateVisibility` enum | yes (built-ins = a `SYSTEM`/`PUBLIC` value) | unlocks public/private/unlisted later |
| `version` | `Int @default(1)` | yes | template evolution + fork lineage |
| `createdByUserId` | `String?` | yes (**null = built-in/system**) | user/AI-authored templates later |
| `createdAt/updatedAt` | timestamps | yes | standard |

**Deferred (do NOT add in SP-1):** `frameworkId` (no `Framework` table — decoupled per D9-B), `defaultPerspectiveConfig`, `defaultGoalConfig`, `defaultAiPromptConfig`, `defaultWidgetConfig` (the section list already carries widget identity+config; goal/AI seeding are separate future features). Add each **nullable** only when its real feature lands. `orgId`, `parentTemplateId` (fork lineage) — additive columns for Phase 3.

**Why these unlock the whole future without more:** `visibility` + `createdByUserId` + `version` + a JSON payload is the minimal quartet that expresses *public/private*, *authorship*, *evolution/fork*, and *arbitrary content*. Everything in §9 is then an additive column or a wrapper table, never a redesign.

---

## 3. Current flow → Proposed flow

**Current**
```
Space create → getPresetsForCategory(category) → PRESET_MAP (hardcoded) → SectionPreset[] → SpaceDashboardSection rows
```

**Proposed (Phase 1 — zero behavioral change)**
```
                          ┌──────────────────────────────────────────┐
Space create → resolveTemplate(category) ─┤ returns the SAME SectionPreset[] │→ SpaceDashboardSection rows
                          └──────────────────────────────────────────┘
                                   │  (source of truth in Phase 1: the in-code
                                   │   preset definitions, which ALSO seed the
                                   ▼   SpaceTemplate table as a data projection)
                          SpaceTemplate rows (seeded from PRESET_MAP, byte-identical)
                          — present in DB, provable-equal, not yet the live source
```

**Proposed (Phase 2 — spaces record provenance)**
```
Space create → resolveTemplate(templateId ?? category) → SectionPreset[] → materialize (unchanged)
   └─ Space.templateId = resolved template id   (provenance; NOT a live binding — snapshot semantics preserved)
   └─ resolver may now read template content from DB, with code-preset fallback if a row is absent
```

**Proposed (Phase 3 — ecosystem, deferred)**
```
Framework / CreatorProfile / FrameworkInstall wrap SpaceTemplate; fork/remix copies a row (+version,+owner,+parentTemplateId);
org templates (+orgId); AI-generated templates (createdByUserId=system, generated `sections`). All additive.
```

---

## 4. What stays untouched (Q7)

- `lib/widget-registry.ts` — **untouched.** Templates reference section keys; renderers are unchanged.
- `SpaceDashboardSection` model + per-space materialization — **untouched** (still created from `SectionPreset[]`).
- Dashboard rendering / perspective engine — **untouched.**
- `getPresetsForCategory`'s **output contract** (`SectionPreset[]`) — preserved; it either stays as-is (Phase 1) or is wrapped by `resolveTemplate`.
- Existing Spaces + existing `SpaceDashboardSection` rows — **untouched** (materialized at their own create; no migration).
- `SpaceCategory` enum, `CATEGORY_LABELS/_DESCRIPTIONS/_ICONS/PRIMARY_/SECONDARY_` — **untouched** in Phase 1 (template picker keeps using them; they later become template-derived).
- `app/api/spaces/route.ts` `.map(...)` materialization — **untouched**; only the *source* of the array moves behind `resolveTemplate`.

---

## 5. Phased implementation plan

**Phase 1 — Foundation (zero behavioral change).** Add the `SpaceTemplate` model (+ `TemplateVisibility` enum) and a nullable, dormant `Space.templateId`. Seed built-in templates *from* `PRESET_MAP`. Introduce `resolveTemplate(category)` returning the identical `SectionPreset[]`; route Space creation through it (still code-sourced, still synchronous). Prove byte-parity with a test. **No live DB dependency, no data migration, existing Spaces untouched.**

**Phase 2 — Provenance + optional DB read.** On create, set `Space.templateId` to the resolved template's id (provenance only — materialization stays a snapshot, so changing a template never mutates existing Spaces). Optionally let `resolveTemplate` read `sections` from the DB row with a **code-preset fallback** (so an unseeded env still works). Allow private/user templates (`createdByUserId`, `visibility`).

**Phase 3 — Ecosystem (deferred, out of SP-1).** `Framework`/`CreatorProfile`/`FrameworkInstall`, public template gallery, fork/remix (`parentTemplateId`), org templates (`orgId`), AI-generated templates. All build additively on the Phase-1 columns.

---

## 6. Implementation slices (SP-1 = Phases 1 only)

- **SP-1.0 — Schema (dormant).** Add `model SpaceTemplate` (§2.3 fields) + `enum TemplateVisibility`; add `Space.templateId String?` (nullable, unindexed-or-indexed, no FK behavior change). Additive migration. No code reads it. Validate: `prisma generate` + `migrate dev`, `tsc`, existing create path unchanged.
- **SP-1.1 — Canonical definitions + seed.** Treat the in-code preset objects as the canonical built-in template definitions; add a seed that upserts one `SpaceTemplate` per category from `getPresetsForCategory` output (or from `PRESET_MAP` + universals). `createdByUserId = null`, `visibility = SYSTEM/PUBLIC`, `version = 1`. Add a **parity test**: for every `SpaceCategory`, `template.sections` deep-equals `getPresetsForCategory(category)`.
- **SP-1.2 — Resolver indirection.** Introduce `resolveTemplate(category): SectionPreset[]` (code-backed, byte-identical to `getPresetsForCategory`) and route `app/api/spaces/route.ts` through it. Keep it **synchronous** and code-sourced. Zero behavioral change; the `.map(...)` is untouched.
- **SP-1.3 (Phase 2 opener, separately approved) — Provenance.** Set `Space.templateId` on create; optionally switch `resolveTemplate` to read `sections` from DB with code fallback.

Each slice is independently shippable and reversible.

---

## 7. Future compatibility (Q9)

| Future capability | How the foundation supports it (additive only) |
|---|---|
| **Public Spaces / public templates** | `visibility = PUBLIC`; list by `visibility` + `category`. |
| **Marketplace / Framework** | `Framework` (deferred) wraps `SpaceTemplate` per Freeze §9.4 — `SpaceTemplate` is the "what installed"; no change to the template shape. |
| **Framework creators** | `createdByUserId` (author) + `visibility`; a `CreatorProfile` table (deferred) joins on it. |
| **Remix / Fork** | copy the row, `version++`, new `createdByUserId`, future `parentTemplateId` column for lineage. |
| **Organization templates** | future nullable `orgId` column; query by org. |
| **AI-generated Spaces** | `createdByUserId = system/AI`, generated `sections` JSON validated against the `SectionPreset` shape — no new machinery. |

None require touching the dashboard, widgets, or the `SectionPreset` contract.

---

## 8. Risks

- **Seed/code drift (highest).** While code remains the source of truth, seeded `SpaceTemplate` rows could diverge from `PRESET_MAP`. Mitigation: seed *from* the resolver output + a parity test asserting deep-equality per category; do not hand-author template JSON in Phase 1.
- **Async creep.** Reading templates from the DB makes `resolveTemplate` async, rippling to callers. Mitigation: Phase 1 stays synchronous/code-sourced; DB reads arrive only in Phase 2 on the already-async create path, with a code fallback.
- **Seed dependency on fresh DBs.** If runtime ever *requires* a template row, an unseeded env breaks Space creation. Mitigation: code presets remain the fallback source of truth through Phase 2; the DB row is a projection, not a hard dependency.
- **Snapshot vs live-binding confusion.** Materialization is a snapshot; `templateId` is provenance, **not** a live foreign key that re-renders existing Spaces. Mitigation: never re-read the template for an existing Space; document the snapshot invariant.
- **`@@unique([spaceId,key])` collisions.** Templates with duplicate section keys would break materialization. Mitigation: preserve the existing preset-wins dedupe + per-tab re-order inside `resolveTemplate`; validate `sections` key-uniqueness at seed time.
- **Scope creep into marketplace.** The Freeze sketch's `frameworkId`/config blobs invite premature breadth. Mitigation: D9-B decoupling — ship only the envelope + `sections`; defer the rest as nullable columns added with their features.
- **Category enum coupling.** Reusing `SpaceCategory` means template-only categories need enum additions (additive, safe) rather than a parallel type — intended per Freeze §9.4.

---

## 9. Validation strategy

- `npx prisma generate` + `npx prisma migrate dev` — **additive** migration only (new table, new enum, one nullable column); confirm no change to existing tables' semantics.
- `npx tsc --noEmit`, `npm run lint`.
- **Parity test (the core guarantee):** for every `SpaceCategory`, assert `resolveTemplate(category)` (and the seeded `template.sections`) deep-equals `getPresetsForCategory(category)` — same keys, labels, tabs, enabled, order, config.
- **Create-space non-regression:** create a Space in each category before/after SP-1.2; the resulting `SpaceDashboardSection` rows must be identical (same set, order, config).
- **Existing Spaces untouched:** confirm no migration statement mutates `SpaceDashboardSection`/`Space` rows; existing dashboards render unchanged.
- **Seed idempotency:** re-running the seed upserts (no duplicate templates).

---

## 10. Rollback strategy

- **Additive-only, fully reversible.** SP-1.0's table/enum/nullable column can be dropped; nothing else references them until later slices.
- **Resolver indirection reverts trivially** — `resolveTemplate` is a thin wrapper over `getPresetsForCategory`; revert the one call site in `spaces/route.ts` back to the direct call.
- **Seed rows are inert** if unused; deleting them affects nothing while code is the source of truth.
- **`Space.templateId` is nullable** and provenance-only — ignoring/removing it changes no behavior.
- **No data migration, no irreversible steps.** `git revert` + `prisma migrate` down restores prior state; existing Spaces are never touched at any phase.

---

## 11. Recommendation

Proceed to a **SP-1.0 + SP-1.1 checklist** first: add the dormant `SpaceTemplate` schema and seed it from `PRESET_MAP` with a byte-parity test — the smallest step that makes the presets data-backed and provably identical, with zero runtime dependency and zero behavioral change. Hold SP-1.2 (resolver indirection) and Phase 2 (provenance/DB reads) for separate approval. Marketplace/Framework (Phase 3) stays deferred per D9-B.

**Stop after investigation.**
