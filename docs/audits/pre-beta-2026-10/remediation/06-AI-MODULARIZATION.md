# 06 — AI Tools Modularisation (CQ-011, owner decision 6)

Detail: `agent-reports/H-ai-modularization.md` (full inventory with original line ranges, every moved pin, dependency check). Integrated at `06212e6`; full gate green there and at every later integration (`01098bd`: unit 828/828, all suites).

## 1. Result

`lib/ai/conversation/tools.ts`: **4,782 lines → 128-line registry** (the stable public facade). The tools and helpers moved **verbatim** into 21 modules; only import lines were regenerated, plus `export` where another module now uses a declaration. A line-by-line comparison found none of the 4,467 original non-blank, non-import lines missing.

| Module | Responsibility | Lines | Tools |
|---|---|---|---|
| `tools.ts` | registry: `TOOLS` (same order), `openAiToolSchemas`, `findTool`, re-exports | 128 | — |
| `tools/types.ts` | the contract: `ToolContext`, `ToolDefinition`, `CashSpineReads` | 140 | — |
| `tools/shared/` (7) | read windows, value/schema/origin helpers, historical snapshot, cash spine | 556 | — |
| `tools/snapshot.ts` | positions and composition | 180 | `get_financial_snapshot`, `explain_net_worth_composition` |
| `tools/spending.ts` | category spending | 135 | `get_spending` |
| `tools/measures.ts` | measured flows and baselines (FIN-001 continuation wiring) | 444 | `measure_flows`, `get_baselines` |
| `tools/transactions.ts` | transaction reads (SEC-AI-005 scrub) | 241 | `get_transactions` |
| `tools/income.ts` | income streams and pay dates (FIN-001) | 104 | `get_income`, `get_pay_dates` |
| `tools/investments.ts` | holdings and the investment scenario | 149 | `get_investments`, `investment_scenario` |
| `tools/history.ts` | balance history and exact temporal predicates | 425 | `get_net_worth_history`, `find_in_balance_history` |
| `tools/projection.ts` | cash projection, incompleteness bound, reconcile (FIN-001) | 634 | `project_cash`, `reconcile_projection` |
| `tools/scenario/` (5) | scenario setup, run, goal seek, staging, presentation | 2,150 | `scenario_projection`, `scenario_crossing`, `scenario_goal_seek`, `stage_assumptions` |
| unchanged homes | `product.ts`, `memory-tools.ts` | — | `describe_fourth_meridian`, memory tools |

## 2. Contract preserved (evidence)

- **Characterisation first** (`f7917f9`, green on the unchanged code): `lib/ai/conversation/tools-characterization.test.ts` pins the ordered tool names, `findTool` resolution, the full public export surface, and behavioural cases for moved pure helpers.
- **`openAiToolSchemas()` (21 tools) is byte-identical** to the committed snapshot at every commit — the model-facing contract (names, descriptions, JSON input schemas) did not change.
- No caller outside `tools/**` changed its import path (`engine.ts`, `turn.ts`, `brief/recent-activity.ts`, `scripts/ai-baseline/*`, `scripts/rls-ai-acceptance.ts`).
- Authorisation and tenancy: tools still take no `spaceId`/`userId`; scope comes from `ToolContext`. `rls:accept:ai` 72/72 on the integrated branch. Allowance and kill switch never lived in this module; `rls:accept:allowance` 15/15.
- Recent fixes intact and pinned: SEC-AI-005 scrub (`tools/transactions.ts`), FIN-001 wiring (`tools/projection.ts`, `measures.ts`, `income.ts`; `fin001-wiring.test.ts`).

## 3. Dependency structure

No module imports the registry; no domain module imports another domain module; the scenario tools share only their own setup/presentation (intentional); no runtime import cycle touches the tool layer.

## 4. Test pins moved

20 source-scan tests read `tools.ts` by path. They now read the whole tool layer through `lib/test-support/tools-source.ts`, which **fails if a module under `tools/` is missing from its list**, so a new module cannot escape the "no Prisma client / no write op" scans. Two latent test defects surfaced and were fixed: a slice in `scripts/ai-baseline/baseline.test.ts` that would have become empty (passing vacuously) after the split now asserts non-emptiness; another slice that always ran to end-of-file was bounded correctly.

## 5. Residual

- `tools/scenario/setup.ts` (903 lines) is the next candidate; splitting `prepareScenario` requires changing code, not moving it, so it was left.
- A few scans slice between anchors that now live in different modules; they depend on the file order in `tools-source.ts` (original section order).
- `next build` (Turbopack) of the integrated HEAD compiles cleanly with `tools.ts` beside `tools/` (`01098bd`).
