# Fourth Meridian — A5, A4, and P1–P4 Parallelization & Delivery Investigation

**Date:** 2026-07-11
**Branch:** `feature/v2.5-spaces-completion`
**Type:** Architecture and implementation-sequencing investigation only. No code written, no files modified besides this report, no migrations, nothing committed.
**Governing inputs:** A5 investigation, A3 investigation, Progressive Evidence plan, Time Machine cross-perspective investigation + Timeline/Simulation plan (all 2026-07-11), plus direct repository audit below.
**Governing principle:** *"Did the data earn this?"*

---

## 1. Executive answer

**Yes — A5, A4, and P1–P4 can run substantially in parallel, but only after a small serial spine lands: A5-S1 (contract) then A5-S2 (resolvers), two commits on the primary branch.** After that spine, four streams are genuinely concurrent with near-zero file overlap:

| Stream | Content | Can run concurrently? |
|---|---|---|
| **Primary branch** | A5-S3 networth lens, A5-S4 shell as-of control + badge (= P4), all `SpaceDashboard` UI including P1's UI wiring | Yes — sole owner of the shell and `lib/perspective-engine/types.ts` |
| **A4 worktree** | Pure reconstruction core, `PositionReconstruction` schema + migration, persistence runner, bounded repair | Yes — sole owner of `lib/investments/*` and `prisma/schema.prisma` |
| **P1 worktree** | Cash Flow stamp emission + Then-vs-Now diff helper (lib only, no UI) | Yes — sole owner of `lib/transactions/cash-flow*` |
| **P2/P3 worktree** | Liquidity + Debt as-of bindings over `getAccountsAsOf` | Yes — sole owner of `lenses/liquidity.ts` / `lenses/debt.ts` |

**What cannot be parallelized:**

- **A5-S1 and A5-S2 themselves.** Every stream imports S1's `CompletenessTier`/stamp types; P2/P3 call S2's `getAccountsAsOf`. Starting any stream before S1 recreates exactly the vocabulary drift A5 exists to prevent (the fifth trust vocabulary).
- **`components/dashboard/SpaceDashboard.tsx` (3,440 lines).** One owner at a time — the primary branch. P1's "Then vs Now" UI and any consumption of the shared as-of state must land on primary after S4, never from a worktree.
- **`lib/perspective-engine/types.ts` and `engine.test.ts`.** A5-stream-owned. S3 adds `"networth"` to `LensId` in the same ownership window; P2/P3 import types but never edit them, and write their asOf tests in their own test files.
- **A4's real-data replay validation.** The code parallelizes; the validation is runtime-sequential — it needs `INVESTMENT_EVENTS_ENABLED` ingestion to have populated real events (A3-4 is wired into `jobs/sync-banks.ts`, so this is accruing now).
- **P4 as a separate stream.** P4 *is* A5-S3+S4. Spawning a fourth worktree for it would put two owners on the shell. It stays on primary.

---

## 2. Landed-state audit (Section 1 of the brief)

### 2.1 Exact commits

| Slice | Commit(s) | Files |
|---|---|---|
| **A1** Investment Observation Foundation | `752b07a` | `lib/investments/{brokerage-cash,instrument-resolver,position-capture}{,.test}.ts`, `lib/plaid/{exchangeToken,refresh}.ts`, migration `20260711210000_investment_observation_foundation`, `prisma/schema.prisma`, `scripts/backfill-position-observations.ts` |
| **A2** Holding Writer Modernization | `f935b89` | `lib/investments/sync-current-holdings{,.test}.ts`, `lib/plaid/{exchangeToken,refresh}.ts` (code-only, no schema) |
| **A3-1** schema | `402a1f5` | `prisma/schema.prisma`, migration `20260711223000_add_investment_event` |
| **A3-2** mapper | `49b90bb` | `lib/investments/plaid-investment-events{,.test}.ts` |
| **A3-3** ingest | `a824c35` | `lib/investments/investment-event-ingest{,.test}.ts`, `lib/plaid/{exchangeToken,refresh}.ts` |
| **A3-4** scheduled wiring | `f0dc9e1` (HEAD) | `jobs/sync-banks.ts` |

Note: the A5 investigation's header (written earlier on 2026-07-11) describes A2 as "wiring uncommitted in the working tree" — **that is stale**. A2 landed at `f935b89`; the tree is clean.

### 2.2 Working tree, flags, migrations

- **Working tree:** clean of code changes. Untracked: seven investigation `.md` documents + `.claude/settings.local.json`. **No A3 validation code or local-only data is uncommitted.**
- **Feature flags** (env-based; no formal flag framework exists): `INVESTMENT_OBSERVATIONS_ENABLED` (A1, `position-capture.ts:31`), `INVESTMENT_EVENTS_ENABLED` (A3, `investment-event-ingest.ts:37`, checked in `jobs/sync-banks.ts:86`).
- **Migration head:** `20260711223000_add_investment_event`. Both investment migrations are additive. **No `PositionReconstruction` table exists** (grep confirms) — that is A4's one migration. `PositionObservation` carries the reserved-null derived columns at `schema.prisma:1329–1332`: `reconstructionVersion Int?`, `completeness String?`, `unexplainedQuantity Float?`, `evidenceRefs Json?`.

### 2.3 Subsystem inspection findings that drive the topology

- **`lib/perspective-engine/types.ts`:** `LensId = "liquidity" | "debt"`; `PerspectiveScope {spaceId, userId}`; `ComputeOptions {now, targetCurrency}` — **no `asOf`**; `LensResult` has `estimated?` but **no completeness envelope**. This single file is where S1's contract and S3's `LensId` addition land.
- **Registry/index:** lenses self-register at module import (`registerLens` throws on duplicates). Lens *availability* is additionally declared via `lensId` entries in `lib/perspectives.ts` (`:131` debt, `:150` liquidity) — S3 touches both.
- **Lens bindings** (`lenses/liquidity.ts:31`, `lenses/debt.ts:33`) read `getAccountsWithVisibility` (`lib/data/accounts.ts:71`) + `buildSpaceConversionContext{,ById}`. The cores take rows — feeding them as-of rows requires **binding changes only**. This is why P2/P3 are small and isolated.
- **Walk-backs:** `reconstructDailyCashBalances` (`lib/snapshots/backfill-core.ts:59`) and `reconstructDailyLiabilityBalances` (`:101`) — pure, tested, imported (not modified) by S2.
- **Snapshot reads:** `lib/data/snapshots.ts` — `getRecentSnapshots(days=30)`, `getSpaceNetWorthSummaries`, `getPortfolioHistory`; stamp-aware. S2 adds `getSnapshotAsOf` here.
- **Cash Flow period state:** `SpaceDashboard.tsx:2595` — `const [cashFlowPeriod, setCashFlowPeriod] = useState<CashFlowPeriod>(...)`, threaded to all Cash Flow widgets via `SectionRenderProps.period` (`:1350–1355`, `:3124–3148`). `CashFlowPeriodSelector` is a fully controlled component. **The shell already owns time state — the shared `asOf` is a sibling `useState` beside it, owned by the same file.** Coverage boundary: `availableHistoricalPeriods` (`cash-flow.ts:185`), `periodRange` (`:135`) — P1's stamp derives from these, zero engine change.
- **Cross-contamination guards already in place:** Cash Flow reads `Transaction` only and explicitly ignores `INVESTMENT` rows (`cash-flow.ts:262`); Liquidity/Debt read accounts, not positions. Investment gaps structurally cannot contaminate P1–P3 — this becomes a byte-identity regression test, not new work.
- **Tests:** engine guards in `engine.test.ts`; core-vs-binding source-inspection guards in `liquidity.test.ts:164`/`debt.test.ts:187`; fixture-based core tests; `backfill-core.test.ts`; full investment suites from A1–A3. Test files are disjoint per subsystem except `engine.test.ts` (A5-owned).

---

## 3. Dependency graph (Section 2 of the brief)

Classification key: **HARD** = hard prerequisite · **SOFT** = soft dependency · **CONTRACT** = shared contract · **FILE** = file-overlap risk · **SCHEMA** = schema-order dependency · **RUNTIME** = runtime-validation dependency · **IND** = independent.

```
A5-S1 (FinancialContext/asOf + CompletenessTier + stamp)
 ├── depends on: nothing new (types.ts + engine.test.ts only)
 └── is HARD prerequisite of: A5-S2, A5-S3, A5-S4, A4-persistence(vocabulary),
     P1(stamp types), P2, P3, P4

A5-S2 (getSnapshotAsOf + getAccountsAsOf resolvers)
 ├── A5-S1 ......................... HARD (tier types on resolved rows)
 ├── backfill-core walk-backs ....... IND (imported as-is, not modified)
 └── is HARD prerequisite of: P2, P3; SOFT of: A5-S3 (uses getSnapshotAsOf only)

A5-S3 (networth lens = P4 compute half)
 ├── A5-S1 ......................... HARD
 ├── A5-S2.getSnapshotAsOf ......... HARD (not getAccountsAsOf)
 ├── lib/perspectives.ts lensId ..... FILE (A5-owned)
 └── types.ts LensId union .......... FILE (A5-owned, merge-order sensitive)

A5-S4 (shell as-of control + completeness badge = P4 UI half)
 ├── A5-S3 ......................... HARD (needs one lens that answers)
 ├── SpaceDashboard.tsx ............. FILE (single owner: primary)
 └── owns the ONE shared asOf state; is HARD prerequisite of P1-UI, cross-
     perspective date sync, and the A4/B4 badge conventions

A4-core (pure reconstruction algorithm)
 ├── A3 event shapes (landed) ....... HARD (satisfied)
 ├── A5-S1 CompletenessTier ......... CONTRACT (import; half-day wait, take it)
 ├── PositionObservation anchors .... HARD (landed, A1)
 └── A5-S2/S3/S4, P1–P4 ............ IND (zero shared files)

A4-persistence (PositionReconstruction table + DERIVED writes + bounded repair)
 ├── A4-core ....................... HARD
 ├── A5-S1 vocabulary .............. HARD (writes canonical tier strings)
 ├── prisma/schema.prisma .......... SCHEMA (sole migration in the program —
 │                                    no ordering conflict possible: A5/P1–P4
 │                                    are zero-schema by design)
 └── real ingested events .......... RUNTIME (A3-4 accruing now)

A4-read-model (B4 honesty badges in Investments UI)
 ├── A4-persistence ................ HARD
 └── A5-S4 badge conventions ....... SOFT (reuse, don't reinvent)

P1 (Cash Flow Time Machine: stamp + Then-vs-Now)
 ├── A5-S1 stamp types ............. HARD (lib phase)
 ├── A5-S2 ......................... IND (owns its period engine)
 ├── A5-S4 shared control .......... HARD for UI phase only
 └── cash-flow*.ts, DayFacts ....... IND (all landed)

P2 (Liquidity TM) / P3 (Debt TM)
 ├── A5-S1 ......................... HARD
 ├── A5-S2 getAccountsAsOf ......... HARD — and P3 shares the SAME resolver
 │                                    as P2 (CONTRACT): cash walk-back +
 │                                    revolving-liability walk-back + flat-hold
 │                                    + incomplete-beyond-depth, per-row {method,tier}
 ├── lenses/{liquidity,debt}.ts .... FILE (P2/P3-owned; cores untouched)
 └── A5-S4 ......................... SOFT (results render fully only when the
                                      shell control exists; lib merges earlier)

P4 (Wealth TM partial) = A5-S3 + A5-S4. Not a separate stream.
P5 (Investments TM) = gated on A4 + PriceObservation (Track D). Out of scope;
   its adapter seam should be defined by the A4 stream, not A5, to keep
   lib/investments ownership single (revising A5 §10 item 7 — see §5.2).
```

---

## 4. A5 vs A4 (Section 3 of the brief)

**Which A5 sub-slice defines the canonical `CompletenessTier` A4 must import?** A5-S1, and only S1. It is one type + one exported const array + propagation helper in `lib/perspective-engine/types.ts` (or a sibling `completeness.ts`). A4 imports types only — no runtime coupling, no engine-invariant violation (the "no Prisma inside the engine" rule constrains the engine's imports, not who imports the engine's types).

**Can A4's pure reconstruction core precede the A5 UI and net-worth lens?** Yes, entirely. The core depends on A3 event shapes, `PositionObservation` anchors, and the S1 vocabulary — nothing from S2/S3/S4. It should **not** precede S1: the plan doc (§7.3) sketched a private `COMPLETE | PARTIAL | INCOMPLETE` vocabulary for the reserved column, while the A5 investigation (§5) ratified that the column adopts the canonical enum. Starting A4 before S1 forces that decision privately — the exact drift A5 was scheduled to prevent. S1 is a half-day slice; wait for it.

Resolution of that vocabulary tension, explicitly: **row-level `PositionObservation.completeness` on DERIVED rows takes canonical values** (`"derived"` normally; `"incomplete"` past a stop/unexplained residual boundary). **The `PositionReconstruction` summary keeps a separate reconciliation-outcome field** (`COMPLETE | PARTIAL | FAILED` + `failureReason`) — that is a *job outcome*, not a trust tier, and conflating them would flatten "the walk succeeded but the residual is nonzero" into a single axis. The summary additionally carries a canonical `completeness` tier for consumers.

**Can A4 schema work begin before A5?** Technically yes (the migration is additive and references no A5 types), but there is no schedule benefit: schema is a one-hour slice inside a stream that must wait for S1 anyway.

**`PositionObservation.completeness`: String, Prisma enum, or TS vocabulary by convention?** **Remain `String?`, constrained to the TypeScript vocabulary by convention plus a write-time runtime guard.** Grounds: (a) converting a reserved-null string column to a Prisma enum requires a data-touching migration and couples A4's schema slice to every future vocabulary change (adding `"unknown"`-adjacent values becomes migration churn); (b) the vocabulary's single source of truth is deliberately the engine's TypeScript export — a Prisma enum would be a second source needing synchronization; (c) the repo's MC1 null doctrine and A1's reserved-null design anticipated string adoption. Enforcement instead of schema: the A4 writer asserts `value ∈ COMPLETENESS_TIERS` and refuses the write otherwise, with a test proving noncanonical values cannot be written (§10 validation plan).

**Exact files A5 and A4 would both touch: none**, after one scope adjustment. The A5 roadmap's item 7 ("Investments adapter contract / P5 seam") would put A5 hands in `lib/investments`-adjacent read paths. Move that seam definition into the A4 stream (it lands naturally with B4). With that, the intersection is exactly one read-only type import.

**A4 split for parallelism:** yes — (1) **pure core** `lib/investments/reconstruction-core.ts` (fixture-tested, fully parallel with everything after S1); (2) **schema/persistence runner** (`PositionReconstruction` migration + DERIVED-row writer + `scripts/run-reconstruction.ts`, parallel, sole schema owner); (3) **bounded repair** (entry point wired into `investment-event-ingest.ts` — an A4-owned file going forward, no other stream touches it); (4) **UI/read model (B4)** — the only sequential part: after A5-S4's badge conventions and A4's own summaries exist.

**Recommended A5/A4 merge order:** S1 → S2 → (A4 core+schema+runner developed in parallel; merge any time it is green — the additive migration conflicts with nothing) → DERIVED writes enabled behind `INVESTMENT_RECONSTRUCTION_ENABLED` after real-data replay → B4 after S4.

---

## 5. A5 vs P1–P4 (Section 4 of the brief)

Minimum A5 sub-slices per P slice:

| Slice | Needs S1 | Needs S2 | Needs S3 | Needs S4 | Notes |
|---|---|---|---|---|---|
| **P1 Cash Flow** | Yes (stamp types) | **No** — owns its period engine (`DayFacts`, `periodRange`, `availableHistoricalPeriods`) | No | **UI phase only** | Lib phase (stamp emission + `DayFacts` diff helper) starts immediately after S1 |
| **P2 Liquidity** | Yes | **Yes** — `getAccountsAsOf` is the entire enabling mechanism | No | Soft (rendering) | Binding-only change; `liquidity.core` untouched |
| **P3 Debt** | Yes | **Yes — the same resolver as P2.** One `getAccountsAsOf` covers cash walk-back (derived), revolving-liability walk-back (derived), flat-hold (estimated), beyond-depth (incomplete) | No | Soft | Binding-only; decomposition refused |
| **P4 Wealth** | Yes | Yes (`getSnapshotAsOf` half) | **Is** S3 | **Is** S4 | P4 is not a separate work item — it is A5's proving slice |

**Can P1 begin immediately after A5-S1?** Yes, for everything except UI. Cash Flow is not a lens; its stamp is emitted by an adapter helper reading `availableHistoricalPeriods` — the only S1 artifact it needs is the `Completeness`/stamp type. The Then-vs-Now diff helper is pure compute over two `bucketDayFacts` results.

**Can P1 and P2/P3 run concurrently after the contracts land?** Yes — file sets are fully disjoint (`lib/transactions/*` vs `lib/perspective-engine/lenses/*`). Both must stay out of `SpaceDashboard.tsx` and `engine.test.ts`.

**Who owns the shared date-control state?** `SpaceDashboard.tsx`, exclusively, via A5-S4 on the primary branch: one `asOf` `useState` beside the existing `cashFlowPeriod` state (`:2595`), threaded through `SectionRenderProps` exactly as `period` already is. P1–P3 *consume* it through props; no worktree stream introduces any date state, selector, or URL param. This is the structural guarantee behind "P1–P4 share one date state rather than independent controls" — enforced by ownership, then by a shell-seams test (`space-shell-seams.test.ts` is the existing precedent surface).

---

## 6. File-ownership matrix (Section 5 of the brief)

Ownership legend: **P** = primary branch (A5 stream) · **A4** / **P1** / **P23** = worktree streams. Overlap: none / low / **HIGH** / (M) = merge-order sensitive.

| File / surface | S1 | S2 | S3 | S4 | A4 core | A4 persist | P1 | P2 | P3 | Owner | Overlap |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `lib/perspective-engine/types.ts` | **W** | — | W (LensId) | — | R | R | R | R | R | **P** | HIGH (M) — single owner; writes serialized S1→S3 |
| `lib/perspective-engine/completeness.ts` (new: tiers const + worst-tier helper) | **W** | — | R | R | R | R | R | R | R | **P** | none after S1 |
| `lib/perspective-engine/engine.test.ts` | **W** | — | W | — | — | — | — | — | — | **P** | (M) — P2/P3 forbidden; they write own test files |
| `lib/perspective-engine/index.ts` / `registry.ts` | — | — | W (export/registration only if needed) | — | — | — | — | — | — | **P** | low |
| `lib/perspectives.ts` | — | — | **W** (networth lensId) | — | — | — | — | — | — | **P** | none |
| `lib/data/snapshots.ts` | — | **W** (getSnapshotAsOf) | R | — | — | — | — | — | — | **P** | none |
| `lib/data/accounts.ts` | — | **R only** | — | — | — | — | — | R | R | — | **none — do not modify**; S2 puts `getAccountsAsOf` in a new sibling file |
| `lib/data/accounts-asof.ts` (+ `.core`, tests, fixtures — new) | — | **W** | — | — | — | — | — | R | R | **P** | none; fixtures owned here, reused by P2/P3, never forked |
| `lib/snapshots/backfill-core.ts` | — | R | — | — | — | — | — | — | — | — | none — imported, never modified |
| `lenses/networth.core.ts` / `networth.ts` / tests (new) | — | — | **W** | — | — | — | — | — | — | **P** | none |
| `lenses/liquidity.ts` + new asOf tests | — | — | — | — | — | — | — | **W** | — | **P23** | none (core + existing tests untouched) |
| `lenses/debt.ts` + new asOf tests | — | — | — | — | — | — | — | — | **W** | **P23** | none |
| `lib/transactions/cash-flow-compare.ts` (new) + `cash-flow.ts` (small export if needed) | — | — | — | — | — | — | **W** | — | — | **P1** | none |
| `components/dashboard/SpaceDashboard.tsx` | — | — | — | **W** | — | — | UI phase, on **P** after S4 | — | — | **P** | **HIGH (M)** — single owner at all times |
| `components/space/AsOfControl.tsx`, `CompletenessBadge.tsx` (new) | — | — | — | **W** | — | — | R | R | R | **P** | none |
| `components/space/widgets/wealth-adapters.tsx` | — | — | — | **W** | — | — | — | — | — | **P** | none |
| `components/space/widgets/cash-flow-adapters.tsx`, `CashFlowHistoryWidget.tsx` | — | — | — | — | — | — | **W** (UI phase, on P) | — | — | **P** (post-S4) | (M) |
| `components/space/widgets/{liquidity,debt}-adapters.tsx` | — | — | — | badge pass | — | — | — | badge consumption (UI phase, on P) | ← | **P** (post-S4) | low (M) |
| `prisma/schema.prisma` + new migration | — | — | — | — | — | **W** (PositionReconstruction only) | — | — | — | **A4** | none — sole migration in program |
| `lib/investments/reconstruction-core.ts` + tests (new) | — | — | — | — | **W** | R | — | — | — | **A4** | none |
| `lib/investments/reconstruction-runner.ts`, `scripts/run-reconstruction.ts` (new) | — | — | — | — | — | **W** | — | — | — | **A4** | none |
| `lib/investments/investment-event-ingest.ts` (bounded-repair hook) | — | — | — | — | — | **W** | — | — | — | **A4** | none |
| `lib/data/investment-accounts.ts`, `current-holdings.ts`, `InvestmentAccountsWidget.tsx` (B4) | — | — | — | — | — | later | — | — | — | **A4** (B4, post-S4) | low (M) |
| `lib/plaid/refresh.ts` / `exchangeToken.ts` | — | — | — | — | — | — | — | — | — | — | **untouched by all streams** (first program slice where this is true) |

**Single-owner-at-a-time files:** `types.ts`, `engine.test.ts`, `SpaceDashboard.tsx`, `prisma/schema.prisma`, `lib/perspectives.ts`, `accounts-asof` fixtures. All are assigned above; no file has two concurrent writers in this topology.

---

## 7. Implementation topologies (Section 6 of the brief)

### A. Fully sequential (A5 → A4 → P1 → P2 → P3 → P4)

- **Speed:** slowest — ~9 serial slices; P4 arrives last despite being A5's own proving slice (the ordering is also internally wrong: A5 isn't "done" without S3/S4, which *are* P4).
- **Merge-conflict risk:** zero. **Semantic drift:** zero. **Validation burden:** lowest per step. **Rollback clarity:** perfect (linear revert).
- **Claude Code suitability:** fine but wasteful — the file-ownership analysis shows the streams are naturally disjoint; serializing them buys nothing after S1/S2.

### B. Contract-first parallel (recommended)

S1+S2 land serially on primary; then A4 / P1-lib / P2+P3 fan out in worktrees while primary continues S3→S4; UI phases converge on primary.

- **Speed:** ~2–2.5× vs A — the three worktree streams are each small and independent.
- **Merge-conflict risk:** low, *by construction* (matrix §6: no shared writable files). Residual risk: `types.ts` if a worktree "helpfully" extends the contract — forbidden-files lists in the prompts prevent this.
- **Semantic drift risk:** low — the drift-prone artifact (trust vocabulary) is frozen in S1 before fan-out; the resolver semantics are frozen in S2 with fixtures P2/P3 must reuse.
- **Validation burden:** moderate — kill-switch byte-identity re-run at every merge (cheap: it's an existing test pattern), plus one integration pass after the last merge.
- **Rollback clarity:** good — each stream is additive and kill-switched (`asOf` absent ⇒ byte-identical; A4 behind a new flag); any stream reverts independently.
- **Claude Code suitability:** high — each worktree prompt has a closed file set, a prerequisite commit, and stop conditions; no agent ever edits another's files. **Never two agents in one working tree.**

### C. Worktree-parallel from the current commit (all streams start now, including A5 in its own worktree)

- **Speed:** marginally faster start, then stalls: P2/P3 block on S2 regardless; A4 either blocks on S1 or invents vocabulary. **Semantic drift risk: the highest of the three** — the contract gets negotiated across branches instead of defined once.
- **Merge-conflict risk:** moderate (contract churn rebases). **Rollback:** murkier — interleaved merges of contract and consumers.
- Verdict: strictly dominated by B, which uses C's worktree mechanics *after* the contract gate.

**Recommended: B, executed with worktrees.** Layout:

```
~/dev/FourthMeridian                    feature/v2.5-spaces-completion   (primary: S1→S2→S3→S4, P4, all UI)
git worktree add ../fm-a4   -b feature/a4-position-reconstruction   <S1-commit>
git worktree add ../fm-p1   -b feature/p1-cashflow-time-machine     <S1-commit>
git worktree add ../fm-p23  -b feature/p23-liquidity-debt-asof      <S2-commit>
```

(A4 and P1 branch from the S1 commit; P2/P3 from the S2 commit. All merge back into `feature/v2.5-spaces-completion`.)

---

## 8. Best way to start (Section 7 of the brief)

The brief's example sequence is **confirmed with two grounded corrections**:

1. **Implement and commit A5-S1** on `feature/v2.5-spaces-completion`: `asOf?: string` on `ComputeOptions`; `CompletenessTier` + `Completeness` + `FinancialContextStamp` types; `COMPLETENESS_TIERS` const + worst-tier/conflict-OR propagation helper; kill-switch guards in `engine.test.ts`. One commit. (Grounded: `types.ts` is the one file every stream reads; freezing it first is what makes fan-out safe.)
2. **Implement and commit A5-S2**: `getSnapshotAsOf` in `lib/data/snapshots.ts`; `getAccountsAsOf` in a **new** `lib/data/accounts-asof.ts` (pure core + binding, per-row `{method, tier}`), importing — never modifying — `backfill-core.ts`. Fixtures live here. One commit. (Correction 1 vs the example: `lib/data/accounts.ts` is *not* touched; a sibling file removes the only would-be overlap between S2 and future account-surface work.)
3. **Fan out three worktrees** (layout in §7): A4 pure core + schema + runner; P1 Cash Flow lib (stamp + diff helper, **no UI**); P2/P3 binding switches to `getAccountsAsOf`. (Correction 2 vs the example: P1's deliverable in the worktree is lib-only; its adapter/UI wiring is explicitly reassigned to the primary branch post-S4, because "P1 Cash Flow adapter" as a worktree deliverable would collide with `SpaceDashboard.tsx`.)
4. **Primary keeps S3/S4/P4** and performs all merges in the §9 order.

---

## 9. Exact chronological merge order

1. `A5-S1` (primary commit)
2. `A5-S2` (primary commit) — worktrees fan out here
3. `A5-S3` networth lens (primary commit)
4. **Merge `feature/p23-liquidity-debt-asof`** (lib-only; rebase trivially over S3's `LensId` change — different lines of `types.ts`? No: P23 never edits `types.ts`; nothing to rebase but test snapshots)
5. `A5-S4` shell as-of control + badge (primary commit) — **launches with Wealth + Liquidity + Debt responding and Cash Flow period-native: four coherent perspectives on day one** (this ordering is why P23 merges before S4)
6. **Merge `feature/p1-cashflow-time-machine`** (lib), then P1 UI wiring on primary (Then-vs-Now + stamp into the shared control)
7. **Merge `feature/a4-position-reconstruction`** (can happen any time after step 2 when green; placed here so its real-data replay runs on a primary that already has the full contract). Run the additive migration; keep `INVESTMENT_RECONSTRUCTION_ENABLED` off.
8. Enable A4 dark writes; validate replay against the 16 real positions; residuals persisted, never zeroed.
9. B4 Investments honesty badges (A4 stream, on primary or a short-lived branch — SpaceDashboard/widget conventions now stable).

---

## 10. UI/UX delivery order (Section 8 of the brief)

The user should first see Perspective Engine benefits at **step 5 of §9 (A5-S4)** — and not before. Rationale: exposing a shared As-of control when only one perspective can respond violates the coherence guardrail; by sequencing P2/P3's lib merge ahead of S4, the control launches with Wealth, Liquidity, and Debt answering and Cash Flow already period-native. Any perspective that cannot respond (Investments) renders its shaped partial state with an explicit "shows current values" label — the engine's existing per-lens-degrade contract, never a blank shell.

| UX capability | Ships with | Notes |
|---|---|---|
| Then vs Now (period comparison) | **P1 only** | Cash-Flow-local; needs no shared control; could even ship before S4 if desired |
| Shared "As of" control | **P4 (S4)**, after P2/P3 lib | The single date state; Cash Flow keeps its period selector for flows |
| Completeness badges | **P4 (S4)** onward, all perspectives | User-facing copy only ("Reconstructed", "Held at today's value", "No history before …") — never tier names |
| Historical charts (net-worth line as-of cursor) | **P4** | Bounded by snapshot depth; gaps visible, never interpolated |
| Clickable chart points → set `asOf` | **P4 + one small follow-up** | Trivial once the chart and the single state exist |
| Account-level drill-down (per-account tier/method) | **P2/P3** (via `byComponent`) | Liquidity/Debt rows carry `{method, tier}` from S2 |
| Transaction/event evidence drawers | **P1/P2/P3** | Reuse `TransactionSliceDrawer`; investment-event drawers wait for B4 |
| Cross-perspective date synchronization | **automatic at S4** | One state, structurally — not a feature to build later |
| Investment "history since / N shares unexplained" | **A4 (B4)** | Honesty surface only; no valuation |
| Historical portfolio value / contribution-vs-growth | **P5, later** | Gated on A4 + `PriceObservation` |

---

## 11. Validation and integration plan (Section 9 of the brief)

- **Shared contract tests (S1, primary):** `COMPLETENESS_TIERS` frozen by snapshot test; worst-tier + conflict-OR propagation helper unit-tested once (all consumers use the helper, never re-implement); serialisability + determinism guards extended in `engine.test.ts`.
- **Kill-switch byte-identity (the load-bearing regression):** every existing lens/adapter call **without `asOf` is byte-identical** — asserted in `engine.test.ts` (S1), re-run at every merge (steps 4–7 of §9). This is the "absent asOf" guarantee, mechanically enforced.
- **Fixture ownership:** S2 owns the walk-back/as-of fixtures in `lib/data/accounts-asof` tests; P2/P3 import them — forking fixtures is a review-rejectable offense (drift vector).
- **Cross-branch integration test (post-merge, primary):** for a snapshotted date, `getAccountsAsOf` cash aggregate reconciles with `SpaceSnapshot.cash` within tolerance — ties S2's reconstruction to the persisted snapshot truth and catches resolver/lens drift between branches.
- **A4 canonical-value guard:** the DERIVED writer asserts `completeness ∈ COMPLETENESS_TIERS` and refuses otherwise; a test writes a noncanonical value and asserts rejection. A4 structurally cannot mint vocabulary.
- **Single date state:** shell-seams test asserts exactly one `asOf` owner in `SpaceDashboard` and that widgets receive it via props (the `space-shell-seams.test.ts` precedent); no widget file may contain its own as-of `useState` (source-inspection guard, mirroring `liquidity.test.ts:164`'s pattern).
- **Partial-never-looks-observed:** badge component test — `estimated`/`derived`/`incomplete` stamps must render the labeled variant; a result with `asOf` set and no completeness field fails shaped (fail-closed).
- **Investment-gap non-contamination:** byte-identity test that enabling `INVESTMENT_RECONSTRUCTION_ENABLED` and writing DERIVED rows changes zero bytes of Cash Flow (`cash-flow.ts:262` ignores INVESTMENT), Liquidity, and Debt results.
- **Migration sequencing:** one additive migration (A4's `PositionReconstruction`), merged at §9 step 7; all other streams zero-schema — no ordering to manage.
- **Feature flags:** existing `INVESTMENT_OBSERVATIONS_ENABLED`, `INVESTMENT_EVENTS_ENABLED` unchanged; new `INVESTMENT_RECONSTRUCTION_ENABLED` (A4 writes); the as-of UI needs no flag (absent `asOf` is the kill switch), but the S4 control may ship behind a UI conditional if staged exposure is wanted.
- **Real-data validation order:** (1) S3 vs a Space with ≥30 snapshot days incl. one `isEstimated` row and one gap; (2) P2/P3 vs dates inside and beyond transaction depth (expect `derived` / `incomplete`); (3) snapshot-reconciliation invariant above; (4) A4 replay: 16 real positions each get a summary, `opening + Σevents = current + residual`, residual persisted; (5) browser verification after S4 and after P1 UI (control, badges, gap rendering, no smooth fabricated lines).

---

## 12. Risks and guardrails

| Risk | Guardrail |
|---|---|
| Worktree stream edits a contract file "while in there" | Forbidden-files list in every prompt; `types.ts`/`engine.test.ts`/`SpaceDashboard.tsx`/schema owned as per §6; review rejects out-of-set diffs |
| A4 invents completeness semantics | S1 lands first; write-time guard + rejection test |
| Second date control appears (widget-local asOf) | S4 owns the single state; source-inspection guard on widget files |
| S4 ships before perspectives can respond | Merge order §9 (P23 before S4); non-responders labeled, never blank |
| Same-day doc drift (A5 doc's stale "A2 uncommitted" note) | This report's §2.1 audit supersedes; prompts cite commits, not doc prose |
| A3 restatements arriving mid-A4-replay | Bounded repair is part of A4's own slice; replay validation re-runnable (versioned DERIVED rows) |
| Merge-queue serialization pain | All merges land through primary in §9 order; worktree branches rebase onto primary before merge, never onto each other |

---

## 13. Claude Code prompts

### 13.1 Shared-contract slice (primary branch — run first)

```
Fourth Meridian — implement A5-S1 + A5-S2 (shared Perspective Engine contract + as-of resolvers).
Branch: feature/v2.5-spaces-completion (work directly on it; two commits).
Prerequisite commit: f0dc9e1 (A3-4 wiring; current HEAD).

Read first:
- FOURTH_MERIDIAN_A5_SHARED_PERSPECTIVE_ENGINE_INVESTIGATION_2026-07-11.md §3–§5 (the ratified contract)
- FOURTH_MERIDIAN_A5_A4_P1-P4_PARALLELIZATION_INVESTIGATION_2026-07-11.md §6 (file ownership), §11 (validation)
- lib/perspective-engine/types.ts, engine.test.ts; lib/data/accounts.ts (getAccountsWithVisibility, READ ONLY);
  lib/data/snapshots.ts; lib/snapshots/backfill-core.ts (walk-backs, READ ONLY)

Commit 1 — A5-S1 (contract):
- lib/perspective-engine/types.ts: add asOf?: string (YYYY-MM-DD) to ComputeOptions; export
  type CompletenessTier = "observed" | "derived" | "estimated" | "incomplete" | "unknown";
  interface Completeness { tier; conflict: boolean; reason: string; coverageFrom?: string;
  byComponent?: Record<string, CompletenessTier> }; add completeness?: Completeness to LensResult.
  Document: PositionObservation.completeness (reserved-null since A1) MUST adopt these exact string
  values when A4 writes DERIVED rows — this is THE single trust vocabulary.
- New lib/perspective-engine/completeness.ts: export const COMPLETENESS_TIERS (frozen array) and a
  worst-tier propagation helper (min over tiers; conflict ORs upward).
- engine.test.ts: kill-switch guard (every existing lens call without asOf byte-identical),
  serialisability + determinism of the new types, COMPLETENESS_TIERS snapshot test.

Commit 2 — A5-S2 (resolvers, data layer — NOT the engine):
- lib/data/snapshots.ts: getSnapshotAsOf(spaceId, asOf) — nearest SpaceSnapshot ≤ asOf, stamp-aware.
- NEW lib/data/accounts-asof.ts (+ pure core + fixture tests): getAccountsAsOf(...) returns
  getAccountsWithVisibility rows with balances resolved to asOf via the EXISTING walk-backs imported
  from lib/snapshots/backfill-core.ts (cash ⇒ derived; revolving liability ⇒ derived; all else held
  flat ⇒ estimated; before earliest transaction/link ⇒ incomplete), each row carrying {method, tier}.
  Do NOT modify lib/data/accounts.ts or backfill-core.ts. Fixtures live here — downstream streams
  reuse them, never fork them.

Forbidden files: lib/data/accounts.ts, lib/snapshots/*, components/**, prisma/schema.prisma,
lib/investments/**, lib/transactions/**, lenses/*.
Stop conditions: both commits green; full suite green; no schema/migration; no lens consumes asOf yet;
no UI. Everything additive and kill-switched.
Merge order: these two commits are the fan-out gate for all parallel streams.
```

### 13.2 Stream A4 (worktree `../fm-a4`)

```
Fourth Meridian — A4 Position Reconstruction: pure core + schema + persistence runner + bounded repair.
Branch: feature/a4-position-reconstruction, worktree ../fm-a4.
Prerequisite commit: the A5-S1 commit on feature/v2.5-spaces-completion (branch from it; you need the
canonical CompletenessTier export). Merge order: merges into the primary branch AFTER P2/P3 and S4
(§9 step 7 of the parallelization investigation); rebase onto primary before merge.

Read first:
- FOURTH_MERIDIAN_INVESTMENT_HISTORY_PROGRESSIVE_EVIDENCE_IMPLEMENTATION_PLAN_2026-07-11.md §6–§7, §12–§14 (B3)
- FOURTH_MERIDIAN_A3_INVESTMENT_EVENT_FOUNDATION_INVESTIGATION_2026-07-11.md §8 (what A3 guarantees you)
- lib/investments/* (A1–A3 landed code), prisma/schema.prisma (PositionObservation reserved columns :1329)

Owned files: lib/investments/reconstruction-core.ts (+tests, new), lib/investments/reconstruction-runner.ts
(+tests, new), lib/investments/investment-event-ingest.ts (bounded-repair hook only),
scripts/run-reconstruction.ts (new), prisma/schema.prisma + ONE additive migration (PositionReconstruction).
Forbidden files: lib/perspective-engine/** (import types only — never edit), lib/data/**,
lib/transactions/**, components/**, lib/plaid/**, jobs/**.

Tasks:
1. Pure core per plan §7: backward walk anchored at OBSERVED rows; sort (date, source, externalEventId, id);
   CANCEL equal-and-opposite matching (unmatched ⇒ CONFLICTED); SPLIT without ratio / MERGER / SPIN_OFF /
   quantity-bearing UNKNOWN ⇒ stop with reason; cash-only events route to the per-currency cash instrument;
   closed positions anchored at quantity 0; residual persisted, NEVER zeroed. Fixture-tested, no DB.
2. Additive migration: PositionReconstruction summary table (earliestDefensibleDate, observedCurrentQuantity,
   openingQuantity, unexplainedOpeningQuantity, reconciliation status COMPLETE|PARTIAL|FAILED + failureReason,
   canonical completeness tier, reconstructionVersion, eventCount, evidenceRefs, runAt).
3. Runner: writes DERIVED PositionObservation rows at event dates. PositionObservation.completeness stays a
   String column; write ONLY values from COMPLETENESS_TIERS imported from lib/perspective-engine/completeness —
   assert membership at write time and add a test proving a noncanonical value is refused.
   Rerun at version N deletes only origin=DERIVED AND reconstructionVersion<N in the affected window.
4. Bounded repair: entry point invoked from investment-event-ingest.ts when late/corrected events land inside
   a reconstructed window; rerun from min(affected dates) to the next OBSERVED anchor.
5. Everything behind new env flag INVESTMENT_RECONSTRUCTION_ENABLED (absent ⇒ zero writes); best-effort/
   non-fatal at call sites (A1 try/catch contract).

Stop conditions: fixtures green incl. every stop/CONFLICTED path; flag-off ⇒ zero writes; migration additive
and reversible; full suite green; NO reader/UI changes (B4 is a later slice, after A5-S4); no valuation,
no prices. Real-data replay validation happens after merge to primary, where ingested events live.
```

### 13.3 Stream P1 (worktree `../fm-p1`)

```
Fourth Meridian — P1 Cash Flow Time Machine, lib phase only: completeness stamp + Then-vs-Now diff helper.
Branch: feature/p1-cashflow-time-machine, worktree ../fm-p1.
Prerequisite commit: the A5-S1 commit (branch from it). Merge order: §9 step 6 — after S4 lands on primary;
rebase onto primary before merge. Your UI wiring is NOT in this stream: it is done on the primary branch
after merge, against the S4 shared control.

Read first: A5 investigation §4 (Cash Flow adapter row), lib/transactions/cash-flow.ts
(periodRange :135, availableHistoricalPeriods :185), cash-flow-projection.ts (DayFacts, bucketDayFacts,
CALENDAR_MEASURES).

Owned files: NEW lib/transactions/cash-flow-compare.ts (+tests); minimal additive exports in
lib/transactions/cash-flow.ts ONLY if an existing internal is needed (no behavior change).
Forbidden files: components/** (ALL UI — especially SpaceDashboard.tsx and cash-flow-adapters.tsx),
lib/perspective-engine/** (import types only), lib/data/**, prisma/**, lib/investments/**.

Tasks:
1. Stamp emission helper: given transactions + a CashFlowPeriod, emit the S1 Completeness/stamp —
   tier "observed" within transaction depth, "incomplete" when the period predates coverage
   (derive from availableHistoricalPeriods); dataAsOf from the inputs. Pure, deterministic, injected clock.
2. Then-vs-Now diff helper: two period selections ⇒ deltas over existing DayFacts totals and category
   breakdown (pure compute over bucketDayFacts outputs); result completeness = worst of the two stamps.
3. Tests: determinism, coverage-boundary tiers, delta correctness vs independent per-period recomputation.

Stop conditions: no UI; no engine changes; no new date/period state anywhere; existing cash-flow tests
byte-identical; full suite green.
```

### 13.4 Stream P2/P3 (worktree `../fm-p23`)

```
Fourth Meridian — P2 Liquidity + P3 Debt Time Machines: as-of bindings over getAccountsAsOf.
Branch: feature/p23-liquidity-debt-asof, worktree ../fm-p23.
Prerequisite commit: the A5-S2 commit (branch from it — you need getAccountsAsOf and its fixtures).
Merge order: §9 step 4 — FIRST worktree merge, before A5-S4, so the shell control launches with three
responding perspectives. Rebase onto primary before merge.

Read first: A5 investigation §4 (Liquidity/Debt adapter rows), lib/data/accounts-asof.ts (S2 — resolver +
fixtures; REUSE the fixtures, never fork), lenses/liquidity.ts, lenses/debt.ts (bindings),
liquidity.core.ts / debt.core.ts (DO NOT TOUCH).

Owned files: lib/perspective-engine/lenses/liquidity.ts, lenses/debt.ts, NEW test files
lib/perspective-engine/liquidity.asof.test.ts and debt.asof.test.ts.
Forbidden files: lenses/*.core.ts, types.ts, engine.test.ts, completeness.ts, registry.ts, index.ts,
lib/data/** (consume only), components/**, prisma/**, lib/transactions/**, lib/investments/**.

Tasks:
1. Liquidity binding: when options.asOf is set, read getAccountsAsOf instead of getAccountsWithVisibility;
   core untouched (it takes rows). Stamp = worst row tier via the S1 propagation helper; byComponent carries
   per-bucket detail (cash derived / marketable estimated / beyond-depth incomplete).
2. Debt binding: same pattern; revolving cards derived, installment loans held flat ⇒ estimated with explicit
   reason; principal-vs-interest REFUSED (no amortization engine — do not build one).
3. Tests in YOUR OWN test files (never edit engine.test.ts): asOf determinism, tier derivation, visibility-tier
   privacy under asOf, kill-switch byte-identity for asOf-absent calls, incomplete-beyond-depth shapes.

Stop conditions: cores byte-identical; asOf-absent behavior byte-identical; no UI; no new resolver logic
(S2 owns resolution semantics — if the resolver is missing something, report it, do not patch around it);
full suite green.
```

### 13.5 Primary branch continuation (S3 + S4 = P4, then merges)

```
Fourth Meridian — A5-S3 (networth lens) + A5-S4 (shell as-of control + completeness badge) = P4 Wealth
Time Machine (partial). Branch: feature/v2.5-spaces-completion, directly (this stream owns the shell).
Prerequisite commit: A5-S2.

Owned files: lenses/networth.core.ts / networth.ts / networth.test.ts (new); types.ts (LensId union add —
this branch is the ONLY writer of types.ts); lib/perspectives.ts (networth lensId entry);
components/dashboard/SpaceDashboard.tsx (single asOf useState beside cashFlowPeriod at :2595, threaded via
SectionRenderProps like period); NEW components/space/AsOfControl.tsx + CompletenessBadge.tsx (Atlas
conventions); components/space/widgets/wealth-adapters.tsx.
Forbidden: prisma/**, lib/investments/**, lib/transactions/**, lenses/{liquidity,debt}*.

S3 per A5 investigation §11 item 4 (tier derivation from SpaceSnapshot/isEstimated/carry-forward/gap; no
interpolation). S4 per item 5, plus: merge feature/p23-liquidity-debt-asof BEFORE shipping S4 so the control
launches with Wealth + Liquidity + Debt responding; non-responding perspectives (Investments) render their
shaped partial state labeled "shows current values" — never a blank shell. Badge copy user-facing only
("Reconstructed", "No history before …"). Then merge P1 lib and wire its Then-vs-Now UI here. Real-data
validation per A5 §11 item 7 + browser verification.
Stop conditions: kill-switch byte-identity across all lenses; single asOf state (shell-seams guard);
estimated/incomplete never styled as observed; no Timeline, no simulation, no investment valuation.
```

---

*End of investigation. No code written, no files modified besides this report, no migrations created, nothing committed.*
