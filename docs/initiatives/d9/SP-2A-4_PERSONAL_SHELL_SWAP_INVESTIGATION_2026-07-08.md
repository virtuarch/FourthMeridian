# SP-2A-4 — Personal Shell Swap Investigation

**Date:** 2026-07-08
**Type:** Investigation only — no implementation, no schema, no migrations.
**State:** SP-1 ✓ · SP-2A-3 ✓ (Personal sections materialize at registration; backfill script exists) · SP-2 ✓ (planner authoritative on every birth path). Personal still renders through `DashboardClient`.
**Supersedes timing guidance in:** `SP-2A_DIRECTION_RESEQUENCING_INVESTIGATION_2026-07-08.md` §7 — see §1 finding on TI.

---

## 1. Executive summary — three findings that change the picture

1. **The TI gate is substantially cleared.** TI Phase 2's transaction detail drawer has landed (commit `7719498` — `components/transactions/TransactionDetailDrawer.tsx` + `useTransactionDrawer`, wired into `BankingClient`, `DebtClient`, `SpaceTransactionsPanel`, `DashboardChrome`; working tree clean). Because `SpaceDashboard` renders `SpaceTransactionsPanel`, **the shell swap inherits transaction detail for free** — the swap no longer needs to wait.
2. **The accounts API already works for Personal.** `/api/spaces/[id]/accounts` reads `SpaceAccountLink` only — but D3 guarantees **exactly one HOME link per FinancialAccount** (raw-SQL unique index; `computeLinkKind()` assigns HOME to the owner's Personal Space). Personal accounts flow through the same endpoint as shared ones. The feared "empty Accounts tab" blocker does not exist.
3. **The hero seam half-exists.** `lib/space-hero.ts` deliberately returns no hero def for PERSONAL ("PERSONAL renders via DashboardClient — KpiRow + NetWorthChart already form its hero"), and `SpaceDashboard` already renders gracefully with `heroDef === undefined`. The missing piece is one **additive render-prop** so the page can inject a Personal hero into that empty slot.

**Bottom line:** the swap is now three surgical moves — an additive hero/initial-tab seam on `SpaceDashboard`, a `PersonalHero` component *moved* (not rewritten) out of `DashboardClient`, and a one-file flip in `page.tsx` — followed by a separate retirement slice. Estimated M, mostly extraction.

---

## 2. Current Personal render path (divergence map, verified)

```
app/(shell)/dashboard/layout.tsx → DashboardChrome (Sidebar + BottomNav — SHARED by both hosts)
app/(shell)/dashboard/page.tsx
  ctx = getSpaceContext()  (cookie → active Space; falls back to Personal)
  ├─ !PERSONAL → <DisplayCurrencyProvider><SpaceDashboard key={spaceId} …identity props/> (client-fetches everything)
  └─ PERSONAL  → server Promise.all: getAccounts/getHoldings/getRecentSnapshots/getLatestAdvice/
                 getFicoData/getDebtTransactions/getTransactions + serializeSpaceConversionContext
                 → <DashboardClient …8 data props/>
```

Inside `DashboardClient` (1,575 lines), Personal-specific structure:
- **Navigation:** single-segment `SegmentedControl` (Overview pill) + `MoreMenu` (Accounts/Transactions/Members) + hidden-gated `PerspectiveSwitcher`; lowercase `PersonalTab` vocabulary bridged by `RAIL_TO_INTERNAL`; **`?tab=` deep links** read via `useSearchParams` (`initialTab`, `VALID_TABS` fallback, `router.replace` on change).
- **Hero region (hardcoded JSX):** greeting · `ViewCurrencyOverride` (MC1 — personal-only by doctrine) · `KpiRow` (net worth/assets/liabilities/cash-flow/FICO, click-through modals) · chart-expand + cash-flow modals · **day-zero "Connect your first account" card** with `ConnectAccountButton`.
- **Section host:** none — content is `filter === …` conditional JSX; the SP-2A-3 materialized sections are dormant (read only by the sections API and data export).
- **Internal tabs:** banking (inline grouped account rows + investable-cash + wallet/manual-asset modal triggers), credit (`DebtClient`), investments, transactions (`SpaceTransactionsPanel`), members, settings (two static links), perspectives/timeline.

## 3. Shared shell render path (what Personal now satisfies)

`SpaceDashboard` (2,692 lines) receives only identity props (`spaceId, spaceName, spaceType, category, myRole, currentUserId`) and client-fetches: `/sections`, `/accounts`, `/goals`, `/snapshots`, `/transactions`, members, view-context. Renders: header row (name, Manage/Leave) → full rail (`railVisibleTabs("shared")` minus SETTINGS-for-non-managers minus TIMELINE-as-modal) → per-tab bodies → OVERVIEW = `SpaceTrendHero` (via `getSpaceHeroDef(category)`) + `SectionRegistry` cards → glass modals for GOALS/DEBT/INVESTMENTS/RETIREMENT → `SettingsTab` over section rows.

**Personal's compatibility scorecard after SP-2A-3/SP-2:**

| Shell dependency | Personal status |
|---|---|
| `SpaceDashboardSection` rows | ✓ new registrations (SP-2A-3); legacy via `backfill:personal-sections` — **must run before flip** |
| `/api/spaces/[id]/accounts` | ✓ via D3 HOME links (finding §1.2) |
| `/api/spaces/[id]/snapshots` | ✓ (personal snapshots exist; same API) |
| `/api/spaces/[id]/goals` | ✓ API works — note: Goals becomes *newly functional* on Personal (product gain; confirm intended) |
| `/api/spaces/[id]/transactions` + drawer | ✓ (KD-15-filtered; drawer landed) |
| Members / Manage / policy | ✓ (`sharedOnly` lifecycle bans already enforced) |
| Perspectives | ✓ `getPerspectivesForCategory("PERSONAL")` |
| Hero def | ∅ by design — the seam to fill |
| Reporting currency provider | needs the same `DisplayCurrencyProvider` wrap the shared branch has |

## 4. Hero divergence — the one new seam

- **Where it lives today:** inline in `DashboardClient`'s overview branch (KpiRow + modals + day-zero card + `ViewCurrencyOverride` + greeting).
- **Can it remain special:** yes — this is the doctrine's sanctioned divergence.
- **Composition mechanism (recommended):** one additive prop on `SpaceDashboard`:
  `renderHero?: (ctx: { accounts, snapshots, loading }) => React.ReactNode`
  When present, the OVERVIEW hero region renders it instead of the `getSpaceHeroDef` path. A render-prop (not a plain node) lets the Personal hero reuse SpaceDashboard's **already-fetched** accounts/snapshots — no duplicate fetching. Server-only data the hero needs (FICO via `getFicoData`, hero `moneyCtx`) is fetched in `page.tsx`'s personal branch (as today, but trimmed to hero needs) and closed over. Default `undefined` ⇒ shared Spaces byte-identical.
- **New component:** `components/dashboard/PersonalHero.tsx` — **moved** KpiRow composition, chart/cash-flow modals, day-zero card, override, greeting. Move, don't rewrite; `DashboardClient` can consume it during the transition so there is never two copies.

## 5. Required changes — exact minimum file list

| File | Change |
|---|---|
| `components/dashboard/SpaceDashboard.tsx` | Additive: `renderHero?` render-prop; `initialTab?: string` (deep-link mapping); rail source parameterized `railVisibleTabs(host)` with `host` derived from `spaceType` (one line — currently hardcoded `"shared"`). Defaults preserve shared behavior exactly. |
| `components/dashboard/PersonalHero.tsx` (new) | Extraction target for the hero region (§4). |
| `components/dashboard/DashboardClient.tsx` | Transitional only: overview branch renders `<PersonalHero/>` instead of inline JSX (keeps one copy). Deleted in the retirement slice. |
| `app/(shell)/dashboard/page.tsx` | Personal branch → `<DisplayCurrencyProvider><SpaceDashboard key spaceId … renderHero initialTab/>`; server fetches trimmed to hero needs (`getFicoData` + hero moneyCtx); `?tab=` legacy ids mapped (banking→ACCOUNTS, transactions→TRANSACTIONS, members→MEMBERS, settings→SETTINGS, credit→DEBT, investments→INVESTMENTS, activity/timeline→TIMELINE, else OVERVIEW). |
| `lib/space-nav.test.ts` / space-template suites | Extend: host-rail assertions; source-scan that `page.tsx` no longer imports `DashboardClient` (final slice). |

**Explicitly not touched:** `DashboardChrome` (already shared; TI just modified it), `lib/space-nav.ts` (host param exists), widgets, `SpaceTransactionsPanel`/drawer internals, schema, register route, legacy standalone routes (`/dashboard/banking` etc. — separate retirement question; they import `BankingClient`, not `DashboardClient`).

## 6. DashboardClient retirement

- **After the flip, `DashboardClient` has zero references** (its only consumer is `page.tsx`) — it becomes dead code immediately, but should survive one bake period for fast revert (the flip is one file).
- **What must temporarily stay:** `PersonalHero` (permanent, by design); the legacy standalone routes and their clients (out of scope); `?tab=` mapping in `page.tsx` (permanent, cheap).
- **What the retirement slice deletes:** `DashboardClient.tsx` itself, its `RAIL_TO_INTERNAL`/`PERSONAL_TABS`/`MORE_MENU_ITEMS`/`VALID_TABS` plumbing, the `MoreMenu` rail usage, and the stale `lib/space-hero.ts` comment ("PERSONAL renders via DashboardClient").
- **One slice or multiple:** multiple — flip and delete must not share a commit; revert of the flip must not resurrect merge conflicts.

## 7. Risks

- **Legacy Personal Spaces without sections** — the flip's hard precondition is running `backfill:personal-sections --apply` in the deploy window. Without it, legacy users get hero + empty Overview. (Graceful, but wrong.)
- **SSR → client-fetch regression:** Personal loses its server-rendered data body; Overview sections/tabs now load like every shared Space (spinners on first paint). Hero keeps server data via the render-prop, which preserves the most important first-paint content. Accept as consistency, monitor.
- **Deep links:** `/dashboard?tab=banking|credit|…` must map at the page boundary; unknown values default to OVERVIEW (existing shell behavior). `SpaceDashboard` has no URL sync — tab state stops writing to the URL on Personal (delta vs today's `router.replace`; acceptable, or add later shell-wide).
- **Density/UX deltas:** ACCOUNTS tab (`AccountsCard`) is plainer than DashboardClient's grouped banking rows + investable-cash section; wallet/manual-asset entry points must survive (day-zero card in hero + ManageSpaceModal Finances tab already has them); post-swap polish, not blockers.
- **Goals appears on Personal** — functional gain via the universal `goals_progress` section; confirm product intent before flip.
- **`ViewCurrencyOverride` scope** — MC1 doctrine limits the override to the personal dashboard; it must move *into* `PersonalHero`, never into `SpaceDashboard` proper.
- **Hydration/chrome/account switching:** low — `DashboardChrome` is untouched; `key={spaceId}` remount pattern is copied from the shared branch; the drawer's `useTransactionDrawer` already runs inside this chrome on both hosts.
- **Mobile:** full rail on narrow screens is exactly the shared-Space experience today; any overflow fix belongs in `SegmentedControl` shell-wide.
- **TI collision:** much reduced (drawer landed), but TI remains active — SP-2A-4a/b avoid TI-touched files entirely; only the flip (4c) coexists with `SpaceDashboard`, which TI did not modify.

## 8. Recommended slice breakdown

- **SP-2A-4a — Shell seams (S).** `renderHero?` + `initialTab?` + host-derived rail on `SpaceDashboard`, all defaulted to current behavior; tests assert shared Spaces byte-identical (no prop = no change).
- **SP-2A-4b — PersonalHero extraction (S–M).** Move hero JSX/state/modals into `PersonalHero`; `DashboardClient` consumes it (zero visual change; one copy of the code).
- **SP-2A-4c — The flip (S, high-visibility).** `page.tsx` personal branch → `SpaceDashboard` + hero + tab mapping; run legacy backfill in the same deploy window; manual QA desktop/mobile; revert = one file.
- **SP-2A-4d — Bake, then retire (S).** Delete `DashboardClient` + plumbing + stale comments; add the source-scan test locking `page.tsx` to the unified shell; update `space-hero.ts` comment. (This absorbs the old SP-2A-5 cleanup.)

## 9. Recommendation

Proceed with 4a → 4b → 4c → 4d. The pre-work (SP-2A-3 sections, SP-2 planner authority, TI's landed drawer, D3's HOME links, the existing hero-def absence for PERSONAL) has reduced the "big risky slice" to an extraction plus a one-file flip with a one-file revert. The only hard sequencing rule: **backfill before flip**. After 4d, the north star is real: one dashboard system, `Space → Template → Sections → Widgets`, hero content as the single sanctioned divergence.

**Stop after investigation. No implementation performed.**
