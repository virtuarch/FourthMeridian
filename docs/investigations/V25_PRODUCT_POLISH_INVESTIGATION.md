# v2.5 Product Polish — Investigation Report

**Status:** Investigation only — no code, schema, migrations, or file regeneration. Findings and plan for approval.
**Date:** 2026-07-02
**Branch:** `feature/v2.5-spaces-completion`
**Baseline:** v2.4.5 tagged (`v2.4.5`), Phase 2 architecture merged into `main`.
**Authority note:** This report defers to `STATUS.md` for current state and to `PHASE_2_DECISION_MATRIX.md` for D1–D14. Where the ten requested review categories cross an approved milestone boundary, this report says so rather than re-litigating the approved roadmap (`docs/ROADMAP_REVISION_PROPOSAL_2026-07.md`).

---

## 0. How to read this report

The request asked for a broad "architecture-complete → polished product" sweep across ten categories. The project already has an approved milestone ladder in STATUS.md §5:

> v2.4.5 (honest) → **v2.5 Spaces Completion + Design Foundation** → v2.5.5 Financial Intelligence (data semantics) → v2.6a Advisor Intelligence → v2.6b Ambient Intelligence → v3.0 Launch.

The ten review categories do **not** all belong to v2.5. Several map cleanly onto later, already-scoped milestones. The most useful thing this investigation can do is (a) inventory the real remaining work found in the code, and (b) sort each item into the milestone whose exit criteria it actually serves — so v2.5 stays the focused seam-closure-plus-design-foundation release its charter says it is, and does not silently absorb v2.6/v3.0 scope.

The single most important framing conclusion: **v2.5's charter is already correct. The risk is not under-scoping v2.5 — it is over-scoping it** by pulling AI conversation polish, admin build-out, and launch surfaces forward into it.

---

## 1. Overall product assessment

Fourth Meridian is an unusually well-architected pre-launch personal-finance platform. The expensive-to-retrofit foundations — multi-tenant Spaces, HKDF encryption, a single auth chokepoint, a single LLM provider seam, deterministic-first AI, soft-delete lifecycle — are built and enforced. STATUS.md's self-assessment ("architecture maturity high for its stage; launch readiness not yet, by design; the gap is verification, not features") is accurate and matches what the code shows.

The gap between "architecture-complete" and "polished product," concretely, is **three distinct kinds of debt**, and they should not be conflated:

1. **Migration seam debt** (the true v2.5 core). SpaceAccountLink dual-writes but WorkspaceAccountShare still exists; legacy `Account` still feeds some read paths. This is invisible to users but blocks everything built on top of it. Closing it *is* v2.5's charter.
2. **Surface-completion debt.** Whole Space tabs render `SpaceComingSoonPanel` (Finances, Documents, and Transactions on shared Spaces); several Perspectives are `comingSoon`; the Timeline is padded with `FUTURE_TIMELINE_EVENTS` preview rows. These are honest placeholders, well-labeled, but they are visible holes a launched product cannot have.
3. **Design-language debt.** Two visual systems coexist. New surfaces use Atlas Glass tokens (`var(--meridian-*)`, `var(--surface-muted)`, `GlassPanel`); older surfaces (settings, admin, auth) use raw Tailwind (`bg-gray-800`, `text-white`, `bg-blue-600`). Measured: **68 of 127** `.tsx` files use raw Tailwind grays; **42** use Atlas tokens. This is the "design foundation" half of v2.5.

The product is closer to launch than most at this stage on architecture, and further than it looks on surface polish — because the polish debt is concentrated in exactly the surfaces (shared Spaces, settings, onboarding) that a real first user touches first.

---

## 2. Category-by-category findings

### 2.1 Spaces completion

Evidence: `lib/space-nav.ts`, `lib/space-presets.ts`, `lib/perspectives.ts`, `components/dashboard/SpaceDashboard.tsx` (2,286 lines), `components/dashboard/DashboardClient.tsx` (1,446 lines), `components/dashboard/widgets/*`, `lib/timeline-placeholder.ts`.

The Space skeleton is fixed and correct: a nine-tab rail (`SPACE_TAB_ORDER`) shared by every Space type, with per-type module enable/disable rather than per-type tab reordering. What is unfinished:

- **Placeholder tabs.** `PLACEHOLDER_SPACE_TABS = ["FINANCES", "DOCUMENTS"]` render `SpaceComingSoonPanel`. **Transactions also renders the placeholder on shared/non-personal Spaces** — it is real only in the Personal Space via `DashboardClient` → `SpaceTransactionsPanel`. So three of nine tabs are empty on a shared Space.
- **Perspectives half-built.** `PERSPECTIVE_LIBRARY` has 9 lenses; 5 are `comingSoon` (Wealth, Cash Flow, Tax, Property, Business Health) and render a placeholder card. The 4 `available` lenses (Investments, Debt, Retirement, Goals) are just routed entry points to existing tabs, not new views.
- **Timeline is preview-padded.** `SpaceTimelineWidget` merges real activity-route events with `FUTURE_TIMELINE_EVENTS` (8 `isPreview: true` rows). The `ALLOWED_ACTIONS` allowlist in `app/api/spaces/[id]/activity/route.ts` has no producers for transaction / document / account-linked / AI-recommendation / recurring-payment / investment-milestone / reminder events. Honest, badged, but visibly synthetic.
- **Members experience is read-mostly.** `SpaceMembersWidget` is a real read-only roster; all mutation (invite, remove, role change) lives in `ManageSpaceModal`. Works, but the Members *tab* is a viewer, not a management surface — role changes require opening a modal.
- **Empty states are strong where they exist** (net worth / debt / investments / trip / emergency-fund / retirement all have `emptyHeadline`/`emptySubline`/`emptyIcon`). Gaps are the placeholder tabs above, which are "coming soon," not true empty states.
- **Public Space joining** is disabled: `SpacesClient` shows "Public joining is coming soon."
- **Hygiene:** committed Finder-duplicate dirs `components/space/sections 2/` and `components/space/widgets 2/` (empty) — same KD-13 class the v2.4.5 cleanup targeted; two stray dirs slipped the net.

Prioritized Spaces roadmap (highest first): (1) Transactions on shared Spaces — it's the highest-traffic tab and already real in Personal, so this is wiring, not net-new; (2) Members tab inline role management; (3) Timeline real producers for the event types that already have backend signals (account_linked, ai_recommendation) so the preview padding can shrink; (4) Finances tab (the single "roll-up" lens shared Spaces most want); (5) Documents tab (needs a storage decision — heavier, defer); (6) the `comingSoon` Perspectives, cut Wealth/CashFlow first since their data already exists.

### 2.2 Dashboard polish

Evidence: `components/dashboard/*Client.tsx`, `components/charts/*`, `components/atlas/*`.

- **Two dashboard implementations** (`DashboardClient` for Personal, `SpaceDashboard` for everything else) carry divergent internal tab vocabularies ("credit" vs "DEBT") that `lib/perspectives.ts` explicitly documents as historical and leaves alone. This is duplicate-logic debt: KPI rows, empty states, and tab gating are implemented twice. Not a v2.5 refactor target per the freeze, but the single biggest source of "why does this Space look slightly different" inconsistency.
- **Loading/skeleton states are thin and inconsistent.** 34 files reference any loading affordance; most are `Loader2` spinners, not skeletons. There is **no route-level `loading.tsx`** anywhere in `app/`, so navigations show nothing until the client hydrates.
- **No error boundaries.** There is **no `error.tsx` or `not-found.tsx`** in the App Router tree. An unhandled render or fetch error in any dashboard surface takes down the segment with the default Next.js error, not a branded recovery.
- **Chart first-day handling is good** — `ChartFirstDayPlaceholder` is reused across Cash / Portfolio / NetWorth / Investments / Banking charts, a genuine reuse win.
- Glass styling itself is clean where applied (`GlassPanel` depth/elevation/radius props); the inconsistency is *coverage*, not *quality*.

### 2.3 AI experience

Evidence: `app/api/ai/chat/route.ts`, `lib/ai/*`, `components/dashboard/AnalyzeClient.tsx`, `KnowledgeAcquisitionCard.tsx`, STATUS.md §3 (AI-4/AI-5), §7 (KD-8/16/17/18).

The AI *engine* is the product's differentiator and is already deterministic-first and honesty-gated (KD-2 live enforcement, KD-17/18 fixed). The AI *experience* gaps are almost entirely **already scoped into v2.6a (AI-5)** and should not be pulled into v2.5:

- Silent time-window changes, contradictory availability claims across intent paths (KD-16), the "max 50 messages" raw-error leak, confidence/completeness propagation, master-mode silent Space omission (KD-8) — all v2.6a charter.
- The one UX-only, non-architectural item that could ride v2.5 as design-foundation work: the AI surfaces (`AnalyzeClient`, the Brief's "Today's Insight" shimmer) are visually distinct but the *entry points* to AI are inconsistent — there is an "AI" bottom-nav tab, an `advice` page, and an `analyze` page, and their relationship is unclear. Consolidating AI entry points is UX, not architecture. Flag for v2.5 design foundation, but only the routing/labeling, not behavior.

Recommendation: resist adding AI features in v2.5. The roadmap doctrine ("may not speak unprompted until it can hold a coherent conversation") is deliberate. v2.5 AI work = zero behavior change, at most entry-point consolidation.

### 2.4 Financial UX

Evidence: `app/(shell)/dashboard/{accounts,banking,holdings,investments,credit,history,analyze}`, `lib/data/transactions.ts`, `components/charts/*`, `components/dashboard/{AccountCard,DebtCard,NetWorthCard,InvestmentsCard,CashOnHandCard,FicoCard}.tsx`.

The surfaces exist and are backed by real data. The refinements the request lists are real and mostly belong to **v2.5.5 Financial Intelligence** (data semantics), not v2.5:

- **Pending vs settled, projected balances, per-liability attribution** — these are `flowType`/transaction-semantics work explicitly owned by v2.5.5 (`TRANSACTION_FLOW_CLASSIFICATION_INVESTIGATION.md`, KD-18 destination attribution). Do not build them in v2.5.
- **Freshness / refresh status** — there is manual-refresh cooldown and sync plumbing, but no consistent per-account "last updated / stale" freshness indicator on the cards. This is UI-only and could ride v2.5 design foundation.
- **Account diagnostics** — exists for admins (`app/api/admin/plaid/diagnostics`) but not surfaced to end users (a "why is this account not syncing" user-facing state). Small, UX-only, v2.5-eligible.
- **Empty states** on the financial dashboards are generally present (see 2.1). **Historical navigation** (scrubbing further back than the default window) is limited by the 5,000-row fetch cap (KD-7, now *honest* but not *removed*); true deep history is a v2.5.5+ data concern.

v2.5-eligible financial UX = freshness indicators + user-facing account diagnostics. Everything else = v2.5.5.

### 2.5 Settings

Evidence: `components/dashboard/SettingsClient.tsx` (525 lines), `app/(shell)/dashboard/settings/`, `TotpSection.tsx`, `app/api/user/*`.

Settings is the **thinnest surface relative to a launched product's expectations.** What exists: profile fields (name, employment, financial goal), password change, TOTP + recovery codes, and a separate archived-assets page. What is **missing** against the request's checklist:

- **Notifications** — none (no preferences, no channels; ambient notifications are v2.6b anyway, but the *settings scaffold* doesn't exist).
- **AI controls** — none (no data-use toggle, no "let AI see this Space," no advisory-mode preference).
- **Integrations** — no user-facing connections management in settings (Plaid connections are managed per-account, not centrally).
- **Import/export** — CSV *import* exists per-account; no data *export* / "download my data" anywhere.
- **Privacy** — no privacy/data-retention controls or disclosure surface (also a v3.0 legal item).
- **Audit visibility** — the append-only audit log is admin-only; users cannot see their own login/session history beyond active-session revocation (`app/api/user/sessions`).
- **Preferences** — no theme toggle (light theme tokens `--paper-*` are defined but "reserved for future"), currency, or locale controls.
- **Styling debt:** `SettingsClient` is entirely raw Tailwind (`bg-blue-600`, `text-white`, `bg-gray-800`) — a prime v2.5 design-foundation reskin target and a good pilot for the token migration.

Settings needs a v2.5 *scaffold* (sectioned shell: Account / Security / Preferences / Privacy / AI) even though several sections' *contents* land in v2.6b/v3.0. Building the shell now prevents a settings rewrite later.

### 2.6 Admin experience

Evidence: `app/admin/{security,providers,spaces,users,audit,workspaces}`, `app/api/admin/*`.

Admin is more complete than settings: security (per-user 2FA reset, sessions, recovery codes), providers (with diagnostics), spaces, users, and a real searchable audit log. Gaps for public launch:

- **Naming drift:** `app/admin/workspaces/page.tsx` still exists post-Workspace→Space rename. Either it's a dead leftover or a not-renamed surface; either way it contradicts the completed rename baseline. Investigate and retire/rename.
- **Provider actions are stubbed:** `ProviderActionsButton` has "Force Sync" and "Disconnect" disabled with "Coming soon" — admins can diagnose but not act.
- **No admin-visible system health** (sync backlog, error rates, LLM token spend) — STATUS.md's own "observability counters" are a v2.4.5 item that landed as counters, but there is no admin *view* of them.
- Admin styling is raw Tailwind gray throughout — lower priority than user-facing reskin.

Before public launch, admin needs: provider actions live (force-sync/disconnect), a support-oriented user lookup ("this user reports X"), and the workspaces-page disposition. Most of this is L-1/v3.0, not v2.5.

### 2.7 Design system audit (Atlas Glass)

Evidence: `app/globals.css` (canonical tokens), `docs/design-system/Fourth-Meridian-Design-Language-v1.html`, `components/atlas/*`, token-vs-raw grep.

The token system is well-defined and disciplined (Atlas Ink / Brass / Meridian / Emerald / Coral / Violet ramps; radius, spacing 8pt, motion, shadow, AI-motion tokens; globals.css explicitly forbids inventing tokens outside the design-language doc). The problem is **adoption, not definition**:

- **68/127 `.tsx` files use raw Tailwind grays; 42 use Atlas tokens.** The split correlates with surface age: auth, settings, admin = raw; Spaces widgets, charts, atlas primitives = tokens.
- **Duplicated color intent:** `bg-gray-800`/`bg-gray-900` in legacy surfaces vs `var(--surface-muted)`/`var(--ink-800)` in new ones — same visual role, two sources of truth.
- **Component reuse opportunities not yet taken:** buttons are `GlassButton` in new surfaces but hand-rolled `bg-blue-600 rounded-xl` in settings/auth. Same for inputs (`AtlasField` vs raw `<input className="bg-gray-900 border...">`).
- **No refactor mandate** per the freeze — the correct v2.5 move is "**all new surfaces in the new language, plus reskin the highest-traffic legacy surfaces (settings, auth) as design-foundation pilots**," not a 68-file sweep.

### 2.8 Performance

Evidence: dashboard client sizes, data-layer reads, chart components.

- **Monolith client components:** `SpaceDashboard.tsx` (2,286 lines) and `DashboardClient.tsx` (1,446) are large single client bundles doing all tab rendering. STATUS.md already notes "monolith component decomposition rides along" with v2.5 — this is the main render-cost lever. Decomposition (code-split per tab) would cut initial hydration cost.
- **No route-level streaming/loading** (no `loading.tsx`) means no Suspense boundaries — everything waits for the client.
- **Read-path duplication:** legacy `Account` still queried alongside SAL in some paths (the exact seam v2.5 closes) means some assemblers do redundant work against two sources of truth.
- **Optimistic updates** are largely absent — mutations (share account, role change, goal check-in) appear to refetch rather than update in place. UX-only opportunity, low risk.
- No evidence of caching beyond `lib/session-cache.ts` (session revocation cache) and `lib/snapshots`. Query-level caching is a v2.6b/v3.0 concern, not v2.5.

### 2.9 Mobile audit

Evidence: `components/ui/BottomNav.tsx`, `components/ui/DashboardChrome.tsx`, `lg:hidden`/responsive usage.

- **Mobile IA is intentional and sound:** `BottomNav` collapses to 4 destinations (Brief / Spaces / AI / Settings), uses tokens correctly, `/dashboard/spaces` carries the full Spaces experience on mobile. This is the strongest "unfinished-area" surprise — mobile nav is *finished* and token-clean.
- **Risk areas** (need device testing, not inferable from code alone): the two monolith dashboards render the same dense KPI rows / multi-column panels on mobile; overflow/clipping on the KPI strip and chart panels is the likely failure mode. The nine-tab rail on a Space almost certainly needs horizontal scroll or overflow handling on narrow viewports.
- **Touch targets:** the inline-edit affordances in `SettingsClient` (small `px-2.5 py-1` buttons) are below the 44px comfortable target.
- **Keyboard behavior** on the AI chat and forms is untested from code; the fixed `BottomNav` (`fixed bottom-0`) will overlap the keyboard on mobile chat unless handled.

Mobile needs an actual on-device pass (v3.0 polish per STATUS.md), but the KPI-strip overflow and tab-rail overflow are worth a v2.5 spot-check since v2.5 touches those surfaces anyway.

### 2.10 Launch readiness

Evidence: `app/` route tree, grep for legal/analytics/billing/onboarding.

Confirmed **absent** (all consistent with STATUS.md L-1 / v3.0 scope — none are v2.5):

- **No landing/marketing page** — root `/` redirects straight to `/dashboard/brief`.
- **No legal pages** — no privacy policy, no terms of service anywhere in `app/`.
- **No onboarding funnel** — registration goes straight to the app; no guided first-run.
- **No waitlist** surface.
- **No analytics/telemetry/monitoring** — no Sentry/PostHog/Datadog; the grep hits are transaction-category keyword lists, not instrumentation.
- **No billing** — correctly, per the D10 ban that lifts only at v3.0.
- **Backups/monitoring/logging/support** — operational, not in-repo; tracked as L-1.

These are correctly deferred. The one launch-readiness item worth starting early (per STATUS.md) is the **Plaid production application**, which has the longest external lead time and should begin during the v2.6 window.

---

## 3. Remaining gaps — consolidated

| # | Gap | Category | Milestone (per STATUS.md discipline) |
|---|---|---|---|
| G1 | WorkspaceAccountShare still present; legacy `Account` in read paths | Seam | **v2.5 (core)** |
| G2 | Visibility tiers not enforced in *every* assembler; two-user BALANCE_ONLY proof | Seam/privacy | **v2.5 (exit criterion)** |
| G3 | Transactions tab placeholder on shared Spaces | Spaces | **v2.5** |
| G4 | Members tab is read-only; inline role mgmt missing | Spaces | **v2.5** |
| G5 | Timeline padded with preview events; few real producers | Spaces | v2.5 (partial) / v2.6b (producers) |
| G6 | Finances & Documents tabs placeholder | Spaces | v2.5 (Finances) / defer Documents |
| G7 | 5 Perspectives `comingSoon` | Spaces | v2.5 (Wealth/CashFlow) / later |
| G8 | Design-language split (68 raw vs 42 token files) | Design | **v2.5 (foundation) — reskin settings/auth pilots** |
| G9 | No route `loading.tsx` / `error.tsx` / `not-found.tsx` | Dashboard/robustness | **v2.5 (cheap, high-value)** |
| G10 | Settings missing notifications/AI/privacy/export/audit-visibility scaffold | Settings | v2.5 (shell) / v2.6b–v3.0 (contents) |
| G11 | Freshness indicators + user-facing account diagnostics | Financial UX | v2.5 (UI-only) |
| G12 | Pending/settled, projected balances, per-liability attribution | Financial UX | **v2.5.5 (do not pull forward)** |
| G13 | AI conversation quality (KD-8/16, silent windows, max-50) | AI UX | **v2.6a (do not pull forward)** |
| G14 | Monolith dashboards (2,286 / 1,446 lines) | Perf | v2.5 (decomposition rides along) |
| G15 | Admin: provider actions stubbed; `admin/workspaces` leftover; no health view | Admin | v2.5 (workspaces disposition) / v3.0 (rest) |
| G16 | Mobile KPI/tab-rail overflow spot-check | Mobile | v2.5 spot-check / v3.0 full pass |
| G17 | Landing, legal, onboarding, waitlist, telemetry, billing, support | Launch | **v3.0 (L-1)** |
| G18 | Committed empty `sections 2/` `widgets 2/` dirs | Hygiene | v2.5 (trivial) |

---

## 4. Prioritized roadmap

The prioritization principle: **close the invisible thing that blocks everything (seams) first, then the visible holes a first user hits (shared-Space tabs, settings shell, robustness), then the foundation that makes future work cheaper (design tokens, decomposition) — and refuse everything that belongs to a later, already-gated milestone.**

**Tier 0 — do first, unblocks the milestone (v2.5 core):**
1. G1/G2 SAL read-cutover + WorkspaceAccountShare retirement + legacy-`Account` removal from read paths, with the two-user BALANCE_ONLY end-to-end test. This is the v2.5 exit criterion; nothing else in v2.5 should merge before the seam plan is approved.

**Tier 1 — visible holes, high traffic (v2.5):**
2. G3 Transactions on shared Spaces (already real in Personal — wiring, not net-new).
3. G9 Route-level `loading.tsx` / `error.tsx` / `not-found.tsx` (cheap, disproportionately raises perceived polish and robustness).
4. G4 Members tab inline role management.
5. G8 (pilot) Reskin Settings + Auth to Atlas tokens — doubles as the token-migration proof and fixes the thinnest, ugliest surfaces.

**Tier 2 — foundation & completion (v2.5):**
6. G10 Settings *shell* (sectioned: Account / Security / Preferences / Privacy / AI) — scaffold only.
7. G6 Finances tab (single roll-up lens).
8. G11 Freshness indicators + user-facing account diagnostics.
9. G14 Monolith decomposition (per-tab code-split) — rides along, reduces render cost.
10. G18 + G15 (workspaces disposition) hygiene.

**Tier 3 — stretch, cut first if v2.5 runs long (charter says "cut first"):**
11. G5 Timeline real producers for already-signalled events (account_linked, ai_recommendation).
12. G7 Wealth / Cash Flow Perspectives.
13. G16 Mobile overflow spot-check on touched surfaces.
14. G6 Documents tab — **defer** (needs a storage-architecture decision; heaviest, least core).

**Explicitly NOT in v2.5** (belongs to a gated later milestone; pulling forward violates the roadmap):
- G12 transaction semantics → **v2.5.5**
- G13 AI conversation quality → **v2.6a**
- Timeline producers requiring the scheduler, notifications, AI Inbox → **v2.6b**
- G17 launch surfaces (landing/legal/onboarding/telemetry/billing/support) → **v3.0**

---

## 5. Recommended v2.5 milestones (sub-milestones within the release)

Keeping v2.5's charter intact, split it into four internally-gated sub-milestones so seam work and UI work don't entangle:

- **v2.5-A — Seam closure (the gate).** G1/G2. Exit: zero `WorkspaceAccountShare` reads, zero legacy-`Account` reads in AI/read paths, two-user BALANCE_ONLY proof green. *Nothing in B/C/D merges until A's plan is approved and A's tests are green* — this preserves "additive before subtractive."
- **v2.5-B — Design foundation.** G8 pilot reskin (Settings + Auth) + confirm every *new* surface in B/C/D uses Atlas tokens + `GlassButton`/`AtlasField`. Exit: settings/auth token-clean; a documented "new surfaces use tokens" rule enforced in review.
- **v2.5-C — Shared-Space completion.** G3 Transactions, G4 Members inline mgmt, G6 Finances, G11 freshness/diagnostics, G10 settings shell. Exit: no `SpaceComingSoonPanel` on Transactions/Finances for shared Spaces; settings shell shipped.
- **v2.5-D — Robustness & hygiene.** G9 route error/loading boundaries, G14 decomposition, G18/G15 hygiene, G16 mobile spot-check. Exit: every dashboard segment has a loading and error boundary; no committed `" 2"` dirs; workspaces page disposed.

Stretch (Timeline producers, Wealth/CashFlow Perspectives) attach to C/D and are cut first.

---

## 6. Suggested implementation order

Per the project working style — checklist → approval → implement one thing → validate (`prisma generate`, `migrate dev` if schema changed, `tsc --noEmit`, `lint`, targeted route/UI test) — and "additive before subtractive":

1. **v2.5-A seam plan** — impact map + rollback + validation checklist for SAL read-cutover, *before any code*. Additive: make SAL the sole read path behind a flag; verify parity; *then* retire WAS (subtractive) in a separate commit. Ship the two-user BALANCE_ONLY test first as the guardrail.
2. **Route robustness (G9)** — `loading.tsx`/`error.tsx`/`not-found.tsx`. Pure-additive, no dependencies, immediate polish; land early to derisk everything after it.
3. **Settings + Auth reskin (G8 pilot)** — establishes the token-migration pattern on contained, low-risk surfaces before touching dashboards.
4. **Transactions on shared Spaces (G3)** — reuse `SpaceTransactionsPanel`; depends on v2.5-A parity so it reads the single source of truth.
5. **Members inline mgmt (G4)** — additive to the existing `ManageSpaceModal` mutations.
6. **Settings shell + Finances tab + freshness/diagnostics (G10/G6/G11).**
7. **Decomposition (G14)** — after C's surfaces are stable, so decomposition refactors known-good code.
8. **Hygiene + mobile spot-check (G18/G15/G16).**
9. Stretch items, or defer to v2.5.5/v2.6.

Each numbered item is one checklist → one approval → one implementation → one validation cycle. Do not batch.

---

## 7. Risks

- **Scope creep is the primary risk.** The ten-category request naturally pulls v2.5.5 (financial semantics), v2.6a (AI conversation), and v3.0 (launch) work into v2.5. The single biggest way to hurt this project is to let v2.5 become "polish everything." Hold the line: v2.5 = seams + design foundation + shared-Space completion.
- **Seam-closure regression risk.** Retiring WorkspaceAccountShare and legacy `Account` is subtractive against live read paths. Mitigation: additive-first (SAL sole reader behind a flag with parity tests) before any deletion; the two-user BALANCE_ONLY test as a merge gate. This is the one v2.5 item that can leak private financial data if done wrong — treat it as the privacy-critical change it is.
- **Design reskin scope explosion.** 68 files is a sweep temptation. Mitigation: pilot two surfaces (settings, auth) + "new surfaces only" rule; do not mandate a full migration in v2.5.
- **Monolith decomposition risk.** Refactoring 3,700 lines of dashboard client code can regress tab behavior. Mitigation: do it *after* those surfaces are otherwise stable (v2.5-D), behind characterization coverage, never mixed with feature work.
- **Solo-maintainer bus factor** (STATUS.md standing risk) — four sub-milestones is a lot for one person; the internal gating (A before B/C/D) is what keeps it shippable in slices.
- **Documents-tab rabbit hole** — building it needs a file-storage/security decision that is really its own initiative. Risk it silently expands v2.5. Mitigation: explicitly defer.
- **Mobile unknowns** — code review can't confirm overflow/keyboard behavior; there is real risk the monolith dashboards break on narrow viewports. Mitigation: on-device spot-check in v2.5-D; full pass stays v3.0.

---

## 8. Items that should wait until v3.0 (and the intermediate milestones)

**Wait for v2.5.5 (Financial Intelligence):** pending vs settled, projected balances, per-liability/per-card attribution, transaction `flowType`, deep historical navigation, category-semantics refinements (KD-17 side findings). All data-semantics; building them on the pre-seam-closure read path means building them twice.

**Wait for v2.6a (Advisor Intelligence):** all AI conversation-quality work — silent window disclosure (KD-16), master-mode omission disclosure (KD-8), graceful compression (retiring max-50), confidence propagation. The roadmap doctrine gates ambient/advisor behavior behind conversation coherence; v2.5 must not add AI behavior.

**Wait for v2.6b (Ambient Intelligence):** scheduler substrate, AiAdvice write path, Daily Brief generation, signals→notifications, AI Inbox, Timeline producers that depend on the scheduler, notification preferences (the settings *shell* is v2.5; its *contents* here). Start the Plaid production application during this window.

**Wait for v3.0 (Launch / L-1):** landing/marketing page, legal pages (privacy policy, terms — external counsel; remove "financial advisor" framing; LLM data-processing disclosure), onboarding funnel, waitlist, telemetry/analytics/monitoring instrumentation, tested backups + incident response + alerting, support tooling, billing/subscription (D10 ban lifts *only* here), admin provider-actions-live + system-health view, full mobile polish pass, light theme (`--paper-*` tokens are reserved for it). Zero new product surface at v3.0 by charter — these are the enabling wrappers, not new app depth.

**Stay parked (STATUS.md §8, unchanged):** Marketplace/SpaceTemplate (D9), internal-ops Spaces (D12), ProviderAdapter abstraction, PublishedAccountView, second sync provider, agents/automation, Decimal/int-cents money migration (plan in v2.5, execute post-v2.6b).

---

## 9. One-paragraph recommendation

Keep v2.5 exactly as chartered — Spaces Completion + Design Foundation — and resist the gravity of the broader polish request. Execute it as four internally-gated slices: close the SAL/WAS/legacy-`Account` seam first (privacy-critical, additive-before-subtractive, gated on a two-user BALANCE_ONLY test), then add route error/loading boundaries and reskin settings+auth as the design-foundation pilot, then finish the shared-Space tabs (Transactions, Members management, Finances) and stand up a settings shell, then decompose the monolith dashboards and clean up. Push transaction semantics to v2.5.5, AI conversation quality to v2.6a, ambient intelligence to v2.6b, and every launch surface to v3.0 — each already has a milestone whose exit criteria it serves. The product's architecture is genuinely ahead of its stage; its remaining distance to "polished" is surface-completion and design-language adoption in exactly the surfaces a first user touches, and that is precisely what a disciplined v2.5 delivers.
