# Agent D: AI Reliability & Cost Control (wave 1)

Branch `remediation/d-ai-reliability` (from `cde8fa0`), worktree `FourthMeridian-remediation/d`. Local commits only: nothing was pushed or merged. No real provider was called and no live database was touched.

## Summary

| Finding | Status | Commit |
|---|---|---|
| SEC-AI-003 (P1): SDK defaults, no per-call abort, retries compound | FIXED | `a926adf` |
| IDEMP-009 / OBS-005 (P1): fire-and-forget ledger, swallowed failures | FIXED | `7e84b32` |
| SEC-AI-005 (P1): raw descriptors sent to OpenAI on the chat path | FIXED | `b4f8bc3` |
| SEC-AI-008 / SEC-AI-002 (partial): guidance call unreserved | FIXED (reserve covers 7 calls); transcript-sized reserve DEFERRED | `b42ed27` |
| SEC-AI-004: AI pacing fails open | FIXED | `5554fb7` |
| OBS-006: kill-switch and harness traffic pollute the failure alert | FIXED | `a7e973c` |
| SEC-AI-001: no fleet gate | DEFERRED (reasoning below) | n/a |

## Bounds now in force

| Bound | Value | Where |
|---|---|---|
| OpenAI client timeout | 90 000 ms per request | `OPENAI_CLIENT_TIMEOUT_MS`, `lib/ai/provider.ts` |
| OpenAI client retries | **0**. The app retry is the only retry authority. | `OPENAI_CLIENT_MAX_RETRIES` |
| Turn budget | 270 s = route `maxDuration` 300 s − 30 s margin, less what the gates spent | `CHAT_TURN_BUDGET_MS`, `lib/ai/turn-deadline.ts` |
| Provider attempts per hop | 3 (1 call + 2 rate-limit retries) | `CHAT_RATE_LIMIT_ATTEMPTS` |
| Total backoff per hop | ≤ 60 s | `CHAT_RATE_LIMIT_WAIT_BUDGET_MS` |
| Retry past the deadline | never (a retry needs ≥ 5 s of budget left) | `CHAT_MIN_ATTEMPT_MS` |
| Guidance label | clipped to `min(60 s, remaining)`, aborted by the turn signal, skipped under 5 s left | `GUIDANCE_MIN_REMAINING_MS`, `engine.ts` |
| Worst case for one 429'd hop | 3 provider requests (was 18 = 6 app × 3 SDK) | |
| Per-turn reserve | 7 calls × (30k prompt + 1.5k completion) at gpt-5.1 = **$0.3675** (was 6 calls = $0.315) | `lib/ai/allowance-core.ts` |
| Ledger trust trip | 3 failed `AiInvocation` writes in the current + previous hour (durable), or 2 consecutive in one process | `lib/platform/ai/ledger-health.ts` |
| Brief path | unchanged: 60 s structured timeout and its existing 90 s lease budget, plus 0 SDK retries | |

## Per finding

### SEC-AI-003: provider timeout and retry: `a926adf`

**Root cause.** `getClient()` built `new OpenAI({...})` with no `timeout` or `maxRetries`, so the SDK used a 10-minute timeout and 2 hidden retries. The tool loop passed no `AbortSignal`. `callWithRateLimitRetry` (≤ 5 app retries, no deadline on chat) multiplied on top of the SDK's own retries. Runtime evidence: 18 provider requests for one 429'd turn. A hung hop could outlive `maxDuration`, so the reservation's `finally` never ran.

**Change.**
- `provider.ts` pins `timeout: 90_000, maxRetries: 0` (exported constants).
- `generateWithTools` and `generateStructuredWithUsage` take a `signal`:
  - if the signal is already aborted, the call is not made, a zero-token `TIMEOUT / turn_deadline` fact is written, and `TurnTimeoutError` is thrown;
  - if it aborts mid-call, the SDK abandons the request and the same fact is written.
- New pure `lib/ai/turn-deadline.ts` holds the budget, the bounds and `TurnTimeoutError`. Its name contains "Timeout", so `classifyAiFailure` maps it to `TIMEOUT`.
- `rate-limit-retry.ts` gains `maxTotalWaitMs` and `signal`: a cancelled caller is never retried, and a wait in progress ends early.
- `turn.ts` checks the deadline before every hop and calls the retry with the bounds above. The single literal provider site is preserved: `rls-ai-acceptance` check 36 counts exactly 1.
- `engine.ts` threads the deadline into the turn and into the guidance call.
- The chat route opens the deadline after the allowance and passes it in. It answers a spent deadline with **504** and the sentence `SAY.timedOut` ("Nothing was changed"). It disposes the deadline in the same `finally` that releases the reservation.
- **Cost exposure is measurable.** Each app attempt number rides the ambient invocation context. Failure rows record it as `finishReason: "attempt:<n>"` (no schema change). RETURNED rows keep the provider's own `finish_reason`.

**Tests.**
- `lib/ai/turn-deadline.test.ts`:
  - bounds pinned;
  - route `maxDuration` literal equals `CHAT_ROUTE_MAX_DURATION_S`;
  - the one `new OpenAI` carries both pins;
  - the signal is threaded route → engine → turn → guidance.
- `lib/ai/provider-deadline.test.ts` (fake client):
  - the signal reaches the SDK;
  - pre-aborted ⇒ 0 calls plus a TIMEOUT fact;
  - abort mid-call ⇒ the fact says `turn_deadline`;
  - the structured path honours both its own timeout and the turn signal;
  - the attempt marker is on failure rows only.
- `lib/ai/conversation/turn-deadline.test.ts` (fake generate, virtual clock):
  - a transient 429 ⇒ 2 calls;
  - a permanent 429 ⇒ exactly 3 calls and the error recorded;
  - the sleep budget cuts retries short;
  - no retry past the deadline;
  - a spent deadline ⇒ 0 calls;
  - cancelled after hop 1 ⇒ hop 2 is never asked;
  - `insufficient_quota` ⇒ 1 call and no wait (db1950b preserved).
- `lib/ai/rate-limit-retry.test.ts` §4b covers the total-wait budget and cancellation before and during a wait.
- `app/api/ai/chat/route.test.ts` §8 covers the clock start, opening order, dispose in `finally`, and the 504.
- Repinned: `invocation-failures.test.ts` counts the two spent-deadline refusal paths; `allowance.test.ts` expects `deadline.dispose()` in the `finally`.

**Residual risk.**
- The route-level deadline protects the chat path. The Brief path keeps its own 60 s / 90 s-lease bounds.
- A request that lands just under the deadline can still run up to 90 s (the SDK timeout). The 30 s margin plus the SDK cap means the lambda is not killed before the `finally` only if the final hop started with ≥ 5 s left (`CHAT_MIN_ATTEMPT_MS`). A hop is not started once the signal has fired, and the signal aborts any in-flight request, so the effective bound is the deadline.
- Client disconnect is not wired to `deadline.abort()`: Next's `req.signal` was not verified on the Node runtime here. Follow-up below.

### IDEMP-009 / OBS-005: ledger await and fail-closed: `7e84b32`

**Root cause.** `provider.ts` called `void recordAiInvocation(...)` and `void recordOpenAiFailure(...)`, and `invocation.ts` swallowed errors with `console.warn`. A failed or slow insert under-counted the allowance silently, and a write-dead ledger admitted every turn.

**Change.**
- **Await.** Every chokepoint ledger write is awaited (8 sites), so the row is on the ledger before `generateWithTools` or `generateStructuredWithUsage` returns. That makes it present before any HTTP response resolves on both the chat and Brief paths. The model call is unaffected. Two writes intentionally stay fire-and-forget:
  - the day-grain `recordApiUsage`;
  - the synchronous `assertPricedModel` refusal row (a refusal, not a billed call).
- **Writer.** The writers now resolve `true`/`false` and still never throw.
- **Failure handling.** A failed write goes through the new `lib/platform/ai/ledger-health.ts`, which:
  - captures it with `captureLedgerWriteFailure("AiInvocation", "providerCall", err)`. The `OperationalLedger` union lives in `lib/monitoring/capture.ts` (Agent A's), so the value is cast; see out-of-scope needs.
  - increments a per-process consecutive counter;
  - writes a durable fm_system `RateLimit` row, key `system:ai-ledger-write-failures`, per hour bucket. This is the same idiom as the in-flight counter: self-healing within 2 h, and cleared by the first successful write after failures. It goes through the same client the ledger write used.
- **Reservation.** `allowance-reservation.ts` reads the durable count **inside** its locked transaction. With enforcement on and the ledger untrusted, it refuses with the new reason `LEDGER_UNTRUSTED`: retryable, 503 + Retry-After, the same body shape as `RESERVATION_UNAVAILABLE`. Nothing is reserved.

**Decision.**
- **The current turn still returns its answer.** The cost is already incurred and refusing would not un-spend it. The allowance is protected on the *next* turn, and the allowance never under-counts silently.
- **Per-process vs durable.**
  - The per-process counter alone would be one lambda's view.
  - The durable row is the fleet-visible signal.
  - Either trips the gate.
- **When the database is fully down,** the durable write fails too. That case is the reservation's existing `RESERVATION_UNAVAILABLE` path.

**Tests.**
- `lib/ai/invocation-await.test.ts`:
  - a 20 ms write is present when `generateWithTools` resolves, with no tick;
  - dead ledger ⇒ observed once, durable row written, answer still returned;
  - a failing failure-write still rethrows the provider's own error;
  - recovery clears the signal;
  - thresholds;
  - the bucket equals `INFLIGHT_BUCKET_MS`;
  - aged out after 2 h.
- `allowance-reservation.test.ts` §5b:
  - durable trip ⇒ `LEDGER_UNTRUSTED` 503 retryable, nothing reserved;
  - one below the trip ⇒ admitted;
  - the previous hour counts and ages out;
  - enforcement OFF ⇒ admitted;
  - process trip ⇒ refused;
  - one success ⇒ re-admitted.

**Residual risk.**
- The capture uses a cast ledger name until `OperationalLedger` gains `"AiInvocation"`.
- The awaited insert adds one insert's latency to each model call: a few ms against 3–70 s hops.

### SEC-AI-005: descriptor scrub: `b4f8bc3`

**Root cause.** `get_transactions` rows sent `merchant` (raw fallback) and `description` verbatim (`tools.ts` ~829–831). The transaction assembler's rollups and drilldown emitted raw descriptors (`largestIncome/Expense.merchant`, recurring candidates keyed on the raw lowercased descriptor, drilldown `rawMerchant` and `description`). The Brief scrubbed the same strings.

**Change.**
- New pure `lib/ai/privacy/scrub.ts` is the Brief's rule, unchanged. It removes runs of 4+ digits and `#`/`*` markers, collapses whitespace and clips to 40 characters. If nothing is left, it returns `undefined` (or `"unnamed"` for required fields).
- The Brief's `safeMerchant` delegates to it.
- **Applied to:**
  - `get_transactions` `merchant` (surgical, one map body);
  - `largestIncome` and `largestExpense`;
  - merchant and income rollups;
  - recurring candidates;
  - drilldown `merchant` and `rawMerchant`.
- **`description` is no longer sent** on either path. The `text` filter still searches it server-side.
- Grouping keys stay raw, so aggregation is unchanged.

**Not scrubbed, deliberately:**
- account names: the resolved display name, not a provider descriptor; masks are last-4 by design and BALANCE_ONLY accounts already get generic names;
- holdings names;
- `lib/ai/forecast/streams.ts`: Agent B's file. Its stream labels derive from merchant names (follow-up below).

**Tests.**
- `lib/ai/privacy/scrub.test.ts`:
  - 16-digit card run, cheque `#1052`, reference ids;
  - 3-digit tokens are kept;
  - idempotent; clipped;
  - the real `buildMerchantRollup`, `buildRecurringCandidates` and `buildIncomeSourceRollup` fed raw descriptors produce no 4+-digit runs;
  - source pins on every emitting site and on the absence of `description`.
- `lib/ai/brief/recent-activity.test.ts` checks that `safeMerchant` is the shared function with its prior outputs unchanged.
- Existing assembler suites (fx 41/41, kd17, privacy, population, parity, canonical-spending) stay green.

**Residual risk.**
- `content/marketing/legal-ai.md:27` says "transactions (merchant, amount, date and category)". That is now accurate for the chat path (no description is sent). Agent A owns the legal copy.

### SEC-AI-008 / SEC-AI-002 (partial): reserve the guidance call: `b42ed27`

**Change.**
- `RESERVE_INVOCATIONS_PER_TURN = RESERVE_ANSWER_HOPS (6) + RESERVE_GUIDANCE_CALLS (1)` = 7, so `RESERVE_USD` is **$0.3675** (fallback likewise).
- The reservation still counts per turn, so `rls:accept:allowance` semantics are intact. The suite computes its expected admissions from `RESERVE_USD`: `ceil((5 − 3.8) / 0.3675)` = 4, the same count as with $0.315.

**Deferred: sizing the reserve from transcript bytes.** Both routes reserve **before** reading the body, and a test pins that order (a refused turn costs no parse), so the transcript size is not known at reservation time. Reordering would mean parsing an unbounded body before the allowance check. The per-call shape is already the body-limit worst case (≤ 160 KB ≈ 40k tokens, mostly cached after hop 1).

**Tests.** `allowance.test.ts` §1b now pins 7 calls and the derivation against `MAX_TOOL_ROUNDTRIPS = 6`, and checks that the engine really calls `classifyGuidance`.

### SEC-AI-004: pacing fails closed: `5554fb7`

**Change.**
- New `lib/ai/pacing.ts` `paceAiRequest` wraps the limiter's existing strict variant, `checkKeyLimitStrict`. Agent A's `lib/rate-limit.ts` is unmodified.
  - `ok` ⇒ proceed;
  - `limited` ⇒ 429 with Retry-After;
  - `unavailable` ⇒ **503** with `PACING_UNAVAILABLE`, retryable, Retry-After 15.
- The chat route's `ai-chat` and `ai-chat-hour` windows and the Brief's `ai-brief-generate` window go through it.
- `RATE_LIMIT_ENABLED` and `RATE_LIMIT_SHADOW` are still honoured by the limiter.
- **Note:** the strict variant keys `key:<name>:<userId>` where the old call used `user:<name>:<userId>`. Old counters age out within their window, so a one-window reset happens at deploy.

**Tests.**
- `lib/ai/pacing.test.ts`: mapping; wrapper over an injected judge, with unavailable ⇒ 503 and never null; source pins that both routes use it and neither calls `limitByUser`.
- Repinned: `app/api/ai/chat/route.test.ts` §2 and `app/api/brief/brief-authority.test.ts`.

### OBS-006: clean failure-alert input: `a7e973c`

**Change.** `getAiFailureHealth` now queries through the pure `aiFailureWhere(since, deploymentEnvironment())`, which keeps only rows where:
- `environment` equals this deployment's;
- `surface` is in `CUSTOMER_SURFACES` (`chat`, `brief`), which excludes harness traffic;
- `errorCode` is null (RETURNED rows) or not `AI_PAUSED`, which excludes kill-switch refusals.

Both consumers get the clean input: the `ai-provider-failing` alert rule and the Platform Ops attention reader.

**Tests.** `failures.test.ts` covers the predicate and pins the real reader's use of it.

**Residual risk.** None known. Rows from other environments still exist and are read by the spend folds, which this change does not touch.

### SEC-AI-001: fleet gate: DEFERRED

Not clean inside the existing reservation transaction:
1. The advisory lock is **per customer**, so two customers' turns are judged concurrently. A fleet ceiling read inside that transaction would race exactly as the pre-reservation allowance did, unless every turn on the platform took one global lock. That would serialise all AI admissions fleet-wide and turn one slow transaction into a platform stall.
2. It needs a fleet-wide `AiInvocation` sum on every turn, plus a fleet in-flight bucket.
3. A new configurable ceiling needs a `PlatformSettingKey` and descriptor in `lib/platform-settings.ts`, which is Agent A's file.

**Recommendation:**
- a fleet counter row taken under its own short advisory lock after the per-user verdict, in the same transaction, with a generous default;
- owner confirmation of the OpenAI project hard spend limit per environment, which today is the only fleet hard stop;
- scope this for wave 2 with Agent A's settings key.

## Preserved and pinned behaviour

- **Kill switch:** route 503 `AI_PAUSED` before the allowance; chokepoint refusal plus a fact. Pinned by `paid-requests-admission.test.ts` and `allowance.test.ts`.
- **Fail-closed reservation** (`RESERVATION_UNAVAILABLE`): pinned by `allowance-reservation.test.ts` §5 and the acceptance suite.
- **`finally release()`:** now `deadline.dispose(); await allowance.release();`. Pinned by `allowance.test.ts` and `route.test.ts` §8.
- **Space mismatch 403:** `route.test.ts` §3, unchanged.
- **Unpriced-model refusal:** `allowance.test.ts` and the route's `SAY.unpriced`, unchanged.
- **Quota no-retry (db1950b):** pinned again in `conversation/turn-deadline.test.ts` §5.
- **Tool names and schemas:** unchanged. The only output change is the scrub plus the removal of `description`.

## Verification

- **`npm run typecheck`:** exit 0 (clean) on the final tree, re-run after the last code edit.
- **`npm run lint`:** run per touched file set; 0 errors, 0 warnings. The full-repo lint was not run separately; the orchestrator gates after integration.
- **`npm run test:unit`:** NOT run in full, on the orchestrator's instruction (parallel full runs caused memory-pressure kills; the orchestrator runs it after integration). Every new and every repinned suite was run individually and passes:
  - new: `turn-deadline`, `provider-deadline`, `conversation/turn-deadline`, `invocation-await`, `privacy/scrub`, `pacing`;
  - repinned or extended: `rate-limit-retry`, `invocation-failures`, `allowance`, `allowance-reservation`, `failures`, `chat/route`, `brief-authority`, `recent-activity`;
  - neighbours: `provider-structured`, `conversation-identity`, `guidance`, `cost-controls`, `paid-requests-admission`, `alerts`, `platform-surface`, `security-surface`, `rate-limit`, `brief/generate`, `brief/lifecycle`, `brief/package`, assemblers `fx` / `kd17` / `privacy` / `population` / `parity`, `canonical-spending-surfaces`, `category-spend-authority`, `ai-baseline/baseline`.
- **`npm run rls:accept:allowance`:** **NOT RUN.** The reservation transaction was touched (`7e84b32` adds one `rateLimit.findMany` read inside it), so this suite is required before merge. The Docker daemon was not running on the host (`~/.docker/run/docker.sock` absent; no Docker, Colima or OrbStack process). The harness failed before creating any container, so nothing was left behind. I did not start Docker Desktop under the memory pressure other agents were reporting. The unit-level `allowance-reservation.test.ts` (fake serialising transaction, incl. new §5b) passes.
  - **Expected effect on the 15 checks:** none. The lock statement is unchanged (`$executeRaw`, first statement), the added read is a plain `findMany` on `RateLimit` (fm_system holds SELECT), and the expected admission count is unchanged (`ceil(1.2/0.3675)` = 4).
  - **Orchestrator:** run it on a throwaway container before integrating this branch and record 15/15.

## `lib/ai/conversation/tools.ts` inventory (for the wave-2 modularisation agent, H)

As found at `cde8fa0`: 4,768 lines. After this branch: 4,773 lines, with one added import line and a 4-line comment in the `get_transactions` row map.

- **Header** (1–31): "adapters, not authorities"; read-only except memory; user vocabulary.
- **Imports:** 47 statements, including `MEMORY_TOOLS` from `./memory-tools` (l.114), `describeFourthMeridian` from `./product` (l.115), and `scrubDescriptor` from `@/lib/ai/privacy/scrub` (added).
- **Section markers** (`// ── … ──`), with approximate line numbers on this branch:

| Line | Section |
|---|---|
| 156 | M1: measures & comparison |
| 176 | The tool contract (`ToolContext` l.195, `ToolDefinition` l.276, `str`/`num` helpers) |
| 417 | 1. Snapshot: `getFinancialSnapshot` l.496 (`get_financial_snapshot`) |
| 563 | 2. Spending / cash flow: `getSpending` l.566 |
| 677 | 3. Transactions: `getTransactions` l.709 (the scrub site, ~l.830) |
| 887 | 4. Income + payroll cadence: `getIncome` l.894 |
| 947 | 4b. Measures & comparison: `measureFlows` l.1068, `getBaselines` l.1143 |
| 1333 | 5. Investments: `getInvestments` l.1340 |
| 1406 | 6. Net-worth history: `getNetWorthHistory` l.1413 |
| 1581 | 6b. Exact temporal facts: `findInBalanceHistory` l.1618 |
| 1761 | 7. Net-worth explanation: `explainNetWorthComposition` l.1826 |
| 2073 | 8. Cash projection, including "AI RELIABILITY (2026-10-16), the income term": `projectCash` l.2185 |
| 2470 | 9. Pay dates: `getPayDates` l.2477 |
| 2491 | 10. Investment scenario: `investmentScenario` l.2498 |
| 2545 | 11. Scenario projection and goal seek (largest block, ~1,300 lines; liability lines, `rebindDerivedFloors*`): `scenarioProjection` l.3822 |
| 3854 | 11b. Scenario threshold crossing: `scenarioCrossing` l.3883 |
| 4045 | 12. Goal seek: `scenarioGoalSeek` l.4083 |
| 4434 | 13. Reconciliation: `reconcileProjection` l.4458 |
| 4621 | Registry marker, immediately followed by a second "12." (sic): Staging, `stageAssumptions` l.4657 |

- **Exports:**
  - `CashSpineReads`, `ToolContext`, `ToolDefinition` (interfaces);
  - `TransactionPager`, `readWindowToExhaustion`, `clampToCeiling`;
  - re-exports `monthEndsBetween`, `yearEndsBetween`;
  - `interestModelledLiabilityIds`, `rebindDerivedFloors`, `rebindDerivedFloorsByDate`;
  - `TOOLS`, `openAiToolSchemas`, `findTool`.
- **`TOOLS` registry** (l.~4752). Order matters for the schema list the model sees:
  - `getFinancialSnapshot, getSpending, measureFlows, getBaselines, getTransactions, getIncome, getInvestments`
  - `getNetWorthHistory, findInBalanceHistory, explainNetWorthComposition, projectCash, getPayDates, investmentScenario`
  - `scenarioProjection, scenarioCrossing, scenarioGoalSeek, reconcileProjection, stageAssumptions`
  - `...MEMORY_TOOLS, describeFourthMeridian`
  - That is 18 local definitions plus the memory tools plus 1 from `product.ts`.
- **Importers (production):** `lib/ai/conversation/engine.ts`, `turn.ts`, `memory-tools.ts`, `product.ts` (type), `lib/ai/brief/recent-activity.ts` (`readWindowToExhaustion`).
- **Importers (tests and harness):**
  - `lib/ai/conversation/*.test.ts` (×14, incl. the new `turn-deadline.test.ts`);
  - `lib/transactions/category-spend-authority.test.ts`;
  - `scripts/ai-baseline/*.check.ts` (×15) and `baseline.test.ts`;
  - `scripts/rls-ai-acceptance.ts`.
- **Source scans that read this file by path** (must follow a split):
  - `scripts/rls-ai-acceptance.ts` checks 39 and 68 (`spansModelCall`, the oracle not handed `db`);
  - `lib/ai/privacy/scrub.test.ts` §3 (the `get_transactions` scrub pin);
  - the header's "no Prisma client in scope" assertion.

## Out-of-scope needs (for the orchestrator)

1. **Agent A** (`lib/monitoring/capture.ts`): add `"AiInvocation"` to `OperationalLedger` and remove the cast in `lib/platform/ai/ledger-health.ts`.
2. **Agent A** (`lib/platform-settings.ts`): a fleet-ceiling setting key, if SEC-AI-001 is scheduled.
3. **Agent A** (`content/marketing/legal-ai.md:27`): confirm the copy against the new behaviour; descriptions are no longer sent.
4. **Agent B** (`lib/ai/forecast/streams.ts`): income/recurring stream labels derive from `merchantDisplayName ?? merchant`. They should go through `scrubDescriptor` before reaching `project_cash` output.
5. **Agent E:** the Platform Ops AI tile could surface `LEDGER_UNTRUSTED` refusals and the `system:ai-ledger-write-failures` row.
6. **Wave 2:**
   - wire `req.signal` (client disconnect) to `deadline.abort()` once verified on the Node runtime;
   - consider reserving after a bounded body read to size the reserve from transcript bytes.
