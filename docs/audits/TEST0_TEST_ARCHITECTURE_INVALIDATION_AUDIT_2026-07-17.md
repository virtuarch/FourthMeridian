# TEST-0 — Test Architecture Invalidation Audit

**Date:** 2026-07-17
**Scope:** Investigation only. No test deleted/rewritten, no production code changed, no commit, no push.
**HEAD audited:** `210150584958f003be6264db5e146576b0d7d9d8` (branch `feature/v2.5-spaces-completion`)
**Method:** Full census of every test file, then six parallel deep-read sub-audits (every file opened), cross-referenced against the code-invalidation audit (`docs/audits/architecture-audit-2026-07-16.md`) and a live full-suite run.

> **The one-line answer.** The suite is **not materially bloated by count** — 231 of 273 files (85%) are load-bearing KEEP that answer the "what real bug/invariant does this prevent?" question cleanly. The real debt is **localized and shallow**: 2 migration-archaeology files to retire, 12 email micro-suites that should be 2, ~24 files carrying brittle *implementation-pin* assertions inside otherwise-durable tests, and a **per-process runner** whose cost is dominated by 273× `tsx` cold-starts. **Zero dead-code tests** keep any dead surface artificially green. The high 37% source-scan share is mostly **justified** (DB-coupled wiring, import-graph purity, FK schema, authz-at-every-callsite) — only ~9–15 scan files are brittle enough to warrant conversion.

> **Operational flag (act first):** the suite is **RED on this HEAD — 271/273.** Both failures are *brittle-pin* failures on legitimate change, not regressions (details in §11a). CI on this branch is currently failing.

---

## 1. Fresh census

Enumerated every `*.test.ts` / `*.test.tsx` under `lib/`, `app/`, `components/` (the exact set the runner discovers).

| Metric | Value |
|---|---|
| Test files | **273** |
| Total test LOC | **~39,073** |
| Files that read source (`readFileSync`/`readdirSync`/`existsSync`) | **102 (37%)** |
| Files using idiomatic `node:test` + `node:assert` | **27** |
| Files using the bespoke `process.exit`/`check()` harness | **246** |
| Files importing Prisma enum values | ~61 |

**37% source-scan share independently reproduces** the code-audit's "99 of 268" figure (drift is the 5 files added since).

### Test-style distribution (aggregated across the six sub-audits)

| Style | ~Count | ~Share | Notes |
|---|---|---|---|
| BEHAVIORAL (executes real prod fns) | ~99 | 36% | The backbone; many carry a small source-scan *tail* |
| PURE_CORE_FIXTURE | ~75 | 27% | Pure functions over inline fixtures (money, valuation, merchant, email) |
| SOURCE_SCAN (pure or scan-dominant) | ~40 | 15% | Of these, most are durable seam tripwires (see §4) |
| CONTRACT | ~11 | 4% | `*SpaceData` composition/passthrough boundaries |
| ORACLE | ~3 | 1% | financial-doctrine-oracle, platform/policy 480-combo, engine matrices |
| GOLDEN | ~6 | 2% | serialize.golden, account-classifier.golden, btc-address vectors |
| MIGRATION_RATCHET | ~2 | <1% | merchant-schema (confinement), deletion-safety (FK) |
| TYPE_LEVEL | ~3 | 1% | transaction-detail-ti2, space-data-historical type half |
| INTEGRATION | ~2 | 1% | authorize-visibility, liquidity space-data e2e |
| **Mixed** (behavioral + scan) | ~30 | 11% | Real runtime core + a wiring tripwire tail |

**`executesRuntime = Y` on ~245 of 273 (90%).** Only ~28 files are pure non-executing scans/type-level. The suite is far more behavioral than the raw "37% source-scan" figure suggests — most scanning files *also* execute production code.

---

## 2. Runner architecture

**`scripts/run-tests.ts`** — hand-rolled discovery + one **child process per file**, run **sequentially**, via `spawnSync(tsx, ['--require', preload, file])`. Aggregates a single pass/fail. There is **no test framework** (no jest/vitest).

| Dimension | State |
|---|---|
| Process model | **One `tsx` process per test file** (isolation: several call `process.exit`, one mutates `process.env`) |
| Parallelism | **None** — strictly sequential loop |
| Startup/transform overhead | `tsx` (esbuild) cold-start **~0.3–0.6s per process**, paid 273 times |
| Watch mode | None |
| Filtering | None (no name/path filter; runs all or nothing) |
| Coverage | None |
| Retry | None |
| Snapshot support | None (golden tests hardcode frozen refs inline) |
| CI | `.github/workflows/ci.yml`: `npm run test:unit` → `tsc --noEmit` → `lint`. No DB/Plaid; no secrets. A second advisory `status-drift-guard.yml` (never blocks). |

### Measured cost

Full-suite run on this HEAD: **~130s CPU** (`user 108s + sys 22s`), **271/273 passed**. The dominant cost is **process startup, not assertion work** — a trivial `process.exit(0)` script costs ~0.3–0.6s under `tsx`, so ≥**100s of the wall time is pure cold-start overhead** before any test logic runs. A heavy test (the 777-LOC oracle) runs in ~0.6s — i.e. the *engine* is fast; the *fan-out of processes* is the tax.

**Where the runtime cost comes from:** `273 files × ~0.4s spawn/transform ≈ 110s` of fixed overhead. Actual assertion execution is a minority of wall time.

### Vitest feasibility (assessment only — not implemented)

Technically **low-friction**, with one real cost:
- **In favor:** esbuild is already the transform (Vitest uses it too); a single `@/*` → `./` path alias (trivial to map); 27 files already use `node:test`+`node:assert` and port near-mechanically; Vitest brings **parallel workers, watch, `-t` filtering, coverage, and snapshots** — directly addressing every gap above.
- **The cost:** **246 files use a bespoke `process.exit`/`check()` harness**, not `describe/it`. Running them under Vitest needs either an assertion-style migration (touch 246 files) or a thin compatibility shim. That is the real work, and it is orthogonal to the runner win.

**Recommendation (see §11):** the cheapest large win is to **parallelize the existing runner first** (a worker pool over the same `spawnSync` — no test changes, ~N× speedup). Treat Vitest as a **later, separately-scoped** migration once the 246-file harness question is decided. Vitest is *justified* on merit but should not be coupled to this cleanup.

---

## 3. KEEP / MERGE / REWRITE / RETIRE — totals

Every file classified by its **primary** verdict (sub-section rewrites inside KEEP files are noted separately).

| Verdict | C1 tx | C2 invest | C3 spaces | C4 ops | C5a fin-num | C5b sec/ai | **Total** |
|---|---|---|---|---|---|---|---|
| **KEEP** | 44 | 41 | 40 | 29 | 47 | 30 | **231** |
| **MERGE** | 1 | 1 | 0 | 12 | 1 | 0 | **15** |
| **REWRITE** | 0* | 1 | 11 | 1 | 4 | 7 | **24** |
| **RETIRE** | 0 | 0 | 2 | 0 | 0 | 0 | **2** |
| **TRIM** (partial) | 0 | 0 | 0 | 0 | 1 | 0 | **1** |
| Files | 45 | 43 | 53 | 42 | 53 | 37 | **273** |

\* C1 has **0 file-level** REWRITE but 2 KEEP files with brittle scan *sub-sections* to soften (`cash-flow-fold-authority`, `merchant-schema`). Similar sub-section watch-lists exist in C2 (`current-positions`, `crypto-instrument`) and C5a (`btc-sync`, `regenerate-history`, `transactions.privacy`, `wallet-connection`).

### RETIRE (2) — with obsolescence + coverage-elsewhere

| File | What it protected | Why obsolete | Coverage elsewhere |
|---|---|---|---|
| `components/space/shell/shell-nav.test.ts` | A one-time **SHELL_NAV migration stop-condition** ("5 untouched SegmentedControl consumers stay byte-identical + iconless") + tab-order/markup pins (`rounded-2xl border p-1.5`, `PERSPECTIVE_PILL_TOP`) | The migration shipped; the stop-condition can never fire again | Its only durable residue — icons resolve via `PERSPECTIVE_ICON_MAP` — is already held by `perspective-icons.test.ts` + `space-nav-icons.test.ts` |
| `app/api/spaces/[id]/sections/settings-and-layout.test.ts` | Exact UI copy from a **completed UX-CUST-1A** move ("Reset to default layout" absent, "Saved layouts"/"Refresh" present; Settings-tab removal) | Completed UX migration; pins user-facing strings that churn without regression | Its one durable check (personal danger-tab gated) duplicates `personal-delete-invariant.test.ts` |

### MERGE (15 files → ~5 files)

| Cluster | Files | Collapses to | Net |
|---|---|---|---|
| **Email URL builders** (`beta-invite-url`, `email-change-url`, `invite-url`, `reset-url`, `verify-url`, + `email-change-confirm` predicate) | 6 | `email/urls.test.ts` (table-driven) | −5 |
| **Email template renders** (`beta-invite`, `email-change`, `email-verification`, `notification`, `password-reset`, `security-alert`, `space-invite`) | 7 | `email/templates.test.ts` (table-driven; `notification` registry-wiring as a bespoke case) | −6 |
| `lib/transactions/liquidity-buckets.test.ts` | 1 | fold 2 numeric asserts into `dayfacts-completeness.test.ts` | −1 |
| `lib/investments/reconstruction-corp-actions.test.ts` | 1 | fold into `reconstruction-core.test.ts` (keep inversion-with-terms + checkpoint-conflict) | −1 |
| `lib/debt.test.ts` | 1 | fold literal semantics into `lib/debt.golden.test.ts` | −1 |

The two email merges alone **collapse 13 micro-suites (~700 LOC) into 2 files with zero coverage loss** — the single highest-value consolidation in the repo.

### REWRITE (24) — durable invariant, brittle assertion

The recurring pattern: a real invariant is asserted by `readFileSync` + `.includes`/regex over **exact source text** (grid classes, JSX order, prop spellings, call strings, prompt phrases, copy strings), so it breaks on cosmetic refactors that change nothing observable. Representative set (full list in §8 cleanup map):

- **Six Workspace-extraction ratchets** (`DebtWorkspace`, `LiquidityWorkspace`, `WealthWorkspace`, `InvestmentsWorkspace`, `CashFlowWorkspace`, `workspaces.test.ts`) — pin exact grid classes (`lg:col-span-7 xl:col-span-8`), JSX source-order, mount-prop spellings (`asOf=`, `presentLens=`), and call strings (`convertDebtHistory(data.history, ctx)`). **Durable core:** dual-authority (figures from canonical result, lens prose-only), workspace owns data+FX+envelope with no duplicate time authority, no double-count / crypto-once, "do-not-fake" (no IRR/Sharpe — keep that token-scan). → Assert against the already-separate pure contracts + a runtime envelope-resolver fixture + `getWorkspaceForTab(tab) → hasRenderer`.
- `space-data-historical.test.ts` (**currently RED**) — §1/§4 pin imports of the **dead** `/investments/time-machine` route. → Bind to the live `/investments/space-data` route.
- `btc-sync.test.ts` — ~50 regex/`indexOf`-order/call-count pins over `btc-sync.ts` internals. Keep behavioral PART A/E–H.
- `attribution-guardrail.kd18.test.ts` + `currency-presentation.mc1.test.ts` — verbatim AI-prompt-phrase snapshots. → Extract prompt builders to a pure module; assert honesty at runtime.
- `sync/wallet-status.test.ts` — exact `ConnectionCard.tsx` copy strings. Keep the durable "no background-retry promise on the wallet branch."
- `virtual-sections.test.ts` — `JSON.stringify(wealth.widgets) === [exact order]` → set-membership + keep the widget-key real/implemented/non-deprecated parity.
- Plus: `space-shell` (keep the "imports no domain logic" scan; rewrite layout pins to a type-level slot-API check), `AccountsPerspective`, `workspace-resources`, `space-shell-seams`, `transactions-redesign`, `SegmentedControl`, `FloatingNavWrapper`, `import-ui`, `TransactionDetailDrawer`, `transactions.privacy` (`salQueryCount === 5`), `regenerate-history`.

---

## 4. Source-scan audit

102 files read source. Classified by intent:

| Classification | ~Count | Verdict posture |
|---|---|---|
| **DURABLE_SEAM_TRIPWIRE** | majority (~70%+ of scanning files) | **Keep as scan** — runtime/type test would be weaker or impossible |
| **IMPLEMENTATION_PIN** | ~15–18 files (dominant or sub-section) | **Rewrite** to behavioral/type/registry |
| **COMMENT_PIN** | a few (`wallet-connection` PART C, `merchant-schema` header) | **Rewrite** (fails on rewording) |
| **MIGRATION_ARCHAEOLOGY** | ~4 (the 2 RETIREs + sub-sections in `authorize`, `space-shell-seams`, `account-count` negatives) | **Retire/Trim** the archaeology |
| **DUPLICATE_PROTECTION** | small (`btc-sync` PART D vs `wallet-position-capture` PART B scan same file) | Consolidate the *scan*, keep both runtime cores |

### Why the high share is mostly legitimate

The scans that should **stay scans** enforce properties a standalone `tsx` runtime test genuinely cannot reach cheaply:
- **Wiring-at-every-callsite** — `security-surface.test.ts` (rate-limit wired at *every* sensitive route, admin-freshness on destructive routes, `/api/health` references no secret); `authorize-visibility` (5 import routes on one guard).
- **Import-graph purity** — `marketing-boundary` (no `@prisma/client`/`@/lib/db`/`@/lib/auth` in the marketing tree); `perspective-engine` purity; `space-shell` domain-agnosticism.
- **FK/schema shape** — `deletion-safety` (`onDelete: SetNull` not Cascade); `merchant-schema` write-site confinement.
- **DB-coupled bindings** — most C2 scans target Prisma-coupled loaders not exercisable in `tsx`.

### Exact tests that should convert

| Convert to… | Tests |
|---|---|
| **Runtime behavior** | The six Workspace ratchets → runtime envelope-resolver + `getWorkspaceForTab`; `attribution-guardrail`/`currency-presentation` → extract prompt builders, assert at runtime; `AccountsPerspective` chip helpers |
| **Type-level** | `space-shell` prop pins → `SpaceShellProps` slot-API type check; `space-data-historical` already half type-level |
| **Registry assertion** | `virtual-sections` exact-order arrays → set-membership over the registry; `workspace-definition` exact-standard-set (§11a) |
| **Pure-function** | `btc-sync` order/count pins → assert on `buildWalletObservedFacts` outputs; `regenerate-history` ternary pins → behavioral |

---

## 5. Duplicate invariant map

Grouped by invariant. **The dominant pattern is complementary layering, not redundancy** — the same rule is legitimately re-checked at *different modules/seams*.

| Invariant | Protected at (complementary — KEEP all) | Genuine redundancy? |
|---|---|---|
| **False-green freshness** (green job over stale/empty archive ≠ fresh) | `resource-freshness.test` (authority) · `provider-health.test` (STALE catch, consumes S1) · `alerts.test` (empty+blocked → no false-red) | No — three different modules |
| **crypto-once / no double-count** | `portfolio-series` (two-bucket series) · `valuation.investment-bucket` (net-worth exclusion) · `historical-splice` (A8 replaces held-flat) · `liquidity`/`transfer-matching`/oracle | Minor: `btc-sync` PART D scan ≈ `wallet-position-capture` PART B scan (same file) — consolidate the scan only |
| **current vs historical separation** | `space-data-core`/`-composition` · `space-data-historical` (type) · `current-positions-core` | No |
| **FX conversion / display-currency (no symbol-only relabel)** | `money/convert` (apply) · `fx/service` (resolve) · 3× `display-conversion` (debt-drop / liquidity-recompute / wealth-fxMiss — **distinct miss-semantics**) · `stamp-conversion` | No — each a distinct transform |
| **URL / time authority** | `space-url` (pure) · `space-url-authority` (one history-writer / one popstate) · `space-shell-seams` (no `useSearchParams`) | Minor overlap: `space-shell-seams` dup of url-authority "no searchParams" |
| **Workspace identity / primary-destination-resolves-workspace** | `workspace-definition` (registry) · `workspaces.test` (per-tab renderer) | The 6 ratchets partly re-pin this via layout — collapses into REWRITE |
| **privacy / no-leak** | 4 disjoint WHERE-builder/route suites + AI-assembler privacy | No — disjoint surfaces |
| **authz gate** | `policy.test` (480-combo oracle) · `authorize.test` · `security-surface` (wiring) | No — matrix vs delegation vs wiring |
| **debt rollup** | `debt.test` (literals) · `debt.golden` (FX equivalence) | **Yes → MERGE** |

---

## 6. Dead-code tests

Cross-referenced against `docs/audits/architecture-audit-2026-07-16.md` §3 (the P0 dead pairs). **Finding: no test's sole purpose is keeping a dead surface green.**

| Dead surface (per code audit) | Reachability (verified) | Test that pins it? |
|---|---|---|
| **Investments time-machine hook + route** (`useInvestmentsTimeMachine`, `/investments/time-machine/route.ts`) | Hook referenced **only in comments**; route's only fetcher is the dead hook. **The A10 *engine* (`getInvestmentsTimeMachine`/`loadInvestmentsHistory`) is LIVE** — reached via `InvestmentsWorkspace → useInvestmentsSpaceData → /space-data → loadInvestmentsSpaceData`. | **One coupling only:** `space-data-historical.test.ts` §4 source-scans the dead route's imports. → **REWRITE** (and it is **currently RED**, §11a). No golden test defends the dead route. The two `investments-time-machine*.test.ts` scan/drive the **LIVE** engine → KEEP. |
| **Widget-registry query API** (`getWidgetEntry`, `getAllWidgets`, `getWidgetsForTab`, `isWidgetImplemented`, `isDeprecatedAlias`) | Dead (0 non-test refs); `getWidgetMeta` is the only live consumer | **No test depends on it** — `virtual-sections`/`registry` use the Map's `.get`/`.has` directly. Code cleanup needs **no test change**. |
| **Provider adapter seam** (`plaidAdapter`) | Dead (defined, never imported) | **No test touches it.** |
| **AiAdvice** (zero write paths) | Written only by `prisma/seed.ts`; no production writer | **No test pins it** — grep across `lib/ai/**` + `app/api/ai/**` tests is empty. If AiAdvice is deleted, **no test breaks**. |
| **`lib/data/snapshots.ts` `getSnapshotAsOf`/`getPortfolioHistory`** | Dead (no importers) | Only a passing phrase in a `WealthWorkspace.test` scan — no dependency. |

**Conclusion:** the dead surfaces can be deleted by the code-invalidation track **independently**; the only implied test edit is the one **REWRITE** (`space-data-historical` §4). This *refines* the code-audit's loose "golden tests keep it green" — it is a single source-scan sub-section, currently failing, not a golden contract.

---

## 7. Financial tests

Treated as load-bearing. **Result: 0 RETIRE across the entire financial surface.** C1 (transactions, 44/45 KEEP) and C5a (financial-numeric, 47/53 KEEP) are the healthiest clusters — overwhelmingly behavioral, executing real production functions.

Independent correctness coverage explicitly **preserved** (not merged away):
- **Financial Doctrine Oracle** (777 LOC) — KEEP; the freeze on `BANKING_FLOWS`/`isNonEconomicResidue`.
- **projection/fold parity** — `cash-flow-fold-authority` (behavioral half KEEP; scan half REWRITE), `cash-flow-projection`, `dayfacts-completeness`.
- **FX correctness** — `money/*` five-file layering all KEEP (`context-batch` equivalence gate held nowhere else); `fx/*` pipeline all KEEP.
- **valuation/reconstruction** — `valuation-core`, `reconstruction-core`/`-read`/`-runner` all KEEP (distinct modules).
- **completeness/trust** — `investments-trust`, `cash-flow-compare`, `valuation-core` honesty tiers.
- **crypto-once** — defended from ≥2 independent code paths; all KEEP.
- **current/historical contract separation** — `space-data-*` family KEEP.
- **transfer semantics** — `transfer-evidence`/`-write`, `transfer-matching`, `RelationshipResolver` KEEP.
- **flow population** — `flow-predicates`, `flow-classifier`, `data/transactions.population` KEEP.

The only financial moves are **1 intra-debt MERGE**, **soften brittle scan sub-sections** (btc-sync, regenerate-history), and **trim now-`tsc`-caught legacy negatives** — none drops a runtime correctness assertion.

---

## 8. Architecture ratchets — cleanup map

Of the ~20 space/ops source-scan ratchets: **~9 durable-dominant, ~9 brittle-dominant, ~2 pure archaeology.**

| Ratchet | Durable rule it protects | Brittle part | Action |
|---|---|---|---|
| `workspace-definition.test.ts` | ONE `WORKSPACE_REGISTRY`; every primary destination registered; shell registry-agnostic; discriminator kinds | Exact `kind:standard set === {6}` — **broke** when OPS-5 platform workspaces joined | **REWRITE line** → scope to `domain !== "platform"` or superset check (§11a) |
| 6× Workspace-extraction ratchets | Dual-authority, own data+FX+envelope, no double-count, do-not-fake | Exact grid/JSX-order/prop/call-string pins | **REWRITE** → pure contracts + runtime resolver |
| `space-shell.test.ts` | **Shell imports no domain/FX/URL/time logic** (a real boundary) | `max-w-5xl mx-auto`, render-ladder, prop strings | **Split**: keep purity scan, rewrite layout → type-level slot API |
| `space-url-authority.test.ts` | One history-writer, one popstate, derived `cashFlowPeriod` | — | **KEEP** (only a scan can hold "one authority") |
| `perspective-engine/*` purity | No `@/lib/db`/`@prisma/client` in engine; name-freedom | — | **KEEP** (gold standard) |
| `platform-surface.test.ts` | No customer-axis gating; `spaceMember.create` absent; seed `update:{}` | — | **KEEP** (durable seam) |
| `marketing-boundary` / `deletion-safety` / `security-surface` | Import allowlist / FK SetNull / rate-limit-at-every-route | — | **KEEP as scan** (runtime strictly weaker) |
| `job-health`/`run`/`dispatch`/`notification-retry`/`cleanup`/`s3-workloads` | Single-detector, append-only ledger, single-cron, one-consumer | `dispatch` exact cron string; `wave2` emit array-order | **KEEP** (soften the 2 exact lines) |
| `shell-nav.test.ts` | (migration stop-condition) | entire file | **RETIRE** |
| `settings-and-layout.test.ts` | (completed UX copy) | entire file | **RETIRE** |
| `space-shell-seams.test.ts` | Rail derived from `spaceType`; no `useSearchParams` | `renderHero`-removal archaeology | **REWRITE** (collapse to the 2 durable checks) |
| `merchant-schema.test.ts` | Write-site confinement (no global prisma handle to merchant tables) | Stale header + enum/index enumeration | **REWRITE** header + thin enum pins; keep confinement |

**Durable litmus that held up:** "SpaceShell imports no domain business logic" and "every primary destination resolves to a Workspace" are *real* rules worth a tripwire. "Component X lives in file Y / exact JSX string exists / exact host import appears" are layout pins → rewrite to registry/runtime/type assertions.

---

## 9. Test consolidation plan

Not a forced restructure — the existing colocation-with-source convention is sound and should stay. Two concrete groupings:

1. **`lib/email/` → 2 files.** Collapse 6 URL-builder suites + 7 template-render suites into `email/urls.test.ts` and `email/templates.test.ts` (table-driven). 13 files → 2, ~700 → ~350 LOC, zero coverage loss.
2. **Shared harness extraction (files stay separate).** `notifications/wave{1,2,3}` re-declare identical `makeClient()`/`prefsWith()` fakes; the display-conversion / space-data families re-declare `check`/`near` helpers. Extract to `scripts/lib/test-harness.ts` (or a colocated `__fixtures__`) — reduces LOC without merging distinct suites. (This is also the natural shim seam if Vitest is later adopted.)

A tiers view (`financial-doctrine`, `spaces-architecture`, `operational-architecture`, `authz`, `provider`, `history`, `pure-core`) is a useful **mental map** for §5's invariant ownership, but physically moving files would break the colocation convention for no test-quality gain — **not recommended**.

---

## 10. Quantified likely reduction

*Honest estimate — not optimized to a target.*

| Bucket | Files | LOC (approx) |
|---|---|---|
| **KEEP** | 231 | ~33,000 |
| **REWRITE** (in place — no count change) | 24 | net small (brittle lines removed, files stay) |
| **TRIM** (partial — file stays) | 1 | −~30 |
| **MERGE** (15 files → ~5) | −10 net | −~500 (email dedup dominates) |
| **RETIRE** | −2 | −~330 |
| **Source-scan files removable outright** | ~2 (the 2 RETIREs) | — |
| **Dead-code tests removable** | **0** (dead surfaces un-pinned; 1 REWRITE, not a removal) | — |
| **Expected file count after cleanup** | **~258** (273 − ~15) | |
| **Expected LOC reduction** | | **~1,000–1,500 (~3–4%)** |

**Reduction is modest by design** — the suite's problem is *assertion brittleness and runner overhead*, not file-count bloat. The high-leverage wins are the **email merge** (−11 files) and **fixing/rewriting the ~24 brittle-pin files in place** (quality, not count).

---

## 11. Final verdicts

| Question | Verdict | Basis |
|---|---|---|
| **Test suite materially bloated?** | **PARTIAL** | 85% KEEP; bloat is localized to 12 email micro-suites + ~24 brittle-pin files + runner overhead — not systemic |
| **Meaningful migration-only tests remain?** | **YES** | 2 file-level (shell-nav, settings-and-layout) + archaeology sub-sections in ~4 KEEP files |
| **Source-scan share too high?** | **PARTIAL** | 37% is a high *raw* share, but the majority are durable seam tripwires; only ~9–15 files are brittle-dominant scans |
| **Dead-code tests exist?** | **NO** | No test's purpose is keeping a dead surface green; the one dead-route coupling is a REWRITE (currently red) |
| **Duplicate invariant coverage exists?** | **YES** | But overwhelmingly complementary layering; genuine redundancy is ~3 files (debt.test, liquidity-buckets, btc-sync scan) |
| **Runner architecture inefficient?** | **YES** | Sequential, one process per file, ~130s CPU dominated by 273× tsx cold-start; no parallelism/watch/filter/coverage |
| **Vitest migration justified?** | **PARTIAL** | Justified on merit, but 246 bespoke-harness files are the real cost — parallelize the current runner *first*, sequence Vitest separately |
| **Safe to begin high-confidence test cleanup?** | **YES** | For the high-confidence set (below). Defer dead-route decoupling until the code deletes the route. |

**Estimated test files that can be retired/merged: 12–18** (2 RETIRE + ~13 MERGE-collapse; suite 273 → ~258).

### 11a. The two current failures (act first — CI is red on this branch)

Both are **brittleness on legitimate change**, and both are the audit's thesis in miniature:

1. **`lib/perspectives/workspace-definition.test.ts`** — `check("kind:standard set === {overview,transactions,accounts,activity,members,goals}")` fails because `WORKSPACE_REGISTRY` now spreads in `...PLATFORM_WORKSPACES` (5 OPS-5 platform workspaces with `kind:"standard"`, `domain:"platform"`). The registry legitimately grew to 11 standard-kind entries; the exact-set line pins exactly 6. **Fix:** scope the assertion to `domain !== "platform"` (or make it a superset check). The durable "these 6 are standard, the perspectives are not" survives untouched.
2. **`lib/investments/space-data-historical.test.ts`** — `ReferenceError: route is not defined` at line 99: a source-scan variable (`route`, from the **dead** `/investments/time-machine` route) is no longer defined. This is precisely the dead-route coupling from §6. **Fix (REWRITE):** bind §4 to the live `/investments/space-data` route.

These two are the strongest evidence in the audit: **brittle pins fail on refactors and legitimate growth, not on regressions** — exactly the assertions the cleanup targets.

### 11b. Recommended sequencing

1. **Now (green the branch):** fix the 2 red tests per §11a (both are REWRITE-in-place, no coverage loss).
2. **High-confidence cleanup (safe today):** RETIRE the 2 archaeology files; MERGE the 13 email suites → 2; MERGE `liquidity-buckets`/`corp-actions`/`debt.test`; TRIM the `account-count` legacy negatives; extract the shared notification/display harness.
3. **Runner win (no test changes):** parallelize `scripts/run-tests.ts` with a worker pool.
4. **After the code-invalidation track deletes the dead route/hook/widget-API/adapter/AiAdvice:** decouple `space-data-historical` §4 (already covered by step 1).
5. **Medium-confidence, batched:** the remaining ~22 REWRITEs — soften implementation-pin scans to runtime/type/registry assertions, one cluster at a time, each behind its own green run.
6. **Later, separately scoped:** evaluate Vitest once the 246-file harness decision is made.

---

## Appendix — per-cluster verdict detail

Full per-file tables were produced for all 273 files. Condensed cluster results:

- **C1 transactions (45):** KEEP 44, MERGE 1 (`liquidity-buckets`→`dayfacts-completeness`), RETIRE 0. 44/45 execute runtime. Sub-section REWRITEs: `cash-flow-fold-authority`, `merchant-schema`. Financial-doctrine core fully load-bearing.
- **C2 investments (43, 5,511 LOC):** KEEP 41, MERGE 1 (`reconstruction-corp-actions`→`reconstruction-core`), REWRITE 1 (`space-data-historical`), RETIRE 0. A10 engine LIVE; hook+route dead but un-pinned. btc-double-count defended from 2 paths.
- **C3 spaces (53):** KEEP 40, REWRITE 11, RETIRE 2 (`shell-nav`, `settings-and-layout`). Ratchet split 9 durable / 9 brittle / 2 archaeology. Widget-registry dead API not test-depended.
- **C4 ops (42):** KEEP 29, MERGE 12 (email → 2 files), REWRITE 1 (`wallet-status`), RETIRE 0. Dormant `quota-low` correctly tested as *containment*, not dead. False-green invariant is layered across 3 seams (not duplicated).
- **C5a financial-numeric (53):** KEEP 47, MERGE 1 (`debt.test`→`debt.golden`), REWRITE 4 (soften scans), TRIM 1 (`account-count` negatives), RETIRE 0. Zero dead surface. Near-parallel FX/display families confirmed distinct (drop / recompute / fxMiss).
- **C5b security/ai/misc (37):** KEEP 30, REWRITE 7 (UI/prompt text pins), RETIRE 0. AiAdvice dead but un-pinned. Four security/schema scans (surface, marketing-boundary, deletion-safety, ai-privacy) are durable keep-as-scan tripwires.
