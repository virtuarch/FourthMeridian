# SP-1 — Space Template Foundation Investigation

**Date:** 2026-07-08
**Type:** Investigation only — no implementation, no schema, no migrations, no STATUS/ROADMAP edits.
**Companion:** `docs/initiatives/d9/SP-1_SPACETEMPLATE_FOUNDATION_INVESTIGATION.md` (the earlier, narrower D9 seam investigation — reconciled in §4 and §16 below).
**Parallel-lane context:** `PARALLEL_WORKSTREAM_INVESTIGATION_2026-07-08.md` (TI conflict surface).

---

## 1. Executive summary

Fourth Meridian already has ~80% of a template system — it just isn't named one. `lib/space-presets.ts` maps every `SpaceCategory` to a curated `SectionPreset[]`, `POST /api/spaces` materializes that list into `SpaceDashboardSection` rows inside the creation transaction, and the preset file was recently re-edited under an approved initiative literally called "Space Template Redesign." What's missing is not behavior but **structure**: presets have no identity (no template ID), no metadata envelope, no purity guarantees, no validation tests, and the category enum is doing double duty as the template selector.

**Recommendation in one paragraph:** SP-1 should be a **pure, code-defined template registry** (`lib/space-templates/`) that formalizes the existing presets into named template objects with IDs, plus a **pure apply-planner function** and a test suite — no Prisma table, no migration, no UI, no API change. This is deliberately *less* database than the earlier D9 investigation proposed, because two things changed since that document: STATUS.md §8 formally **parked** the `SpaceTemplate` table ("Marketplace / SpaceTemplate (matrix D9): unpark on real user demand"), and TI now **owns the serialized migration train**. A code registry delivers the same product foundation with zero migration risk and zero TI contact, and the parked table can land later (SP-3) as a pure projection of the registry — exactly the seed-with-parity-test path the earlier document already designed.

SP-1 has **no dependency on TI in either direction** and touches zero TI-owned files. It can run fully in parallel.

---

## 2. Current Spaces architecture summary

All claims verified against the working tree on 2026-07-08.

**Space model** (`prisma/schema.prisma:423`). `Space { type: SpaceType (PERSONAL|SHARED), category: SpaceCategory, reportingCurrency (copy-once from creator, MC1), archivedAt/deletedAt lifecycle, members, dashboardSections, aiAgent (1:1), accountLinks, goals, ... }`. No `templateId` field exists today.

**Category enum** (`schema.prisma:119`). 15 values: `PERSONAL, HOUSEHOLD, FAMILY, BUSINESS, PROPERTY, VEHICLE, TRIP, INVESTMENT, EQUIPMENT, GOAL (legacy), RETIREMENT, DEBT_PAYOFF, EMERGENCY_FUND, CUSTOM, OTHER`. Doc comment says the category "drives default UI labels, section presets, and AI context" — i.e., it is already the de-facto template key.

**Sections** (`schema.prisma:1129`). `SpaceDashboardSection { key, label, tab: SpaceDashboardTab, enabled, order, config Json?, @@unique([spaceId, key]) }`. Sections are **materialized at creation time** — a snapshot, never re-read from presets. Editing a preset never retroactively changes an existing Space. This snapshot semantics is the single most important property the template system must preserve.

**Preset layer** (`lib/space-presets.ts`, 492 lines). The de-facto template registry:
- `SectionPreset { key, label, tab, enabled, order, config? }` — the section contract (line 57).
- Three `UNIVERSAL_SECTIONS` every Space gets: `goals_progress`, `accounts_overview`, `recent_activity`.
- `PRESET_MAP: Record<SpaceCategory, SectionPreset[]>` (line ~258) — recently pruned under the approved "Space Template Redesign": every key that lacked a real renderer was removed ("the template earns its modules"), each preset now tells one story (hero + ≤3 signature modules).
- `getPresetsForCategory(category)` (line 377) — merges category + universal sections, preset-wins dedupe, per-tab re-numbering. **The seam.**
- `CATEGORY_LABELS / _DESCRIPTIONS / _ICONS / PRIMARY_CATEGORIES / SECONDARY_CATEGORIES` — picker metadata, i.e., template display metadata already exists, keyed by category.

**Creation flow** (`app/api/spaces/route.ts` POST). Validates `category` (falls back to `OTHER`) → `getPresetsForCategory` → one `db.$transaction` creating Space + OWNER `SpaceMember` + all `SpaceDashboardSection` rows + the Space's `AiAgent` (`agentScope: []`) → audit log. `CreateSpaceModal.tsx` (678 lines) is a two-step flow (create → optionally add accounts) whose category grid is built from `PRIMARY_/SECONDARY_CATEGORIES`. The PERSONAL Space is created at registration, not through this modal.

**Widget registry** (`lib/widget-registry.ts`, 815 lines). `WidgetMeta { key, label, description, tab, icon, dataTier, requires: DataRequirement[], configSchema?, deprecatedAlias? }` + an `implemented` boolean. Contains a real dependency model already: `DataRequirement { accountTypes, visibility, minCount, reason }` and `DataTier` (which API calls the shell must make). Note: `implemented: false` means "renders a stand-in, not the intended component" (e.g., `investment_allocation` renders `InvestmentsCard` rather than the intended donut).

**Runtime renderer map** (`components/dashboard/SpaceDashboard.tsx:1076`). `SectionRegistry: Record<string, renderFn>` — the actual key→component mapping. Keys absent here render a contextual `SpaceComingSoonPanel`. **This is a second source of truth alongside `WIDGET_REGISTRY`**, connected only by convention (the file's own comment plans Phase-2 co-location). Widgets carry their own empty states (`emptyHeadline`/`emptySubline` per adapter). The dashboard hero is rendered from `SpaceSnapshot`, not from a section — templates cannot and should not control it.

**Permissions** (`schema.prisma:152`, `lib/spaces/authorize.ts`, `policy.ts`). `SpaceMemberRole OWNER|ADMIN|MEMBER|VIEWER`; creation requires only an authenticated user; the creator becomes OWNER. Templates introduce no new permission surface as long as application happens only at creation.

**AI layer** (`lib/ai/domain-manifest.ts`, `AiAgent` model). `getDomainManifest(category, templateId?)` maps category → ordered `ContextDomain[]`; the `templateId` parameter is **already accepted and deliberately ignored** — an explicit, documented D9 hook. The `AiAgent.agentScope` schema comment likewise anticipates "after D9, from SpaceTemplate.contextDomains." The AI seam for templates is already designed; SP-1 must simply not break it.

**Governance state.** `PHASE_2_DECISION_MATRIX.md` D9 = **Option B** (build `SpaceTemplate` alone, small, seeded from presets, branch `feature/space-template-foundation`, no marketplace). `STATUS.md` §8 subsequently **parked** "Marketplace / SpaceTemplate (matrix D9)" pending real user demand. These conflict only if "SpaceTemplate" means the DB table; they agree entirely if SP-1 stays in code. The earlier `docs/initiatives/d9/` investigation designed the DB-table path (dormant schema + seed + parity test) and is fully reusable later.

**Test infrastructure.** No framework; standalone `*.test.ts` files under `lib/` and `app/` run via `scripts/run-tests.ts` (tsx child processes, no DB/network allowed). Precedents exist for golden tests (`serialize.golden.test.ts`) and source-scan tests (`security-surface.test.ts`) — both patterns SP-1's tests need.

**Hygiene finding (incidental):** `components/space/sections 2/` and `components/space/widgets 2/` are empty accidental duplicate directories — unrelated to SP-1, worth deleting in any cleanup pass.

---

## 3. What is a Space Template? (Q1)

**Definition:** *A Space Template is a named, versioned, declarative blueprint consumed exactly once — at Space creation — that determines the Space's category, display metadata, and initial dashboard sections.*

Of the candidate framings in the brief:

| Framing | In the definition? | Why |
|---|---|---|
| Category preset | **Yes — the core** | It is what exists today; formalizing it is the whole of SP-1 |
| Starter dashboard / section layout / widget bundle | **Yes** | These are all the same thing here: the `SectionPreset[]` payload |
| Setup checklist | Later (SP-4) | No checklist machinery exists anywhere; inventing it now is speculative |
| Onboarding flow | **No** | Parallel-workstream investigation already ruled first-run onboarding deferred (conflict-prone, post-TI) |
| AI agent persona | **No** | The D4 hook exists but nothing consumes template-level context yet; seeding agents from templates before the assistant "never misstates a number" violates STATUS §8's own agents parking rationale |

The smallest useful definition is therefore: **identity + metadata + section list**, with the type left open for later optional fields (checklist, empty-state hints, context domains). Everything else in the brief's list is a *consumer* of templates, not part of one.

A template is a **birth certificate, not a live binding**. It never re-renders, migrates, or owns a Space after creation. That preserves the materialized-snapshot invariant the entire dashboard depends on.

---

## 4. Persistence recommendation (Q2)

**Recommendation: C — hybrid: static code registry now, DB table later.** But with the emphasis inverted from the earlier D9 doc: SP-1 ships **only** the code registry; the Prisma table is explicitly deferred to SP-3.

| Option | Verdict | Reasoning |
|---|---|---|
| A. Pure code registry | **Ship now (as the SP-1 deliverable)** | Zero migration risk; trivially versioned in git; auditable by diff; fully testable without a DB; extractable; touches no TI-owned file |
| B. Prisma `SpaceTemplate` table | Defer to SP-3 | Requires a slot in the **serialized migration train TI currently owns**; STATUS §8 parks it pending user demand; adds a seed dependency to fresh envs; buys nothing until user-created templates exist |
| C. Hybrid | **Yes — this is the plan across SP-1→SP-3** | Code registry is the source of truth; the table lands later as a projection with a parity test (the earlier D9 doc already designed this exactly) |
| D. JSON config files | No | Worst of both: no type safety, no queryability, still not user-editable; the repo's convention is typed TS constants (`space-presets.ts`, `widget-registry.ts`, `domain-manifest.ts`) |

Against the brief's criteria: code registry wins on simplicity, migration risk (none), auditability (git), extractability, and impact on existing Spaces (none). It loses only on user customization and marketplace — both of which are STATUS-parked features whose unpark condition ("real users requesting templates post-launch") has not fired. Versioning is handled by a `version` field on the type from day one, so the later DB projection inherits it.

This resolves the apparent D9-B vs STATUS-§8 conflict rather than picking a side: SP-1 satisfies D9-B's actual near-term need (the Spaces-redesign requirement that "future templates fit naturally into this system") without unparking the table.

---

## 5. Exact SP-1 scope (Q3)

New directory `lib/space-templates/` — pure TypeScript, no `@/lib/db`, no Prisma client, no React:

1. **`types.ts`** — the `SpaceTemplate` interface:
   ```
   { id, name, description, icon, category: SpaceCategory,
     sections: SectionPreset[], version: number,
     status: "live" | "hidden" }
   ```
   `SectionPreset` is imported from `lib/space-presets.ts` (unchanged contract). `status: "hidden"` covers deferred/internal templates from day one (see §13).
2. **`registry.ts`** — `SPACE_TEMPLATES: readonly SpaceTemplate[]`, one per currently exposed category, **built from the existing preset constants** (imports `PRESET_MAP` content and category metadata; does not duplicate section definitions). Helpers: `getTemplate(id)`, `getLiveTemplates()`, `getTemplateForCategory(category)` (the back-compat bridge).
3. **`apply.ts`** — the pure planner:
   `planTemplateApplication(template, existingSectionKeys: Set<string>): { sectionsToCreate: SectionPreset[] }`
   — pure, synchronous, idempotent (skips keys already present, protecting `@@unique([spaceId, key])`), reuses the existing universal-merge/dedupe/re-order logic. **No DB writes; the caller materializes.**
4. **Back-compat facade** — `getPresetsForCategory(category)` in `space-presets.ts` becomes (or is verified equivalent to) `getTemplateForCategory(category)` + planner against an empty Space. **`app/api/spaces/route.ts` is not modified in SP-1** — its behavior is proven identical by a parity test instead. (Rewiring the one call site is a 3-line SP-2 change once the selector needs `templateId`.)
5. **Tests** (`lib/space-templates/*.test.ts`, discovered by the existing runner) — full list in §15.

Explicitly in scope: template IDs, metadata, category mapping, default sections (= default dashboard sections = default widgets, one concept here), template registry, pure apply function, tests.
Explicitly *not* in scope even from the brief's candidate list: empty-state copy and setup-checklist metadata (fields can be added to the type later in one line; inventing content now has no consumer — see §11, §12).

Estimated size: S. One new lib directory + tests. Zero schema, zero API, zero UI, zero behavior change.

---

## 6. Explicit SP-1 non-goals (Q4)

Deferred, with the phase that owns each:

- **Prisma `SpaceTemplate` table / `Space.templateId` column / any migration** — SP-3 (needs a migration-train slot; coordinate with TI).
- **Template gallery UI, preview cards, screenshots** — SP-3/SP-4.
- **Template selector changes in `CreateSpaceModal`** — SP-2 (the modal already has a category grid; converting it to a template grid is the natural first UI step).
- **Drag-and-drop dashboard layout** — separate initiative entirely (SpaceDashboard Phase-2 co-location plans exist in-file; not a template concern).
- **User-created templates, marketplace, `Framework`/`CreatorProfile`** — STATUS §8 parked; unpark condition unmet. D9-B already excluded the four marketplace tables.
- **AI-generated templates, AiAgent seeding, default prompts** — see §12; the D4 hook is the future seam.
- **Setup checklist machinery and onboarding tour** — SP-4; parallel-workstream investigation explicitly defers first-run onboarding (conflict-prone shared files, post-TI content).
- **Empty-state copy overhaul** — SP-2 for creation-adjacent surfaces; transaction-surface empty states are TI's (excluded per the parallel-workstream doc).
- **TI-specific widgets** (`cash_flow`, `savings_rate`, `business_cash_flow`, `monthly_expenses`) — these keys already exist in `WIDGET_REGISTRY` as `implemented: false` and were deliberately removed from presets. Templates must not re-add them until real widgets land ("the template earns its modules").
- **New categories** (Student, Government/Operations, Nonprofit, Wealth-as-distinct) — see §10.
- **Billing, external integrations, industry automations** — D10-banned / no feature attached.
- **Platform Operations template** — see §13; not blocked, not built.

---

## 7. Template application model (Q5)

**Recommendation: A now, C eventually — apply during Space creation only in SP-1/SP-2; post-creation apply ("upgrade/reset") is a separate, later feature (SP-4+).**

Grounded in the current transaction (`app/api/spaces/route.ts:100`): sections, membership, and the AiAgent are created atomically with the Space. The template planner slots in *before* that transaction as a pure computation — exactly where `getPresetsForCategory` sits today.

- **Pure before DB writes: yes.** `planTemplateApplication` computes; the route's existing `.map(...)` materializes inside the transaction. The planner never touches the DB.
- **Idempotent: yes, by construction.** The planner takes `existingSectionKeys` and only returns sections whose keys are absent. At creation the set is empty, so behavior is byte-identical to today. This same signature makes a future post-creation apply safe without redesign.
- **Never mutates user customizations.** The planner is create-only: it never updates, reorders, disables, or deletes existing sections. A future "reset to template" would be a distinct, explicit, destructive operation — not this function.
- **Duplicate avoidance.** Two layers: registry-level test (no duplicate keys within a template — protects `@@unique([spaceId, key])`) and planner-level skip (idempotence).
- **Rollback.** At creation: the existing `db.$transaction` already provides atomic rollback; templates add nothing to roll back. Post-creation apply (future) would need its own transaction; because the planner is additive-only, rollback there = delete the created rows — no restore problem, because nothing was modified.
- **Option D (suggest-only)** is rejected: it would make creation *less* intentional than today, the opposite of the goal.

---

## 8. Category vs template boundary (Q6)

**Recommendation: category and template are separate concepts; a template *implies* (carries) a category; category never implies a specific template.**

- **Category stays** as the coarse semantic classification. It has consumers beyond dashboards that must keep working when templates multiply: the AI domain manifest (`domain-manifest.ts` keys on category), audit metadata, and the schema comment's own definition ("drives default UI labels, section presets, and AI context").
- **Template becomes the creation-time selector.** In SP-2 the modal picks a template; the route derives `category = template.category`. Today's set is 1:1 with categories — that is a coincidence of the initial set, not the model. The first divergence (e.g., "Freelancer" and "LLC" both → `BUSINESS`) requires no rework under this boundary; it would require an enum migration if category *were* the template.
- **Can a Space change category later?** No such endpoint exists today; nothing in SP-1 should add one. Category is effectively immutable post-creation (only `name/description/isPublic` style edits exist).
- **Can a Space change template later?** No — a template is provenance, not state. "Re-apply" or "switch template" is the SP-4+ upgrade feature, and even then it changes *sections*, not some live template binding.
- Provenance (`Space.templateId`, nullable) arrives with the SP-3 table, matching the earlier D9 doc's Phase-2 design: provenance only, never a live foreign key that re-renders existing Spaces.

---

## 9. Initial template set recommendation (Q7)

Conservative: **formalize the 13 currently exposed presets, 1:1, and add nothing.** All are TI-independent (TI-dependent keys were already pruned from presets). Sections below are the category preset + the three universals (Goals / Accounts / Activity) except where the preset overrides.

| ID | Name | Category | Purpose / story (from preset comments) | Category sections | Beta-ready | TI dep | Defer? |
|---|---|---|---|---|---|---|---|
| `household` | Household | HOUSEHOLD | "Are WE on track" — shared net worth hero + obligations | `debt_summary` | Yes | No | No |
| `family` | Family | FAMILY | Same shape as household, family framing | `debt_summary` | Yes | No | No |
| `debt-payoff` | Debt Payoff | DEBT_PAYOFF | "How far have I come, when am I free" | `debt_breakdown_chart`, `debt_payoff_calculator`, `debt_summary` | Yes | No | No |
| `emergency-fund` | Emergency Fund | EMERGENCY_FUND | "How long could I last" | `emergency_fund_progress` | Yes | No | No |
| `retirement` | Retirement | RETIREMENT | Progress toward target/FIRE | `retirement_progress`, `retirement_accounts`†, `investment_allocation`† | Yes† | No | No |
| `investment` | Investment Portfolio | INVESTMENT | "What is it worth, what's it made of" | `investment_summary`†, `investment_allocation`† | Yes† | No | No |
| `business` | Business | BUSINESS | "Do we have cash" | `business_accounts`, `debt_summary` | Yes | No | No |
| `property` | Property | PROPERTY | Equity = value − mortgage, both on Overview | `property_value`, `mortgage_tracker`† (Overview) | Yes† | No | No |
| `vehicle` | Vehicle | VEHICLE | Value + loan | `vehicle_value`, `auto_loan_tracker`† | Yes† | No | No |
| `trip` | Trip / Vacation | TRIP | Budget + savings toward departure | `trip_budget`, `trip_savings` | Yes | No | No |
| `equipment` | Equipment | EQUIPMENT | Asset value + obligations | `equipment_value`, `debt_summary` | Yes | No | No |
| `custom` | Custom | CUSTOM | Blank slate | *(universals only)* | Yes | No | No |
| `other` | Other | OTHER | Generic fallback | `net_worth` | Yes | No | No |

† = section currently renders a stand-in (`implemented: false` in `WIDGET_REGISTRY` — e.g., `investment_allocation` renders the summary card, loan trackers render `debt_summary`). These render *real data*, just not the intended final component — acceptable for beta, but the template registry should record nothing about it; the widget registry already owns that fact.

**Not exposed as templates:** `PERSONAL` (created at registration, renders via `DashboardClient`, not in the picker), `GOAL` (marked legacy in the enum; already absent from `PRIMARY_/SECONDARY_CATEGORIES`; keep its preset for the fallback path, `status: "hidden"` if included at all).

**Deferred entirely (from the brief's examples):** Student, Government/Operations, Nonprofit — each needs a new enum value, a domain-manifest entry, and at least one real signature widget; none has a demand signal. Wealth/Investments is already covered by `investment` + `retirement`. Setup checklists: none, for any template, in SP-1 (§11).

---

## 10. Widget dependency model (Q8)

**Templates reference widgets by section `key` only** — the same stable identifier that `SpaceDashboardSection.key`, `WIDGET_REGISTRY`, and `SectionRegistry` already share. The preset file's own rule ("section keys are stable machine-readable identifiers — do not rename once they exist in the database") is the load-bearing contract; templates inherit it.

Templates should **not** reference: component names (runtime concern, `SectionRegistry`'s job), data requirements (`WidgetMeta.requires` already models `accountTypes/visibility/minCount` — owned by the widget registry, evaluated at render/picker time), feature flags, user permissions, or account types. Duplicating any of these into templates creates a second drifting source of truth.

**How templates stay unbroken as widgets evolve:**
1. **Test-time referential integrity** — a registry test asserts every template section key exists in `WIDGET_REGISTRY` (this immediately protects against the "permanent coming-soon card" failure the Space Template Redesign just cleaned up).
2. **Deprecation is the registry's job** — `WidgetMeta.deprecatedAlias` already exists; a test can additionally assert templates don't use deprecated keys.
3. **Graceful runtime degradation already exists** — unknown keys render `SpaceComingSoonPanel`, unmet `requires` render per-widget empty states. Templates need no runtime dependency logic at all.

**Pre-existing risk worth flagging (not SP-1's to fix, but SP-1's tests can watch it):** `WIDGET_REGISTRY` (metadata) and `SectionRegistry` in `SpaceDashboard.tsx:1076` (renderers) are connected only by convention. A source-scan test asserting every registry key appears in the `SectionRegistry` literal (or vice versa) would close the drift window cheaply; SpaceDashboard's own comments plan eventual co-location.

---

## 11. Empty states and onboarding (Q9)

**Current state:** empty states are *widget-owned* (`emptyHeadline`/`emptySubline` per adapter in SpaceDashboard — e.g., "No accounts shared yet / Share accounts on the Spaces page"), plus `SpaceComingSoonPanel` for unrendered keys, plus `CreateSpaceModal`'s step-2 "Add Accounts" (which already offers exactly the brief's desired CTAs: share existing accounts, Plaid connect, manual asset, wallet). There is no template-aware empty-state layer and no checklist machinery anywhere.

**Recommendation: later, not SP-1.**
- The *widget-level* empty states are correctly owned by widgets — a Personal Finance Space with no accounts already shows account-connection CTAs through them and through the creation flow's step 2.
- The *template-level* differentiation the brief wants (Business shows different CTAs than Personal Finance) belongs in **SP-2**, where the creation flow becomes template-aware — the natural shape is an optional `emptyState`/`firstRunHints` field on the template type feeding CreateSpaceModal step 2 and the dashboard's zero-account banner. Adding that field to a code-defined type later is a one-line change; defining copy now, with no consumer, produces dead content.
- The parallel-workstream investigation independently deferred both the systematic empty-state pass (weak parallel) and first-run onboarding (post-TI, conflict-prone shared files). SP-1 writing empty-state copy would contradict that recorded decision.
- Setup checklists (SP-4) should also wait for observed beta-user behavior — the same "watch the first cohort" argument the prelaunch audit made for onboarding.

---

## 12. AI / Agent default recommendation (Q10)

**Seed nothing in SP-1.** The architecture has already reserved the correct seam:

- `getDomainManifest(category, templateId?)` accepts-and-ignores `templateId` by design ("Until D9 lands, this parameter is accepted but ignored").
- The `AiAgent.agentScope` schema comment anticipates the manifest later deriving "from SpaceTemplate.contextDomains."
- `AiAgent` creation (route + register) sets `agentScope: []` = full manifest; templates changing that today would alter AI behavior with no product driver.

Future path (SP-5, or whenever a template's AI needs diverge from its category's): add optional `contextDomains?: ContextDomain[]` to the template type and pass the template ID through the existing hook. Default prompts, recommended insights, daily-report focus, notification preferences, ambient goals — all deferred; STATUS §8 parks agent autonomy behind a validator track record, and nothing about templates changes that calculus. SP-1's only obligation is negative: **don't touch `AiAgent` creation, don't import `lib/ai/*`** — which the purity tests enforce.

---

## 13. Platform Operations compatibility (Q11)

STATUS §8 parks internal-ops Spaces (matrix D12) with a specific future design: `isInternal` flag + separate authz gate, and "true dogfooding = run company finances in a normal BUSINESS Space" meanwhile. SP-1 must not block this, and doesn't:

- A future Platform Operations template is just a registry entry with `status: "hidden"` (or a later `visibility` refinement) plus whatever D12 gating exists by then. The `status` field in the SP-1 type is the entire accommodation needed now — it also serves deferred templates and the legacy `GOAL` preset, so it isn't speculative.
- Internal Spaces using the same template system is the right default (same materialization, same snapshot semantics); the *authorization* to see/apply an internal template is D12's separate gate, not template machinery.
- SP-1 must not add `isInternal`, internal categories, or any authz — that would implement PO1. It only needs to not hard-code "all templates are public," which `getLiveTemplates()` vs `getTemplate(id)` already avoids.

---

## 14. Testing strategy (Q12)

All tests are standalone `tsx` scripts under `lib/space-templates/` (auto-discovered by `scripts/run-tests.ts`), no DB, no network — matching the repo's established pattern.

| Test | Asserts |
|---|---|
| Registry validity | Every template has non-empty `id/name/category/sections`; `category` ∈ `SpaceCategory`; `version ≥ 1` |
| Unique IDs | No duplicate template IDs; IDs are stable slugs (regex) |
| Category mapping | Every category exposed in `PRIMARY_/SECONDARY_CATEGORIES` has exactly one `live` template; hidden templates allowed elsewhere |
| Widget-key integrity | Every section key in every template exists in `WIDGET_REGISTRY`; no template uses a key whose meta has `deprecatedAlias` set |
| No duplicate section keys | Within each template's planned output (post-universal-merge) keys are unique — protects `@@unique([spaceId, key])` |
| **Parity (the SP-1 core guarantee)** | For every `SpaceCategory`: planner output for that category's template deep-equals `getPresetsForCategory(category)` — keys, labels, tabs, enabled, order, config |
| Idempotent apply | Planning against a Space that already has all/some template keys returns none/only-missing; planning twice = planning once |
| Deferred templates not exposed | `getLiveTemplates()` excludes `status: "hidden"` |
| **Purity / no-TI source scan** | Files under `lib/space-templates/` import none of: `@/lib/db`, `@prisma/client` (values), `lib/transactions/*`, `lib/data/*`, `lib/plaid/*`, `lib/ai/*`, React. Precedent: `security-surface.test.ts` source-scan style |

Optional (recommended, cheap): the `WIDGET_REGISTRY` ↔ `SectionRegistry` drift scan from §10.

---

## 15. TI dependency assessment (Q13)

- **Does SP-1 depend on TI?** No. Every TI-dependent section key (`cash_flow`, `savings_rate`, `business_cash_flow`, `monthly_expenses`) is already out of the presets; templates formalize the post-redesign preset set, which is TI-free. The purity test makes this a permanent, enforced property, satisfying the brief's requirement that "templates must not compute or understand TI facts."
- **Does TI depend on SP-1?** No. TI's lane (per the parallel-workstream doc §1) is the Transaction data layer and transaction UI; it never reads presets or templates.
- **Can SP-1 be built in parallel?** Yes — fully. New files only, no migration, no shared-file edits.
- **Files that could conflict (and how SP-1 avoids each):**
  - `prisma/schema.prisma` — TI owns the serialized migration train. SP-1 touches no schema. (This is the strongest argument for deferring the `SpaceTemplate` table to SP-3.)
  - `components/dashboard/SpaceDashboard.tsx` — shared 2,692-line file; TI Phase 2's overlay touches `SpaceTransactionsPanel` and adjacent surfaces. SP-1 has no UI and never edits it.
  - `app/api/spaces/route.ts` — not TI-owned, but SP-1 leaves it unedited anyway (parity test instead of rewiring); SP-2's 3-line change lands whenever convenient.
  - `lib/transactions/*`, `lib/data/transactions.ts`, `lib/plaid/*` — avoided entirely, enforced by the source-scan test.
- **Files to avoid while TI continues:** all of the above plus `app/(shell)/dashboard/history` and `BankingClient` (TI Phase 2 surfaces). SP-1's footprint (`lib/space-templates/` + tests) intersects none of them.

---

## 16. Proposed SP roadmap

Adjusted from the brief's sketch to the actual codebase and governance state:

**SP-1 — Template Foundation** *(this investigation's scope; S; fully TI-parallel)*
Static code registry (`lib/space-templates/`: types, registry built from existing presets, pure idempotent apply-planner), full test suite (§14), no UI, no schema, no API change, `getPresetsForCategory` proven equivalent by parity test.

**SP-2 — Space Creation Integration** *(S–M; still TI-parallel except one shared-file caution)*
`CreateSpaceModal` category grid becomes a template grid (same metadata, now from the registry); `POST /api/spaces` accepts `templateId` (category derived from template, back-compat: bare `category` still works); template-aware copy in creation step 2 / zero-account state via an optional `emptyState` field added to the type. Touches `CreateSpaceModal.tsx` and `route.ts` — neither TI-owned.

**SP-3 — Persistence & Provenance** *(the earlier D9 doc's plan, essentially verbatim; schedule after TI's migration pressure eases)*
Prisma `SpaceTemplate` table + `TemplateVisibility` + nullable `Space.templateId` (provenance only, snapshot semantics preserved); seed from the code registry with byte-parity test; optional DB-read with code fallback. **One additive migration — coordinate a slot in the migration train.**

**SP-4 — Template-Aware Onboarding** *(post-TI, post-first-cohort per the prelaunch audit's argument)*
Setup checklist metadata + UI, guided next steps, first-run experience, possibly "re-apply/upgrade template" using the already-idempotent planner. Gallery previews/illustrations fold in here or ship as a small SP-3.5.

**SP-5 — Advanced Templates** *(unpark-gated)*
User-created templates (needs SP-3's table + STATUS §8 unpark condition: real user demand); Platform Operations internal template (needs D12's `isInternal` + authz gate); `contextDomains` AI defaults through the existing D4 hook; industry presets; AI-assisted templates. Marketplace tables remain excluded per D9-B/D10.

---

## 17. Final recommendation

Build SP-1 as **pure code**: a typed template registry that gives the existing, recently-curated category presets identity and an enforced contract, plus an idempotent apply-planner and the §14 test suite. Do not create the Prisma table yet — STATUS.md parks it, TI owns the migration train, and the code registry delivers the entire product foundation (intentional Spaces from the first moment, extensible to selectors, galleries, checklists, AI defaults) with zero risk. The earlier D9 investigation's dormant-table design is not discarded; it becomes SP-3, landing as a provable projection of the registry SP-1 creates.

The single most important invariant to carry forward: **materialization is a snapshot**. Templates feed Space birth and never own a Space afterward. Every future feature in §16 stays additive as long as that holds.

**Stop after investigation. No implementation performed.**
