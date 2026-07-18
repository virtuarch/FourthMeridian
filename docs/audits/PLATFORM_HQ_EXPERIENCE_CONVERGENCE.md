# Platform HQ — Editorial Experience Convergence (PO-2)

**Status:** IMPLEMENTED — presentation convergence only. No authorization, data, schema, or operator-write changes.
**Date:** 2026-07-18 · branch `feature/v2.5-spaces-completion`
**Predecessors:** `docs/audits/PLATFORM_OPERATIONS_CONVERGENCE_AUDIT.md` (investigation), `docs/plans/platform-ops-roadmap.md` (PO1), `docs/architecture/PLATFORM_SECURITY_BOUNDARY.md` (PO-1 security foundation).
**Verification:** tsc clean · no new eslint errors · 287/287 unit · browser-verified all four HQ areas as a granted operator (see §6).

---

## 0. What this slice did, in one line

Migrated the four Fourth Meridian HQ areas from a **dashboard card grid of isolated metric widgets** to the **editorial read-surface language customer Spaces already use** (Atlas `Surface`/`Block`/`Figure` + per-area lede + `RightPanel` inspection) — by reshelling the shared widget kit and the host body, so all 24 widgets across all four areas converge at once, with **zero** change to authorization, data contracts, or operator capabilities.

The success test — *"a future employee with a PlatformGrant enters HQ and feels 'this is the operating environment for the company,' not 'an old admin dashboard'"* — is met: each area now opens with the ONE question it answers, over an editorial stack of the same figures/ledgers customer Spaces use.

---

## 1. Before / after architecture

**Unchanged (already structurally correct before PO-2 — do not rebuild):**
- Platform HQ is already a real Space at `/dashboard/platform/[area]`, rendered through the shared `SpaceShell` and the universal `WORKSPACE_REGISTRY` (`PLATFORM_WORKSPACES`, `domain:"platform"`).
- `PLATFORM_AREA_WORKSPACES` is the single composition owner (which workspaces/sections each area exposes). Only `PLATFORM_OPS` is decomposed; the other three keep one Overview.
- Widgets **self-fetch** their `/api/platform/*` read routes, gated by `requirePlatformAccess`. The `PlatformGrant` axis, `AuditLog`, customer `SpaceMember` permissions, and provider-sync logic were **not touched**.

**Changed — presentation only:**

| Layer | Before | After |
|---|---|---|
| Widget shell (`widget-kit.tsx` `PlatformWidgetCard`) | bordered dashboard card: loud icon badge + bold title, `--surface-muted` | Atlas `Block` (quiet uppercase eyebrow + faint icon in the hint slot) wrapping a `Surface` — the customer-Space read-surface idiom |
| Metric (`widget-kit.tsx` `WidgetStat`) | ad-hoc `text-xl` span | Atlas `Figure` (tabular, no brand tone — "a number's colour is a claim") |
| Workspace body (`PlatformSpaceDashboard`) | `grid auto-fit minmax(280px)` card tiles | editorial vertical stack (`flex-col gap-8/10`), density building down the page |
| Area entry | straight into widgets | per-area **`PlatformAreaHero`** — eyebrow + the area's question + lede + operator-context line |
| Detail | inline chevron-expand inside the card | **`RightPanel`** "row → detail" inspection (flagship: Provider Health), composing Atlas panels |
| Doorways | second card grid | quiet "Explore" region |

Because every widget composes from `widget-kit.tsx`, reshelling those two primitives cascaded the editorial language to **all 24 widgets across all four areas** with **no per-widget call-site changes** — the same "reshell the shared body" leverage the Cash Flow convergence used.

---

## 2. Prototype mapping

The prototype target (`prototype/prototype-claude/`, viewable at `/prototype/claude`) models HQ as Spaces on the SAME shell/cards/charts as customer Spaces — "only the domain changes." PO-2 realizes that at the production frame + body level:

| Prototype element | Production equivalent (this slice) |
|---|---|
| `space-y-9` Block stack, density down the page | `PlatformWorkspaceBody` editorial `flex-col gap-8/10` stack |
| `Surface` + `Block` labelled regions | `PlatformWidgetCard` → Atlas `Block` + `Surface` |
| `Figure`/`Stat` big-number typography | `WidgetStat` → Atlas `Figure` |
| First-section anchor + editorial lede | `PlatformAreaHero` (the area's question) |
| `DrillPanel`/`SidePanel` RightPanel inspection | Atlas `RightPanel` + `PanelHeader`/`PanelContent` on Provider Health |
| Per-area "one reality, many Spaces" identity | per-area hero copy, exhaustive over `PlatformArea` |

**Divergences from the prototype (deliberate):**
- The prototype's Platform Ops tabs are Overview/Providers/Jobs; production already ships a richer decomposition (Overview/Jobs/Providers/Operations/Alerts/History/AI/Costs) — kept as-is.
- The prototype's system-health hero shows fabricated figures (Users 12,482 …). PO-2's hero is **presentation-only and fabricates no numbers** ("preserve existing data only"): it frames the question; the data-backed `Figure`s live in the Blocks below (Job Health, Connection Health, Signups, Sync Issues — all real). A composite live "system-health" hero that aggregates multiple endpoints is a **deferred seam** (§5) because it needs a new aggregate read contract.

---

## 3. Components migrated / added

**Migrated (presentation reshell, behavior identical):**
- `components/platform/widget-kit.tsx` — `PlatformWidgetCard` → `Block`+`Surface`; `WidgetStat` → `Figure`. (`useWidgetFetch`, `WidgetMessage`, `timeAgo`, `PlatformSection` unchanged.) → cascades to all 24 widgets.
- `components/platform/PlatformSpaceDashboard.tsx` — body card-grid → editorial stack; hero mounted on each area's Overview; doorways → quiet "Explore" region.
- `components/platform/widgets/OpsProviderHealthWidget.tsx` — inline chevron-expand → **row → `RightPanel` detail** (`ProviderRow` + `ProviderDetail`), the flagship inspection demonstration.

**Added:**
- `components/platform/PlatformAreaHero.tsx` — per-area editorial lede (4 questions, exhaustive over `PlatformArea`), folds the grant access level into the operator-context line. Presentation-only, no fetch.

**Trust indicators — decision:** the finance `TrustIndicator` is coupled to the `PerspectiveEnvelope` (finance completeness contract + popover/evidence drawer). Platform has its own operational `ProviderTrust` vocabulary (OPERATIONAL/DEGRADED/STALE/FAILING). Forcing the finance primitive here would couple platform to the finance envelope and violate the axis separation the whole design protects, so PO-2 kept the platform-native trust display (color-coded dot + label, already honest). Converging the two trust vocabularies is a deferred seam (§5).

---

## 4. Deferred operator capabilities (NOT in this slice)

This is **read-only** experience convergence. Per the PO-2 constraints, none of the following were added, and the Provider Health RightPanel is deliberately **detail-only** (no action controls):
- user management · invite flows · membership grant/remove/transfer · Space recovery
- connection resync / force-refresh · job retry / rerun actions
- any operator write API · `/admin` migration · any new authorization path

These remain in PO-3/PO-4 (backend capability additions), scoped by the convergence audit's Track B.

---

## 5. Future PO-3 / PO-4 seams (left clean)

- **Action slot on inspection panels.** The `RightPanel` detail is the exact place a future WRITE-gated action (Provider → "Resync connection", User → "Deactivate") mounts — as a `PanelFooter` behind `requireFreshPlatformAccess(area,"WRITE")` + a transactional `AuditLog` via `lib/audit.ts` `recordAuditEvent` (PO-1 foundation). The row→panel idiom is now proven; PO-3 adds the footer.
- **Users & Spaces read workspaces.** The convergence audit's Track P4 (`platform-users`, `platform-spaces` read workspaces relocating the `/admin` census) drops straight into `PLATFORM_AREA_WORKSPACES` + the reshelled kit — no new shell.
- **Inspection idiom, remaining list widgets.** Provider Health is the flagship; the same `row → RightPanel` upgrade applies next to Connection Health, the Audit Feed, Sessions, and Sync Issues (all currently editorial lists after PO-2). Mechanical follow-ups.
- **Composite system-health hero.** A live "Users / Spaces / Connections / Sync health" figure row in the hero needs one new aggregate read contract (`GET /api/platform/platform-ops/overview` composing the existing projections) — presentation is ready; the seam is the contract.
- **Trust vocabulary convergence.** Unifying operational `ProviderTrust` with the finance `PerspectiveEnvelope`/`TrustIndicator` (or a shared domain-neutral trust primitive) so platform trust chips render through one component.
- **Section anchors.** Blocks are ready for a left-rail anchor nav (Atlas `LeftPanel`/`Sidebar` idiom); not wired this slice.

---

## 6. Verification

**Static:** `tsc --noEmit` clean · `eslint` on all changed files clean except one **pre-existing** `set-state-in-effect` error in `useWidgetFetch` (unchanged by this slice; confirmed present on `HEAD`) · `287/287` unit tests.

**Browser** (dev, logged in as a `USER` granted READ on all four areas — a `SYSTEM_ADMIN` is redirected `/dashboard`→`/admin` and cannot reach the platform Spaces, so a granted operator account is the correct test identity):
- ✅ All four areas render with their editorial hero: PLATFORM_OPS "What is the health of Fourth Meridian?", SECURITY_OPS "Is Fourth Meridian secure?", GROWTH_REVENUE "How is the platform growing?", CUSTOMER_SUCCESS "How are customers doing?"
- ✅ `SpaceShell` chrome + subtitle ("Platform · <area> · READ") + workspace rail intact; rail navigation (Overview↔Providers) works.
- ✅ Existing widgets still display real data: Job Health (10 jobs), Rate Limits, Connection Health (4/10/14), API Usage, Provider Health, Env, Audit Feed (real login events), Signups & Activation, Sync Issues (36).
- ✅ RightPanel inspection: clicking a Provider row opens the Atlas `RightPanel` with the full field set over a dimmed scrim.
- ✅ Customer Spaces unaffected (jane's Spaces render normally; platform Spaces don't leak into the customer list).
- ✅ Responsive: clean reflow at 1232px and ~590px (Figure grids restack, no horizontal overflow).

*Dev-DB test scaffolding (a temporary grant for the test operator + one enabled section) was reverted after verification, leaving the dev DB as found.*
