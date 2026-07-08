# SP-2A Direction Investigation — Re-sequence Personal Unification

**Date:** 2026-07-08
**Type:** Investigation only — no implementation, no schema, no STATUS/ROADMAP edits.
**Challenges:** the slice ordering in `SP-2A_UNIFIED_SPACE_SHELL_INVESTIGATION_2026-07-08.md` (rail parity → materialize → shell swap).

---

## Verdict up front

**The challenge is correct. Data-first is the better order.** The previous investigation sequenced by *visibility* (fix the embarrassing one-pill rail first because it's cheap); the proposed re-sequence orders by *dependency* (data model → consumers → presentation). Ordering by dependency is architecturally sounder, and — the decisive new finding — it makes standalone rail parity (SP-2A-2) **throwaway work**: once Personal renders through `SpaceDashboard`, the full rail comes free from `railVisibleTabs("personal")`, so a separate rail-parity edit inside `DashboardClient` is an investment in a host scheduled for retirement. The previous investigation flagged the "dormant sections" risk of materializing early but underweighted the mirror-image cost of polishing a doomed host. Evidence re-examined below; conclusions revised where the evidence warrants.

---

## 1. Is the re-sequence cleaner? Why?

Yes, for four grounded reasons:

1. **Each stage strictly enables the next.** Stage 1 (sections everywhere) is precisely the precondition that makes Stage 3 (shell swap) a *pure presentation change*. In the old order, SP-2A-4 bundled data work + host swap + hero migration — the largest, riskiest slice carried a data dependency it didn't need to. In the new order, when the shell swap happens, `SpaceDashboard` finds everything it already fetches for shared Spaces (`/api/spaces/[id]/sections`, `/accounts`, `/goals`, `/snapshots`, `/transactions` — all live for Personal) plus real section rows. The swap shrinks.
2. **No throwaway work.** Rail parity as a `DashboardClient` edit (swap `PERSONAL_TABS`/`MORE_MENU_ITEMS` for `railVisibleTabs`-derived pills) is small, but 100% of it is deleted at SP-2A-5. In the re-sequence it never exists as a separate artifact.
3. **One intermediate state fewer to QA.** Old order ships "full rail over legacy internals" as a user-visible configuration that exists only to be replaced — tested twice, designed twice.
4. **The planner gets its second consumer before SP-2 builds on it.** Register-route materialization makes `planTemplateApplication()` load-bearing in the most sensitive flow while the surface area is still tiny — a better proving ground than debuting new consumers and a new picker simultaneously.

The one thing the old order bought — killing the visible one-pill/dropdown split immediately — is a product-timing benefit, not an architectural one. It survives in the re-sequence as an *optional, explicitly-throwaway* cosmetic patch if beta demands it (§7).

## 2. Does template-backing first reduce later complexity?

Yes, concretely per area:

- **Section materialization** — lands once, in two small isolated sites (register route + backfill script), instead of inside the giant shell-swap slice. The register change mirrors `POST /api/spaces` line-for-line (`sectionPresets.map(...)` inside the existing `tx`), reviewable in isolation.
- **Widget registry** — zero change needed at Stage 1 (the `personal` template's keys — `net_worth`, `debt_summary`, `investment_summary` + universals — all exist and render via `SectionRegistry`). Later FICO/cash-flow widgetization (§6) is decoupled and can trail indefinitely.
- **Empty states** — SP-2's template-specific empty-state work targets one section model with no "except Personal, which has no sections" asterisk in every design decision and test.
- **Template application** — both Space birth paths (register, create) converge on the planner *before* the picker exists. SP-2's route change becomes "pass a templateId to the path register already exercises."
- **Future templates** — any new template's lifecycle (define → plan → materialize → render) is proven end-to-end on the hardest case (Personal) first.

## 3. Does SP-2 become simpler?

Modestly but genuinely. The picker itself never touches Personal (unchanged conclusion — `CreateSpaceModal`/`POST /api/spaces` is a path Personal never takes). What improves: SP-2's docs, tests, and empty-state design lose their Personal caveats; the apply-route change is a variation on an already-shipped pattern rather than the planner's first production consumer; and the product story ("every Space is born from a template") becomes literally true the day the picker ships, instead of true-except-for-the-Space-every-user-sees-first.

## 4. Does rail-parity-first create temporary architecture debt?

Yes — this is the previous investigation's weakest recommendation, now withdrawn as a mandatory slice:

- It edits `DashboardClient`'s rail plumbing (`PERSONAL_TABS`, `MORE_MENU_ITEMS`, `RAIL_TO_INTERNAL` wiring) — all of which SP-2A-5 deletes.
- It creates a hybrid: canonical rail presentation over the legacy lowercase `PersonalTab` internals — a state that satisfies neither the old minimalism intent nor the target architecture, and which deep-link (`?tab=`) handling must support as a third configuration.
- It delivers zero progress toward the actual endpoint; `SpaceDashboard` hosting Personal produces the identical rail with no `DashboardClient` edit at all.

Reclassification: **SP-2A-2 is demoted from "do first" to "optional interim cosmetic patch, explicitly marked throwaway"** — justified only if the one-pill rail must die before TI Phase 2 clears the way for the real swap.

## 5. The doctrine: "Templates own default content. Templates do not own layout."

Correct in spirit; needs one refinement to match the code. `SectionPreset` carries `tab` and `order` — templates *do* own **placement within the skeleton** (which tab a section lives on, in what order; e.g. PROPERTY deliberately hoists `mortgage_tracker` onto OVERVIEW). What templates must never own is the skeleton itself: `SPACE_TAB_ORDER` is law ("Accounts is always third"), the rail, the shell, the tab model. Proposed wording:

> **Templates own default content and where it sits within the skeleton. The skeleton — tabs, rail, shell — is owned by the product and identical for every Space. Hero content is the only sanctioned per-Space divergence.**

This is consistent with `lib/space-nav.ts`'s existing contract ("hosts may filter, never reorder") and with the Space Template Redesign's per-category placement decisions.

## 6. Can Personal's richness live entirely in a hero slot?

Mapped item-by-item against `DashboardClient`'s below-hero content:

| Personal surface today | Unified-shell home | Gap? |
|---|---|---|
| `NetWorthCard` + `KpiRow` (+ greeting) | **Hero slot** (personal hero variant; shared Spaces keep `SpaceTrendHero`) | None — this IS the sanctioned divergence |
| `FicoCard` | Hero slot initially; later a `fico_score` registry widget | Widget doesn't exist yet — future entry, honest `implemented:false` until real |
| `PerspectivesWidget` row | Already shared — SpaceDashboard renders it on Overview | None |
| `RecentTransactionsPanel` | SpaceDashboard's Overview preview / TRANSACTIONS tab (`SpaceTransactionsPanel`) | None (panel internals are TI's; re-parent only) |
| Inline banking account sections | ACCOUNTS tab (`accounts_overview` — implemented) | Cosmetic delta (grouping/collapse polish) |
| `DebtClient` (credit tab) | Debt perspective glass modal (`renderDebtSummary` family) | FICO piece separates out (above) |
| Investments tab | Investments perspective / `investment_summary` | Stand-in renderer, same as shared |
| Cash-flow KPI modal | Future `cash_flow` widget (key exists, `implemented:false`) | **TI-adjacent — defer**; do not build during unification |

**Verdict: yes.** Everything below the hero maps to an existing widget, tab body, or perspective route; the only genuinely new registry entries (FICO, cash-flow) are additive later work, not unification blockers. Long-term, even the KPI tiles could decompose into widgets, shrinking the personal hero toward a trend+headline like every other Space — but that's polish, not architecture.

## 7. The cleaner roadmap

The proposed roadmap is right; two amendments (SP-2A-2's demotion, and an explicit TI gate before the shell swap):

```
SP-1     Template foundation                          ✓ shipped
SP-2A-3  Personal becomes template-backed             S — register route + idempotent backfill script
         (register applies hidden `personal` template;  no schema, no migration, TI-parallel)
SP-2     Template picker / application / empty states  M — both birth paths now share the planner
  [optional] SP-2A-2′ cosmetic rail patch              XS — only if product demands it pre-swap;
                                                        explicitly throwaway
──────── TI Phase 2 lands (SpaceDashboard.tsx merge window clears) ────────
SP-2A-4  Personal rendered by SpaceDashboard           M — pure presentation swap + hero slot;
                                                        rail parity arrives free
SP-2A-5  DashboardClient retirement + cleanup          S — delete RAIL_TO_INTERNAL, PersonalTab
                                                        plumbing, MoreMenu usage; ?tab= reconciliation;
                                                        stray `sections 2`/`widgets 2` dirs
SP-3+    Persistence/provenance, gallery               unchanged from SP-1 roadmap
```

## 8. Risk delta

**Reduced by the re-sequence:** throwaway work (eliminated); SP-2A-4 scope (loses its data step — the riskiest slice gets smaller); planner production-risk (proven early, in isolation, instead of debuting under SP-2); double-QA of an interim rail state; merge exposure (Stage-1 files — register route, new script — have zero overlap with TI or SP-2).

**Introduced, with mitigations:**
- **Dormant rows** (Stage 1 → Stage 3 gap): sections exist that no Personal surface renders. Verified consumers of `spaceDashboardSection`: the two sections API routes and **`lib/export/assemble.ts`** — so the rows *do* appear in user data exports immediately. Benign (arguably more honest exports) but observable; note it in the slice doc. No Personal UI reads them (DashboardClient's settings tab is just links — verified).
- **Template snapshot staleness:** rows backfilled now reflect today's template; if presets evolve before Stage 3, Personal renders the older snapshot. This is *exactly* the materialized-snapshot doctrine every shared Space already lives under — not drift, but worth a conscious nod. Optional mitigation: re-run the idempotent backfill (adds missing keys only) just before Stage 3.
- **Register-route change moves earlier:** the most sensitive flow in the product gets its transaction extended sooner. Mitigation: it's a line-for-line mirror of the create route's shipped pattern, small enough to review exhaustively, and staging-testable end-to-end.
- **The one-pill rail lives longer** — the visible inconsistency persists until SP-2A-4 (or the optional cosmetic patch). This is the real price of the re-sequence, and it's a product call, not an architectural one.

## 9. The architectural north star

**`Space → Template → Sections → Widgets` is the correct north star — and it is already the shipped architecture for every Space except Personal.** The create route materializes template output into sections; `SectionRegistry` resolves sections into widgets; `lib/space-nav.ts` already models both hosts as one tab system; `SpaceDashboard`'s own comments plan registry/component co-location; the Widget Primitive Rule exists to keep the widget layer closed under adapters. "Personal Dashboard vs Shared Dashboard" appears nowhere as a design intention — it is a historical artifact of `DashboardClient` predating the Spaces redesign, and every pass since (shared tab vocabulary, shared widgets, shared switcher gates) has been eroding it.

Two things correctly survive as Personal-specific *without* violating the north star: **policy** (the lifecycle trio ban, no Leave, register-only birth — `lib/spaces/policy.ts` `sharedOnly`, an authorization concern, not a rendering one) and **hero content** (the sanctioned divergence). The legacy standalone routes (`/dashboard/banking` etc.) remain a separate retirement question outside this initiative.

## 10. Final recommendation — from scratch, knowing everything

**One dashboard system whose behavior is determined by templates. Without hesitation.** Every planned intelligence layer argues for it: TI Phase 2's transaction overlay, MI's merchant display, and future ambient insights each need to land on *one* integration surface — today each would have to consider two hosts (TI's own conflict-surface list already names both `BankingClient` and `SpaceTransactionsPanel`). Two dashboard systems means every cross-cutting feature ships twice or ships unevenly — and "unevenly" is precisely the Personal-feels-legacy problem this initiative exists to fix.

The candid caveat: a single system must not flatten Personal's density into a generic card grid. The hero slot plus eventual FICO/cash-flow registry widgets is how Personal's quality survives unification — content richness expressed *through* the system rather than beside it.

**Therefore: adopt the re-sequenced roadmap in §7. Next implementable step: SP-2A-3 (register-route materialization + `backfill-personal-sections` script), then SP-2. Shell swap waits for TI Phase 2.** The previous investigation's slice content stands; its ordering is superseded by this document.

**Stop after investigation. No implementation performed.**
