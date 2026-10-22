# Agent H — AI architecture modularisation (CQ-011)

Branch `remediation/h-ai-modularization`, cut from `57de6aa`. Local commits only; nothing pushed or merged. No AI provider was called and no database was touched.

## Outcome

`lib/ai/conversation/tools.ts` is now a thin registry. It went from **4,782 lines to 128**: the original header (ARCH-012 text kept) plus a CQ-011 module map, `TOOLS` in the same order, `openAiToolSchemas`, `findTool`, and re-exports of every name it exported before.

The 18 local adapters and their helpers moved **verbatim** into 21 modules under `lib/ai/conversation/tools/`. Only two kinds of edit were made to moved code:
- import lines were regenerated;
- `export` was added to a declaration that another module now imports.

Results:
- **Behaviour:** zero change. The `openAiToolSchemas()` snapshot (21 tools, 111,734 bytes) is byte-identical at every commit.
- **Import paths:** no caller outside `tools/**` changed its import path.
- **Dependencies:** no module imports the facade, and no domain module imports another domain module.

## Method

1. **Inventory** of every top-level declaration (below). It was produced by parsing the file with the TypeScript compiler API and resolving identifiers through the binder, so a local `str` or `measure` that shadows a top-level name is not counted as a reference.
2. **Characterisation tests first** (`f7917f9`), green on the unchanged module:
   - `lib/ai/conversation/tools-characterization.test.ts` pins the ordered names and the exact `openAiToolSchemas()` output against `lib/ai/conversation/__snapshots__/tool-schemas.json`, byte-for-byte. Regenerating it needs `FM_WRITE_TOOL_SCHEMA_SNAPSHOT=1`.
   - It also pins `findTool` (resolves all 21 names; returns `undefined` for unknowns), the runtime export surface (10 names), and the type exports at compile time.
   - Pre-split outputs are pinned for `clampToCeiling`, `interestModelledLiabilityIds`, `rebindDerivedFloors` (base level, cut, zero), `rebindDerivedFloorsByDate`, the month-end and year-end grids, and `readWindowToExhaustion` (exhausted and non-advancing cursor).
3. **Pin moves on the unchanged module** (`371316b`). The source scans now read the tool layer through `lib/test-support/tools-source.ts`. On that commit the layer was still the single file, so every scan read exactly what it read before.
4. **A generator** (scratch-only, not committed) regenerated the facade and the modules from the ORIGINAL file at each step:
   - each declaration's full text, including its leading comments, is moved byte-for-byte;
   - each module's imports are computed from what that module references;
   - three section markers were relocated so that they stay with their section: `1. Snapshot` and `7. Net-worth explanation` went to `snapshot.ts`, and `Registry` stayed in the facade.
   - A line-multiset check confirmed that **0 of the 4,467 non-blank, non-import original lines are missing** from the split.
5. **One commit per domain.** Each step got typecheck, eslint on the layer, the dependency check, and 34 test files run one at a time. The final state got the 175-file run listed below.

## Inventory (pre-split `tools.ts` at `f7917f9`, 4,782 lines)

### Header, imports and sections

- **Header** (l.1–33): ARCH-012 registry-is-the-count; adapters, not authorities; read and calculate only, with one named exception; the user's vocabulary.
- **Imports:** 47 import declarations. They sit at l.35–174, plus two mid-file at l.380–385 (`scenario-checkpoints`, `scenario-change`). The only declaration among them is `accessOf`.
- **Side effects:** none at module scope. Every top-level statement is a declaration. There is no Prisma client and no write op. The value import of `@/lib/ai/absence` is a capability derived from `ctx.readClient`.

**Sections:**

| Line | Section |
|---|---|
| 178 | The tool contract |
| 419 | 1. Snapshot |
| 565 | 2. Spending |
| 679 | 3. Transactions |
| 893 | 4. Income |
| 954 | 4b. Measures |
| 1342 | 5. Investments |
| 1415 | 6. Net-worth history |
| 1590 | 6b. Temporal facts |
| 1770 | 7. Net-worth explanation |
| 2082 | 8. Cash projection (and the AI-RELIABILITY income term) |
| 2484 | 9. Pay dates |
| 2505 | 10. Investment scenario |
| 2559 | 11. Scenario |
| 3868 | 11b. Crossing |
| 4059 | 12. Goal seek |
| 4448 | 13. Reconciliation |
| 4635 | Registry |
| 4637 | "12." Staging |

### Exports, registry and importers

- **Exports:**
  - interfaces `CashSpineReads`, `ToolContext`, `ToolDefinition`;
  - type `TransactionPager`;
  - `readWindowToExhaustion`, `clampToCeiling`;
  - re-exports `monthEndsBetween`, `yearEndsBetween`;
  - `interestModelledLiabilityIds`, `rebindDerivedFloors`, `rebindDerivedFloorsByDate`;
  - `TOOLS`, `openAiToolSchemas`, `findTool`.
- **`TOOLS`** (l.4761): 18 local definitions, then `...MEMORY_TOOLS` (`recall`, `remember`), then `describeFourthMeridian`, giving 21 tools.
- **Importers:**
  - production: `engine.ts`, `turn.ts`, `memory-tools.ts` (type), `product.ts` (type), `lib/ai/brief/recent-activity.ts` (dynamic `readWindowToExhaustion`);
  - tests: 14 in `lib/ai/conversation/*.test.ts`, plus `lib/transactions/category-spend-authority.test.ts`, `scripts/ai-baseline/*.check.ts` (×15) and `baseline.test.ts`;
  - `scripts/rls-ai-acceptance.ts`.
- **Tests that read the file by path:** the 20 files listed under "Moved pins".

### Top-level declarations

"Used by tool(s)" is transitive through helpers. "Imports used" is the number of imported names the declaration references.

| Lines | Declaration | Kind | Exported | Used by tool(s) | Imports used | Now in |
|---|---|---|---|---|---|---|
| 128–131 | `accessOf` | Function |  | get_financial_snapshot | 2 | tools/snapshot.ts |
| 190–195 | `CashSpineReads` | Interface | yes | 18 of 18 tools | 4 | tools/types.ts |
| 197–276 | `ToolContext` | Interface | yes | 18 of 18 tools | 6 | tools/types.ts |
| 278–284 | `ToolDefinition` | Interface | yes | 18 of 18 tools | 0 | tools/types.ts |
| 286–287 | `obj` | const |  | 18 of 18 tools | 0 | tools/shared/schema.ts |
| 288–288 | `str` | const |  | 16 of 18 tools | 0 | tools/shared/schema.ts |
| 289–289 | `num` | const |  | get_transactions, get_baselines, get_net_worth_history, find_in_balance_history, project_cash, investment_scenario, scenario_crossing, scenario_goal_seek | 0 | tools/shared/schema.ts |
| 291–291 | `round2` | const |  | get_baselines, get_net_worth_history, project_cash, reconcile_projection, scenario_projection, scenario_crossing, scenario_goal_seek | 0 | tools/shared/values.ts |
| 293–293 | `isoDay` | const |  | find_in_balance_history | 0 | tools/shared/values.ts |
| 295–301 | `addYearsISO` | const |  | scenario_crossing | 0 | tools/shared/values.ts |
| 303–303 | `SNAPSHOT_READ_ROWS` | const |  | get_financial_snapshot, get_investments, project_cash, scenario_projection, scenario_crossing, scenario_goal_seek, reconcile_projection, get_net_worth_history, find_in_balance_history | 0 | tools/shared/values.ts |
| 305–305 | `MAX_DAILY_POINTS` | const |  | get_net_worth_history | 0 | tools/shared/values.ts |
| 333–333 | `TransactionPager` | TypeAlias | yes | get_transactions | 1 | tools/shared/read-window.ts |
| 335–360 | `readWindowToExhaustion` | Function | yes | get_transactions | 6 | tools/shared/read-window.ts |
| 369–369 | `clampToCeiling` | const | yes | get_spending, get_transactions, get_income, measure_flows, get_baselines, get_net_worth_history, find_in_balance_history, explain_net_worth_composition | 0 | tools/shared/values.ts |
| 371–372 | `daysAgoISO` | const |  | get_spending, get_income, get_net_worth_history | 0 | tools/shared/values.ts |
| 379–379 | `<export>` | Export |  | — | 1 | tools.ts (facade) |
| 384–384 | `<export>` | Export |  | — | 1 | tools.ts (facade) |
| 401–403 | `absentIn` | const |  | get_financial_snapshot, get_investments, project_cash, scenario_projection, scenario_crossing, scenario_goal_seek, reconcile_projection, get_spending, get_net_worth_history, find_in_balance_history, investment_scenario | 1 | tools/shared/reads.ts |
| 405–417 | `assemble` | Function |  | 13 of 18 tools | 1 | tools/shared/reads.ts |
| 431–495 | `historicalSnapshot` | Function |  | get_financial_snapshot, get_investments, project_cash, scenario_projection, scenario_crossing, scenario_goal_seek, reconcile_projection | 4 | tools/shared/historical-snapshot.ts |
| 497–563 | `getFinancialSnapshot` | const |  | (is get_financial_snapshot) | 4 | tools/snapshot.ts |
| 567–677 | `getSpending` | const |  | (is get_spending) | 5 | tools/spending.ts |
| 699–699 | `COMPLETABLE_SEARCH_ROWS` | const |  | get_transactions | 0 | tools/transactions.ts |
| 701–708 | `FLOW_SETS` | const |  | get_transactions | 1 | tools/transactions.ts |
| 710–891 | `getTransactions` | const |  | (is get_transactions) | 9 | tools/transactions.ts |
| 895–952 | `getIncome` | const |  | (is get_income) | 4 | tools/income.ts |
| 962–966 | `PERIOD_SHAPE` | const |  | measure_flows, get_baselines | 0 | tools/measures.ts |
| 967–974 | `PERIOD_SCHEMA` | const |  | measure_flows | 0 | tools/measures.ts |
| 976–977 | `FlowRead` | Interface |  | measure_flows, get_baselines | 1 | tools/measures.ts |
| 980–988 | `toMonthRows` | Function |  | measure_flows, get_baselines | 2 | tools/measures.ts |
| 991–1005 | `readFlowMonths` | Function |  | measure_flows, get_baselines | 2 | tools/measures.ts |
| 1016–1041 | `flowCoverage` | Function |  | measure_flows, get_baselines | 6 | tools/measures.ts |
| 1051–1057 | `resolveCategoryArg` | Function |  | measure_flows | 1 | tools/measures.ts |
| 1059–1059 | `CATEGORY_VOCABULARY_UNSUPPORTED_LIST` | const |  | measure_flows | 1 | tools/measures.ts |
| 1062–1068 | `CATEGORY_ARG_DESCRIPTION` | const |  | measure_flows | 1 | tools/measures.ts |
| 1070–1143 | `measureFlows` | const |  | (is measure_flows) | 9 | tools/measures.ts |
| 1145–1340 | `getBaselines` | const |  | (is get_baselines) | 23 | tools/measures.ts |
| 1344–1413 | `getInvestments` | const |  | (is get_investments) | 4 | tools/investments.ts |
| 1417–1588 | `getNetWorthHistory` | const |  | (is get_net_worth_history) | 3 | tools/history.ts |
| 1592–1599 | `BALANCE_METRICS` | const |  | find_in_balance_history | 0 | tools/history.ts |
| 1600–1600 | `BalanceMetric` | TypeAlias |  | find_in_balance_history | 0 | tools/history.ts |
| 1602–1605 | `TEMPORAL_OPERATIONS` | const |  | find_in_balance_history | 1 | tools/history.ts |
| 1622–1768 | `findInBalanceHistory` | const |  | (is find_in_balance_history) | 6 | tools/history.ts |
| 1787–1791 | `ChangeableSnapshotPoint` | Interface |  | get_net_worth_history | 0 | tools/history.ts |
| 1792–1792 | `ChangeMetric` | TypeAlias |  | get_net_worth_history | 0 | tools/history.ts |
| 1794–1813 | `changeBlock` | Function |  | get_net_worth_history | 1 | tools/history.ts |
| 1816–1819 | `EXPLAINABLE_LENSES` | const |  | explain_net_worth_composition | 0 | tools/snapshot.ts |
| 1830–1884 | `explainNetWorthComposition` | const |  | (is explain_net_worth_composition) | 1 | tools/snapshot.ts |
| 1904–1922 | `CashSpine` | Interface |  | project_cash, scenario_projection, scenario_crossing, scenario_goal_seek, reconcile_projection | 5 | tools/shared/cash-spine.ts |
| 1924–2080 | `buildCashSpine` | Function |  | project_cash, scenario_projection, scenario_crossing, scenario_goal_seek, reconcile_projection | 16 | tools/shared/cash-spine.ts |
| 2092–2109 | `incompletenessBlock` | Function |  | project_cash, reconcile_projection | 2 | tools/projection.ts |
| 2112–2139 | `projectionQualification` | Function |  | project_cash | 2 | tools/projection.ts |
| 2142–2149 | `BASIS_FIELD_MEANING` | const |  | reconcile_projection | 0 | tools/projection.ts |
| 2161–2192 | `presentInterval` | Function |  | project_cash | 1 | tools/projection.ts |
| 2194–2482 | `projectCash` | const |  | (is project_cash) | 13 | tools/projection.ts |
| 2486–2503 | `getPayDates` | const |  | (is get_pay_dates) | 3 | tools/income.ts |
| 2507–2557 | `investmentScenario` | const |  | (is investment_scenario) | 7 | tools/investments.ts |
| 2567–2567 | `DAYS_PER_MONTH` | const |  | scenario_projection, scenario_crossing, scenario_goal_seek | 0 | tools/scenario/setup.ts |
| 2576–2576 | `ScenarioRun` | TypeAlias |  | scenario_projection, scenario_goal_seek, scenario_crossing | 3 | tools/scenario/setup.ts |
| 2579–2581 | `floorDerivationsOf` | Function |  | scenario_projection, scenario_goal_seek, scenario_crossing | 2 | tools/scenario/present.ts |
| 2584–2586 | `spendingOf` | Function |  | scenario_projection, scenario_goal_seek, scenario_crossing | 2 | tools/scenario/present.ts |
| 2588–2597 | `ScenarioOverrides` | Interface |  | scenario_projection, scenario_goal_seek, scenario_crossing | 3 | tools/scenario/setup.ts |
| 2600–2600 | `suppliedSpending` | const |  | scenario_projection, scenario_crossing, scenario_goal_seek | 0 | tools/scenario/setup.ts |
| 2603–2605 | `originOf` | Function |  | get_baselines, project_cash, scenario_projection, scenario_crossing, scenario_goal_seek | 3 | tools/shared/origin.ts |
| 2608–2609 | `ORIGIN_KEYS` | const |  | scenario_projection, scenario_crossing, scenario_goal_seek | 0 | tools/scenario/setup.ts |
| 2610–2623 | `argumentOrigins` | Function |  | scenario_projection, scenario_crossing, scenario_goal_seek | 2 | tools/scenario/setup.ts |
| 2625–2676 | `ScenarioSetup` | Interface |  | scenario_projection, scenario_goal_seek, scenario_crossing | 14 | tools/scenario/setup.ts |
| 2705–2782 | `toIncomeChangeRules` | Function |  | scenario_projection, scenario_crossing, scenario_goal_seek | 5 | tools/scenario/setup.ts |
| 2794–2840 | `toSpendingChangeRules` | Function |  | scenario_projection, scenario_crossing, scenario_goal_seek | 4 | tools/scenario/setup.ts |
| 2848–2891 | `liabilityLinesOf` | Function |  | scenario_projection, scenario_crossing, scenario_goal_seek | 4 | tools/scenario/setup.ts |
| 2899–2901 | `interestModelledLiabilityIds` | Function | yes | scenario_projection, scenario_crossing, scenario_goal_seek | 1 | tools/scenario/setup.ts |
| 2903–3340 | `prepareScenario` | Function |  | scenario_projection, scenario_crossing, scenario_goal_seek | 26 | tools/scenario/setup.ts |
| 3350–3373 | `rebindDerivedFloors` | Function | yes | scenario_projection, scenario_crossing, scenario_goal_seek | 2 | tools/scenario/setup.ts |
| 3379–3397 | `resolveFloorAt` | Function |  | scenario_projection, scenario_crossing, scenario_goal_seek | 2 | tools/scenario/setup.ts |
| 3405–3432 | `rebindDerivedFloorsByDate` | Function | yes | scenario_projection, scenario_crossing, scenario_goal_seek | 2 | tools/scenario/setup.ts |
| 3453–3470 | `surplusRule` | Function |  | scenario_projection, scenario_goal_seek, scenario_crossing | 1 | tools/scenario/present.ts |
| 3482–3520 | `floorRule` | Function |  | scenario_projection, scenario_goal_seek, scenario_crossing | 2 | tools/scenario/present.ts |
| 3535–3574 | `stagedEcho` | Function |  | scenario_projection, scenario_goal_seek, scenario_crossing | 0 | tools/scenario/present.ts |
| 3576–3677 | `scenarioAssumptions` | Function |  | scenario_projection, scenario_goal_seek, scenario_crossing | 6 | tools/scenario/present.ts |
| 3688–3725 | `liabilityEcho` | Function |  | scenario_projection, scenario_goal_seek, scenario_crossing | 3 | tools/scenario/present.ts |
| 3738–3746 | `changeSinceOpeningAt` | Function |  | scenario_projection, scenario_goal_seek, scenario_crossing | 5 | tools/scenario/present.ts |
| 3752–3797 | `presentScenario` | Function |  | scenario_projection, scenario_goal_seek | 4 | tools/scenario/present.ts |
| 3804–3807 | `SCENARIO_QUALIFICATION` | const |  | scenario_projection, scenario_goal_seek, scenario_crossing | 0 | tools/scenario/present.ts |
| 3825–3829 | `RECOMPUTE_SENTENCE` | const |  | scenario_projection, scenario_crossing | 0 | tools/scenario/run.ts |
| 3831–3866 | `scenarioProjection` | const |  | (is scenario_projection) | 1 | tools/scenario/run.ts |
| 3871–3877 | `CROSSING_METRICS` | const |  | scenario_crossing | 1 | tools/scenario/run.ts |
| 3878–3878 | `CROSSING_DIRECTIONS` | const |  | scenario_crossing | 1 | tools/scenario/run.ts |
| 3889–3889 | `CROSSING_DEFAULT_YEARS` | const |  | scenario_crossing | 0 | tools/scenario/run.ts |
| 3890–3890 | `CROSSING_MAX_YEARS` | const |  | scenario_crossing | 0 | tools/scenario/run.ts |
| 3892–4057 | `scenarioCrossing` | const |  | (is scenario_crossing) | 8 | tools/scenario/run.ts |
| 4070–4076 | `SOLVABLE` | const |  | scenario_goal_seek | 0 | tools/scenario/goal-seek.ts |
| 4079–4079 | `dayAfter` | const |  | scenario_goal_seek | 0 | tools/scenario/goal-seek.ts |
| 4090–4090 | `MAX_SOLVED_RETURN_PCT` | const |  | scenario_goal_seek | 0 | tools/scenario/goal-seek.ts |
| 4092–4446 | `scenarioGoalSeek` | const |  | (is scenario_goal_seek) | 17 | tools/scenario/goal-seek.ts |
| 4451–4451 | `MAX_RECONCILED` | const |  | reconcile_projection | 0 | tools/projection.ts |
| 4463–4465 | `METRIC_FIELD` | const |  | reconcile_projection | 0 | tools/projection.ts |
| 4467–4633 | `reconcileProjection` | const |  | (is reconcile_projection) | 12 | tools/projection.ts |
| 4655–4664 | `spendingLinesHeld` | Function |  | stage_assumptions | 1 | tools/scenario/staging.ts |
| 4666–4759 | `stageAssumptions` | const |  | (is stage_assumptions) | 4 | tools/scenario/staging.ts |
| 4761–4770 | `TOOLS` | const | yes | registry | 2 | tools.ts (facade) |
| 4773–4778 | `openAiToolSchemas` | Function | yes | registry | 0 | tools.ts (facade) |
| 4780–4782 | `findTool` | Function | yes | registry | 0 | tools.ts (facade) |

## Final module map

Paths are relative to `lib/ai/conversation/`. Line counts include each module's new header and its regenerated imports.

| File | Responsibility | Lines | Tools |
|---|---|---|---|
| `tools.ts` | Facade and registry: `TOOLS` (order is the contract), `openAiToolSchemas`, `findTool`, re-exports | 128 | — (registers all 21) |
| `tools/types.ts` | The contract: `ToolContext`, `ToolDefinition`, `CashSpineReads` | 140 | — |
| `tools/shared/schema.ts` | JSON-schema builders `obj` / `str` / `num` | 18 | — |
| `tools/shared/values.ts` | `round2`, `isoDay`, `addYearsISO`, `daysAgoISO`, `clampToCeiling`, read bounds | 42 | — |
| `tools/shared/read-window.ts` | `TransactionPager`, `readWindowToExhaustion` (also the Brief's read) | 82 | — |
| `tools/shared/reads.ts` | `absentIn` (adjudicated absence), `assemble` (assembler read on `ctx.readClient`) | 55 | — |
| `tools/shared/historical-snapshot.ts` | Position on a past date | 98 | — |
| `tools/shared/origin.ts` | `originOf`: USER_STATED / MODEL_SUPPLIED | 23 | — |
| `tools/shared/cash-spine.ts` | `CashSpine`, `buildCashSpine`: the one spine shared by projection and scenarios | 238 | — |
| `tools/snapshot.ts` | Position tools (+ `accessOf`, `EXPLAINABLE_LENSES`) | 180 | `get_financial_snapshot`, `explain_net_worth_composition` |
| `tools/spending.ts` | Spending summary | 135 | `get_spending` |
| `tools/transactions.ts` | Transaction search; the SEC-AI-005 scrub site | 241 | `get_transactions` |
| `tools/income.ts` | Income and pay dates; the FIN-001 `continuationOf` | 104 | `get_income`, `get_pay_dates` |
| `tools/measures.ts` | M1 heads, period/category helpers, flow reads; the FIN-001 `continuationOf` | 444 | `measure_flows`, `get_baselines` |
| `tools/investments.ts` | Investments | 149 | `get_investments`, `investment_scenario` |
| `tools/history.ts` | Balance history and the change block | 425 | `get_net_worth_history`, `find_in_balance_history` |
| `tools/projection.ts` | Cash projection and reconciliation; FIN-001 `incompletenessBlock` and `projectionQualification` | 634 | `project_cash`, `reconcile_projection` |
| `tools/scenario/setup.ts` | `prepareScenario`, rule conversion, liability lines, floor rebinding | 903 | — |
| `tools/scenario/present.ts` | Assumptions echo, presented table, `SCENARIO_QUALIFICATION` | 410 | — |
| `tools/scenario/run.ts` | Scenario table and crossing | 276 | `scenario_projection`, `scenario_crossing` |
| `tools/scenario/goal-seek.ts` | Goal seek | 417 | `scenario_goal_seek` |
| `tools/scenario/staging.ts` | Planning continuity | 144 | `stage_assumptions` |
| `memory-tools.ts` (unchanged) | The one write path | — | `recall`, `remember` |
| `product.ts` (unchanged) | Product self-description | — | `describe_fourth_meridian` |

Before and after:

| | Before | After |
|---|---|---|
| `tools.ts` | 4,782 lines | 128 lines |
| Tool layer in total | 4,782 lines | 5,286 lines |
| Largest module | 4,782 lines | 903 lines (`scenario/setup.ts`) |

The 504 added lines are:
- the 21 module headers;
- regenerated imports;
- import comments duplicated into each module that uses the import (for example "THE ABSENCE CONTRACT … this file still holds no Prisma client", which holds per file);
- the facade's re-export block and module map.

## Dependency check

The check walks the value and type imports of the facade plus `tools/**` across 403 reachable modules, including dynamic `import()`.

| Check | Result |
|---|---|
| `tools/**` → facade imports | **0** |
| Cross-domain imports between domain modules | **0** |
| Intra-scenario imports | 5, by design: `run` and `goal-seek` → `setup` and `present`; `present` → `setup` |
| Runtime import cycles touching the tool layer | **0** |

- **Intra-scenario imports.** These share the one setup and the one presentation that the scenario scans require. They are not cross-domain.
- **`memory-tools.ts` and `product.ts`.** They still `import type { ToolDefinition } from './tools'`. That import is type-only and erased, so the facade → `memory-tools` / `product` edges create no runtime cycle. It is the same as before the split; their import paths were left alone, per the brief.
- **Other cycles.** The reached graph contains 2 runtime cycles elsewhere in `lib/`, neither involving the tool layer. They existed before.

The module map is also written into the facade header.

## Moved pins

Every move is deliberate, and none weakens what the scan asserts. Negative scans got broader, because they now cover every module of the layer.

The helper is `lib/test-support/tools-source.ts`:
- `readToolsSource()` returns the facade plus every module, concatenated in original section order.
- `toolsSourceFiles()` returns the per-file list.
- It **throws if a `.ts` under `tools/` is not listed**, so no new module escapes the "no Prisma client / no write op / one call site" scans.

| File | Move |
|---|---|
| `lib/ai/asset-valuations-ai.test.ts` | Reads the tool layer (2 sites). |
| `lib/ai/snapshot-modeled-real-assets.test.ts` | Reads the tool layer. |
| `lib/ai/absence.test.ts` | The `db`-oracle scan reads the tool layer. |
| `lib/ai/privacy/scrub.test.ts` §3 | Reads **`tools/transactions.ts`**: the scrub site and its `@/lib/ai/privacy/scrub` import. |
| `lib/ai/measures/measures.test.ts` | Reads the tool layer (4 sites). |
| `lib/ai/conversation/history-facts.test.ts` | Reads the tool layer. The `find_in_balance_history` slice now ends at its own module's next declaration (`interface ChangeableSnapshotPoint`); before, it ended at the next tool in the old file, which now precedes it in scan order. The assertion still reads 6,424 chars of this tool alone. |
| `lib/ai/conversation/fin001-wiring.test.ts` | Reads the tool layer. `incompletenessBlock` → `projectionQualification` is still a contiguous slice inside `tools/projection.ts`. |
| `lib/ai/conversation/canonical-spending-surfaces.test.ts` | Reads the tool layer. |
| `lib/ai/conversation/spending-floor.test.ts` | Reads the tool layer. |
| `lib/ai/conversation/knowledge-gaps.test.ts` | Reads the tool layer. |
| `lib/ai/conversation/scenario-rules.test.ts` | Reads the tool layer (4 sites). |
| `lib/ai/conversation/scenario-change.test.ts` | Reads the tool layer. |
| `lib/ai/conversation/hardening.test.ts` | Reads the tool layer (2 sites). |
| `lib/ai/conversation/scenario-contract.test.ts` | Reads the tool layer. The import regex accepts `../` paths to `scenario-inputs`. The `prepareScenario` slice end anchor no longer requires `const scenarioProjection` at column 0, because the definition is now `export const`. |
| `lib/freshness/estimate-horizon.test.ts` | Reads the tool layer. |
| `lib/liquidity/access.test.ts` | Reads the tool layer. |
| `lib/data/transaction-corpus-coverage.test.ts` | Reads the tool layer. |
| `scripts/ai-baseline/baseline.test.ts` | Details below. |
| `scripts/rls-ai-acceptance.ts` | Checks 39 and 68 run the oracle scan and `spansModelCall` over **each** file of the layer. |
| `scripts/audit-account-reparenting.ts` | The `counterpartyAccountId` reference ratchet entry (`READ`) moves from `tools.ts` to `tools/transactions.ts`. |

Details for `scripts/ai-baseline/baseline.test.ts`:
- **35 sites** read `readToolsSource(ROOT)`.
- "No other harness file holds a Prisma client" now covers the whole layer.
- `^function` / `^async function` anchors for `prepareScenario`, `presentScenario` and `scenarioAssumptions` accept a leading `export `.
- **Latent defect found: 13f `changeBlock`.** The slice ran from `function changeBlock` to `const EXPLAINABLE_LENSES`. After the split that slice would be **empty**, and the negative check "the adapter performs no subtraction of its own" would have passed over nothing. It is now bounded by the block's own closing brace, and a new check asserts it is non-empty (> 400 chars, contains `observedChange(`).
- **Pre-existing defect fixed: 13g `get_transactions`.** The slice's end anchor `// ── 4. Income` is a comment, and `code()` strips it, so the slice always ran to end of file. Once `readWindowToExhaustion` became its own module, the declaration was counted as a call. The slice now ends at `name: 'get_income'`. Counts were re-verified on the pre-split file: 3 reads and 2 filtered queries, the same as the old to-EOF slice.

## What stayed where, and why

- **Stayed in the facade:**
  - `TOOLS`, `openAiToolSchemas` and `findTool`: the public contract.
  - The `monthEndsBetween` / `yearEndsBetween` re-exports, with their "RE-EXPORTED, NOT REIMPLEMENTED" comment.
  - The `MEMORY_TOOLS` import and its "ONE WRITE PATH" comment.
  - The header.
- **No `tools/describe.ts`.** `describe_fourth_meridian` already lives in `product.ts`. The memory tools stay in `memory-tools.ts`.
- **Nothing was left in the facade for being entangled.** Every declaration had an unambiguous home once these shared pieces moved to `shared/`:
  - `historicalSnapshot`, used by snapshot, investments, the spine and reconciliation;
  - `buildCashSpine`, used by the projection and scenario tools;
  - `originOf`, used by measures, projection and scenario.
- **Two placements follow use rather than section:**
  - `changeBlock` sat under section 7 but is used only by `get_net_worth_history`, so it is in `history.ts`.
  - `floorDerivationsOf` / `spendingOf` sat at the top of section 11 but are used only by the presentation, so they are in `scenario/present.ts`.
- **`prepareScenario` (≈440 lines) was not split internally.** That would have meant changing code, which this task forbids. It is the natural next candidate if `scenario/setup.ts` (903 lines) is still too large.

## Verification

All results below are on the final `HEAD`. Tests were run one file at a time with `npx tsx --require ./scripts/lib/server-only-preload.cjs <file>`.

- **Characterisation:** green on the unchanged module (`f7917f9`), at every step and at `HEAD`. The schema snapshot was never regenerated after the first commit.
- **Typecheck:** `npm run typecheck` (`tsc --noEmit`) exits 0 at every commit. `scripts/rls-ai-acceptance.ts` typechecks and its new import resolves. It was **not executed**, because it needs a database.
- **Lint:** `npx eslint` is clean (0 warnings) on the facade, `tools/**`, the helper and every edited test.
- **Static audit:** `npx tsx scripts/audit-account-reparenting.ts` (needs no database) passes.
- **Tests:** **175 / 175 PASS** at `HEAD`, each file run on its own. The set is the union of three groups: every test that imports or reads `tools*`, every `lib/ai/**` test, and the 78 repo-wide source-scanner tests (any test that walks the tree).

The **34 files run at every step** (all PASS at every step and at `HEAD`):

- `lib/ai/absence.test.ts`
- `lib/ai/asset-valuations-ai.test.ts`
- `lib/ai/conversation/canonical-spending-surfaces.test.ts`
- `lib/ai/conversation/conversation-identity.test.ts`
- `lib/ai/conversation/fin001-wiring.test.ts`
- `lib/ai/conversation/goal-seek-return-representation.test.ts`
- `lib/ai/conversation/goal-seek-truthfulness.test.ts`
- `lib/ai/conversation/guidance.test.ts`
- `lib/ai/conversation/hardening.test.ts`
- `lib/ai/conversation/history-facts.test.ts`
- `lib/ai/conversation/interest-once.test.ts`
- `lib/ai/conversation/knowledge-gaps.test.ts`
- `lib/ai/conversation/memory-isolation.test.ts`
- `lib/ai/conversation/projection-temporal.test.ts`
- `lib/ai/conversation/provenance-origin.test.ts`
- `lib/ai/conversation/runtime-state-capacity.test.ts`
- `lib/ai/conversation/scenario-change.test.ts`
- `lib/ai/conversation/scenario-composition.test.ts`
- `lib/ai/conversation/scenario-contract.test.ts`
- `lib/ai/conversation/scenario-rules.test.ts`
- `lib/ai/conversation/spending-change-tools.test.ts`
- `lib/ai/conversation/spending-floor.test.ts`
- `lib/ai/conversation/spending-goal-seek.test.ts`
- `lib/ai/conversation/spending-pending.test.ts`
- `lib/ai/conversation/tools-characterization.test.ts`
- `lib/ai/conversation/turn-deadline.test.ts`
- `lib/ai/measures/measures.test.ts`
- `lib/ai/privacy/scrub.test.ts`
- `lib/ai/snapshot-modeled-real-assets.test.ts`
- `lib/data/transaction-corpus-coverage.test.ts`
- `lib/freshness/estimate-horizon.test.ts`
- `lib/liquidity/access.test.ts`
- `lib/transactions/category-spend-authority.test.ts`
- `scripts/ai-baseline/baseline.test.ts`

The **other 141 files** (all PASS at `HEAD`):

`components/ai/ai.test.ts`, `components/atlas/panels/panels.test.ts`, `components/atlas/TimelineLens/TimelineLens.test.ts`, `components/notifications/notification-icons.test.ts`, `components/platform/widget-fetch-static-url.test.ts`, `components/space/shell/timeline-lens-exclusivity.test.ts`, `components/space/widgets/display-currency-fallback.test.ts`, `components/ui/space-markets-nav.test.ts`, `jobs/recovery-isolation.test.ts`, `lib/accounts/display-identity.test.ts`, `lib/admin-totp-enrollment-surface.test.ts`, `lib/ai/allowance.test.ts`, `lib/ai/assemblers/holdings-core.test.ts`, `lib/ai/assemblers/holdings-scope.test.ts`, `lib/ai/assemblers/holdings.test.ts`, `lib/ai/assemblers/position-class.test.ts`, `lib/ai/assemblers/snapshot.authority.test.ts`, `lib/ai/assemblers/transactions.fx.test.ts`, `lib/ai/assemblers/transactions.kd17.test.ts`, `lib/ai/assemblers/transactions.parity.test.ts`, `lib/ai/assemblers/transactions.population.test.ts`, `lib/ai/assemblers/transactions.privacy.test.ts`, `lib/ai/bounded-selection.test.ts`, `lib/ai/brief/claim-evidence.test.ts`, `lib/ai/brief/digest.test.ts`, `lib/ai/brief/generate.test.ts`, `lib/ai/brief/licence.test.ts`, `lib/ai/brief/lifecycle.test.ts`, `lib/ai/brief/load.test.ts`, `lib/ai/brief/package.test.ts`, `lib/ai/brief/recent-activity.test.ts`, `lib/ai/brief/relevance.test.ts`, `lib/ai/brief/state.test.ts`, `lib/ai/brief/view-model.test.ts`, `lib/ai/brief/watermark.test.ts`, `lib/ai/conversation/chat-request.test.ts`, `lib/ai/conversation/income-clause.test.ts`, `lib/ai/conversation/liability-dynamics.test.ts`, `lib/ai/conversation/liquid-floor-contribution.test.ts`, `lib/ai/conversation/memory-model.test.ts`, `lib/ai/conversation/pending-plan.test.ts`, `lib/ai/conversation/reconcile-attribution.test.ts`, `lib/ai/conversation/runtime-state.test.ts`, `lib/ai/conversation/scenario-checkpoints.test.ts`, `lib/ai/conversation/scenario-crossing.test.ts`, `lib/ai/conversation/starter-topics.test.ts`, `lib/ai/conversation/surplus-contribution.test.ts`, `lib/ai/coverage-envelope.test.ts`, `lib/ai/currency-presentation.test.ts`, `lib/ai/economic-concepts.test.ts`, `lib/ai/evidence-authorities.test.ts`, `lib/ai/fold-enrolment.test.ts`, `lib/ai/forecast/assemble-spending.test.ts`, `lib/ai/forecast/assemble.test.ts`, `lib/ai/forecast/income-completeness.test.ts`, `lib/ai/forecast/stream-read.test.ts`, `lib/ai/intelligence/annotations.ti2.test.ts`, `lib/ai/intelligence/assessment-contract.test.ts`, `lib/ai/intelligence/brief-scope-adequacy.test.ts`, `lib/ai/intelligence/debt-rate-reason.test.ts`, `lib/ai/intelligence/debt-strategy-fx.test.ts`, `lib/ai/intelligence/deficit-reason.test.ts`, `lib/ai/intelligence/flow-measure-basis.test.ts`, `lib/ai/intelligence/liquidity-baseline-refusal.test.ts`, `lib/ai/intelligence/monthly-income-basis.test.ts`, `lib/ai/intelligence/spending-trends-net.test.ts`, `lib/ai/intelligence/trajectory.test.ts`, `lib/ai/invocation-await.test.ts`, `lib/ai/invocation-failures.test.ts`, `lib/ai/model-rate-coverage.test.ts`, `lib/ai/openai-credentials.test.ts`, `lib/ai/pacing.test.ts`, `lib/ai/provider-deadline.test.ts`, `lib/ai/provider-structured.test.ts`, `lib/ai/rate-limit-retry.test.ts`, `lib/ai/signals/detectors/transactions.ti2.test.ts`, `lib/ai/temporal-scope.test.ts`, `lib/ai/turn-deadline.test.ts`, `lib/analytics/product-events.test.ts`, `lib/atlas/palette-ratchet.test.ts`, `lib/audit-email-hash.test.ts`, `lib/audit.test.ts`, `lib/auth/login-redirect.test.ts`, `lib/auth/session-token-exposure.test.ts`, `lib/balances/balance-boundary.test.ts`, `lib/balances/reconciliation-boundary.test.ts`, `lib/data/snapshot-read-boundary.test.ts`, `lib/debt/aggregates.test.ts`, `lib/debt/effective-terms.test.ts`, `lib/freshness/freshness-convergence.test.ts`, `lib/imports/investments/pipeline.test.ts`, `lib/investments/space-data-historical.test.ts`, `lib/investments/transaction-boundary.test.ts`, `lib/jobs/cron-auth.test.ts`, `lib/marketing-boundary.test.ts`, `lib/money-presentation.test.ts`, `lib/money/round.test.ts`, `lib/monitoring/deployment.test.ts`, `lib/monitoring/sentry-capture-boundary.test.ts`, `lib/monitoring/sentry-dev-gate.test.ts`, `lib/perspective-engine/engine.test.ts`, `lib/perspectives/trust-vocabulary.test.ts`, `lib/perspectives/workspace-definition.test.ts`, `lib/plaid/disconnect-revocation.test.ts`, `lib/plaid/refresh-ledger.test.ts`, `lib/platform-surface.test.ts`, `lib/platform/admission/admission-boundary.test.ts`, `lib/platform/capability-control.test.ts`, `lib/platform/incidents/incident-boundary.test.ts`, `lib/platform/incidents/invariant.test.ts`, `lib/platform/incidents/operation-key.test.ts`, `lib/platform/incidents/preview-core.test.ts`, `lib/platform/refresh/constructor-uniqueness.test.ts`, `lib/platform/refresh/read-boundary.test.ts`, `lib/public-site-boundary.test.ts`, `lib/rls-server-component-authority.test.ts`, `lib/security-surface.test.ts`, `lib/security/client-ip.test.ts`, `lib/security/write-origin.test.ts`, `lib/snapshots/reconstruction-basis.test.ts`, `lib/space-templates/create-route.test.ts`, `lib/space-templates/purity.test.ts`, `lib/space/mount-context.test.ts`, `lib/sync/deferred-ingestion.test.ts`, `lib/test-support/mutant-module.test.ts`, `lib/time/clock-authority.test.ts`, `lib/transactions/cash-flow-window-identity.test.ts`, `lib/transactions/crypto-separation.test.ts`, `lib/transactions/debt-creditor-presentation.test.ts`, `lib/transactions/debt-payment-authority.test.ts`, `lib/transactions/event-identity.test.ts`, `lib/transactions/flow-classifier-authority.test.ts`, `lib/transactions/flow-presentation.direction.test.ts`, `lib/transactions/flow-presentation.test.ts`, `lib/transactions/lifecycle-boundary.test.ts`, `lib/transactions/merchant-schema.test.ts`, `lib/transactions/refund-economics.test.ts`, `lib/visibility-resolver-parity.test.ts`, `scripts/ai-baseline/active-scenario.test.ts`, `scripts/audit-migration-names.test.ts`, `scripts/docker-teardown.test.ts`

## Residual risk

- **Scan order is now part of some assertions.** A few scans slice between two anchors that now sit in different modules (`prepareScenario` → `surplusRule`, `scenarioCrossing` → `// ── 12. Goal seek`). They depend on `TOOLS_SOURCE_ORDER`, which follows the original section order. Reordering that list could empty a slice. The two slices that a split *did* empty were found and fixed, and each now asserts non-empty or positive content. A similar empty-slice risk remains for any future scan that slices across modules.
- **Not run here:** the full `npm run test:unit`, `npm run ci`, lint over the whole repo, and `next build`. Per the machine constraints, the orchestrator runs these.
- **Module resolution.** `./tools` (a file) and `./tools/` (a directory with no `index.ts`) now coexist. TypeScript `bundler` resolution and tsx resolve the file. `next build` (Turbopack and webpack) should too, but that was not exercised here.
- **Duplicated import comments.** A few comments are copied into each module that uses the import. Edit them together.
- **The scratch generator was not committed.** Each commit is reviewable with `git diff --color-moved`, and the line-conservation check is recorded above.
