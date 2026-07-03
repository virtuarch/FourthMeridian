# Perspective Engine Foundation — Investigation & Implementation Checklist

**Status:** ✅ **IMPLEMENTED** (2026-07-03) — all nine commits landed per §7.5, approved one at a time.
Engine + Liquidity/Debt lenses + membership-gated batch route + library `lensId` wiring + widget result rendering + both dashboard hosts wired. See `lib/perspective-engine/README.md` for the living engineering reference; this document remains the decision record.
Implementation deltas from plan (both approved mid-flight): (1) the visibility-tier marker ships as `getAccountsWithVisibility()` returning `{ account, visibilityLevel }` pairs — tier beside, never on, the client-safe `Account` shape (§2.3's "no widening" held for APR fields but a tier seam was needed and was added as its own commit); (2) `availableBalance` is not exposed by the data layer, so the Liquidity cash tier uses reported balances with an explicit assumption instead.
**Date:** 2026-07-03 (investigated and implemented)
**Predecessor:** `docs/investigations/PERSPECTIVES_INVESTIGATION.md` (product definition: "a saved, scoped, answerable question about a defined set of money"). This document is the engineering foundation slice: deterministic, typed, **non-persistent**.
**Constraint acknowledgments:** no query engine, no LLM math, no persistence, no sharing, no cross-Space, no Opportunity Cost, no tax recommendations, visibility tiers enforced, everything deterministic and source-traceable.

---

## 1. Current-state inventory

### 1.1 Perspective presentation layer

| Piece | State | Relevant detail |
|---|---|---|
| `lib/perspectives.ts` | Static lens library, 10 entries | 4 `available` (routing only), 5 `comingSoon`, plus `overview`. No business logic by explicit design. Per-category ordering via `PERSPECTIVES_BY_CATEGORY`. `PerspectiveDef` = id/label/description/icon/status/group. |
| `PerspectivesWidget.tsx` | Pure presenter | Renders cards; `onSelect` present → clickable; absent → "Soon" badge, `opacity-80`, no click. Static `description` is the card body. |
| `PerspectiveSwitcher.tsx` | Placeholder dropdown | Reports selection; hosts keep `COMPOSITION_SWITCHING_ENABLED` false — Overview body never swaps. |
| `SpaceDashboard.tsx` | Consumer #1 | `PERSPECTIVE_TARGET_TAB` maps 4 lens ids → internal tabs, rendered in `GlassModal` via `PERSPECTIVE_ROUTED_TABS`. Grid on `PERSPECTIVES` tab; row on Overview. |
| `DashboardClient.tsx` | Consumer #2 (Personal) | Same pattern via `PERSONAL_PERSPECTIVE_TARGETS` (different tab vocabulary: `debt → "credit"`). Post-"v2.5 honesty slice": finances/documents placeholders already removed; `wealth`/`cashFlow` remain the visible `comingSoon` cards. |

Placeholder behavior today: a `comingSoon` card is inert copy. Nothing anywhere computes a financial answer for a Perspective.

### 1.2 Deterministic data sources (what the engine can stand on)

**Accounts.** `FinancialAccount` is canonical (KD-19 complete): balance, `availableBalance`, `creditLimit`, `type` (checking/savings/investment/crypto/debt/other), debt flat fields + `DebtProfile` 1:1 (apr, minimumPayment, dueDay, statementCloseDay, promoAprEndDate), `balanceLastUpdatedAt` provenance, soft-delete. Read path: **`lib/data/accounts.ts#getAccounts()`** — already SpaceAccountLink-only, `status: ACTIVE`, visibility-enforced via `grantsAccountDetail` + `sanitizeForBalanceOnly` (KD-19). This is the single most important finding: **a visibility-safe, seam-correct account read already exists and is the same one the AI assemblers' rules mirror.**

**Classification & math.** `lib/account-classifier.ts#classifyAccounts()` — the declared single source of truth for liquid/investments/digitalAssets/realAssets/liabilities/netWorth. `lib/debt.ts#estimateMinimumPayment()` — pure, deterministic, self-labeling as an estimate. `lib/snapshots/regenerate.ts` keeps `SpaceSnapshot` aligned with `classifyAccounts`.

**Snapshots.** `SpaceSnapshot` (daily, `[spaceId, date]` unique): netWorth, totalAssets, cash, savings, debt, netLiquid, cashOnHand. Category-level only — supports trend, not per-account attribution.

**Transactions.** Dual-anchor (`accountId` legacy / `financialAccountId` canonical), `pending` boolean, **no flowType / settlement semantics** (that is v2.5.5 G12). The AI transactions assembler does income/spend partitioning via category heuristics — explicitly AI-context-grade, caveated, not verdict-grade.

**Holdings.** Dual-anchor like transactions (legacy `Account` rows still exist; `lib/data/accounts.ts#getHoldings()` normalizes both). `lib/ai/assemblers/holdings.ts` already computes deterministic concentration metrics with strict FULL-only position exposure.

**Goals / credit.** `SpaceGoal` (no RETIREMENT category — retirement is preset-driven UI, not a data model), `CreditScore` time series, `DebtProfile` as above.

**AI assemblers as the pattern to mirror.** `lib/ai/assembler-registry.ts` + `lib/ai/assemblers/*`: pure async server-only functions `(SpaceContext, options) → typed section | null`, registered per domain, Space-scoped, no decrypt imports, visibility rules documented per assembler, `scopeHint: 'full' | 'brief'`. The accounts assembler already implements exactly the redaction ladder a Perspective needs (FULL = everything; BALANCE_ONLY = generic name + balance; knowledge gaps FULL-only *because emitting a gap reveals a debt account's existence*). The Perspective Engine should be this pattern's sibling, not a new invention.

**Visibility predicates.** `lib/ai/visibility.ts` (KD-1/KD-19): `grantsTransactionDetail` / `grantsAccountDetail`, FULL-only, fails closed, SHARED legacy excluded. One source of truth shared by data layer and AI.

**Testing convention.** No jest/vitest. Tests are standalone `npx tsx` scripts exiting 0/1 (`lib/space-nav.test.ts`, `lib/ai/output-validator.test.ts`, `lib/data/transactions.privacy.test.ts`, `lib/ai/assemblers/transactions.privacy.test.ts`). The privacy-proof pattern (fixture accounts across visibility tiers, assert redaction) already exists to copy.

**Hygiene note (pre-existing, not this work):** committed Finder-duplicate dirs `lib/ai/assemblers 2/`, `lib/ai/signals 2/`, `app/api/spaces/[id] 2/` etc. — same KD-13 class flagged in the v2.5 polish investigation.

---

## 2. Recommended Perspective Engine design

### 2.1 Placement and naming

New directory **`lib/perspective-engine/`** — *not* `lib/perspectives/`, which would collide with module resolution of the existing `@/lib/perspectives` (`lib/perspectives.ts`). The presentation library stays where it is; the engine is a separate, server-only layer.

```
lib/perspective-engine/
  types.ts        — contracts (below)
  registry.ts     — lens registration, mirrors assembler-registry.ts
  index.ts        — computePerspective(lensId, scope), computePerspectives(scope)
  lenses/
    liquidity.ts
    debt.ts
  *.test.ts       — standalone tsx tests per lens + privacy proofs
```

### 2.2 Contracts (proposed shape — for review, not implementation)

```ts
// types.ts — all serialisable, no Date instances (lib/data convention)

export type LensId = "liquidity" | "debt";            // grows deliberately

/** v1 scope: exactly one Space, resolved membership. No cross-Space. */
export interface PerspectiveScope {
  spaceId: string;
  userId:  string;      // the viewing member — drives visibility, resolved by caller
}

export type LensStatus = "ok" | "empty" | "error";

export interface LensMetric {
  id:      string;
  label:   string;
  value:   number | string;
  format:  "currency" | "percent" | "count" | "text" | "date";
  tone?:   "neutral" | "positive" | "warning" | "danger";   // reuse BriefTone vocabulary
  /** True when the value is an estimate/heuristic — must render labeled. */
  estimated?: boolean;
}

export interface LensAssumption {
  id:     string;
  text:   string;                       // human sentence, deterministic
  source: "default" | "user" | "provider" | "estimate";
}

export interface LensProvenance {
  /** FinancialAccount ids that contributed. Ids only — never names here. */
  accountIds:   string[];
  /** Counts per visibility tier, so the UI can say "3 accounts (1 balance-only)". */
  tierCounts:   { full: number; balanceOnly: number; summaryOnly: number };
  /** Oldest balanceLastUpdatedAt ?? lastUpdated among inputs (ISO). */
  dataAsOf:     string | null;
  /** What was deliberately withheld, phrased tier-safely (see §7). */
  redactions:   string[];               // e.g. "Rate detail withheld for 1 shared account"
}

export interface LensResult {
  lensId:      LensId;
  /** Bump when a lens's math changes — future saved Perspectives and AI
   *  consumers key caching/trust off this. */
  lensVersion: number;
  scope:       PerspectiveScope;
  computedAt:  string;                  // injected clock (determinism in tests)
  status:      LensStatus;
  /** One deterministic sentence, template-built from metrics. Never includes
   *  account/institution names. Absent when status !== "ok". */
  verdict?:    string;
  /** The single number the card leads with. */
  headline?:   LensMetric;
  metrics:     LensMetric[];
  assumptions: LensAssumption[];
  provenance:  LensProvenance;
  /** status === "empty": safe copy, follows space-presets emptyHeadline convention. */
  empty?:      { headline: string; subline: string };
  /** status === "error": category only — never raw error text with account data. */
  error?:      { code: "DATA_UNAVAILABLE" | "COMPUTE_FAILED" };
}

export type LensFn = (scope: PerspectiveScope) => Promise<LensResult>;
```

Contract rules, enforced by tests: verdicts are template strings over already-computed metrics (no free text, no names); `computedAt` is injectable; every non-`ok` status still returns a fully-shaped, render-safe object; a lens never throws to the caller (`COMPUTE_FAILED` instead).

### 2.3 Data-access rule (the core privacy decision)

**Lenses do not query Prisma directly in v1. They consume `lib/data/accounts.ts#getAccounts()` output** (plus, where FULL-tier detail is needed, the same DebtProfile resolution rules the accounts assembler documents). Rationale: `getAccounts()` already enforces KD-19 redaction (`sanitizeForBalanceOnly`, `grantsAccountDetail`), already reads exclusively via SpaceAccountLink (seam-correct), and is the same data every dashboard total renders — so a Perspective can never disagree with the dashboard it sits on, and can never see what the viewing member cannot. The engine inherits its privacy proof instead of writing a new one.

**Verified:** `getAccounts()` already returns everything the Debt lens needs — effective APR (`profile.apr ?? interestRate`), minimum payment with `minimumPaymentIsEstimated` flag (via `estimateMinimumPayment`), `creditLimit`, and the `debtProfile` sub-object (lib/data/accounts.ts:133–179). **No widening of any existing file's data shape is required for slice 1.** The engine consumes the existing shape untouched.

### 2.4 Consumption path

One new membership-gated route, batch-shaped to avoid N fetch waterfalls:

```
GET /api/spaces/[id]/perspectives   →  { results: LensResult[] }
```

Auth/membership mirrors the existing `activity` route. Hosts fetch once and pass results into `PerspectivesWidget` items. Engine functions remain directly importable server-side — that is the future seam for Daily Brief, D4 assemblers, and Meridian Analyst (they call `computePerspective()`, not the route).

### 2.5 Presentation wiring (surgical, no redesign)

- `lib/perspectives.ts`: additive fields on `PerspectiveDef` — `lensId?: LensId`; add one new library entry `liquidity` (group "Financial", status "available"), added to a conservative set of categories (PERSONAL, HOUSEHOLD, FAMILY, EMERGENCY_FUND, BUSINESS). `debt` entry gains `lensId: "debt"`.
- `PerspectivesWidget.tsx`: `PerspectiveCardItem` gains optional `result?: LensResult`. When present: render verdict in place of the static description, headline metric, "as of" from provenance, and drop the "Soon" badge logic for that card. When absent: exactly today's rendering. Pure-presenter property preserved.
- Hosts: fetch results, attach by `lensId`. Debt card keeps its existing `onSelect` (modal to the real tab) — answer on the card, detail behind the click. Liquidity card v1 is answer-on-card only (no new modal surface; a detail view is a later slice).

`comingSoon` cards without a lens are untouched. No Space Dashboard layout, rail, or tab changes.

---

## 3. Lens feasibility matrix

| Lens | Classification | Basis |
|---|---|---|
| **Liquidity** | **Safe now** | Pure function of `getAccounts()` balances + types. Tiering: cash (checking+savings, prefer `availableBalance`), marketable (investment+crypto, sale/settlement assumption stated), illiquid (realAssets/`other`), plus available credit (FULL-tier `creditLimit − balance` only). No transactions, no holdings, no dual-anchor exposure. Assumptions contract carries the caveats (AccountType cannot distinguish retirement-wrapped investment accounts → stated as an assumption, and marketable tier is labeled "before any tax or penalty"). |
| **Debt** | **Safe now** | Balances via `getAccounts()`; APR/min-payment via DebtProfile→flat-field resolution already specified in the accounts assembler; `estimateMinimumPayment` for gaps (labeled). Blended APR + monthly interest accrual are arithmetic. Rate metadata FULL-only; BALANCE_ONLY debt contributes balance to totals only. Promo-expiry metric from `promoAprEndDate`. |
| **Net Worth (attribution)** | Safe now (trend), **recommended next slice, not this one** | `SpaceSnapshot` gives deterministic trend today; attribution is category-level only (snapshot granularity). Deferred from slice 1 because it duplicates the Overview KPI until attribution copy is designed — low marginal user value per foundation slice, and it would power the `wealth` card, which deserves its own review. |
| **Cash Flow** | **Blocked by v2.5.5 flowType** | Verdict-grade income/spend requires settlement + flow semantics (G12). The transactions assembler's category-heuristic partition is AI-context-grade by its own documentation. A Perspective verdict ("you spent $X against $Y income") built on heuristics fails the determinism/correctness bar. Also touches dual-anchor Transaction reads. |
| **Investments (exposure/concentration)** | **Safe later** | Deterministic math already exists (`holdings assembler`: concentration, Herfindahl, FULL-only positions) and could be mirrored — but Holding rows are mid-D11 dual-anchor migration, and duplicating the assembler's math into a lens invites drift. Do after either extracting a shared holdings-math module or after Holding's legacy anchor retires. Not blocked, just not smallest. |
| **Retirement** | **Blocked by missing data** (and correctness posture) | No retirement-account distinction in `AccountType`, no `SpaceGoal` retirement category, no assumptions-management surface. Any projection without adjustable, surfaced assumptions violates the predecessor investigation's advisor constraints. Needs the assumptions contract to mature in shipped lenses first. |

Nothing in the candidate set is blocked by dashboard redesign or by persistence — the contracts above deliberately don't need either.

**Recommended first slice: Liquidity + Debt only.** Both are pure functions of the already-redacted account read; neither touches transactions, holdings, snapshots, or any dual-anchor model; together they exercise every contract feature (assumptions, estimates, redactions, empty state, FULL-vs-BALANCE_ONLY divergence) — so the foundation is proven by two lenses that cannot collide with v2.5-A.

Example verdicts (template-built, name-free):
- Liquidity: `"About $18,400 is available as cash now, and roughly $52,000 more could be raised by selling investments."`
- Debt: `"You carry $23,400 of debt across 4 accounts, accruing an estimated $310/month in interest at known rates."`

---

## 4. Integration strategy (non-conflict argument, per workstream)

**v2.5-A seam closure.** The engine reads only through `lib/data/accounts.ts`, which is already post-cutover (SpaceAccountLink-only, KD-19). It adds zero reads of `WorkspaceAccountShare` (retired) and zero reads of legacy `Account` — it cannot regress the count gates; it is a *consumer* of the seam closure, not a participant. Slice 1 deliberately excludes Transaction/Holding (the remaining dual-anchor models).

**Space Dashboard redesign.** Touch points are additive props on an existing pure presenter and a data fetch in each host. No tab, rail, modal, or layout changes. If the dashboard is redesigned later, `LensResult` is the stable contract the new surface consumes.

**Meridian Analyst.** Not implemented, not referenced. The engine's exports (`computePerspective`, serializable `LensResult` with provenance + lensVersion) are the interface a future Analyst consumes. Nothing in slice 1 imports AI code except the shared visibility predicates.

**AI context builder (D4).** No assembler registration in this slice. The engine mirrors the assembler pattern so a later, separate slice can expose lens outputs as a context domain (or feed Daily Brief `BriefItem`s) without rework. Direction of dependency: AI may later depend on the engine; the engine never depends on AI. LLMs never compute lens numbers — the engine has no provider imports, enforceable by a test that greps its module graph.

**Future saved Perspectives.** A saved Perspective will persist `(lensId, lensVersion, scope, params)` — never results. The contracts already carry all three. No schema now; when persistence is approved, it is a wrapper table plus re-computation, not an engine change.

---

## 5. Privacy and redaction inventory

Every leak surface identified, with the rule that closes it:

1. **Hidden balances (SUMMARY_ONLY).** SUMMARY_ONLY grants *qualitative* summary, no raw numbers. Rule: SUMMARY_ONLY accounts contribute to **no numeric aggregate** in any lens (stricter than BALANCE_ONLY); they appear only in `tierCounts.summaryOnly` and a redaction line. Fails closed like KD-1.
2. **Institution / account names.** Verdicts, metrics labels, assumptions, errors, and redaction strings are name-free by contract; provenance carries ids only. Generic labels (`genericAccountName`) are the only permitted name substitute if a later slice adds per-account breakdowns.
3. **Debt metadata (APR, limits, min payments).** FULL-only, mirroring the accounts assembler. BALANCE_ONLY debt → balance into totals, nothing else. `creditLimit`-derived available credit is FULL-only (the limit is an identifying/withheld field).
4. **"Knowledge gap"-style emissions.** Mirror the assembler's rationale: never emit a gap/assumption that reveals a non-FULL account's *type or existence* ("1 account has no APR on file" must only ever count FULL accounts).
5. **Holdings.** Slice 1 lenses never read Holding. Future Investments lens inherits the holdings assembler's FULL-only position rule.
6. **Transaction detail.** Not read in slice 1 at all.
7. **Aggregate inference.** v1 scope is single-Space, whole-Space — the same aggregate the member's own dashboard KPIs already show them, so no *new* inference surface is created. The dangerous case (differencing a filtered scope against the whole) arrives only with user-defined sub-scopes; flagged as a mandatory gate on the future scoped-Perspective slice, per the predecessor investigation §5.
8. **Error/empty leakage.** Error objects are enum codes only. Empty copy is static per lens ("No debt accounts in this Space yet"), never derived from withheld rows — an empty state must read identically whether accounts are absent or merely invisible to the viewer. This needs an explicit test because it is the subtlest case: `status: "empty"` for a viewer who can't see the Space's only debt account would otherwise whisper that fact. Decision: lens computes over *visible-to-viewer* accounts only, and empty means "nothing visible," with copy that does not assert nonexistence.
9. **The API route.** Membership-gated (mirror `activity` route), per-viewer results (scope.userId = requester, always — never a stored/elevated identity), no caching keyed without userId.

---

## 6. Testing strategy

House convention: standalone `npx tsx` scripts, exit 0/1, colocated (`lib/perspective-engine/*.test.ts`), modeled on `lib/data/transactions.privacy.test.ts`.

1. **Determinism:** fixed fixture + injected clock → byte-identical `LensResult` JSON across two runs; verdict string snapshot-asserted.
2. **No metadata leakage:** fixtures with FULL + BALANCE_ONLY + SUMMARY_ONLY accounts carrying sentinel names/institutions (`"LEAKCANARY_CHASE"`); assert `JSON.stringify(result)` never contains any sentinel for non-FULL rows. (Direct reuse of the existing privacy-proof pattern.)
3. **No holdings/transaction reads:** module-graph check — engine files import neither `Holding`/`Transaction` query surfaces nor `lib/plaid/encryption` nor `lib/ai/provider`; grep-based guard test, same spirit as the no-decrypt invariant.
4. **BALANCE_ONLY behavior:** debt fixture at BALANCE_ONLY → balance included in `totalDebt`, absent from rate-weighted metrics, `tierCounts.balanceOnly` correct, redaction line present, no APR-gap assumption emitted.
5. **SUMMARY_ONLY behavior:** contributes to no numeric metric anywhere; counted; redaction line present.
6. **Empty states:** zero-account Space → `status:"empty"`, safe static copy; viewer-invisible-only Space → identical shape/copy (leak case §5.8).
7. **Assumptions shown:** estimated minimum payment fixture → metric flagged `estimated:true` and matching `LensAssumption` present; liquidity marketable tier always carries its sale/tax assumption.
8. **Route gating:** non-member request → 403/404 parity with the activity route; member request → per-that-viewer results.
9. **No placeholder remains:** extend `lib/space-nav.test.ts`-style guard — every `PERSPECTIVE_LIBRARY` entry with a `lensId` must have `status:"available"` and a registered lens; a lens-backed card may never render the "Soon" badge (assert in a widget-level check or the same guard script).
10. **Math cross-check:** liquidity cash tier and debt total reconcile exactly with `classifyAccounts()` over the same fixture — the engine may never disagree with the dashboard.

---

## 7. Deliverable summaries

### 7.1 Files likely to change (proposal — nothing touched yet)

New: `lib/perspective-engine/{types,registry,index}.ts`, `lib/perspective-engine/lenses/{liquidity,debt}.ts`, `lib/perspective-engine/{engine,liquidity,debt}.privacy.test.ts` (names indicative), `app/api/spaces/[id]/perspectives/route.ts`.
Modified: `lib/perspectives.ts` (additive `lensId` field, `liquidity` entry, category lists), `components/dashboard/widgets/PerspectivesWidget.tsx` (optional `result` rendering), `components/dashboard/SpaceDashboard.tsx` + `components/dashboard/DashboardClient.tsx` (fetch + attach results), `lib/data/accounts.ts` confirmed **unchanged** (already exposes effective APR, estimated min-payment flag, creditLimit — §2.3).
Not touched: `prisma/schema.prisma`, migrations, `lib/ai/*` (read-only reuse of `visibility.ts` predicates only), `PerspectiveSwitcher.tsx`, space rail/nav, any AI provider code.

### 7.2 Risks

1. **Math drift** between engine, `classifyAccounts`, and the accounts assembler's debt resolution — mitigated by reusing `classifyAccounts`/`estimateMinimumPayment` directly and cross-check test §6.10; the DebtProfile resolution duplication is the one drift-prone spot (extract a shared helper later; noted, not done now).
2. **Two-dashboard wiring tax** — every host change lands twice (`DashboardClient` + `SpaceDashboard`); accepted per the freeze (no consolidation in v2.5), and why the widget owns all rendering.
3. **Verdict copy correctness** — financial phrasing carries advisor-grade risk (e.g. available credit is not "liquidity you should use"); templates need explicit copy review before merge, and Liquidity's verdict should not sum available credit into the headline.
4. **Stale inputs** — balances can be days old; mitigated by `provenance.dataAsOf` rendered on the card, never asserting freshness.
5. **`getAccounts()` shape change** (if APR fields must be added) widens a KD-19-audited surface — smallest possible widening, FULL-tier only, with privacy tests updated in the same commit.
6. **Scope creep** — the registry makes adding lenses cheap, which is the danger; feasibility matrix above is the gate, one approved lens at a time.

### 7.3 Validation checklist (per project working style)

- `npx prisma generate` — must be a no-op diff (no schema change).
- ~~`npx prisma migrate dev`~~ — N/A, no schema change; its absence *is* the check.
- `npx tsc --noEmit` — clean.
- `npm run lint` — clean.
- `npx tsx lib/perspective-engine/*.test.ts` — all pass (determinism, privacy, empty, assumptions).
- `npx tsx lib/space-nav.test.ts` and existing privacy tests — still green (no regression).
- Targeted UI check: Personal + one shared Space — Debt/Liquidity cards show verdict + as-of; a BALANCE_ONLY-viewer member sees redaction-safe copy; `comingSoon` cards unchanged; no layout shift on Overview row.
- Grep gates: no new `WorkspaceAccountShare` references; no `lib/plaid/encryption` or `lib/ai/provider` imports under `lib/perspective-engine/`.

### 7.4 Rollback plan

The engine is read-only — no writes, no schema, no data mutation anywhere — so rollback is pure `git revert` with zero data risk at every step. Commit order (§7.5) is arranged so consumers land last: reverting the two host-wiring commits alone restores exactly today's card behavior (static descriptions, Soon badges) while leaving the inert engine in place; reverting the whole stack removes it without trace. The widget renders statically whenever `result` is absent, so a route failure degrades to current behavior at runtime, not just at revert time — no feature flag needed.

### 7.5 Exact proposed commit order

1. `lib/perspective-engine/types.ts` + `registry.ts` + `index.ts` — contracts and skeleton, no lenses, no consumers; determinism/shape tests.
2. Liquidity lens + its privacy/determinism/empty tests.
3. Debt lens + its tests (incl. BALANCE_ONLY/SUMMARY_ONLY proofs, estimate labeling). No `getAccounts()` changes needed — verified §2.3.
4. `app/api/spaces/[id]/perspectives/route.ts` + membership-gating test.
5. `lib/perspectives.ts` additive changes (`lensId`, `liquidity` entry, category lists) + guard-test extension (§6.9).
6. `PerspectivesWidget.tsx` optional-result rendering (pure presenter, no host changes yet).
7. `SpaceDashboard.tsx` wiring.
8. `DashboardClient.tsx` wiring.
9. Docs: engine README/ADR note + this doc marked implemented; full validation sweep.

Each commit compiles, lints, and passes tests independently; consumers trail providers throughout, so the stack is revert-safe at any prefix.

---

**Stopping here per brief.** Next step if approved: implement commit 1 only, then re-validate before proceeding.
