# Fourth Meridian — Closure Strategy Investigation: v2.5 / v2.5.5 / OPS-1 / AI-5

| | |
|---|---|
| Date | 2026-07-14 |
| Verified against | Working tree at **`e74046e`** (`feature/v2.5-spaces-completion`), including uncommitted changes (KD-20 defense-in-depth, Investments allocation work-in-progress) |
| STATUS.md stamp at time of investigation | `e948ee3` (2026-07-13) — **72 commits stale** at HEAD; ~10 commits unpushed to origin |
| Method | STATUS.md read first, then every claim re-verified against source, schema, migrations, tests, routes, and git history. Seven parallel deep-scans: legacy `Account`, shell decomposition, Atlas adoption + hygiene, aggregation doctrine, metadata/tooling, OPS-1/beta readiness, AI architecture |
| Nature | Investigation and planning only. No source files were modified. |

**Labels used throughout:** VERIFIED · PARTIALLY VERIFIED · STALE STATUS · IMPLEMENTED BUT UNDOCUMENTED · DOCUMENTED BUT NOT IMPLEMENTED · PROPOSAL · NEEDS RUNTIME/DB VERIFICATION.

---

## 1. Executive verdict

**The project is materially further along than STATUS.md says, and the fastest path to beta and AI-5 is mostly *verification, ruling, and recording* — not construction.** The single most important finding of this investigation is that the 2026-07-13 drift-correction pass was immediately followed by a second, larger drift: a 72-commit "Growth & Security Platform" wave (Waves 1–3, plan at `docs/investigations/FOURTH_MERIDIAN_GROWTH_SECURITY_PLATFORM_INVESTIGATION_2026-07-13.md`) that shipped **most of OPS-1 S9 and S10** — the exact two items STATUS.md names as the remaining OPS-1 work — plus a public landing page, Turnstile CAPTCHA, an auth-anomaly detector, PO1.3/PO1.4, a Plaid webhook receiver, sync-lock hardening, the SnapshotAmendment system, an API-usage/cost counter, and an Atlas redesign of the Transactions perspective.

Headline verdicts per body of work:

1. **v2.5 (Part A):** Two genuine work items remain — legacy-`Account` runtime read retirement (larger than STATUS's three-site list: 4 direct accessors + 5 `Space.accounts` relation-count sites, one of them a *user-facing undercount bug*, + ~11 dual-path OR arms) and host decomposition of the 3,731-line `SpaceDashboard.tsx` (the satellites are already decomposed; STATUS's "not yet started" is half-stale). Atlas adoption is substantially **done** for product surfaces — the palette-ratchet baseline is empty — and most hygiene debt already quietly closed. v2.5 can close within roughly 4–6 focused slices.
2. **v2.5.5 (Part B):** The core exit criterion — "one canonical aggregation doctrine" — is **substantially implemented but unrecorded**: since commit `06137f8` (CF-3), Summary, History, and Calendar all consume one `DayFacts` projection with test-enforced parity. The `Customg6w5n` liability/payment-app leak is already fixed and test-pinned in the liquidity axis. What genuinely remains: one classifier rule (liability payment-app outflow → SPENDING, classifier v3), retirement of duplicated fold/clamp/net definitions, a compact doctrine test suite closing four named gaps, currency threading in four assembler rollups, a minimal correction UI, and backfill apply-state verification. This is 5–6 slices, not a milestone-sized initiative.
3. **OPS-1 / beta (Part C):** S9 and S10 are ~85–90% shipped. Remaining before one external beta user: **consent capture at registration** (no `acceptedTermsAt`, no checkbox — the S9 gate is unmet), **naming OpenAI + a retention posture** in `/legal/ai` (STATUS blocker 7, narrowed), **Sentry** (explicitly deferred in `instrumentation.ts`), **external uptime monitoring**, **a backup restore drill**, and **production configuration flips** (`registration_mode=invite_only` — the DB default is `open` — Turnstile keys, production Plaid, Resend domain). All are small; none is architecture.
4. **AI-5 (Part D):** The deterministic substrate the charter assumes (confidence lattice, completeness flags, KD-7/KD-10/KD-17/TI2-W2 honesty plumbing, shadow planner, single provider seam) is real and stronger than the proposal's date implies. The conversational substrate (persisted state, conversation identity, context-change disclosure, compression, master-mode honesty) is **entirely absent**, exactly as chartered. Two blocking discoveries: the "eight observed conversation-quality failures" corpus **is not committed anywhere** and must be reconstructed before the exit criterion is testable; and the client/server contract has **no conversation id**, which is a prerequisite for any persistence slice. A meaningful first tranche of AI-5 (KD-16 semantics, window provenance, shadow context-change detection, state-as-pure-function, confidence contracts, KD-8 disclosure) is **zero-schema and can safely begin before v2.5.5 fully closes**, provided its tests assert window bounds and provenance labels rather than dollar figures.

**Recommended strategy: Option 2 (safe parallelization), anchored by an immediate STATUS.md truth-up.** The current STATUS drift is not cosmetic — it names as "remaining" work that is already built (S9/S10, observability counters, max-50 copy, KD-13, FLOW_COST duplication, DataCard migration), which is precisely how redundant re-planning happens. Details and sequencing in §§7–10 and the final section.

---

## 2. Current-state matrix

| Body of work | STATUS.md says | Repository reality | Verdict |
|---|---|---|---|
| v2.5 exit: legacy `Account` out of read paths | 3 runtime read sites remain | 4 direct accessors (`app/admin/page.tsx:56` missing from list) + 5 `Space.accounts` `_count` sites (incl. user-facing `dashboard/spaces/page.tsx:48` undercount bug) + ~11 dual-path OR arms in 7 files; zero runtime writes anywhere | STALE STATUS (undercount); retirement DOCUMENTED BUT NOT IMPLEMENTED, correctly gated |
| v2.5 exit: monolith decomposition | "not yet started" | Satellites fully decomposed (5 perspective modules, shell kit, nav libs, accounts renderer, transactions kit, platform kit); only `SpaceDashboard.tsx` (3,731 LOC, 16 responsibilities, 55 `useState`) remains monolithic | PARTIALLY STALE STATUS |
| v2.5 exit: new surfaces in Atlas | "substantially met" | Confirmed and stronger: palette-ratchet baseline is **empty** (`lib/atlas/palette-ratchet.baseline.json` = `{}`); DataCard has 15 consumers; Daily Brief redesign landed. Gaps: platform widget-kit + marketing pages are token-clean but primitive-free; auth/admin islands outside ratchet scope | VERIFIED / partially IMPLEMENTED BUT UNDOCUMENTED |
| v2.4.5 carry-forward debt | counters unimplemented, max-50 copy unshipped, .env.example missing flags | LLM token + Plaid counters shipped (`ApiUsageCounter`, `lib/usage/record.ts`); max-50 copy fixed (`app/api/ai/chat/route.ts:1971–76`); `RATE_LIMIT_*` documented; still missing: `AI_OUTPUT_VALIDATION_MODE`, `TIINGO_API_KEY` + 3 flags; window/follow-up heuristic suites still absent; fallback-hit counter still absent | ~80% STALE STATUS |
| KD-13 hygiene | "Reopened — 19 ' 2' dirs" | Zero `" 2"` dirs on disk; root-cause `.gitignore` patterns landed (`e948ee3`); root docs reorganized into `docs/{audits,completions,implementation-plans,investigations}` | STALE STATUS — fixed |
| v2.5.5: canonical aggregation | remaining scope, unstarted | CF-3 `lib/transactions/cash-flow-projection.ts` is the canonical projection; Summary/History/Calendar parity test-enforced (`cash-flow-projection.test.ts`, `liquidity-buckets.test.ts`) | IMPLEMENTED BUT UNDOCUMENTED |
| v2.5.5: FLOW_COST duplication (FlowType residual #3) | open | Resolved by TI1 `COST_FLOWS` (`lib/transactions/flow-predicates.ts:48`); `BankingClient` deleted; zero live `FLOW_COST`/`EXPENSE_FLOWS` | STALE STATUS |
| v2.5.5: metadata depth | remaining scope | Substantially complete (currency, PFC trio, TI2 facts, merchant enrichment); §7A doctrine ratified the blob/location/PII items *out*; remainder = historical-thinness decision + TI3 dry-run + ≤3 optional fields | STALE STATUS (scope shrank) |
| OPS-1 S9 legal pages | "remain" | `/terms`, `/privacy`, `/legal/ai`, `/security`, `/about`, landing + footer links all live with real drafted-honest content; missing: consent capture, named provider/retention, effective-date precision, support contact | STALE STATUS — ~85% shipped |
| OPS-1 S10 beta gate | "remain" | Full `BetaAccessRequest` lifecycle: request → founder Approve/Deny widget → hashed, email-bound, 14-day, single-use invite → atomic redemption → born-verified; `registration_mode` DB toggle; Turnstile; audit events | STALE STATUS — ~90% shipped; **prod default is `open`** |
| §6 blockers | #6 thin tests, #7 LLM posture | Both still open but narrowed; real pre-beta list adds consent capture, Sentry, uptime monitor, backup drill, prod config flips | PARTIALLY STALE |
| AI-5 | Planned; charter approved | Deterministic substrate strong; conversation substrate absent; failure corpus uncommitted; no conversation id; KD-16 defects verified live (`classifier.ts:392–409`, silent 90-day default, undisclosed 800-day clamp) | VERIFIED |

---

## 3. Part A — v2.5 architecture closure

### A1. Legacy `Account` runtime retirement

**Schema state (VERIFIED).** `prisma/schema.prisma:812–850` defines legacy `Account` behind a banner ("kept temporarily during migration… removal gated on the Phase 0 prod counts"). Inbound web: `User.ownedAccounts` (:410), `Space.accounts` (:505), `PlaidItem.accounts` (:696), `Holding.accountId` (:1295–96, **onDelete: Cascade**, unique `[accountId, symbol]`), `Transaction.accountId` (:1818–19, **Cascade**), and `VisibilityLevel.SHARED` (:186, retained only for this model). The parallel canonical FKs (`Transaction.financialAccountId`, `Holding.financialAccountId`) are both **optional** — the schema contract is "exactly one of the two FKs per row," so neither can become required until legacy-anchored rows are re-anchored. **Cascade hazard:** dropping the table with legacy-anchored child rows present cascade-deletes user transactions/holdings — this is why Phase 5 is count-gated, and the gating is correct.

**Write path (VERIFIED): the legacy table is frozen.** Zero `create`/`update`/`upsert` of `Account` anywhere. Plaid sync writes `financialAccountId` at all three write sites (`lib/plaid/syncTransactions.ts:343,405,423–25,438`); imports, manual accounts, wallets, BTC sync, investments sync — all canonical. `prisma/seed.ts` creates only canonical models and retains a deliberate `prisma.account.deleteMany()` wipe (:274). Rows can only disappear (Space-delete cascade, dev seed wipe), never appear.

**Read inventory — STATUS's "exactly three" list is STALE.** Complete classified inventory:

*Direct accessors (4 production):*
- `app/api/accounts/[id]/transactions/route.ts:38` — legacy existence fallback after SAL lookup; the legacy hit bypasses KD-15 by own-Space doctrine. Its only UI consumer (AccountModal) was deleted; the route is now caller-less in-repo (IMPLEMENTED BUT UNDOCUMENTED) but externally reachable.
- `lib/imports/authorize.ts:74` — the one **authorization dependency**: distinguishes 400 ("does not support import") from 404 for legacy ids, then Slice-B ownership/role checks. Dropping the branch degrades an unreachable-in-practice error from 400→404.
- `app/api/admin/overview/route.ts:73` + `app/admin/page.tsx:56` — `db.account.count()` for admin stats. `app/admin/page.tsx` is **missing from STATUS's list** despite being in both v2.5-A investigation docs. `/api/admin/overview` has no in-repo caller (candidate dead route; NEEDS RUNTIME VERIFICATION for external tooling).

*Relation-count sites (5 production, missed by STATUS and both v2.5-A docs):* `app/(shell)/dashboard/spaces/page.tsx:48–50,114–16` (**user-facing**: every Space card's `accountCount`), `app/api/admin/overview/route.ts:66–67`, `app/admin/page.tsx:53`, `app/api/admin/spaces/route.ts:52–57`, `app/api/admin/users/route.ts:61`. Because all account creation is canonical-only, these count only *legacy* rows — i.e. on current data they systematically **undercount (likely show 0)** while the Space has linked FinancialAccounts. This is a live user-facing correctness bug, not just debt. Canonical replacement: ACTIVE `SpaceAccountLink` counts. IMPLEMENTED BUT UNDOCUMENTED defect.

*Dual-path OR arms (~11 sites, 7 files — compatibility reads that keep legacy-anchored rows visible):* `lib/data/transactions.ts:116,202,237,303–05,428`; `lib/transactions/detail-query.ts:44` (this one **is** the row-visibility predicate shared by detail + corrections); `app/api/transactions/[id]/correct/route.ts:66,74`; `lib/ai/assemblers/transactions.ts:358,1216,1246` (AI context); `lib/data/accounts.ts:251` (`getHoldings`); `app/api/accounts/[id]/transactions/route.ts:62`. Plus 4 column-normalization sites (`accountId ?? financialAccountId`) in `lib/transactions/serialize.ts:84,119`, `lib/data/accounts.ts:282`, `lib/ai/assemblers/transactions.ts:384`, `lib/data/transactions.ts:441`.

*Scripts (10, all standalone tsx):* `phase0-seam-gates.ts` (the count gates themselves), 7 backfills with dual-path arms, 2 diagnostics. *Migrations:* `20260611000001` backfilled `FinancialAccount` **from** `Account` reusing the same `id` (so backfilled ids overlap — contradicting the comment in `lib/imports/authorize.ts:17–18`), but **never re-anchored child FKs**. *Tests:* fixtures only; **no source-scan guard against legacy usage exists** — a gap, given the repo's KD-15-tripwire idiom.

**The real finish line — four separable milestones (PROPOSAL):**

- **M1 — "No production runtime reads" (the v2.5 exit criterion).** Two tranches: (a) *safe today, no DB gate*: swap the 2 admin counts and 5 relation-count sites to canonical counts (also fixes the undercount bug); (b) *gated on prod counts*: remove the C1/C2 fallbacks (Gate C = legacy Account rows) and the ~11 dual arms (Gates A/B = legacy-anchored Holding/Transaction rows), updating `lib/data/transactions.privacy.test.ts` (pins exactly 5 SAL queries) and `transaction-detail.privacy.test.ts` (pins the WHERE shape) in the same slices.
- **M2 — Data migration (only if Gates A/B/C ≠ 0):** re-anchor `accountId → financialAccountId` (a column copy where ids overlap) + verify script, per `docs/investigations/V25A_PHASE0_SEAM_RETIREMENT_READINESS.md` §5.
- **M3 — FK/column drop:** remove `Transaction.accountId`/`Holding.accountId` + 4 indexes + 1 unique + the 4 normalization shims; consider making `financialAccountId` required.
- **M4 — Model delete:** drop `model Account` + 3 back-relations + seed wipe + `VisibilityLevel.SHARED` (coupled here — Postgres enum-value removal needs a type-recreate migration; Gate E must be 0 on both SAL and Account), retire/trim `phase0-seam-gates.ts` and the dual-path script arms (or `tsc` breaks).

**Answers to the posed questions:**
- *Should v2.5 close after runtime read retirement even if the schema model remains?* **Yes (PROPOSAL).** The v2.5 exit criterion as written is "zero legacy-`Account` queries in AI/read paths" — that is M1. M2–M4 are a DB-milestone with irreversible-loss risk and their own approval gate, exactly as D3's ledger row already records ("legacy `Account` retirement is a separate future milestone").
- *Is full physical deletion appropriate now?* **No.** It is blocked on prod Gate counts that have never been recorded in the repo (the readiness doc's deferral condition is still open), and the Cascade hazard makes a premature drop a data-loss event. Run the gates first; the tool exists and is read-only.
- *Regression prevention:* add a `legacy-account-invariants` source-scan test in M1 tranche (a): whitelist the remaining accessors/arms and shrink the whitelist per slice — it would have caught the `dashboard/spaces` sites.
- *Proof needed before model deletion:* recorded prod runs of `scripts/phase0-seam-gates.ts` (Gates A, B, C, E = 0), plus a stated backup/retention window, plus one deploy cycle of M1 in production with the fallbacks removed (observability that no 404s appear on the trimmed paths).

**NEEDS RUNTIME/DB VERIFICATION:** Gate A/B/C/E counts; whether the `20260611000001` backfill ran before any legacy rows were created; dual-anchored row count; external callers of `/api/admin/overview`.

### A2. Dashboard and shell decomposition

**STATUS's "monolith decomposition not yet started" is half-stale.** The *satellites* are decomposed — and decomposed well: five perspective composition modules (`components/space/widgets/{wealth,cashflow,liquidity,investments,debt}/`), the shell kit (`components/space/shell/` — `PerspectiveShell` is an 86-line pure layout; `usePerspectiveShellState` is the single owner of `{preset, asOf, compareTo}` with URL sync), the nav libs (`lib/space-nav.ts`, `space-nav-icons.ts`, `perspective-icons.ts`, atlas `SegmentedControl`/`FloatingNavWrapper`/`useScrollShrink`), the `accounts_overview` self-fetching renderer, the Transactions kit (6 subcomponents extracted in `8340f35`), the platform `PLATFORM_WIDGET_REGISTRY` precedent, the trust-envelope registry (`lib/perspectives/envelope.ts:188–211` — "the single sourcing point — no host ternaries"), and the globally-mounted `TransactionDetailDrawer` (`DashboardChrome.tsx:160`, URL-param driven). All VERIFIED.

**What remains monolithic is exactly one file.** `components/dashboard/SpaceDashboard.tsx`: **3,731 LOC**, 55 `useState`/19 `useEffect`, 11 `activePerspectiveId ===` + 20 `activeTab ===` branches, 19 `fetch` calls (10 endpoints from the main host), 65 `@/` imports across 14 lib subdomains, and ~2,050 lines of module-level *siblings* (GoalsCard + TrashDrawer + AddGoalModal ≈ 1,150 lines; SectionRegistry ≈ 60 keys; 20-prop SectionCard; AccountsCard; ActivityCard; adapters). The exported host owns 16 enumerable responsibilities (nav state, deep links, perspective branch chain + 6 lazy-fetch gating consts, shell time wiring, per-perspective read models, 10-endpoint data fetching, 3 window-event refresh channels + 2 nonces, currency, modals/drawers, reorder, hero, section compositing, doorways, header/roles, category quirks). `SpaceTransactionsPanel.tsx` (967 LOC, 20 `useState`) is redesigned but state-unreduced.

**Test locks that constrain any refactor (VERIFIED):** at least 4 source-scan files regex-match `SpaceDashboard.tsx` directly — `lib/space-shell-seams.test.ts`, `components/space/shell/shell-nav.test.ts` (rail bare iff Perspectives), `CashFlowPerspective/LiquidityPerspective/DebtPerspective.test.ts` (branch-literal pins, specific-before-generic ordering, prop threading). Any relocation must re-point these in the same slice — they are the wiring contract.

**Prop-contract reality:** the six perspective components have six different prop shapes (result-driven vs raw-data vs current-state vs self-fetching); a naive shared-`P` registry doesn't exist for free. The codebase's own precedent (superset-props `SectionRenderProps`, `PLATFORM_WIDGET_REGISTRY`) makes a `PERSPECTIVE_RENDERERS: Record<string, (p: PerspectiveWorkspaceProps) => ReactElement>` feasible — the host already computes every input regardless of the active id — but the 6 lazy-fetch gates need a declarative `needs` field or stay host-side.

**Deletion candidates found:** dead Personal server fetches (`app/(shell)/dashboard/page.tsx:87–108` runs 4 fetches whose results `PersonalDashboard` never destructures — live per-request DB cost for nothing, VERIFIED); SETTINGS residue (mapped but renders nothing); deprecated registry aliases (`net_worth_section`, three tracker keys); DEBT_PAYOFF legacy key remaps (needs a one-time DB rename migration first); dormant composition switcher (intentional). The `renderHero`/`PersonalHero` seam is **already deleted** — STATUS §3 SP-2A-4 still describes it as live (STALE STATUS).

**Minimum decomposition for v2.5 (PROPOSAL) — ownership moves, not line-count vanity:**
1. **A2-S1 — Relocate the siblings** (Goals suite → `components/space/goals/`; SectionRegistry + SectionCard + SortableSectionCard + chart sections → `components/space/sections/`; AccountsCard/ActivityCard/OverviewSetupCard/ContextualCard out). Byte-identical render; import paths only; re-point the source-scan tests. 3,731 → ~1,700 lines. Include the dead-Personal-fetch deletion here (small, real perf win).
2. **A2-S2 — Extract `PerspectiveWorkspace`**: everything under `activeTab === "PERSPECTIVES"` (shell mount, envelope assembly, branch chain, 6 gating consts, wealth/investments read models, cashFlow bridge — L2496–2740 + L3323–3453) becomes one component owning the Perspectives tab. `selectedPerspectiveId` stays hoisted (Overview doorways set it). Update the 4 branch-pinning tests in the same slice.
3. **Exit criterion (objective, better than "smaller"):** *every rail tab and every perspective is rendered by a component that owns exactly one of {navigation, data acquisition, workspace composition, section chrome}, and no source-scan test regex-matches more than one responsibility per file.* Concretely: host ≤ ~1,200 lines owning nav + data + composition dispatch only; zero module-level sibling components in the host file.

**Beneficial-deferrable:** `PERSPECTIVE_RENDERERS` registry (inside the extracted workspace), `useSpaceDashboardData` hook (effect-ordering risk — preserve guard semantics exactly), `useSpaceTabState` nav module (unifies three hand-rolled URL-sync dances), `SpaceTransactionsPanel` `useReducer` consolidation, DEBT_PAYOFF key migration + branch deletion.

**Dangerous over-engineering (do not do in v2.5):** any widget/grid/schema engine (explicitly rejected in every redesign plan); shell time via React Context (breaks the tested props doctrine); `useSearchParams` (forbidden — Suspense; pinned absent by `space-shell-seams.test.ts:84–87`); unifying customer and platform registries (deliberate authz-axis separation, `lib/platform-surface.test.ts`); splitting SectionCard's four chromes; deleting `business_accounts` before a data decision.

### A3. Remaining Atlas design-system adoption

**System inventory (VERIFIED).** `components/atlas/` = 2,371 LOC + vendored liquid-glass: GlassPanel (5 depths, e1–e4, Fresnel `edge`, consumes `--glass-filter-*` tokens), OverlaySurface + Dialog/FormModal/ConfirmDialog, DataCard, SegmentedControl (icons, `labelVisibility`), FloatingNavWrapper, useScrollShrink, GlassButton, AtlasField, InlineFilter, `tones.ts`, useBodyScrollLock. Tokens in `app/globals.css`: `--dur-*`, per-depth `--glass-filter-*` (:174–78, neutralized under `prefers-reduced-transparency` :531–35), `.atlas-fresnel-edge`. **Missing primitives:** form inputs (doctrine explicitly defers), tables, empty states, loading skeletons, toasts, dropdown/menu/tooltip, chart wrappers.

**Enforcement (IMPLEMENTED BUT UNDOCUMENTED — stronger than STATUS says):** the palette ratchet's baseline is **empty** (`lib/atlas/palette-ratchet.baseline.json` = `{}`; live run: "0 tracked files") — the burn-down within scope (`components/{dashboard,space,atlas}`) is complete. Gap: the scan does not cover `components/{connections,brief,settings,security,admin,platform,marketing,charts,transactions,ui}` or `app/` — the raw-palette hotspots (admin ~250 hits, auth ~75, security ~65) sit outside the fence, and nothing prevents regressions in the new platform/marketing trees.

**UI-1 "Remaining" list — 2 of 4 items are STALE:** DataCard Step B → **15 consumers** exist; legacy `ui/Card.tsx` retired; the file header still claims "mounted nowhere" (fix the comment). Daily Brief redesign → landed (every brief card composes GlassPanel/AtlasLiquid; STATUS contradicts itself between the UI-1 row and §5). Genuinely open: **primitive material adoption** (GlassButton hardcodes `blur(20px) saturate(160%)` at :77–78; OverlaySurface scrim; ~10 product files hand-roll `backdrop-filter`) and **Material Engine Phase 1B `--atlas-light-angle`** (token exists nowhere; `globals.css:488` says "intentionally NOT introduced here" — DOCUMENTED BUT NOT IMPLEMENTED).

**Surface classification:** Fully Atlas-native: 4 perspective redesigns + Wealth, Transactions perspective + drawer, Connections. Mostly-Atlas: Space shell, Settings. Redesigned-but-primitive-inconsistent: **Platform Ops** (tokens yes, hand-rolled panel/chip/empty/loading, zero atlas imports). Token-aligned-but-primitive-free: **public marketing/legal/beta pages** (new 07-13/14 surfaces — technically against the exit criterion as literally worded). Deliberately legacy: `business_accounts` AccountsCard (locked by `AccountsPerspective.test.ts:129–31`), merchant-ops, admin. Untouched: auth pages.

**Bounded completion plan (PROPOSAL):**
- *Required to close v2.5:* a **ruling**, not a migration: explicitly exempt (a) admin + merchant-ops (internal, ride UI-1 later), (b) marketing tree (separate shell by design — but record it), (c) `business_accounts` (already ruled); then do one small slice: **ratchet-scope expansion** to `components/{platform,marketing,brief,connections,settings,security,transactions,ui}` + `app/(auth)` `app/(public)` (their counts become the new baseline — the ratchet only stops *growth*, so this is cheap) + fix the DataCard header comment + STATUS UI-1 row.
- *Product polish (defer to a UI-1.x slice):* GlassButton/scrim tokenization + the ~10 hand-rolled backdrops; platform widget-kit onto GlassPanel/DataCard.
- *Defer past v2.5.5:* Phase 1B light model; auth-page migration (touch it when C-S1 adds the consent checkbox — one combined pass); admin migration; missing primitives (build each when its first consumer arrives — the doctrine's own rule).
- *Prerequisites elsewhere:* nothing in OPS-1 S9/S10 or AI-5 presentation is blocked on Atlas work. Daily Brief further redesign belongs to v2.6b generation work, not v2.5.

### A4. Repository hygiene and carry-forward v2.4.5 debt

| Item | Reality | Classification |
|---|---|---|
| KD-13 " 2" dirs | Zero on disk; `.gitignore` root-cause patterns present (`* 2`, `* 2.*`) | Obsolete — fixed (`e948ee3`); update KD-13 row |
| Untracked root docs | Mass-moved into `docs/{audits(4),completions(3),implementation-plans(16),investigations(126)}` (`6ba75e5`,`83d59f7`); ~6 untracked items remain (`.claude/`, WIP investments files) | Repo hygiene — largely closed; restamp §2 |
| `.env.example` drift | `RATE_LIMIT_*` fixed; still missing: `AI_OUTPUT_VALIDATION_MODE` (read at `chat/route.ts:157`), `TIINGO_API_KEY` (referenced by comment at `.env.example:194,203` but never defined!), `SECURITY_PRICES_ENABLED`, `INVESTMENT_IMPORTS_ENABLED`, `FLOWTYPE_SHADOW`. Also a latent `.gitignore` ordering bug: trailing `.env*` re-ignores `.env.example` after the earlier negation | Documentation debt — one 20-minute slice |
| "Too many messages (max 50)" copy | Fixed — user-facing copy at `chat/route.ts:1971–76` | Obsolete — fixed |
| Observability counters | LLM tokens + Plaid calls: shipped (`ApiUsageCounter`, `lib/usage/record.ts:37–56`, writers `lib/ai/provider.ts:87–93` + `lib/plaid/client.ts:67`, PO1 widget). Sync stats: covered by PO1.2/PO1.4 reads. **Fallback-hit counter: still missing** | ~80% IMPLEMENTED BUT UNDOCUMENTED; fallback counter = later enhancement |
| v2.4.5 test debt | 221 test files (STATUS says 200); monthly-rollup math now covered (`transactions.golden.test.ts`, kd17). Still absent: dynamic-window resolution / follow-up carry-forward / drilldown heuristic suites — **these are exactly AI5-1's characterization suite; do not build twice** | Production-readiness debt, absorbed into AI5-1 |
| Worktree residue / artifacts | Clean — no worktrees, no stray artifacts | Obsolete |
| Stale flags | None found — every env flag has a live reader | Obsolete |

**Smallest safe closeout:** one hygiene slice (env-example keys + gitignore ordering + STATUS restamp). Everything else is either already fixed or explicitly re-homed (window suites → AI5-1; fallback counter → PO1.x).

---

## 4. Part B — v2.5.5 Financial Intelligence closure

### B1. Canonical aggregation doctrine

**FI0 (`docs/FI0_FINANCIAL_INTELLIGENCE_DOCTRINE.md`, ratified) is the governing frame:** one *definition site* per financial claim, forever; consumers own zero canonical claims; persistence is per-fact engineering; LLMs narrate, never compute. `flowType` is the kernel; the relationship resolver is read-time Intelligence by ratified posture.

**The canonical layer exists and is live (VERIFIED):**
- `lib/transactions/flow-predicates.ts` (TI1): `COST_FLOWS`, `SERIALIZED_SPENDING_FLOWS`, `isCostFlow/isIncome/isRefund/isTransfer/isDebtPayment/isInvestmentFlow`, `sumByFlowType` — pure, zero imports, consumed by every surface.
- `lib/transactions/flow-classifier.ts`: `classifyFlow` v2 (CF-4: liability + ACCOUNT_TRANSFER outflow → SPENDING — account tier outranks the provider transfer tag), honest UNKNOWN, `FLOW_CLASSIFIER_VERSION = 2`.
- `lib/transactions/liquidity.ts`: `classifyLiquidity` — the LIQUIDITY axis (CASH_IN/OUT/NEUTRAL/UNRESOLVED) from flowType × own tier × counterparty tier × `transferDisposition`; liability legs unconditionally NEUTRAL (:225–28).
- **`lib/transactions/cash-flow-projection.ts` (CF-3, commit `06137f8`) — THE canonical projection:** `DayFacts` (one fold reading both axes once), `aggregateDayFacts` (Summary), `projectDailyFacts` (Calendar), `bucketDayFacts` (History), `economicSpend` clamp, `CALENDAR_MEASURES` with `subsetOf` anti-double-count metadata and per-row `rowMatches` so drill-downs reconcile with cells.
- Transfer evidence (TE1): provider-neutral axes on the row; `deriveTransferDisposition` at read time (never persisted — schema comment :1930); rail ≠ purpose doctrine in-file.

**Summary/History/Calendar parity: YES — one shared projection, test-enforced (VERIFIED; IMPLEMENTED BUT UNDOCUMENTED as milestone progress).** Exact flow: `GET /api/spaces/[id]/transactions` → `getTransactions` (KD-15 FULL-only, `deletedAt: null`, pending included) → per-row read-time context (disposition + needsClassification) → one DTO array + serialized moneyCtx → `SpaceDashboard.tsx:2900` → `CashFlowPerspective` → each widget runs the same `filterByPeriod` then Summary=`aggregateDayFacts`, History=`bucketDayFacts`, Calendar=`projectDailyFacts`, all over `DayFacts`. Parity pinned by `cash-flow-projection.test.ts` (daily Σ == Summary; bucket Σ == Summary) and `liquidity-buckets.test.ts`. The legacy per-widget folds (`bucketCashFlow`, `dailyCashFlow`, `bucketLiquidity`, `dailyLiquidity`) have **zero live consumers** — deletable.

**Genuine remaining divergences (the real v2.5.5 work):**
1. **Three live "net" definitions:** UI economic net = `income − max(0, spend−refund)` (projection:178–84); AI `netCashFlow = income + refund − expense − debtPayment` (assembler:546); annotations monthly net = `income − expense − debtPayment` (:866–70). (a) vs (b)/(c) genuinely diverge whenever debt payments exist. Each is individually defensible; none is *named*. This is the KD-10 pattern one rename away from an incident.
2. **Spend-clamp restated 5×** (`cash-flow.ts:267,344,392`, projection:171, `SpaceTransactionsPanel.tsx:432–34`) — same semantics, held by convention only.
3. **cashIn/cashOut fold triplicated** (`deriveCashFlowAxes`, `foldLiquidity`, `foldDayFacts`) — one classifier, four sum sites, equality test-pinned but structural.
4. **Assembler currency divergence:** merchant rollup (:707), income sources (:797), recurring (:636), largest rows (:868,876) sum **native** amounts while neighboring totals convert via moneyCtx — magnitudes diverge on multi-currency Spaces. VERIFIED.
5. **The payment-app/liability economic hole** (below).
6. STALE STATUS: the FlowType residual "#3 FLOW_COST duplication" is resolved (TI1); `BankingClient` deleted.

**Payment-app / liability class (`Customg6w5n`):** the original leak — a −$69.84 payment-app row on a credit card counted as Cash Out — is **already fixed and test-pinned** (`liquidity.ts:196–228`; `investment-venue.test.ts:108–13`: "liability + PAYMENT_APP → NEUTRAL, never Cash In/Out"). Within Summary/History/Calendar the row cannot diverge (one classifier). The remaining *general* gap is one axis over: a card-funded payment-app **outflow** creates new debt exactly like a purchase — the codebase already ratified that argument as CF-4 for `ACCOUNT_TRANSFER` — but a card outflow whose PFC is `FROM_APPS` (or brand-allowlisted) still classifies TRANSFER, so the identical economic event is SPENDING or invisible depending on which Plaid detailed code arrived. Cross-surface today the row is: invisible in Cash Flow (NEUTRAL + no "Moved, not spent" bucket for PAYMENT_APP_MOVEMENT), a "Transfers" KPI in the tab, and `unknownPaymentAppTotal` in the AI needs-classification line.

**Where the fix belongs (PROPOSAL, grounded):** the **flow classifier** — extend CF-4: liability-tier outflow + payment-app signal (`FROM_APPS` detailed / brand allowlist) → `SPENDING`; bump `FLOW_CLASSIFIER_VERSION` to 3; selective backfill `WHERE classifierVersion < 3` (mechanism exists: `scripts/backfill-flowtype.ts`, dry-run default). **Coupled must-fix:** evidence stamping is currently gated on `classification.flowType === "TRANSFER"` (`syncTransactions.ts:323`) — reclassification would silently stop capturing the rail; widen the stamp condition to "transfer-like PFC signal" (capture-or-never, FI0 §16). NOT in liquidity (already correct), NOT in the projection/widgets (a consumer minting a fact = the KD-10 birth defect), NOT purpose-from-rail (banned). Cheap interim regardless: give the liability payment-app leg a "Moved, not spent" label so the money is visible.

**Canonical architecture answer:** the pipeline the milestone asks for already exists — *raw row → persisted facts (flowType+version, TI2 facts, transfer-evidence axes) → read-time relationship context (disposition, ownership) → `DayFacts` canonical projection → measures → surface adapters*. The proposal is **convergence, not construction**: (i) make `DayFacts` the only fold (Summary's liquidity headline reads `aggregateDayFacts`; `deriveCashFlowAxes`/`groupLiquidityByReason` become label shims); (ii) delete the four dead folds + two stale comments; (iii) export `economicSpend` as the sole clamp and compose the tab through it; (iv) name the nets (`netEconomic`, `netLiquidity`, `netAfterDebtService`) as exported measures and re-home the AI/annotations nets onto the named claims; (v) keep persistence exactly as ratified (flowType + evidence persisted+versioned; disposition/ownership/DayFacts read-time — cheap and self-healing); (vi) carry min consumed `classifierVersion`/`tiFactsVersion` in aggregate provenance so a v3 backfill *explains* figure shifts. No new model is justified.

### B2. Semantics doctrine tests

**Existing coverage is far better than "absent" (VERIFIED):** ~30 suites across flow-classifier (full ruleset + CF-4 + assembler-partition equivalence), flow-predicates (membership freeze + label totality vs the Prisma enum), flow-desync invariant, write-marshalling (plaid-flow-write/input, flow-row-input), serialize.golden (DTO byte-identity), cash-flow / projection / compare / context / movement, liquidity ×3, transfer-evidence ×2 + transfer-matching + investment-venue + counterparty-visibility + RelationshipResolver, needs-classification, transaction-facts (+backfill), kd17 + golden (assembler), and the perspective/host source-scans. Covered doctrine cases: income, refund netting, CC payment both legs, internal/external transfer, brokerage/exchange both directions, dividend, interest both signs, fee, ATM/cash, payment-app incl. liability leg, pending policy, multi-currency.

**The four genuine gaps:** (1) BALANCE_ONLY row-exclusion has no test at this surface (KD-15 predicate is tested; the *aggregate* consequence isn't); (2) `deletedAt` exclusion at the aggregate layer (pure functions trust pre-filtered input; nothing pins the contract); (3) imported-CSV vs Plaid **flowType parity** (facts parity exists; classification parity doesn't); (4) **cross-surface parity over one shared fixture** (tab spend == `aggregateCashFlow` == assembler expense∓refund over identical rows/window — currently only intra-perspective parity is pinned).

**Best test form (PROPOSAL):** extend the house idiom rather than inventing one — a **table-driven oracle** (`doctrine-cases.ts`: ~35 rows of {input row(s) + account context} → {expected flowType, disposition, liquidity effect, income/spend/debt/investment inclusion, calendar bucket, needs-classification, AI serialization presence}) executed against `classifyFlow` + `classifyLiquidity` + `DayFacts` + the assembler accumulator in one file, plus one **shared-fixture cross-surface parity test**, plus the existing source-scan invariants. Skip property tests and DB-backed fixtures for now (the pure layer is where meaning lives; the repo's `npx tsx` runner favors pure suites). Golden files only for the AI serializer (already exists). This is one slice, not a program.

### B3. Transaction metadata depth

**The 2026-07-02 investigation's scope is substantially complete or deliberately ratified out (STALE STATUS — scope shrank).** Shipped since: currency (MC1), PFC trio + merchantEntityId (P3), paymentChannel/paymentMethod/settlementState/authorizedAt/counterpartyType/fxApplied/pendingTransactionRef (TI2), merchant logo/website at the Merchant tier (MI1 M4, entity-id-matched only), pending↔posted (TI4). Ratified **out** by the TI2 §7A Metadata Capture Doctrine: the raw `providerMetadata` blob, location, `account_owner`, payment_meta identity fields, counterparty account numbers ("never captured" deny-list at the type level, `plaid-flow-input.ts:53,63–67,127–32`). No raw payload retention exists anywhere. Import path captures everything the format offers.

**What genuinely remains:** (1) **a decision, not code** — historical thinness: provider-only facts are NULL on rows synced before 2026-07-07 ~21:32 UTC and cannot be backfilled from rows; the only cure is a cursor-reset re-sync (`recover-plaid-item-transactions.ts` exists). Accept forward-only or run one re-sync — founder call. (2) **TI3 apply-state verification** — one read-only dry-run of `scripts/backfill-transaction-facts.ts` (NEEDS RUNTIME/DB VERIFICATION; STATUS explicitly flags it). (3) Optional §7A-compliant additions if a surface wants them: `datetime`/`authorized_datetime` intraday precision, `original_description`. Receipt Intelligence stays parked (re-affirmed 07-13, demand-gated on beta); provider-specific leakage is fenced (PFC strings labeled "provider hint" in-schema); the real semantic leakage is the CSV-vs-Plaid category dialect, which belongs to the classifier/doctrine lane, not metadata.

### B4. Transaction cleanup tooling

**Detect-side is rich; resolve-side is thin (VERIFIED).** Exists: needs-classification predicate wired into 6 surfaces (assembler, chat line, brief, signals, assessment, UI filter+chips); read-time transfer candidates in the drawer; MI2 merge review queue end-to-end (with the `MerchantMergeDecision` migration gap closed 07-14); SyncIssue ledger + PO1.4 triage widget; import rollback (audited, scoped); duplicate detection write-time + read-time; two read-only audits (`audit:flow-desync`, `audit:pending-posted`); `POST /api/transactions/[id]/correct` (merchant identity with 409-candidate flow, category rule, category override) with **sound flow recompute** (`merchant-corrections.ts:107–22` re-runs `classifyFlow` on both paths — the category-correction→flow propagation contract exists); ~16 backfill scripts, mostly dry-run-default and version-gated.

**Genuine gaps:** (1) **No UI calls `/correct`** — the drawer is display-only; needs-classification is a dead-end flag. (2) **Cluster A (`UNKNOWN_PAYMENT_APP_PURPOSE`) is unresolvable by any existing action** — the predicate keys on `transferRail + hasResolvedCounterparty`, which no correction touches. (3) Category rewrites outside `/correct` don't invalidate flow (`backfill-merchant-categories.ts` — the named MI entry-gate item); transfer evidence is never recomputed on correction (stale rail after an override away from TRANSFER); `paymentMethod`'s INTERNAL_TRANSFER branch can go stale (cosmetic). (4) `SyncIssue.resolved` has no writer. (5) Three scripts have **inverted posture** (live-by-default): `backfill-provider-account-identity.ts`, `backfill-wallet-connections.ts`, `dedupe-home-links.ts`; `backfill-ai-agents.ts` has no flags. (6) No repo-marker convention for `--apply` runs (the TI3-class problem). (7) No AuditLog write on `/correct`.

**Minimum tooling verdict (PROPOSAL):** v2.5.5 needs — the drawer correction UI over the existing route; a cluster-A resolution action (assert purpose / confirm counterparty); one shared category-write helper that recomputes flow + re-stamps evidence (and is used by the bulk scripts); script-posture normalization + npm aliases + an apply-run marker convention; an audit row on `/correct`; a `resolved` writer for SyncIssue. **Not** needed: a persisted review-queue platform, bulk ops, refundCandidate (own ratification), undo, a generic recompute service. Corrections stay non-competing with the classifier because the correction path *feeds* the single classifier rather than writing flow directly — preserve that.

### B5. v2.5.5 closeout definition

**Exit criteria (exact, PROPOSAL):**
1. One canonical aggregation path: `DayFacts` is the only fold; dead folds deleted; `economicSpend` single-sited; nets named and re-homed. *(Substantially done; convergence slice required.)*
2. Summary/History/Calendar parity — already test-enforced; add the cross-surface (tab/assembler) shared-fixture test.
3. Payment-app/account-tier correctness: classifier v3 + evidence-stamp decoupling + version-gated backfill applied and **recorded**.
4. Doctrine test suite: table-driven oracle + the 4 named gap tests green in CI.
5. Cleanup tooling minimum (B4 list) shipped; correction propagation contract codified.
6. Metadata: TI3 dry-run verified + historical-thinness decision recorded; no new capture initiative.
7. Clean audits: `audit:flow-desync`, `audit:pending-posted`, backfill dry-runs ≈ 0 eligible.
8. STATUS.md v2.5.5 section rewritten to record CF-3 et al.
**Must-have:** 1–4, 7, 8. **Should-have:** 5. **Follow-up-eligible:** 6's optional fields, SyncIssue resolved-writer, fallback-hit counter. **Explicitly out:** any new surface (the milestone's own rule), refundCandidate, Receipt Intelligence, review-queue platform, Decimal money migration.

---

## 5. Part C — OPS-1 S9/S10 and beta readiness

### C1. OPS-1 S9 legal pages — ~85% shipped (STALE STATUS)

**Built (VERIFIED, all IMPLEMENTED BUT UNDOCUMENTED in STATUS):** `app/(public)/` serves `/` (landing), `/terms`, `/privacy`, `/legal/ai`, `/security`, `/about`, `/request-access`, all logged-out (`proxy.ts:13` guards only `/dashboard/*` + `/admin/*`), all linked from `components/marketing/MarketingFooter.tsx:11–18`, content in `content/marketing/` (real drafted-honest text, not placeholders), with the marketing tree server-only and Prisma-free (enforced by `lib/marketing-boundary.test.ts`). Terms covers closed-beta disclaimer, 18+, credential responsibility, read-only/no-money-movement, **not-financial-advice incl. AI output**, acceptable use, as-is, termination + self-serve deletion, liability, change notice. Privacy covers collection categories, minimalism/never-sell, generic provider description, encryption, retention, export/deletion/2FA rights. `/legal/ai` covers ambient briefing, not-advice, accuracy limits, third-party model processing, minimum-necessary, no-training commitment.

**Missing (VERIFIED):**
1. **Consent capture — entirely absent (DOCUMENTED BUT NOT IMPLEMENTED; the S9 gate).** No `acceptedTermsAt` on `User`; `app/(auth)/register/page.tsx` (373 lines) has no checkbox and **no link to /terms or /privacy anywhere**; the register route records nothing. Login links nothing legal either.
2. **Named LLM retention posture (STATUS blocker 7, narrowed).** `/legal/ai` names neither OpenAI nor any retention window; `lib/ai/provider.ts:40` constructs a plain OpenAI client with no retention/ZDR configuration. Closing this = one decision (state the OpenAI API data-usage posture) + one paragraph + optionally the org-level API setting.
3. **Precision gaps for counsel:** dates are month-granularity ("July 2026") with no version identifiers; the 7-day deletion grace window (`lib/account-deletion/preflight.ts:25`) and audit-log anonymization behavior (`purge.ts:77–95`) are true but undisclosed; NextAuth JWT 30-day sessions undescribed; no published support address (`support@fourthmeridian.com` exists as a sender identity only; the sole contact channel is the request-access form).

**Promise-vs-implementation cross-check (all VERIFIED true):** export (`POST /api/user/export` — ZIP, visibility-filtered through the FULL-only readers, fresh-auth, 3/day), deletion (7-day grace → daily `process-deletions` job → Plaid `itemRemove`, anonymized audit retention), no-analytics ("basic technical data" claim is accurate — zero telemetry packages), security-page claims (bcrypt 12, HKDF, audit, default-on rate limits, TOTP). The implementation can already support the policy; the policy under-discloses rather than over-promises. Product facts counsel needs: OpenAI (chat completions, gpt-4o-mini), Plaid, Resend, Vercel (sin1), Supabase Postgres, Cloudflare Turnstile — none currently named; 7-day deletion + anonymized audit retention; JWT sessions + DB session ledger; no cookies beyond auth; no analytics; CSV import contents; wallet addresses (public-chain data); cross-border processing (Vercel sin1 / provider regions); 18+ restriction; beta terms.

### C2. OPS-1 S10 beta-access gate — ~90% shipped (STALE STATUS)

**Implementation (VERIFIED, commit `ccf9955` + migration `20260713180000_add_beta_access_request`):** `BetaAccessRequest` (unique email, note, `PENDING|APPROVED|DENIED|REDEEMED`, SHA-256 `inviteTokenHash`, `inviteExpiresAt`, decidedBy/redeemedUser provenance, queue index). Registration mode is a **DB `PlatformSetting`** (`registration_mode ∈ open|invite_only|closed`, settable only via fresh-auth SYSTEM_ADMIN `PUT /api/admin/security/settings`) — strictly better than the planned env flag (instant, reversible, no deploy). Flow: request-access (IP-limited + Turnstile + non-enumerating 200, audited) → founder Approve/Deny in the Growth widget (`GrowthBetaRequestsWidget`, WRITE-gated `requireFreshPlatformAccess("GROWTH_REVENUE","WRITE")`) → Approve mints a 32-byte token (hash stored, **14-day expiry, email-bound, single-use**), sends the invite email, re-approve = rotate/resend, Deny revokes outstanding tokens silently → `/register?invite=` validated + consumed **atomically inside the user-creation transaction** (status-guarded `updateMany`; replay-safe) → invited signups born email-verified. Existing users untouched; fully separate from `SpaceInvite`; all four lifecycle audit events written.

**Gaps:**
1. **Production default is `open`** (`lib/platform-settings.ts:41` — default and invalid-value fallback). The gate exists but is **not closed by default**. Flipping `registration_mode=invite_only` in prod is a config act; whether it has been done: NEEDS RUNTIME/DB VERIFICATION. Same for Turnstile keys in prod env (CAPTCHA is a no-op without `TURNSTILE_SECRET_KEY`).
2. Minor plan deltas: no HOLD status, no cohort tagging, **no direct-invite action** (the founder cannot invite an address that never submitted the form without a manual DB row).
3. Recommendation on model choice: the shipped design (request/approve + hashed email-bound single-use tokens folded into the request row + DB mode toggle) **is** the right model for this stage — auditable, reversible, founder-operable, separate from Space membership, and not an entitlement platform. Do not rebuild it; finish it: flip the default (or the prod setting), add the direct-invite affordance later if needed.

### C3. External-beta readiness audit

| Area | Evidence | Classification |
|---|---|---|
| Authentication | `lib/auth.ts` two-step, timing-safe pre-login, TOTP (+forced for SYSTEM_ADMIN), CAPTCHA step-up after 3 failures, verification gate `lib/auth.ts:203` (no exemptions) | Already sufficient |
| Password reset / email verification | Hashed tokens; prod email-only; POST-only verify; non-enumerating resend | Already sufficient |
| Session security | JWT 30d + `UserSession` revocation + fresh-auth on all sensitive mutations | Sufficient for tiny beta |
| Rate limiting | Default-on in prod (`lib/rate-limit.ts:73`); every new public endpoint limited at birth | Already sufficient |
| Security headers | HSTS/nosniff/XFO/Referrer/Permissions live; **CSP Report-Only** (`next.config.ts:52`) | Sufficient for beta (enforce flip post-clean-window) |
| Audit logs | Canon `AuditLog` + beta/verification/anomaly/export/delete coverage + SecOps feed widget | Already sufficient |
| Data deletion / disconnect | OPS-2 pipeline, 7-day grace, scheduled purge, Plaid itemRemove | Already sufficient |
| Support contact | Unpublished; form-only | Sufficient w/ documented limitation — publish support@ before invites |
| **Error monitoring** | `instrumentation.ts:24–27`: "Sentry… NOT configured yet"; no APM anywhere | **Must fix before beta** |
| Job health | OPS-4 ledger + dead-job detector + Ops widgets; detect-only by ruling | Sufficient for beta |
| **External uptime monitoring** | `OPS4_PRODUCTION_READINESS_CHECKLIST.md:21` unchecked | **Must fix before beta** (ops task, no code) |
| Provider sync failure | SyncIssue + CS widget + connection-health widget + 07-14 sync-lock fixes (`43cc5b7`) | Sufficient for beta |
| **Backups / restore drill** | Named precondition in `KEY_ROTATION_RUNBOOK.md:45–49`; no drill writeup exists | **Must fix before beta**; Supabase PITR state NEEDS RUNTIME VERIFICATION |
| Migration safety | Additive-first discipline across 44 migrations | Already sufficient |
| Privacy boundaries | KD-1/15/19 canonical predicates + two-user proof | Already sufficient |
| **LLM disclosure** | Page live; provider/retention unnamed | **Must fix before beta** (small) |
| Data export | OPS-2 export route | Already sufficient |
| **Legal pages** | Live; **consent capture missing** | **Must fix before beta** (consent only) |
| **Beta access** | Built; **prod default open** | **Must fix before beta** (config flip + verify) |
| Onboarding | Register auto-creates template-backed Personal Space + agent | Sufficient for tiny beta |
| **Production Plaid** | `PLAID_ENV=sandbox` default; Plaid keys not in `PROD_REQUIRED_KEYS` (`lib/env.ts:111–16`) | **Must fix before beta** (credentials + env validation won't catch sandbox-in-prod — consider adding a validateEnv warn) |
| Env validation / observability | Boot-time validateEnv + EnvReport widget + ApiUsageCounter + JobRun | Already sufficient (no APM caveat above) |
| Incident response | Runbook current except a stale "three Vercel crons" paragraph | Sufficient w/ documented limitation |
| Feature rollback | Env flags + PlatformSetting + per-slice-revertible doctrine | Sufficient for beta |
| User communication | Resend seam, 8+ templates, retry outbox | Already sufficient |
| Mobile / accessibility | Shell-nav responsive work landed; no formal audits | Sufficient w/ limitation / fix soon after |

**Correct blocker list (replaces STATUS §6's "blockers 6 + 7"):**
1. Consent capture at registration (S9 gate) — code, small.
2. LLM disclosure completion: name OpenAI + retention posture (blocker 7, narrowed) — decision + copy.
3. Sentry (or equivalent) via the documented `register()` init point — code, small.
4. External uptime monitor on `/api/health` — ops act.
5. Backup restore drill, recorded in `docs/operations/` — ops act; verify Supabase PITR.
6. Production config flips + verification: `registration_mode=invite_only`, Turnstile keys, production Plaid credentials, Resend domain auth — NEEDS RUNTIME/DB VERIFICATION.
7. (Retained, beta-acceptable for a hand-picked cohort:) the two named missing test suites — window/follow-up heuristics (→ absorbed by AI5-1) — and publishing a support address.
Explicitly NOT beta blockers: CSP enforce flip, counsel-reviewed legal text (v3.0), status page, async export, accessibility audit.

---

## 6. Part D — AI-5 readiness

### D1. What AI-5 already has

**Pipeline (VERIFIED, `app/api/ai/chat/route.ts`, 2,199 lines):** requireUser → per-user rate limit 30/60s → body guards (50 msgs — now with user-facing copy; 24k chars) → intent classification of the **latest message only** (9 ordered keyword rules, `lib/ai/intent/classifier.ts:147–297`) → window resolution (`resolveTransactionWindow` :305–24: latest-message parse wins; else `looksLikeFollowUp` scans prior messages newest→oldest re-classifying each; else undefined → assembler default 90d) → ambiguity guard (deterministic clarification, no LLM) → drilldown resolution (a second, partially independent window path :511–74) → `buildContext` (membership guard, AiAgent load, manifest ∩ agentScope, parallel assemblers with per-domain error swallowing → `skippedDomains`, audit row per build) → `computeAssessment` (13 sections, each with `ConfidenceLevel`) → prompt (doctrines + QUESTION ROUTING + FINANCIAL ASSESSMENT with `[confidence: X]` + SPACE CONTEXT with window block, ATTRIBUTION_DISCLOSURE, per-liability rollup, KD-7 COVERAGE LIMIT, TI2-W2 needs-classification line, KD-17 checked invariants, monthly breakdown with INCOMPLETE/PARTIAL flags, **raw JSON.stringify domain dumps** :1115–27) → `gpt-4o-mini` (temp 0.3, **1,024 max output tokens**, usage → ApiUsageCounter) → output validator (membership+tolerance, `annotate` default, fails open) → `{message, knowledgeGaps}` — **no window, provenance, or validation metadata returned to the client**.

**Nothing conversational is persisted (VERIFIED).** The client (`AnalyzeClient.tsx`) holds messages in `useState` and POSTs the full history each turn; page refresh wipes it; there is **no conversation id** anywhere; the only cross-request writes are audit rows (2/message/Space — KD-12) and usage counters. "Follow-up carry-forward" is per-turn re-classification of prior message *text*, not state. The route header self-documents: "conversation persistence, memory, actions — not implemented."

**Charter-item states:** conversation-state substrate ABSENT · active-window disclosure PARTIAL (effective window stated in prompt; requested window only when the latest message parsed one; no provenance stamp; nothing returned to UI) · context-change disclosure ABSENT (no prior-window record exists) · confidence propagation PARTIAL-STRONG (lattice everywhere; contract untested) · completeness propagation PARTIAL-STRONG (KD-7 truncation, complete-months, KD-10 null doctrine, TI2-W2 wired into all 5 surfaces incl. income-confidence downgrade) · intent-path consistency DOCUMENTED BUT NOT IMPLEMENTED (all KD-16 defects verified live: "since <year>"→closed-year at `classifier.ts:392–409`; silent 90-day default; undisclosed 800-day clamp `transactions.ts:178,1142–44`; ≥3 window-deriving paths) · compression ABSENT (hard 400) · presentation PARTIAL (markdown+GFM; the enforcement notices are verbatim mechanical strings) · follow-up PARTIAL (heuristic; intent has NO carry-forward — asymmetric with window) · goal reasoning PARTIAL (data, not conversation) · durable continuity ABSENT · KD-8 OPEN (`Promise.allSettled` :2060–64, failures console-only, no omission disclosure, unbounded prompt) · provenance display ABSENT.

**Two discoveries that materially affect planning:**
1. **The "eight failures" corpus is not in the repo.** Every citation points at an uncommitted 2026-07 testing-session artifact. The exit criterion ("eight failures reproduced as tests") is untestable until the corpus is reconstructed from the five documented failure classes + the two WS-2 reproductions + KD-16 + KD-8. This is AI5-0 work.
2. **No conversation identity exists in the client/server contract.** WS-1 persistence needs the client to carry a `conversationId`; that contract change (and its reconciliation rules against client-editable history) should be designed before any migration is written.

### D2. Dependencies on v2.5 and v2.5.5

- **Legacy Account retirement → SOFT dependency.** The AI assembler still carries legacy OR arms (`transactions.ts:344–59, 1216, 1246`); retirement changes the row population, so **golden-figure tests would re-baseline**. Mitigation: write AI-5/KD-16 characterization tests asserting *window bounds and provenance labels*, not dollar figures — then they are retirement-proof and the work can proceed in parallel.
- **Canonical aggregation (v2.5.5) → affects WS-3 values, not contracts.** Classifier v3 + net-naming shift figures; caveat-propagation contracts are value-independent. Land contracts first; avoid numeric goldens until B-S1/B-S3 land.
- **Confidence contracts → no blocker** (lattice exists; WS-3 is formalization).
- **Beta gate / legal-LLM disclosure → no code dependency** (disclosure is copy; but a *user-facing* AI-disclosure line in the chat UI would ride WS-2's machinery naturally).
- **Observability/token accounting → exists**; per-conversation attribution needs conversation identity (WS-1).
- **Design system → no dependency** for the disclosure/state slices; WS-6 presentation should use Atlas primitives when it arrives.

**Verdict on the milestone label:** the entry criterion "v2.5 seams closed" should be read as gating **live cutover**, not investigation or zero-schema foundation slices. Chartering is done; AI5-0/1/2/3-shadow can run in a parallel worktree now without touching v2.5/v2.5.5 files (except one serializer insertion point), provided the golden-figure rule above is followed.

### D3. Proposed AI-5 architecture (grounded)

**Persist:** a `ConversationState` row — id, `userId` (required), `spaceId` nullable (master mode; `AuditLog.spaceId` nullable is the precedent), optional `aiAgentId`, `version` (state-schema version), `activeWindow` (resolved **dates**, not phrases, + provenance enum `explicit|inherited|default|clamped`), `activeIntent`, `lastAnsweredWindow`, `unresolvedQuestions`, `citedFactsDigest` (assembler-reported availability per domain incl. per-Space availability in master mode), `runningSummary` (deterministic, WS-5), timestamps. **Derive (never persist):** context, assessment, prompts, validation results, anything recomputable from facts. **Deterministic transitions only:** state updates are pure functions of (previous state, new user message, resolver outputs) — the LLM never writes state fields; LLM text is presentation only. **Guards:** no chain-of-thought storage; no financial figures in state (digests/availability flags only — keeps state privacy-cheap and Space-scoped through existing membership guards); freeze resolved windows at answer time (fixes the re-derivation clock drift — three separate `new Date()` sites today can disagree within one turn); explicit reconciliation rule for client-edited history (recommend: server state wins for continuity, hash-check the replayed tail, disclose on mismatch); master-mode state records per-Space availability deltas so KD-8's contradiction class is structurally covered; single state read+update row per turn (do not worsen KD-12).

**No immediate migration is required.** Phase 0 defines the `ConversationState` **type** and a pure `deriveState(messages, now)` populated by today's heuristics, characterization-tested; the schema + conversationId contract land only when shadow parity is proven (the D6.3D-1 shadow-planner precedent, `route.ts:89–134`, is the house pattern for exactly this).

### D4. AI-5 slice plan and opening gate

- **AI5-0 — Failure corpus + state doctrine (zero schema).** Reconstruct the eight failures as a committed fixture doc + test skeletons; define the ConversationState type + `deriveState` pure function + transition rules; decide the history-reconciliation and master-mode-keying doctrines. Non-goals: any runtime change.
- **AI5-1 — Window semantics + single resolver (KD-16 items 1–2, 4; zero schema).** Characterization suite over `detectTransactionWindow`/`resolveTransactionWindow`/`resolveDrilldown` (asserting bounds+labels, not dollars — absorbs the v2.4.5 "window/follow-up suites" debt); fix "since <year>"→year-to-present; distinguish unparsed from no-window; collapse the ≥3 window paths onto one resolver; fix the `looksLikeFollowUp` bare-month false positive ("may").
- **AI5-2 — Window provenance + disclosure (KD-16 items 2b–3; zero schema).** `AssemblerOptions.transactionWindow.provenance`; serializer line at the :761–74 site covering default/inherited/clamped; return `{window, provenance}` in the response payload; minimal UI chip.
- **AI5-3 — Shadow context-change detector (zero schema).** Statelessly re-derive turn N−1's window from `messages[0..n−1]`, compare, log would-be disclosures (shadow-planner pattern). Promotion to a visible disclosure line is a flag flip after a clean window.
- **AI5-4 — Confidence/completeness contracts (WS-3; zero schema; parallel-safe).** Per-derived-metric carry-or-suppress tests in `annotations.ts`; needs-classification/truncation caveat propagation proven by test.
- **AI5-5 — KD-8 master-mode disclosure (zero schema).** "N of M Spaces unavailable" serializer line from the already-known `contextResults` rejections; per-Space availability recorded for AI5-6. Prompt bounding deferred (planner-live is v2.6b).
- **AI5-6 — ConversationState persistence + conversationId contract (FIRST schema slice).** Additive model + client round-trip; dual-run: derived state vs persisted state compared in shadow until parity, then persisted becomes authoritative. Rollback = revert to derivation (reads never depend on rows existing).
- **AI5-7 — Graceful compression (WS-5; after AI5-6, structurally).** Deterministic history compression + running summary; retire the 50-message 400. (Compression destroys the raw text today's carry-forward re-scans — the sequencing constraint is structural, not preferential.)
- **AI5-8 — Advisor presentation (WS-6).** Humanize the two enforcement notice strings (must run before enforcement or re-validate — `annotate` idempotence depends on the exact string); provenance display; Atlas components. Optional post-validator rephrase stays below the validator, fails open.

**Formal gates:**
- *Planning may begin:* now (this document + charter satisfy it).
- *Pure foundation (AI5-0…5) may begin:* now, in a parallel worktree, under the no-golden-dollar-figures rule. Recommended actual start: after B-S1/B-S3 merge to minimize churn, or immediately if staffing allows.
- *Shadow integration (AI5-3 promotion, AI5-6 dual-run):* requires v2.5 M1 (legacy reads gone from AI paths) + v2.5.5 items 1–4 (canonical aggregation + classifier v3) so state never memorializes figures that are about to change meaning.
- *Live user-facing cutover (AI5-6 authoritative, AI5-7, disclosure lines on):* requires v2.5.5 closeout + the C-blocker list done (an external beta user should meet the disclosed, gated product).
- *AI-5 complete:* the reconstructed failure corpus green as tests; zero silent window changes and zero contradictory availability claims over a one-week window; every derived metric's caveat behavior test-pinned; validator authority unchanged; KD-8 + KD-16 closed in §7.

---

## 7. Cross-initiative dependency graph

```
STATUS truth-up ──────────────► (unblocks honest planning everywhere)

A1-M1a count swaps ─┐
A1 invariant test ──┼─► A1-M1b arm removal ─► [prod gates 0] ─► M2/M3/M4 (separate DB milestone)
[prod gate run] ────┘         │
                              └─► AI shadow integration gate (assembler arms gone)

B-S1 convergence ─► B-S2 doctrine tests ─► v2.5.5 close ─► AI-5 live cutover gate
B-S3 classifier v3 + backfill ──┘                          │
B-S4 currency threading ───────────────────────────────────┤
B-S5 correction UI  (independent)                           │
                                                            │
C-S1 consent + C-S2 LLM disclosure + C-S3 ops floor ─► BETA │
S10 config flip (ops act) ──────────────────────────► BETA ─┴─► AI-5 live cutover

A2-S1 sibling relocation ─► A2-S2 PerspectiveWorkspace ─► (v2.5 close; no downstream dependents)
A3 ruling + ratchet scope ─► (v2.5 close)

AI5-0/1/2/3/4/5 (zero schema, parallel worktree) ─► AI5-6 persistence ─► AI5-7 compression ─► AI5-8
```

Hard edges: AI5-7 after AI5-6 (structural); AI5-6 shadow after A1-M1b + B-S3; B-S2 after B-S1 (tests pin the converged shape); A2-S2 after A2-S1 (same file). Everything else is soft or parallel.

## 8. Parallelization and ownership map

| Workstream | Files touched | Conflicts with | Worktree? |
|---|---|---|---|
| STATUS truth-up | STATUS.md only | everything textually — do it FIRST, alone | no |
| A1 (Account) | admin pages/routes, `dashboard/spaces/page.tsx`, `lib/data/*`, `lib/transactions/detail-query.ts`, AI assembler arms, privacy tests | AI5 (assembler), B-S4 (assembler) — sequence within the file | no (small, sequential slices) |
| A2 (shell) | `SpaceDashboard.tsx` + new dirs + 4 source-scan tests | anything touching SpaceDashboard (nothing else planned does) | **yes** — big mechanical moves |
| A3 (Atlas ruling) | ratchet test/baseline, DataCard comment, STATUS | none | no |
| B-S1/S2/S3 (semantics) | `lib/transactions/{cash-flow,liquidity,cash-flow-projection,flow-classifier}.ts`, `syncTransactions.ts:323`, widgets' import lines, doctrine tests | B-S4/B-S5 (adjacent files) — one owner for the whole B lane | no (one lane, sequential) |
| B-S4 (assembler currency) | `lib/ai/assemblers/transactions.ts` | A1 arm removal + AI5 golden tests — land after A1-M1b or coordinate | no |
| B-S5 (correction UI) | drawer components, `/correct` route, scripts | none | optional |
| C (S9/S10/ops) | register page/route, schema (+`acceptedTermsAt`), `content/marketing/`, `instrumentation.ts`, ops docs | auth pages also wanted by A3 polish — combine | no |
| AI5-0…5 | `lib/ai/intent/*`, chat route serializer insertions, new `lib/ai/conversation/` | B-S4 + A1 in the assembler; chat route is the merge-conflict hot zone with B-S4's net-naming | **yes** — dedicated worktree, rebase after B lane merges |

**Merge-conflict zones:** `lib/ai/assemblers/transactions.ts` (A1, B-S4, AI5 tests) and `app/api/ai/chat/route.ts` (AI5-2/5, B-S4 net naming) — sequence A1→B-S4→AI5 serializer work within those files. **Schema ownership:** only C-S1 (`User.acceptedTermsAt`) and AI5-6 (ConversationState) add models/fields before the deferred Account M3/M4 — no contention.

## 9. Recommended execution order

**Option 1 — Strict milestone closure** (v2.5 → v2.5.5 → OPS-1 → AI-5): ~sequential, lowest cognitive load, but delays beta by the entire v2.5+v2.5.5 tail even though beta depends on neither the shell decomposition nor the classifier fix; delays AI-5 learning; leaves the founder operating a stale STATUS for weeks. Total effort identical; time-to-beta and time-to-AI-5-learning strictly worse; rework risk low.

**Option 2 — Safe parallelization (RECOMMENDED):** three lanes with live-cutover gates preserved.
- *Lane 1 (ship-to-beta):* STATUS truth-up → C-S1/C-S2 → C-S3 ops floor + config flips → invite first user. Nothing here touches product architecture.
- *Lane 2 (semantics + v2.5 closure):* A1-M1a + invariant test → B-S1 → B-S3 → B-S2 → A1 gate-run + M1b → B-S4/B-S5 → A2-S1 → A2-S2 → A3 ruling. v2.5 and v2.5.5 close within this lane.
- *Lane 3 (AI-5 foundation, worktree):* AI5-0 → AI5-1 → AI5-2 → AI5-3/4/5 (shadow) — window-bounds tests only; rebase after Lane 2's assembler changes; AI5-6+ waits for the gates.
Comparison: same total effort; beta arrives weeks earlier; AI-5 learning (corpus + characterization) starts immediately; merge risk contained to two named files with an explicit sequencing rule; cognitive load manageable because Lane 1 is checklist-work, not design-work. Rework risk is the golden-figure trap, neutralized by the bounds-not-dollars rule. **Recommend Option 2.**

---

## 10. Detailed slice proposals — summary table

| Slice | Purpose | Already exists | Missing | Files/domains | Schema impact | Risk | Dependencies | Parallel-safe | Tests | Exit condition |
|---|---|---|---|---|---|---|---|---|---|---|
| **ST-0** STATUS truth-up | Kill the 72-commit drift (S9/S10, CF-3, counters, KD-13, FLOW_COST, DataCard, KD-20) | drift-guard CI | the edits | STATUS.md | none | none | — | first, alone | n/a | STATUS re-stamped at current HEAD; every "remaining" claim re-verified |
| **A1-S1** Canonical count swaps | Fix 5 `Space.accounts` sites + 2 admin counts (user-facing undercount bug) | SAL count pattern | the swaps | `dashboard/spaces/page.tsx`, `admin/{page,overview,spaces,users}` | none | low (numbers change — correctly) | — | yes | extend existing route tests | zero `_count.accounts` / `db.account.count()` in production code |
| **A1-S2** Legacy-Account invariant | Prevent regression; shrinking whitelist | KD-15 tripwire idiom | the scan test | new `lib/legacy-account-invariants.test.ts` | none | none | A1-S1 | yes | itself | CI fails on any new legacy reference |
| **A1-S3** Prod gate run | Record Gates A/B/C/E | `scripts/phase0-seam-gates.ts` (read-only) | the run + recorded results | docs + STATUS | none | none | prod DB access | yes | n/a | counts committed to repo |
| **A1-S4** Dual-arm removal | M1 finish: remove fallbacks + 11 OR arms + `legacy` DTO flag | canonical arms | deletions + test updates | `lib/data/*`, `detail-query.ts`, correct route, AI assembler, account-txns route; `transactions.privacy.test.ts`, `transaction-detail.privacy.test.ts` | none | medium (row visibility) — gated on A1-S3 = 0 | A1-S3 | after B-S4 in assembler | updated KD-15 suites + invariant shrink | zero legacy reads; v2.5 exit criterion met |
| **A1-M2/3/4** DB retirement | Re-anchor (if needed), FK drop, model+SHARED drop | backfill/verify script shapes | approval + migrations | prisma, seed, gate script | **destructive-capable** | high — Cascade | A1-S4 + prod-clean cycle + founder approval | no | gate re-runs | model gone; separately approved milestone |
| **A2-S1** Sibling relocation | Host 3,731→~1,700 LOC; byte-identical | decomposition pattern ×5 | the moves; dead Personal-fetch deletion | `SpaceDashboard.tsx` → `components/space/{goals,sections}/`; `page.tsx` | none | low-medium (4 source-scan tests re-pointed) | — | **worktree** | re-pointed scans green, suite green | host has zero module-level sibling components |
| **A2-S2** PerspectiveWorkspace | Extract the Perspectives tab owner (branch chain + gates + envelope) | shell kit, envelope registry | the extraction | new `components/space/shell/PerspectiveWorkspace.tsx` + host | none | medium (state ownership; 6 lazy-fetch gates) | A2-S1 | worktree | branch-pin tests rewritten | host owns nav+data only; workspace owns composition |
| **A3-S1** Atlas ruling + ratchet scope | Rule exemptions (admin/marketing/business_accounts); expand ratchet fence; fix stale comments | empty baseline, ratchet mechanism | scope list + baseline regen + ruling text | `palette-ratchet.test.ts`, DataCard.tsx comment, STATUS | none | none | — | yes | ratchet run | all component trees fenced; exemptions recorded |
| **A4-S1** Hygiene close | env-example keys (5), gitignore ordering, support@ publication | most already fixed | the edits | `.env.example`, `.gitignore`, marketing contact | none | none | — | yes | n/a | env.ts↔example diff clean |
| **B-S1** Projection convergence | DayFacts = only fold; delete 4 dead folds; single `economicSpend`; name the nets | CF-3 + parity tests | shims, deletions, exports | `lib/transactions/{cash-flow,liquidity,cash-flow-projection}.ts`, SummaryWidget, Panel | none | low (test-pinned equalities) | — | yes (B-lane owner) | existing parity suites + new net-name tests | one fold; one clamp; three named nets |
| **B-S2** Doctrine test suite | Financial constitution: ~35-case oracle + 4 gap tests | ~30 suites | oracle table; BALANCE_ONLY/deletedAt/CSV-parity/cross-surface tests | new `lib/transactions/doctrine-cases.test.ts` | none | none | B-S1 | yes | itself | all doctrine cases green in CI |
| **B-S3** Classifier v3 (payment-app/liability) | Close the economic hole; general rule not row-patch | CF-4 precedent, backfill mechanism | rule, stamp-decoupling (`syncTransactions.ts:323`), version bump, backfill run + record | flow-classifier, sync, `backfill-flowtype` | none (data backfill) | medium (meaning change — version-gated, dry-run first) | B-S1 recommended | yes | classifier suite + oracle rows + desync audit | v3 applied + recorded; liability app-outflow = SPENDING; evidence still captured |
| **B-S4** Assembler currency + net naming | Thread moneyCtx through 4 rollups; re-home AI nets onto named claims | ctx everywhere else | threading + renames | `lib/ai/assemblers/transactions.ts`, chat serializer | none | medium (AI figures shift on multi-currency) | B-S1; before AI5 goldens; after/with A1-S4 | sequenced in-file | golden updates + kd17 green | zero native-amount aggregates in AI path |
| **B-S5** Correction UI + propagation contract | Resolve-side minimum | `/correct` route + 409 flow + flow recompute | drawer UI, cluster-A action, shared category-write helper, script posture, audit row, SyncIssue resolved-writer | drawer, correct route, `merchant-corrections`, 4 scripts | none | low | — | yes | route + helper tests | needs-review resolvable end-to-end; bulk writers use the invalidation helper |
| **B-S6** Metadata closure | Decisions + verification, not capture | TI2/§7A complete | TI3 dry-run record; historical re-sync decision; optional 2 fields | scripts run + docs | optional additive | none | prod DB access | yes | n/a | decision + dry-run recorded in STATUS |
| **C-S1** Consent capture | S9 gate | pages, footer | `User.acceptedTermsAt`, checkbox + links on register/login, stamp in route, versioned date | register page/route, prisma, terms date | **additive migration** | low | — | yes | register route test | registration stamps versioned acceptance |
| **C-S2** LLM disclosure completion | Blocker 7 | `/legal/ai` page | name OpenAI, retention posture decision, effective dates, in-app chat disclosure line | content/marketing, AnalyzeClient footer | none | none (decision needed) | founder decision | yes | marketing-boundary test | provider + retention named; dates precise |
| **C-S3** Ops floor | Sentry, uptime monitor, backup drill, prod flips | `register()` init point documented; health route | the acts | instrumentation.ts, ops docs, prod config | none | low | prod access | yes | boot test | Sentry live; monitor on /api/health; drill recorded; `invite_only` + Turnstile + Plaid prod verified |
| **AI5-0** Corpus + state doctrine | Make the exit criterion testable; define state | 5 failure classes documented | committed corpus; ConversationState type; `deriveState` pure fn; reconciliation doctrine | new `lib/ai/conversation/` + docs | none | none | — | **worktree** | characterization skeletons | 8 failures enumerated + fixture'd; state contract ratified |
| **AI5-1** Window semantics | KD-16 items 1–2, 4; absorbs v2.4.5 window-suite debt | classifier, resolvers | suite; since-year fix; unparsed-vs-none; single resolver; bare-month fix | `lib/ai/intent/classifier.ts`, chat route | none | medium (behavior change — characterization-first) | AI5-0 | worktree | the suite (bounds+labels, no dollars) | one window path; "since 2024" = Jan-2024→today |
| **AI5-2** Provenance + disclosure | KD-16 2b–3; WS-2 half | serializer window block | provenance enum; serializer line; response metadata; UI chip | assembler options, chat route :761–74, AnalyzeClient | none | low | AI5-1 | worktree | serializer goldens (labels) | every reply's window + provenance visible |
| **AI5-3** Shadow context-change | WS-2 other half, risk-free | shadow-planner pattern | detector + audit log | chat route | none | none (shadow) | AI5-2 | worktree | detector unit tests | clean shadow window → flag-flip to live |
| **AI5-4** Confidence contracts | WS-3 | lattice + flags everywhere | carry-or-suppress tests per metric | `annotations.ts` tests | none | none | — | yes | itself | every derived metric's caveat behavior pinned |
| **AI5-5** KD-8 disclosure | Master-mode honesty | rejection info in scope | one serializer line + availability record | chat route :2074–96 | none | low | — | worktree | master-mode test | omissions always disclosed |
| **AI5-6** State persistence | WS-1 proper | AI5-0 contract, dual-run pattern | model, conversationId contract, dual-run, cutover | prisma, chat route, AnalyzeClient | **additive migration** | medium-high | AI5-0..3; A1-S4; B-S3 (gates) | worktree until cutover | parity dual-run + transition tests | persisted state authoritative; rollback = derivation |
| **AI5-7** Compression | WS-5; retire max-50 | 24k/50 guards | deterministic compression + summary | chat route, conversation lib | none | medium | AI5-6 (structural) | worktree | compression determinism tests | long conversations degrade gracefully, never 400 |
| **AI5-8** Presentation | WS-6 | validator seam, Atlas | notice copy, provenance UI, optional post-validator rephrase | output-validator strings, AnalyzeClient | none | low (idempotence coupling) | AI5-2 | yes | enforcement idempotence tests | notices human; provenance rendered |

## 11. Tests and verification matrix

| Area | Existing locks (keep green) | New tests required | Runtime/DB verification required |
|---|---|---|---|
| Legacy Account | `transactions.privacy.test.ts` (5-SAL-query pin), `transaction-detail.privacy.test.ts`, two-user proof script | legacy-account source-scan invariant (A1-S2); updated pins at A1-S4 | `phase0-seam-gates.ts` prod run (Gates A/B/C/E); `/api/admin/overview` external callers |
| Shell | 4 source-scan files matching SpaceDashboard; perspective threading tests; space-shell-seams; shell-nav | re-pointed scans (A2-S1/S2); workspace-ownership scan | pixel pass on the dev env (house convention) |
| Atlas | palette-ratchet (empty baseline) | expanded-scope baseline | visual/a11y pass deferred to UI-1.x |
| Semantics | ~30 suites incl. projection/liquidity parity, kd17, goldens, desync invariant | doctrine oracle; BALANCE_ONLY aggregate; deletedAt aggregate; CSV↔Plaid flowType parity; cross-surface shared-fixture; net-name tests; classifier-v3 rows | `backfill-flowtype` v3 dry-run→apply recorded; `backfill-transaction-facts` dry-run (TI3); `audit:flow-desync` + `audit:pending-posted` re-run post-v3 |
| Cleanup tooling | merchant-merge suites, corrections implicit | correction-UI route test; invalidation-helper test; script-posture scan | none |
| OPS/beta | rate-limit, env.validate, security-headers, marketing-boundary, platform-surface tripwires | consent-stamp test; register invite-mode test extension | prod: registration_mode, Turnstile keys, PLAID_ENV, Resend domain, Supabase PITR, uptime monitor, Sentry DSN, backup drill |
| AI-5 | output-validator (27), kd17/kd18 route tests, gap characterization, classifier tests | AI5-1 window characterization (bounds+labels); provenance goldens; context-change detector; WS-3 contracts; master-mode disclosure; state-transition determinism; dual-run parity | one-week clean shadow window before disclosure flip |

## 12. Schema/migration impact matrix

| Change | Type | Milestone | Risk |
|---|---|---|---|
| `User.acceptedTermsAt` (+ optional `acceptedTermsVersion`) | additive | C-S1 | none |
| ConversationState model | additive | AI5-6 | low (no readers until dual-run) |
| Classifier v3 | **data backfill only** (version-gated UPDATE) | B-S3 | medium — dry-run, record, audit after |
| Legacy re-anchor (M2, only if gates ≠ 0) | data UPDATE | deferred | medium |
| `Transaction.accountId`/`Holding.accountId` drop (M3) | **destructive DDL** | deferred, approval-gated | high (Cascade if mis-sequenced) |
| `Account` model + `VisibilityLevel.SHARED` drop (M4) | destructive DDL + enum recreate | deferred, approval-gated | high |
| Optional metadata fields (`originalDescription`, `datetime`) | additive | B-S6 (optional) | none |
| DEBT_PAYOFF section-key rename | data UPDATE | deferred (A2 tail) | low |
| Everything else in this plan | **zero schema** | — | — |

## 13. Privacy / security / financial-correctness risks

1. **Cascade data loss on premature Account removal** — the single highest-consequence risk; fully mitigated by the M1→gates→M2→M3→M4 sequence and the invariant test. Never let Prisma auto-generate the M3/M4 migrations (DB1's hand-authored rule applies).
2. **Legacy dual-arm removal changes row visibility** — a legacy-anchored row would vanish from lists/AI if gates are non-zero; hence gate-first ordering.
3. **Classifier v3 changes historical figures** — by design; version-gated backfill + provenance versioning + doctrine tests make it explainable; run desync audits after.
4. **Assembler currency threading shifts AI-quoted figures** on multi-currency Spaces — land before AI-5 goldens; annotate in STATUS.
5. **Evidence-stamp decoupling (B-S3)** — if missed, reclassified rows silently lose rail capture forever (capture-or-never).
6. **Consent capture** must not block existing users (stamp on next login or grandfather — decide; simplest: require acceptance only at registration, backfill-null acceptable for beta cohort).
7. **AI-5 state layer**: no chain-of-thought, no financial figures in state; server-state-vs-client-history reconciliation must be explicit or ghost carry-forward appears; master-mode needs per-Space availability deltas or KD-8's class is institutionalized; single state row per turn or KD-12 worsens; the validator cannot catch wrong-window answers (membership-blind) — correctness is test-enforced upstream only.
8. **Beta gate default-open**: until `registration_mode=invite_only` is verified in prod, the landing page is effectively open registration with a CAPTCHA that is a no-op without Turnstile keys. This is the most urgent single config act in the plan.
9. **No redaction before the LLM** (full merchant/account names + raw JSON dumps leave the server) — acceptable for beta *only if* C-S2 names the provider and posture; pseudonymization is a post-beta consideration, not in scope here.
10. **Inverted-posture backfill scripts** (live-by-default) are an operator footgun next to the correctly-defaulted majority — normalize in B-S5.

## 14. What should explicitly be deferred

- Legacy `Account` M2/M3/M4 physical retirement (separate approved DB milestone; after M1 + one clean prod cycle).
- `PERSPECTIVE_RENDERERS` registry, `useSpaceDashboardData`, `useSpaceTabState`, Panel `useReducer` (beneficial, not v2.5-gating).
- Material Engine Phase 1B light model; admin/auth/merchant-ops Atlas migration; missing primitives (build with first consumer); platform widget-kit primitive adoption.
- Fallback-hit observability counter (PO1.x); digests; snapshot cadence.
- refundCandidate; Receipt Intelligence (parked, demand-gated); review-queue platform; bulk ops; correction undo.
- CSP enforce flip (own commit after clean window); counsel-reviewed legal text (v3.0); status page; async export; accessibility audit (soon after beta).
- Decimal/int-cents money migration (plan during v2.5 per §8; execute post-v2.6b).
- WS-7 goal/follow-up reasoning (charter stretch — cut first); per-conversation cost attribution; live context-priority planner (v2.6b).
- Direct-invite affordance + HOLD status on the beta queue (nice-to-have).

## 15. Exact closeout criteria — v2.5

1. Zero legacy-`Account` production reads: no `db.account.*`, no `Space.accounts` traversals, no dual-path OR arms in app/lib (scripts whitelisted); enforced by the invariant test. (Model retention explicitly re-recorded as a deferred DB milestone — this closes the exit criterion as written.)
2. Prod Gate A/B/C/E counts recorded in the repo (whatever their values — M1b execution requires 0; recording is the v2.5 requirement).
3. `SpaceDashboard.tsx` decomposed per A2-S1/S2: no module-level sibling components; Perspectives workspace extracted; all source-scan locks re-pointed and green; dead Personal fetches deleted.
4. Atlas: ratchet fence expanded to all component trees + `app/(auth)`/`app/(public)`; exemption rulings (admin, marketing, business_accounts) recorded; DataCard/UI-1 stale claims corrected.
5. Hygiene: env-example complete against lib/env.ts + direct-process.env flags; gitignore ordering fixed.
6. v2.4.5 carry-forward disposition recorded: rollup tests exist (done), window/follow-up suites re-homed to AI5-1, counters ~shipped with fallback-hits re-homed to PO1.
7. STATUS.md §5 v2.5 block + §7 rows (KD-13, KD-14 unchanged, KD-20) re-stamped at closing HEAD.

## 16. Exact closeout criteria — v2.5.5

As §4/B5: (1) DayFacts sole fold + dead folds deleted + single clamp + named nets; (2) doctrine oracle + 4 gap tests green; (3) classifier v3 + evidence-stamp decoupling + recorded backfill; (4) cross-surface parity test; (5) correction UI + cluster-A action + invalidation helper + script-posture normalization; (6) TI3 dry-run + historical-thinness decision recorded; (7) desync + pending-posted audits clean post-v3; (8) zero new product surface shipped under this milestone's flag; (9) STATUS v2.5.5 block rewritten (CF-3 recorded as the canonical projection; FLOW_COST residual removed).

## 17. Exact closeout criteria — OPS-1

1. S9: consent captured + stamped at registration; `/legal/ai` names OpenAI + retention posture; effective dates precise; support address published. (Counsel review explicitly deferred to v3.0 per the plan's own risk acceptance.)
2. S10: `registration_mode=invite_only` verified in production; Turnstile keys live; one end-to-end invite (request → approve → email → redeem → born-verified) executed against production and recorded.
3. Ops floor: Sentry initialized at the documented `register()` point; external uptime monitor on `/api/health`; backup restore drill performed and written up in `docs/operations/`; production Plaid credentials decision executed (or beta explicitly scoped to founder-connected data).
4. STATUS OPS-1 row and Current-focus rewritten (S9/S10 no longer "remain").

## 18. Exact formal entry criteria — AI-5

- **Open now:** AI5-0 (corpus reconstruction + state doctrine) and AI5-1/2 (window semantics + provenance) — zero schema, worktree-isolated, bounds-not-dollars test rule.
- **Shadow integration opens when:** A1-S4 merged (AI assembler legacy arms gone) AND B-S1+B-S3 merged (canonical folds + classifier v3) — so no state or golden memorializes figures about to change meaning.
- **AI5-6 persistence opens when:** shadow context-change detector has one clean week AND the conversationId contract is ratified.
- **Live cutover opens when:** v2.5.5 closed (§16) AND OPS-1 closed (§17) AND at least one external beta user exists (the disclosure machinery should meet real users).
- **AI-5 closes when:** the committed eight-failure corpus is green as tests; one week with zero silent window changes and zero contradictory availability claims; per-metric caveat contracts pinned; KD-8 and KD-16 closed; validator authority unchanged.

## 19. STATUS.md corrections required

1. **Current focus / OPS-1 row:** "S9 legal pages + S10 beta access gate remain" → both ~built (Waves 1–3); remaining = consent capture, LLM naming, config flips, ops floor. Record the Growth & Security Platform wave with its own ledger rows (public site, beta system, Turnstile, anomaly detector, PO1.3/PO1.4, webhook receiver, sync-lock F1, SnapshotAmendment, ApiUsageCounter, Transactions perspective redesign).
2. **§5 v2.5 exit criteria:** legacy-Account site list is wrong (4+5+11, incl. the user-facing spaces-page undercount); "monolith decomposition not yet started" → satellites done, host remains.
3. **§3 UI-1 row:** DataCard Step B substantially done (15 consumers); Daily Brief redesign landed (resolve the internal contradiction with §5); remaining = primitive material adoption + Phase 1B only.
4. **§3 FlowType row residual #3** (FLOW_COST duplication): resolved by TI1; delete.
5. **§5 v2.5.5:** record CF-3 canonical projection + parity tests as landed; re-scope remaining to B-S1…S6.
6. **§5 v2.4.5 carry-forward:** max-50 copy fixed; RATE_LIMIT flags documented; observability counters ~shipped (ApiUsageCounter; fallback-hits re-homed); rollup tests exist; window suites re-homed to AI5-1.
7. **§7 KD-13:** closed by `e948ee3` (gitignore root-cause + prune; zero " 2" dirs).
8. **§3 SP-2A-4 row:** `renderHero`/`PersonalHero` seam since deleted.
9. **§2:** working-tree note stale (docs reorganized; ~6 untracked items); suite count 200 → 221+; note ~10 unpushed commits.
10. **A1 inventory correction:** add `app/admin/page.tsx` + the five `Space.accounts` sites to the retirement ledger.
11. **§6 blockers:** replace "6+7 remain" framing with the C-blocker list (§5C above).
12. **MI2 row:** migration gap closed 07-14 (`20260714120000`) — partially recorded already; verify wording.
13. **AI-5 charter row:** note the failure corpus is uncommitted and AI5-0 must reconstruct it.

## 20. Questions / decisions requiring founder approval

1. **Beta gate flip:** flip production `registration_mode` to `invite_only` now? (Recommended: yes, immediately — it is one admin-panel action.)
2. **LLM retention posture:** which statement to publish (OpenAI API default no-training + N-day abuse-retention vs. negotiated ZDR)? Required for C-S2.
3. **Production Plaid:** apply for production credentials now (longest external lead time — STATUS already recommends starting during v2.6) or run beta on founder-connected data only?
4. **Historical facts thinness (B-S6):** accept forward-only provider facts, or run a one-time cursor-reset re-sync?
5. **Legacy Account M2–M4:** approve as a named DB milestone after M1 + clean gates? (M1 itself needs no approval — it is the already-written v2.5 exit criterion.)
6. **`business_accounts` widget:** migrate to Atlas now or record a permanent exemption? (Recommended: exempt for v2.5; fold into a later UI-1.x pass.)
7. **Marketing/platform primitive posture:** ratify "marketing tree is token-aligned but primitive-free by design"?
8. **Consent grandfathering:** stamp existing users on next login, or beta-cohort-only registration stamping?
9. **AI-5 lane timing:** start the AI5-0…3 worktree lane now in parallel, or hold until Lane 2 lands B-S3? (Recommended: start AI5-0/1 now — they are test-and-semantics work with almost no collision surface.)
10. **Eight-failure corpus:** does the 2026-07 testing-session transcript still exist off-repo? If yes, commit it; if no, AI5-0 re-elicits it.

---

## What I would do next if this were my repository

In order, with reasoning:

1. **ST-0: STATUS.md truth-up (half a day).** Everything else compounds on top of an honest ledger. The repo has now drifted twice in 48 hours despite a dedicated drift-correction pass and a CI tripwire; the drift is currently *dangerous* (it says the beta gate doesn't exist — someone could re-plan and rebuild it). While in there, wire the drift-guard to fail (not advise) on migration-bearing PRs without STATUS diffs.
2. **C-S1 + C-S2: consent capture + LLM disclosure completion (one day).** Smallest code closing the largest strategic gate (external beta). One additive migration, one checkbox, links on the auth pages, two content edits, one founder decision on retention wording.
3. **C-S3: ops floor + config flips (one day, mostly ops).** Flip `registration_mode=invite_only` **first** — it is one action and the gate is currently open by default. Then Sentry at the documented init point, an uptime monitor, the backup drill writeup, Turnstile keys, and the Plaid-production decision. After this, inviting the first user is safe. Beta unlocks Receipt Intelligence's demand gate and starts producing the real-usage signal every parked idea is waiting for.
4. **A1-S1 + A1-S2: count swaps + invariant test (half a day).** Fixes a live user-facing bug (Space cards showing 0 accounts), removes 7 of the legacy read sites, and locks the door behind itself. No DB gate needed.
5. **B-S1: projection convergence (one day).** Delete the four dead folds, single-site the clamp, name the three nets, re-home Summary's headline onto `aggregateDayFacts`. This is mostly deletion — the highest-value kind of change — and it makes B-S2's oracle unambiguous about what it is pinning.
6. **B-S3: classifier v3 + evidence-stamp decoupling + recorded backfill (one-two days).** The one genuine financial-correctness hole found in this investigation (liability payment-app outflows invisible to the economic axis). Do it before AI-5 writes any figure-adjacent tests and before beta users see Cash Flow.
7. **B-S2: doctrine oracle + the four gap tests (one day).** With B-S1/B-S3 landed, the financial constitution pins the converged, corrected semantics rather than the transitional ones.
8. **A1-S3 + A1-S4: prod gate run, then dual-arm removal (one day if gates are clean).** Closes the v2.5 legacy exit criterion. Doing it after B-S3 means the AI assembler is touched once for arms and once for currency (B-S4 can ride in the same PR window).
9. **A2-S1: sibling relocation in a worktree (one-two days).** Byte-identical mechanical move; then **A2-S2** (PerspectiveWorkspace) closes the decomposition criterion. Kept late deliberately: it conflicts with nothing above and benefits from a quiet host file.
10. **AI5-0 + AI5-1 in a parallel worktree (start alongside items 5–9).** Reconstruct the failure corpus, ratify the state contract, land the window-characterization suite and the "since <year>" fix under the bounds-not-dollars rule. This is the highest-leverage AI-5 work precisely because it is test-and-semantics only — it de-risks WS-1's design before any migration exists, and it retires the last v2.4.5 test-debt item as a side effect.

Why this sequence beats the alternatives: it front-loads the two things only the founder can unblock (beta config, retention wording) and the one live user-facing bug; it does deletion before construction (B-S1 before B-S2; STATUS before planning); it touches the two merge-hot files (`transactions.ts` assembler, chat route) in one coordinated window instead of three; it keeps every destructive or meaning-changing step behind a recorded gate (prod counts, version-gated backfill, shadow windows); and it gets AI-5 learning started weeks earlier without letting it build on semantics that items 5–7 are about to change. Strict milestone order (Option 1) would spend the first two weeks on shell refactoring while the beta gate sat open in production and the STATUS ledger kept promising work that is already done.

---

*Investigation artifacts: seven parallel deep-scans over the working tree at `e74046e`; git evidence gathered from the local repository (log, status, migrations, tag list). Items marked NEEDS RUNTIME/DB VERIFICATION cannot be confirmed from source alone and are collected in §11's third column.*
