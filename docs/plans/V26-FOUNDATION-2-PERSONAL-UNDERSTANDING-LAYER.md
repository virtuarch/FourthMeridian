# V26-FOUNDATION-2 — Personal Financial Understanding Layer

**Status:** Investigation. No code, no schema, no migration produced by this pass.
**Audited against:** `v2.6` @ `146a0dd` (2026-07-27). Every field and file:line verified from source this session.
**Reads with:** `V26-FOUNDATION-1-FINANCIAL-CONTEXT-FRAME.md` · `FABLE-2.6-CONTEXT-ARCHITECTURE.md`

---

## 1 · Executive recommendation

**Adopt the Personal Understanding Layer — but split it from the initiative it is currently bundled with, because three of the four motivating examples are not personal-context problems at all.**

The four examples in the brief resolve to two distinct engineering problems:

| Example | Actually requires | Needs personal data? |
|---|---|---|
| "$2M net worth, $40k liquid — don't headline 2% liquid" | Liquidity semantics = coverage-months | **No** |
| "$1M net worth vs $100k @ 22% revolving — don't neutralise, don't destroy runway" | Cross-domain assessment interaction | **No** |
| "Portfolio question → liquidity share; safety question → runway" | Intent-based emphasis policy | **No** |
| "User moved Riyadh → Kuwait" | Effective-dated residence context | **Yes** |

**Only one of four needs the personal layer.** The other three need a *deterministic cross-domain reasoning policy* that consumes nothing personal and can ship far sooner, with none of the privacy surface.

This matters because example 2 is already half-solved: the assessment engine **already** reasons in coverage-months (`lib/ai/intelligence/annotations/engine.ts:291-303`). The surface that says "2% liquid" is the Daily Brief's inline rule (`app/api/brief/route.ts:317`), which V26-FOUNDATION-1 deletes. **Resolving F-1's decision D1 fixes the headline example with zero personal data and zero new tables.**

### Therefore: two initiatives, not one

- **V26-F2a · Cross-Domain Reasoning Policy** — deterministic, personal-context-free, high immediate value, no privacy surface. Ships first.
- **V26-F2b · Personal Understanding Layer** — `StatedFact` / `LifeEvent` / effective-dated residence, confirmation policy, Personal Context Ledger. Ships behind F2a, gated on product decisions in §17.

### Reservations

1. **The layer is greenfield, but so is its proof of value.** Nothing personal reaches the AI today (§2). There is no migration burden — and no evidence that any specific personal field improves output. Build the *smallest* contract that lets you measure that.
2. **Peer benchmarking is not feasible in v2.6** (§10) and probably not in v2.7. Recommend excluding it from the roadmap rather than deferring it.
3. **Sensitive traits: recommend hard exclusion**, not policy management (§11).

---

## 2 · Verified inventory of current personal context

### 2.1 What exists

| Field | Model | Source | Mutable | History | Scope | Consumed by | **Reaches AI?** |
|---|---|---|---|---|---|---|---|
| `firstName`, `lastName`, `name` | User | user-stated | yes | no | User | settings, brief greeting | **No** |
| `dateOfBirthEncrypted` | User | user-stated | yes | no | User | **export only** | **No** |
| `employmentStatus` (enum, 5) | User | user-stated | yes | no | User | settings, admin, export | **No** |
| `useCase` (enum, 5) | User | user-stated | yes | no | User | settings, admin, export | **No** |
| `timezone` | User | user-stated | yes | no | User | — (see 2.3) | **No** |
| `reportingCurrency` | User | user-stated | yes | no | User | **seed only** → Space | **No** (Space's is used) |
| `preferredSpaceId` | User | user action | yes | no | User | login landing | **No** |
| `lastBriefViewedAt` | User | system | yes | no | User | brief | **No** |
| `CreditScore` | own model | user-stated | yes | **YES** | User | widgets | **No** |
| `SpaceGoal` | own model | user-stated | yes | partial | **Space** | goals assembler | **YES** |
| `SpaceMember` role/visibility | own model | system | yes | no | Space | everything | indirectly (gating) |
| `AiAgent.agentScope` | AiAgent | system | yes | no | Space | domain manifest ∩ | indirectly (gating) |

### 2.2 The decisive finding

**Zero personal context reaches the AI.**

- `lib/ai/context-builder.ts` selects **no** user personal field — `userId` is used solely for membership and visibility.
- `lib/ai/prompts/system-prompt.ts` contains **no** personal reference — no age, employment, geography, household, or risk vocabulary.
- `SpaceContext_AI` (`lib/ai/types.ts:1052`) carries `userId` as an identity key only.

`SpaceGoal` is the **single** personal-context channel that reaches the model, via the registered goals assembler (`lib/ai/assemblers/goals.ts:197`).

So the platform asks for date of birth, employment status and use case at registration — encrypts the first — and then uses **none of them** to interpret anyone's finances. `dateOfBirthEncrypted` is decrypted in exactly one place: `lib/export/assemble.ts:87`, for GDPR export. Age is never derived.

### 2.3 What does not exist at all

Verified absent from `prisma/schema.prisma` — grep for `country|residence|region|locale|nationality|address|city` returns **nothing**:

- country / residence / metro / cost-of-living environment
- household composition, dependents, marital status
- income (structure, stability, amount, cadence)
- risk tolerance, investment horizon, liquidity preference
- tax or regulatory context
- life events of any kind
- any user-stated fact outside goals
- **any onboarding flow** — zero artifacts under `app/`, `components/`, `lib/`

`User.timezone` exists but the only timezone consumer (`lib/hero-region.ts`) reads the **browser-resolved** zone, not the stored field. The stored value appears functionally unused.

### 2.4 The existing precedent worth generalising

```prisma
model CreditScore {
  id         String   @id @default(cuid())
  userId     String
  score      Int
  source     String   @default("manual")  // "manual" | "chase_app" | "amex_app" | "experian"
  recordedAt DateTime @default(now())
}
```

This is **already** a stated fact with provenance and an effective date: value + source + when-it-was-true, append-only, per-user. It is the miniature of the entire contract this plan proposes. `StatedFact` should be recognisably its generalisation, not a novel invention.

A second precedent worth copying: `reportingCurrency` exists on both `User` (`schema.prisma:416`) and `Space` (`:504`), and the schema comment states the User value is a **copy-once seed** while the Space value is authoritative. That "seed vs authority" distinction is exactly what personal context needs (a User-level default residence seeding, never overriding, Space-level interpretation).

---

## 3 · Missing capability map

| Capability | Today | Gap class |
|---|---|---|
| Know where the user lives | absent | **schema + intake** |
| Know when they moved | absent | **temporal model** |
| Know income structure/stability | absent (inferred only from transactions) | schema + intake |
| Know dependents/household | absent | schema + intake |
| Know risk/liquidity preference | absent | schema + intake |
| Distinguish stated vs observed vs inferred | absent | **contract** |
| Effective-date any personal fact | only `CreditScore` | contract |
| Confirm a candidate fact | absent | **intake policy** |
| Show the user what we know | absent | **product surface** |
| Delete a personal fact and propagate | absent | privacy |
| Cross-domain judgment (debt vs runway) | absent | **reasoning policy** |
| Intent-based emphasis | absent | reasoning policy |
| Peer benchmarking | absent | not feasible (§10) |

The two **bold** clusters are the v2.6 foundation. Everything else is v2.7+.

---

## 4 · Personal-context authority boundaries

Extends the five layers in F-1 §3 with a sixth. The ordering rule is absolute:

```
Canonical Truth        rows            — what happened
Financial Frame        sealed          — what it means, financially
Assessment Policy      deterministic   — which meanings interact, and how       ← V26-F2a
Personal Context       effective-dated — who this person is                     ← V26-F2b
Relevance & Emphasis   derived         — which true things matter now
Rendering              regenerable     — how it is said
```

**The invariant, stated as a testable rule:** personal context may enter at *Relevance & Emphasis* and at *Assessment Policy inputs that are themselves financial* (e.g. a confirmed upcoming obligation is a cash-flow fact). It may **never** enter canonical arithmetic. Two users with identical financial facts and different personal context must receive an **identical assessment** and may receive a **different headline, ordering, comparison set and wording**.

This is enforceable by construction: `computeAssessment(ctx)` is pure over `SpaceContext_AI`, which carries no personal field today. Keep it that way. Personal context is a parameter of the *policy* and *presentation* functions, not of the assessment function. A guard test can pin the signature.

---

## 5 · Proposed domain contracts

Exploratory. No Prisma. Deliberately several small concepts rather than one memory blob.

```ts
// ── Shared provenance vocabulary ────────────────────────────────────────────
export type FactOrigin =
  | 'USER_SETTINGS'      // typed into a form — highest trust
  | 'ONBOARDING'         // answered a structured question
  | 'USER_ACTION'        // implied by a deliberate act (goal created)
  | 'CHAT_STATED'        // user said it in conversation
  | 'SYSTEM_OBSERVED'    // derived from financial data (pattern)
  | 'MODEL_INFERRED';    // model's hypothesis — NEVER a fact

export type ConfirmationState =
  | 'CONFIRMED'          // user affirmed explicitly
  | 'CANDIDATE'          // awaiting confirmation; may inform, may not assert
  | 'HYPOTHESIS'         // never surfaced as fact; may only prompt a question
  | 'REJECTED'           // user said no — retained to prevent re-asking
  | 'SUPERSEDED';        // replaced by a later fact

export type Sensitivity =
  | 'ORDINARY'           // employment status, currency
  | 'FINANCIAL_PRIVATE'  // income, dependents
  | 'RESTRICTED';        // never collected — see §11

// ── A single user-stated fact, effective-dated ──────────────────────────────
export interface StatedFact {
  id:        string;
  userId:    string;
  /** null = applies to the person across all Spaces. */
  spaceId:   string | null;
  key:       StatedFactKey;        // closed vocabulary, NOT free text
  value:     StatedFactValue;      // discriminated by key
  origin:    FactOrigin;
  confirmation: ConfirmationState;
  sensitivity:  Sensitivity;
  confidence:   'HIGH' | 'MEDIUM' | 'LOW';

  /** When the fact became true in the world — not when it was recorded. */
  effectiveFrom: string;
  effectiveTo:   string | null;    // null = still true
  recordedAt:    string;

  /** Where it came from, precisely enough to show the user. */
  sourceRef: | { kind: 'settingsField'; field: string }
             | { kind: 'chatMessage';   messageId: string; excerpt: string }
             | { kind: 'onboarding';    questionId: string }
             | { kind: 'observation';   frameId: string }
             | null;

  supersedesId: string | null;
  visibility:   'PRIVATE' | 'SPACE';   // never household-wide by default
}

/** Closed vocabulary. Adding a key is a reviewed decision, not a model choice. */
export type StatedFactKey =
  | 'residence.country' | 'residence.metro'
  | 'employment.status' | 'employment.employer' | 'employment.startDate'
  | 'income.cadence'    | 'income.stability'
  | 'household.adults'  | 'household.dependents'
  | 'preference.liquidityFloorMonths'
  | 'preference.riskTolerance'
  | 'obligation.upcoming';

// ── A dated change in circumstance ──────────────────────────────────────────
export interface LifeEvent {
  id:      string;
  userId:  string;
  kind:    LifeEventKind;
  occurredOn:  string;          // effective date
  precision:   'DAY' | 'MONTH' | 'YEAR' | 'APPROXIMATE';
  origin:      FactOrigin;
  confirmation: ConfirmationState;
  /** Facts this event implies — created only on confirmation. */
  impliedFactIds: string[];
  sourceRef: StatedFact['sourceRef'];
  narrative: string | null;      // user's own words, never the model's
}

export type LifeEventKind =
  | 'RELOCATION' | 'EMPLOYMENT_CHANGE' | 'HOUSEHOLD_CHANGE'
  | 'INCOME_CHANGE' | 'MAJOR_PURCHASE' | 'DEBT_PAYOFF'
  | 'RETIREMENT' | 'BUSINESS_FORMATION' | 'EDUCATION';

// ── Observed, never stated ──────────────────────────────────────────────────
export interface ObservedPattern {
  id:       string;
  spaceId:  string;
  kind:     'INCOME_CADENCE' | 'RECURRING_OBLIGATION' | 'SPEND_SEASONALITY'
          | 'MERCHANT_GEOGRAPHY_SHIFT';
  /** Evidence is canonical pointers — the frame's contract, reused. */
  evidence: Array<{ kind: 'transaction'; ids: string[] }>;
  firstObservedFrameId: string;
  lastObservedFrameId:  string;
  strength: number;        // 0..1, deterministic
  /** An observation may PROMPT a question. It may never become a StatedFact. */
  promptedFactKey: StatedFactKey | null;
}

// ── What the assessment policy was allowed to assume ────────────────────────
export interface ContextAssumption {
  key:        StatedFactKey;
  value:      unknown;
  basis:      'CONFIRMED_FACT' | 'DEFAULT' | 'ABSENT';
  factId:     string | null;
  /** Rendered to the user as "we assumed X because Y". */
  disclosure: string;
}
```

**Deliberately not proposed:** `UserProfile` as a wide mutable row (it is the timeless-field anti-pattern the brief warns against — `residence.country` on a profile row cannot express "moved last year"); `PeerBenchmarkProfile` (§10); a free-form memory blob (explicitly excluded).

**`FinancialGoal`** already exists as `SpaceGoal` and should not be duplicated. It needs one addition to join this model: an origin/confirmation stamp so a goal proposed in chat is distinguishable from one the user typed.

---

## 6 · Intake and confirmation policy

| Path | Origin | Default state | May assert? | May persist automatically? |
|---|---|---|---|---|
| Settings form | `USER_SETTINGS` | `CONFIRMED` | yes | **yes** |
| Onboarding answer | `ONBOARDING` | `CONFIRMED` | yes | **yes** |
| Deliberate action (goal, currency change) | `USER_ACTION` | `CONFIRMED` | yes | **yes** |
| Chat statement ("I live in Kuwait now") | `CHAT_STATED` | `CANDIDATE` | **no** | **no — requires confirmation** |
| Model inference from merchant geography | `MODEL_INFERRED` | `HYPOTHESIS` | **never** | **never** |
| Financial-data pattern (salary on the 25th) | `SYSTEM_OBSERVED` | n/a — `ObservedPattern` | as observation only | yes, as a pattern |
| Household member statement | `CHAT_STATED` | `CANDIDATE` | no | no — and never cross-writes another member |

**Three hard rules.**

1. **Nothing from a conversation is ever written as a `CONFIRMED` fact without an explicit affirmative.** A `CANDIDATE` may be stored (so the question is not re-asked) but may not be asserted back to the user as known, and may not enter emphasis policy.
2. **A `HYPOTHESIS` never persists as a fact.** It may only generate a question. "Your card activity moved to Kuwait — did you relocate?" is legitimate; silently setting `residence.country = KW` is not.
3. **Confirmation is per-fact, not per-conversation.** Confirming a relocation does not confirm the currency change it implies; each implied fact carries its own state.

**Worked example — "I moved from Riyadh to Kuwait last year":**

```
LifeEvent   RELOCATION, occurredOn ≈ −1y, precision APPROXIMATE, CANDIDATE
  implies → StatedFact residence.country = SA, effectiveTo   ≈ −1y   CANDIDATE
  implies → StatedFact residence.country = KW, effectiveFrom ≈ −1y   CANDIDATE
  prompts → "Should I use KWD for cost comparisons from then on?"    (asks, never assumes)
```

Nothing is confirmed. Nothing changes the assessment. One question is asked, once, and a rejection is recorded so it is not asked again.

---

## 7 · Cross-domain reasoning model — **V26-F2a**

This is the part that needs no personal data and delivers three of the four examples.

Today the assessment produces **sections** (`liquidity`, `cashFlow`, `debt`, `allocation`, `readiness`, `priorities` — `engine.ts`). What is missing is a layer that reasons about **interactions between** sections and decides what is eligible to be a headline.

```ts
export interface AssessmentInteraction {
  id:       string;             // 'RUNWAY_SUPPRESSES_LIQUID_SHARE'
  when:     (a: FinancialAssessment) => boolean;
  effect:   | { kind: 'SUPPRESS'; claimId: string; reason: SuppressionReason }
            | { kind: 'ELEVATE';  claimId: string; rationale: string }
            | { kind: 'CONSTRAIN'; claimId: string; constraint: Constraint };
  /** Deterministic, ordered, and individually testable. */
  precedence: number;
}

export type SuppressionReason =
  | 'ADEQUATE_RUNWAY'        // liquid share is low but coverage is long
  | 'LOW_CONFIDENCE'         // inputs too incomplete to headline
  | 'IMMATERIAL_MAGNITUDE'
  | 'SUPERSEDED_BY_URGENT';

export interface Constraint {
  kind:   'MIN_RUNWAY_MONTHS' | 'MIN_LIQUID_ABSOLUTE';
  value:  number;
  source: 'DEFAULT' | 'CONFIRMED_PREFERENCE';   // ← the only personal hook
}
```

**The four examples as rules:**

| Rule | Behaviour |
|---|---|
| `RUNWAY_SUPPRESSES_LIQUID_SHARE` | liquid/net-worth is never a *safety* headline when coverage ≥ threshold. It remains available as a *composition* fact |
| `HIGH_APR_SURVIVES_SOLVENCY` | revolving debt above an APR threshold stays a priority regardless of net worth — solvency never suppresses cost-of-carry |
| `PAYOFF_BOUNDED_BY_RUNWAY` | a payoff recommendation is constrained so post-payoff runway ≥ `MIN_RUNWAY_MONTHS`; if impossible, recommend partial |
| `ILLIQUID_WEALTH_IS_NOT_RESILIENCE` | high net worth with low coverage does not raise the safety verdict |

All four are pure functions of `FinancialAssessment`. **None reads personal context** — except `MIN_RUNWAY_MONTHS`, which takes a default and is overridden only by a *confirmed* preference. That single seam is where F2b later plugs in, and it is the whole coupling between the two initiatives.

---

## 8 · Intent-versus-truth policy

Intent selects **emphasis**, never **value**.

```ts
export interface EmphasisPolicy {
  intent:  'SAFETY' | 'PORTFOLIO' | 'DEBT_DECISION' | 'GENERAL';
  /** Ordered claim ids to lead with. */
  lead:    string[];
  /** Claims eligible for headline under this intent. */
  eligible: string[];
  /** Never hidden — demoted only. Suppression ≠ deletion. */
  demoted:  string[];
}
```

| Question | Leads with | Still true, just demoted |
|---|---|---|
| "How safe am I?" | runway, cash-flow direction, upcoming obligations, data freshness | liquid share, allocation |
| "Is my portfolio healthy?" | allocation, concentration, **liquid share**, risk exposure | runway |
| "Should I pay off debt?" | APR, debt type, post-payoff runway, cash-flow headroom, alternatives | allocation |

**The guarantee, and how it is proved:** the same sealed frame under different intents must yield **identical claim values** and may yield different ordering. A test asserts that for a fixed frame, the set of claims and their values is invariant across all `intent` values — only `lead`/`demoted` differ. That is the mechanical answer to "prompt wording must not create contradictory assessments."

---

## 9 · Progressive-personalization model

| Level | Has | Can conclude | Cannot conclude | Invitation |
|---|---|---|---|---|
| **L0 — Financial data only** | connected accounts | runway, cash-flow direction, debt cost, allocation, concentration, trends | whether runway is *adequate for this person*; cost-of-living comparisons; goal-relative progress | none — must feel complete |
| **L1 — Basic profile** | + residence country, employment status | currency-appropriate framing; regional cost context | household-adjusted adequacy | offered at the moment a comparison would have been possible |
| **L2 — Goal-aware** | + goals & target dates | progress, required run-rate, trade-offs | competing-priority resolution across life domains | offered when a goal-shaped question is asked |
| **L3 — Life-context aware** | + household, dependents, obligations, preferences | personalised adequacy thresholds; obligation-aware liquidity | future intent | offered when an assessment is *materially* uncertain without it |
| **L4 — Longitudinal** | + frame history, life events | trajectory, seasonality, "since you moved…" | — | emerges, never asked for |

**Invitation doctrine.** Ask at the point of value, once, with the benefit named and the refusal free:

> "Your runway is 13 months. If you tell me roughly what you spend per month in Kuwait, I can tell you whether that's comfortable *there* — otherwise I'll keep using your observed spending."

Never: incompleteness meters, "profile 40% complete", nagging, or a locked feature. **L0 must be a complete product.** A test should assert that no surface renders a "missing information" warning for an L0 user.

---

## 10 · Peer-benchmarking feasibility

**Recommendation: exclude from v2.6 and v2.7. Do not defer — decline.**

Evidence:

1. **No cohort dimensions exist.** No country, metro, income, household or homeownership field is in the schema (§2.3). Every proposed cohort axis would have to be built and populated first.
2. **The user base cannot support it.** The production database holds a handful of users (v2.5 shipped to a closed beta; `registration_mode` gates signup). Minimum viable cohort sizes (k≥50 for a stable percentile, k≥5 for any anonymity guarantee) are years away.
3. **Selection bias is disqualifying.** Users of a net-worth tracker who connect accounts are not representative of any population. "Above average for similar users" would mean "above average among people who opted into financial tracking software" — a statement with no decision value and high misleading potential.
4. **It conflicts with the house honesty doctrine.** This codebase returns `amount: null` rather than a plausible number when FX is unavailable. A percentile from a biased n=40 sample is exactly the false precision that doctrine exists to prevent.

**If it is ever revisited:** external reference data (central-bank household surveys, national statistics) framed as *population statistics*, never as "users like you" — with the population named, the year stated, and no percentile shown below a published cohort size. That is a v3.0 content-licensing question, not an architecture question.

---

## 11 · Privacy and sensitive-data policy

### 11.1 Protected traits — hard exclusion

Race, ethnicity, gender, religion, health status, disability, sexual orientation, political affiliation, immigration status, union membership.

**Recommendation: never collect, never infer, never store, never use.** Not "collect with consent" — **exclude**.

Reasoning: no legitimate financial-interpretation use survives scrutiny. Every plausible use case decomposes into a non-protected proxy that is both more accurate and lawful — household size rather than marital status or orientation; confirmed medical obligations as an *upcoming obligation* rather than health status; residence country rather than nationality. Using protected traits in financial judgment raises fair-lending exposure (ECOA/Reg B in the US, GDPR Art. 9 in the EU) for zero modelling gain.

**Enforcement, not policy.** `StatedFactKey` is a **closed vocabulary** with no protected-trait key. There is no field to write to. A guard test asserts the key union contains no restricted term. If a user volunteers a protected trait in chat, the extractor produces nothing — not a `HYPOTHESIS`, not a `REJECTED` row, **nothing** — and this must be explicitly tested, because "we stored that you told us you're pregnant, marked rejected" is itself the harm.

### 11.2 Controls

- **Data minimisation** — a key enters the vocabulary only with a named consuming rule. No speculative collection.
- **Personal Context Ledger** (§ below) — the required user-facing surface.
- **Deletion** — deleting a fact removes it from all *future* compilation. Historical frames are immutable (F-1) and retain the *pointer*; the reader must render "this context has since been removed", never resurrect the value. This is the same dangling-evidence contract as F-1 §10.5.
- **`purgeUser` must cascade** `StatedFact`, `LifeEvent`, `ObservedPattern` — and this belongs in the same audit that F-1 §10.2 flags for frames.
- **Export** — `lib/export/assemble.ts` must include personal facts with provenance; it already handles the DOB decrypt precedent.
- **Visibility** — a `StatedFact` defaults to `PRIVATE`. Space-visible facts must respect `SpaceAccountLink` semantics. **A household member's stated fact is never written to another member's profile.**

### 11.3 Personal Context Ledger — recommended surface

A settings page listing every fact with: value · origin badge (stated / observed / inferred) · effective dates · the exact source (message excerpt or form field) · *what it changes* ("used to set your runway floor at 6 months") · edit · delete. Plus a global "use my personal context" switch that degrades cleanly to L0.

This is the product expression of the codebase's existing "show your work" doctrine, and it is the thing that makes conversational fact-extraction ethically shippable at all. **It should ship in the same release as the first extractor, never after.**

---

## 12 · Temporal / life-event model

**Rule: personal context is effective-dated and affects future frames only. Historical frames remain interpretable in their own period.**

```
frames:   F1 ────── F2 ────── F3 ────── F4 ────── F5
context:  [ residence.country = SA ][ residence.country = KW ]
                                   ↑ effectiveFrom
```

- F1–F2 remain **Riyadh-period frames** and must render as such. A relocation does not rewrite them.
- Compilation resolves context **as-of the frame's compile time**, never "current".
- Frames record the `ContextAssumption[]` they used, so an old frame can explain itself years later even if the fact has since been edited or deleted.
- A confirmed `LifeEvent` is a **compilation trigger** (F-1 §6, class `USER_CORRECTION`) — the frame is recompiled *forward*, not retroactively.
- **Temporary vs permanent** is a distinct fact, not a guess: travel is `obligation.upcoming` with an end date; relocation is `residence.*` with an open `effectiveFrom`. The disambiguating question is asked; it is never inferred from merchant geography.

---

## 13 · LLM-versus-platform responsibility matrix

| Capability | Owner | Note |
|---|---|---|
| Conversational interpretation | **LLM** | |
| Extracting *candidate* facts | **LLM** | output is `CANDIDATE`/`HYPOTHESIS` only, against the closed key vocabulary |
| Phrasing a clarifying question | **LLM** | platform decides *whether* to ask |
| Deciding whether to ask | **Platform** | based on materiality of the missing input |
| Entity resolution ("my Chase card") | **Platform** | deterministic against frame entities |
| Selecting frame sections | **Platform** | context-priority planner |
| Explaining a deterministic conclusion | **LLM** | may not alter the number |
| Generating prose | **LLM** | validator-gated, references a sealed frame |
| Canonical financial calculation | **Platform** | |
| Durable fact truth | **Platform** | |
| Confidence assignment | **Platform** | evidence-derived |
| Materiality thresholds | **Platform** | |
| Policy / eligibility conclusions | **Platform** | |
| Changing user context | **Platform** | only on explicit confirmation |
| Deciding a sensitive trait is relevant | **Neither** | the vocabulary has no such key |

**One-line boundary:** the model may *propose* and *phrase*; the platform *decides*, *stores*, and *computes*.

---

## 14 · v2.6 scope

**Ships (V26-F2a — no personal data):**
1. `AssessmentInteraction` contract + the four rules in §7.
2. `EmphasisPolicy` + intent-invariance guard (§8).
3. `Constraint` with `MIN_RUNWAY_MONTHS` default — the single seam for later personal override.

**Ships (V26-F2b — minimal personal foundation):**
4. `StatedFact` + `LifeEvent` contracts with the closed key vocabulary (§5).
5. Confirmation policy (§6) as a pure decision function, testable without a database.
6. Effective-dated `residence.country` — the one key with a proven use case (currency/cost framing).
7. Personal Context Ledger **design** (surface spec, not implementation).
8. `ContextAssumption[]` added to the F-1 frame contract, so frames record what they assumed.

**Explicitly deferred to v2.7+:** conversational fact extraction (even in shadow), household/dependents, income structure, risk/liquidity preference keys beyond the runway floor, `ObservedPattern` persistence, peer benchmarking (declined outright), onboarding flow.

### Challenge to the expected foundation

The brief expects *"feature-gated conversation fact extraction in shadow mode"* in v2.6. **I recommend cutting it**, on repository evidence:

- There is **no Personal Context Ledger** and no settings surface for personal facts. Shipping an extractor before the user can see and delete what it captured inverts the consent order, even in shadow — shadow extraction still *stores*.
- There is **no onboarding**, so the cheap, high-trust path (just ask, in a form) is entirely unbuilt. Extraction from chat is the *most* expensive and *least* trustworthy intake path, and it would be the first one built.
- Nothing personal reaches the AI today (§2.2), so there is **no measurement baseline** to prove an extracted fact improves any output.

Build the ledger and one settings-sourced key first. Extraction becomes cheap and defensible once the user can see the result.

---

## 15 · v2.7+ scope

Onboarding flow (structured, skippable, benefit-named); conversational extraction behind the ledger; `ObservedPattern` persistence with frame-linked evidence; household composition (joins F-1's `HouseholdFrame` composer); income structure and stability; full preference set; life-event timeline as a user-facing narrative; longitudinal L4 features (trajectory, seasonality) once ≥12 months of frames exist. Peer benchmarking: not scheduled.

---

## 16 · Ordered implementation work packages

| # | Package | Objective | Depends | Tests | Gate | Rollback |
|---|---|---|---|---|---|---|
| **P-1** | Assessment interaction contract | §7 types + 4 rules, pure over `FinancialAssessment` | F-1 WP-1 | rule unit tests; suppression never deletes a claim | none (pure) | delete module |
| **P-2** | Emphasis policy | §8 + intent-invariance guard | P-1 | **claim values invariant across intents** | none | delete |
| **P-3** | Brief/chat consume policy | headline chosen by policy, not by surface | P-1,P-2, F-1 WP-2 | golden outputs | flag | flag off |
| **P-4** | Personal contracts | `StatedFact`/`LifeEvent` types + closed vocabulary + confirmation decision fn | — | vocabulary excludes protected traits; confirmation state machine | none (types) | delete |
| **P-5** | Ledger design | surface spec + copy | P-4 | — | design review | — |
| **P-6** | `residence.country` end-to-end | settings field → fact → currency/cost framing | P-4,P-5 | effective-dating; L0 unaffected | flag | flag off |
| **P-7** | Frame records assumptions | `ContextAssumption[]` in frame | P-6, F-1 WP-5 | old frames explain themselves | — | — |
| **P-8** | Deletion & export | purge cascade, export inclusion, dangling-reference rendering | P-6 | deletion propagates; old frames degrade honestly | — | — |

P-1→P-3 deliver three of the four motivating examples and touch **no personal data**.

---

## 17 · Product decisions requiring founder input

**D1 (inherited, still blocking).** Which liquidity semantics is canonical — coverage-months or percent-of-net-worth? This blocks F-1 WP-2 *and* determines whether example 2 is already solved. **Recommendation: coverage-months.**

**D2 — What is the default minimum runway floor?** `MIN_RUNWAY_MONTHS` gates the payoff-vs-runway rule. 3 months? 6? This number will appear in real advice. **Recommendation: 6 by default, overridable only by a confirmed preference.**

**D3 — Is conversational fact extraction in v2.6 at all?** I recommend **no** (§14). Requires a founder decision because it contradicts the stated expectation.

**D4 — Is peer benchmarking on the roadmap?** I recommend **declining outright**, not deferring (§10). A "later" leaves it in scope documents for years.

**D5 — Protected traits: exclusion or managed consent?** I recommend **hard exclusion via closed vocabulary**. Confirm, because it forecloses future product options.

**D6 — Does personal context ever cross Space boundaries?** A user's residence is a property of the *person*; a Space may be shared with a partner who should not necessarily see it. Recommendation: facts default `PRIVATE`, promotion to `SPACE` is explicit and per-fact.

**D7 — Retention of rejected candidates.** Storing "user was asked about relocation and said no" prevents nagging but is itself a record of a question asked. Recommendation: retain the *rejection*, never the *asserted value*.

---

## 18 · Exact first implementation ticket

> **V26-F2a-1 · Assessment interaction + emphasis policy (no personal data)**
>
> Add the deterministic cross-domain reasoning layer that decides which true things lead. **No Prisma model, no migration, no personal context, no LLM involvement.**
>
> **1. `lib/ai/policy/` (new)**
> - `types.ts` — `AssessmentInteraction`, `SuppressionReason`, `Constraint`, `EmphasisPolicy`, `HeadlineEligibility` per §7–§8.
> - `interactions.ts` — the four rules, each a pure predicate + effect over `FinancialAssessment`, ordered by `precedence`:
>   `RUNWAY_SUPPRESSES_LIQUID_SHARE`, `HIGH_APR_SURVIVES_SOLVENCY`, `PAYOFF_BOUNDED_BY_RUNWAY`, `ILLIQUID_WEALTH_IS_NOT_RESILIENCE`.
> - `emphasis.ts` — `selectEmphasis(assessment, intent): EmphasisPolicy`. Reorders only.
> - `MIN_RUNWAY_MONTHS` is a named default constant with **D2's value**. If D2 is unresolved, stop and ask.
>
> **2. Guards — `lib/ai/policy/policy-authority.test.ts`**
> - **Intent invariance:** for a fixed `FinancialAssessment`, the set of claims and every claim *value* is identical across all `intent` values; only `lead`/`demoted` ordering differs. This is the core anti-contradiction proof.
> - **Suppression is not deletion:** a suppressed claim remains present and readable, with a `SuppressionReason`.
> - **Purity:** the policy module imports nothing from `@prisma/client`, `lib/db`, or any personal-context module. A source-scan assertion, so the boundary cannot erode.
> - **Worked fixtures:** `$2M/$40k/low burn` ⇒ liquid share suppressed as a safety headline, still present as composition. `$1M/$40k/$100k @22%` ⇒ debt elevated **and** payoff constrained by the runway floor.
>
> **3. No surface changes.** This ticket lands the policy and its proof only. Consumption is P-3, behind a flag, after F-1 WP-2.
>
> **Constraints:** no migration; no `StatedFact`; no schema; do not modify `computeAssessment`; do not touch the Brief or chat routes in this ticket.
>
> **Done when:** suite green with the new guards, `tsc` clean, lint clean, and the two worked fixtures pass.

---

## Appendix · Verification index

| Claim | Evidence |
|---|---|
| No personal field reaches the AI | `lib/ai/context-builder.ts` (no user select) · `lib/ai/prompts/system-prompt.ts` (no personal refs) · `lib/ai/types.ts:1052` |
| DOB decrypted only for export | `lib/export/assemble.ts:87`; written at `register/route.ts:179`, `user/profile/route.ts:97` |
| `employmentStatus`/`useCase` consumed by settings/admin/export only | `lib/settings/loaders.ts:91-92` · `app/admin/users/page.tsx:27` · `lib/export/assemble.ts:283` |
| No geography field exists | `prisma/schema.prisma` — grep `country\|residence\|region\|locale\|city` returns 0 |
| No onboarding flow exists | no artifacts under `app/`, `components/`, `lib/` |
| `CreditScore` is the effective-dated precedent | `schema.prisma` — `score`, `source`, `recordedAt` |
| `reportingCurrency` seed-vs-authority precedent | `schema.prisma:416` (User, copy-once) vs `:504` (Space, authoritative) |
| Goals are the only personal channel to AI | `lib/ai/assemblers/goals.ts:197` |
| Assessment already uses coverage-months | `lib/ai/intelligence/annotations/engine.ts:291-303` |
| Brief's competing rule | `app/api/brief/route.ts:317` |
| `AiAgent` has no memory field | `schema.prisma` — `name`, `agentScope`, `lastActiveAt` only |
