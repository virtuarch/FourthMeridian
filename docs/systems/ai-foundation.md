# AI Foundation — Financial Intelligence

*Governs how the platform thinks: deterministic modules compute financial knowledge, the LLM narrates it, and a validator enforces honesty. The north-star reference every future architectural proposal is measured against. These are binding rules, not a status report. See also [Financial Truth Spine](../architecture/FINANCIAL_TRUTH_SPINE.md), [money & FX](./money-and-fx.md).*

> **New here? The one inversion.** **Financial Intelligence is NOT AI.** Financial
> Intelligence is *deterministic knowledge* — computed by pure, versioned code from
> stored records. **The LLM is a *consumer*** of those computed facts: it phrases,
> explains, and arranges; it never invents a number, classifies a flow, or becomes a
> fact other code reads. Fourth Meridian would rather tell a user *less but true* than
> *more but drifting*. Where does an AI feature attach? Through **one** provider seam
> (`lib/ai/provider.ts`, the only OpenAI import site), reading grounded context built
> by `buildContext`, gated by the **one** visibility predicate (`[FULL]`), narrating
> facts the [Financial Truth Spine](../architecture/FINANCIAL_TRUTH_SPINE.md) already
> computed — and checked by an output validator that referees the model's numbers.
> The implementation section at the end of this doc is the map; the doctrine below is
> the law.

This is the foundational architectural doctrine for Financial Intelligence inside
Fourth Meridian. It defines how the platform thinks, how future systems must be
designed, how new ideas are classified, and how architectural drift is prevented.
It is doctrine, not description — it states what must be true, not what happens to
be true today. (Implementation detail lives in the separate AI System document;
this file stays doctrine-level.)

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

*This section folds the former `systems/ai.md` so the AI doctrine and its
implementation live in one place. It describes the shipped Space-scoped chat.*

**Governing premise:** deterministic-first. The system computes provenance-carrying
facts deterministically; the LLM only *narrates* them. The model is structurally
prevented from calculating figures, inventing data, or seeing account data the
requesting Space is not permitted to see.

- **One provider seam** — `lib/ai/provider.ts` `generateChatReply(systemPrompt, messages)`
  is the *only* file permitted to import the OpenAI SDK (model set via `CHAT_MODEL`,
  today `gpt-4o-mini`). Every AI feature calls through it, so the vendor is one seam,
  not a hundred call sites — the codebase can move providers without touching a route.
- **Context builder** — `lib/ai/context-builder.ts` `buildContext` turns a Space into
  a grounded `SpaceContext_AI` via the self-registering assembler registry
  (`lib/ai/assemblers/`). Assemblers *read the canonical financial authorities and
  re-decide nothing* (see [Financial Truth Spine §9](../architecture/FINANCIAL_TRUTH_SPINE.md)):
  transactions gate on `BANKING_POPULATION` and partition via `flow-predicates`;
  accounts delegate to `classifyAccounts` and `reportingBalance`; holdings read
  `getCurrentPositions`, never the legacy `Holding` table.
- **Visibility fails closed** — `lib/ai/visibility.ts` `TRANSACTION_DETAIL_VISIBILITY`
  (`[FULL]`) is the single predicate deciding which account data may enter a prompt.
  `BALANCE_ONLY` contributes only totals; `SUMMARY_ONLY`/`PRIVATE`/legacy `SHARED` are
  excluded; absence of a grant is exclusion. `VIEWER` role is excluded from chat as
  defense in depth. The data layer and the assemblers share the one predicate so a
  drifted copy can never leak.
- **Output validator** — `lib/ai/output-validator.ts` enforces "the model narrates, it
  never calculates" by **membership with tolerance**: each flag-eligible numeric claim
  in the reply must reconcile (within `max($0.01, 0.5%)` + coarse-rounding tolerance)
  to a number already in the prompt or a prior user turn. It is membership, not
  recomputation — a pure, fast, side-effect-free string function (Enforcement, "referee
  not player"). Modes (`AI_OUTPUT_VALIDATION_MODE`): `shadow | annotate | block`
  (default `annotate`); enforcement is append-only and never edits the model's text;
  validation failures are swallowed so they can never break the chat.
- **Stateless by design** — there is **no** `Conversation`/`ChatMessage`/`conversationId`
  model. Each turn is stateless; the client owns history. Only `AuditLog` and
  `ApiUsageCounter` are persisted. Conversation persistence and durable memory are
  deliberately *not built yet*: statelessness keeps the trust surface small while the
  deterministic-and-narrate core is proven, and the prompt forbids the model implying
  a persistence capability it lacks. (This is the major unbuilt AI layer — see
  `/STATUS.md`.)
- **Orchestration** — `app/api/ai/chat/route.ts` sequences permission → context →
  prompt → model call → validation → response, emitting an `AI_CONTEXT_ASSEMBLED`
  audit event.

**Where AI attaches, in one line:** one provider import site (`lib/ai/provider.ts`),
one visibility gate (`lib/ai/visibility.ts` `[FULL]`), one context entry
(`buildContext → SpaceContext_AI`), narrating facts the Financial Truth Spine owns —
never authoring them.
