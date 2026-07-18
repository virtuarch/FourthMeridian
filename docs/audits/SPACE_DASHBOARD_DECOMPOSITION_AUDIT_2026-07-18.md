# SpaceDashboard Decomposition Audit

**Date:** 2026-07-18
**Baseline commit:** `4ef3813` (SD: collapse the perspective render ladder into a registry)
**File:** `components/dashboard/SpaceDashboard.tsx` — **1582 LOC**
**Status:** READY TO START. Read-only audit + sequenced plan. No code changed by this doc.

---

## 1. Verdict

`SpaceDashboard` is **not a rendering monolith** — the rendering is already decomposed into
components (`WealthWorkspace`, `CashFlowWorkspace`, `SpaceShell`, `OverviewWorkspace`,
`SectionCard`, `PerspectiveShell`, every widget). Of its 1582 lines the return block is only
~450, and after the registry refactor most of that is thin mount wiring.

It is an **orchestration monolith**: ~1150 lines of interdependent state + data-loading effects +
the canonical URL/time authorities. The correct decomposition of *that* is **custom hooks by
resource**, then a **SpaceData provider**, then (last) **region components** — NOT splitting the
host into sibling components first. Splitting an orchestrator along visual lines just trades one
big file for prop-drilling or, worse, competing state authorities (the exact thing the SD-0 work
consolidated). Do it resource-by-resource, safest first.

**Target:** ~1582 → **~700–800 LOC** host that reads: *resolve state → load via hooks → render
`workspaceRenderers[active]()`*. Realistic over ~4 waves; each wave is independently shippable.

---

## 2. What's already decomposed (do NOT redo)

- **Workspace bodies** → their own files under `components/space/widgets/*/` and
  `components/space/workspaces/`. The host mounts them via the `workspaceRenderers` registry
  (added in `4ef3813`).
- **Shell frame** → `SpaceShell` (rail + body), `PerspectiveShell` (time/trust + lens tabs),
  `ContextualNavbar` (sidebar, via the `SpaceChrome` bridge).
- **Sections** → `SectionCard` + `SectionRegistry` (key → renderer).
- **Per-lens historical data** → Debt / Investments / Liquidity already **self-fetch** their
  as-of/historical data *inside* the workspace (see the `active` gate props). The host no longer
  computes their read models.

The registry keys are now the single source of truth for "which lenses own a workspace".

---

## 3. What remains in the host (the extraction surface)

Line numbers are as of `4ef3813` and will drift — treat them as a map, re-grep before editing.

### 3a. State — 26 `useState` (L269–745)

**Data state (candidates to move into hooks / provider):**

| State | Line | Fetched by | Consumed by |
|---|---|---|---|
| `sections` | 269 | `/sections` (L722, L885) | Overview/Accounts/Activity section stacks |
| `accounts` | 270 | `/accounts` (L733, L886) | almost every workspace + hero + day-zero gating |
| `memberCount` | 281 | `/spaces/[id]` (L813) | header subtitle (now via SpaceChrome) |
| `lensResults` | 287 | `/perspectives` (L793) | lens ledes (present-day), Debt/Liquidity present anchor |
| `snapshots` | 293 | `/snapshots` (L830) | Wealth, Debt, net-worth chart |
| `snapshotsBackfilling` | 296 | backfill poll (L854-ish) | Wealth loading state |
| `spaceTransactions` | 297 | `/transactions` (L868) | Cash Flow, Liquidity, Transactions, previews |
| `spaceMoneyCtx` | 300 | (from tx fetch) | tx conversion |
| `widgetMoneyCtx` | 309 | `/money/view-context` (L312) | widget FX context |
| `spaceGoals` | 692 | `/goals` (L696) | Goals lens |

**UI / composition state (STAYS in the host):**
`loading` (271), `activeTab` (272), `showAddGoal` (273), `showManage` (274), `confirmLeave` (275),
`leaveBusy` (276), `currencyNonce` (334), `refreshNonce` (340), `selectedPerspectiveId` (421),
`initialAccountFilter` (550), `cashFlowExplicitPeriod` (583), `lastRelativePeriod` (589),
`chartMetric` (624), `activeEnvelope` (653), `editingLayout` (741), `savingLayout` (745).

### 3b. Single-authority seams (KEEP as single owners — do not fork)

- **URL authority** — `useSpaceUrl()` (L499). ONE owner of `?tab/perspective/metric/asof` etc.
- **Time authority** — `usePerspectiveShellState()` (L570): the canonical `{asOf, compareTo,
  preset}` triple. ONE owner.
- **Display currency** — `useDisplayCurrency()` (L308) from the layout provider.

These are why naive component-splitting is dangerous: a child that also reads/writes URL or time
becomes a second authority. Any decomposition MUST keep these single-owned (host owns them and
passes values down, or a provider owns them once).

### 3c. Data-loading effects / fetches

`view-context` (L312) · `goals` (L696) · `members/[user]` (L710) · `sections` (L722) ·
`accounts` (L733) · `perspectives` batch (L793) · `spaces/[id]` (L813) · `snapshots` (L830) ·
`transactions` (L868) · initial parallel `sections`+`accounts` (L885–886) · `sections/reorder`
write (L1045). Re-fetch triggers today: `currencyNonce`, `refreshNonce`, and the
`SPACE_CURRENCY_CHANGED` / `SPACE_ACCOUNTS_CHANGED` / `SPACE_DATA_REFRESHED` window events.

---

## 4. Strategy — hooks first, provider second, components last

### Why hooks, not components (the crux)
Each fetch + its state + its refresh-event listeners is one **cohesive resource concern**. A hook
captures exactly that boundary and returns `{ data, loading, … }` with no prop-drilling. A
component boundary here would have to receive that same state as props anyway. So: extract to
hooks to *decouple*, not to components to *relocate*.

### The three moves
1. **Extract data-loading into resource hooks** (`components/space/hooks/` or `lib/space/hooks/`).
   Each hook owns its fetch + state + the window-event/nonce re-fetch. Biggest, safest LOC win;
   introduces NO new authority.
2. **`SpaceDataProvider`** — once the hooks exist, compose them in one provider that exposes the
   shared reads via context. The host reads context instead of holding the state. This is what
   lets render-regions stop prop-drilling.
3. **Region components (LAST)** — only after the provider exists, extract the two big render
   branches into components that read context:
   - `<EngagedPerspectiveRegion>` — `PerspectiveShell` + `workspaceRenderers[active]()`.
   - `<OverviewSummaryRegion>` — the `!perspectiveEngaged` lens summary + section stack.
   And a thin `<SpaceTabRouter>` for the flat tab branches (Transactions/Members/Accounts/Activity).

---

## 5. Concrete extraction targets (the hooks)

Each row: what moves out, and the rough host-line reduction. Order = safest → riskiest.

| # | Hook | Moves out (state + fetch + events) | Notes / risk |
|---|---|---|---|
| 1 | `useSpaceSnapshots(spaceId, {currencyNonce, refreshNonce})` | `snapshots`, `snapshotsBackfilling` + `/snapshots` (L830) + backfill poll | Consumed by Wealth/Debt/chart. Low risk — pure read. |
| 2 | `useSpaceTransactions(spaceId, …)` | `spaceTransactions`, `spaceMoneyCtx` + `/transactions` (L868) | Consumed by CashFlow/Liquidity/Transactions. Low risk. |
| 3 | `useSpaceGoals(spaceId)` | `spaceGoals` + `/goals` (L696) + `SPACE_GOALS_CHANGED` | Smallest. Great first PR to prove the pattern. |
| 4 | `useSpaceAccounts(spaceId, …)` | `accounts` + `/accounts` (L733/886) + `SPACE_ACCOUNTS_CHANGED` | Widely consumed — thread carefully; keep the day-zero gate semantics. |
| 5 | `useSpaceSections(spaceId, …)` | `sections` + `/sections` (L722/885) + `/sections/reorder` (L1045) | Owns the reorder write too. Medium. |
| 6 | `useLensResults(spaceId, …)` | `lensResults` + `/perspectives` (L793) | Present-day lens ledes. Medium. |
| 7 | `useSpaceMeta(spaceId)` | `memberCount` + `/spaces/[id]` (L813) | Tiny. |
| 8 | `useWidgetMoneyCtx(displayCurrency)` | `widgetMoneyCtx` + `/money/view-context` (L312) | Tiny; keyed on display currency. |

**Refetch triggers:** fold `currencyNonce` / `refreshNonce` and the `SPACE_*_CHANGED` /
`SPACE_DATA_REFRESHED` window listeners INTO each hook (each hook subscribes to the events it cares
about). That deletes the nonce plumbing from the host as a bonus.

Estimated host reduction from hooks alone: **~450–600 LOC** (the effects + their state + event
wiring + the derived money-ctx memos that hang off them).

---

## 6. Sequencing (waves)

- **Wave A — prove the pattern (1 PR each, independently shippable):**
  `useSpaceGoals` → `useSpaceMeta` → `useWidgetMoneyCtx`. Tiny, isolated, near-zero risk. Confirms
  the hook location + test tripwire style.
- **Wave B — the big reads:** `useSpaceSnapshots` → `useSpaceTransactions` → `useSpaceAccounts` →
  `useSpaceSections` → `useLensResults`. Each is one PR; verify the consuming workspace in-browser.
- **Wave C — `SpaceDataProvider`:** compose the Wave A/B hooks into one provider; host reads
  context. No behaviour change; this is the seam that unlocks Wave D.
- **Wave D — region components:** `EngagedPerspectiveRegion`, `OverviewSummaryRegion`,
  `SpaceTabRouter`. Only now do the render branches become components (they read the provider, so
  no prop-drilling). This is what finally takes the return block down.

Ship Wave A/B/C before D. Do NOT start with D (component-splitting before the provider exists is
the trap).

---

## 7. Invariants to preserve (regression tripwires)

- **Single URL authority:** `useSpaceUrl()` used exactly once; no `history.pushState`/`useSearchParams`
  introduced elsewhere. (Existing test: `space-url-authority.test.ts`.)
- **Single time authority:** `usePerspectiveShellState()` used exactly once; workspaces never own
  `asOf/compareTo`. (Existing shell tests assert this.)
- **Snapshots fetched ONCE and shared** across Overview/Wealth/Debt — a hook must not re-introduce
  a second snapshot fetch. (`WealthWorkspace.test.ts` already ratchets this.)
- **FX / money-ctx semantics** unchanged (per-date conversion, identity fast-path, fxMiss honesty).
- **Day-zero gating** (no accounts ⇒ setup card, not empty lenses) preserved by `useSpaceAccounts`.
- **No new authority per resource:** a hook may READ the URL/time values (passed in) but must never
  WRITE them.
- Each extracted hook gets a small source-scan/behaviour test asserting the host DELEGATES to it
  (mirrors the existing `*Workspace.test.ts` tripwires — e.g. "host no longer fetches X inline").

---

## 8. Exit criteria

1. All 8 resource hooks extracted; host holds no `fetch(` for shared reads.
2. `SpaceDataProvider` owns the shared reads; host reads context.
3. Engaged/Overview/Tab render branches are components.
4. URL + time remain single-authority (tripwires green).
5. `tsc` + `eslint` clean; full suite green (update the source-scan tripwires that pin old
   in-host fetch/state shapes, as done for the registry in `4ef3813`).
6. Host ≈ 700–800 LOC, shaped as *resolve state → load via hooks → render registry*.

---

## 9. Notes / gotchas

- Line numbers above are `4ef3813`-relative; **re-grep before each edit** (`useState<`, `fetch(`,
  the hook names).
- Two stale comments still name retired per-lens envelope vars (`wealthEnvelope` L617,
  `cashFlowEnvelope` L657) — harmless, tidy them when touching that region.
- The `SpaceChrome` sections channel (added in the Net Worth pass) means the sidebar reads sections
  from whichever workspace publishes them — `useSpaceSections` is about the DB section *stack*, a
  different concern; don't conflate the two.
- Concurrent-branch discipline: commit each wave with an explicit pathspec (this branch has other
  in-flight work).
