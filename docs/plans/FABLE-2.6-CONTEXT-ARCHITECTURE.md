# FABLE-2.6 — Ambient Intelligence & Context Architecture

*Product-architecture proposal for Fourth Meridian v2.6. Grounded in a fresh audit of every AI entry point in the repository (snapshot: `feature/v2.5-spaces-completion` + V26-PRE hardening slices). File references are to real code. The centerpiece — the versioned Financial Context — is the architecture Chris proposed mid-review; this document makes it concrete, proves from the code why it is the right move, and sequences it.*

---

## 1. Vision

Fourth Meridian's AI ladder says it plainly: v2.4.5 made every answer honest; v2.5 made the data singular; v2.6 must make the *understanding* singular. Today the platform has one canonical truth layer (DayFacts, queryTransactions, valuation, FX, debt semantics — genuinely converged, guard-pinned) and **zero canonical understanding layer**. Every smart surface re-derives its own opinion from the truth layer, per request, and forgets it immediately.

The v2.6 thesis: **the AI should hold one versioned, persisted, diffable understanding of the user's finances — the Financial Context Frame — compiled once, rendered everywhere.** The Daily Brief renders it. Ambient Intelligence reacts to its diffs. Notifications reference it. Chat and Voice query it. Search explains it. Platform Ops inspects it. Changing the surface changes presentation, never reasoning — which is exactly the property v2.5 already proved out for financial *data* (one fold, many widgets), lifted one level up to financial *meaning*.

This is the same doctrine the codebase already lives by, applied to a new layer. Fourth Meridian doesn't need a different philosophy for v2.6; it needs its existing philosophy — one authority per truth, facts durable, meaning derived, provenance stamped — extended from numbers to understanding.

## 2. Current State (what the audit found)

### 2.1 The good news: the funnel exists and is clean

`buildContext()` (`lib/ai/context-builder.ts`) is already a real context authority: membership-guarded, manifest-driven (domains by SpaceCategory ∩ AiAgent scope), five registered assemblers, signal detectors as pure functions over assembled domains, audit-stamped. Four of five assemblers consume canonical services (`getRecentSnapshots`, `getCurrentPositions`, `classifyAccounts`, `resolveEffectiveDebtTerms`, flow predicates); the deterministic assessment (`computeAssessment`, 12 sections) is pure over the context; the output validator is live in annotate mode and is membership-not-recomputation. The AI-ARCH doctrine ("no financial derivation in the route") held under adversarial audit. This is a far better substrate than most platforms have — v2.6 builds *on* it, not around it.

### 2.2 The structural problem: one funnel, one consumer, zero memory

- **Only chat consumes the full funnel.** The Daily Brief (`app/api/brief/route.ts`) builds contexts but *never runs `computeAssessment`* — it re-implements simpler judgments inline: its own savings-rate fold (route.ts:408–429), its own low-liquidity rule (`totalLiquid/netWorth < 5%`, route.ts:317) while the assessment uses coverage-months (`engine.ts:294–303`). **The platform currently holds two incompatible opinions about whether the user has a liquidity problem.** This is the contradiction class the v2.6 goal statement names, already live between two shipping surfaces.
- **Weighted APR is computed three times** (assessment classification `engine.ts:241`, debt strategy `metrics.ts:394`, debt workspace `debt-kpis.ts:223`); avalanche ordering twice; spending-trend "what changed" twice (AI monthly buckets vs widget DayFacts compare); the transactions assembler forks the canonical query scope rather than consuming it (`assemblers/transactions.ts:349` — "mirrors the canonical scope").
- **Nothing is persisted.** No conversation model (schema grep clean), no insight memory, no signal dedup — `NET_WORTH_DECLINED` is recomputed and re-surfaced on every request with no record that the user saw it yesterday. `AiAdvice` has **zero production writers** (seed only — KD-14); all five AI notification types are `VOCABULARY` with no producers; the timeline's "Daily Briefing engine" and "AI recommendation" hooks are declared placeholders (`lib/timeline-types.ts:7, 108`).
- **Everything recomputes per request.** Every chat turn rebuilds full context (up to 5,001 transactions + accounts + 90 snapshots + valuations + FX), reruns the assessment, re-derives the time window by re-classifying the entire message history (KD-16), and re-serializes with fresh timestamps — which also defeats provider-side prompt caching byte-by-byte. Master mode multiplies this by N Spaces, unbounded (KD-8). The brief rebuilds N contexts per page view.
- **The scaffolding for the future is present but dangling**: AiAgent exists per Space ("Owns all advice and (future) memory" — a comment with no memory field), the context-priority planner runs in shadow and is never consulted, the AI notification pointer-contract (`adviceId`/`agentId`/`goalId`) is designed against a table nothing fills, and `members`/`providers` domains are routed-to by the intent classifier but have no assemblers (silently skipped every request).

### 2.3 Dependency graph (condensed)

```
                              ┌─ CANONICAL TRUTH (v2.5, converged) ─┐
                              │ DayFacts · queryTransactions ·      │
                              │ valuation · FX · debt semantics ·   │
                              │ visibility · snapshots               │
                              └──────────────┬───────────────────────┘
                                             │
                      buildContext (5 assemblers + signals)          ← per-request, ephemeral
                                             │
              ┌──────────────────────────────┼───────────────────────────────┐
        AI Chat (LLM)                 Daily Brief (deterministic)      [nobody else]
    + computeAssessment              − skips computeAssessment
    + planner (shadow)               + 4 inline judgment rules  ← divergence point
    + validator (live)               + reads AiAdvice (seed-only)
                                             
   PARALLEL, DISCONNECTED STACKS (no shared identity or memory):
   · Space widgets: cash-flow-insights / debt-signals / payoff sim (client, own folds)
   · Alerts (operator): health authorities → email, JobRun-ledger dedup
   · Notifications: chokepoint + registry; AI category = vocabulary only
   · Platform Ops projections: deterministic, share only ApiUsageCounter with AI
   · Timeline: AuditLog/SyncIssue events; AI neither produces nor consumes
   · Search: does not exist (username lookup only) · Embeddings: none anywhere
```

Three separate detection/delivery stacks exist for the same event class (connection breakage: context signal vs SYNC_FAILED notification vs provider-unhealthy alert), each with its own dedup scheme, no shared breach identity.

**Verdict on current state:** the truth layer is singular; the understanding layer is fragmented across five re-implementations and persists nothing. That — not any missing feature — is the v2.6 problem.

## 3. Context Architecture — the Financial Context Frame

### 3.1 The object

One persisted, versioned object per Space (and one composed household frame), exactly along the proposed shape:

```
FinancialContextFrame  (per Space; monotonic version; immutable once sealed)
├── financialState        assembler outputs (accounts, transactions summary,
│                         snapshots, holdings, goals, debt, liquidity,
│                         recurring/subscription candidates)
├── operationalState      user-scoped platform truth: connection health,
│                         open sync issues, pending refreshes, data freshness,
│                         degraded providers — derived from the SAME authorities
│                         Platform Ops reads (sync-issue-semantics, resource-
│                         freshness, connection-health), scoped to this user
├── assessment            computeAssessment output — THE judgment layer
│                         (cash flow, liquidity, debt, allocation, trends,
│                         readiness, priorities) — promoted from chat-only
│                         to frame-resident
├── semanticState         NEW, persisted: active insights/concerns/opportunities
│                         (see §4), known themes, behavioral patterns, stated
│                         facts the user has told the AI ("rent is 800 KWD"),
│                         life-event markers
├── confidence            completeness/estimation metadata per section (the
│                         KD-7/KD-10 honesty pattern, made structural: income
│                         completeness, truncation, FX estimation, coverage)
├── evidence              pointers, not copies: transaction ids, snapshot dates,
│                         sync-issue ids backing every assessment claim
├── narrative             deterministic summary paragraph(s) rendered from the
│                         above (template-first; any LLM narration sits below
│                         the validator per AI-5 doctrine and never adds numbers)
└── provenance            compiledAt, inputs' as-of stamps, deployment SHA,
                          compiler version, trigger (scheduled | sync | manual)
```

**What stays out of the frame (surface-specific by design):** conversation state (per-conversation, not per-Space — it *references* a frame version), user-intent/navigation context (current page, open workspace — request-scoped hints for presentation and context-priority, never reasoning inputs that could make two surfaces disagree), rendering preferences, and drilldown row sets (fetched on demand against the frame's window, as today).

**What deliberately moves *into* canon:** the four inline Brief judgments (savings rate, low-liquidity, debt-ratio, cash-ratio rules) die; the Brief renders `frame.assessment`. The widget-side "what changed" engines converge on frame deltas over time. One liquidity opinion, one APR, one trend.

### 3.2 The compiler and the lifecycle

The **Context Compiler** is `buildContext` + `computeAssessment` + semantic-state carry-forward, run as one unit with a persistence step — evolution, not rewrite:

```
triggers: sync completed · import completed · manual refresh · daily schedule
          · material user action (goal change, account link, correction)
   │
   ▼
compile(spaceId)  →  FrameN  (seal, persist)
   │
   ▼
diff(FrameN, FrameN−1)  →  FrameDelta  (persisted)
   │
   ├─→ delta rules → Insight lifecycle writes (AiAdvice production path — closes KD-14)
   ├─→ materiality thresholds → Notification producers (closes the 5 VOCABULARY types)
   ├─→ timeline events (fills the declared "Daily Briefing engine" consumer hooks)
   └─→ brief/widgets read "latest frame + delta since lastBriefViewedAt"
```

Frames are **compiled on events, read by surfaces** — inverting today's model where every surface compiles on read. A chat turn reads the latest sealed frame (milliseconds) instead of rebuilding it (five assemblers + folds per turn). Staleness is explicit and honest: the frame carries its as-of stamps, and a surface that needs fresher truth triggers a compile and says so — the same freshness honesty the connection cards already practice.

Frames are immutable and stamped (deployment SHA, compiler version) — deliberately the same evidence discipline as `RefreshExecution`/`JobRun`. **Every AI output references the frame version it reasoned from.** That one field buys reproducibility ("what did the AI know when it said that?"), explainability ("why am I seeing this?" → frame evidence pointers), auditability (Platform Ops inspects frames like it inspects refresh executions), and eval infrastructure (replay a frame against a new prompt — the AI5-0 failure corpus becomes *frames + transcripts*, reconstructible by design instead of by archaeology).

Retention: frames are small (they hold aggregates and pointers, not row copies — the 90-point snapshot series is referenced by date range, not embedded). Keep dailies for 90 days, weeklies for 2 years, monthlies forever — the frame history *is* the "financial health evolution" feature (§12) for free.

### 3.3 Contract with the truth layer

The frame does not replace canonical services and must never become a second truth: `financialState` sections are *projections of* canonical reads, evidence is *pointers into* canonical rows, and any consumer needing row-level truth (explorer, drilldown, export) goes to the canonical services as today. The fold-authority guard pattern extends: a source-scan guard pins that no surface computes assessment-class judgments outside the compiler — exactly how `cash-flow-fold-authority.test.ts` pins the DayFacts fold today, and the missing repo-wide breadth that audit finding flagged becomes the natural v2.6 guard.

## 4. Unified Intelligence Model

The second half of the singular understanding is a **single Insight entity with a lifecycle**, because consistency across surfaces is a *dedup and memory* problem as much as a reasoning problem:

```
Insight { id, spaceId, frameVersionDetected, kind, severity, title,
          evidence[], confidence,
          status: detected → surfaced(where,when)[] → acknowledged | dismissed
                  | accepted → resolved | expired,
          dedupeKey }
```

`AiAdvice` becomes this table's ancestor or is superseded by it — either way it finally gains its production write path (frame-delta rules produce insights; KD-14 closes structurally, not incidentally). The rules for what each surface does are then one sentence each: the **Daily Brief** renders the latest frame plus insights `detected|surfaced` since last view. **Ambient Intelligence** is the delta-rule engine plus scheduling — it *is* the compiler's diff step, not a separate mind. **Notifications** fire only on insights crossing per-kind materiality thresholds, honoring the existing pointer contract (`adviceId → Insight`), with suppress-while-open semantics borrowed from the operator alert stack (which already solved this — `evaluate.ts`'s 20h-renotify dedup generalizes). **Timeline** shows surfaced insights as first-class events (the reserved `isPreview` "AI recommendation" type goes live). **Search** answers "why/what changed" queries against frames + insights. **Platform Ops** gets a frame inspector, and — the requirement that Ops explain user-facing behavior changes — the frame's `operationalState` means the Brief can say "your Chase data is 3 days stale because the connection needs reauthentication" from the *same* sync-issue rows the operator sees, closing today's three-disconnected-stacks problem with one shared breach identity (evidence pointer → SyncIssue id).

The consistency guarantee falls out structurally: two surfaces reading frame version N *cannot* contradict each other, because neither one reasons — they render. The Brief can never ignore what a notification recommends, because both are views of the same insight row.

## 5. AI Surface Unification (migration, surface by surface)

| Surface | Today | v2.6 target | Effort shape |
|---|---|---|---|
| Chat | full rebuild per turn | reads latest frame + ConversationState; compile only on staleness | route refactor; assemblers unchanged |
| Daily Brief | own context builds + 4 inline rules | pure renderer of frame + insight inbox | **deletes** judgment code |
| Ambient (new) | — | delta rules on compile; scheduled evaluation | new, small — rules not models |
| Notifications | AI types = vocabulary | insight-threshold producers via existing chokepoint | producers only; registry ready |
| Timeline | no AI events | surfaced insights as events (hook declared) | normalizer + vocabulary |
| Widgets (Key Insights / What Changed / Debt Signals) | client-side own folds | render frame sections/deltas | staged; payoff simulator becomes a canonical lib consumed by frame *and* widget (single payoff engine, closes the APR/avalanche triplication) |
| Search (new) | none | query router over frames/insights/merchants + canonical queryTransactions | v2.7 |
| Platform Ops | disjoint | frame inspector + AI cost per Space (needs ApiUsageCounter user/space dimension — OPS-6H) | small |
| Voice | — | renderer of the same frame (§6) | v2.7 |

Master mode stops being N unbounded prompt concatenations (KD-8) and becomes **frame composition**: household frame = merge of Space frames with dedup at the frame layer (account-id dedup already exists in the brief — it moves into the composer), then one bounded serialization. Failed Spaces become explicit `confidence` entries instead of silent omissions — closing KD-8's disclosure gap structurally.

## 6. Voice Readiness

Voice is a renderer with a microphone. If the architecture above lands, the nine benchmark questions are all answered *from the frame*: "How am I doing?" → narrative + assessment priorities; "Why did cash flow decline?" → assessment deficit-cause + evidence pointers; "What changed this week?" → FrameDelta; "Should I invest more?" → investmentReadiness + liquidity coverage (with its confidence caveats spoken, not dropped); "What should I worry about?" → active insights by severity; "Explain my portfolio" → holdings section; "Compare this month with last month" → delta between frames — *already a persisted object, not a recomputation*; "Where am I wasting money?" → spending opportunities + recurring candidates; "What should I do today?" → insight inbox.

What genuinely must be built for voice, none of it a second AI: **ConversationState** (AI-5 WS-1 — the same substrate chat needs; voice is unusable without window/entity continuity and graceful compression, WS-5); **streaming** in `lib/ai/provider.ts` (today: none — blocking completions with no retry/timeout; voice needs token streaming and sub-second first-token, which frame-reads enable by removing compile latency from the turn path); **an entity-resolution API** ("my Chase card", "that subscription") — deterministic resolution against frame entities, an extension of the intent classifier's existing entity work; **an action API** with confirmation semantics for the small set of state-changing verbs (categorize, snooze, set goal) — insight lifecycle transitions are already actions, so the inbox gives voice its verbs; and the **speech shell** itself (STT/TTS, barge-in), which is pure presentation. Missing memory (stated facts — "my rent is 800 KWD") lands in `semanticState` with user-visible, editable provenance; the current doctrine line "never claim to persist" flips to "persist and *show* what you persisted."

## 7. Provider Expansion Strategy

The repo's own doctrine (PROV/CCPAY-2G: *abstract from the second proven implementation, not the first*) is correct and should govern the roadmap. Plaid + BTC-wallet prove the account spine (`persistAccountSpine`, `Connection → ProviderAccountIdentity → FinancialAccount → SpaceAccountLink`); they do not yet prove a universal ingestion payload (PROV-6 deliberately deferred). Therefore: **the next provider is chosen to be the one that proves the contract**, and PROV-6 lands *from* it.

**Sequencing.** v2.6: one crypto exchange — **Coinbase** (OAuth, sane REST, fills the largest user-visible gap: exchange custody is where most crypto actually sits, and the legacy-Holding crypto bridge P2-6 wants retiring). Building it surfaces the third copy of the spine; extract `ProviderIngestionPayload` then, per doctrine. v2.7: **Kraken** (second exchange — validates the payload contract across exchange idioms), **EVM wallets as one adapter** — Ethereum, Base, Arbitrum, Optimism, Polygon, Avalanche/BSC are a single JSON-RPC/indexer contract with a chain-id parameter, mirroring how btc-sync already treats addresses; one adapter, N chains, priced as one integration. **Solana** is its own adapter (different account model). **Brokerages via aggregator, not direct**: IBKR/Schwab/Fidelity/Vanguard/Robinhood direct integrations are five compliance-heavy projects; SnapTrade (or Plaid Investments where coverage suffices) delivers the set through one payload-conformant adapter — revisit direct IBKR (the only one with a real API worth owning) at v3.0 scale. Later/long-tail: Gemini, Crypto.com, Bitstamp; **Strike/River/Lightning** only with genuine demand (custodial APIs are thin; Lightning channel accounting is a research project, not an integration). Hardware wallets are *not integrations* — xpub watch-only already covers BTC; EVM watch-only covers the rest; say so in the product. **Banking regional gaps**: Plaid covers NA well; EU/UK via one PSD2 aggregator (GoCardless/Tink/TrueLayer — pick one); and given the founder's own geography, **MENA/GCC via Lean Technologies or Tarabut** deserves an early spike — it is also the best test that `money-and-fx`'s multi-currency honesty holds under a non-USD home currency.

**Architectural implications.** Identity: the B4 partial unique index (`financialAccountId, externalTransactionId` active-only) generalizes as-is to exchanges and EVM; each adapter must declare its external-id shape (exchange trade id; `chainId:txHash:logIndex` for EVM) and its tombstone semantics (tombstone-wins is now doctrine). Sync: every adapter implements `connect → automatic initial sync → ready` and rides the shared lock/coverage/incident patterns — the OPS-2D admission plane must grow provider-neutral producers (today's census is Plaid-side; the BTC pause-gap audit finding becomes a contract requirement). Reconciliation is the genuinely new problem: **cross-provider transfer folding** — a Coinbase withdrawal and the wallet deposit it lands as are one economic movement seen twice; transfer-evidence gains a cross-provider matcher (amount/asset/time-window/address evidence union), which is also the flagship "cross-provider intelligence" feature (§12) — the data model (evidence axes, disposition resolution) already anticipates it.

## 8. Crypto Roadmap (condensed)

v2.6: Coinbase (proves PROV-6) · retire the legacy-Holding bridge (P2-6 completes: every crypto position becomes a canonical PositionObservation) · cost-basis groundwork (exchange fills carry basis; observations gain optional lots). v2.7: Kraken · EVM adapter (ETH + L2s in one) · Solana · cross-provider transfer folding · staking/reward flow classification (new flow families, through the *one* classifier under its authority fence — the btc-sync FU-1 convergence must land first so there is exactly one writer to extend). v2.8+: Gemini/Crypto.com/Bitstamp by demand · Cosmos · Lightning research spike only. Non-goals, explicit: no trading execution, no DeFi position parsing (LP/lending protocols) until the observation model proves it wants it — watch-only truth first, doctrine over surface area.

## 9. Cost Optimization

What the audit measured: every chat turn rebuilds full context and serializes most transaction aggregates **twice** (once as prose blocks, once as the raw `JSON.stringify(section.data)` blob — `context-serializer.ts:506`); the 90-day snapshot series is likely the single largest blob; fresh `assembledAt`/`detectedAt` timestamps in the prefix defeat provider prompt caching byte-for-byte; the planner that would trim to a 6,000-token budget runs in shadow; master mode multiplies everything by N with no cap; the brief re-folds N contexts per page view; and per-Space cost attribution is structurally impossible (ApiUsageCounter has no user/space dimension).

The remedies, in order of leverage: **(1) Frames** — compile once per material change instead of once per read; a 10-turn chat session goes from 10 full compiles to ~1; the brief's per-view fold cost collapses to a frame read. **(2) Stable serialization** — move volatile stamps out of the prompt body into a single trailer line; serialize sections in fixed order from the *sealed* frame so consecutive turns share a byte-identical prefix and provider-side prompt caching (50–90% discount on cached input tokens, model-dependent) actually engages. **(3) De-duplicate the prompt** — prose blocks *or* raw JSON per section, not both (the serializer's checked-invariant pattern, KD-17, shows how to keep the prose honest without the shadow copy). **(4) Planner goes live** — the shadow scaffolding is built; enforcing the 6k budget with the ALWAYS floor is configuration plus trust, and the frame's stable sections make trimming deterministic. **(5) Bounded master composition** (§5) caps the N-Space blowup. **(6) Insight persistence kills re-summarization** — narratives and assessments are stored once per frame, not regenerated per surface. **(7) Embeddings, when search lands, are computed at frame-compile time** (incremental — only changed entities), never per query. **(8) OPS-6H** — add userId/spaceId to ApiUsageCounter so the Ops cost widget can attribute spend and the beta can price itself.

Order-of-magnitude estimate (full-scope space, from in-repo constants and serializer shape): today's per-turn input is roughly 8–15k tokens, nearly all rebuilt and uncached. Frames + stable prefix + dedup + live budget takes the *fresh* input per turn to ~1–3k (new user turn + delta) with the remainder cache-priced — a **60–85% reduction in effective input cost per conversation turn**, larger in master mode, while *adding* the ambient surfaces at near-zero marginal LLM cost because ambience is deterministic delta rules over already-compiled frames plus at most one narration call per compile. The AI-usage Ops widget provides the before/after ledger to verify the estimate in production — measure, don't trust.

## 10. Recommended v2.6 Scope

**v2.6a — One Mind (the frame substrate):**
1. `FinancialContextFrame` model + Context Compiler (buildContext + computeAssessment + persistence + diff) with provenance stamping; chat and brief converted to frame readers; brief's inline judgments deleted. *This is V26-FOUNDATION-1 — AI Truth Convergence, now with a written definition.*
2. ConversationState (AI-5 WS-1) + window/context-change disclosure (WS-2) + intent-path consistency (WS-4) — closes KD-16; frames give WS-4 its single availability source.
3. Confidence propagation (WS-3) lands *as* the frame's `confidence` layer — structural, not prompt prose.
4. Context-priority planner live under the 6k budget; stable serialization; prompt dedup; bounded master composition (closes KD-8); AuditLog write-amplification fix rides along (KD-12).
5. Pre-entry obligations from the closure audit: relocate `lib/ai/visibility.ts` out of the AI namespace; btc-sync flow-authority convergence; ship the `members`/`providers` assemblers or delete their routing.

**v2.6b — Ambient (the frame speaks):**
6. Insight entity + lifecycle + dedup; frame-delta rules as the AiAdvice/insight production path (closes KD-14).
7. Notification producers for the five AI types via the existing chokepoint + materiality thresholds; DAILY_BRIEF_READY becomes a real scheduled compile-and-notify job in the job registry (first AI entry in `lib/jobs/registry.ts` — it inherits health/alerting for free, and the dispatcher-budget fix from the ops backlog becomes a prerequisite worth pulling forward).
8. Timeline integration (surfaced insights as events); "why am I seeing this?" = evidence-pointer rendering; frame inspector in Platform Ops; OPS-6H cost attribution.
9. Exit criteria stay the roadmap's: one week of scheduled briefs, zero validator failures, zero contradictions — now testable *by construction* (two surfaces, one frame) rather than by vigilance.

## 11. Recommended v2.7+ Scope

Voice (streaming provider + speech shell + entity/action APIs over the frame); Search (query router over frames/insights/merchants; embeddings computed at compile time; "explain any number" via validator-in-reverse); provider wave 1 (Coinbase → PROV-6 payload extraction → Kraken + EVM adapter + Solana; MENA banking spike); cross-provider transfer folding; household intelligence (frame composition as a first-class product for shared Spaces — "the household frame" — with per-member visibility already solved by the SAL layer); frame-history features (financial health evolution, seasonal baselines once 12+ months of frames exist); time-model integration (compile a frame *as-of* a past date — the TimelineLens/AI unification the audit found missing).

## 12. Stretch Ideas (what Fourth Meridian should become known for)

- **The Financial Memoir** — frames replayed as narrative: "In March you were worried about runway; by June the Chase payoff you planned in chat had cut your interest burden 40%." The AI provably *remembers the user's year*, because understanding is versioned. No competitor can retrofit this — it requires having persisted frames from the start.
- **"What did you know and when did you know it"** — every AI statement links to its frame; every frame links to its evidence; every evidence pointer links to canonical rows. Full-chain explainability as a *user-facing* feature, born from ops-grade provenance discipline.
- **The Counterfactual Machine** — the deterministic engine + frames enables honest what-ifs: "what would my runway be if I dropped these three subscriptions?" is a re-fold, not an LLM guess; the validator guarantees the numbers.
- **Financial Weather** — seasonal forecasting from frame history + recurring-candidate model: "December is historically your most expensive month (+34%); at current pace you'll enter it with 2.1 months of runway."
- **Household Diplomacy** — shared-Space intelligence that respects visibility levels *in its speech*: the AI can tell a partner "shared spending rose" without leaking BALANCE_ONLY details — the visibility predicate already gates the data; the frame makes the *narration* provably leak-free (the validator's membership check extends to entity names).
- **The Stated-Fact Ledger** — user-taught facts (rent, salary date, tuition) as first-class, editable, provenance-marked memory that measurably upgrades `confidence` — turning "tell me your rent" from a lost chat message into an accuracy investment the user can see.
- **Trust Score, inverted** — expose the AI's *own* confidence per claim, per section (data completeness × freshness × estimation), as UI. Competitors project false confidence; Fourth Meridian's brand is that its AI shows its work — the doctrine files already read this way; make it product.
- **Drift alarms** — longitudinal behavior detection over frame history: "your dining spend has grown 8%/month for four consecutive months" is a frame-series regression, cheap, deterministic, and exactly the ambient insight users actually forward to their partners.

## Final Answer — the one improvement

**Ship the versioned Financial Context Frame: compile the understanding once, persist it, diff it, and make every surface a renderer of it.**

Not voice, not providers, not any single delightful feature — the frame. Three reasons it dominates: *(1) Every other ambition reduces to it.* The brief-vs-chat contradiction, KD-8, KD-12, KD-14, KD-16, the five dangling notification types, the timeline hooks, voice readiness, explainability, cost — each is either solved by the frame or blocked without it. It converts eleven scattered gaps into one substrate plus renderers. *(2) It compounds and cannot be retrofitted.* Every week of production creates frame history no competitor can synthesize later — the memory, evolution, and forecasting features of v2.7+ are only possible if v2.6 starts recording understanding now. A smarter model can be swapped in any quarter; a year of versioned understanding cannot. *(3) It is the same bet the codebase already won.* v2.5's entire value was forcing one authority per financial truth, and the discipline held under adversarial audit. The frame is that identical bet at the semantic layer — one authority per *understanding* — made by a team that has already proven it can collect on it.

Fourth Meridian's moat won't be that its AI answers questions about money. It will be that its AI has *known the user's finances continuously, verifiably, and honestly for years* — and the first version of that moat is dug the day the first frame is sealed.
