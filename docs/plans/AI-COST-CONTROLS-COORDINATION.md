# AI COST CONTROLS + OPENAI ENVIRONMENT SEPARATION — COORDINATION (2026-10-15)

**Milestone:** owner-authorized post-beta milestone (brief of 2026-10-15). **Base:** `aicost/base` = `v2.6` `3e91562` (docs HEAD; verified application baseline `1c04752`) + this coordinator commit. **Agent branches:** `aicost/a` (policy backend + enforcement), `aicost/b` (Platform Ops UI + Economics), `aicost/c` (OpenAI environment separation, docs, tests), each in a worktree under `/Users/chrstn/dev/FourthMeridian-aicost/` with **no `DATABASE_URL`** and `FM_DB_GUARD=clone-only`. **Production is untouched** by every step here: no deployment, migration, configuration, credential or data change on Production is authorized.

## 1. The contract (frozen in the base commit)

`lib/platform/ai/cost-controls.types.ts` — read models, control keys, setting keys, rule ids, defaults, the PATCH body, the two route paths. Agents append; nobody renames.

| Control | PlatformSetting key | Type / bounds | Default | Missing row |
|---|---|---|---|---|
| `allowance.enforced` | `ai_daily_allowance_enforced` | boolean | `true` | FALLBACK_TO_DEFAULT (invalid ⇒ enforced) |
| `allowance.usd` | `ai_daily_allowance_usd` | integer 1 … ceiling (20) | `5` | FALLBACK_TO_DEFAULT |
| `userAlert.enabled` | `alert_rule_enabled:ai-spend-user-high` | boolean | `true` | FALLBACK_TO_DEFAULT |
| `userAlert.thresholdUsd` | `ai_spend_alert_user_usd_24h` (exists) | integer 1 … 10000 | `3` | FALLBACK_TO_DEFAULT |
| `fleetAlert.enabled` | `alert_rule_enabled:ai-spend-fleet-high` | boolean | `true` | FALLBACK_TO_DEFAULT |
| `fleetAlert.thresholdUsd` | `ai_spend_alert_fleet_usd_24h` (exists) | integer 1 … 100000 | `10` | FALLBACK_TO_DEFAULT |
| `killSwitch.paused` | `ai_paid_requests_paused` | boolean | `false` | ABSENT_MEANS_OFF; an **unreadable** row denies (admission-fact idiom, policy-core.ts) |

All seven: `class: OPERATOR_CONFIGURABLE`, `writeSurfaces: ["PLATFORM_OPS"]`, `writeCapability: "CONTROL"`, `operatorConfigurable: true`, `resettable: true`. Written ONLY by the new mutation service (§2) through the conditional primitives in `lib/platform-settings.ts`; reset = DELETE the row.

**Alert rule split.** `ai-spend-high` becomes two live rules in `lib/alerts/rules.ts`: `ai-spend-fleet-high` (fleet signal + the unpriced-coverage warning) and `ai-spend-user-high` (per-customer signal). Each is enabled through the engine's existing `alert_rule_enabled:<id>` key (`resolveEnabled`), dedupe keys keep their `<rule>:<fleet|user|unpriced>:<day>` family, suppress-while-open (20 h) unchanged ⇒ idempotent. Disabling a rule changes evaluation only; the spend fold, the ledger and the Economics figures keep running.

**Per-customer allowance precedence** (one pure function, used by enforcement AND every operator view):
`USER_OVERRIDE > OVERLAY > PLATFORM_SETTING > POLICY`, then the catalogue **ceiling clamps last** (20). Sources reported as such. The user override is `CustomerPolicyAssignment.aiDailyUsdAllowanceOverride INTEGER NULL` — **the one additive migration** of this milestone (`prisma/migrations/20261016000000_customer_ai_allowance_override/`, with README + rollback; old-client compatible; table-level grants unchanged so RLS needs nothing). Written only by `lib/platform/customer/assign.ts` (audited, reason-required) via `POST /api/platform/customer-success/customers/[userId]/policy` with the new optional field `aiDailyUsdAllowanceOverride?: number | null` (null = remove). Validation: integer 1 … ceiling; above the ceiling is REFUSED at the service (not silently clamped) so no accidental escalation; the resolver still clamps as belt-and-braces.

**Kill switch precedence.** Judged in the Conversations and Daily Brief routes BEFORE the allowance (after authentication, entitlement and pacing), AND at the provider chokepoint (`lib/ai/provider.ts`, before `assertPricedModel`) so harness/script traffic is refused too. Refusal: 503, `{ error, code: "AI_PAUSED" }`, customer sentence from `KillSwitchView.customerMessage`; one zero-token `FAILED / AI_PAUSED` ledger row from the chokepoint path (the routes refuse before the chokepoint, so no row for a route refusal — consistent with allowance refusals). No override lifts it.

**Allowance disabled ≠ pricing off.** With `allowance.enforced=false` the `ALLOWANCE_EXHAUSTED` refusal is not issued; the `UNPRICED_MODEL` refusal (pricing validation) and the provider chokepoint's unpriced refusal stay. Everything is still recorded.

**Concurrency (bounded, honest).** The ledger is written after the provider returns, so N simultaneous turns can each pass the check on the same stale sum. Agent A implements a per-customer **in-flight reservation** judged together with the spend read under `pg_advisory_xact_lock` (a short transaction; the model call is never inside it), stored in the existing `RateLimit` counter table (no migration) with a self-healing bucket, and released in the route's `finally`. The guarantee to state: *admitted spend ≤ allowance + (actual cost of admitted turns − their reservation)* — overshoot bounded by one turn's excess over its reserve per concurrently admitted turn, never claimed as an absolute hard cap. If the lock cannot be taken (no DB, memory backend in dev), fall back to the current check and say so in the read model's `propagation` note.

**Caching.** Today no AI policy read is cached: `getSetting`/`findMany` per decision, `AI_RATES` is code. Agent A documents this in `propagation` and pins it with a test (a change is visible to the very next decision).

## 2. Ownership

| Agent | Owns (files) | Must not touch |
|---|---|---|
| **A** backend | `lib/platform-settings.ts` (+5 keys/descriptors), `lib/platform/ai/cost-controls.ts` (read model + mutation service, `lib/platform/policies/` idiom), `app/api/platform/platform-ops/ai-cost-controls/route.ts`, `app/api/platform/platform-ops/ai-budget/route.ts`, `lib/platform/ai/ai-budget.ts`, `lib/ai/allowance*.ts`, `lib/ai/provider.ts` (kill-switch admission only), `lib/alerts/rules.ts`, `lib/alerts/evaluate.ts`, `lib/platform/ai/spend-health.ts`, `lib/platform/ai/spend-thresholds.ts`, `lib/platform/ai/cost-safeguards.ts`, `lib/entitlements/*`, `lib/platform/customer/assign.ts`, the CS policy route, the chat/brief routes, the migration, all their tests | UI files, `lib/ai/openai-credentials.ts`, docs other than the migration README and its own hand-off |
| **B** UI | `components/platform/widgets/OpsPoliciesWidget.tsx` (+ a new `AiCostControlsPanel` in its own file `components/platform/widgets/AiCostControlsPanel.tsx` + `ai-cost-controls-view.ts`), `OpsAiBudgetWidget.tsx` (+ `ai-budget-view.ts`), `overview/EconomicsBlock.tsx` (a budget line + doorway), `CsCustomersWidget.tsx` (the per-customer allowance override editor beside the overlay select), their tests | server code, routes, settings, types file (append only with a note) |
| **C** OpenAI env | `lib/ai/openai-credentials.ts` (+ test), `lib/env.ts` (value-free report of the project pin; **no** new key names), `OpsEnvStatusWidget` / env-status reader (project pin shown, never the key), `.env.example`, `docs/operations/openai-environment-separation.md` (new), `docs/operations/environment-separation.md` §7 cross-link, `docs/operations/key-rotation.md` if needed, source-scan tests pinning "one key name, no fallback" | `lib/ai/provider.ts` (already wired), any route, any setting |

**Overlaps resolved:** `lib/ai/provider.ts` is A's (kill switch) — C never edits it. `cost-controls.types.ts` is coordinator-owned; append-only. B builds against the types with fakes and the two route URLs; A delivers the routes. If B needs a field A cannot deliver, B says so in the hand-off instead of inventing one.

## 3. Rules every agent follows

1. No DB in worktrees (`FM_DB_GUARD=clone-only`, no `DATABASE_URL`). Unit tests use fakes. The coordinator applies the migration on Dev/Preview with backups.
2. Tests beside every change (`*.test.ts`, the repo's `check()` idiom, run with `npx tsx --require ./scripts/lib/server-only-preload.cjs <file>`); `npx tsc --noEmit` before hand-off (filter `tmp/` and `prototype/`); `npx eslint` on touched files. Keep every existing test green — fix pins you legitimately break and say which.
3. Identity minimisation on PLATFORM_OPS surfaces: opaque refs only; never an email, username, full id or Space name. Customer Success keeps usernames.
4. Audit through `recordOperatorAction` with a required structured reason; metadata = keys, before/after values, origins — never a secret, never a prompt, never a dollar figure that is not already a policy value.
5. Fail closed: unreadable policy ⇒ the safe default (enforced / paused ⇒ deny); unpriced ⇒ refuse; never `$0` for the unknown.
6. Never print, commit or log an API key. The project id (`proj_…`) is a non-secret identifier and may be shown.
7. Commit on your branch with clear messages (`AICOST-A — …`); hand off with: files, tests run (counts), tsc result, pins changed, open questions.

## 4. Integration order

A (migration review + Dev apply by the coordinator) → C → B (B's fakes replaced by A's routes; coordinator runs the Policies/Economics tests on the merged tree) → coordinator: tsc, targeted suites, clean-worktree `next build`, `npm run ci` (Node 24), push explicit SHA, GitHub CI + drift guard, Preview migration (`db:migrate:safe` with backup) + `platform:seed-spaces` (new `ops_ai_budget` section) + browser verification, STATUS.md, final report.
