# Fourth Meridian — Post-SD-8 Codebase Invalidation & Architecture Efficiency Audit

**Date:** 2026-07-16
**Branch:** `feature/v2.5-spaces-completion` · **HEAD:** `da4b385` (`test(spaces): SD-7 — source-scan ratchet locking the Standard Workspace extraction`)
**Posture:** Adversarial invalidation review. Investigation only — no runtime code was modified, deleted, committed, or pushed. Every material claim below was verified against the working tree with fresh greps, file reads, and `ts-prune` reachability analysis; where a claim comes from a prior audit and was *not* re-verified, that is stated.

**Honest scope note (SD-8).** No commit, STATUS row, or doctrine section in this tree carries the label "SD-8." The Spaces Decomposition wave present at HEAD is SD-0A → SD-7 plus the SD-7 source-scan ratchet, all landed 2026-07-16. This audit treats that completed wave as the "post-SD-8" state the brief describes (the ratchet/test-scrub commit is the last SD artifact). If SD-8 designates additional work, it is not in this tree and this baseline should be re-stamped when it lands.

---

## Executive summary

The SD wave was real. `SpaceDashboard.tsx` went from 3,725 to 1,481 lines; a single URL authority (`useSpaceUrl`, SD-0A) replaced four independent `window.history` writers; a single time reducer owns the shell triple; five financial workspaces now own their own data through activated `*SpaceData` contracts (Investments' composed loader — "zero consumers" this morning — is now the production path); and the Platform surface composes the same `SpaceShell` frame as customer Spaces. Several items every prior audit flagged as dead or dark are now live: `cash-flow-compare` has consumers, `space-templates` is wired into the create/register routes, A9 is trigger-wired, `loadInvestmentsSpaceData` serves the Investments workspace.

The decomposition also *moved* weight rather than removing it, and left a debris field. The largest UI file in the repo is now `SpaceSections.tsx` (1,584 lines, 63 renderer entries, its own goals CRUD, 6 fetch sites) — a mini-monolith created *by* the extraction. The host still holds 31 `useState`, 18 `useEffect`, 12 `fetch` sites, a five-way envelope-relay switchboard, and a hardcoded workspace ternary ladder that the new registry does not drive. The cutover stranded a dead hook + route pair (`useInvestmentsTimeMachine` → `/investments/time-machine`) that golden tests keep green. The Personal page still server-fetches accounts, 365 days of snapshots, and the full transaction list — and now **throws all of it away** (`PersonalDashboard` destructures only `ficoScore`; the props are documented "currently unused"). The `AiAdvice` surface ships a page claiming "Runs 2× daily" against a table with zero write paths. Six-plus history mechanisms with ≥3 as-of semantics survive intact, one divergence channel now *test-pinned as intentional*. Money is still 59 `Float` columns and 0 `Decimal`. 99 of 268 test files (37%) are regex source-scans. STATUS.md (212KB) was last written at 02:31 — sixteen SD commits ago, same day: the truth file does not know about the repo's largest architecture change.

**Bottom line:** the workspace decomposition earned its complexity; roughly 8–12k LOC of the remainder did not — dead pairs, discarded fetches, a parallel legacy debt surface, a metadata registry whose query API nothing calls, and duplicated CRUD in a modal the wave never touched. A scoped cleanup initiative is justified. The historical-system consolidation is justified too, but needs its own runtime-diff investigation first.

---

## 1. Repository baseline

| Metric | Value |
|---|---|
| Branch / HEAD | `feature/v2.5-spaces-completion` / `da4b385` (SD-7 ratchet) |
| Working tree | Clean except untracked: `.claude/`, two root review docs, two mockup PNGs, one platops doc |
| Tracked files | 1,628 |
| TypeScript LOC | 126,202 (809 files) |
| TSX LOC | 46,378 (242 files) |
| ts+tsx total / non-test | 172,580 / 134,756 |
| Test LOC | 37,824 across 268 `*.test.ts(x)` files (22% of ts+tsx) |
| Markdown LOC | 87,741 (436 files; `docs/` = 83,217 across 410 files; STATUS.md alone 212KB) |
| Prisma | 2,772 lines, 50 models, 76 migrations (3,132 SQL LOC) |
| JSON | 12,436 (lockfile-dominated) |
| Binary excluded | 22 PNG, 1 ICO |

**Growth.** The repo's first migration is 2026-06-09 — the codebase is ~5 weeks old. Against the 2026-07-07 audit baseline (`f7337df`, 634 ts/tsx files ≈ 110k LOC), the tree grew **+73,806 / −11,695 ts+tsx lines in 9 days** (net +62k, ~+57%) to 1,051 files. The SD wave itself (e8c4768 → HEAD, one day) was +10,893 / −4,651 across 93 files. Attribution of the 9-day surge, in rough order: the A-series historical/investments systems, the SD decomposition + its contract layers, platform ops (PO1.0), test scaffolding (37.8k test LOC), and AI intelligence modules. The oft-quoted "~80k → ~170k" is directionally right if the earlier figure excluded tests; measured, it is ~110k → ~172.6k including tests. Growth is **not** primarily duplication — but §3 and §21 identify the portion that is.

**Workspace hygiene (not tracked, still a finding):** `_to_delete/` holds **414MB of repo tarballs** (`fm_repo.tar.gz`, `_fm_snapshot.tar.gz`, a `_staging_tmp` dir, …) in the working tree. Untracked, but sitting inside the project root of a repo whose docs process is this heavy is how a tarball eventually gets committed. Delete outside git.

---

## 2. System map

| Subsystem | Authority (module) | Inputs → Outputs | Consumers | Seam status |
|---|---|---|---|---|
| App shell / nav | `app/(shell)`, `Sidebar.tsx`, `lib/space-nav.ts` | session/space ctx → routed surfaces | all pages | live |
| SpaceShell | `components/space/shell/SpaceShell.tsx` (146) | slots (rail/toolbar/overlays) → frame | SpaceDashboard, PlatformSpaceDashboard | live, converged (SD-1/SD-2E) |
| URL authority | `components/space/shell/useSpaceUrl` + `lib/space/space-url` | URL ⇄ commits/subscribe | host, shell time hook, wealth metric | live, singular (SD-0A) |
| Time authority | `lib/perspectives/time-range.ts` reducer via `usePerspectiveShellState` | presets/asOf/compareTo | all perspectives | live, singular + CF explicit-period mirror (SD-0B) |
| Workspace identity | `WORKSPACE_REGISTRY` (`lib/perspectives.ts`) = STANDARD_WORKSPACES + PERSPECTIVE_LIBRARY | id → def, dataNeeds, routing | host, SD-3 resolver | live; **does not own composition** (§11) |
| Declarative loading | `lib/space/workspace-resources.ts` | id → dataNeeds set | host activation booleans | live (SD-3) |
| Workspaces (financial) | Wealth/CashFlow/Liquidity/Investments/Debt under `components/space/widgets/*` | contracts + shell time → render + envelope | host ladder | live (SD-4…6) |
| Workspaces (standard) | Overview/Accounts/Activity/Transactions/Members (24–198 LOC each) | section stack / panels | host ladder | live (SD-7), thin pass-throughs |
| Section subsystem | `components/space/sections/SpaceSections.tsx` (1,584; `SectionRegistry` 63 renderers) | DashboardSection rows → cards | workspaces, RoutedWorkspaceModal, virtual sections | live; **new mini-monolith** |
| Widget metadata | `lib/widget-registry.ts` (1,193; 53 entries) | key → label/meta | `getWidgetMeta` only | **query API + `dataTier` dead** |
| Platform Spaces | `platform/[area]/page.tsx` → `PlatformSpaceDashboard` (199) + `widget-kit` | PlatformGrant → self-fetching widgets | platform users | live; own 2 registries |
| Flow semantics | `flow-classifier.ts` (write, v2) / `flow-predicates.ts` (read) | Plaid rows → FlowType | folds, AI, population | live, singular write |
| Transfer evidence | `plaid-transfer-evidence` → `transfer-evidence-write` → `RelationshipResolver` | provider strings → evidence axes → read-time pairs | cash-flow, liquidity | live |
| Cash-flow folds | `lib/transactions/cash-flow.ts` + `cash-flow-compare.ts` + `cash-flow-space-data.ts` | tx rows → folds/compare | CashFlowWorkspace, envelope | live (compare **activated** by SD) |
| Money/FX | `lib/money/convert`, `lib/fx/*` | amounts+ctx → converted, tainted | everywhere | live, best subsystem |
| Snapshots (live) | `lib/snapshots/regenerate.ts` | balances → today's SpaceSnapshot | events, jobs | live |
| History (see §6) | `backfill.ts`, `regenerate-history.ts` (A9), `snapshot-amendment.ts`, `reconstruction-core/runner` (A4), `investments-time-machine` (A10), `wealth-time-machine`, `liquidity/historical-splice`, `getAccountsAsOf` | various → past values | wealth/debt/liquidity/investments | live, **overlapping** |
| Provider: Plaid | `lib/plaid/*` (refresh 738, syncTransactions 538, exchangeToken 645) | Plaid API → canonical rows | jobs, routes | live |
| Provider: crypto | `lib/crypto/btc-sync.ts` (656) | chain → Holding (legacy) + PositionObservation (spine) | wealth, AI, export | **dual-write, 3-way read split** |
| Provider seam | `lib/providers/plaid/adapter.ts`, `lib/providers/catalog.ts` | — | **none** | decorative |
| Imports | `lib/imports/*`, `lib/investments/investment-import-*` | CSV → batches, events | routes, wizard | live |
| AI | `app/api/ai/chat/route.ts` (2,199), assemblers, `annotations.ts` (2,184), intent, signals, context-priority | space data → context → LLM → validated output | chat UI | live; serialization hoarded in route |
| AiAdvice | `lib/data/advice.ts` + advice page + AdviceBanner | AiAdvice table → UI | 3 read surfaces | **zero write paths — dead feature** |
| Jobs/cron | `jobs/*` via `/api/jobs/dispatch` + JobRun ledger | cron secret → serial loops | ops widgets | live; no queue/fan-out |
| AuthZ | `lib/session.ts` (requireUser/SpaceRole/SystemAdmin), `lib/spaces/authorize`, `lib/platform/authorize`, `merchant-ops-access` | session → guards | 129 API routes | live, consistent (§19) |
| Legacy surfaces | `/dashboard/credit` + `DebtClient` (1,240), `ManageSpaceModal` (1,742), `/dashboard/advice` | — | FicoCard links; Manage button | **parallel/duplicated** |
| Design system | `components/atlas/*` (+ vendored liquid-glass) | primitives | all UI | live; some orphan exports |
| Tests/ratchets | `scripts/run-tests.ts` + 268 files | — | CI/local | live; 37% source-scans |

---

## 3. Dead-code and reachability audit

Method: `ts-prune` over the full tsconfig (Next.js framework exports and barrel re-export noise filtered), then **manual verification of every claim below** — ts-prune produced at least one false positive (`planContextSelection` is live via the chat route; `types/index.ts` flags were not reproducible and are excluded).

### DEFINITELY DEAD (verified: zero non-test, non-comment references)

| Item | Evidence |
|---|---|
| `useInvestmentsTimeMachine` hook (`components/space/widgets/investments/useInvestmentsTimeMachine.ts`) | Replaced by `useInvestmentsSpaceData` (SD-4D+). Zero component consumers; referenced only by its own file and comments. |
| `/api/spaces/[id]/investments/time-machine/route.ts` | Its only fetcher is the dead hook above. The route's "JSON byte-identical" golden contract is now defending an unreachable endpoint. (`loadInvestmentsHistory` itself stays live inside the composed loader.) |
| `plaidAdapter` (`lib/providers/plaid/adapter.ts`) | Defined, never imported. The provider-adapter seam exists as a gesture only. |
| `lib/providers/catalog.ts` — `listProviderCatalogEntries`, `listEnabledProviderCatalogEntries`, `getProviderCatalogEntry` | No importers. |
| `lib/data/snapshots.ts` — `getSnapshotAsOf`, `getPortfolioHistory` | No importers (`getSnapshotAsOf` survives only as a phrase in a wealth-time-machine comment). Duplicate as-of logic that §6 wants gone anyway. |
| `lib/data/transactions.ts` — `getInvestmentTransactions` | No importers. |
| `ensureHomeLink` (`lib/accounts/space-account-link.ts:313`) | No importers. |
| `renderDebtPayoffSnapshot` (`debt-perspective-adapters.tsx:286`) | No importers (one comment mention). |
| `lib/api.ts` — `ok`/`created`/`badRequest`/`notFound` | Response-helper API nothing uses; routes hand-roll `NextResponse`. |
| `widget-registry` query API — `getWidgetEntry`, `isWidgetImplemented`, `isDeprecatedAlias`, `getAllWidgets`, `getWidgetsForTab` | The registry's entire query surface is unused; the sole live consumer is `getWidgetMeta` (labels for virtual sections). |
| `WidgetRegistryEntry.dataTier` (54 occurrences in `widget-registry.ts`) | Consumed by nothing; one comment in `SpaceSections.tsx` refers to it aspirationally. Confirms the 07-16 review's finding — still true after SD. |
| Misc orphan UI exports: `CoinIcon`, `Sparkline` (wealth-ui), `TONE_BORDER`, `useHeroRegion`, `HERO_REGION_LABEL`/`HERO_REGIONS`, vendored `LiquidGlassCard` + settings exports, `formatCurrency` (lib/currency), `getGreeting`/`GREETING_PLACEHOLDER`, `_debugCacheSize`, `generateTOTP` (the standalone export) | ts-prune + spot verification. Individually trivial; collectively ~1–2k LOC of surface that misleads readers about what is load-bearing. |

### Dead *data flow* (code is reachable; its output is discarded)

| Item | Evidence |
|---|---|
| **Personal page server fetch-and-discard** — `app/(shell)/dashboard/page.tsx:87-108` awaits `getAccounts`, `getRecentSnapshots(365)`, `getTransactions`, then builds `serializeSpaceConversionContext` over **every transaction row**; `PersonalDashboard` (107 LOC) destructures **only `ficoScore`** and its prop block admits the rest is "currently unused… kept on the prop contract to avoid churning page.tsx." | Every Personal dashboard load performs 4 DB reads (including the full KD-7-capped transaction fetch) plus FX-context serialization whose results are garbage-collected, then the client re-fetches the same three resources. The old double-fetch became fetch-and-discard — strictly worse than either single path. |
| `AiAdvice` feature surface — 0 write paths anywhere (`grep aiAdvice.(create|upsert|update)` = empty); read by `/dashboard/advice` page, `AdviceBanner` (203 LOC, also mounted in `AnalyzeClient`), brief route, export | The advice page tells users the engine "Runs 2× daily." The table is permanently empty. This is the 07-07 audit's "never-executable flagship" still shipping a UI. |
| `SnapshotAmendment` / `SnapshotAmendmentDay` tables — 2 write sites, 0 product reads | Write-only ledger. Defensible as a consent audit artifact, but nothing surfaces it; classify DORMANT-BUT-PLANNED and either build the read or say it's an audit table in schema comments. |

### MIGRATION-ONLY / TRANSITIONAL (alive, but only because a seam never closed)

| Item | Evidence |
|---|---|
| `/dashboard/credit` + `DebtClient.tsx` (1,240 LOC) | Parallel personal debt surface predating `DebtWorkspace`. Reachable only through two `FicoCard` links. Two debt UIs now answer the same questions from different code paths. |
| Legacy `Holding` bridge | `getHoldings` (`lib/data/accounts.ts:241`) still reads `db.holding`; crypto sync still dual-writes; Wealth still values crypto from `FinancialAccount.balance`. Three concurrent crypto valuation sources until the written Part-9 census gate closes. Reads=9 / writes=4 in the census. |
| `Transaction.financialAccountId` / `Holding.financialAccountId` still nullable | Residue of the Account retirement; the retirement itself is complete. |
| `mapPlaidCategory` upstream of the classifier | Improved — it now lives in `lib/transactions/plaid-category.ts` (a semantic module, no longer buried in the parser) and is re-exported from `syncTransactions.ts` — but it remains a lossy pre-stage under `classifyFlow`. |

### Stale prose masking live/dead state (doctrine drift, post-SD edition)

- `lib/space-templates/registry.ts:13` still says "nothing in the app reads this registry yet" — false; the register and create routes read it (SP-2 landed).
- `app/(shell)/dashboard/page.tsx:20` still says "the unified SpaceDashboard has no URL sync" — false since SD-0A; the host now has full `?tab/?perspective` sync.
- STATUS.md (last write 02:31) predates all 16 SD commits. The project's single truth file does not contain its largest refactor.
- `plaid-transfer-evidence.ts` "ONLY module that knows" claim vs `flow-classifier.ts` `ACCOUNT_TRANSFER` string-match: **not re-verified this pass**; carried from the 07-16 self-audit where it was confirmed.

---

## 4. Monolith audit

Ranked by architectural problem, not LOC. Counts are fresh (`grep -c`).

| Rank | File | LOC | Density evidence | Verdict |
|---|---|---|---|---|
| **A** | `app/api/ai/chat/route.ts` | 2,199 | Route hoards intent routing, context assembly orchestration, serialization, validation, drilldowns. Untouched by SD. Every future AI surface must duplicate or force the extraction. | Architectural problem |
| **A** | `components/dashboard/ManageSpaceModal.tsx` | 1,742 | Seven inlined sub-apps (GeneralTab, MembersTab :533, GoalsTab :818 with its own edit/delete/complete CRUD, ShareExistingAccountsPanel, FinancesTab, DashboardTab). Goals CRUD now exists in **three** places (GoalsTab, GoalsCard-in-SpaceSections, AddGoalModal); Members in two (MembersTab vs MembersWorkspace). The SD wave extracted the dashboard and left its modal twin intact. | Architectural problem |
| **A−** | `lib/ai/intelligence/annotations.ts` | 2,184 | Single-domain but responsibility-dense; pairs with the chat route. | Concerning–problem boundary |
| **B** | `components/space/sections/SpaceSections.tsx` | 1,584 | **Created by SD-7 part 2.** 63 `SectionRegistry` renderers + `SectionCard` + `formatBalance` + an embedded ~430-line GoalsCard with 6 fetch sites, 14 useState. The god component's widget zoo was relocated wholesale, not decomposed. Also exports shared helpers, so everything imports it. | Concerning |
| **B** | `components/dashboard/SpaceDashboard.tsx` | 1,481 | Down from 3,725 — real progress. Still: 31 useState, 18 useEffect, 12 fetch sites, 5 envelope-relay states + 6-way envelope ternary, hardcoded 5-branch workspace ladder, in-host emergency-fund math (`months covered`, :967-976) violating host-never-computes, member-count fetch of the full space object. | Concerning |
| **B** | `components/dashboard/SpacesClient.tsx` | 1,293 | Space list + create/join/invite flows in one client file. | Concerning |
| **B−** | `components/dashboard/DebtClient.tsx` | 1,240 | Legacy parallel surface (§3) — the problem is duplication, not size. | Deprecate, don't split |
| **C** | `lib/ai/assemblers/transactions.ts` (1,434), `lib/widget-registry.ts` (1,193), `lib/ai/types.ts` (1,019), `prisma/seed.ts` (1,484) | — | Large but single-purpose; registry's issue is dead weight (§3), types file is type-only. | Large but justified |
| **C** | `SpaceTransactionsPanel.tsx` (967), `app/admin/security/page.tsx` (743), `lib/plaid/refresh.ts` (738), `app/api/brief/route.ts` (650) | — | Watch list. | Large but justified |

The pre-SD fear — "replace one monolith with several accidental mini-monoliths" — half-materialized: the host halved, but `SpaceSections.tsx` + `ManageSpaceModal` + the chat route mean the top of the ranking looks structurally the same as last week minus ~2,200 lines.

---

## 5. Semantic architecture invalidation

**Singular authorities hold** at the classifier/predicate boundary (one versioned writer, one pure reader; fold discipline intact in `cash-flow.ts`). SD-4's contract-priming also gave Cash Flow and Debt real composition contracts, and the envelope vocabulary (`PerspectiveEnvelope`) is now emitted by all five financial workspaces — an improvement over host-computed trust.

**Surviving duplications (all re-verified today):**
- `isReconstructableCard` now has **three** verbatim copies (`snapshots/backfill.ts:69`, `snapshots/regenerate-history.ts:67`, `data/accounts-asof.core.ts:69`) — up from two at the last review. A financial predicate is being maintained by parallel edit.
- The income/expense/transfer partition is still stated ≥3 times (`flow-predicates`, `BANKING_POPULATION` in `lib/data/transactions.ts`, AI assembler), reconciled by population tests only.
- `SPEND_CATEGORIES` (`flow-classifier.ts:118`) still hand-mirrors the Prisma enum with no compile guard.
- Account-name resolution (`displayName ?? officialName ?? plaidName ?? name`) remains convention-by-comment across ≥3 files (`investments/space-data.ts` cites the other copies rather than importing one function).
- Flow predicates remain stringly-typed (`Flow = string | null | undefined`) on the read path.
- Envelope resolution now has **two** code paths by design: workspace-emitted envelopes for the five financial lenses, `resolvePerspectiveEnvelope` for the rest. Acceptable, but it is a new dual authority the doctrine should name.

**Could two code paths answer the same financial question differently?** Yes — still, and now partly *by ratified design*: A10's "investments" includes digital assets; the snapshot path's `totalInvestments` excludes them (`excludeDigitalAssetAccounts: true`, `regenerate-history.ts:382`), and `valuation.investment-bucket.test.ts` asserts **both** sides. Divergence is pinned green. Same for Wealth's balance-basis-today vs valued-basis-history kink, and the `detailEligible` vs `all` population split (`investments-time-machine.ts:77-79` re-verified).

---

## 6. Historical-system audit

Census at HEAD — **seven mechanisms plus a consumer-level splice**, unchanged in count by the SD wave (which activated but did not consolidate them):

| # | Mechanism | Question answered | Reads | Persists | As-of rule |
|---|---|---|---|---|---|
| 1 | `regenerate.ts` | "what is today worth" | live balances via `classifyAccounts` | today's SpaceSnapshot | n/a |
| 2 | `backfill.ts` | "fill the last 30 days" | balances + tx walk-back | create-only estimated rows | own walk-back |
| 3 | `regenerate-history.ts` (A9) | "re-derive estimated history" | links, tx, A8 valuation per day | overwrites estimated rows | per-day loop |
| 4 | `snapshot-amendment.ts` | "consented in-place rewrite" | amendment plan | mutates SpaceSnapshot + write-only ledger | n/a |
| 5 | `reconstruction-core/runner` (A4) | "position quantity on date D" | InvestmentEvent anchors | DERIVED PositionObservation | anchored walk-back |
| 6 | `investments-time-machine` (A10, via composed loader) | "portfolio on date D" | observations + prices at read | nothing | strict as-of, staleness surfaced, `detailEligible` |
| 7 | `wealth-time-machine.ts` | "net worth on date D" | snapshot series | nothing | nearest-≤, no staleness ceiling |
| 8 | `liquidity/historical-splice.ts` (+ `getAccountsAsOf`) | "liquidity on date D" | snapshots + as-of accounts | nothing | splice of live + reconstructed |

**Is it a coherent stack?** Partially. The good news is real: A8's `getInvestmentValueAsOf` is a genuinely shared valuation core (A9, A10, and the lens layer all call it), `getAccountsAsOf` centralizes account-level as-of for debt/liquidity lenses, and the SD wave made the historical engines actually reachable from the UI. The incoherence is at the top: **three as-of semantics** (nearest-≤ / strict / latest-observation), **two population taxonomies** (detailEligible vs all; digital assets in vs out), and **a basis switch at the today boundary** — all still present, one now test-defended.

**Collapse candidates.** (a) `backfill.ts` and `regenerate-history.ts` overlap materially (both reconstruct estimated card history; the tripled `isReconstructableCard` is the smoking gun) — one windowed regenerator with a create-only mode should absorb the other. (b) `getSnapshotAsOf` is already dead; delete. (c) A single as-of resolution module (nearest-≤ with explicit staleness ceiling vs strict) consumed by wealth + debt + liquidity would remove the semantics fork. **Load-bearing distinctions to keep:** amendment (consent boundary), event-sourced reconstruction (different substrate), read-time A10 vs persisted snapshots (different freshness contracts). Do **not** collapse those. Precondition for any of this: run one account through all mechanisms and diff the numbers — that investigation has been recommended twice and never executed.

---

## 7. Financial computation efficiency

- **`regenerate-history.ts` is N×date by construction** (`:344` loop; `:382` per-day `await getInvestmentValueAsOf`). Each day is internally batched (~3 queries + FX context), so a 30-day window ≈ 100+ sequential queries per Space, run from sync jobs. O(D) awaits, serial. Fine at beta scale; the first structural casualty at real scale. Fix shape: hoist the observation/price window reads (A8 already reads windows) and fold per-day in memory.
- **`jobs/sync-banks.ts` loops every PlaidItem serially** in one invocation (`:82`), with per-item regen + event ingestion inline. No fan-out, no retry, capped by one serverless duration — the known queue absence, unchanged.
- **Perspectives batch route recomputes every lens per dashboard load**; the route's own header says results are per-viewer and uncacheable *as designed*. Combined with the host re-fetching it on every currency nonce, this is the most-frequently-recomputed financial path in the product. A per-(space,user,day) memo would be doctrine-compatible.
- **AI chat recomputes everything per message** (context assembly, read-time transfer resolution, assessment) with no conversation-scoped cache. Known, unchanged by SD.
- Client-side folds (CashFlowWorkspace re-folding on render) are memoized adequately; not a concern.
- No N×account or N×instrument query patterns found in the hot read paths — A8's batched-window design is doing its job.

---

## 8. Data-loading and network efficiency

| Issue | Status at HEAD | Impact |
|---|---|---|
| Personal server/client double-fetch | **Regressed to fetch-and-discard** (§3): 4 wasted server reads incl. full tx list + FX serialization per Personal load, then client refetches everything | **P0** — hottest page in the product |
| Member count | Host still fetches the **entire space object** (`SpaceDashboard.tsx:730-737`) to render `members.length`; MembersWorkspace and ManageSpaceModal fetch members again | P2 |
| Goals multi-owner | Three fetch owners persist: host effect (`:615-623`), GoalsCard inside SpaceSections (own list + trash + CRUD fetches), ManageSpaceModal GoalsTab | P1 |
| Snapshot/transactions sharing | **Improved**: host fetches once, passes into Wealth/Debt/CashFlow/Liquidity as props | closed by SD |
| Workspace engine fetches | Debt/Liquidity/Investments self-fetch their space-data routes, gated on `active` — correct lazy shape | good |
| Invalidation bus | Still window `CustomEvent`s + two nonces (`currencyNonce`, `refreshNonce`) + a 12s `setInterval` during backfill; no query cache/SWR anywhere | P1 — the root cause of the nonce choreography |
| Platform widgets | Self-fetching by design (widget-kit) — consistent within the platform plane | acceptable |

The durable fix is one client data layer (even a minimal SWR-style cache keyed by route) replacing the nonce/event choreography; every individual bug above is a symptom of its absence.

---

## 9. Database/schema efficiency

- 50 models, 76 migrations in 5 weeks — migration discipline (additive, rename-via-`@@map`, documented) is genuinely good.
- **59 `Float` / 0 `Decimal`** re-confirmed. See §10.
- Write-only tables: `SnapshotAmendment`/`SnapshotAmendmentDay` (§3). `ApiUsageCounter`, `JobRun`, `MerchantMergeDecision` have balanced read/write paths (ops widgets read them).
- Read-mostly spine tables healthy: `PriceObservation` 7r/1w, `PositionReconstruction` 5r/1w, `InvestmentEvent` 10r/11w.
- Transitional residue: nullable `financialAccountId` on `Transaction`/`Holding`; dormant `SHARED` value in `VisibilityLevel`; `AccountOwnerType` legacy enum retained for OID stability (documented — fine); `Holding` model itself is the largest open seam (§3).
- Stale schema comment re-confirmed by prior audit ("nothing writes or reads them yet" on FlowType columns) — the class of defect persists; a schema-comment sweep belongs in the cleanup initiative.
- No missing-index red flags surfaced in the hot paths reviewed (space-scoped reads go through link tables with compound uniques); a query-plan pass was out of scope.

---

## 10. Numeric architecture (DEC-0 cross-check)

Unchanged and still the single most expensive deferred item: `Transaction.amount Float`, `FxRate.rate Float` ("Float confirmed — plan D3"), every snapshot total Float, no money library in `package.json`. The SD wave did not add a new hazard *class*, but it did add new Float multiplication surfaces (per-date display-currency conversion inside Wealth/Liquidity/Debt workspaces), which widens the error-compounding funnel DEC-0 describes. The per-domain epsilon fragmentation (0.005 / 1e-6 / 1e-9 / 0.5) was not re-censused this pass; no evidence it improved. Every month of accumulated snapshot/amendment history makes the migration strictly harder. This audit's only numeric recommendation: write the executable Decimal migration plan *now*, even if execution stays scheduled.

---

## 11. Workspace architecture (post-SD grade)

What the doctrine promised vs what landed:

| Boundary | Grade | Evidence |
|---|---|---|
| URL ownership (SD-0A) | **A** | One serializer + one popstate path (`useSpaceUrl`); host has a single `replaceState`-class call site; tab/perspective/metric/time all commit through it. The pre-SD four-writer problem is genuinely closed. |
| Time ownership (SD-0B) | **A−** | One reducer; Cash Flow's explicit-period drill is a mirror, not a second authority (state kept only to avoid ref-read-in-render). Honest design, well-commented. |
| SpaceShell (SD-1/2E) | **A−** | 146-line frame, slot-based, shared by customer and platform surfaces. Exactly right size. |
| Workspace data ownership (SD-3…6) | **B+** | Five financial workspaces own their engines; contracts activated (Investments composed loader is the production path — this morning's "zero consumers" is closed). Host still owns 8 shared fetches, which is defensible (shared inputs) but keeps it at 12 fetch sites. |
| Composition | **C** | The ladder survived: five hardcoded ternary branches on `activePerspectiveId` (`SpaceDashboard.tsx:1224-1358`). `WORKSPACE_REGISTRY` owns identity/routing/dataNeeds but stores **no component references** — adding a workspace still edits the host. The registry is a phonebook, not a dispatcher. |
| Envelope flow | **C+** | Five `useState` + `onEnvelopeChange` bridges + a six-way ternary (`:1187-1201`). Should be one `Record<workspaceId, PerspectiveEnvelope>` and one setter. Pass-through state at its most ceremonial. |
| Standard workspaces (SD-7) | **B** | Members (24 LOC), Accounts (44), Activity (45), Transactions (55) are near-pure pass-throughs. As registry slots they are honest; as files they are ceremony. Acceptable cost (~170 LOC total) for slot uniformity — but the ratchet test locking them is more code than they are. |
| Host residue | **C+** | Emergency-fund math in-host (`:967-976`), debt-preview filtering in-host, member-count fetch, hero assembly — "host never computes" is still violated in four small places. |

**Did decomposition make things simpler?** Yes on net: −2,244 lines from the host, one URL/time authority, real contracts. **Did it create pass-through layers?** A few (envelope relay, thin standard workspaces) — tolerable. **Did it create new monoliths?** One: `SpaceSections.tsx`. The wave moved the widget zoo; the next wave has to actually split it (per-section files + a generated registry index would do).

---

## 12. Section/widget architecture

Registry census at HEAD: `SectionRegistry` (63 renderers, in-file), `WIDGET_REGISTRY` (53 metadata entries, 1,193 LOC), `PLATFORM_WIDGET_REGISTRY` + `PLATFORM_SECTION_REGISTRY` (platform-local), `WORKSPACE_REGISTRY` (identity), plus `space-templates/registry` (now properly derived from `space-presets` — the byte-duplicate era is over, only the stale header remains).

- **Duplicate registries: yes, still.** Metadata (`WIDGET_REGISTRY`) and renderers (`SectionRegistry`) describe overlapping key spaces and are consistency-checked by tests instead of types. The only live metadata consumer is `getWidgetMeta` for virtual-section labels. Merge verdict from the last review stands, now with harder evidence: the metadata registry's query API and `dataTier` axis are dead (§3). Either the registry becomes the single `{meta, render}` table both surfaces read, or it shrinks to the label map it actually is (~100 lines).
- Section keys remain meaningful (DB-backed rows, gated by `hasRenderer`); virtual sections are a clean reuse of the compositor.
- `SectionCard`/`SortableSectionCard`/`SpaceSectionStack` layering is fine; the problem is their 1,584-line host file, not the abstraction.

---

## 13. Platform Spaces

The promised `Platform Space → SpaceShell → Workspace(s)` chain is **real at the frame level** (SD-2E: `PlatformSpaceDashboard` composes `SpaceShell`; the page deliberately imports zero customer data/authz machinery, tripwired by `platform-surface.test.ts`). Below the frame it remains parallel by design: grant-derived gating (clean, fresh-checked on mutations), self-fetching widgets via `widget-kit.tsx`, and two platform-local registries. Verdict: the authz separation is justified duplication; the *registry* duplication is not — a platform widget entry and a customer widget entry are the same shape and could share the registry mechanism with different data planes. `PlatformSpaceDashboard` remnants feared by the brief did not materialize (199 LOC, thin). Fourteen ops widgets for an audience of one remains a proportion question, not an architecture one.

---

## 14. Provider architecture

- **The adapter seam is fictional**: `plaidAdapter` and the provider catalog's query functions have zero consumers (§3). Actual provider logic lives in `lib/plaid/*` and `lib/crypto/btc-sync.ts` directly. Adding provider #2 today would copy the Plaid module shape, not implement an interface — the seam should either be deleted or made real by routing one call through it.
- `mapPlaidCategory` extraction into `lib/transactions/plaid-category.ts` is a real improvement (the semantic table is no longer hidden in the parser), but the two-stage classification pipeline persists.
- Crypto remains the riskiest provider surface: dual-write with a three-way read split (spine observations / legacy `Holding` via `getHoldings` / balance-based Wealth), with a written retirement gate that is not close to satisfied.
- What would make provider #2 unexpectedly hard: the sync loop's serial in-process shape (no queue), the `PlaidItem`-shaped assumptions in refresh/lock/consent columns, and FX/price backfill orchestration living inside provider jobs rather than behind the (currently decorative) seam.

---

## 15. Investments-specific residuals

| Item | Status | Owner |
|---|---|---|
| Canonical current positions in UI | **Closed by SD-4** — `useInvestmentsSpaceData` → composed loader → `getCurrentPositions` | — |
| Internal brokerage transfer semantics | Open — `brokerage-cash.ts` surfaces "non-trivial unresolved residuals" as diagnostics; no pairing model | semantic layer (transfer evidence v2) |
| Crypto currency allocation precision | Open (STATUS MC1 residual: mixed-currency allocation precision) | money/FX |
| Historical valuation chart | Live (portfolio-series over composed loader) | — |
| Current/historical contract split | Closed at the contract level; taxonomy split (digital assets) remains test-pinned (§5) | needs a ruling, not code |
| Cost basis / FX P&L | Absent by design, gated on a lot model | future initiative |
| Wallet refresh | Dual-write bridge (§14) | crypto retirement census |

---

## 16. Testing architecture

- 268 test files / 37,824 LOC; distribution: lib 229, components 27, app 11, scripts 1.
- **99 files (37%) are source-scan tests** (`readFileSync` over source + regex/string assertions). Some encode real invariants cheaply (seam tripwires, purity checks); many pin implementation details and comments — the SD-7 ratchet asserts which file contains which hook call. These tests make refactoring *of the decomposition itself* expensive: the next reorganization pays a tax to every ratchet that pinned this one.
- **Runner**: no framework; `scripts/run-tests.ts` spawns one `tsx` child process per file — 268 sequential process boots + TS transforms per run. No parallelism, no watch, no coverage. The suite's wall-clock cost is dominated by process spawn, not assertions.
- **Golden tests defend dead code**: the time-machine route's byte-identity contract keeps an unreachable endpoint green (§3) — the exact failure mode of implementation-pinning tests.
- Strengths worth keeping verbatim: the doctrine oracle (table-driven financial invariants), fixture tests over the pure cores (folds, valuation, reconstruction, time-range round-trips), population/parity tests that catch the stated duplications.
- Duplicate-protection check: the coarse partition is protected three times (oracle + two population tests) — acceptable given it is stated three times in code; fix the code, then the tests collapse naturally.
- Grade: **C+** — high-value pure-core coverage inside an inefficient harness, with a source-scan share that should be capped, not grown.

---

## 17. Documentation architecture

87,741 markdown LOC / 436 files. Classified sample: canonical doctrine (~10 files: FI0, Semantic Authorities, Space Contract Doctrine, Phase-2 set) — keep; active initiative docs (`docs/initiatives/*`, 30+ tracks) — keep the open ones; **historical reports and completion certificates** (the bulk of the 410 `docs/` files plus 12+ root-level `FOURTH_MERIDIAN_*_2026-07-*.md` completions/audits) — archive; stale planning (README's local-first Docker story, ROADMAP 337 bytes vs ROADMAP_ARCHITECTURAL_PRIORITIZATION) — supersede or delete.

Specific findings: STATUS.md is 212KB and **pre-dates the same-day SD wave by 16 commits** — the truth file's error rate is now structural, since it cannot keep pace with commit velocity by hand. Root-level report files belong under `docs/completions`/`docs/audits` (the directories exist). Recommendation: freeze the format (STATUS + one-pager per open initiative), move all dated reports to `docs/archive/2026-07/`, and regenerate the STATUS initiative table from the ledger rather than editing 212KB by hand. No deletion — the corpus's candor is an asset; its *location and weight* are the problem.

---

## 18. Build/runtime efficiency

- **198 of 240 `.tsx` files are `"use client"`** (82%). The shell pages are thin servers, but nearly the entire component tree ships to the browser.
- **All twelve workspace/modal components are statically imported into `SpaceDashboard.tsx`** — Wealth, CashFlow, Liquidity, Investments, Debt, Members, Transactions, Accounts, Activity, Overview, AddGoalModal, RoutedWorkspaceModal all land in one client chunk with recharts behind them. `next/dynamic` on the five financial workspaces + the two modals is the single cheapest bundle win available.
- Heavy deps are restrained (recharts is the only large visualization lib; no lodash/moment/d3). The vendored liquid-glass module exports unused components (§3).
- `ManageSpaceModal` (1,742 lines) is likewise statically imported and loads with every Space view for managers.

---

## 19. Security/authorization consistency

Sweep of all 129 API route files against the full guard family (`requireUser`/`requireFreshUser`/`requireSystemAdmin`/`requireFreshSystemAdmin`/`requireSpaceRole`/`requireSpaceAction`/`requireFreshPlatformAccess`/`requireMerchantOpsMember`/cron secret): **every route is guarded except the deliberately public set** (auth flows, health, access-request, email confirm — all of which are public by design). Platform mutations use the fresh live-revocation variant; merchant-ops has its own membership guard; jobs check the cron bearer. This is the most consistent cross-cutting layer in the repo: **B+**. (Known posture items — CSP report-only, JWT revocation gap, single `ENCRYPTION_KEY` — are carried from the security audits and were not re-verified here.)

---

## 20. Complexity grading

| Area | Grade | Evidence / strongest strength / biggest weakness / highest-leverage move |
|---|---|---|
| Architecture (overall) | **B−** | SD wave landed a real shell/workspace model. Strength: authority discipline (URL, time, money, flow). Weakness: composition ladder + surviving monoliths. Move: registry-driven composition (id → component) + split SpaceSections. |
| Domain boundaries | **B** | lib/ domain folders are coherent; strength: contract loaders per domain. Weakness: `ManageSpaceModal` cuts across every domain. Move: modal decomposition reusing workspace pieces. |
| Financial semantics | **B+** | Singular write authorities, honest UNKNOWN, activated compare/insights. Weakness: tripled predicate copy, stringly reads, pinned taxonomy split. Move: one shared `isReconstructableCard` + a `Flow` union type on reads. |
| Historical systems | **C+** | Shared A8 core is real; strength: event-sourced reconstruction. Weakness: 3 as-of semantics, backfill/A9 overlap, divergence-by-design. Move: single as-of module + the never-run cross-mechanism diff. |
| Data loading | **C−** | Strength: workspace-gated lazy engine fetches. Weakness: Personal fetch-and-discard, nonce/event bus, triple goals owners. Move: delete the dead server fetches today; adopt one client cache this quarter. |
| Runtime efficiency | **C+** | Nothing pathological at beta scale; N×date regen and per-load lens recompute are the known ceilings. Move: memo the perspectives batch route. |
| Database design | **B** | Migration discipline excellent; strength: provenance columns everywhere. Weakness: Float money, Holding seam, write-only amendment ledger. Move: Decimal migration plan on paper now. |
| Provider extensibility | **C** | Strength: canonical spine (observations/events). Weakness: the adapter seam is decorative and sync is serial in-process. Move: delete or realize the seam before provider #2. |
| Frontend composition | **B−** | Strength: SpaceShell slots + workspace ownership. Weakness: SpaceSections monolith, eager bundle, 82% client components. Move: dynamic imports + per-section files. |
| Testing | **C+** | Strength: oracle + fixture cores. Weakness: 37% source-scans, per-file process spawn, golden tests on dead routes. Move: adopt vitest (or similar) runner; cap source-scan share. |
| Observability | **D+** | JobRun/SyncIssue/ops widgets are inputs, not observability; no error reporting (self-declared in `instrumentation.ts`). Move: Sentry + one uptime check — a day of work. |
| Security | **B** | Guard consistency verified across all 129 routes. Weakness: carried posture items (revocation, CSP). Move: token blocklist. |
| Maintainability | **C+** | Strength: written context is extraordinary. Weakness: truth-file drift is now structural; prose-enforced invariants; solo bus factor. Move: shrink the doc surface to what one person can keep true. |
| Developer ergonomics | **C** | Strength: `npm test` runs everything with zero services. Weakness: slow runner, no watch mode, ratchets that punish refactors. Move: same as Testing. |

---

## 21. Invalidation ledger

| P | Candidate | Location | Current purpose | Actual consumers | Why questionable | Removal risk | Confidence | Recommendation |
|---|---|---|---|---|---|---|---|---|
| **P0** | Personal server fetches (3 reads + FX ctx) | `app/(shell)/dashboard/page.tsx:87-108` | none — output discarded | none (`PersonalDashboard` uses `ficoScore` only) | 4 wasted DB reads per load of the hottest page | None (props documented unused) | High | **DELETE** (keep `getFicoData`) |
| **P0** | `useInvestmentsTimeMachine` + `/investments/time-machine` route | components/…/investments, app/api/… | superseded A10 binding | none (hook orphaned; route fetched only by hook) | dead pair kept green by golden test | Low — verify no external caller logs first | High | **DELETE** (hook now; route after log check) |
| **P0** | AiAdvice UI surface (advice page, AdviceBanner, notification link) | app/(shell)/dashboard/advice, components/dashboard | displays a table with zero write paths | users see "Runs 2× daily" | false product claim; dead feature shipping | None user-visible (page shows empty state today) | High | **DELETE or gate** until a writer exists |
| **P0** | Widget-registry query API + `dataTier` | `lib/widget-registry.ts` | none | none (only `getWidgetMeta` live) | ~1,000 of 1,193 lines are inert metadata | None | High | **SIMPLIFY** to the label map, or **MERGE** into SectionRegistry |
| **P1** | `/dashboard/credit` + `DebtClient` (1,240) | app, components/dashboard | legacy personal debt page | FicoCard links only | duplicate debt authority vs DebtWorkspace | Medium — feature diff needed (FICO history UX) | Med-High | **DEPRECATE** → redirect to Debt perspective |
| **P1** | `ManageSpaceModal` inline CRUD (Goals/Members tabs) | components/dashboard/ManageSpaceModal.tsx | duplicate goals/members management | Manage button | 3× goals CRUD, 2× members UI | Medium | High | **REWRITE** tabs to reuse workspace components |
| **P1** | `isReconstructableCard` ×3 | backfill / regenerate-history / accounts-asof.core | same predicate, three copies | each host file | parallel-edit hazard on a financial predicate | Low | High | **MERGE** into one shared module |
| **P1** | `backfill.ts` vs `regenerate-history.ts` | lib/snapshots | overlapping estimated-history reconstruction | jobs, connect flow | two walk-backs, one purpose | Medium — semantics differ (create-only vs overwrite) | Medium | **MERGE** behind one windowed regenerator |
| **P1** | Envelope relay switchboard | SpaceDashboard.tsx | 5 states + 6-way ternary | shell chip | pass-through ceremony | None | High | **SIMPLIFY** to one keyed record |
| **P1** | Provider adapter seam (`plaidAdapter`, catalog fns) | lib/providers | speculative | none | decorative abstraction contradicting FI0 §12 | None | High | **DELETE** (recreate when provider #2 is real) |
| **P2** | Dead lib exports batch (§3 list: snapshots/transactions helpers, api.ts helpers, ensureHomeLink, orphan UI exports) | various | none | none | reader-misleading surface | None | High (each verified) | **DELETE** |
| **P2** | `SpaceSections.tsx` as single file | components/space/sections | section compositor + 63 renderers + GoalsCard | all section surfaces | new largest UI file; created by SD-7 | Low (mechanical split) | High | **REWRITE** (split per-section; extract GoalsCard) |
| **P2** | Source-scan ratchet share (99 files) | lib/, components/ | pin decomposition shape | CI | pins comments/implementation; taxes next refactor | Medium — some encode real seams | Medium | **SIMPLIFY** — keep seam tripwires, drop comment pins |
| **P2** | Stale prose (space-templates header, page.tsx URL-sync comment, STATUS pre-SD, schema comments) | various | — | readers | doctrine drift, again | None | High | **SIMPLIFY** (sweep in cleanup PR) |
| **P2** | Static workspace imports | SpaceDashboard.tsx | eager bundle | — | one chunk carries 12 workspaces + recharts | None | High | **SIMPLIFY** via `next/dynamic` |
| **P3** | `SnapshotAmendment` write-only ledger | prisma, lib/snapshots | consent audit trail | none (product) | written, never read | High if deleted (consent evidence) | High | **KEEP**, document as audit-only; or build the read |
| **P3** | Legacy `Holding` bridge + 3-way crypto reads | lib/crypto, lib/data/accounts | compatibility | getHoldings, AI, export, Wealth | retirement gate unmet | High — needs census | High | **INVESTIGATE FURTHER** (run the Part-9 census) |
| **P3** | Standard workspace pass-throughs (24-55 LOC ×4) | components/space/workspaces | registry slots | host ladder | ceremonial but uniform | — | High | **KEEP** (cheap uniformity) |
| **P3** | Platform-local registries ×2 | PlatformSpaceDashboard | platform widget dispatch | platform pages | 4th/5th registries | Low | Medium | **MERGE** mechanism (not data plane) later |
| **P3** | `_to_delete/` 414MB tarballs | repo root (untracked) | none | none | workspace hazard | None | High | **DELETE** outside git |

Estimated safely-removable code from P0–P2 DELETE/SIMPLIFY rows: **~6,000–9,000 LOC** plus ~1,000 lines of registry metadata, before any historical-system consolidation.

---

## 22. If we rebuilt Fourth Meridian today

**Keep exactly:** the money/FX layer (convert-then-sum, taint, append-only rate archive); the FlowType write/read split and fold discipline; the investments event log → reconstruction → observation spine with the shared A8 valuation core; provenance/versioning discipline on every backfill; the SpaceShell + URL/time authority trio the SD wave just proved out; the authz guard family; the doctrine oracle and the pure-core fixture tests.

**Design differently:** one history mechanism per *substrate* (one snapshot regenerator with windowed/create-only modes; one read-time valuation; one as-of module) instead of seven mechanisms per *initiative*; Decimal from day one; a real client data cache instead of nonce-and-event choreography; a registry that maps id → component so composition is data; a test framework from the ecosystem; sections as files, not entries in a 1,584-line switch.

**Exists only because of migration history:** the credit page, ManageSpaceModal's inline sub-apps, the Holding bridge, nullable `financialAccountId`s, the backfill/A9 pair, the dead time-machine binding, the two-stage category pipeline, `URL_TAB_ALIAS`'s legacy vocabulary, and most root-level report files.

**Abstractions that proved valuable vs not:** `*SpaceData` contracts, `PerspectiveEnvelope`, `dataNeeds`, and the section compositor all earned their keep the moment SD activated them — the lesson is that the contracts were right and the *pre-building* was merely early. The counter-examples — `dataTier`, the provider adapter, the widget query API, transfer authority tiers — were built the same way and never got a consumer; the difference between the two groups was a committed activation plan, not design quality. FI0 §12's own rule (no machinery ahead of its second consumer) remains the best predictor in the repo of what turned into dead weight.

---

## 23. Final executive assessment

1. **Too large for its product surface?** Yes, moderately — ~135k source LOC for a single-aggregator, pre-user personal-finance product carries an estimated 15–20% of structure with no runtime consumer or duplicated authority. The core (~70%) is proportionate to the ambition.
2. **Where did the growth come from?** Measured ~110k → ~172.6k ts+tsx (with tests) in 9 days: A-series historical systems, SD decomposition + contracts, platform ops, 37.8k test LOC, AI intelligence. Real capability and test scaffolding dominate; duplication and dead code are a minority but a visible one (§21).
3. **How much is justified?** Roughly: capability + tests + contracts ≈ justified; the ~6–9k LOC ledger above plus the doc corpus's report weight are not.
4. **Removable/consolidatable?** ~6–9k LOC immediately (P0–P2); another ~3–5k contingent on the history consolidation and Holding retirement investigations.
5. **Semantics efficient?** Partially — singular authorities hold and folds are disciplined, but three predicate copies, triple-stated partitions, and stringly reads mean the same truth is maintained in parallel.
6. **Historical systems efficient?** No — activated, shared-core at the bottom, but seven mechanisms, three as-of semantics, and test-pinned divergence at the top.
7. **Did Spaces decomposition materially improve maintainability?** Yes — this is the audit's clearest positive finding. Host halved, authorities unified, contracts activated. It also relocated one monolith (SpaceSections) and skipped another (ManageSpaceModal).
8. **Remaining monoliths?** Yes: chat route, annotations, ManageSpaceModal, SpaceSections, SpacesClient (§4).
9. **Over-engineered anywhere?** Yes: speculative seams with zero consumers (provider adapter, widget query API/dataTier), a 37% source-scan test share, ratchet tests larger than the code they pin, and a documentation process whose truth file can no longer track a single day's commits.
10. **Under-engineered anywhere?** Yes: Float money, no queue, no error reporting, no client data cache, no API-boundary validation layer — the same list as every prior audit, unchanged, which is itself the finding.

---

## 24. Ranked cleanup roadmap

1. **CLEAN-0 (hours):** Delete the P0 dead pairs — Personal fetch-and-discard, time-machine hook/route, AiAdvice surface (or gate it), widget-registry dead API/metadata, dead lib exports, `_to_delete/` tarballs. Sweep the four stale prose sites. Zero behavior change; every deletion has evidence in §3.
2. **CLEAN-1 (days):** Envelope record, shared `isReconstructableCard`, `next/dynamic` on workspaces/modals, memo the perspectives batch route, member-count from an existing payload.
3. **CLEAN-2 (1–2 weeks):** Split `SpaceSections.tsx`; rewrite ManageSpaceModal tabs over workspace components; deprecate `/dashboard/credit` behind a redirect; adopt a real test runner and cap source-scan share.
4. **INVEST-1 (investigation before code):** The cross-mechanism history diff (one account, all mechanisms, same dates) → then merge backfill/A9 and unify as-of semantics. The Part-9 crypto census → then retire `Holding`.
5. **Standing constraints:** Decimal migration plan written now; no new abstraction without a named second consumer; STATUS regenerated, not hand-edited.

---

## 25. Verdicts

```text
Codebase size justified?                              PARTIAL
Meaningful dead code exists?                          YES
Meaningful architectural duplication exists?          YES
Remaining monoliths exist?                            YES
Semantic layer efficient?                             PARTIAL
Historical layer coherent?                            PARTIAL
Workspace architecture successful?                    YES (with C-grade composition residue — §11)
Platform architecture unified?                        PARTIAL (frame yes, registries no)
Testing architecture efficient?                       NO
Major cleanup initiative justified?                   YES
Safe to begin cleanup without another investigation?  YES for P0–P2 (evidence in §21); NO for history
                                                      consolidation and Holding retirement (INVEST-1 first)
```

*Every deletion recommendation above cites its reachability evidence; nothing was removed, committed, or pushed as part of this audit.*
