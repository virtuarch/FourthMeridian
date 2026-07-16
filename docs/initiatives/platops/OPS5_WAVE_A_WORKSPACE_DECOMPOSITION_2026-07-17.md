# OPS-5 Wave A — Platform Workspace Decomposition + Operational Perspectives Foundation

**Status:** COMPLETE · validated green (tsc · eslint · unit 274/274) · committed `da6a539`, not pushed
**Date:** 2026-07-17 · branch `feature/v2.5-spaces-completion`
**Scope:** OPS-5 **S6** (Workspace Decomposition) + **S8** (Operational Perspectives *foundation only*). Did NOT begin S7 / S9 / S10. Architecture/composition work — recomposition, not redesign.

---

## 1. Pre-wave Platform architecture census

- **Render path:** `app/(shell)/dashboard/platform/[area]/page.tsx` — area→session→ACTIVE `PlatformGrant` (`hasPlatformAccess`, never 404), then loads the platform Space + its **DB-seeded** `SpaceDashboardSection` rows (`enabled`, ordered), passed to `PlatformSpaceDashboard`.
- **Surface (before):** `PlatformSpaceDashboard` rendered ONE Overview workspace in the shared `SpaceShell`, a no-op single-tab rail, and a flat CSS grid of all enabled sections via a platform-local `PLATFORM_WIDGET_REGISTRY`. A dead `PLATFORM_SECTION_REGISTRY`/`PlaceholderCard` subsystem lingered (integration-gate §12).
- **Composition (before):** `PLATFORM_AREAS[area].sections` (policy.ts) seeded the DB rows; the render read the DB rows. No workspace concept.
- **Authz:** `PlatformGrant (area, level)` only — no `SpaceMemberRole` anywhere in the platform axis.
- **Universal architecture (reuse target):** `SpaceShell` is fully workspace-agnostic (title/subtitle/toolbar/rail/children). `WORKSPACE_REGISTRY` (lib/perspectives.ts) = `STANDARD_WORKSPACES` + `PERSPECTIVE_LIBRARY`, keyed by id. Customer `SpaceDashboard` builds a fixed-order rail → `railOptions` → per-tab branch into `children`.
- **PLATFORM_OPS section→owner map:** job-health→S2 · rate-limits→RateLimit · env→env-report · api-usage→ApiUsageCounter · connection-health→CH-1 · resource-freshness→S1 · manual-operations→S4 · provider-health→S3 · alerts→S5. All READ-gated `requirePlatformAccess`.

## 2. Final Platform Workspace map (S6)

Only **PLATFORM_OPS** decomposes (demand-pulled); other areas keep a single Overview (behavior-preserving).

| Workspace (id) | Rail | Section-widgets |
|---|---|---|
| `platform-overview` | Overview | **summary:** alerts · job-health · provider-health · resource-freshness · rate-limits · env-status **+ doorways** → Jobs/Providers/Operations/Alerts |
| `platform-jobs` | Jobs | job-health (rich) |
| `platform-providers` | Providers | provider-health · connection-health · resource-freshness · api-usage |
| `platform-operations` | Operations | manual-operations (the WRITE surface) |
| `platform-alerts` | Alerts | alerts (rules + history) |

## 3. Overview responsibility — before / after

| | Before | After |
|---|---|---|
| Cards in Overview | **9** (everything, incl. Manual Operations WRITE, full connection/API/provider/job detail) | **6 summaries + doorways** |
| Manual Operations (WRITE) | in Overview | **moved to Operations workspace** |
| Connection / API-usage detail | in Overview | **moved to Providers workspace** |
| Role | the permanent home of every capability | a **summary + doorways** landing surface |

## 4. WorkspaceDefinition / registry changes (Part 4)

**Decision: single universal `WorkspaceDefinition` + a `domain?: "finance" | "platform"` discriminator. NO base/PersonalFinance type split.**

The census disproved the split's premise: `dataNeeds` / `consumesShellTime` / `envelope` are declared by the *structural* `STANDARD_WORKSPACES` too, and SD-3's own doctrine makes `dataNeeds` **universal orchestration metadata** ("any Space domain … orchestrated by this SAME code"). The pollution is not the fields but the finance **vocabularies** (`WorkspaceDataNeed` / `WorkspaceEnvelopeSource` / `RoutedWorkspaceTab`). A split would *contradict* SD-3; the mission's own condition — "only if the second consumer proves it necessary" — is not met (Platform defs simply omit the finance-vocab optionals). A `domain` discriminator + the guard test (`no finance vocabulary on a Platform definition`) enforce non-pollution without the risky core refactor (which the blast-radius census rated LOW but doctrine-wrong).

`WORKSPACE_REGISTRY` now unions `PLATFORM_WORKSPACES` (id-namespaced `platform-*`, `domain:"platform"`) — the ONE universal identity authority across domains. No finance helper sees a Platform entry (they read `PERSPECTIVE_LIBRARY` or filter on finance-only fields Platform omits).

## 5. Platform composition owner (Part 6)

`PLATFORM_AREA_WORKSPACES` in **`lib/platform/workspaces.ts`** — THE single owner answering "which Workspaces does each area expose, in what order, and which section-widgets each renders." Identity (label/icon/kind) lives in `PLATFORM_WORKSPACES`; composition (order + section grouping + doorways) lives here; the render resolves identity from the registry and composition from here — no duplicated identity.

## 6. dataNeeds / self-fetching decision (Part 5)

**Decision A — self-fetch.** Platform widgets already self-fetch (`useWidgetFetch`); Platform workspace defs carry **no** `dataNeeds`; the finance `WorkspaceDataNeed` union is **untouched** (no mega-union). If Platform ever needs declarative loading, SD-3 already supports a domain-specific vocabulary + orchestration seam added *then* — not speculatively now.

## 7. Navigation result (Part 7)

Shared `SpaceShell` + its Atlas `SegmentedControl` rail — same foundational navigation as customer Spaces. Platform differs only in permitted presentation (rail content = platform workspaces, an access-level badge in the toolbar, summary→detail doorways). Same architecture, different presentation. Active-tab is local `useState` (URL sync is a future nicety, unchanged from before).

## 8. Platform registry result (Part 8 — convergence audit)

- **`WORKSPACE_REGISTRY`** — universal identity authority; now the second-consumer home. Justified.
- **`PLATFORM_WIDGET_REGISTRY`** (platform-local, section-key→widget) — justified; parallel to the customer `WIDGET_REGISTRY`, same "one entry, no switch/case" pattern, different widget family.
- **`PLATFORM_SECTION_REGISTRY` + `PlaceholderCard`** — **removed** (dead per integration gate §12; the rewrite made removal small and safe).
- **Future cleanup (documented, not done):** `WORKSPACE_REGISTRY` physically lives in the finance-named `lib/perspectives.ts`; a domain-neutral home is the eventual convergence, deferred (a bigger move than this wave warrants).

## 9. S8 Perspective capability census (Part 10)

| Candidate Perspective | Canonical domain | Historical substrate today | Temporal/comparison model | Verdict |
|---|---|---|---|---|
| Reliability (job success/punctuality over time) | job execution | `JobRun` (append-only, dated) — raw only | none (no rollup, no non-finance time model) | **PARTIAL → BLOCKED_ON_S7** |
| Provider Health Over Time | provider | `ApiUsageCounter` (daily), `SyncIssue`, `JobRun` — raw only | none | **PARTIAL → BLOCKED_ON_S7** |
| Cost & Latency | economics | `ApiUsageCounter` volume; latency whole-job only | none; also S10 scope | **BLOCKED_ON_S7 / S10** |
| Operational Risk | composite | — | — | **BLOCKED_ON_S7** |

Raw dated ledgers exist, but a Perspective needs a *temporal + comparative* model (rollups + comparison semantics + a non-finance time model) that is **S7's** deliverable. Building one now would breach the S7/S10 fence and duplicate what S7 must own.

## 10. Perspectives READY_NOW / PARTIAL / BLOCKED_ON_S7

**READY_NOW: none.** Everything is PARTIAL (raw substrate) → **BLOCKED_ON_S7** (no rollup/comparison layer, no operational time model). Per the mission, **no operational Perspective ships** — Wave A establishes the *foundation seam* only, guarded by a test (`no fake operational Perspective ships`).

## 11. Time-model decision (Part 12)

The shell time reducer (`lib/perspectives/time-range.ts`, `{preset, asOf, compareTo}`) is **structurally generic** (pure calendar arithmetic) but **finance-coupled** two ways: `TimePreset` aliases `lib/transactions/cash-flow`, and asOf/compareTo are **semantically inert without history**. **Decision:** do NOT reuse the finance reducer verbatim, and do NOT extract a generic temporal contract now (premature). S7 establishes the operational temporal model; the reducer can be reused *structurally* later once (a) the preset vocabulary is neutralized off the cash-flow alias and (b) the host gates the `PerspectiveShell` time bar on `consumesShellTime` (today it renders unconditionally — the blocking coupling).

## 12. Trust / envelope decision (Part 13)

`PerspectiveEnvelope` (`tier/tone/evidence`) is **universal at the shape level** (the platform-wide `observed/derived/estimated/incomplete` vocabulary) with a first-class opt-out (`envelope:"none"` → inert chips). Its **resolvers are finance-DTO-bound**. **Decision:** no extraction, no speculative trust machinery. A Platform Perspective supplies trust either by `"none"` or a future non-finance resolver arm — **never forced through a financial DTO**. Specialization boundary documented; nothing built.

## 13. OPS-5 authority preservation (Parts 14, 15)

S1–S5 canonical ownership **unchanged**; decomposition is composition only. Widgets still self-fetch their `/platform-ops/*` routes; the composition/render layer imports/recomputes **no** authority (guard-tested). Integration-gate follow-ups honored: provider-health JobRun-metric duplication **not** touched (S6 offered no clean shared primitive; deferred to S7); S5 `provider-unhealthy` still consumes connection-health (no superior path emerged); dispatcher SPOF documented, not solved.

## 14. PlatformSpaceDashboard reduction metrics (Part 16)

| Metric | Before | After |
|---|---|---|
| Overview cards | 9 (all capabilities) | 6 summaries + doorways |
| Primary destinations | 1 (Overview only) | 5 Workspaces (OPS) |
| Render branching | flat grid | flat registry render + rail select (no switch chain) |
| Dead placeholder subsystem | present | removed |
| Manual Operations (WRITE) in landing grid | yes | no (own Workspace) |
| Fetch ownership | widgets self-fetch | unchanged (self-fetch) |

No new Platform mega-workspace. Overview is no longer the permanent home of every capability.

## 15. Tests (Part 18)

`lib/platform/workspaces.test.ts` (behavior/type-level, per "avoid brittle source scans where behavior tests work") pins: every Platform destination resolves to a Workspace in the **universal** registry · one composition owner (composition ⊆ declared sections, nothing orphaned) · Overview is a summary (no Manual Operations / no connection+API detail; has doorways) · detail lives in its Workspace · no finance vocabulary on Platform defs · **no fake operational Perspective ships** · navigation uses the shared SpaceShell · authorities consumed not recomputed · no customer space-authz import. Existing `workspace-definition.test.ts` scoped its exhaustive standard-set to the finance domain (Platform standard workspaces now coexist).

## 16. Validation (Part 19)

`tsc --noEmit` clean · `eslint` clean · `npm run test:unit` **274/274** (incl. Financial Doctrine Oracle, platform policy/surface tests, workspace-registry + SpaceShell + Perspective foundation tests). Browser smoke: **blocked** (localhost auth wall — house constraint); navigation validated via the type/behavior tests + tsc instead.

## 17. Remaining blockers for S7 (Operational History)

No blockers from this wave — the seam is ready. S7 needs: (a) a dated operational **rollup** substrate (the PlatformSnapshot idiom over `JobRun`/`ApiUsageCounter`/errors), and (b) an operational **temporal model** distinct from the finance asOf/compareTo reducer.

## 18. Exact seam S7 must fill

1. **Rollups:** dated operational facts (job success-rate/punctuality, provider quota/error/latency curves) — recompute-and-compare verified, single definition site.
2. **Operational time model:** a non-finance temporal/comparative contract (the finance `TimePreset`/asOf/compareTo does not fit; do not reuse verbatim).
3. **Host gate:** render the `PerspectiveShell` time-&-trust bar only when `consumesShellTime` (today unconditional) — so an operational Perspective with `consumesShellTime:false` shows no finance time bar.
4. **Ratchet amendment:** the `perspective + widgets ⟹ consumesShellTime:true` doctrine ratchet (`workspace-definition.test.ts`) must admit an operational Perspective (or a new `domain:"platform"` carve-out).
5. **Registration:** a `kind:"perspective"`, `domain:"platform"` workspace with `envelope:"none"` (or a non-finance resolver arm) — already type-representable; composed into `PLATFORM_AREA_WORKSPACES` when its substrate exists.

## 19. Concurrency note (honest record)

This wave ran while a concurrent session was heavily rewriting the branch (a large investments refactor + a docs restructuring), actively mutating the shared git index/HEAD. An initial checkpoint commit inadvertently swept 3 **pre-staged** concurrent file-deletions (a `git commit` without an explicit pathspec) — producing a momentarily inconsistent commit. It was detected and **fully corrected**: the commit was reset and re-created as `da6a539` containing **exactly the 6 S6 files** (verified: no concurrent deletions, tree = parent + additive S6). The final commit used an explicit pathspec. Lesson reaffirmed (concurrent-branch discipline): on a shared branch, always `git commit -- <pathspec>`, never a bare `git commit`.

---

## Final verdict

```
Platform Workspace decomposition complete?          YES
Overview reduced to summary responsibility?         YES
Universal Workspace architecture reused?            YES
Parallel Platform Workspace architecture eliminated? YES  (none introduced; universal registry + SpaceShell reused)
Platform authz preserved?                           YES  (PlatformGrant only; no SpaceMemberRole)
OPS-5 authorities preserved?                        YES  (composition only; consumed, not recomputed)
Operational Perspective foundation established?     YES  (seam + S7 contract documented)
Any fake Perspective shipped?                       NO   (guard-tested)
Ready for Wave B / S7 Operational History?          YES
```

**Commit:** `da6a539` refactor(platops): OPS-5 S6 — decompose Platform Operations into Workspaces on the universal registry. Wave A = S6 (code) + S8 (foundation: guard tests + this report). Not pushed. S7/S9/S10 not started.
