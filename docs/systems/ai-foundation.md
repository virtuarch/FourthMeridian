# AI Foundation — Financial Intelligence

*Governs how the platform thinks: deterministic modules compute financial knowledge, and anything that speaks about money narrates what they computed. The north-star reference every future architectural proposal is measured against. These are binding rules; the [implementation map](#implementation--the-ai-subsystem-as-built) at the end says what is built today. See also [Financial Truth Spine](../architecture/FINANCIAL_TRUTH_SPINE.md), [money & FX](./money-and-fx.md).*

> **New here? The one inversion.** **Financial Intelligence is NOT AI.** Financial
> Intelligence is *deterministic knowledge* — computed by pure, versioned code from
> stored records. **The LLM is a *consumer*** of those computed facts: it phrases,
> explains, and arranges; it never invents a number, classifies a flow, or becomes a
> fact other code reads. Fourth Meridian would rather tell a user *less but true* than
> *more but drifting*. Where does an AI feature attach? Through **one** provider seam
> (`lib/ai/provider.ts`, the only OpenAI import site), reading grounded context built
> by `buildContext`, gated by the **one** visibility predicate (`[FULL]`), narrating
> facts the [Financial Truth Spine](../architecture/FINANCIAL_TRUTH_SPINE.md) already
> computed. (An output validator used to referee the model's numbers; it was removed
> with the conversation layer. The principle survives; that implementation does not.)
> The implementation section at the end of this doc is the map; the doctrine below is
> the law.

This is the foundational architectural doctrine for Financial Intelligence inside
Fourth Meridian. It defines how the platform thinks, how future systems must be
designed, how new ideas are classified, and how architectural drift is prevented.
It is doctrine, not description — it states what must be true, not what happens to
be true today. (Implementation detail lives in the
"Implementation" part at the end of this file.)

---

## 1. Vision

**Fourth Meridian is building a Financial Intelligence Platform.** The durable
asset is not a chat product and not a set of screens — it is a body of
*deterministic financial knowledge*, computed once, owned by exactly one authority
each, carrying its own provenance, and reused by every surface that needs it.

**Financial Intelligence is not AI.** This is the inversion the whole platform
rests on. The mainstream AI-PFM failure mode is LLM-over-raw-data: pour
transactions into a prompt, let the model do the arithmetic, and accept that the
figures drift between answers. Fourth Meridian refuses that shape. The relationship
between the two layers is fixed and directional:

- **Financial Intelligence is deterministic knowledge.** It is computed by pure, versioned code from stored records. It can be wrong only in the specific, honest sense that its inputs were incomplete or its inference was fallible — and when it is, it says so.
- **AI consumes Financial Intelligence.** The LLM is a *consumer* of serialized facts. It phrases, explains, and arranges. It reasons over numbers it was handed; it does not invent them.
- **LLMs narrate. They never become canonical.** No figure, relationship, category, or claim is ever authoritative because a model produced it. The moment a model's output would become a fact other code reads, the architecture has failed. Canonical knowledge has one home, and that home is never a prompt.

Fourth Meridian would rather tell a user less than tell them wrong, and it builds
the architecture that makes "less but true" cheaper than "more but drifting."

---

## 2. Core Philosophy

These principles are the platform's constitution — laws, not preferences. Every
module, consumer, and future proposal inherits them.

**Compute once.** A fact is computed in exactly one place — its definition site.
Not once per surface, once per request path, or once per redesign. "Compute once"
governs the *definition*, not the *execution*: a fact may be recomputed at read
time on every request and still obey it, provided one place defines how it is
computed.

**Reuse everywhere.** Once a fact exists, every consumer reads it. A second
computation of an existing fact is a defect, because two computations drift and the
platform's whole value is that they cannot.

**Facts have one authority.** Every named claim about a user's finances has exactly
one owner, forever — not one owner per feature, per table, or per release. This is
the strongest single rule in the document.

**Every claim has provenance.** No fact travels without its lineage: which inputs
produced it, at what freshness, under which visibility tiers, and at which version
of the computation. Provenance is what makes "why did my number change" answerable
and what the output validator ultimately checks against.

**Honesty is a feature.** The honesty valve is product behavior. Insufficient
signal yields UNKNOWN, null, or absence — never a fabricated value dressed as fact.
Estimates are always labeled. This applies with *more* force to composite scores
and forecasts, not less, because those are where false confidence is most tempting.

**Determinism first.** Same inputs plus an injected clock yield byte-identical
output. An LLM-computed "fact" is banned everywhere, not merely discouraged.

**Consumers never invent facts.** A surface may select, arrange, filter, threshold
for display, and present. It may never define a fact, an aggregation, or a
membership predicate.

**LLMs explain. They do not compute.** The model receives serialized, pre-computed
facts and turns them into language. It never performs the arithmetic, resolves the
identity, or classifies the flow. Facts reach it as aggregates and stored labels it
phrases — never as raw per-row dumps to reason over.

---

## 3. Architectural Taxonomy

Fourth Meridian recognizes exactly **six categories plus one substrate**. Every
component, initiative, and proposed idea belongs to exactly one. The categories are
contracts, each with a distinct discipline and a distinct set of things it must
*never* own.

| Category | One-line contract |
|---|---|
| **Records** (substrate) | Immutable / append-only stored reality; asserts nothing beyond "this was captured." (Transaction rows, FinancialAccount, FxRate archive, SpaceSnapshot once written.) |
| **Intelligence** | The sole, versioned, deterministic authority for a named family of *fallible derived financial claims*. (Transaction, Merchant, Financial Health, Coverage.) |
| **Infrastructure** | Correct-or-buggy supporting computation and plumbing; no semantic claims, no confidence, code-versioned only. (Period math, currency conversion, normalization, parsers, provider adapters, registries/engines, visibility predicates.) |
| **Context** | Declared or operational state that computation consumes but never derives; told, not inferred. (User profile, age band, employment, risk tolerance when declared, provider capabilities, session, preferences, flags, conversation state.) |
| **Consumers** | Select, arrange, filter, and present owned facts; assert nothing new. (Dashboard, Briefs, Advisor serializer, Search, Notifications content, Platform Operations views.) |
| **Delivery** | Move finished outputs across time and channels; compute nothing. (Scheduler, jobs, automation, notification transport, Ambient.) |
| **Enforcement** | Deterministically police artifacts and boundaries; own judgments about *outputs*, never about finances. (Output validator, guardrails, policies, invariant checks, rate limiting, visibility gates.) |

Two subtleties are doctrine because they recur:

- **Engines are Infrastructure; their content is Intelligence.** The Perspective Engine (registry, shaping, `validateLensResult`) is Infrastructure — it cannot be wrong about finances. Each lens *core* is Intelligence, owned by a domain module. The same split governs the assembler registry vs the assemblers, and the notification machinery vs the facts notifications carry.
- **Initiative names and registry membership are different namespaces.** An initiative may be called anything ("Advisor Intelligence," "Ambient Intelligence"). The registry admits only components that pass the Wrongness Test — say this explicitly or the initiative ledger silently becomes the registry.

`SpaceSnapshot` is the deliberate hinge: its *computation* is Intelligence-adjacent
(an aggregate with provenance and an `isEstimated` flag), but the *instant it is
written it becomes a Record* — frozen, dated, never edited (history is never
rewritten).

---

## 4. The Wrongness Test

**This is the first question asked before any new architecture is created.**

> **Could this component's output be *wrong about the user's finances* while the
> code is bug-free?**

- **YES → it is Intelligence.** It makes a fallible claim about financial reality and must carry the full apparatus: single authority, deterministic core, honesty valve, machine-readable explanation, provenance, versioning, and (where inference is fallible) confidence.
- **NO → it is something else, and must not be called Intelligence.** Naming it Intelligence only dilutes the doctrine.

The discriminating property is **fallible semantic derivation**: Intelligence
*asserts* something the records do not say ("this row is one leg of a transfer,"
"your runway is 3.2 months," "these two merchants are the same brand").

**When the answer is NO**, three questions place it: content *declared* by a user /
operator / provider → **Context**; *selects / arranges / presents* facts owned
elsewhere → **Consumer**; *moves or schedules* finished outputs → **Delivery**;
*polices* outputs or boundaries → **Enforcement**; otherwise → **Infrastructure**.

**When the answer is YES**, two questions decide whether it is a *new* module: if
another module already owns the family, it is a **facet** (extend it) or a
**duplicate** (kill it), not a new module; if fewer than two consumers read the
claims through a typed contract, it is **consumer-internal logic** — record it, and
promote it (by *moving* the code, never copying) when the second consumer appears.

**Two intuitive-but-wrong criteria are explicitly rejected:** "derives from
multiple sources" is not a signal (`flowType` derives substantially from one row
and is the kernel of the architecture; the Daily Brief reads everything and owns
nothing); "is deterministic" is not distinguishing (everything here is
deterministic — determinism is the constitution, not Intelligence's badge).

---

## 5. Intelligence — the precise definition

> **An Intelligence module is the sole, versioned, deterministic authority for a
> named family of derived financial claims — statements about financial reality
> that are not present in the raw records, that could therefore be wrong, and that
> consequently must carry provenance, an honesty valve, and (where inference is
> fallible) confidence — exposed as typed, reusable outputs.**

A component is an Intelligence module only if it satisfies **all seven** at birth:

1. **Fallible semantic derivation** — claims not present in the records, wrong even with bug-free code.
2. **Canonical ownership** — the sole authority for that family; no second definition site anywhere.
3. **Deterministic pure core** — same inputs plus injected clock yield identical output; no LLM, no I/O in the core (enforced by import-graph tripwire tests). Fail closed and *fail shaped*: a failure yields a typed `COMPUTE_FAILED`, never raw error text and never a guessed value.
4. **Honesty valve** — insufficient signal degrades to UNKNOWN / null / absence; estimates always labeled. Applies with extra force to composite scores and forecasts.
5. **Explainability** — machine reasons (stable enums, not prose) for every claim.
6. **Provenance** — inputs, freshness, visibility tiers, and consumed fact-versions carried with every output.
7. **Reusable typed contract** — outputs designed for more than one consumer.

**Conditional:** *confidence* where the derivation is fallible inference,
*completeness* where the risk is missing inputs. Never stamp `HIGH` reflexively — a
confidence field that is always `HIGH` is confidence theater.

**Versioning** makes claims correctable at scale. Fact modules version rows
(`FLOW_CLASSIFIER_VERSION`, `tiFactsVersion`) so backfill runs over stale rows
(`WHERE version < N`) and "why did my number change" is answerable; aggregate
modules version math (`lensVersion`) so outputs are comparable across time. A
downstream output records the versions of the facts it consumed, so a backfill
*explains* any shift instead of mystifying it.

**Persistence is a per-fact decision, never a defining property.** The read-time
relationship resolver computes real Intelligence unpersisted, because those facts
are cheap to recompute. Persist when recompute cost is high, or write-path stamping
enables backfill economics, or consumers need cross-time comparability; otherwise
recompute at read. Persisting cheap aggregates only manufactures staleness and
invalidation machinery for no benefit.

---

## 6. Registry — the ledger of Intelligence modules

Everything else lives in the taxonomy, not the registry. The core registry is
small and earns each entry: **Transaction** (row facts + read-time relationships),
**Merchant** (identity, category provenance), **Financial Health** (cross-domain
assessment), **Coverage** (data sufficiency / completeness — a first-class
epistemic module, because "income is complete enough to state a savings rate" can
be wrong).

**Modules must earn their existence.** A module exists only when it owns a named
family of fallible claims no existing module owns, at least two consumers need those
claims through a typed contract, and it satisfies all seven §5 requirements *at
birth*. New claims default into existing modules — the bar for a new module is
higher than the bar for a new facet; **when in doubt, extend.** The registry is
append-justified and prune-eager: an entry whose gate never clears is removed.
Steady state is roughly six members; past ~10 is a signal the definition is being
diluted, not that the platform got smarter.

**Folded elsewhere, by ruling:** Opportunity → Financial Health · Subscription →
recurrence facts + a Consumer surface · User → Context · Advisor → Context +
Consumer discipline · Ambient → Delivery. **Never (recorded so they stay dead):**
Location, Behavior, Time, Crypto-as-module, and any per-surface "Search / Brief /
Dashboard Intelligence."

---

## 7. The non-Intelligence categories

- **Infrastructure owns zero financial knowledge.** Correctness is binary — correct or buggy, never "low confidence." Infrastructure with Intelligence trappings is false precision (a `confidence` on period math launders arithmetic into judgment); Intelligence hiding in Infrastructure is unaccountable (the CSV `mapCategory` keyword table — semantic inference in a parser with no version, no owner — is the cautionary tale). If a conversion cannot be performed, that is a *missing Record* surfaced as a **Coverage fact**, not low-confidence Infrastructure. Infrastructure is allowed to be wrong only in ways a unit test can catch.
- **Context is declared, never derived.** The defining property is the direction of truth: Context is *told* to the system and changed by re-declaration, not by backfill. It cannot be *wrong about the finances* — only stale, missing, or misdeclared. It still needs governance (a single definition site; coarse-enum / never-raw-DOB privacy; declared-when/declared-by provenance), but never module machinery.
- **Consumers assemble Intelligence and own zero canonical financial claims.** A Consumer may own view logic, display thresholds, scope selection, and composition. It may never own a fact definition, an aggregation, or a membership predicate. Consumer-owned facts diverge across surfaces, are invisible to Enforcement, and cannot be versioned or backfilled — and presentation is the highest-turnover layer, so authority belongs in the slowest-changing layer that can host it.
- **Delivery distributes information; it never computes intelligence.** Its disciplines are idempotence, retry, opt-out, and audit — operational, not epistemic. The proof it adds no claims is its own exit criterion: outputs delivered with *zero validator failures*.
- **Enforcement is the referee, not a player.** It owns judgments about *artifacts* ("this reply contains an unreconciled figure"), never about finances. A validator that owned a financial fact would validate itself, and the honesty guarantee would collapse into a tautology. Its trajectory — from *membership* validation ("this figure appears in context") to *provenance* validation ("this figure is `assessment.cashFlow.estimatedMonthlyExpenses` v3") — makes it stronger as a referee, never as a computer of facts. Live output validation is the honesty backstop.

---

## 8. Providers, Location, Lifecycle, Ownership

**Providers adapt into Fourth Meridian; the canonical model never bends to a
provider.** Plaid, Lean, Tarabut, CSV imports, and wallets are *sources* marshaled
into the canonical model at the adapter boundary (Infrastructure). Semantic
decisions (what a category *means*, whether a row is a transfer) are pulled *up*
into the owning module, never left in a parser. A provider-generic abstraction is
not built ahead of a second real provider. A field a provider does not supply is a
**Coverage fact**, not a gap in the model. Originals are never discarded; history
is never rewritten; reporting currency stays free.

**Location is a Records-tier attribute, never a module.** Coarse provider-supplied
locality is *declared by the provider, not derived by the system* — a captured
dimension consumers may group/filter by, never a fallible claim the platform makes.
**No stored location value may feed home/work/commute/travel/routine inference,
behavioral geofencing, or any LLM-derived location claim.** Precise venue
(`address`, `store_number`, `lat`, `lon`) is **never captured**. A Location module
with the inference bans applied owns an empty claim family — the definition of a
module that must not exist.

**Module lifecycle: start broad, split only on proven divergence.** A module is
born owning a broad claim family and is subdivided only when the sub-families
acquire genuinely different owners, privacy boundaries, or change disciplines.
Specializing early manufactures the duplication the platform exists to prevent
(Crypto lives as a *dimension* inside Investment; Subscriptions as recurrence facts
+ a Consumer; Income as Cash's first-class half). Financial Health decomposes only
maturity-driven — consuming sibling cores as they mature, never big-bang.

**One authority per claim. Forever.** Stronger than ownership by feature (features
multiply and each "just needs" the fact — the `FLOW_COST`-in-four-places mechanism),
by module (too coarse — the unit of ownership is the *claim*), or by table (confuses
storage with authority — the authority is the single *definition site*, independent
of where the value lands). Precisely: **every named claim has exactly one definition
site, forever; a second computation site for an existing claim is a review-blocking
defect regardless of where it appears — module, consumer, script, or prompt.** Single
ownership is what makes cross-surface consistency structural rather than aspirational:
chat, brief, and dashboard agree because they all read the one authority.

---

## 9. Anti-patterns

Named so they are recognizable in a pull request:

- **Duplicate computations** — the same fact computed in more than one place.
- **Consumers owning facts** — a dashboard, brief, or serializer computing a figure instead of reading one.
- **Infrastructure owning intelligence** — a semantic decision hiding in a parser or utility with no version, no owner.
- **Too many intelligence modules** — completeness-driven chartering; a registry past ~10 entries signals dilution.
- **LLMs becoming canonical** — any design where a model's output becomes a fact other code reads.
- **Speculative schema** — adding columns or tables because they *might* be useful someday.
- **Provider-driven architecture** — reshaping the canonical model around a provider, or building a generic provider abstraction before a second provider exists.
- **Behavior inference without doctrine** — unfalsifiable psychographic labels no fact backs and no honesty valve can gate.
- **Location tracking** — storing precise location, or inferring home/work/commute/travel from any location value.
- **Premature specialization** — splitting a module before responsibilities diverge.
- **Confidence theater** — a `confidence` field reflexively stamped `HIGH`, or added to Infrastructure that cannot be uncertain.
- **Persistence creep** — persisting cheap, read-time-computable aggregates and inheriting staleness for no benefit.
- **Architectural drift** — the slow accumulation of all of the above, prevented by running every proposal through the Wrongness Test *before* it is built.

---

## 10. North-Star Principles

Every future proposal is measured against these. If it violates one, it is wrong
until proven otherwise.

1. **Financial Intelligence is deterministic knowledge; AI consumes it.** The model narrates and never becomes canonical.
2. **Compute once — one definition site.** Not one per surface, request, or redesign. Not necessarily one execution.
3. **Reuse everywhere.** No consumer re-derives a fact it could read.
4. **One authority per claim. Forever.** Stronger than ownership by feature, module, or table.
5. **Every claim carries provenance and a version.** "Why is this number what it is" and "why did it change" are always answerable.
6. **Honesty is a feature.** Insufficient signal yields UNKNOWN, null, or absence. Hardest on scores and forecasts, not softest.
7. **Determinism first.** Same inputs plus injected clock yield byte-identical output. No LLM computes a fact, anywhere.
8. **The Wrongness Test is the first question.** Wrong about finances with bug-free code? Yes → Intelligence, with the full apparatus. No → Records, Context, Consumer, Delivery, Enforcement, or Infrastructure — and must not be called Intelligence.
9. **Six categories, one substrate.** Every component belongs to exactly one.
10. **Intelligence needs seven properties at birth.** Missing one means it is not a module.
11. **Persistence is a per-fact decision, never a definition of Intelligence.**
12. **Modules earn their existence; the registry stays small and prune-eager.** New claims default into existing modules. Extend before you split.
13. **Infrastructure owns zero financial knowledge; it may be wrong only where a unit test can catch it.** A missing capability is a Coverage fact, never a hedge.
14. **Context is declared, never derived; Consumers present, never compute; Delivery moves, never computes; Enforcement referees, never plays.**
15. **Providers adapt into Fourth Meridian; the canonical model never bends to a provider.** Originals are never discarded; history is never rewritten.
16. **Location is a Records attribute, never a module; nothing is ever inferred from it.** Capture-or-never governs all metadata.
17. **Initiative names and registry membership are separate namespaces.** A track may be called anything; the registry admits only what passes the Wrongness Test.

---

# Implementation — the AI subsystem (as built)

*Re-baselined 2026-11-02 (closes the ai-foundation part of FM-AUDIT-066). This part is
the map; the doctrine above is the law. Every claim is marked:* **IMPLEMENTED** *(with
a code path or PR) ·* **DECIDED BUT NOT IMPLEMENTED** *·* **PROPOSED** *·*
**DEPRECATED**. *If the code disagrees with this section, the code wins and this
section is the defect.*

*Durable content extracted here from the retired working documents: the AI conversation
reset record, the baseline-harness contract, the production-promotion record, the
Memory V2 design (rulings R1–R12), the M1 measures investigation and the post-M1
architecture-program closure. Their full text is in git history (`git log --
docs/plans/<NAME>.md`). Provider pricing, the invocation ledger, allowances and the
emergency pause are documented separately (billing and provider costs).*

## 1. Where AI attaches

- **One provider seam — IMPLEMENTED.** `lib/ai/provider.ts` is the only OpenAI import
  site: `generateChatReply`, `generateWithTools` (one request, one response, raw tool
  calls returned; the tool *loop* is the caller's), `generateStructured` /
  `generateStructuredWithUsage`. The seam picks the parameter dialect by model family
  (`usesModernParams`: `max_completion_tokens` and default temperature for `gpt-5.x`),
  refuses an unpriced model (`assertPricedModel`) and re-checks the paid-requests
  admission (`assertPaidRequestsAdmitted`) on every call.
- **Model call sites — IMPLEMENTED.** Exactly three product surfaces call the seam:
  the conversation runtime (`lib/ai/conversation/turn.ts`, one `generateWithTools(`
  call site, asserted by `scripts/ai-baseline/baseline.test.ts`), the Daily Brief
  (`lib/ai/brief/generate.ts`, one structured call, no tool loop) and operator-invoked
  Communications authoring (`lib/notifications/content/deps.ts`, surface
  `comms_authoring`). Every call runs inside an AI invocation context, so the provider
  writes one attributable `AiInvocation` row per call.
- **Grounded context — IMPLEMENTED.** `lib/ai/context-builder.ts` `buildContext` →
  `SpaceContext_AI` through the self-registering assembler registry
  (`lib/ai/assemblers/`). Assemblers read the canonical authorities and re-decide
  nothing ([Financial Truth Spine §9](../architecture/FINANCIAL_TRUTH_SPINE.md)).
  Since RLS slice S6 an `AssemblerFn` takes a required leading `ReadClient`, so a
  conversation turn cannot be split-authority between its orientation and its tools.
- **Visibility fails closed — IMPLEMENTED.** `lib/ai/visibility.ts`
  `TRANSACTION_DETAIL_VISIBILITY` (`[FULL]`) is the single predicate deciding which
  account detail may reach a model. `BALANCE_ONLY` contributes totals only; absence of
  a grant is exclusion.
- **Tenant authority — IMPLEMENTED.** The chat route binds every read to the
  authenticated user through `aiPhaseRunner(user.id)` (`lib/ai/tenant-phase`): one short
  tenant transaction for the prologue, one per tool call, one for a durable write. No
  tool argument, schema field, header, body or cookie can reach that identity.
- **Deterministic forecast — IMPLEMENTED.** `lib/forecast/**` and
  `lib/ai/forecast/{assemble,streams,pay-dates}.ts` project cash from explicit typed
  inputs (`statements: UserStatement[]`, routed by `routeStatement`). No regular
  expression is declared in `lib/ai/forecast/assemble.ts` (asserted by
  `assemble.test.ts`).

## 2. The conversation runtime

**IMPLEMENTED — promoted 2026-09-13 (`989d63d`), `POST /api/ai/chat`, model `gpt-5.1`.**

- **Two clients, one engine.** The product route and the terminal harness both open a
  transcript with `openTranscript()` and run turns through
  `lib/ai/conversation/engine.ts` / `turn.ts` (`runStatelessTurn`, `executeTurn`). The
  runtime imports nothing from `scripts/`, no route imports the harness, and there is
  exactly one `generateWithTools(` call site (all asserted by
  `scripts/ai-baseline/baseline.test.ts`).
- **The model is a constant.** `CHAT_MODEL = 'gpt-5.1'` in `engine.ts`, with no
  environment override: a model is changed by measuring the new one, not by setting a
  variable. (`lib/ai/provider.ts` keeps a separate `AI_CHAT_MODEL` default for the
  non-conversation callers; `lib/ai/model-rate-coverage.test.ts` requires both to be
  on the rate card.)
- **Turn budgets.** At most 6 tool round trips (`MAX_TOOL_ROUNDTRIPS`) and 16 tool calls
  (`MAX_TOOL_CALLS_PER_TURN`) per turn (`turn.ts`), inside a wall-clock budget
  (`lib/ai/turn-deadline.ts`, `CHAT_TURN_BUDGET_MS`). Compaction keeps raw tool results
  for the last 2 completed turns and elides older ones (`compaction.ts`
  `DEFAULT_COMPACTION`).
- **The tool surface — 21 tools** (`lib/ai/conversation/tools.ts` `TOOLS`):
  `get_financial_snapshot`, `get_spending`, `measure_flows`, `get_baselines`,
  `get_transactions`, `get_income`, `get_investments`, `get_net_worth_history`,
  `find_in_balance_history`, `explain_net_worth_composition`, `project_cash`,
  `get_pay_dates`, `investment_scenario`, `scenario_projection`, `scenario_crossing`,
  `scenario_goal_seek`, `reconcile_projection`, `stage_assumptions`, `recall`,
  `remember`, `describe_fourth_meridian`. The financial tools are adapters over existing
  authorities and compute no financial figure the authorities do not; tool names use the
  user's vocabulary, not internal terms. The only durable writes are `remember` and the
  silent evidence-based projection checkpoint, both in `memory-store.ts`, which touches
  only `db.spaceMemory`.
- **The system instruction is short and figure-free.** `SYSTEM_INSTRUCTION`
  (`turn.ts`) is pinned at roughly 90–490 words with no worked example, no phrase table,
  no financial figure, and no sentence copied from the golden conversations
  (`baseline.test.ts` §2). Each word-count increase was one measured sentence with an
  A/B check under `scripts/ai-baseline/`.

### 2.1 The trust boundary (`app/api/ai/chat/route.ts`) — IMPLEMENTED

- **Order:** `requireUser()` → the `conversations` entitlement → per-minute and per-hour
  pacing (`lib/ai/pacing.ts`, both fail closed) → the paid-requests admission (a paused
  platform returns 503 `AI_PAUSED`) → the daily allowance with a reservation released in
  `finally` → body parsing. No model work happens before all of these pass.
- **What the browser may send:** a `spaceId` and `{role, content}` turns with role
  `user` or `assistant` (`lib/ai/conversation/request.ts`). A `system` or `tool` turn is
  a refused request (400), not a dropped message. The memory line, evidence, scenario,
  model, as-of date and owner are all built server-side.
- **The Space is re-resolved, never accepted.** A named Space that does not come back
  from `resolveSpaceContext` as itself is a 403. Only the selector's "all my Spaces"
  sentinel (resolved to `null` by the parser) may fall back to the user's own Space.
- **What leaves:** `AiChatResponse` (`types/index.ts`) — the answer, its `guidance`
  level, any `knowledgeGaps`, and `continuity` only on the turn a plan is lost. No
  evidence, tool result, usage or provider detail. Failures
  return one of a fixed set of sentences (`refusal-sentences.ts`); the reason is logged
  server-side and never put in a response body.
- **No conversation persistence.** No conversation table, id or restore. A conversation
  that ends is gone, apart from the durable memory the user asked for (§5) and
  the cost-ledger rows.

### 2.2 Conversation state carrier — IMPLEMENTED

*Kept current by the pre-S1 gate repairs (FM-AUDIT-018, FM-AUDIT-019), 2026-09-22.*

A chat conversation carries three things between turns, in ONE sealed, HttpOnly,
path-scoped cookie (`fm_ai_state`, `lib/ai/conversation/runtime-state.ts`): the
**executed scenario** (what ran), the **staged conditions** (stated, not yet run) and — only
when needed — a **continuity-loss** descriptor. Three slots, never merged; none is a
financial truth, and none is durable (2 h TTL, bound to user + Space + the digest of the
last assistant reply, so a new chat or another Space opens to nothing).

- **Cipher:** the repo's purpose-derived AES-256-GCM (`sealWithPurpose`,
  `EncryptionPurpose.AI_RUNTIME_STATE`), as one base64url token (`c1.`
  iv‖tag‖ciphertext, 12-byte IV, 16-byte tag pinned both sides).
- **Capacity:** 3,900 characters (`MAX_SEALED_CHARS`) — a browser discards a cookie over
  4,096 bytes silently — holding ~2,890 bytes of state.
- **Overflow is explicit, never silent.** State that does not fit is replaced by a sealed
  continuity marker naming what was lost (an executed scenario, N staged clauses). The next
  turn receives a `CONTINUITY NOT CARRIED` notice (`continuity.ts`) saying the plan is not in
  force; the plan stays *in play* (project_cash refuses to answer it from the current trend
  unless `ignoreStaged`); the loss is carried until a scenario runs again; the response
  carries `continuity` on the turn it happens and the chat UI shows a notice.
- **Known gap (accepted):** a transcript rebuilt from the browser has the prose but not
  the raw tool results of the last two turns, so the model re-reads through a tool
  (documented at `replayHistory` in `engine.ts`). The carrier is per browser, not per
  tab; the conversation-tail binding stops two tabs reading each other's hypothetical,
  but the last tab to answer owns the cookie.

### 2.3 Cash projection honesty (`project_cash` and `reconcile_projection`) — IMPLEMENTED

*From the AI reliability investigation, fixed in `89a46ad` (`lib/ai/conversation/tools/projection.ts`,
`lib/ai/conversation/reconcile.ts`).* Every figure the model quoted was a real tool
output. The defects were in the engine and the tools: a payroll stream's amount was
refused after one unusual newest paycheck
([Forecast: periodic-amount](./forecast.md#periodic-amountts-the-newest-payment-is-judged-like-every-other-one)),
the projection silently counted that stream at zero under a "complete" label, and the
reconciliation tool returned a large variance with nothing that explained it. With no
quantified cause in any tool output, the model invented causes and then asked the user
for income the platform already held. Payroll classification, transfers, card
payments, duplicates, the detection window and page truncation were checked and were
not causes.

- **`project_cash` states what its income term holds.** `kind` is
  `INCOMPLETE_ESTIMATE` (not `EVIDENCE_BASED_ESTIMATE`) when a current stream was
  materially omitted, with the bound beside it (`income-completeness.ts`).
  `basis.recurringIncome` reports per stream what was counted. `latestPaymentDeviates`
  gives the figure if the newest deviating payment is the new level.
  `incomeEventsCounted` / `incomeEventsExcluded` are the fold's real counts (the old
  field counted *generated* events, so it reported events beside near-zero income).
  `qualification` is built from what actually contributed and never claims payroll was
  inferred when it added nothing. `rangeMeaning` says the range varies spending only,
  because the model had read it as income uncertainty.
- **`reconcile_projection` attributes the variance exactly.**
  `attributeInFlightVariance` (pure) returns lines with causes `OPENING_CASH`,
  `INCOME_TIMING` (payments that arrived and are now in opening cash),
  `PROJECTED_INCOME` / `DATED_OUTFLOWS` or one `INCOME_NET_OF_OUTFLOWS` line,
  `SPENDING_RATE` and `HORIZON_DAYS`. The lines sum to the variance with a zero
  residual (`UNATTRIBUTED` appears only when they do not). The daily spending rate is
  labelled as an outflow, because the model had read it as positive drift. A
  checkpoint stated under an older spending-window definition is attributable too,
  and the definition change is visible as a rate line rather than unexplained.
  Legacy checkpoints attribute income as one net line, never split by a guess.
  Pinned by `reconcile-attribution.test.ts`.
- **An incomplete figure is never checkpointed** (`memory-tools.ts`: an
  `INCOMPLETE_ESTIMATE` returns no checkpoint), and new checkpoint bases record
  `incomeProjected` / `outflowsProjected` so later attribution is exact.
- **Tool descriptions, not the instruction, carry the rule.** Each tool gained one
  sentence: a variance may be explained only by the returned attribution lines, and an
  `INCOMPLETE_ESTIMATE` is presented only beside its omission. **Not guaranteed:**
  disclosure of the latest deviation and the lower bound depends on the model reading
  fields that are always present.

**Latency, measured at the same time (no optimisation implemented).** Model time is
over 90% of a turn: tool selection, answer and the guidance label are three sequential
calls, and answer time scales with completion tokens. Tool execution and the prologue
are sub-second. The large cold-start figure seen in development is `next dev` route
compilation; a production build serves the same route in milliseconds. **PROPOSED**,
highest yield first: stream the answer (time to first token), take the guidance
labeller off the critical path, confirm prompt-cache hits on the stable prefix
(`cachedPromptTokens` on `AiInvocation`), warm routes after `next dev` starts.

## 3. Enforcement — what referees model output today

The pre-reset prose validator is gone (§9). Enforcement now sits where a figure is
*produced or admitted*, not in a sweep over prose:

- **Daily Brief figure licence — IMPLEMENTED.** `lib/ai/brief/licence.ts`: every amount-like
  token in Brief prose must be a faithful rounding of a number in the deterministic
  package, compared at the precision it was written at and never looser than 3%.
  `lib/ai/brief/generate.ts` refuses a Brief whose headline states an unlicensed figure
  (`UNLICENSED_HEADLINE`) and drops an observation that does (`UNLICENSED_FIGURE`), cites
  nothing real (`NO_EVIDENCE`), mislabels a movement (`MISLABELED_MOVEMENT`) or ties a
  balance to an unconnected movement (`UNCONNECTED_MOVEMENT`). It drops rather than
  regenerates: a loop that asks again until the numbers look right eventually accepts a
  wrong one.
- **Memory provenance gate — IMPLEMENTED.** `memory-model.ts` `admitWrite` (§5).
- **Scenario argument contract — IMPLEMENTED.** An argument a scenario tool's schema does
  not declare is refused by name (`lib/ai/conversation/tools/scenario/setup.ts`); which
  clauses ran is reported from the ledger's own movements (`clausesInForce`,
  `scenario-rules.ts`), never from the caller's arguments; a rule is named from its fields
  (`contributionName`), never from a caller's label.

## 4. Unprompted speech requires a licence

> **The Daily Brief speaks unprompted under a deterministic licence; nothing else may
> speak unprompted until it has its own licence of the same kind.**

- **The rule — DECIDED** (carried from the roadmap's Workstream 3 gate: *the system may
  not speak unprompted until it cannot misquote a number*).
- **The Daily Brief — IMPLEMENTED** under that licence (`lib/ai/brief/licence.ts`,
  `generate.ts`, §3). It met the gate through the licence, not through the deleted
  output validator.
- **No other unprompted AI surface exists — IMPLEMENTED (by absence).** The only other
  model callers are the chat runtime (speaks only when the user asks) and Communications
  authoring (an operator asks for a polish or check; nothing is sent to a customer
  by the model). Any proactive AI surface (ambient insights, AI-written notifications) is
  **PROPOSED** at most and must arrive with its own licence before it ships.

## 5. Durable financial memory (Memory V2)

**IMPLEMENTED 2026-09-21 (post-M1 program, slices S1–S6, no migration).** Model:
`lib/ai/conversation/memory-model.ts` (pure); store and tools: `memory-store.ts`,
`memory-tools.ts`; user surface: `app/api/ai/memory/**` and
`components/dashboard/MemoryPanel.tsx`; table `SpaceMemory`.

Three sentences the design keeps true: **memory is not financial truth; memory is not an
active scenario; a scenario is not memory.**

### 5.1 Invariants

1. **A figure enters memory only as the user stated it — exactly.** Every new Money,
   Months, Fraction and Percent value must appear in the user's own turns, read as that
   kind of quantity, matched to half a cent (`SAID_EXACTLY = 0.005`). Our own figures
   (orientation, envelope, tool results, our prose) license nothing, even when the user
   loosely echoes them ("so about 180k?" does not admit a projected 181,204.37). A digit
   group inside a larger number or a date licenses nothing. Money means a currency mark,
   a k/m suffix, thousands grouping, decimals, a spelled currency word, or a bare
   integer ≥ 1,000 that is not a year; a bare small integer is a count. Months also accept
   a closed word list ("six months"). One exception: a `Fraction` of exactly `1` needs no
   figure ("…then invest the rest").
2. **Memory is never financial truth.** No measure, baseline resolver, forecast or
   liquidity reader reads a remembered figure. It reaches arithmetic only when the model
   passes it as an explicit tool argument, and the answer says it was remembered.
3. **Memory never acts by itself.** It activates no scenario and re-seeds no envelope;
   the user surface cannot "use it now".
4. **A projection is remembered only when it rests on evidence.** A projection that rests
   on a user-stated figure is a hypothetical and is never recorded
   (`memory-store.ts` checkpoint path).

### 5.2 The model

Four stateable classes plus one we write (`STATED_CLASSES`, `KIND_OF_CLASS`):

| Class | Stored kind | Fields (closed set) |
|---|---|---|
| `GOAL` | `INTENTION` | `targetMetric` (`netWorth`·`liquid`·`investments`·`debt`), `targetAmount`, optional `byDate` |
| `PLANNED_EXPENSE` | `INTENTION` | `label` (1–40 chars), `amount`, optional `earliest` |
| `RULE` | `INTENTION` | nested `rule`: `liquidFloorMonthsOfExpenses` **or** `liquidFloor` (+ `fractionOfExcess`, `target`), **or** `surplusFraction` (+ `target`); optional `from` / `to` |
| `BASELINE` | `ASSUMPTION` | exactly one of `monthlySpending` / `annualReturnPct`; code stamps `basis: "REMEMBERED", scope: "PLANNING"` |
| `PROJECTION` | `CHECKPOINT` | a projection we made, with its evidence basis |

Shape (synthetic values):

```json
{ "kind": "INTENTION",  "payload": { "v": 2, "class": "RULE", "rule": { "liquidFloorMonthsOfExpenses": 6, "fractionOfExcess": 1, "target": ["highest_apr", "investments"] } } }
{ "kind": "ASSUMPTION", "payload": { "v": 2, "class": "BASELINE", "monthlySpending": 4000, "basis": "REMEMBERED", "scope": "PLANNING" } }
```

States (`stateOf`): `IN_FORCE`, `STALE` (a planning figure older than 180 days,
`BASELINE_STALE_AFTER_DAYS`), `NOT_YET`, `LAPSED` (a goal whose date passed — still
readable), `SETTLED`, `SUPERSEDED`, `RETIRED`. Supersession keeps history: an amend
writes a new version and marks the old one `SUPERSEDED`.

### 5.3 The twelve rulings (R1–R12) as implemented

| # | Ruling | Status |
|---|---|---|
| R1 | The user's words are passed in (`userTexts`), never read off the transcript: the orientation is itself a `user`-role message and carries every balance we hold. `turnEvidence(userTexts, messages)` is pure. | IMPLEMENTED |
| R2 | A Money field with a relational sibling (`liquidFloor` ↔ `liquidFloorMonthsOfExpenses`) needs positive user evidence; otherwise the refusal names the months field. Not rememberable in a rule: `amount`+`cadence`, `fractionOfLiquid`+`cadence`, `{liability: id}` targets (ids churn on reconnect), `onDate`, `label`. | IMPLEMENTED |
| R3 | A remembered planning figure is `REMEMBERED`, never `STATED`. It is not a rung of `resolveExpenseBaseline`; no tool reads it. | IMPLEMENTED |
| R4 | One vocabulary authority: the model imports `CONTRIBUTION_KEYS`, `ALLOCATION_TARGET_WORDS`, `unknownContributionKeys`, `contributionBasis`, `contributionName` from `scenario-rules.ts`. A stored rule holds exactly contract keys. `scenario-ledger.ts` stays import-free; its `AllocationTarget` type is tied to the constant by the compiler, plus a parity test. | IMPLEMENTED |
| R5 | Validators split: `validateShape` / `validateFields` are timeless; `admitWrite` judges only this call's supplied fields, exempts values equal to the current version's, and checks future dates (`byDate`, `to`). | IMPLEMENTED |
| R6 | Priming is measured and gates the reader: `composeMemoryLine(rows, today, {rules})`; production ships `MEMORY_LINE_RULES = 'clause'` after a measured 0 silent applications. | IMPLEMENTED |
| R7 | Cuts: no `PREFERENCE` class; digits-only money (no word numbers); no `unreadable: n` in the memory line (kept in `recall` and the panel). | IMPLEMENTED |
| R8 | Legacy V1 rows are read deterministically: goal and projection shapes are readable; a planned outlay is readable only when `intent ∈ {buy, purchase, spend}`, `amount > 0`, `label` 1–40 chars; everything else (including a standalone V1 assumption) is unreadable. Nothing is rewritten by deploy. | IMPLEMENTED (`readMemory`) |
| R9 | Readers land before writers (S1 model → S2 checkpoints → S3 readers → S4 writers → S5 API → S6 panel). | IMPLEMENTED (sequencing rule; also binding for future memory changes) |
| R10 | The memory line's bytes are measured and pinned by test (typical ≈1.2 KB, capped worst case ≈3 KB); caps `LINE_CAPS`: 3 goals, 3 rules, 2 planning figures, 3 planned, 6 horizons. | IMPLEMENTED (`memory-model.test.ts`) |
| R11 | The replay corpus is a sanitised, committed fixture (`lib/ai/conversation/fixtures/remember-replay.json`); no test reads `tmp/`. | IMPLEMENTED |
| R12 | Acceptance runs on a database clone, production path, full tool surface. | IMPLEMENTED (procedure; see §8) |

### 5.4 The memory line, recall, and the user's control

- **The memory line — IMPLEMENTED.** Sent on every request (`composeMemoryLine`). It
  lists only the user's own `ACTIVE`, readable, `IN_FORCE`/`STALE` items and says
  "Nothing listed is in effect and none of it is a current figure". When a planning
  figure is listed it adds one `planningNote`: answer on measured evidence unless asked,
  and if the figure is used say it was remembered on its date and give the measured
  figure beside it.
- **Write behaviour — IMPLEMENTED.** An identical restatement writes nothing
  (`unchanged: true`), except that restating a `STALE` or `LAPSED` item writes a new
  version and moves its date. Every `RULE` write echoes `otherRulesInForce`.
- **Who may write — IMPLEMENTED** (`memory-write-policy.ts`, FM-AUDIT-019). Writes are
  off unless the turn context says `memoryWrites: true`. Only two callers set it: the
  product chat route, and a harness explicitly opted in with
  `FM_AI_MEMORY_WRITES=clone-only` against a clone database (`fintracker_<suffix>`). Any
  other value, or a live/unidentifiable database, refuses before anything runs.
- **User agency — IMPLEMENTED.** `GET /api/ai/memory` lists, `PATCH /api/ai/memory/[id]`
  retires, `DELETE` erases. Scope is always `{spaceId, ownerUserId: user.id}`; no route
  takes a user id, no owner/admin bypass, another member's id is a 404. Erasure writes
  one content-free `AuditLog` row (`AI_MEMORY_ERASED`, `{kind, versionsErased}`). The
  surface cannot create, edit or apply memory. The panel lives under
  `components/dashboard/` because `components/ai/` is presentation-only by guard.

### 5.5 Known and deliberately not built

1. **Concurrent first-record race — DECIDED BUT NOT IMPLEMENTED.** Two turns recording
   the same new subject at the same instant can leave two `ACTIVE` rows. The fix is a
   partial unique index on `(spaceId, ownerUserId, kind, subject) WHERE status =
   'ACTIVE'`, which needs a migration; `SpaceMemory` today has only
   `@@index([spaceId, ownerUserId, kind, status])`.
2. **An amend inherits a legacy goal's ungated amount** (by `admitWrite`'s
   equal-to-current exemption). Accepted; the user can see and delete it in the panel.
3. **"Remember my raise in March" is refused** — a future income change is not in the
   `RULE` vocabulary.
4. **Derived dates are not gated**, and word-form money is asked for once in digits.

## 6. Measures and baselines (M1)

**IMPLEMENTED 2026-09-20 (`d056898`).** Pure modules `lib/ai/measures/{period,measure,baseline}.ts`;
tools `measure_flows` and `get_baselines` in `lib/ai/conversation/tools/measures.ts`.

Three kinds of figure, never collapsed:

- **MEASURE** — what happened over a requested period. Code owns it entirely.
- **BASELINE** — the representative monthly rate for forward reasoning, always with its
  basis and window. Code resolves it given a basis; the model chooses the window and must
  say which.
- **DERIVED** — arithmetic over baselines and state (surplus, savings rate, runway,
  thresholds). Code owns it; every result ships with numerator, denominator and basis, and
  a zero or unknown denominator is an explicit refusal (never Infinity or NaN).

### 6.1 `measure_flows({ measure, period, compareTo?, category?, asOf? })`

- `measure ∈ FLOW_MEASURES`: `spending`, `income`, `economicNet`, `cardAndDebtPayments`,
  `transfersBetweenOwnAccounts`, `refunds`. All read the one economic fold through the
  transactions assembler's monthly rows; there is no second inclusion rule.
- **A monthly figure is a mean over whole calendar months, never total ÷ days.**
  `perCompleteMonth` is null on a window with no whole month; a partial month counts in
  `total` but is never averaged.
- `period`: relative presets (`MTD`, `QTD`, `YTD`, `PAST_MONTH`, `PAST_QUARTER`,
  `PAST_6_MONTHS`, `PAST_YEAR`), explicit `month` / `quarter` / `year`,
  `completeMonths: N`, or `from`/`to` (`period.ts`).
- `compareTo`: `PREVIOUS` (for a to-date period, the same elapsed days of the prior unit),
  `SAME_PERIOD_LAST_YEAR`, or an explicit period. **Both sides are computed in one call**
  with the difference, percentage and direction, so the model never holds one side and
  computes the other. A window compared with itself is refused.
- `category` filters `spending` only; spending reports what was charged and, when refunds
  arrived, `netOfRefunds` / `changeNetOfRefunds`.
- **Completeness is population-aware** (`completenessFor`): a stale source lowers a
  measure's tier only when its accounts feed this measure's population. Tiers use the
  platform `CompletenessTier` vocabulary.
- `asOf` is an information ceiling clamped to today.

### 6.2 `get_baselines({ statedMonthlySpending?, statedMonthlyIncome?, spendingWindow?, monthsOfExpenses?, liquidChange?, asOf? })`

- **Expense precedence is the canonical one:** STATED (this conversation) > DECLARED (the
  product setting) > MEASURED, through `resolveExpenseBaseline`
  (`lib/liquidity/expense-baseline.ts`, which gained the STATED rung in M1). There is no
  second chain. The measured rung is net economic spending (charges less same-month
  refunds); the default window is the cash projection's canonical baseline
  (`lib/transactions/canonical-spending`), and a named `spendingWindow` is a measurement
  that never replaces it.
- **Income precedence:** STATED > CADENCE (settled paycheck streams) > MEASURED.
- **Derived:** `monthlySurplus = incomeBaseline − expenseBaseline`; one savings-rate
  definition, `(income − expense) / income`, which requires a recurring income basis
  (STATED or CADENCE) and refuses otherwise; `runwayMonths = liquid / expenseBaseline`
  (liquid = the canonical `totalLiquid`); `thresholds` always price 3, 6 and 12 months of
  expenses plus any `monthsOfExpenses` asked, each with the rule, the baseline multiplied
  and the gap to current cash; `liquidChange` prices a one-off movement
  (`afterLiquidChange`).
- **It never says what the user should spend or keep.** Thresholds are reference points;
  the choice of reserve is the user's.
- **Scenario composition:** `liquidFloorMonthsOfExpenses` on a contribution rule is
  resolved to a literal floor from the scenario's own spending level
  (`resolveMonthsOfExpensesFloor`), and the floor's derivation is echoed. The ledger
  stays pure.

## 7. Other primitives from the post-M1 program

**IMPLEMENTED 2026-09-21 (`b9e9fd6`).** The program's test for every change: *did we add a
reusable financial primitive, or did we patch a question?* Phrase handlers, provider
exceptions, an annual-spending tool and schema de-duplication were refused on that test.

- **A payment is not a cost** — `lib/transactions/debt-service.ts`: `netPaydown =
  max(0, payments − newChargesOnLiabilities − debtProceeds)`; an unmeasured paydown is
  `null`, never defaulted to the payments total. Monthly money figures are complete-month
  means (`meanPerReliableMonth`).
- **A verdict carries its reason** — `ClassificationReason<T>`
  (`lib/ai/intelligence/annotations/classification-reason.ts`): scope, the rung that
  fired, operands, thresholds, population. Freshness belongs to the claim it feeds
  (`lib/ai/brief/claim-evidence.ts`), not to the Space. `pctOfOpening` decides when a
  percentage of an opening value means anything. A 429 is absorbed by a bounded retry
  (`lib/ai/rate-limit-retry.ts`).
- **The difference is a field** — `positionChange` in scenario payloads; `project_cash`
  takes a `from` and states what comes in, goes out and remains.

## 8. Conversation harness

The harness is how every conversation change is measured before it ships. It drives the
**same engine** the product uses (`openTranscript` / `executeTurn`); it owns only the
experiment around a turn — probe, evidence arm, model, artifact.

### 8.1 What is where

| Path | Role |
|---|---|
| `scripts/ai-conversation-baseline.ts` | CLI: batch probe runs (`npm run ai:baseline`) and interactive operator mode (`npm run ai:chat`). Model tiers (`TIERS`): `control` gpt-4o-mini, `mid` gpt-4.1 (the interactive default), `ceiling` gpt-5.5, `candidate` gpt-5.1, `frontier` gpt-6-astra (no tools through chat completions, A0/A1 only). |
| `scripts/ai-baseline/probes.ts` | The probe conversations (`broad`, `projection`, `cadence`, `debt`, `investments`, `affordability`, `networth`, `spending`, `strategy`, `format`, `session`). Each is multi-turn and replayed against a growing transcript. The goldens' answers are never sent to the model; `whatItDiscriminates` reaches the artifact only. |
| `scripts/ai-baseline/run.ts` | Runs one probe × arm × model and writes the artifact. |
| `scripts/ai-baseline/interactive.ts` | The A2 arm with a keyboard: `/tools`, `/cost`, `/exit`; the transcript is written after every turn and on Ctrl-C. A model that cannot call tools is refused, not downgraded. |
| `scripts/ai-baseline/artifacts.ts` | Artifact shape (`INDEX.md`, `index.json`, one JSON per case with blank human-review fields). |
| `scripts/ai-baseline/baseline.test.ts` | **Pure, runs in CI.** Pins the structural contract: one turn loop, no harness import from product code, the instruction's size and content rules, the arm contract, the write census. |
| `scripts/ai-baseline/*.check.ts` | **Live checks**, one per capability (`ai:measures-check`, `ai:memory-check`, `ai:chat-route-check`, `ai:brief-check`, …; full list in `package.json`). Real database and real model calls; **not run by CI**. Run the relevant one when that path changes. Each derives its as-of, horizon and expected figures from the run, never from pinned dates. |
| `docs/plans/AI-CONVERSATION-GOLDENS.md` | A stub: the 21 golden conversations the probes are drawn from were written against a personal Space and are kept in private records. Their product requirements are in §8.5. `baseline.test.ts` asserts no sentence of the system instruction appears in the in-tree probe conversations. |

### 8.2 Evidence arms (`lib/ai/conversation/evidence.ts`)

| Arm | Given | Tools | The question it answers |
|---|---|---|---|
| A0 | full assembled context, assessment withheld | no | Can a model infer relevance from clean evidence alone? |
| A1 | full context + `computeAssessment` | no | Does the deterministic verdict layer help or fight the conversation? |
| A2 | thin orientation + coverage envelope | yes | Is a compact orientation plus retrieval enough? (**the shipped runtime**) |
| A3 | the date only | yes | Can tool selection replace deterministic routing? |

A0/A1 deliberately skip `resolveDomains` so the broad-context arms are not a test of the
router.

### 8.3 Running it

```bash
npm run ai:baseline -- --list                 # probes, arms, models
npm run ai:baseline -- --smoke --dry-run      # resolve the matrix, call nothing
npm run ai:baseline -- --smoke                # projection+debt+investments × all arms × mid (12 cases)
npm run ai:baseline -- --probe projection --arm A2 --model mid
npm run ai:baseline -- --probe debt --arm A0,A1 --model control,mid,ceiling
npm run ai:baseline -- --space <spaceId> --probe broad --arm A2 --model mid
npm run ai:baseline -- --all                  # every probe × arm × tier; must be asked for
npm run ai:baseline -- --probe session --arm A2 --model ceiling --no-compaction
npm run ai:chat                               # interactive, default tier mid
npm run ai:chat -- --model ceiling            # skip the picker
```

Rules (IMPLEMENTED in the CLI):

- **Nothing runs without an explicit selection.** `--all` is many whole conversations
  against a paid API and is never implied.
- **Durable memory is read-only by default** (`FM_AI_MEMORY_WRITES`, §5.4). Turns still
  write `AiInvocation` usage rows, as the product does.
- **The Space is printed before anything runs.** Default: the `PERSONAL` Space with the
  most transactions; `--space` overrides.
- **Artifacts go to `tmp/ai-baseline/<run-id>/`, which is gitignored**: they contain real
  balances, merchant names and transcripts. Never commit them, and never copy their
  figures into tests or docs (tests use synthetic values of the same shape).
- **Checks that write rows run only against a clone.** `memory-store`, `applied-facts`
  and `daily-brief-lifecycle` checks call `assertCloneForDurableWrites()`. Setting
  `FM_DB_GUARD=clone-only` makes `lib/db.ts` refuse any database that is not a clone
  (`lib/db/live-guard.ts`); the income, planning, advice and hardening checks document
  running under it. An exported `DATABASE_URL` beats
  `--env-file`, so a worktree's env file alone is not isolation; the guard in the script
  is.

### 8.4 Method

- **The transcripts are the result.** Metrics are mechanical only (success, latency,
  tokens, tool calls, errors); a person scores accuracy, relevance, conversation,
  conciseness, judgment and follow-up 1–5 in the artifact's blank fields. No LLM judge,
  no claim extraction, no rubric scorer.
- **Counts, not rates.** Acceptance runs report n per case (typically n = 6) on the
  production path with the full tool surface. Withholding a tool is not isolation: the
  turn loop has two durable write paths.
- **A prompt change is one measured sentence** with an A/B check committed beside it.
  Prompt-only rules often move nothing; fix the tool contract first.

### 8.5 Findings from the pre-runtime investigation and the goldens

*From the conversation investigation that followed the reset (§9; run read-only against
the surviving code) and the 21 golden conversations written before it. These are
the findings that chose the shipped design. Re-measure before treating any gap below
as still open.*

- **The working line:** the model owns meaning and language; code owns financial truth
  and every calculation that must not vary between two identical questions. That covers
  net worth, sums, currency conversion, category and merchant totals, monthly rollups,
  cash projection, pay dates, cadence, baselines, interest and net-worth attribution.
  **Visibility is a security boundary, never a model judgment.** Tools enforce it
  internally, and no tool may take a "show hidden" flag.
- **Facts, not verdicts.** `computeAssessment` is materiality-blind and
  sample-size-blind. A trivially small debt with a null APR produced several warnings
  and blocked recommendations, and two complete months produced a "worsening"
  trajectory. Handed to a model, a pre-committed verdict argues with the model's
  judgment instead of informing it. The assessment stays for the Daily Brief and is
  measured in the conversation as a hypothesis (arms A0 vs A1, §8.2).
- **Why tool-calling over a router.** The full assembled context for a broad question
  was cheap in tokens and latency, so token budget was never the argument for
  retrieval; answer quality was. Deterministic domain retrieval (option C) was
  rejected because it *is* `resolveDomains`, and measured, `resolveDomains` excluded
  investments from plainly broad questions. The
  surviving retrieval surfaces were already tool-shaped (explicit parameters, fast,
  bounded, visibility-enforcing), so the shipped runtime is a thin orientation plus
  tools (A2).
- **Conversation state: the null hypothesis first.** Keep prior tool calls and their
  JSON results in the transcript (answer memory for free) before building anything.
  Escalate only to typed `UserStatement[]`, never to a scenario state machine (that is
  what the reset deleted). "What's realistic" is the discriminating turn: it needs the
  user's suppositions kept apart from the evidence.
- **A correct number read at the wrong scope is a defect.** The holdings concentration
  statistic was arithmetically right about a tiny priced subset and silent about it.
  The fix attaches the population to the statistic
  ([Investments: Invariants](./investments.md#invariants)). Never add a prose guard
  for it.
- **Memory is testimony, never a balance.** Financial data is the authority for what
  happened; memory is the authority for what the user said and intends. A remembered
  figure loses to the ledger, always (§5.1). Corrections are typed statements, and
  durability ("keep excluding those, or just this conversation?") is an explicit
  product moment, never an inference.
- **Surface truncation; do not silence it.** Every forecast stream read is a capped page
  (`truncated: true`).
- **Do not over-fit one Space.** Run probes against a thin Space too.

**What the goldens require** (the product contract the probes are drawn from; a golden
is never weakened to match the code): (1) materiality, so trivial debt raises no
warnings; (2) payroll cadence in evidence, with per-month paycheck counts and dates,
so a three-paycheck month is never an income drop; (3) investments as one concept,
crypto and brokerage together with unvalued positions disclosed; (4) card payments
framed as transfers, not debt burden; (5) net-worth history beyond the 90-row context
cap (`SNAPSHOT_HISTORY_LIMIT`); (6) answer memory, so "break it down" explains *that*
figure; (7) an assumption stack (add, carry, retract one, "realistic" drops the
user's); (8) scenario arithmetic on investments; (9) sample-size honesty, since a
two-month trend is not a trajectory; (10) the correction-durability question asked;
(11) write-back of a category correction (a data-layer action, where conversation
stops being read-only); (12) a projection that answers.

## 9. History: the 2026-09-07 conversation reset — DEPRECATED machinery

The first conversation layer failed its own dogfood and was **deleted rather than
patched** (`95512bb`). Between the user's sentence and the answer it had grown a lexical
intent classifier, scope resolver, retrieval planner, figure-licence table, typed answer
schema, answer verifier and repair loop, deterministic figure-dump fallback,
contradiction and numerical guards, a prose numerical sweep and six environment flags.
In one session a follow-up re-planned from scratch, the safety fallback printed several
mutually inconsistent figures for one question, and a plain formatting request returned
a 502.

**DEPRECATED and removed — do not reintroduce:** `lib/reasoning/**`, `lib/ai/chat/**`,
`lib/ai/intent/**`, `lib/ai/prompts/**`, `lib/ai/conformance/**`,
`lib/ai/retrieval-plan.ts`, `lib/ai/output-validator.ts`, `lib/ai/assessment-guard.ts`,
`lib/ai/claim-detection.ts`, the forecast numerical guard, horizon parser and statement
extractors; the flags `AI_ANSWER_MODE`, `AI_REASONING_PATH`, `AI_PROMPT_SHAPE`,
`AI_ASSESSMENT_GUARD_MODE`, `AI_OUTPUT_VALIDATION_MODE`, `AI_FORECAST_GUARD_MODE`; the
audit actions `AI_CONTEXT_SELECTION_PLANNED`, `AI_OUTPUT_VALIDATION_FLAGGED` (historical
rows still render). The fourteen removed operator harnesses are tombstoned in
`scripts/audit-registry.ts` so none can silently reappear.

**Kept, because it is deterministic knowledge rather than conversation machinery:**
`visibility.ts`, `types.ts`, `assemblers/**`, `buildContext`, `signals/**`,
`intelligence/**`, `coverage-envelope.ts`, `domain-relevance.ts`,
`economic-concepts.ts` (`composeInvestments`, a double-count prevention rule),
`bounded-selection.ts`, `temporal-scope.ts`, the forecast engine, and the provider seam.

**Constraints the reset carries into any design (binding):**

1. **Possession of a number is not permission to use it.** A current and a future figure
   that happen to be equal are different claims; conversation history never mints an
   authority.
2. **A refusal is an answer to a question — make sure it is the question asked.**
3. **A safety mechanism that changes what the user reads is part of the product**, and is
   judged on the sentence the user ends up reading.
4. **When the answer to a measured failure is a fourth guard, the architecture is the
   failure.**
5. **Design from exemplar conversations, measured in the harness**, not from the list of
   removed components. The north star: a person can talk to it like a capable assistant
   with access to their financial world, without learning Fourth Meridian's internals;
   provenance and safety support the conversation and do not become it.

## 10. Open items recorded at closure

Recorded open at the post-M1 closure (2026-09-21) and the promotion (2026-09-13). Later
programs (I1 income changes, planning continuity, S1 category spending) targeted several;
re-measure before relying on any of these as current:

- A changed assumption or horizon sometimes answered without recomputing (no-tool answers
  disclosed it). A system-instruction decision, not a tool gap.
- A change starting on a future date ("cut spending 20% starting January") had no
  representation at closure.
- A measured figure sometimes passed back as a stated assumption, relabelling OBSERVED as
  STATED.
- Quiet-day Daily Brief goldens: standing classifications appear every day. Needs a
  product decision on whether a standing warning may go unsaid on day two.
- Browser dogfood of the chat page (composer, abort, Space selector, refusal rendering) was
  not claimed at promotion.
