# SP-2A — Unified Space Shell Investigation

**Date:** 2026-07-08
**Type:** Investigation only — no implementation, no schema, no migrations, no STATUS/ROADMAP edits.
**Predecessor:** SP-1 (complete — `lib/space-templates/` registry + planner + tests, zero runtime change).
**Companions:** `SP-1_SPACE_TEMPLATE_FOUNDATION_INVESTIGATION_2026-07-08.md`, `PARALLEL_WORKSTREAM_INVESTIGATION_2026-07-08.md`.

---

## 1. Executive summary

The divergence is real, and it is **two divergences, not one**. The *visible* one — the Personal rail is a single-segment "Overview" pill plus a "More" dropdown, while shared Spaces get a full pill rail — is small, deliberate (a documented "Personal rail tab-cleanup pass"), and fixable with a surgical edit inside `DashboardClient` alone. The *structural* one is much deeper: Personal Spaces have **zero `SpaceDashboardSection` rows** (the register route has never created them), render through a completely separate 1,575-line host (`DashboardClient`) with server-fetched props, hardcoded overview content, and a legacy lowercase tab vocabulary — while shared Spaces render through `SpaceDashboard` (2,692 lines) driven by materialized section rows and the `SectionRegistry`.

The good news: the codebase has been converging these hosts for several passes already. Both draw tab order/copy from `lib/space-nav.ts` (which explicitly names both hosts), both use the Atlas `SegmentedControl`, both share `PerspectivesWidget`, `PerspectiveSwitcher`, `SpaceTransactionsPanel`, and the timeline components. The skeleton contract exists; Personal just doesn't fully honor it yet.

**Recommended path (smallest safe):** unify in three independently shippable stages — (1) rail parity inside `DashboardClient` only (kills the one-pill + dropdown split, zero data change, zero `SpaceDashboard` contact); (2) materialize Personal sections at registration via the SP-1 planner + an idempotent backfill script (the exact `backfill-ai-agents.ts` precedent — no schema, no runtime fallback ambiguity); (3) only then, as a separate initiative-sized slice, move Personal's overview body onto the `SpaceDashboard` shell — the M–L piece that should be sequenced around TI because `SpaceDashboard.tsx` is a TI-adjacent shared file. Stages 1–2 are SP-2A; stage 3 can trail SP-2 without blocking it. **SP-2's template picker does not depend on any of this** — it touches `CreateSpaceModal` and the create route, which never run for Personal.

---

## 2. Current divergence map

Everything verified in the working tree.

**2.1 The fork.** `app/(shell)/dashboard/page.tsx` resolves the active Space from the cookie (`getSpaceContext()`, falls back to Personal) and branches on `ctx.space.type === "PERSONAL"`:
- Personal → `DashboardClient` with **server-fetched props** (accounts, holdings, snapshots, advice, FICO, debt transactions, transactions, moneyCtx).
- Everything else → `SpaceDashboard` with only identity props (`spaceId`, name, category, role…) — it **client-fetches** sections/accounts/goals/snapshots from `/api/spaces/[id]/*`.

One route, two dashboards. This is the root of every other divergence.

**2.2 Tab model.** A shared vocabulary exists — `lib/space-nav.ts` (`SpaceTabId`, `SPACE_TAB_ORDER`, `SPACE_TAB_LABELS`, `railVisibleTabs(host)` with `host: "personal" | "shared"`) — and *both* hosts import it. But they consume it differently:

| | Shared (`SpaceDashboard`) | Personal (`DashboardClient`) |
|---|---|---|
| Rail source | `railVisibleTabs("shared")` minus SETTINGS-for-non-managers minus TIMELINE (modal launcher) → **full pill rail** (Overview, Perspectives, Accounts, Transactions, Members, [Settings]) | Hand-rolled `PERSONAL_TABS = [Overview]` → **single-segment pill**; Accounts/Transactions/Members demoted to a `MoreMenu` dropdown (`ml-auto`); Perspectives reached via inline switcher/links; Settings via header "Manage" |
| Tab ids | `SpaceTabId` directly (+ `SpaceDashboardTab` enum for section placement; GOALS/DEBT/INVESTMENTS/RETIREMENT open as Glass modals via `PERSPECTIVE_ROUTED_TABS`) | Legacy lowercase `PersonalTab` (`"dashboard" \| "banking" \| "credit"…`) bridged by `RAIL_TO_INTERNAL: Record<SpaceTabId, PersonalTab>` |
| Rendering | `SegmentedControl` `w-full` | `SegmentedControl` (one segment) + `PerspectiveSwitcher` (currently hidden — gated to >1 available composition) + `MoreMenu` |

This is exactly the brief's "tabs split between a dropdown and a tab bar / tab bar with only one item." Important nuance: it was done *on purpose* in a "Personal rail tab-cleanup pass" (comment at `DashboardClient.tsx:145`) and explicitly left `SPACE_TAB_ORDER` untouched for other Spaces. SP-2A reverses a deliberate presentation decision, not an accident — the doctrine ("templates change content, not skeleton") now outranks that trim.

**2.3 Section model.** Shared Spaces render DB-materialized `SpaceDashboardSection` rows through `SectionRegistry` (`SpaceDashboard.tsx:1076`), filtered by `s.tab === activeTab`. Personal renders **no sections at all** — overview content is hardcoded JSX (`NetWorthCard` hero, `KpiRow`, `PerspectivesWidget` row, `RecentTransactionsPanel`, banking account sections, `DebtClient` for credit, etc., gated by `filter === …` booleans). `GET /api/spaces/[id]/sections` has **no preset fallback** — it returns exactly the rows, which for every Personal Space is `[]`.

**2.4 Data model.** The register route (`app/api/auth/register/route.ts:120`) creates: Space (`type: "PERSONAL"`, category defaults to `PERSONAL`, reportingCurrency defaults `"USD"`), OWNER `SpaceMember`, `preferredSpaceId`, `AiAgent`. It **never creates `dashboardSections`** — unlike `POST /api/spaces`, which materializes presets for every shared Space. So the `PRESET_MAP[PERSONAL]` entry (net_worth, debt_summary, investment_summary — "kept minimal + real for the SpaceDashboard fallback path") currently materializes only if someone creates a *SHARED* Space with category PERSONAL through the API.

**2.5 Hero/header.** Shared: `SpaceTrendHero` driven by `SpaceSnapshot` rows + header row (name, Manage/Leave buttons). Personal: `NetWorthCard` + KPI tiles computed client-side from account props, plus personal-only surfaces (FICO card, greeting, cash-flow modal) with no widget-registry representation.

**2.6 Adjacent but not the shell:** standalone legacy personal routes (`/dashboard/banking`, `/investments`, `/credit`, `/history`, `/holdings`, `/accounts`, `/analyze`, `/advice`, `/workspaces`) still exist — `BankingClient` is the `/dashboard/banking` page, *not* part of the `/dashboard` shell. Modern nav (Sidebar/BottomNav) links only brief/spaces/AI/connections/settings. These routes are reachable via deep links and internal buttons; they are a *separate* legacy-surface question, not an SP-2A blocker.

**2.7 Already unified (do not touch):** `lib/space-nav.ts` order/copy/host gates (tested — 508 checks in `space-nav.test.ts`), `SegmentedControl`, `PerspectivesWidget` + `getPerspectivesForCategory(category)` (works for PERSONAL), `PerspectiveSwitcher` (identically gated on both hosts), `SpaceTransactionsPanel` (consumed by both), timeline components, `ManageSpaceModal` (used by both; `lib/spaces/policy.ts` already blocks the lifecycle trio on PERSONAL via `sharedOnly`), `CreateSpaceModal` (creates SHARED only — no Personal assumptions).

---

## 3. Desired unified shell definition

The minimum skeleton every Space (including Personal) should share — all of it already existing in `SpaceDashboard`:

1. **Header row** — Space name + role-gated actions (Manage / Leave). Personal keeps Manage, never Leave (policy already handles this).
2. **One rail** — full-width `SegmentedControl` fed by `railVisibleTabs(host)` + documented host-side presentation filters (SETTINGS ⇒ `canManage`; TIMELINE ⇒ modal launcher). **No MoreMenu, no single-segment rail, on any host.** The rail is the skeleton; the doctrine's "Accounts is always third" muscle-memory rule applies to Personal too.
3. **Tab bodies** — Overview = hero slot + section cards from `SectionRegistry`; Perspectives = `PerspectivesWidget` grid; Transactions = `SpaceTransactionsPanel`; Members = `SpaceMembersWidget`; Settings = `SettingsTab` over section rows; Timeline = modal.
4. **Section model** — `SpaceDashboardSection` rows for every Space. **Yes, Personal should have rows**, born from the SP-1 hidden `personal` template. Same `@@unique([spaceId,key])`, same materialized-snapshot semantics.
5. **Empty states** — the widget-owned `emptyHeadline`/`emptySubline` pattern, identical machinery on all hosts; only the *copy* may differ per template (that's SP-2's business, not a second mechanism).
6. **Hero slot** — the one sanctioned divergence point. Personal may keep a richer hero (net-worth + KPI + FICO) rendered *in the hero slot* of the shared shell; shared Spaces keep `SpaceTrendHero`. Content differs; the slot, and everything below it, is identical. Personal-only modules that survive convergence should eventually become registry widgets (per the Widget Primitive Rule in `widget-registry.ts`), not host-hardcoded JSX.

Canonical tab model: `SpaceTabId` / `SPACE_TAB_ORDER`. The lowercase `PersonalTab` vocabulary is transitional plumbing that should shrink until `RAIL_TO_INTERNAL` is deletable.

---

## 4. Personal template recommendation

**Recommend C, built on A — Personal is the hidden `personal` template in the SP-1 registry (already true), and it becomes the *default template applied at registration*.**

- **A is already the case:** SP-1 shipped `personal` as a hidden template whose sections are byte-identical to `getPresetsForCategory(PERSONAL)` (parity-tested). Nothing to decide — only to *use*.
- **C is the endpoint:** the register route materializes `planTemplateApplication(getTemplateForCategory("PERSONAL")… )` output inside its existing transaction — exactly what `POST /api/spaces` does for shared Spaces. Personal becomes a Space born from a template like every other.
- **B (visible in picker): no.** Users cannot create a second Personal Space (`type PERSONAL` is register-only; the create route always makes SHARED). Listing it would offer something the product forbids.
- **D (special-cased forever): no as an end state**, but it *is* the honest description of the transition period — Personal keeps its host until slice SP-2A-4/5 lands. D-as-permanent violates the doctrine this brief exists to enforce.

---

## 5. Data model assessment

**No schema needed. Nothing in unification requires a new table, column, or enum.** Current Personal Space inventory (verified):

| Asset | Present? | Where |
|---|---|---|
| `Space` row | ✓ | register route, `type: "PERSONAL"` |
| `category = PERSONAL` | ✓ | schema default (`@default(PERSONAL)`) — register doesn't set it explicitly |
| `SpaceMember` OWNER | ✓ | register route |
| `AiAgent` | ✓ | register route (+ `backfill:ai-agents` script existed for legacy gaps — the precedent) |
| `reportingCurrency` | ✓ | schema default `"USD"` (register predates MC1 copy-once; acceptable) |
| Account links | ✓ | Plaid/wallet/manual accounts land in the Personal Space (`ownedFinancialAccounts`) |
| Snapshots | ✓ | `SpaceSnapshot` rows exist (DashboardClient receives `getRecentSnapshots`; `backfill:snapshots` exists) |
| **`SpaceDashboardSection` rows** | **✗ — none, for any Personal Space, ever** | register route never creates them; sections API has no fallback |

The single data gap is sections, and SP-1 already built the pure machinery to fill it: `planTemplateApplication(personalTemplate, existingKeys)` is idempotent by construction and safe to run against any Space, empty or partially customized.

---

## 6. Legacy data strategy

- **Do existing Personal Spaces have sections?** No — all of them lack rows (this is not a legacy-only gap; today's registrations also skip them).
- **What happens without rows?** Under the current host: nothing (DashboardClient ignores sections). Under the unified shell: Overview renders hero + zero cards, and `SettingsTab` has nothing to manage — functional but hollow. Also note: purely *virtual* runtime sections can't support the Settings tab, because `PATCH /api/spaces/[id]/sections/[sectionId]` needs row ids.
- **Can they be regenerated?** Yes, exactly: the SP-1 hidden `personal` template ≡ `getPresetsForCategory(PERSONAL)` (parity-tested), and the planner skips any keys that exist.
- **Recommendation: backfill by script + fix the source.**
  1. Register route (SP-2A-3) starts materializing sections in its existing transaction — new users are born correct.
  2. `scripts/backfill-personal-sections.ts` (`npm run backfill:personal-sections`) — iterate Personal Spaces, `createMany` the planner output against each Space's existing keys. Idempotent, re-runnable, follows the `backfill-ai-agents.ts` precedent. **This is a script, not a Prisma migration** — no slot in the serialized migration train, no TI coordination.
  3. **Runtime fallback: rejected as the primary mechanism** (two sources of truth at runtime; breaks Settings editing; hides backfill failures). Acceptable only as the shell's natural graceful-degradation: `SpaceDashboard` already renders fine with `[]` sections.
  4. "Leave alone" is fine **until** SP-2A-4 — sections have no Personal consumer before the shell swap, so the backfill should land with (or just before) the consumer, not months ahead of it.

---

## 7. Relationship to SP-2

**SP-2A is not a hard prerequisite for SP-2's core.** Grounded in the code:

- **Template picker + apply-route changes (SP-2 proper):** touch `CreateSpaceModal` + `POST /api/spaces` — a path Personal never takes (register-only). Zero interaction with the Personal shell. **Can proceed in either order.**
- **Template-specific empty states:** mechanism is shared; only copy varies. Not blocked by SP-2A, though landing SP-2A-2 first means new copy debuts in one consistent shell.
- **Template gallery (SP-3+):** unaffected.
- **Where SP-2A genuinely matters:** the doctrine itself. Every template-polish investment amplifies the sense that Personal is "a legacy dashboard beside the template system." And SP-2A-3 (Personal born from the `personal` template) makes template application the *universal* Space-birth path, which simplifies SP-2's story: one code path, `register` and `create` both consuming the SP-1 planner.

**Recommended order:** SP-2A-1/2/3 (small, parallel-safe) → SP-2 picker → SP-2A-4/5 (the big shell swap) sequenced against TI (see §8). If forced to pick one first: SP-2A-2, because it is tiny and removes the visible embarrassment immediately.

---

## 8. Relationship to TI

- **No TI dependency, either direction.** The shell is presentation over sections/accounts/goals/snapshots; TI owns transaction facts and their surfaces.
- **No transaction-detail dependency.** Nothing here needs TI Phase 2's overlay.
- **No transaction tables touched.** The only data write anywhere in the plan is `SpaceDashboardSection` rows via script/route — a table TI never touches.
- **`BankingClient`:** *not* a shell blocker — it's the standalone `/dashboard/banking` legacy page, outside the `/dashboard` shell fork. SP-2A should not touch it (it's also a transaction-rendering surface on TI's Phase-2 list).
- **`SpaceTransactionsPanel`:** already consumed by both hosts; SP-2A *re-parents* it at most and must not modify its internals (TI Phase 2 will reshape them).
- **One real coordination point:** `SpaceDashboard.tsx` and `DashboardClient.tsx` are the "largest shared client files" the parallel-workstream investigation warned about, and TI Phase 2's overlay will likely edit `SpaceDashboard`'s transactions tab region. SP-2A-2/3 avoid `SpaceDashboard` entirely (DashboardClient + register route + script only). **SP-2A-4 — the shell swap — is the slice to sequence around TI's Phase-2 landing**, or accept a one-file merge coordination.

---

## 9. UI/UX recommendation

- **Desktop:** Personal gets the full pill rail via `railVisibleTabs("personal")` (currently: Overview, Perspectives, Timeline, Accounts, Transactions, Members, Settings) with the same host filters SpaceDashboard applies — TIMELINE stays a modal launcher (no pill), SETTINGS pill gated on `canManage` (Personal owner ⇒ visible; or keep Settings behind header "Manage" on both hosts — pick one rule, apply to both). Result: ~5–6 pills, same order as every shared Space. `MoreMenu` retires from the rail. `PerspectiveSwitcher` stays exactly as-is on both hosts (Overview-content control, already identically gated).
- **One-tab behavior:** the question dissolves — Personal never legitimately has one tab. Accounts/Transactions/Members are real features on Personal *today* (they're in the MoreMenu); they simply re-earn their pills. If some future host ever has a single visible tab, the rule should be: render the rail anyway (skeleton consistency beats minimalism — that's the doctrine this initiative enforces).
- **Mobile:** unchanged chrome (BottomNav is global). `SegmentedControl w-full` is how shared Spaces already present the rail on small screens; Personal adopting it is convergence, not new design. If pill count overflows narrow widths, the fix belongs in `SegmentedControl` (scroll/compress) so both hosts benefit — no Personal-specific mobile variant.
- **Avoiding shared-Space regression:** SP-2A-2/3 make **zero edits** to `SpaceDashboard.tsx`, `space-nav.ts` order/gates, or any shared widget — enforced by diff review and by the existing 508-check `space-nav.test.ts` suite. The rail source (`railVisibleTabs`) is read-only reuse.

---

## 10. Implementation slice plan

The brief's slicing is right in shape; adjusted to the codebase:

- **SP-2A-1 — Contracts (this document).** Ratify: canonical tab model = `SpaceTabId`; section model = materialized rows for all Spaces; hero slot = the one sanctioned divergence; `personal` hidden template = the source of Personal sections. No code.
- **SP-2A-2 — Rail parity (S; DashboardClient only).** Replace `PERSONAL_TABS` + `MORE_MENU_ITEMS` with pills derived from `railVisibleTabs("personal")` mapped through the existing `RAIL_TO_INTERNAL`. Remove the MoreMenu from the rail row. No data, no SpaceDashboard, no API changes. Kills the visible divergence.
- **SP-2A-3 — Personal sections at birth + backfill (S; register route + script).** Register route materializes the `personal` template via the SP-1 planner inside its existing transaction; add idempotent `scripts/backfill-personal-sections.ts` (backfill-ai-agents precedent). No schema, no migration. (Sections remain unconsumed until SP-2A-4 — acceptable dormancy, or land 3 immediately before 4.)
- **SP-2A-4 — Personal through the shared shell (M–L; the real convergence; sequence around TI Phase 2).** `page.tsx` routes Personal to `SpaceDashboard` (host prop or `key`-level branch removal); Personal-only overview content (NetWorthCard/KPI/FICO/brief) moves into a host-aware hero slot first (fastest), then piecemeal into registry widgets per the Widget Primitive Rule. DashboardClient's overview body retires; its non-overview internal tabs map to the shell's existing bodies.
- **SP-2A-5 — Cleanup (S).** Delete dead `PersonalTab` plumbing (`RAIL_TO_INTERNAL`, `VALID_TABS` remnants, MoreMenu import), reconcile `?tab=` deep links, visual polish, and *assess* (separately) the legacy standalone routes (`/dashboard/banking` etc.). Also delete the stray empty dirs `components/space/sections 2/`, `widgets 2/`.

2 and 3 are independent of each other and of SP-2; each is individually revertible. 4 is the only risky slice and the only one touching `SpaceDashboard`.

---

## 11. Test plan

Consistent with the tsx harness (no DOM/browser runner exists — component render tests aren't currently possible; structural/source-scan tests are the repo's tool):

1. **Personal rail = shared tab model:** extend `lib/space-nav.test.ts`-style checks — after SP-2A-2, a source-scan (or exported-constant test) asserting DashboardClient's rail ids are exactly `railVisibleTabs("personal")` (mod documented filters) in `SPACE_TAB_ORDER` order.
2. **No duplicate dropdown/tab behavior:** source-scan that `DashboardClient` no longer imports `MoreMenu`, and that no tab id appears in both a rail source and a menu source.
3. **Legacy Personal renders:** planner-level guarantee — `planTemplateApplication(personalTemplate, ∅)` non-empty and parity with `getPresetsForCategory(PERSONAL)` (already tested in SP-1); backfill script gets a dry-run mode asserting idempotence (second run plans zero rows). A live-DB render test isn't in the harness's scope; the graceful-`[]` behavior of SpaceDashboard is the runtime safety net.
4. **Shared Spaces unchanged:** SP-2A-2/3 diffs contain no `SpaceDashboard.tsx` / `space-nav.ts` / widget changes (review gate); existing `space-nav.test.ts` (508 checks) and SP-1 suite must stay green.
5. **Template registry parity intact:** SP-1's `registry.test.ts` parity checks already pin `personal` template ≡ `getPresetsForCategory(PERSONAL)` — they now double as the backfill-content guard.
6. **No TI imports:** SP-1's `purity.test.ts` allowlist already enforces this for template code; add the backfill script to a scan if desired (it may import `db` — it's a script, not `lib/space-templates` code; the allowlist boundary stays intact).
7. **Mobile:** not testable in the harness beyond class-string assertions; manual QA note for SP-2A-2 (pill overflow at 320–390px) and SP-2A-4.

---

## 12. Risks

- **SP-2A-4 size/entanglement (highest).** DashboardClient is 1,575 lines with personal-only features (FICO, greeting/brief, cash-flow modal, inline banking sections, investable-cash logic) that have no widget-registry representation. Mitigation: hero-slot-first strategy (move, don't rewrite), then widgetize piecemeal; keep 4 out of SP-2A's initial commitment.
- **TI merge collision on `SpaceDashboard.tsx`** — only for slice 4; sequence it after TI Phase 2 or accept one coordinated merge.
- **Reversing a deliberate design.** The one-pill rail was an intentional minimalism pass. Unification means Personal gets ~6 pills again — the product owner should consciously ratify that the doctrine outranks the trim (this document assumes yes, per the brief).
- **Dormant sections drift** (if SP-2A-3 lands long before 4): rows exist that nothing renders; a user's Settings edits (if exposed) would be invisible. Mitigation: land 3 adjacent to 4, or accept dormancy consciously.
- **Deep-link compat:** `?tab=` values (`banking`, `credit`…) must keep resolving through any tab-model change (`VALID_TABS` fallback already handles unknowns → Overview).
- **Register-route transaction growth** (slice 3): adds one `createMany` to an existing multi-step transaction — low risk, same pattern as the create route, but registration is the most sensitive flow in the product; test in staging with email verification on.
- **Legacy standalone routes** remain a second Personal surface after unification — out of scope here, flagged so nobody mistakes SP-2A for having removed them.

---

## 13. Final recommendation

Adopt the three-stage path: **SP-2A-2 (rail parity, DashboardClient-only) and SP-2A-3 (Personal born from the hidden `personal` template + idempotent backfill script) now** — both small, schema-free, TI-parallel, and independently revertible — and **defer SP-2A-4 (hosting Personal in `SpaceDashboard`) to its own initiative-sized slice sequenced around TI Phase 2**. Ratify the contracts in §3 so SP-2's picker work (which is *not* blocked by any of this) builds toward the same skeleton. Personal's answer to "what is your template?" becomes the same as every other Space's: the SP-1 registry — hidden from the picker, applied at registration.

**Stop after investigation. No implementation performed.**
