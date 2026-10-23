# Agent G — Product Retirement & Code Hygiene

Branch `remediation/g-hygiene` (worktree `…-remediation/g`), cut from `cde8fa0`. Local commits only; nothing pushed, no database touched, no `prisma/**` or `package.json` change. Date 2026-10-22.

Method for every candidate: static importers (`@/` alias, relative, `import()`), string references (registries, source-scan tests, `scripts/**`, `site/**`, `next.config.ts`), docs plans by name, and `git log --diff-filter=A` for origin. "Not visible in the UI" was never treated as evidence.

**Policy I applied to test pins in files I do not own.** A deletion that leaves a source-scan pin red is not finished, and the brief forbids a red gate. Where a pin read a deleted file, I made the smallest possible edit (one list entry or one check), named it in the commit message, and list it in §12 as a cross-ownership edit the orchestrator can accept or revert. Where a deletion would have required a *behavioural* change in another agent's file, I did not delete (§4: `domain-relevance.ts`).

Gate results at HEAD are in §13.

---

## 1. RETIRE CREDIT — inventory (commit `RETIRE-CREDIT`)

Investigation: `grep -rn --include='*.ts' --include='*.tsx' -E "dashboard/credit|/api/credit|update-fico|CreditScore|creditScore|FicoCard"` (60 hits, every one classified below).

| File | Class | Disposition | Note |
|---|---|---|---|
| `app/(shell)/dashboard/credit/page.tsx` | (a) Credit product page | **DELETED** | no nav entry; reachable only via `FicoCard` links. Origin `b2564b4` (v1.0), last touched `bad0927`. |
| `components/dashboard/DebtClient.tsx` | (a) Credit product client | **DELETED** | 1,251 lines; sole importer was the page. |
| `components/dashboard/FicoCard.tsx` | (b) shared card | **KEPT, trimmed** | removed both `href="/dashboard/credit"` links (:49, :84) and the `compact` variant that only `DebtClient` used. Still rendered by `CreditHealthInputs.tsx:103`. |
| `app/api/credit/update-fico/route.ts` | (b) Debt-workspace write path | **KEPT** | `lib/debt/user-terms.ts:97 saveCreditScore` → `CreditScoreInput` (Net Worth → Debt). Not Credit-product-only. |
| `components/space/widgets/debt/CreditHealthInputs.tsx`, `lib/debt/user-terms.ts`, `debt-signals.ts` | (b) Debt feature | KEPT | |
| `lib/data/accounts.ts` (`getFicoData`) | (b)/(c) | KEPT | read by `app/(shell)/dashboard/page.tsx:115` and the Debt workspace. |
| `CreditScore` model, `prisma/seed.ts:390,579` | (c) data | KEPT | no schema change. C's file untouched. |
| `app/api/auth/register/route.ts:17,69,129,281` + `app/(auth)/register/page.tsx` | (c) registration collects an optional score | KEPT — **A: no change needed** | writes the kept model. |
| `lib/export/assemble.ts:263,385` (`creditHistory`) | (c) export of kept data | KEPT — **A: no change needed** | |
| `scripts/rls-foreground-acceptance.ts:284-288, 396` | (d) fixture + route list | KEPT working | C4 fixture writes `CreditScore`; the route list names `update-fico` (kept). |
| `lib/space-nav.ts` | nav | no credit entry existed | `lib/space-nav.test.ts:51` case `['/dashboard/credit', null]` removed. |
| `lib/perspectives/overview-lenses.test.ts:77` `?tab=credit` | legacy URL alias → Debt | KEPT | a deep-link alias, not the page. |

Pins updated for the deletion (all pass): `lib/space-nav.test.ts`; `components/transactions/TransactionDetailDrawer.test.ts` (Debt rows); `components/space/widgets/debt/debt-experience.render.test.ts` (legacy-page checks → tombstone: both files must stay deleted); `lib/debt/balance-semantics.test.ts:297`; `lib/data/transactions.authority.test.ts:371-381`; `lib/money/reporting-currency-failure-contract.test.ts:116-121` (**B's file**, 6-line pin removal); `scripts/audit-account-reparenting.ts:765` (CI REQUIRED audit fails on a stale `COUNTERPARTY_REFERENCES` entry).

Stale prose that now names a deleted file (no behaviour; owners listed): `app/(shell)/dashboard/layout.tsx:49` (A), `components/space/widgets/debt-adapters.tsx:7`, `components/settings/InlineField.tsx:12`, `lib/debt/aggregates.ts:60`, `lib/space/mount-composition.ts:123,229`, `lib/transactions/debt-payment-authority.ts:17`, `lib/transactions/cash-flow-space-data.ts:214`, `lib/debt.ts:75` (historical, mine, left as history), `docs/systems/transactions.md:149`, `docs/initiatives/kd15/KD-15_IMPLEMENTATION_CHECKLIST.md:248`.

**Now-orphaned by the deletion (unowned `lib/data/transactions.ts`):** `getDebtTransactions` and `getDebtPaymentRows` had the page as their only production caller (`scripts/audit-ui-truth-convergence.ts:225` mentions them in prose). Recommend deleting both in a later hygiene slice; left in place.

`proxy.ts` has no credit path (verified). Route-matrix pins: none counted the route.

---

## 2. RETIRE GROWTH — classification (no code removed)

Definition search: `docs/` and `STATUS.md` contain no "Growth product". "Growth" in this codebase is only the operator Platform Space `GROWTH_REVENUE` (`lib/platform/policy.ts:169`, origin `caa92f4` PO1.0 S2), composed in `lib/platform/workspaces.ts:165` and designed in `docs/design-studies/growth-revenue-v1.md`. It is an internal operations/marketing service, which the owner says is **not** the abandoned product. Nothing here is customer-facing.

| Sub-feature | Code | Readers / writers | Class | Decision |
|---|---|---|---|---|
| Beta access requests (approve / deny / resend / revoke) | `growth-revenue/requests/**` (A), `GrowthBetaRequestsWidget` | `BetaAccessRequest`, invitation emails | acquisition / waitlist | **PRESERVE** |
| Invitations | `growth-revenue/invitations` (A) | mints invite + email | acquisition | PRESERVE |
| Registration mode | `registration-mode` route; `lib/platform-settings.ts` (A) | gates sign-up | operations | PRESERVE |
| Product status (development / beta / live) | `product-status` route (PUT), `beta-status` (GET), `scripts/set-platform-setting.ts`, widget stage chips | `PlatformSetting product_status`; read by `beta-status` → `GrowthBetaRequestsWidget:195`; the route header says "framing only; gates no signup behaviour" | launch-axis flag, operator-read | **PRESERVE** (has readers; cheap; owner-visible). Candidate for a later "does anything else need this?" question, not for this wave. |
| Sign-ups & activation | `signups` route, `GrowthSignupsWidget` | `User`/`UserSession` projection | analytics | PRESERVE |
| Product analytics | `product-analytics` route, `lib/platform/growth/product-analytics{,-core,-types}.ts`, `GrowthProductAnalyticsWidget` | also consumed by `lib/platform/activity/activity.ts` and `lib/platform/customer/{customers,customer-core,customer-detail}.ts` (Customer Success) | analytics (shared) | PRESERVE — deleting it would break CS |
| Growth funnel + stage panel | `growth` route, `lib/platform/growth/growth.ts`, `OpsGrowthWidget`, `FunnelStages`, `GrowthStagePanel`, `growth-funnel-view.ts` | `growth-funnel-view.ts` is also imported by `product-analytics-view.ts` and `security-posture-view.ts` | analytics | PRESERVE |
| Users (deactivate / reactivate) | `users`, `users/[userId]` routes, `OpsUsersWidget` | operator action envelope | operations / CS | PRESERVE |
| User activity | `activity` route, `OpsActivityWidget` | projection | analytics | PRESERVE |
| Policy groups catalogue | `policy-groups` route, `GrowthPolicyGroupsWidget` | entitlement catalogue (read-only) | operations | PRESERVE |

Dead funnels with 0 consumers: none found. Stubs with no reader: none (every route has a widget reader; every widget is composed in `lib/platform/workspaces.ts:166`). CQ-003's "14 unreferenced values in `product-analytics-core.ts`" are exports consumed by tests only — export pruning, not a product retirement; not done (B/E-adjacent core, and the brief says preserve).

---

## 3. PRESERVE MARKETS — `comingSoon` (commit `MARKETS-COMING-SOON`)

Finding: the registry's `status` field (`lib/perspectives.ts`, `PerspectiveStatus`) was **inert** — no consumer read it, which is why `status: "available"` on a shell "bypassed" nothing: there was no mechanism to bypass. The real wiring is `CORE_LENS_IDS` (`lib/space/use-space-navigation.ts:141`) + `WORKSPACE_RENDERERS` (mine).

Change (nothing deleted — `MarketsWorkspace`, `lib/markets/markets-mode`, `?view=` routing, sidebar children, all five views stay wired):

- `components/space/workspaces/WorkspaceComingSoon.tsx` (new): the honest placeholder (registry label, "Coming soon.", registry description; publishes the empty envelope).
- `components/space/workspaces/workspaceRenderers.tsx`: the exported map is now built from `WORKSPACE_RENDERER_IMPLS` through a **generic** gate — any renderer id whose registry entry says `comingSoon` renders the placeholder. Keys unchanged (parity test still binds registry ↔ renderer). The `markets` implementation entry is intact.
- `lib/perspectives.ts:316` — **one word outside my owned paths**: `status: "available"` → `"comingSoon"` with a UI-014 note. This IS the registry mechanism the brief named; flip it back to restore the skeleton. Flagged in §12.
- `lib/perspectives/overview-lenses.test.ts:59-60` — the parity pin accepted only `available`; now `available | comingSoon` (one check). Flagged in §12.
- `components/space/workspaces/workspaces.test.ts` §6: pins the registry word, the generic gate (no `id === "markets"` branch), unchanged keys, that the skeleton files stay on disk, and renders `WORKSPACE_RENDERERS.markets` → placeholder with label + description and no view chips, while an available workspace is not gated.

Residual (unowned, not changed): the sidebar still lists the five Markets children (`lib/space/use-space-navigation.ts workspaceChildren`); selecting any lands on the placeholder. If the owner prefers "hide for beta", the additional edit is: drop `MARKETS_LENS_ID` from `CORE_LENS_IDS` (`use-space-navigation.ts:141`) and `"markets"` from every `PERSPECTIVES_BY_CATEGORY` list + `DEFAULT_PERSPECTIVES` (`lib/perspectives.ts:427-450`), then update `components/ui/space-markets-nav.test.ts` (asserts "Net Worth · Cash Flow · Markets").

---

## 4. DEAD CODE — per-candidate table

Importer census: `scratchpad/census2.sh` — import-form grep (`@/path`, relative `./name`, `import()`, quoted path) over `*.ts,*.tsx,*.mjs,*.js,*.json`, excluding `node_modules .next tmp backups prototype _v26pre_bundle docs`; then docs/plans by name; then dynamic `import(` scan (`lib/ai/brief/{load,lifecycle}.ts` are the only dynamic importers in the tree and name none of these); registries (`assembler-registry`, `perspective-engine/registry`, jobs registry) name none.

| Candidate | What it does | Why it exists (origin) | References found | Markets/RWA/marketing? | Persisted data? | Disposition |
|---|---|---|---|---|---|---|
| `components/brief/BriefModal.tsx` | 38-line modal shell for the old Brief | `639e9a5` v2.0 Brief | prose only: `OverlaySurface.tsx:24,104`, `ThemeProvider.tsx:32` | no | no | **DELETE** |
| `components/brief/HeroRegionProvider.tsx` | context for the Brief hero backdrop region | `20cc53c` glass Brief redesign | none (its only consumer, the glass Brief, is gone) | no | no | **DELETE** |
| `lib/hero-region.ts` | timezone → Earth-image region map | `20cc53c` | only `HeroRegionProvider.tsx:41` | no | no | **DELETE** (with it) |
| `components/brief/BriefLogo.tsx` | theme-aware 4M mark | `20cc53c` | prose only: `components/ui/AppLogo.tsx:10,15` (its successor) | no | no | **DELETE** |
| `components/plaid/AccountRefreshButton.tsx` | per-connection refresh button over `POST /api/plaid/refresh` | `a72d789` retire legacy investment workspace | `AccountsPerspective.test.ts:111` pins its ABSENCE | no | no | **DELETE** |
| `components/atlas/InlineFilter.tsx` | compact text range selector for modals | `20cc53c` | prose only: `ToolbarMenuButton.tsx:8`, `ThemeProvider.tsx:37` | no | no | **DELETE** |
| `components/atlas/tones.ts` | `BriefTone` → colour map | `20cc53c` | prose only: `lib/brief-types.ts:22` | no | no | **DELETE** |
| `components/space/widgets/TimelineWidget.tsx` | self-fetching 60-event audit timeline | `82c45aa` Space rename (from the v2.0 widget family) | prose only (`lib/perspectives.ts:481,495`, `SpaceDashboard.tsx:543,754`, `ActivityWorkspace.tsx:26`, `lib/timeline-types.ts:6`, `lib/perspective-icons.ts:7`, activity/*.tsx headers) — all claim it still renders `recent_activity`; `SpaceSectionStack.tsx` imports no widget, so the claim is stale | no | no | **DELETE**; stale prose listed in §12.2 |
| `components/space/widgets/ProgressWidget.tsx` | goal/budget progress bar (trip_budget, savings…) | `82c45aa` | `lib/atlas/palette-ratchet.baseline.json:27` (baseline key; stale keys are harmless, cleared by `--update`) | no (Goals retired, W2) | no | **DELETE** |
| `components/space/widgets/AssetValueWidget.tsx` | property/vehicle value card with purchase price + gain | `82c45aa` | none in code; **named by `docs/plans/UNIVERSAL-FINANCIAL-CONNECTOR-ARCHITECTURE-P0.md:571`** (RWA section) | **yes — RWA** | no | **PRESERVE** (brief: preserve anything the connector doc names) |
| `components/ui/UserButton.tsx` | legacy user menu button | `b2564b4` v1.0 | prose `NotificationBell.tsx:8,179`; palette baseline key | no | no | **DELETE** |
| `components/dashboard/widgets/GlassModal.tsx` | routed-modal shell (W2 retired the mechanism) | `0796bf0` | `workspaces.test.ts:86` pins its ABSENCE from the host; prose elsewhere | no | no | **DELETE** |
| `lib/ai/domain-manifest.ts` | ordered assembler domains per Space category | `ada22a0` AI context builder | **LIVE**: `scripts/test-visibility-two-user-space.impl.ts:72,149` (KD-1/KD-15 DB privacy harness, kept by `scripts/run-tests.ts:43`) | no | no | **KEEP** (audit's "0 importers" missed the script) |
| `lib/ai/domain-relevance.ts` | CF-6 concept-breadth resolver | `93b46c0` | test-only: `domain-relevance.test.ts`; **`lib/ai/economic-concepts.test.ts:271-275` (D's) reads its source** | no | no | **READY TO DELETE, not deleted** — needs D to drop the 2 checks at `economic-concepts.test.ts:269-275`; then `git rm lib/ai/domain-relevance.ts lib/ai/domain-relevance.test.ts` |
| `lib/forecast/spending-baseline.ts` | `PeriodBasis`, `dailySpendRate`, `assertedSpendingBaseline`, `MEAN_MONTH_DAYS` + the dead `deriveSpendingBaseline` | `V26-REASONING` | **NOT dead**: imported by `lib/forecast/{engine,policy,operating-state}.ts`, `lib/ai/forecast/assemble.ts` (B) | no | no | **KEEP**; only the export `deriveSpendingBaseline` is dead (its absence from callers is already pinned by `engine.test.ts:752`, `operating-state.test.ts:234`) — B may prune that export |
| `lib/ai/conversation/compaction.ts` | tool-history compaction | AI baseline harness | `lib/ai/conversation/turn.ts:36` (type) + `scripts/ai-baseline/{run,interactive,probes,active-scenario.*,baseline.test}.ts` | no | no | **KEEP** (harness-only on the route, but the harness is maintained and CI-tested) |
| `lib/platform/capability-classification.ts` | CONTROL mutation-family classification (scaffold) | PO | tests only; **named by dated plan** `docs/plans/PLATFORM-OPS-CONTROL-PLANE-INVESTIGATION.md` (2026-09-14) and `docs/architecture/SECURITY_MODEL.md:77` | no | no | **KEEP** (rule: dated plan names it) |
| `lib/forecast/obligation.ts` | what is owed and when (evidence-gated scaffold) | `V26-FOUNDATION` | tests only; **named by dated plans** (`AI-LIABILITY-DYNAMICS-L1-INVESTIGATION.md` 2026-09-15, `docs/systems/forecast.md:70`) | no | no | **KEEP** |

Deletion evidence is in the `CQ-002` commit message (the census command, re-run after deletion, returns no importer).

---

## 5. SCHEMA-MODEL ASSESSMENT (document only; no `prisma/**` change)

| Model | Readers (prod) | Writers (prod) | Row-owning data | RLS (policies / enable+force / grants) | Tombstone audit | Recommended disposition |
|---|---|---|---|---|---|---|
| `SpaceGoal` | 0 | 0 | goal rows from the retired Goals surface (W2) | 0 / 0 / 0 | `audit-goals-tombstone` (REQUIRED) | **drop in the next schema train** (export any rows first if non-empty) |
| `GoalCheckIn` | 0 | 0 | same | 0 / 2 / 0 (RLS enabled+forced, no policy ⇒ unreachable to fm_app anyway) | same | drop with `SpaceGoal` |
| `GoalContribution` | 0 | 0 | same | 0 / 2 / 0 | same | drop with `SpaceGoal` |
| `AiAdvice` | 2: `lib/data/advice.ts` (`findFirst`), `lib/export/assemble.ts:303` (`findMany`, export) | 0 (`prisma/seed.ts` only; KD-14) | seed-only rows | 0 / 0 / 0 | none | **drop in a later train** after removing the two readers (export can keep an empty `aiAdvice: []` for format stability) |
| `Holding` | 0 production readers (forbidden by `lib/data/accounts.ts:16-22`; `scripts/*` count/purge only) | `lib/investments/sync-current-holdings.ts:188-226` (dual-write) + `scripts/rls-app-acceptance.ts` fixtures | current-holdings mirror of `PositionObservation` | 0 / 0 / 0 by name grep (the RLS acceptance script writes it as fm_app — verify the policy name before any drop) | `audit-crypto-holding-tombstone` (REQUIRED) | **stop the dual-write first** (delete the `holding.*` block in `sync-current-holdings.ts` — C/B area), keep the tombstone, then drop in the train |

Both tombstone audits remain green at HEAD.

---

## 6. ARCH-007 / CQ-009 — route deletions (commit `ARCH-007`)

Consumer verification: `fetch(`/template-string/`apiFetch` grep over `lib components app context hooks site scripts jobs`, docs plans by path.

| Route | Consumers | Decision |
|---|---|---|
| `POST /api/plaid/sync` | **none** — its own header: "no UI is wired to this yet"; prose only in `lib/plaid/{refresh.ts:761,refreshCooldown.ts:6,syncTransactions.ts:11,backgroundHistorySync.ts:21}`, `app/api/plaid/resume-sync/route.ts:5` | **DELETED** |
| `GET /api/spaces/[id]/investments` (`route.ts`) | **none** — the live reader is the sibling `investments/space-data` (kept, listed in `rls-foreground-acceptance.ts:402`) | **DELETED** (`route.ts` only; `space-data/` kept) |
| `GET /api/spaces/[id]/snapshots` | `lib/space/use-space-data.ts:228` | **KEPT** (audit wrong) |
| `GET /api/spaces/[id]/transactions` | `lib/space/use-space-data.ts:254` | **KEPT** (audit wrong) |

Pins updated for `/api/plaid/sync` (9 files; all pass): `lib/refresh/refresh-routes.test.ts:46` (**C**), `scripts/rls-foreground-acceptance.ts:406` (**F/C**), `lib/plaid/execution-convergence.test.ts:41,102,125-127,146`, `lib/plaid/sync-lock.test.ts:249`, `lib/plaid/refresh-fanout.test.ts:463`, `lib/notifications/wave3.test.ts:461`, `lib/platform/admission/producer-convergence.test.ts:65,233`, `lib/platform/admission/admission-boundary.test.ts:83`, `lib/security-surface.test.ts:72`. Census denominators lowered deliberately: `lib/platform/admission/producer-convergence.test.ts:118` 8 → 7 and `lib/platform/admission/admission-boundary.test.ts:232` 12 → 11 (both `as const` arrays, so the comparison is widened with `as number`). `app/api/spaces/[id]/rls-t2-route-authority.test.ts` does not count `investments/route.ts` (its eleven-file inventory names the other routes) — no change needed. Now-orphaned in unowned code: `lib/data/investment-accounts.ts getInvestmentAccountsView` (only the deleted route called it; the `InvestmentAccountsSlice` type and `assembleInvestmentAccounts` stay live) — recommend pruning the function later.

---

## 7. CQ-008 — one monthly-interest formula (commit `CQ-008`)

`lib/debt.ts estimateMinimumPayment` now calls `estimatedMonthlyInterest` from `lib/debt/interest-cost.ts` (`amountOwed` = `max(balance, 0)` = the old `safeBalance` clamp, so every figure is unchanged). New `lib/debt/interest-cost.test.ts` pins the authority's semantics (0 % known, null unknown, credit balance → 0), the parity of `estimateMinimumPayment` over six cases, that `lib/debt.ts` carries no inline `/100/12`, and `computeInterestCost`. `lib/debt-space-data.ts` is a time-composition contract that shares the name only (no formula); untouched and working. The three-homes naming (`lib/debt.ts` / `lib/debt/` / `lib/debt-space-data.ts`) is CQ-010 territory — not renamed.

---

## 8. ARCH-001 / CQ-007 — membership authorities (assessment)

Authorities: (1) `requireSpaceRole(spaceId, minRole)` `lib/session.ts:417` — tenant phase, role floor; (2) `requireSpaceAction(spaceId, action)` `lib/spaces/authorize.ts:111` — tenant phase, `can()` policy; (3) `resolveSpaceContext` `lib/space.ts:168-240` — migration principal `db`, page/cookie context; (4) inline `spaceMember.*`.

Inline sites and what they would take to consolidate (none are in my owned paths; none edited):

| Site | Semantics | Replaceable by | Verdict |
|---|---|---|---|
| `app/api/spaces/[id]/route.ts:97` | ACTIVE member **or** `space.isPublic` | `requireSpaceRole(id, VIEWER)` would 403 PUBLIC non-members | **not trivially** — the public-Space arm is a product rule |
| `app/api/space/switch/route.ts:53` | ACTIVE member, 403 otherwise (no existence disclosure) | `requireSpaceRole(spaceId, VIEWER)` — identical: ACTIVE row with role ≥ VIEWER, 403 | **replaceable** (A's file). Edit: replace the `withTenantDb … findUnique` + status check with `const [auth, err] = await requireSpaceRole(spaceId, SpaceMemberRole.VIEWER); if (err) return err;` and use `auth.membership` for the audit row |
| `app/api/spaces/[id]/invite/route.ts:104` | is the **target** already ACTIVE? (409) | not an authorisation check (caller already gated) | keep inline |
| `app/api/spaces/[id]/members/[userId]/route.ts:129,196` | **target** membership lookup for PATCH/DELETE | not a caller check | keep inline |
| `app/api/accounts/manual/route.ts:139,151` | resolve the caller's PERSONAL Space; validate extra Space ids are ACTIVE memberships | `resolvePersonalSpaceId` (`lib/accounts/space-account-link.ts:107`) for the first; the second is a batch check with no helper | first is a duplicate of `resolvePersonalSpaceId` — **replaceable** (unowned) |
| `lib/imports/authorize.ts:157` | caller has OWNER/ADMIN in Space | `can()` (`lib/spaces/policy.ts`) over the same row — the lookup must stay (import authorisation takes a `client`), but the role test could call `can(membership.role, "account:import")` | partial |
| `lib/accounts/space-account-link.ts:110` | the caller's personal Space (resolver) | — it IS the helper | keep |
| `lib/ai/absence.ts:209` | "does any ACTIVE member exist" (evidence state) | not auth | keep |
| `lib/spaces/default-space.ts:63` | eligibility of a stored default Space | not auth | keep |

The one security-relevant divergence stays `resolveSpaceContext` on the migration principal (audit ARCH-001); converting it is the RLS-cutover item, not a wave-1 hygiene edit.

---

## 9. CQ-006 — direct `auditLog.create(` sites (assessment) and the ESLint rule for Agent F

Count at HEAD (non-test, `app lib jobs scripts components`): **82** — `app/api` 61, `lib/account-deletion` 3, `lib/plaid` 3, `lib/connections` 2, `lib/transactions` 2, `lib/email` 1, `lib/events` 1, `lib/security` 1, `lib/snapshots` 1, `lib/audit.ts` 1 (the sanctioned `auditInsert`/`recordOperatorAction` home) + 2 prose, `scripts/admin-promote.ts` 1, `scripts/rls-foreground-acceptance.ts` 3 (negative-control probes; keep).

Proposed rule (for `eslint.config.mjs`, F's):

```js
{
  files: ["app/**/*.ts", "app/**/*.tsx", "lib/**/*.ts", "jobs/**/*.ts"],
  ignores: ["lib/audit.ts", "lib/events/emit.ts", "**/*.test.ts"],
  rules: {
    "no-restricted-syntax": ["error", {
      selector: "CallExpression[callee.property.name='create'][callee.object.property.name='auditLog']",
      message: "Write AuditLog through lib/audit.ts (auditInsert / recordOperatorAction / emitDomainEvent). A direct auditLog.create() uses INSERT … RETURNING, which fm_auth refuses, and bypasses the operator envelope (CQ-006).",
    }],
  },
}
```
Ratchet: start as `warn` with the 82 sites, flip to `error` once `app/api/**` is migrated (the Growth beta routes — UI-013 — first).

---

## 10. ARCH-012 / PRIV-014 — stale prose

Fixed (mine): `app/api/platform/README.md` ("no routes here yet" → the 66-route shape by area, 2026-10-22). `README.md` has no model/tool-count claims (grep `gpt|tools|model` → 0 hits) — nothing to fix. PRIV-014: `lib/plaid/investmentsConsent.ts:9-13` now describes `additional_consented_products` on fresh links; `app/api/plaid/link-token/route.ts:186-192` (the "ONLY in update mode … never on a fresh link" paragraph that contradicted the code two lines below) removed, B2 note kept. Comments only.

Report-only (other owners): `app/api/jobs/dispatch/route.ts:3-9` (C) still describes the retired multi-slot cron schedule (`vercel.json` runs `/api/jobs/dispatch` every 15 min + `resume-stale-imports` every 5); `lib/ai/provider.ts:13` (D) "Model: gpt-4o-mini" vs the promoted `gpt-5.1` runtime; `lib/ai/conversation/tools.ts:3` (D/H) "thirteen adapters … plus the two memory tools" — `TOOLS` (:4747) has **21** entries: 18 adapters + 2 memory (`MEMORY_TOOLS`) + `describeFourthMeridian`.

---

## 11. Unused dependencies (for Agent F — CQ-001)

`grep -rn -E "@dnd-kit|recharts"` over `*.ts,*.tsx,*.mjs,*.js,*.css,*.json` (excluding `node_modules`, lockfiles, docs): **0 imports**. The only hit is a prose comment, `components/dashboard/SpacesClient.tsx:289` ("rather than recharts"). Safe to uninstall `@dnd-kit/core`, `@dnd-kit/sortable`, `@dnd-kit/utilities`, `recharts` (`package.json:104-106,126`).

---

## 12. Cross-ownership edits made (flagged) and out-of-scope changes needed

### 12.1 Edits I made outside my owned paths (minimal, revertable, each one list entry or one check)
| File | Owner | Edit | Commit |
|---|---|---|---|
| `lib/money/reporting-currency-failure-contract.test.ts:116-121` | B | removed the credit-page resolver pin | RETIRE-CREDIT |
| `lib/refresh/refresh-routes.test.ts:46` | C | dropped `plaid/sync` from the cooldown loop | ARCH-007 |
| `scripts/rls-foreground-acceptance.ts:406` | F/C | dropped `plaid/sync` from the tenant-phase route list | ARCH-007 |
| `lib/plaid/{execution-convergence,sync-lock,refresh-fanout}.test.ts`, `lib/notifications/wave3.test.ts`, `lib/platform/admission/{producer-convergence,admission-boundary}.test.ts`, `lib/security-surface.test.ts` | unowned | dropped the `plaid/sync` entries; producer census 8→7 and 12→11 | ARCH-007 |
| `lib/perspectives.ts:316` | unowned | `status: "comingSoon"` (+ note) — the registry mechanism itself | MARKETS-COMING-SOON |
| `lib/perspectives/overview-lenses.test.ts:59-60` | unowned | parity pin accepts `comingSoon` | MARKETS-COMING-SOON |
| `components/transactions/TransactionDetailDrawer.test.ts`, `components/space/widgets/debt/debt-experience.render.test.ts`, `lib/debt/balance-semantics.test.ts`, `lib/data/transactions.authority.test.ts`, `scripts/audit-account-reparenting.ts` | unowned | pins of the deleted Credit files | RETIRE-CREDIT |

### 12.2 Changes I did not make (exact edits)
1. **D** — `lib/ai/economic-concepts.test.ts:269-275`: delete the `const dr = readFileSync(… domain-relevance.ts)` block and its two `check(...)` calls; then `git rm lib/ai/domain-relevance.ts lib/ai/domain-relevance.test.ts` (0 other importers).
2. **D** — `lib/ai/provider.ts:13`: replace "Model: gpt-4o-mini …" with the promoted model name from `lib/ai/conversation/engine.ts CHAT_MODEL`.
3. **D/H** — `lib/ai/conversation/tools.ts:3`: "thirteen adapters" → "eighteen adapters … plus the two memory tools and `describeFourthMeridian` (21 entries in `TOOLS`)".
4. **C** — `app/api/jobs/dispatch/route.ts:3-9`: replace the multi-slot schedule paragraph with "`vercel.json`: `/api/jobs/dispatch` every 15 minutes; `/api/jobs/resume-stale-imports` every 5; the dispatcher selects due jobs from the `JobRun` ledger + `lib/jobs/cadence-policy.core.ts`".
5. **A** — `app/(shell)/dashboard/layout.tsx:49`: drop `/dashboard/credit` from the parenthetical.
6. **A** — `app/api/space/switch/route.ts:53-58`: replace the inline membership check with `requireSpaceRole(spaceId, SpaceMemberRole.VIEWER)` (identical semantics; see §8).
7. **B** — `lib/forecast/spending-baseline.ts`: remove the dead `deriveSpendingBaseline` export (and the matching block of `spending-baseline.test.ts`) — the "must not be revived" item; keep `PeriodBasis`, `dailySpendRate`, `assertedSpendingBaseline`, `MEAN_MONTH_DAYS`.
8. **C/B** — `lib/investments/sync-current-holdings.ts:188-226`: stop the `Holding` dual-write (schema train prerequisite); `scripts/rls-app-acceptance.ts` fixtures then lose their `holding.*` probes.
9. **unowned** — `lib/data/transactions.ts`: delete `getDebtTransactions`, `getDebtPaymentRows` (orphaned by RETIRE-CREDIT); `lib/data/investment-accounts.ts`: delete `getInvestmentAccountsView` (orphaned by ARCH-007); `lib/atlas/palette-ratchet.baseline.json`: remove the `ProgressWidget.tsx`/`UserButton.tsx` keys (or run `npx tsx lib/atlas/palette-ratchet.test.ts --update`).
10. **unowned prose** naming the deleted `TimelineWidget` as the `recent_activity` renderer: `lib/perspectives.ts:481,495`, `components/dashboard/SpaceDashboard.tsx:543,754`, `lib/timeline-types.ts:6`, `lib/perspective-icons.ts:7`, `components/space/widgets/activity/{ActivityHero.tsx:9,event-visuals.tsx:14,useActivityFeed.ts:8}`, `app/api/spaces/[id]/activity/route.ts:5`; and the Credit prose list in §1.
11. **Optional "hide Markets for beta"** — see §3 residual.

---

## 13. Commits and gates

```
51bc553 CQ-002: delete 11 confirmed orphan components and lib/hero-region.ts
046b655 PRIV-014 + ARCH-012: fix comments that contradicted the code (comments only)
fdd34cc CQ-008: one monthly-interest formula — estimateMinimumPayment folds onto estimatedMonthlyInterest
a69674f MARKETS-COMING-SOON: gate Markets behind the registry's comingSoon status (UI-014)
1d4bf78 ARCH-007: delete POST /api/plaid/sync and GET /api/spaces/[id]/investments (CQ-009)
88cdaee RETIRE-CREDIT: delete the orphaned Credit page and DebtClient (UI-015)
```
(+ this report commit.) No RETIRE-GROWTH commit: the classification (§2) found nothing to remove.

| Gate | Result at `51bc553` |
|---|---|
| `npm run typecheck` (`tsc --noEmit`) | **exit 0, 0 errors** (run after each code commit group) |
| `npm run lint` | **exit 0 — 0 errors, 18 warnings** (audit baseline: 19 warnings on CI) |
| `npm run test:unit` (full) | **NOT RUN by instruction** — the orchestrator runs it after integration (parallel full runs caused memory-pressure kills on the 8 GB host) |
| Affected test files, run individually with `npx tsx` (+ `server-only` preload where the runner uses it) | **45/45 pass**: Credit 9 (`space-nav`, `TransactionDetailDrawer`, `debt-experience.render`, `balance-semantics`, `transactions.authority`, `reporting-currency-failure-contract`, `DebtWorkspace`, `user-terms`, `AccountsPerspective`); ARCH-007 9 (`execution-convergence`, `sync-lock`, `refresh-fanout`, `wave3`, `refresh-routes`, `producer-convergence`, `admission-boundary`, `security-surface`, `perspective-engine/route`); Markets 6 (`workspaces`, `overview-lenses`, `workspace-definition`, `space-markets-nav`, `space-workspace-nav`, `DebtWorkspace`); CQ-008 2 (`interest-cost` new, `payoff`); CQ-002 6 (`palette-ratchet`, `AccountsPerspective`, `workspaces`, `brief-flow`, `brief-provenance`, `GlassPanel`) — a file counted once per group in which it was run |
| CI REQUIRED audits touched | `audit-account-reparenting`, `audit-goals-tombstone`, `audit-crypto-holding-tombstone`: **pass** |
