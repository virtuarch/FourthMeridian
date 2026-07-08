# SP-2 Investigation — Template Picker & Template Application

**Date:** 2026-07-08
**Type:** Investigation only — no code changes, no schema, no migrations.
**State:** SP-1 ✓ (registry/planner/tests) · SP-2A-3 ✓ (register route materializes the hidden `personal` template; idempotent backfill script exists) · no `templateId`, no shell changes, Personal still renders via `DashboardClient`.

---

## 1. Current architecture (verified)

**The complete Create Space path today:**

```
CreateSpaceModal (components/dashboard/CreateSpaceModal.tsx, 678 lines)
  │  step "create": name/description/isPublic + category chip grid
  │    grid source: PRIMARY_CATEGORIES (6) / + SECONDARY_CATEGORIES (7) behind "Show more types"
  │    chip content: CATEGORY_ICONS[cat] + CATEGORY_LABELS[cat]; toggle-to-deselect (category may be null)
  │  handleCreate() → fetch POST /api/spaces
  │    body: { name, description?, isPublic, category: category ?? SpaceCategory.OTHER }
  ▼
POST /api/spaces (app/api/spaces/route.ts)
  │  requireUser → validate name → validate category (fallback OTHER)
  │  sectionPresets = getPresetsForCategory(resolvedCategory)     ← the seam SP-2 moves
  │  reportingCurrency (copy-once from creator)
  │  db.$transaction: space.create { …, members: OWNER, dashboardSections: create(sectionPresets.map…) }
  │                   + aiAgent.create
  │  auditLog (metadata: { name, isPublic, category })
  ▼
SpaceDashboardSection rows (materialized snapshot) → SpaceDashboard renders via SectionRegistry
```

**Callers:** `CreateSpaceModal.handleCreate` is the **only** POST caller of `/api/spaces` (Sidebar / AddManualAssetModal / AnalyzeClient only GET). One other materialization site exists outside the API: **`prisma/seed.ts:342`** also calls `getPresetsForCategory` directly when seeding demo Spaces.

**Registry state (SP-1):** `getLiveTemplates()` returns the 13 picker-exposed templates in `PRIMARY + SECONDARY` order; `getTemplate(id)` and `getTemplateForCategory(category)` resolve hidden ones too (`personal`, `goal`); `planTemplateApplication(t, ∅)` is parity-tested byte-identical to `getPresetsForCategory(t.category)` for all 15 categories. The register route (SP-2A-3) is already a production consumer of exactly this pattern.

**Where template selection enters the flow:** two seams, one per side —
1. **Client:** the chip grid's data source (`PRIMARY_/SECONDARY_CATEGORIES` + `CATEGORY_*` records → `getLiveTemplates()`), and the request body (`category` → `templateId`).
2. **Server:** the resolver line (`getPresetsForCategory(resolvedCategory)` → template lookup + planner). Everything downstream — the transaction, the `.map(...)` materialization, AiAgent creation — is untouched.

## 2. Registry as single source of truth

- **Lookup:** `getTemplate(templateId)` server-side; `getLiveTemplates()` client-side. Both exist; no new helpers needed.
- **Hidden vs visible:** `status: "hidden"` already excludes `personal`/`goal` from `getLiveTemplates()`. The server must additionally **reject hidden templateIds** (a hidden template is resolvable, not creatable) — otherwise the API would mint arbitrary PERSONAL-category shared Spaces by id. A future public template = one registry entry with `status: "live"`; it appears in the picker automatically with zero picker code changes.
- **Display metadata:** templates already carry `name`, `description`, `icon` (sourced from `CATEGORY_*` at registry build). The modal currently renders icon + label only; description is available free for richer cards later.
- **Category derivation:** `template.category` — already on the type, already validated by SP-1 tests. Client stops sending category; server derives it.
- **One gap — the featured/secondary split:** the registry has no notion of the modal's two-row presentation. Smallest fix: an optional `featured?: boolean` on `SpaceTemplate` (set on the six current primary templates). Code-only, additive, one line in the type + six in the registry + one shape-test tweak. Alternative (zero type change): keep `PRIMARY_CATEGORIES` as a transitional presentation-order list and match templates by category — rejected as it keeps category as the picker's organizing concept, which SP-2 exists to end.

## 3. API contract (minimal evolution)

```ts
POST /api/spaces
{ name, description?, isPublic?, templateId?, category? }   // both optional; templateId wins
```

- **`templateId` present:** `getTemplate(id)` → 400 if unknown → 400 if `status !== "live"` → `category = template.category` (client-sent category ignored) → `planTemplateApplication(template, new Set())`.
- **`templateId` absent (legacy path, kept for migration):** existing category validation (fallback `OTHER`) → `getTemplateForCategory(category)` → planner. Byte-identical to today's `getPresetsForCategory` output (parity-tested), so legacy callers see zero behavior change. Note the deliberate asymmetry this preserves: `category: "PERSONAL"` remains creatable via the legacy path (as today — a SHARED Space with personal presets), while `templateId: "personal"` is rejected as hidden. Document it; don't "fix" it in SP-2.
- `getPresetsForCategory` import is retired from the route; the planner becomes the route's sole materialization source (matching the register route). The audit log gains `templateId` in metadata — additive, and incidentally provides weak provenance for debugging without any schema.

## 4. Materialization — pure reuse

Yes, entirely. The route's `.map(...)` → `dashboardSections.create` block, the transaction, AiAgent creation, and the audit call are all untouched; only the *source* of the `SectionPreset[]` changes to the planner. No duplicated section definitions, no duplicated preset logic — the registry builds from the presets, the planner filters them, parity is already pinned by tests. `prisma/seed.ts`'s direct `getPresetsForCategory` call is equivalent by the same parity guarantee; optionally swap it to the planner in SP-2 cleanup for uniformity (XS), or leave it — either is safe.

## 5. Hidden templates — confirmed behavior

| Surface | `personal` / `goal` (hidden) | Future live template |
|---|---|---|
| `getLiveTemplates()` (picker) | excluded (tested) | appears automatically |
| `getTemplate(id)` via API `templateId` | **rejected 400** (new rule, SP-2) | accepted |
| Legacy `category` path | reachable (unchanged, back-compat) | n/a |
| Registration | `personal` applied (SP-2A-3, unchanged) | n/a |

One test-suite consequence to plan for: `registry.test.ts` currently asserts *exactly one* live template per exposed category. The first time a category gains a second template (e.g. two BUSINESS variants), that check must relax to "at least one" and the picker groups by template, not category. No action now; noted so the failure isn't a surprise.

## 6. Migration impact — files, scope, risks

| File | Change | Size |
|---|---|---|
| `app/api/spaces/route.ts` | accept `templateId`, resolve/validate/derive, planner-source the presets, audit metadata | S (~25 lines) |
| `components/dashboard/CreateSpaceModal.tsx` | grid from `getLiveTemplates()` (featured/rest split), state `templateId` instead of `category`, request body swap | S–M (localized to step-1 markup + `handleCreate`) |
| `lib/space-templates/types.ts` + `registry.ts` | optional `featured?: boolean` + set on six templates | XS |
| `lib/space-templates/registry.test.ts` | shape test covers `featured`; keep exactly-one-live check for now | XS |
| new `lib/space-templates/sp2-route.test.ts` (or extend existing) | source-scan: route imports planner not `getPresetsForCategory`; hidden-rejection present; modal sends `templateId` | S |
| `prisma/seed.ts` (optional) | planner instead of direct preset call | XS |

**Not changed:** schema, migrations, `SpaceDashboard`, `DashboardClient`, register route, widgets, TI/AI files. The modal is client-side and the registry is pure data with no server imports (enforced by `purity.test.ts`) — bundling it client-side is safe and tiny.

**Risks:** (1) `CreateSpaceModal` is a 678-line multi-step flow — step 2/3 (accounts/invites) must be untouched; manual QA of the create step on desktop + mobile. (2) The toggle-to-deselect chip behavior (`category ?? OTHER`) needs an equivalent: no selection ⇒ either default to the `other` template or omit `templateId` and ride the legacy fallback — recommend omitting (fewest changes, identical outcome). (3) The exactly-one-live test constraint (§5). (4) Zero TI overlap — neither file is on TI's conflict surface.

## 7. Schema — not required

**No schema for SP-2.** Template application needs only: resolve → derive category → plan → materialize, all of which is code. A `Space.templateId` column would serve *provenance* (which template birthed this Space), which nothing in SP-2 reads — the picker doesn't need it, materialization doesn't need it, and rendering is snapshot-based by doctrine. It stays deferred to SP-3 per the ratified roadmap (one additive migration, coordinated with TI's migration train). Alternatives considered: (a) audit-log metadata — already added in SP-2, adequate for debugging; (b) inferring template from category — lossy once categories have multiple templates; (c) the column now — rejected: takes a migration-train slot for a field with no reader. If SP-3's provenance need arrives early, stop and justify then.

## 8. Proposed architecture & sequence

```
CreateSpaceModal ── getLiveTemplates() ──► picker (featured 6 / show-all)
      │ POST { name, templateId }
      ▼
POST /api/spaces ── getTemplate(id) → live? → category := template.category
      │              └ legacy: category → getTemplateForCategory(category)
      ▼
planTemplateApplication(template, ∅) ──► existing transaction materialization (unchanged)
```

**Sequence (each independently shippable/revertible):**
1. **SP-2.1 — Server first.** Route accepts `templateId` (validation + hidden rejection + derivation), planner-sources both paths, audit metadata. No client change; legacy body still works; prove parity via tests. Ship alone.
2. **SP-2.2 — Picker.** Modal grid from the registry (`featured` flag added), sends `templateId`, drops its `CATEGORY_*`/`PRIMARY_/SECONDARY_` imports. Legacy `category` support in the API remains (external/back-compat), just unused by the modal.
3. **SP-2.3 — Cleanup + tests.** Source-scan tests; optional `seed.ts` planner swap; document the legacy-category deprecation intent. Template-specific empty-state copy is **out** of this slice set — it belongs with the shell/onboarding work where it has a consumer.

## 9. Recommendation

Proceed with SP-2.1 → SP-2.3 as scoped: **no schema, two files of real change, planner authoritative everywhere a Space is born** (create route + register route + optionally seed). The registry becomes the single source of truth for the picker, hidden templates stay hidden by construction, and future templates ship as pure registry entries. Provenance (`templateId` column) remains SP-3's decision, not SP-2's.

**Stop after investigation. No implementation performed.**
