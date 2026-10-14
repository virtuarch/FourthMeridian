# AI RUNTIME — MULTI-PROVIDER READINESS ASSESSMENT (ANTHROPIC CLAUDE, GOOGLE GEMINI)

**Status:** PREIMPLEMENTATION / AWAITING OWNER REVIEW · **Date:** 2026-10-15 · **Branch:** v2.6 · **Baseline:** 3241f16 (docs on top) · **Mode:** read-only; no code, schema, config or Production change; no provider called; no SDK installed.

**Question:** how ready is the AI runtime for additional LLM providers, and what is the smallest architecture change that enables controlled model comparisons **without modifying the current production runtime**?

**Evidence tiers:** VERIFIED (file:line at the baseline; provider facts from the official references named in §9, fetched 2026-10-15) · PROPOSED · UNKNOWN.

---

## 1. Answer in one paragraph

The runtime is a single-provider design with one clean seam. Every OpenAI call goes through three functions in `lib/ai/provider.ts` (one SDK import, three `chat.completions.create` sites), and the two production callers already accept an injected generator: `executeTurn({ generate? })` for conversations and `generateBriefFromPackage({ deps: { structured? } })` for the Daily Brief. The OpenAI chat-completions message array is, however, the transcript format for the conversation loop, compaction, measurement and four mid-transcript system envelopes, so a "neutral" message shape would touch at least six modules and a dozen source pins. The smallest change therefore keeps that array as the lingua franca and adds **per-call adapters** (`anthropic.ts`, `gemini.ts`) under the evaluation harness that translate request and response at the edge, write the same `AiInvocation`/`ApiUsageCounter` rows with a different `provider` string, and are selected only by an explicit harness arm `{provider, model}`. Production stays byte-identical, and a source scan pins that nothing under `lib/`, `app/` or `components/` imports the adapters or the two SDKs. Two accounting changes are needed for honest comparison: an optional cached-token field on the tool-turn result (today the harness cannot see cache share), and a cache-creation token unit plus a cache-write rate in the pricing authority (Anthropic bills cache writes at a premium; Gemini bills explicit-cache storage per hour). About five to seven engineering days, none on the production path.

---

## 2. OpenAI-specific dependencies (VERIFIED)

| Concern | Evidence |
|---|---|
| The only SDK import; client without timeout or retry overrides | `lib/ai/provider.ts:18,46`; pinned to one import by `lib/usage/ai-tokens.test.ts:139-140` |
| Usage vocabulary typed on OpenAI fields (`prompt_tokens`, `completion_tokens`, `prompt_tokens_details.cached_tokens`, `completion_tokens_details.reasoning_tokens`) | `lib/usage/ai-tokens.ts:47-55,94-102`; ledger input typed `OpenAiUsage` `lib/ai/invocation.ts:51,59,150-153` |
| Transcript = OpenAI message array: system → user evidence → prose history → **four mid-transcript `role:'system'` envelopes** (continuity `continuity.ts:20-25`, pending plan `pending-plan.ts:720-726`, active scenario `active-scenario.ts:384-385` trailing slot, provenance `provenance.ts:202-207`) → user question → raw assistant message appended verbatim (`turn.ts:417`) → one `role:'tool'` message per result with `tool_call_id` (`turn.ts:479`) | `lib/ai/conversation/engine.ts:195-226`; `turn.ts:383-390` |
| `finish_reason` literals `'length'`/`'stop'` tested; `tool_calls` read for measurement; compaction serialises the OpenAI wire shape | `turn.ts:492-496,521-526`; `lib/ai/conversation/compaction.ts:52-55,80-83,113,131-133,149` |
| Tool registry: 18 tools as `{type:'function', function:{name, description, parameters}}`, non-strict; `obj()` sets `additionalProperties:false`; schemas use `enum` ×15, `anyOf` ×2, `minimum` ×19, `maximum` ×3, `items` ×5, `default` ×1; no `$ref`/`oneOf`/`format` | `lib/ai/conversation/tools.ts:275-284,1075,3973,4546-4563` |
| Request dialect: `tool_choice:'auto'`; `max_completion_tokens` for `gpt-5|gpt-6|o\d` else `max_tokens`+`temperature:0.3`; budgets 1,500 classic / reasoning | `provider.ts:277-279,292-297,313-320` |
| Structured outputs: `response_format: json_schema` with `strict:true`; `refusal` field; Brief and labeller schemas; post-hoc validators that survive a non-strict provider | `provider.ts:453-456,490-491`; `lib/ai/brief/contract.ts:30-93`; `lib/ai/conversation/guidance.ts:225-245,291-300`; pinned `lib/ai/provider-structured.test.ts:79-80` |
| Request id `_request_id`; errors by `.status === 429`, `insufficient_quota`, "try again in Ns" parse; failure classification by `.code/.status/.name` | `provider.ts:150-151,166-170`; `lib/ai/rate-limit-retry.ts:67-85`; `invocation.ts:114-123` |
| `'OPENAI'` literals: writers, Brief cost, platform model filter, provider-health row, all eight rates | `provider.ts:116,125,153`; `lib/ai/brief/generate.ts:207`; `lib/platform/ai/ai-usage.ts:78`; `components/platform/widgets/provider-view.ts:165-180`; `lib/usage/pricing.ts:71-86` |
| Model selection: `CHAT_MODEL='gpt-5.1'` hard-coded, no env override by design; Brief and labeller reuse it; `AI_CHAT_MODEL` reaches only a dead helper and an omitted-model fallback | `engine.ts:53-61,378-382`; `lib/ai/brief/daily-brief.ts:21,26`; `provider.ts:67,201,440` |
| Model-specific prompt text: **none** (only the `supportsTools` regex `turn.ts:221-223`) | grep over the prompt modules |

Installed: `openai` 6.45.0 only (`package.json:117`). No `@anthropic-ai/sdk`, no `@google/genai`.

## 3. The seam (VERIFIED)

| Export | Production importer | Contract |
|---|---|---|
| `generateWithTools({ model, messages, tools?, maxTokens? })` → `ToolTurnResult { content, toolCalls[{id,name,arguments}], raw, usage {promptTokens, completionTokens, totalTokens, reasoningTokens} \| null, latencyMs, finishReason }` | `lib/ai/conversation/turn.ts:26`, single call site `:405` | **no `cachedPromptTokens`, no requestId, no provider, no model** on the result (`provider.ts:254-274`) |
| `generateStructuredWithUsage(systemPrompt, messages, schema, options?, deps? { client?, sinks? })` → `StructuredResult { value, model, latencyMs, finishReason, usage {promptTokens, cachedPromptTokens, completionTokens, reasoningTokens} \| null }` | labeller `engine.ts:43`; Brief `lib/ai/brief/generate.ts:41` | injectable `client`/`sinks` already exist (`provider.ts:398-411`) |
| `generateChatReply`, `generateStructured`, `ChatMessage` | no runtime callers; existence pinned `ai-tokens.test.ts:125-127` | dead but pinned |

Writers are exported and callable from anywhere: `recordAiInvocation` (`invocation.ts:138`), `recordAiInvocationFailure` (`:172`), `recordApiUsage` (`lib/usage/record.ts:37`). The pins that protect production count things **inside `provider.ts` only**: three `recordOpenAiUsage({`, one `recordAiInvocation(`, one SDK import (`invocation-economics.test.ts:160-164`; `ai-tokens.test.ts:120-143`), and one `recordOpenAiFailure` per `completions.create` (`invocation-failures.test.ts:131-138`).

Injection points that already exist: `executeTurn({ generate?: typeof generateWithTools })` (`turn.ts:289`, documented "tests only"); `runStatelessTurn({ classify?, instruction?, model? })` (`engine.ts:293,310,312`) — **no `generate` passthrough** (`engine.ts:340-347`); `generateBriefFromPackage({ deps: { structured? } })` (`generate.ts:230`).

Attribution is provider-neutral: AsyncLocalStorage context (`lib/ai/invocation-context.ts:73-83`); `AiInvocation.provider` and `ApiUsageCounter.provider` are free strings, not enums (`prisma/migrations/20260908222415_ai_invocation/migration.sql:4`; `lib/usage/record.ts:32`). Platform readers key by `${provider}:${model}` (`invocations-core.ts:137`) and re-emit the three units from the columns — provider-agnostic once the columns are filled, except the operator model list that filters `provider === "OPENAI"` (`ai-usage.ts:78`).

## 4. Provider token accounting (VERIFIED provider facts; mapping PROPOSED)

| Ledger column / unit | OpenAI (today) | Anthropic Claude (Messages API) | Google Gemini |
|---|---|---|---|
| `promptTokens` | `prompt_tokens` (includes cached) | `input_tokens` is the **uncached** remainder; `cache_read_input_tokens` and `cache_creation_input_tokens` are reported separately ⇒ the adapter must **sum the three** to keep the ledger's invariant `cached ⊆ prompt` (`ai-tokens.ts:12`) | Interactions API `usage` reports `total_input_tokens` and `total_cached_tokens`; whether cached is a subset of input is **not stated** on the token docs page (UNKNOWN until verified against a live response) |
| `cachedPromptTokens` | `prompt_tokens_details.cached_tokens` (rounded down to 128 on older models) | `cache_read_input_tokens`; billed at the cache-read rate ($0.20 per 1M on Opus 5.5 and Sonnet 5.5; $0.25 on Fable 5.1) | `total_cached_tokens`; billed at the "context caching" read price (e.g. $0.125 per 1M on Gemini 2.5 Pro ≤200K) |
| **cache writes** | none (automatic caching, no write charge on models before GPT-5.6) | `cache_creation_input_tokens`, billed at about 1.25× the input rate (5-minute TTL; higher for the 1-hour TTL) — **no column and no counter unit exist** ⇒ lost, or mispriced at 1× if folded into `promptTokens` | explicit caches bill **storage per token-hour** (e.g. $4.50/hr per 1M on Gemini 2.5 Pro) — no unit can express it; implicit caching has no write charge |
| `completionTokens` | `completion_tokens` (reasoning inside) | `output_tokens` (thinking inside) | `total_output_tokens`; pricing page states output price "including thinking tokens" |
| `reasoningTokens` | `completion_tokens_details.reasoning_tokens` (0 on gpt-5.1 without `reasoning_effort`) | not reported as a count; thinking is billed as output ⇒ stored `0`, **ambiguous with "none"** | `total_thought_tokens` reported separately; whether included in `total_output_tokens` not stated (UNKNOWN) |
| `finishReason` | `stop \| tool_calls \| length` (tested literally) | `end_turn \| tool_use \| max_tokens \| pause_turn \| refusal` — map; `refusal` has no OpenAI analogue in the loop | `STOP \| MAX_TOKENS \| …` — map |
| `providerRequestId` | `_request_id` | request-id header via SDK | response id |
| errors | `.status 429`, `insufficient_quota` | typed SDK errors with `.status`; 529 overloaded has no mapping | 429 `RESOURCE_EXHAUSTED` |
| `ApiUsageCounter.metric` | `chat.completions:<model>`; `modelFromMetric` requires that prefix (`pricing.ts:179-182`) | a naming convention, not an SDK dependency | same |
| pricing | `rateAt(provider, model, day)` is provider-keyed; `AiRate.usdPerMillion = {input, cachedInput, output}` has **no cacheWrite** (`pricing.ts:50,252-257`); `pricing.test.ts:145` pins every rate `OPENAI`; `:151-156` pins `cachedInput ≤ input` | needs `cacheWriteInput` | needs `cacheWriteInput` (explicit) or a storage term |

Official rates to configure if arms are approved (per 1M tokens, verified 2026-10-15): Claude Opus 5.5 `claude-opus-5-5` $4 in / $20 out, cache read $0.20; Claude Sonnet 5.5 `claude-sonnet-5-5` $2 / $10, cache read $0.20; Claude Haiku 5.5 `claude-haiku-5-5` $0.10 / $0.50 (prompts ≤100K); Gemini 2.5 Pro `gemini-2.5-pro` $1.25 / $10.00 (≤200K), cache read $0.125, storage $4.50/hr; Gemini 2.5 Flash `gemini-2.5-flash` $0.30 / $2.50, cache read $0.03; Gemini 3.1 Pro Preview `gemini-3.1-pro-preview` $2.00 / $12.00 (≤200K), cache read $0.20; Gemini 4 Argon `gemini-4-argon` $2.00 / $10.00 through 2026-11-30 then $4.00 / $20.00. Gemini prices carry scheduled increases and prompt-size tiers, which the rate card's single-tier shape cannot express.

## 5. Tool-call compatibility (VERIFIED current; provider facts VERIFIED)

| Property | Current runtime | Anthropic | Gemini |
|---|---|---|---|
| Tool definition | `{name, description, parameters}` JSON schema, non-strict | `{name, description, input_schema}`; optional `strict: true` (schema needs `additionalProperties:false` + `required`, which `obj()` already produces) | `functionDeclarations {name, description, parameters}`; `additionalProperties` historically unsupported — adapter strips it; the two `anyOf` sites need verification or rewrite |
| `tool_choice` | `'auto'` only | `{type:'auto'}`; forced `any`/`tool` is **rejected (400)** on Opus 5.5 and Sonnet 5.5 — the runtime never forces, so no change | `AUTO` |
| Parallel calls | several calls per response executed sequentially; one `role:'tool'` message each | several `tool_use` blocks; results must be returned as **one user message** of `tool_result` blocks (splitting them degrades parallel calling) | several `functionCall` parts; results as `functionResponse` parts |
| Rounds | 6 round trips / 16 calls per turn (`turn.ts:203,212`) | same loop | same loop |
| Structured outputs | `response_format` json_schema strict | `output_config.format` (structured outputs) or a strict tool; no assistant prefill on current models | `responseSchema` (subset) |
| Thinking | `reasoning_effort` not set; reasoning hidden in output | adaptive thinking on by default on Opus 5.5 / Sonnet 5.5 (cannot be disabled on Opus 5.5; `effort` is the lever; default effort differs by model) — the adapter must declare effort per arm | thinking on by default on 2.5+/3.x; thought tokens billed as output |
| Validators that make non-strict safe | Brief `contract.ts:63-93`; labeller `guidance.ts:239-245` | reuse | reuse |

## 6. Evaluation harness reuse (VERIFIED)

- Arms are **evidence arms** A0–A3 (`lib/ai/conversation/evidence.ts:54-64`), not providers; model tiers are strings (`scripts/ai-conversation-baseline.ts:55-69`: control gpt-4o-mini, mid gpt-4.1, ceiling gpt-5.5, candidate gpt-5.1, frontier gpt-6-astra; a `claude` prefix is already accepted at `:83` but would still hit the OpenAI client).
- Correlation `${probeId}:${arm}:${model}:${runDir}` (`run.ts:100`), surface `harness` (`turn.ts:292`), artifacts per probe/arm/model (`run.ts:115-131`) with a tier comparison table (`artifacts.ts:73-89`); conversation scoring is human review over probes (`run.ts:136-150`), Brief scoring is regex goldens over fixture packages with cost from the ledger row (`daily-brief.check.ts:53-82,174-182`).
- Conversation artifacts carry tokens but **no cached tokens and no USD** (`run.ts:42-44`) because `ToolTurnResult.usage` omits cached tokens.
- OpenAI-bound in the harness: model strings, `supportsTools`/`usesModernParams`, `.function.name` reads (`run.ts:121`, `interactive.ts:96`), and the seam. Nothing else.
- Database rule: harness rows are written to whatever database is in force (`invocation.ts:128` systemDb) under `FM_DB_GUARD=clone-only` (`lib/db.ts:20-33`) and `FM_AI_MEMORY_WRITES=clone-only`; `memory-isolation.test.ts:104-109` pins every harness script.

## 7. Smallest change for controlled comparisons (PROPOSED)

**Keep the OpenAI message array as the transcript format; translate per call at the edge; select by an explicit harness arm; never in production.**

```
scripts/ai-baseline/providers/           research code — never imported by lib/, app/, components/
  types.ts      ChatProvider = { id: 'OPENAI'|'ANTHROPIC'|'GEMINI';
                  generateWithTools: typeof generateWithTools;   // same ToolTurnResult; raw stays OpenAI-shaped
                  generateStructured: StructuredCall }           // generate.ts's existing injected type
  openai.ts     re-exports lib/ai/provider.ts (zero change; every pin holds)
  anthropic.ts  OpenAI-shaped messages/tools → Messages API; tool_use/tool_result mapping; stop_reason map;
                usage summed into the OpenAiUsage shape (+ cache creation); writes the ledger with provider 'ANTHROPIC'
  gemini.ts     systemInstruction; strip additionalProperties; functionCall/functionResponse; responseSchema;
                thought tokens → reasoning; writes the ledger with provider 'GEMINI'
```

| # | Step | Touches | Effort | Production risk |
|---|---|---|---|---|
| 1 | `types.ts` + `openai.ts`; add optional `cachedPromptTokens?` and `cacheCreationTokens?` to `ToolTurnResult.usage` (additive; `provider.ts:260-271` fills cached from `prompt_tokens_details`); harness totals show cache share and USD | `provider.ts` (+2 optional fields), `run.ts` | 0.5 d | none |
| 2 | Anthropic adapter: system messages → top-level `system`; **re-home the four mid-transcript envelopes** (prepend to the next user message under their markers); `tool_calls` → `tool_use`; consecutive `role:'tool'` → one user message of `tool_result`; stop-reason map; usage = `input + cache_read + cache_creation`; errors rethrown with `.status`; thinking/effort declared per arm; `@anthropic-ai/sdk` as a **devDependency** | new file | 1.5–2 d | none |
| 3 | Gemini adapter: `systemInstruction`; strip `additionalProperties`; verify or rewrite the two `anyOf` schemas (`tools.ts:1075,3973`); `functionCall`/`functionResponse`; `responseSchema` for structured; `total_thought_tokens` → reasoning; `@google/genai` as a devDependency | new file | 1.5–2 d | none |
| 4 | Ledger: `cacheCreationTokens Int @default(0)` on `AiInvocation` + unit `cache_creation_tokens` (`ai-tokens.ts:64-72`) — **schema migration, needs owner approval**; the table is fm_system-only, grants unaffected. Fallback without migration: fold creation into `promptTokens` and state that Anthropic input cost is understated by the write premium | schema, `invocation.ts:150-153`, `ai-tokens.ts` | 0.5 d + approval | low (additive) |
| 5 | Pricing: `AiRate.usdPerMillion.cacheWriteInput?`; `priceAiUsage` adds the creation term; dated, sourced ANTHROPIC/GEMINI rates; relax `pricing.test.ts:145` to "provider ∈ known set"; `generate.ts:207` → `rateAt(result.provider ?? 'OPENAI', …)` with `provider` on `StructuredResult` | `pricing.ts`, tests, `generate.ts` | 0.5 d | low |
| 6 | Harness arm = `{provider, model}`: `TIERS` entries become objects; `run.ts` passes `generate: provider.generateWithTools` to `executeTurn` (already allowed); artifact names and correlation ids include the provider; `daily-brief.check.ts` passes `deps.structured`; labeller via `runStatelessTurn.classify`. For stateless comparisons add an optional one-line `generate?` passthrough in `engine.ts:340-347` (the HTTP route cannot pass it — `app/api/ai/chat/route.test.ts:36`) | scripts (+1 optional line) | 1 d | none |
| 7 | Guards: keep `turn.ts:26` and `engine.ts:43` imports and the single call site (`baseline.test.ts:488`, `rls-ai-acceptance.ts:421-424,786`); new scan: no file under `lib/ app/ components/` imports `scripts/ai-baseline/providers`, `@anthropic-ai/sdk` or `@google/genai`; `generate:` in `lib/` appears only in tests; SDKs in `devDependencies`; widen or leave `ai-usage.ts:78` | tests | 0.5 d | none |

Total ≈ 5–7 engineering days. The production path is unchanged by construction: `provider.ts` keeps its three `create` sites, its one SDK import and its writers; every existing pin holds without edits. Why under `scripts/` rather than `lib/ai/providers/`: Next never bundles `scripts/`, so "never in production" is structural, not a convention; if the owner prefers `lib/ai/providers/`, the same source scan applies to the selector.

## 8. What cannot be made equivalent, and how to compare honestly

1. **Strict schema semantics** differ (OpenAI enforces `strict:true` at the provider; Anthropic strict tools and structured outputs enforce differently; Gemini `responseSchema` is a subset). Compare on the **validator-accepted rate** using the existing post-hoc validators, not on provider rejections.
2. **Mid-transcript system envelopes** must be re-homed for Anthropic (Claude Opus 5.5 and Sonnet 5.5 accept mid-conversation `role:"system"` messages under placement rules; Sonnet 5 does not) and for Gemini. Re-homing is an experimental variable: run an OpenAI control arm through the same re-homing (the harness already supports instruction variants, `engine.ts:157`).
3. **Parallel tool calls and round-trip counts** are model behaviour; `roundTrips` and `toolCalls` are recorded separately (`run.ts:42-44`) — report both, never "tokens".
4. **Reasoning visibility and budgets**: OpenAI bills reasoning inside `completion_tokens` under `max_completion_tokens`; Anthropic thinking is adaptive with `effort` as the lever and thinking blocks replayed on the same model; Gemini reports thought tokens. `reasoningTokens = 0` is ambiguous for Anthropic. `completionBudgetFor` returns the classic 1,500 for any non-gpt id (`provider.ts:295-297`) — adapters set their own budgets.
5. **Caching**: OpenAI caches automatically; Anthropic caches only at explicit `cache_control` breakpoints (prefix match, tools → system → messages order; cache writes at a premium); Gemini has implicit and explicit caching with storage cost. Declare the cache policy per arm; first comparison with no breakpoints, cache tokens reported separately, USD stated as a configured-rate estimate (as `pricing.ts:9-11` already says).
6. **Tokenizers differ** — compare USD and latency, not token counts.
7. **Stop-reason vocabularies, tool-call id formats, default temperature** (classic dialect sends 0.3; modern sends none; Anthropic and Gemini default 1.0) and **refusal** stop reasons (Anthropic `stop_reason: "refusal"` with `stop_details`) — declare per arm; map refusal to a FAILED-class outcome with its own error code.
8. **Retry and quota predicates** are OpenAI-worded (`rate-limit-retry.ts:67-85`); adapters throw errors carrying `.status` and do not rely on the "try again in Ns" parse.

Two pre-existing gaps worth fixing regardless of providers: `ToolTurnResult.usage` omits cached tokens (artifacts cannot show cache share or cost); `AI_CHAT_MODEL` is documented as the chat tier but is unreachable in production, and `generateChatReply`/`generateStructured` are dead yet pinned (`ai-tokens.test.ts:125-127`).

## 9. Decisions requiring owner approval

| # | Decision |
|---|---|
| P1 | Approve the adapter location (`scripts/ai-baseline/providers/`, recommended) and the "never in production" source scan |
| P2 | Approve the additive `cacheCreationTokens` column and `cache_creation_tokens` unit (schema migration) — or accept the fold-into-prompt fallback with understated Anthropic input cost |
| P3 | Approve `cacheWriteInput` on the rate card and the ANTHROPIC/GEMINI rate entries with their sources and dates; accept that Gemini prompt-size tiers and scheduled price changes need either dated entries or a second rate shape |
| P4 | Which models form the first comparison set (recommended: `claude-opus-5-5`, `claude-sonnet-5-5`, `gemini-2.5-pro`, `gemini-2.5-flash` against `gpt-5.1`), with declared effort/thinking and cache policy per arm |
| P5 | Add `@anthropic-ai/sdk` and `@google/genai` as devDependencies (new dependencies, dev-only) |
| P6 | Provider credentials: new env names for the harness only (`ANTHROPIC_API_KEY`, `GEMINI_API_KEY`), never read by production code; budget for the comparison runs (every run spends real money) |
| P7 | Whether to add the one-line `generate?` passthrough to `runStatelessTurn` for stateless comparisons |

## 10. Sources

- Repository at 3241f16: files cited inline.
- Anthropic: Claude API reference bundled with this session's `claude-api` skill (model ids and prices cached 2026-10-06; usage fields `input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`; cache write ≈1.25× input, cache read $0.20 per 1M on Opus 5.5 / Sonnet 5.5; thinking billed as output; strict tool use; structured outputs `output_config.format`; parallel tool results in one user message; forced `tool_choice` removed on Opus 5.5 / Sonnet 5.5; no assistant prefill; mid-conversation system messages on Opus 5.5 / Sonnet 5.5).
- Google: https://ai.google.dev/gemini-api/docs/pricing (page marked "Last updated 2026-10-14 UTC"; fetched 2026-10-15); https://ai.google.dev/gemini-api/docs/tokens (fetched 2026-10-15; Interactions `usage` fields; subset semantics not stated).
- OpenAI: https://developers.openai.com/docs/pricing, /docs/guides/prompt-caching, /docs/guides/reasoning (fetched 2026-10-15).

*Assessment only. No implementation was started; no SDK was installed; no provider was called.*
