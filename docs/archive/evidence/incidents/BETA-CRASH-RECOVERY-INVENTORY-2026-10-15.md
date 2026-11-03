# BETA IMPLEMENTATION — CRASH RECOVERY INVENTORY (2026-10-15)

**Context.** Two coordinating sessions (Claude 1: beta implementation; Claude 3: real-world assets) and their background agents were interrupted by a machine crash and an account usage limit (HTTP 429). This inventory is the read-only audit taken by the consolidated lead coordinator before any change. It records what was found, not what was hoped.

**Read at:** main checkout `v2.6` = `a62f712` (10 commits ahead of `origin/v2.6` = `76853fe`); eight worktrees; no surviving agent process; Docker daemon was down (container `fintracker-db`, postgres:16-alpine, came back healthy on daemon start — no data loss observed); Dev DB at 123 applied migrations.

## A. Completed and committed

| Item | Where | Evidence |
|---|---|---|
| Claude 2 — CI health-route flake fix | `3241f16` on `v2.6`, pushed; GitHub CI 38646264116 success | in `origin/v2.6` |
| Beta base (contracts, dimensions, settings, stub jobs, stub section, frozen DTO) | `b625d45` on `v2.6` | `beta/base` |
| RWA-1A/1B/1C (manual assets UI, estimate horizon, Brief + `get_financial_snapshot` valuationSource fixes) | `6bf9243`, `61f70bf`, `adebafe` on `rwa1/manual-assets`; **merged** `5f8821b` | both Claude 3 gaps (Brief userEstimate, snapshot valuationSource) are closed in `adebafe` |
| W2a — C1, C2, C4, C7′ (+ migration `20261015100000_plaid_item_environment`) | `a54f596`, `5931b28`, `91628bb` on `beta/w2a`; **merged** `a62f712` | migration NOT applied on Dev/Preview at audit time |
| W1 — UX P2 Phase A + B (N1–N4) | `8bd5874`, `1ff9b54` on `beta/w1`; hand-off written; **not merged** at audit time | coordinator re-ran 8 pinned tests + tsc on the branch: green |
| W4 — V3 product-analytics surface + CS roll-up row | `1268472`, `4653f12` on `beta/w4`; **not merged** | — |
| RWA-2A (schema + migration `20261015120000_rls_asset_valuations`, resolver, write paths, history route, chart, forms, AI exposure) | `444f296` on `rwa2/asset-valuations` (stacked on `adebafe`); **not merged** | agent-reported tests/tsc/eslint green; the full `npm run ci` gate started by Claude 3 **did not complete** (log lost with /tmp) |

## B. Completed but uncommitted
- **W2b** (`beta/w2b`): C6/C7 nearly complete — 14 modified + 12 new files (allowance seam + core, spend-by-surface, thresholds, health, cost-safeguards, `ai-spend` route, alert rule/evaluate/run, provider unpriced-model refusal, chat + brief route refusals, Policies "Cost safeguards" group, AI/Economics blocks, privacy lists). Tests/tsc/eslint not yet run on the final tree; nothing committed.

## C. Partial implementations
- **W3** (`beta/w3`): vocabulary (`PRODUCT_EVENT_ACTIONS`), writer `lib/analytics/product-events.ts` (+test), `request-intent.ts`, `SESSION_ACTIVE_DAY` CTE in `session-activity.ts`, writers in dashboard/brief/transactions routes, A7 PII cleanup (email hash, wallet/manual metadata) — all uncommitted. **Missing:** readers (`product-analytics.ts` + core + route), activity present/engaged basis, growth funnel stages, CS per-user roll-up fields, `jobs/product-event-retention.ts` body, privacy-list extensions.
- **W4** (`beta/w4`): V1 user-impact composition in flight (core + reader + view done; `AttentionBlock` edit in progress) — uncommitted. **Missing:** V1 tests/finish, V2 Security Ops posture surface.

## D. Missing implementations
- RWA-2B (historical net-worth integration under the owner's rules: frozen snapshots by default; Personal-Space consent amendment with preview; shared Spaces floored at link date; modeled labelling on Net Worth chart; `WEALTH_REGENERATION_ENABLED` respected). Claude 3 had only begun reading the amendment module.
- Coordinator items: `MANUAL_ASSET_VALUE_UPDATED` call in the manual PATCH route (after W3), Dev/Preview migrations, Preview seed, clean build, `npm run ci`, push, CI, Preview verification, C10 owner actions, final report.

## E. Interrupted verification
- W1: pinned tests + eslint + tsc were "about to run" — re-run by this coordinator: green (8 files + tsc).
- RWA-2A: `npm run ci` on `444f296` started, result unknown → re-run by this coordinator (in progress at the time of writing).
- W2b / W3 / W4: no final test runs.

## F. Potential file conflicts
- `git merge-tree` of `beta/w1`, `beta/w4`, `rwa2/asset-valuations` against `v2.6`: clean.
- W3 uncommitted edits overlap `v2.6` only in `app/api/accounts/wallet/route.ts` (W2a connection-cap guard vs W3 audit-metadata block — different hunks).
- `app/api/accounts/manual/route.ts`: W3 (audit metadata) vs RWA-2A (helper call) — different hunks; `[id]/route.ts` belongs to RWA + coordinator.
- W4 `CsCustomersWidget` consumes five optional roll-up fields W3 must provide by name.

## G. Migration state
| Migration | Repo | Dev | Preview | Production |
|---|---|---|---|---|
| `20261015100000_plaid_item_environment` (one nullable column, rollback documented) | on `v2.6` | **not applied** at audit; applied by the coordinator after review (see STATUS) | pending | prohibited |
| `20261015120000_rls_asset_valuations` (two tables, RLS, append-only grant) | on `rwa2/asset-valuations` only | not applied | pending | prohibited |
Dev `SpaceDashboardSection` already carries `growth_product_analytics` (seeded earlier). `PlatformSetting` has no `ai_spend_*` rows (defaults apply until an operator writes one).

## H. Integration dependencies
W1 → W2b → W3 → W4 → RWA-2A → RWA-2B → coordinator (MANUAL_ASSET_VALUE_UPDATED line, seeds, migrations, build, ci, push, Preview). W4's CS table depends on W3's roll-up field names; W4 V2 may need coordinator registry/composition wiring; RWA-2B depends on RWA-2A and the snapshot amendment path.
