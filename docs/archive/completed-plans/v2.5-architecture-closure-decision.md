# V25 — Architecture Closure Investigation

**Status:** INVESTIGATION ONLY. No code modified.
**Date:** 2026-07-20.
**Baseline:** `feature/v2.5-spaces-completion` @ `6490975`, 638 commits past `v2.4.5`. 314/314 tests, lint exit 0, `tsc --noEmit` clean. 137 source-scanning guard files.
**Question:** can we honestly declare *"v2.5 Architecture Complete"* and move the remainder into UX-CLOSE / V25-CLOSE-3 / V25-CLOSE-4 / Beta Readiness?

---

## Verdict

# A) v2.5 Architecture Complete

**The foundation is finished.** Measured against the v2.5 thesis — *"one authoritative model, one semantic layer, one aggregation path, many consumers"* — the thesis is **true**, and true in the strong sense: it is enforced by tests rather than upheld by convention.

This is a close call in exactly one place, and the honest way to declare A is to name it rather than let it be discovered later:

> **One ingestion path writes flow classification without the classifier.** `lib/crypto/btc-sync.ts:243-289` hand-writes `flowType`, `flowDirection`, `category`, and `classificationReason`, and never calls `classifyFlow`. It is a live route (`app/api/accounts/wallet/route.ts:150,217,295`).

I classify this as **architecture complete, convergence outstanding** rather than architecture incomplete. The reasoning is in §1.2 and the counter-argument is stated there too — a reviewer who weights it differently would land on B, and that disagreement is legitimate. What decides it for me: the *foundation* (one classifier, one FlowType vocabulary, one fold) exists and works; btc-sync is a **consumer bypassing an authority that exists**, not a missing authority. That is a convergence slice, not a foundational one.

**One condition makes the declaration honest:** the btc-sync exception is currently fenced by *comments* and an audit script, not by a *test*. Its sibling concern — the position dual-write — is properly test-fenced at `lib/crypto/wallet-position-capture.test.ts:82-89`. Classification has no equivalent. **Fencing the exception is a ~1-hour guard, not a refactor**, and it converts "we remember there is one exception" into "a second exception cannot appear unnoticed." That belongs in V25-CLOSE-3.

---

## 1. Authority Audit

| # | Concept | Verdict | Basis |
|---|---|---|---|
| 1 | Cash-flow aggregation | **GREEN** | DayFacts is the sole fold |
| 2 | Transaction classification | **RED→ see §1.2** | second live writer (btc-sync) |
| 3 | Net worth / wealth | **YELLOW** | one authority, two re-derivations |
| 4 | Investment valuation | **GREEN** | one pure core, one DB binding |
| 5 | Liquidity | **GREEN** | one computation, spliced not duplicated |
| 5b | Debt | **YELLOW** | dual by design, convention-fenced |
| 6 | Time-window resolution | **GREEN** | one reducer, render-level guard |
| 7 | Balance / freshness | **GREEN** | one derivation, min-freshness rule |
| 8 | Visibility | **GREEN** | one predicate, parity-guarded (V25-CLOSE-2) |

### 1.1 The GREENs, briefly

**Cash flow.** `foldEconomicRow` / `clampEconomicSpend` (`lib/transactions/cash-flow.ts:282,290`) are the only economic primitives; every aggregate delegates. The authority test does real reconciliation — Summary == Σ History == Σ Calendar across income, refunds, over-refund clamp, debt payments, transfers, multi-month (`cash-flow-fold-authority.test.ts:80-148`) — not merely duplicated formulas agreeing. Per-category clamping vs global clamping is a genuine divergence risk and is pinned (`cash-flow-projection.test.ts:161-165`).

*Caveat:* the source-scan half of that guard is pinned to **three hardcoded filenames**. A new widget folding transactions independently would trip nothing. No current component does — the components importing flow predicates use them for row selection in drill slices, never accumulation. Worth broadening to a repo-wide rule; not a blocker.

**Investment valuation.** `valuation-core.ts` is the pure math with exactly one DB binding. `current-positions.ts:1-14` documents itself as "A10-at-today" and states it "computes no value, price, FX, cash, or completeness math of its own."

**Time.** `lib/perspectives/time-range.ts` is the sole reducer. The exclusivity guard is unusually strong: it *renders* `PerspectiveShell` across all five perspectives and asserts the deleted legacy selectors cannot return (`timeline-lens-exclusivity.test.ts:37,60-70`). The one other piece of mutable time state, `cashFlowExplicitPeriod` (`SpaceDashboard.tsx:381`), is a Cash-Flow-local drill to an explicit calendar period the relative model cannot express, set only from the one lens and cleared on any relative re-selection. Documented, not a second authority.

**Visibility.** One fail-closed predicate, now enforced by `lib/visibility-resolver-parity.test.ts` (V25-CLOSE-2): four constraints per resolver, single expression of the tier, predicate pinned, enrolment fails closed.

### 1.2 Classification — the one that decides the verdict

**The facts, verified directly.** `lib/crypto/btc-sync.ts` never imports `flow-classifier`. `buildTransactionRow` (`:243-289`) assigns:

- `flowType` cast from the explorer's own enum (`lib/crypto/btc-explorer.ts:360,376,386`)
- `category` from its own `FLOW_TO_CATEGORY` map (`:207-213`)
- `classificationReason` from its own three-branch mapping (`:253-255`)
- its own INTERNAL-transfer reclassification (`:263-267`)
- **no `classifierVersion`** → NULL

**Two systems can disagree.** If `classifyFlow`'s transfer detection improves, BTC rows do not receive it, and `lib/transactions/flow-desync-invariant.test.ts` would not notice — it exercises `classifyFlow` only.

**Why this is nonetheless *complete-with-convergence-outstanding*, not *incomplete*:**

1. **The system already names it.** `flow-classifier.ts:88-101` states that `classifierVersion` "records WHICH AUTHORITY produced a row's persisted flow facts" and that NULL "does **not** mean 'an old classifier wrote this, safe to recompute'." `scripts/audit-flow-desync.ts:39` defines a row class literally called **FOREIGN-AUTHORITY**. This is a recognised boundary, not an undiscovered one.
2. **It is tooled.** `scripts/backfill-flowtype.ts:87-108` added `--only-version=N` specifically so a version migration targets an exact version rather than sweeping NULLs — citing the concrete near-miss where recomputing btc-sync's rows "would have retired an unknown-inflow honesty signal … and raised confidence 0.5 → 1.0 on a circular derivation."
3. **The inputs genuinely differ.** On-chain transactions have no PFC, no merchant descriptor, no counterparty name. `classifyFlow`'s evidence ladder has nothing to stand on; a crypto path would be passing `undefined` for most of its inputs.
4. **The population is bounded** (~25 rows) and the fix is a contained slice.

**The counter-argument, stated fairly.** v2.5's whole method has been *"make the invariant enforced, not remembered."* Classification is now the only major authority whose exception is comment-fenced. A reviewer who holds that standard strictly would call this B. I weight it as A because the missing artefact is a *guard over a known exception*, not a *missing authority* — and because the exception is documented in three independent places that a maintainer would actually hit.

### 1.3 The YELLOWs

**Net worth.** `classifyAccounts` (`lib/account-classifier.ts:251`) is the authority. Two sites re-derive the same arithmetic instead of reading `c.netWorth`: `lib/snapshots/regenerate.ts:126-134` and `lib/snapshots/backfill-core.ts:325`. Numerically identical today and fed from the same buckets, so they cannot disagree on inputs — but **a new bucket added to `classifyAccounts` lands in `netWorth` and not in these two.** No guard pins them. `regenerate.ts:23-33` records that this formula already silently diverged once (realAssets missing). Cheap, high-value pin.

**Debt.** Dual by design and honestly so: `lib/debt-space-data.ts:24-30` states the lens may see `DebtProfile` terms the client array lacks, "so the two can legitimately disagree," and keeps the lens **prose-only** while every visible number comes from `computeDebtKpis`. Enforced, not merely intended (`DebtWorkspace.test.ts:94-107` asserts the lede reads only `lens.verdict`). YELLOW rather than GREEN because the disagreement can still surface as prose contradicting figures.

---

## 2. Legacy Surface Audit

**No active v1/v2 competing path exists.** Every candidate resolved to *retired*, *documented shim*, or *dead export*.

| Surface | Finding |
|---|---|
| Legacy `Account` model | **Physically gone.** Migration `20260716120000_retire_legacy_account_model` drops the table, both FK columns, 5 indexes. Zero `db.account.*` reads. Tripwire at `lib/account-count-canonical-invariants.test.ts:59-60` |
| Old transaction loaders | **Not legacy.** `getTransactions` and `queryTransactions` are complementary; `transaction-query.ts:1-19` *composes* the shared authorities (`bankingTransactionWhere`, `transactionListInclude`, `projectTransactionListRows`) imported from `lib/data/transactions.ts`. Same population predicate ⇒ cannot disagree |
| Old investment readers | One **documented, dated shim** (`legacy-crypto-holdings.ts`, header marks "DELETE at P2-6", names its deletion trigger, guarded by `lib/export/holdings.test.ts`) + one **dead export** (`getHoldings`, `lib/data/accounts.ts:238`, zero callers) |
| Old time controls | **Deleted**; return blocked by render-level guard |
| Old workspace composition | **Retired.** `renderHero` exists only in comments and its own removal test; `SpaceSections.tsx` split into `SectionRegistry` + `SectionCard`; `LEGACY_TAB_PERSPECTIVE` is a dead export |

Dead exports (`getHoldings`, `legacyTabPerspective`) are **cleanup, not architecture** — they cannot be chosen accidentally because nothing routes to them.

**Hygiene finding:** 21 untracked `.fuse_hidden*` orphan files in `components/charts/` and `components/dashboard/`. Not compiled (no extension), not tracked (`git ls-files` → 0). Harmless to the build, but they contain stale code — one holds an old `netWorth: totalNonDebt - debt` — and they **pollute source audits**; they briefly misled this investigation. Delete them.

---

## 3. Space / Workspace Architecture

**Verdict: the Space *frame* is universal; the Space *runtime* is per-domain. That is a boundary, not a gap — but the honest claim is narrower than "universal application container."**

**What is genuinely complete — identity and frame:**

- **One registry, four domain-owned modules**, composed at `lib/perspectives.ts:534-544` from `STANDARD_WORKSPACES + PERSPECTIVE_LIBRARY + PLATFORM_WORKSPACES + CONNECTIONS_WORKSPACES + SETTINGS_WORKSPACES`. Dependency direction is clean and cycle-free (domain modules import `WorkspaceDefinition` type-only). Disjointness enforced per-domain by namespace prefix.
- **`WorkspaceDefinition` requires only `id`, `label`, `icon`, `kind`** (`lib/perspectives.ts:153-195`); everything finance-flavoured is optional behind a `domain` discriminator.
- **`SpaceShell` is 164 lines and provably finance-free** — `components/space/shell/space-shell.test.ts:87-98` bans 17 strings from its source including `@/lib/money`, `formatCurrency`, `convertMoney`, and every workspace component name.
- **`TimelineLens` is optional**, proven by three production hosts that render no time control.
- **Proof by existence:** Platform (8 workspaces), Settings (5), Connections (1) all mount the shared `SpaceShell` in production. Settings is the strongest evidence — a 70-line *layout* file with zero data ownership.

**What remains finance-shaped — orchestration and render dispatch:**

- `WorkspaceDataNeed` (`lib/perspectives.ts:67-75`) is a **closed union of eight finance tokens**, and the domain tests actively *forbid* non-finance workspaces from declaring any.
- `lib/space/workspace-resources.ts` advertises domain-agnostic orchestration but has **one consumer** (`SpaceDashboard.tsx:25`).
- `WorkspaceRenderCtx` (`workspaceRenderers.tsx:42-93`) is a finance bag (accounts, snapshots, transactions, asOf, lensResults, ficoScore…).
- Each non-finance domain supplies its own widget registry and body loop (~60–260 LOC).

**Could a new product area be built?** Yes — and Growth and Customer Success already exist (`lib/platform/workspaces.ts:135-140`). A new area gets identity, registry membership, guard coverage, the frame, rail, responsive behaviour, and chrome publication for free; it writes a workspaces module, a composition root, widgets, and a test file. **Nothing must be forked to be identified or framed.** The widget registry must be forked if not adopting an existing host wholesale.

**Classification: YELLOW — product evolution, not architecture incomplete.** The runtime boundary is explicit, guard-tested per domain, and three domains ship on it. Generalising `WorkspaceDataNeed` and the renderer lookup is a v2.6+ improvement that a fifth domain would justify; it is not a foundation the current product is missing.

---

## 4. Intelligence Boundary

**Verdict: GREEN. v2.6 intelligence can be added without destabilising financial semantics.**

Verified directly:

- **Dependency direction is correct.** `lib/ai/` imports *downward* into financial authorities (`lib/transactions/flow-predicates`, `lib/money/convert`, `lib/investments/*`). No financial module imports AI intelligence, assemblers, prompts, or the validator.
- **The one reverse edge is a single misfiled file.** Every non-AI import from `lib/ai/` is `lib/ai/visibility` — 13 production files. That module is **67 lines and imports only `VisibilityLevel` from `@prisma/client`**. It contains zero AI code.
- **Therefore this is placement, not inversion.** It creates no cycle and no coupling. The only failure mode is cognitive — an engineer might not look in the AI namespace for the privacy predicate — and that is already mitigated structurally: `lib/visibility-resolver-parity.test.ts` fails the build with a message naming the canonical import, and hardcoded-literal gating is banned repo-wide.
- Moving it to `lib/visibility.ts` is ~20 lines of import churn with zero behaviour change. **Worth doing; not a blocker.**
- **Conversation state is genuinely absent** (no `Conversation` model, no `conversationId` anywhere) and **purely additive** — new model + route read/update. It touches no financial code.

---

## 5. Provider Expansion Readiness

**Verdict: GREEN for architecture; remaining items are naming and deferred design.**

- **`persistAccountSpine` is genuinely provider-neutral and proven by two real providers.** Plaid (`lib/plaid/exchangeToken.ts:339`) and the crypto wallet (`app/api/accounts/wallet/route.ts:272`) share one writer despite different atomicity models — the wallet passes its own transaction so FinancialAccount + spine commit together, Plaid lets the writer open its own. That is the second-implementation proof the doctrine asks for.
- **One Plaid-shaped leak**: `plaidItemDbId?: string | null` (`persist-account-spine.ts:46`) — optional, nullable, omitted by the wallet caller. Mechanical rename across two call sites.
- **A provider-neutral `Connection` model exists** (`prisma/schema.prisma:719`) with `ProviderType` covering six values; the schema comment states it exists "so future, non-Plaid providers have a home that isn't shaped like Plaid." `PlaidItem` remains in parallel carrying Plaid-only sync machinery — correct, not duplicate.
- **Ingestion is already provider-neutral in substance.** `lib/transactions/plaid-flow-input.ts` is **misnamed**: Prisma-free, structurally typed, and consumed by CSV import (`app/api/accounts/[id]/import/route.ts:137`). The classifier takes PFC fields as *optional* hints (`flow-classifier.ts:170-172`).
- **Would the financial spine change for a second provider?** Essentially no. One leaf exception: `lib/snapshots/regenerate.ts:77` carries a Plaid-shaped consent filter — additive to extend.
- **`lib/providers/catalog.ts` has zero importers** — a nominally-populated directory, dead code.
- **PROV-6 (`ProviderIngestionPayload`) is correctly deferred.** Writing it now with one real ingesting provider is the speculative abstraction the plan explicitly rejects — and the deleted `plaidAdapter` is evidence this project already paid that cost once.

---

## 6. Security / Privacy Architecture

**Verdict: GREEN architecturally. Every gap found is coverage, not design.**

- **One fail-closed visibility predicate**, `SHARED` deliberately excluded with reasoning recorded; `grantsAccountDetail` delegates to `grantsTransactionDetail` so they cannot drift.
- **Authorization is layered, not bypassed.** Three guards (`lib/session.ts`, `lib/spaces/authorize.ts`, `lib/platform/authorize.ts`) all funnel through `resolveUser()`; `requireSpaceAction` composes on `requireUser`. Every `app/api/**/route.ts` lacking a guard import resolved to a legitimate pattern (public by design, cron-secret-guarded, delegated, or provider callback). **No bypass found.** One incomplete migration: `requireSpaceRole` (18 routes) → `requireSpaceAction` (9) — incomplete, not incorrect.
- **Admin TOTP model is sound and unusually well-reasoned.** `decideAdminApiAccess` is pure, role-before-enrolment is deliberate, and there is **no opt-out parameter by design**. The proxy/session *pairing* is documented in both directions, and the header records the real deadlock that produced it.
- **`proxy.ts` gates page navigations only and says so** (`:26-31`). Previously-dead branches that "read as if this file protected the enrolment API" were found and removed. Correctly understood as routing/UX, not a security boundary.

**The one finding that is trending wrong — verified and worse than first reported:**

> `lib/audit.ts` was written to be the audit-write authority. **`recordAuditEvent` has ZERO production callers.** `buildAuditData` has exactly one importer (`lib/auth.ts:29`). Meanwhile there are **83 direct `db.auditLog.create` sites**.

This is the project's own recorded anti-pattern — *"never ship an authority without a clear consumer"* (TX-3) — recurring. It is **not architecture-incomplete today**: audit rows are records, not computed facts, so there is no "two systems disagree about a number" failure. There is exactly one de-facto pattern in use plus one unadopted helper. But it is **architectural by attrition** if new code keeps choosing the raw call. Either adopt it or delete it — and a guard is cheap now, expensive after another 15 sites.

**Four (not three) `app/api/admin/plaid/*` routes have zero audit writes and no fresh-access check** — `diagnostics`, `exchange-expanded-history-token`, `expand-history-token`, `retire-superseded-item`. These mutate real state (retiring a PlaidItem; exchanging a credential) under a cached session that may be up to 30s post-revocation. **Beta readiness, not architecture**: the stronger guard (`requireFreshSystemAdmin`), the audit authority, and the enforcement-test pattern (`lib/platform/beta-ops-guards.test.ts:39`) all already exist and are applied to comparable routes. This is a retrofit against an existing standard.

---

## 7. Data Evolution

**Verdict: YELLOW. Nothing RED. The evolution discipline is above average and has already survived three classifier version bumps — but one specific ceiling exists.**

**Strong:**
- **50 models, no schema drift**, `Account` physically dropped with no shim or compatibility view. The parallel position layers (`Holding` / `PositionObservation` / `InvestmentEvent` / `PositionReconstruction`) are a *staged, flag-gated* migration with the layering documented in-schema, not abandoned experiments.
- **77 migrations, strictly linear, no rollbacks.** Apparent duplicates are legitimate two-phase enum splits that self-document why (PostgreSQL `ALTER TYPE … ADD VALUE` transaction rules).
- **`DATABASE_SAFETY_PROTOCOL.md` names the actual incident** that produced it and mandates `db:migrate:safe` = backup + `migrate deploy`.
- **Backfills follow one repeatable contract**, not bespoke one-offs: pure planner in `lib/` + thin script, **dry-run by default with `--apply` required**, idempotent, version-gated. Six version-gated backfills plus wired-in audit scripts.
- **Version stamps are pervasive**: `classifierVersion`, `tiFactsVersion`, `transferEvidenceVersion`, `reconstructionVersion`, `mapperVersion`.

**The ceiling — and it is specific:**

1. **`SpaceSnapshot` has no rule-version stamp.** It carries `isEstimated`, `reportingCurrency`, `amendedByAmendmentId` — but no `snapshotVersion`. You cannot ask *"which rows were computed by formula vN?"* This is the one place the otherwise-excellent versioning discipline was not applied, and `regenerate.ts:23-33` records that this formula **already silently diverged once** (realAssets missing). **Highest-leverage single fix in the repo.**
2. **No bulk-replay path for snapshot semantics.** `regenerate-history.core.ts:127-130` freezes observed (`isEstimated=false`) rows against the automatic pipeline; the only override is `SnapshotAmendment` — consent-gated, per-account, PERSONAL-space-only. Change the formula and observed history keeps the old semantics indefinitely. The amendment machinery is ~90% of what a "formula migration" mode needs.
3. **NULL `classifierVersion` is overloaded** across btc-sync-authored rows and never-classified seed rows. Documented and mitigated by `--only-version`, but an `authoredBy` discriminator would make it structurally safe rather than comment-safe. *(Same root cause as §1.2.)*

Recomputation itself is sound: `regenerate-history.core.ts` is pure, total, deterministic, and idempotent by construction. The constraint is the **freeze guard and the missing version predicate**, not an inability to recompute.

---

## 8. Classification of Remaining Work

### Architecture incomplete
**Empty.** No item found prevents declaring v2.5 architecture complete.

*The nearest miss* — btc-sync as a second classification writer (§1.2) — is classified as convergence, with the guard that makes the declaration honest listed below.

### V25-CLOSE-3 — Honesty Polish (the closure conditions)
1. **Fence the classification exception.** A guard asserting `classifyFlow` is the only writer of persisted flow facts, with btc-sync as the single named exception. Converts remembered → enforced. *This is the condition on verdict A.*
2. **Decide `recordAuditEvent`: adopt or delete.** Zero callers vs 83 direct writes. Add a guard either way.
3. Pin `regenerate.ts:126-134` and `backfill-core.ts:325` to `classifyAccounts().netWorth`.
4. Broaden the cash-flow fold source-scan from three hardcoded filenames to a repo-wide rule.
5. FX rate-miss disclosure (`lib/money/convert.ts:59` — native amounts rendered as target currency behind only an `≈`).

### Beta readiness
1. Audit + fresh-access on the four `app/api/admin/plaid/*` routes.
2. LLM/provider disclosure + retention posture in `/legal/ai`.
3. Sentry, uptime monitor, backup-restore drill, `invite_only` verification, Turnstile keys, Plaid environment, Resend/domain.
4. Published support address.

### Product evolution (v2.6+ / UX-CLOSE / V25-CLOSE-4)
1. `SpaceSnapshot` version stamp + a formula-migration mode (§7 — highest leverage).
2. Conversation state / `conversationId`; `AiAdvice` write path; `context-priority` activation.
3. Generalise `WorkspaceDataNeed` + renderer lookup beyond finance (justified by a fifth domain).
4. PROV-6 ingestion payload — deferred by design until a third provider.
5. Template truthfulness (V25-CLOSE-4): hide templates whose lead lens doesn't render; picker descriptions; Debt/Liquidity empty states.
6. `comingSoon` lenses (tax / property / businessHealth).

### Cleanup (no classification needed)
Dead exports (`getHoldings`, `legacyTabPerspective`, `lib/providers/catalog.ts`); 21 `.fuse_hidden*` orphans; move `lib/ai/visibility.ts` → `lib/visibility.ts`; rename `plaid-flow-input.ts` and `plaidItemDbId`; burn down the 937 baselined palette violations.

---

## Closing note

The evidence that most supports verdict A is not any single GREEN — it is a property the security audit named precisely: **when you go looking for the "right" version of a pattern in this codebase, it is already there.** `requireFreshSystemAdmin`, `recordAuditEvent`, `requireSpaceAction`, `persistAccountSpine`, `valuation-core`, `beta-ops-guards.test.ts` — each exists, correctly shaped, before it is fully adopted. Architecture-incomplete codebases do not have that property; they are missing the pattern, not its adoption.

What v2.5 has left is **adoption debt, not design debt**. That is what "polish and readiness" means, and it is the right thing to move into UX-CLOSE, V25-CLOSE-3/4, and Beta Readiness.
