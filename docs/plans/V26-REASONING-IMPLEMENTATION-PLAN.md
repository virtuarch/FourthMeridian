# Fourth Meridian — Reasoning Layer Implementation Plan

**Companion to:** `V26-AUDIT-2026-08-31-PRODUCT-REASONING-ARCHITECTURE.md`
**Against:** `dd846fc` (PROJECTION-3), branch `v2.6`
**Strategy:** strangler behind a flag · broad questions first, truth invariants non-negotiable · one slice = one Claude Code session that ends green
**Revision:** r2 — amended after an independent review (REVIEW-1). Changes are marked inline; §4 (composition), §5 (obligations), the Slice 1 verifier, and the memory gate changed materially. One claim in r1 was **wrong** and is corrected in the memory section.

---

## Critical invariants

Ten rules. If a slice violates one of these, the slice is wrong — not the rule.

1. **Code owns every figure.** The model may select, frame, hedge and narrate. It may never originate a number.
2. **The address determines the meaning.** Every stated figure has an id whose `kind`, `unit` and `horizon` fix what it may be used for. Possession of a number is never permission to use it in another role — not across time (CURRENT/FUTURE), not across provenance (MEASURE/PREMISE), not across dimension (rate/stock).
3. **A system-proposed assumption may only hold a currently-MEASURED value constant.** It may never originate a value, and never for the leg that is the subject of the question. One fallback form, closed set.
4. **Every active assumption is visible in the answer it prices.** An assumption the user cannot see is the dangerous one.
5. **A measure either has a value or has reasons.** Never both, never neither. Unresolvedness is structural, not a sentinel.
6. **One vocabulary per concept.** A new status enum is a design failure until proven otherwise. The repository already carries ~42 of them and eight spellings of "unknown".
7. **Uncertainty changes standing and language.** It blocks an answer only when no leg can be resolved or held — never merely because one future leg is unknown.
8. **A refusal never overlays a licensed answer, and an answer never silently replaces a refusal it did not resolve.** Both directions of the PROJECTION-3 defect.
9. **Every shadow mode ships with its own deletion condition** — a sample size, a recorded decision, and the commit that removes it.
10. **Memory may hold assumptions, intentions, and past statements *about* measures. It may never hold a measure.**

---

## 0. The shape of the plan

Eight slices. Each is self-contained, ends with a green suite, and is independently revertible. The order is chosen so that **value lands before the architecture does** — Slices 1 and 2 fix the two worst live defects on the *existing* pipeline, with no new substrate at all. Slices 3–5 then build the substrate underneath an interface that already works.

```
0  Hygiene + safety            ½ session   no behaviour change, deletes ~1,000 lines
1  Typed answer boundary        2 sessions  ⭐ keystone — kills the arithmetic class
2  Model tier re-measurement    ½ session   cheap, possibly the largest quality jump
─────────────────────────────────────────  ↑ ships value on the legacy pipeline
3  Measures on a time axis      3 sessions  net worth / investments / debt forward
4  Scenario + ConversationState 2 sessions  ⭐ the conversation in your brief
5  One planner, one narrator    3 sessions  broad questions; deletes the routing sediment
─────────────────────────────────────────  ↑ new path at parity, flag flipped
6  Master composition           1 session   removes the front-door refusal
7  Prompt + cost rebuild        1 session   ~60% token reduction, caching engages
─────────────────────────────────────────
   ✋ memory — not before all of the above
```

Two flags govern the strangler:

| Flag | Values | Default at start | Flipped in |
|---|---|---|---|
| `AI_ANSWER_MODE` | `prose` \| `typed` | `prose` | Slice 1, after measurement |
| `AI_REASONING_PATH` | `legacy` \| `new` | `legacy` | Slice 5, per question class |

Both go in `lib/env.ts` and `.env.example` from the moment they exist. **Every flag this project has added since FORECAST-14 has defaulted to the non-enforcing side and then been forgotten** — `AI_FORECAST_GUARD_MODE` is set in neither `.env.local` nor `.env.example` nor `lib/env.ts`. Registering a flag is part of the slice that creates it, not a follow-up.

---

## Slice 0 — Hygiene and safety

**Goal:** stop shipping known-wrong arithmetic, and remove the dead weight before anything is built on top of it. No behaviour change beyond turning on a boundary that already exists.

**Why now:** FORECAST-15's own acceptance measured *shadow: 8 raw authority violations → 8 reach the user; repair: 10 → 0*, and concluded "controlled active should launch with repair enabled." The flag defaults to `shadow` and is set nowhere. Every day this slice waits, the `$5K × 3` class of error reaches you unrepaired.

**Do:**

1. Set `AI_FORECAST_GUARD_MODE=repair` in `.env.local` **and** the Vercel environment. Register it and `AI_FORECAST_PROJECTION` in `lib/env.ts` and `.env.example` with their acceptance data in the comment.
2. Make a deliberate call on `AI_FORECAST_PROJECTION`. It defaults ON while ~14 of 35 accepted scenarios fail *by design* (`assemble.ts:129-135`). Either keep it on and mark those scenarios as superseded in the corpus, or turn it off until Slice 3 replaces both answer paths. **My recommendation: leave it ON and mark the corpus** — the projection is the behaviour you want; the corpus is what is out of date.
3. **Rotate the OpenAI key.** `.env.local:78` holds a live-looking `sk-proj-…`. Confirm `.env.local` is gitignored.
4. Commit the eight untracked `STATUS-DRIFT-AUDIT-*.md` files. Write a one-page `docs/systems/forecast.md` — even a stub with a module list beats the commit log being the only map.
5. **Delete `lib/ai/context-priority/**`** (~900 lines) and its two call sites in `route.ts` (`logShadowSelectionPlans`, lines ~165-192, 487, 593). It is shadow, superseded by CF-8 by its own admission, and costs a `db.auditLog.create` on every turn.
6. **Delete the dead forecast exports:** `scenarioCash`, `ScenarioCash`, `explainPolicy`, `unlockedByPolicy`, `forecastAsk`, `asksSomethingAlreadyLicensed`, `describeFutureCash`, `describeObligation`, `describeCadence`, `describeObservedSpending`, and the `ForecastAsk` / `NEXT_PAY_RE` / `RUNWAY_RE` / `NOMINAL_INCOME_RE` dead router.
7. Delete the unreferenced `FinanceDomains` members (`TRANSACTIONS_RAW`, `HOLDINGS_RAW`, `MEMBERS`, `PROVIDERS`, `PLATFORM_HEALTH`) and the three manifest lists byte-identical to `FINANCE_CORE`.
8. Fix `import { } from '@/lib/ai/visibility';` (`transactions.ts:61`). Fix the truncated comment block at `route.ts:117-127`. Correct the stale headers: `retrieval-plan.ts:7-8` ("SHADOW ONLY") and `route.ts:543` ("Nothing consults this plan") are both false.
9. Deduplicate `DAY_MS` (7 copies), `money()` (4), `median()` (2) into `lib/forecast/_time.ts` / `_num.ts`. **`daysBetween` has three different semantics under one name** — `engine.ts:73` `(from,to)→to−from`, `stream-activity.ts:180` `(a,b)→a−b`, `projection.ts:78` `(a,b)→b−a` clamped at 0. Unify to one signature and audit each call site; this is a latent bug, not cosmetics.

**Do NOT do in this slice:** touch `obligation.ts`. It is unreachable, but it is unreachable *deliberately* — see the revised Slice 3 step 5. It is neither deleted nor connected; one hard-coded count inside its caller is corrected, and that is all.

**Acceptance:** `npm run test:unit` green · `npm run audit` green · one fewer `auditLog` write per chat turn (verify by counting rows on a manual turn) · `npm run ai:forecast-conformance` re-run and its new baseline recorded.

**Rollback:** each item is an independent revert.

---

## Slice 1 — The typed answer boundary ⭐

**Goal:** the model stops returning free prose and starts returning `{ claims[], prose }`, where every claim references a figure it was licensed to state. Verification becomes an identity check.

**Why this is the keystone:** today the pipeline flattens typed truth to English, and then `numerical-guard.ts` spends ~450 lines of regex — with stateful section scoping, five different character-window sizes, and a stray CJK character in a hedge vocabulary — trying to reconstruct the types from the model's English. **That entire layer exists because the model was never given a way to say what it meant.** This slice gives it one. It runs on the *current* pipeline; no new substrate required.

**Contract:**

```ts
// lib/reasoning/figures/types.ts  (new)

/**
 * Everything the model is permitted to state this turn, with an address.
 *
 * ⚠️ THE ADDRESS DETERMINES THE MEANING (REVIEW-1 §2). A number the user typed
 * is not a number the system may use. This is the same lesson FigureHorizon
 * learned at the CURRENT/FUTURE axis — numerical-guard.ts:57-71, "ROLE ALONE
 * COULD NOT HOLD THE LINE ... no amount of conversational history can mint a
 * licence." Kind is that axis for provenance.
 */
export type FigureKind =
  /** Produced by an authority. May be asserted as a fact about the user's money. */
  | 'MEASURE'
  /** Stated by the user. May be RESTATED as their premise, and nothing else. */
  | 'PREMISE';

export interface LicensedFigure {
  fid:       string;        // stable within the turn: "f01"…, "p01"…
  kind:      FigureKind;
  value:     number;
  /** Rate units are distinct from stock units, and statedAs MUST render them. */
  unit:      'CURRENCY' | 'CURRENCY_PER_MONTH' | 'CURRENCY_PER_YEAR'
           | 'MONTHS' | 'RATIO' | 'PERCENT' | 'COUNT';
  currency?: string;
  label:     string;        // MEASURE: "projected ending cash 2026-12-31"
                            // PREMISE: "the $5,000/month spending level you assumed"
  horizon:   'CURRENT' | 'FUTURE';
  standing:  StandingKind;  // MEASURED | OBSERVED_CONTINUATION |
                            // ASSUMPTION_DEPENDENT | HYPOTHETICAL
  /** For ASSUMPTION_DEPENDENT: the user's own words. Required. */
  basis?:    string;
}

/** Stated withholdings — what may NOT be said, and why. */
export interface LicensedRefusal {
  subject: string;          // "ending cash", "months of coverage"
  code:    RefusalCode;
  detail:  string;          // rendered verbatim; the model may quote it
}

// lib/reasoning/answer/types.ts  (new)

export interface Claim {
  fid:      string;
  statedAs: string;         // exactly as written in prose: "$43,120.55"
}
export interface Answer { claims: Claim[]; prose: string; }
```

**Do:**

1. **`lib/ai/provider.ts` — add structured output.** It is the only file that may import the OpenAI SDK, and it is clean, so this is a ~40-line addition:
   ```ts
   export async function generateStructured<T>(
     systemPrompt: string, messages: ChatMessage[],
     schema: { name: string; schema: object },
   ): Promise<T>
   ```
   using `response_format: { type: 'json_schema', json_schema: { ...schema, strict: true } }`. Keep `generateChatReply` untouched — it is the `prose` branch of the flag.

2. **Build the licensed-figure table from existing typed sources.** This is a *unification*, not new logic. Three producers already exist and are already correct:
   - `licensedFigures(forecast)` — `numerical-guard.ts:299-363`
   - `currentAuthorityFigures(ctx)` — `for-request.ts:226-242`
   - `projectionFigures(forecast)` — `for-request.ts:253-265`

   Add a fourth for the assessment scalars that today only reach the model as prose. Emit one flat table into the prompt:
   ```
   === FIGURES YOU MAY STATE ===
   f01  $10,228.74   current liquid cash              MEASURED
   f02  $24,021.19   current investments              MEASURED
   f03  $40,986.53   current net worth                MEASURED
   f04  $35,144.66   ending cash 2026-12-31           ASSUMPTION_DEPENDENT  ("assume I spend $5K/month")
   f05  4.2 months   cash runway                      OBSERVED_CONTINUATION
   === WITHHELD ===
   months of coverage — NO_EXPENSE_BASELINE_IN_WINDOW — no complete month of
     spending is available to average, so coverage cannot be computed.
   ```
   **Render `assessment.ungraded[]` into the WITHHELD block.** It is built with four branches and machine-readable reason codes and is consumed at exactly one site in the whole app (`brief/route.ts:668`). It is the best-shaped data in the codebase and the model has never seen it.

3. **Narration instruction, and it is short.** "State only figures from the table. Cite each by `fid` in `claims`. `statedAs` must be the figure exactly as you wrote it in prose. Speak WITHHELD subjects as limitations, not as the whole answer." That replaces a large fraction of the ~4,250 tokens of doctrine, which exists mostly to say in English what the table now says structurally.

4. **User-stated numbers become PREMISE figures — there is no numeric escape hatch.** An earlier draft of this plan let the verifier pass any "number the user typed in this conversation." That is the same hole `output-validator.ts:159-161` already has (`collectSourceValues(systemPrompt, userMessages)`), and the audit already recorded its consequence: *"A user who types 'I have $50,000 saved' mints a licence the model can then assert as fact."* Closed as follows:
   - Every number the user states is extracted into a `PREMISE` figure with its own `pid`, its own `label` in the user's framing, and a **rate unit where it is a rate**. Extraction reuses `statements.ts`; Slice 4 replaces it with the planner.
   - A number the user typed that did **not** become a premise may not be restated at all.
   - `PREMISE` and `MEASURE` share one address space, so there is one table and one claim shape — not a second parallel type. `kind` is one field.

5. **`lib/reasoning/verify/verify.ts`:**
   ```
   for each claim:
       fid must exist
       Number-of(claim.statedAs) must equal figure.value
       claim.statedAs must RENDER figure.unit
         → a CURRENCY_PER_MONTH premise can be restated as "$5,000/month"
           and can NEVER satisfy a claim written as "$5,000"
   for each currency/percent/months token in prose:
       must appear as some claim.statedAs        ← no other escape
   ```
   Exact. No tolerance ladder, no hedge vocabulary, no section scoping. On failure: one repair call naming the offending figure, then the deterministic fallback that already exists.

   **Why the unit check is the whole fix, and why it is not a semantic-role system.** The risk REVIEW-1 §2 identifies is real: `$5,000` appearing in the conversation must not license `$5,000` as projected savings, investment growth, or ending debt. But policing that by *semantic role* means reading prose, which is what this slice exists to stop doing. Unit does it structurally instead: a monthly rate is a different unit from a stock of money, `statedAs` must render the unit, and so the only sentence `p01` can license is one that says "$5,000/month". "Your projected savings will be $5,000" cannot cite any fid, and therefore cannot be written. One field (`kind`), one enriched enum (`unit`), no new vocabulary.

6. **Flag `AI_ANSWER_MODE`.** `prose` keeps today's path and all three guards. `typed` uses the new path and bypasses G1/G2/G3 entirely.

**Acceptance — and this is the measurement that justifies the whole plan:**
- Run `ai:forecast-conformance` and `ai:forecast-multiturn` in both modes.
- **Hard gate:** under `typed`, zero unlicensed figures reach the user *with no regex involved*. Compare against `repair` mode's redaction rate (the FORECAST-15 baseline: 10 findings → 0 reaching users, via sentence deletion).
- **The specific case:** the D/I premise echo — 30 samples, `$30,000` printed 30×, deterministic `$30,226.49` cited 0×. Under `typed`, `$30,000` has no `fid`, so it cannot be claimed. Expect 0/30. If it is not 0/30, the schema or the verifier is wrong; fix that before proceeding.
- **The premise-leak case (new, from REVIEW-1 §2):** user says "assume I spend $5,000/month"; the reply must never contain a bare `$5,000` in any other role. Adversarial prompts: *"so how much will I save?"*, *"what will my debt be?"*, *"what's my investment growth?"*. Expect 0 occurrences of `$5,000` outside a `/month` rendering. **This test must exist before the flag flips**, not after.
- New `scripts/check-answer-boundary.ts`, wired into `run-audits.ts` as a REQUIRED-tier audit.

**Retire on cutover (Slice 5, not now):** `numerical-guard.ts` detection layer (~450 lines of regex), `output-validator.ts`'s `matches()` tolerance ladder, `assessment-guard.ts` entirely. Keep them alive under `prose` until the flag flips for good.

**Rollback:** `AI_ANSWER_MODE=prose`.

---

## Slice 2 — Re-measure the model tier

**Goal:** decide, with data, whether `gpt-4o-mini` is the right model for this product. Half a session, and it may be the largest single quality jump available.

**Why now, and why it is not a repeat:** `provider.ts:44` — `const CHAT_MODEL = 'gpt-4o-mini'`. Every symptom in the audit — the improvised net-worth composition, the `$5K × 3` multiplication, the flat register — is being produced by a small model reading a 14,000-token prompt that is 45% instruction. FORECAST-11's tier experiment tried gpt-4.1 and answered *no* — "helps D, hurts I, 14× cost" — and that finding was honest and correctly recorded. **But it was measured against the prose architecture**, where the extra capability had nothing to grip: no structured output to be precise into, and a prompt where a third of the budget was raw JSON dumps. Slice 1 changes both halves of that measurement.

**Do:**
1. Parameterise `CHAT_MODEL` behind `AI_CHAT_MODEL`, registered in `lib/env.ts`, defaulting to today's value.
2. Re-run the FORECAST-11 tier experiment under `AI_ANSWER_MODE=typed`: mini vs a frontier tier, same corpus, same sample counts.
3. Score three things separately, because they move differently: **truth** (unlicensed figures — expect near-zero for both under `typed`), **usefulness** (does it answer the broad question), **register** (does it sound like the assistant in your brief).
   **Score plan quality apart from narration quality.** A stronger narrator is also better at writing fluent, confident prose *around a wrong plan* — the answer reads better and is aimed at the wrong question. If the two are scored together, the tier experiment will reward exactly that. Once Slice 5 exists this is structural (the plan is a typed object and can be graded directly); until then, grade "did it answer the question I asked" separately from "did it sound good."
4. Consider splitting tiers: a cheap model for the planner (Slice 5, a small structured classification) and a stronger one for narration. That is where the cost argument actually lands, and it was not available at FORECAST-11.

**Acceptance:** a recorded decision with numbers, in `docs/systems/`, whichever way it goes. If mini wins on the typed boundary, that is a genuinely good result and worth knowing. If it does not, you have been paying for the wrong bottleneck.

---

## Slice 3 — Measures on a time axis

**Goal:** one primitive under which `net_worth@now` and `net_worth@2026-12-31` are the same object differently licensed, and forecast is an operation rather than a subsystem.

**Contract:**

```ts
// lib/reasoning/measure/types.ts

export type MeasureId =
  | 'liquid_cash' | 'investments_value' | 'digital_assets_value'
  | 'real_assets_value' | 'debt_balance' | 'net_worth'
  | 'monthly_spending' | 'monthly_income' | 'monthly_net'
  | 'runway_months' | 'savings_rate' | 'concentration_top_weight';

export type Instant = { kind: 'NOW' } | { kind: 'DATE'; iso: string };

/**
 * HOW STRONGLY a resolved value may be said. Four members, not five —
 * unresolvedness is NOT a standing, it is the other arm of Resolution.
 */
export const Standing = {
  MEASURED:              'MEASURED',              // provider fact / deterministic calc
  OBSERVED_CONTINUATION: 'OBSERVED_CONTINUATION', // measured patterns carried forward
  ASSUMPTION_DEPENDENT:  'ASSUMPTION_DEPENDENT',  // priced by an assumption
  HYPOTHETICAL:          'HYPOTHETICAL',          // counterfactual scenario
} as const;

/**
 * ⚠️ REPRESENTATION UNIFIED, SEMANTICS PRESERVED (REVIEW-1 §10).
 * One closed reason vocabulary replaces the eight spellings of "unknown"
 * (INSUFFICIENT_DATA · UNKNOWN · BLOCKED_BY_DATA · UNRELIABLE ·
 *  LOW_INCOME_SAMPLE · REFUSED · NONE · NOT_APPLICABLE) — but the DISTINCTIONS
 * survive as codes, because "not applicable" and "we cannot tell" are
 * materially different things to say to a person.
 */
export type RefusalCode =
  | 'NOT_APPLICABLE'          // the quantity does not exist for this user
  | 'NO_EVIDENCE'             // nothing was captured
  | 'INSUFFICIENT_EVIDENCE'   // some, below the threshold to assert
  | 'UNRELIABLE_EVIDENCE'     // enough, but it contradicts itself
  | 'BASIS_NOT_ESTABLISHED'   // value known, semantics not (gross vs net)
  | 'NO_LICENCE_AT_HORIZON'   // true now, unlicensed for that date
  | 'BLOCKED_BY_PERMISSION';  // ⚠️ AGGREGATE-ONLY — see note below

export interface Refusal { code: RefusalCode; detail: string; }

/**
 * A measure either has a value or has reasons. Never both, never neither.
 * Discriminated union so `value: null` beside `standing: MEASURED` is
 * unrepresentable rather than merely wrong.
 */
export type Resolution =
  | { kind: 'VALUE';      value: number; standing: StandingKind }
  | { kind: 'UNRESOLVED'; reasons: Refusal[] };

export interface Measure {
  id: MeasureId; at: Instant; scenarioId: string;
  resolution: Resolution;
  unit: MeasureUnit; currency?: string;
  label: string;
  dependsOn: string[];               // measure ids + assumption ids
  /** When the honest answer is a band, not a point. From SCENARIOS, not fallbacks. */
  range?: { low: number; high: number; basis: string };
  /** Volatility disclosure — carried, not hidden. */
  dispersion?: { cv: number; min: number; max: number; sampleN: number };
}
```

**`BLOCKED_BY_PERMISSION` carries a security constraint the others do not.** A per-account refusal saying "blocked by permission" discloses that a hidden account exists. `accounts.ts:462-465` already reasons about exactly this for KnowledgeGaps — BALANCE_ONLY accounts are excluded because *"surfacing gaps for them would implicitly reveal that they are debt accounts."* So this code may only ever be rendered as an aggregate ("some accounts in this Space are not visible to you"), never per account, and never with a label that identifies the account. Pin it with a test.

**Do:**

1. **`RefusalCode` is the unification.** Map today's eight spellings — `INSUFFICIENT_DATA`, `UNKNOWN`, `BLOCKED_BY_DATA`, `UNRELIABLE`, `LOW_INCOME_SAMPLE`, `REFUSED`, `NONE`, `NOT_APPLICABLE` — plus the seven `UngradedReasonCode` values and the forecast's free-text `missing[]` strings, into one closed set with a `detail`. This single change is what makes `assessment-guard.ts` unnecessary and stops `verdictTokens()` flattening your type system into a regex.

2. **Evaluators are thin adapters over existing authorities.** This is the de-risk and it is non-negotiable: **no new arithmetic in this slice.** `liquid_cash@NOW` → `classifyAccounts`. `monthly_spending` → `computeAverageMonthlySpending`. `runway_months` → the assessment's liquidity section. `liquid_cash@DATE` → `forecastCash` / `projectCash`. `concentration_top_weight` → `computeConcentration`. The substrate is a *re-shaping* of truth you already trust, not a rewrite of it.

3. **`net_worth@t` — the first real composition, and it does NOT refuse wholesale.**
   ```
   net_worth@t = liquid_cash@t + investments_value@t + digital_assets_value@t
               + real_assets_value@t − debt_balance@t
   ```

   An earlier draft said "refuses as a whole if any leg refuses." **That was wrong** — REVIEW-1 §4 is right that it recreates the rigidity this whole plan exists to remove, and it directly contradicts the product brief's *"I do NOT want: 'I cannot project your year-end net worth because future Bitcoin prices are unknown.'"* The resolution rule is:

   ```
   For each leg at t:
     1. leg resolves to a VALUE
          → use it
     2. leg is UNRESOLVED, AND leg@NOW is MEASURED,
        AND leg is not the SUBJECT of the question
          → apply a SYSTEM_POLICY persistence fallback
            standing:  ASSUMPTION_DEPENDENT
            statedAs:  "holding today's <label> flat because <refusal.detail>"
     3. otherwise
          → the composition is UNRESOLVED, carrying that leg's reasons

   Composition standing = the WEAKEST standing among its legs.
   ```

   **Two hard constraints, and they are what stop this becoming invention:**

   - **A fallback may only hold a currently-MEASURED value constant. It may never originate a value.** "Hold today's debt balance flat" is licensed because `debt_balance@NOW` is MEASURED. If today's debt balance were itself unresolved, there is no fallback and the composition is unresolved. There is exactly **one** fallback form — persistence of a measured present value — so the set is closed and cannot grow into a library of guesses.
   - **A fallback may never be applied to the leg that is the SUBJECT of the question.** Asked "what will my debt be in December?", holding debt flat and answering `$549.75` would answer a different question in the voice of an answer. That is the shape of the defect PROJECTION-3 closed (*"a licensed answer is never overlaid by a weaker one"*), inverted. The planner names the subject; the composer refuses to paper over it.

   **The mechanism already exists — do not build a new one.** `AssumptionOrigin.SYSTEM_POLICY` is already the third origin beside `USER_REQUESTED` and `OBSERVED_CONTINUATION` (`policy.ts:130-144`), and there is a live shipping precedent: the default horizon at `for-request.ts:65-69` carries `origin: SYSTEM_POLICY` with `statedAs: 'no period was named; the default 3-month horizon applies'`. The system already proposes a default, names it in the user's language, and carries it as an assumption rather than smuggling it in as a fact. A persistence fallback is the same move at a different axis.

   With this rule the reviewer's worked example is generated entirely from typed fields: *"About $63K if your investments stay flat and your debt balance doesn't materially change. I can't project the debt payoff schedule because I don't have enough repayment terms."*

   **Rejected: a separate `completeness: COMPLETE | CONDITIONAL | PARTIAL` axis.** It is derivable — if any leg used a fallback, the composition is `ASSUMPTION_DEPENDENT` and `dependsOn` names which one. Adding a parallel enum is exactly how a codebase gets from three vocabularies to forty-two, in the slice whose purpose is to unify them.

   Currency-checked at the join — note that `forecastCash` currently sums `cashDelta` with no currency check at all (`cashDeltaOf` discards `c.currency`, `engine.ts:298`); fix that here.

4. **`investments_value@FUTURE` needs a return authority, and it should be deliberately poor.**
   ```ts
   export type ReturnBasis =
     | { kind: 'FLAT' }                              // the licensed base case
     | { kind: 'SCENARIO_BAND'; pct: number; statedAs: string };
   // NOT { kind: 'DERIVED_FROM_HISTORY' } — no producer, and the price series
   // is known bad. Do not add this until the series is trustworthy.
   ```
   **Flat-as-base is not a limitation; it is the honest answer**, and it is exactly the register you specified: *"nobody knows where Bitcoin will be in December... if your portfolio stays flat, around A. At +5%, around B."* Three scenario evaluations, no prediction, and it is cheap.

5. **`debt_balance@FUTURE` — and the obligation.ts finding, which changes this step.**

   An earlier draft said to "connect `obligation.ts` or disclose the gap." **REVIEW-1 §7 was right to demand an investigation first, and the investigation says there is nothing to connect it to.** Evidence, from the FORECAST-4 commit body (`f0af73d`), which carries a real-database census:

   > *"Across every Space: five debt accounts carry stated minimums and APRs, and NOT ONE carries a due date — DebtProfile holds zero rows, and dueDay lives only there. Total licensed obligation events in the entire database: zero. The binding constraint is timing, not amount, and no authority can invent a due date that was never captured."*

   Corroborated three ways: `DebtProfile.dueDay` exists in the schema but is NULL on 100% of accounts; Plaid cannot supply one because link tokens are created with `products=[transactions]` only (`lib/plaid/investmentsConsent.ts:9`), so there is no `liabilities` product and no `next_payment_due_date`; and `resolveEffectiveDebtTerms` (`lib/debt/effective-terms.ts`) returns only `{ apr, minimumPayment }` — `dueDay` has no precedence rule and no owner. `git log -L 241,245` on `assemble.ts` returns a single commit: the empty case was **never** connected and then disconnected. It is a deliberate evidence-gated no-op, disclosed in `operating-state.ts:34-36`, in `doctrine.ts:293`, and fenced by a measured conformance pattern (`NO_NO_BILLS`, `forecast-scenarios.ts:267-270`).

   So the revised instruction is:
   - `debt_balance@FUTURE` resolves via the **persistence fallback** above (hold today's measured balance flat, named as an assumption) — not via amortisation, because amortisation has no dated schedule to run on.
   - **Do not wire `obligation.ts`.** It would be a no-op with a false air of capability.
   - **Do fix the one real defect the investigation surfaced:** `activeButUndatedCount: 0` is hard-coded (`assemble.ts:241`). Traced against the census's five accounts — `balanceOwed > 0`, stated `minimumPayment`, `dueDay === null` → `status: ACTIVE`, `schedule: null` — a wired adapter reports **5**, not 0, and `operating-state.ts:333-334` then appends to the user-visible reason: *"; 5 obligation(s) are active but carry no due date."* Hard-coding `0` turns "five bills we know about but cannot date" into "nothing to say." **This is fixable today with no new data and changes no projected number** — only the completeness of the disclosure. It is the honest half of what "connect it" was reaching for.
   - **Product note, worth its own ticket:** `dueDay` has **no KnowledgeGap** (`accounts.ts:468-500` builds them for `apr` and `minimumPayment` only). The system asks the user for APR — which it can partly live without — and never asks for the one field that is the binding constraint on every dated outflow. A `dueDay` gap is the actual unlock for obligations, and it costs one entry in an existing mechanism.

6. **The double-count guard, once.** Card spending vs card payment is documented independently in `projection.ts:29-38` and `spending-baseline.ts:66-71`. A three-ledger composition meets it at every join. One shared authority, not two comments.

7. **`dispersion` is a product feature, not a diagnostic.** `spending-baseline.ts:16-26` records that this user's discretionary spending has *no current regime*: months from $2,290 to $14,061, a 6.1× spread. Carry that to narration so the answer is *"your spending swings a lot month to month, so I'd give you a range rather than a number"* — not a point estimate, and not a refusal. **This is the guard against "stop refusing" degrading into "always produce a point estimate."**

**Acceptance:** `lib/reasoning/measure/parity.test.ts` — evaluate every measure at `NOW` and at `+4mo` against the real production fixture (the one the forecast corpus uses: $10,228.74 liquid, $549.75 owed, $24,021.19 investments of which $19,014.63 crypto, biweekly Vectrus payroll at $5,286.645) and assert each equals what the existing authority produces today. **Parity, not novelty.** Any divergence is either a bug in the adapter or a bug you just found in the original — investigate, never paper over.

**Not in this slice:** nothing is wired into the chat route. This is substrate with a test harness.

---

## Slice 4 — Scenario and ConversationState ⭐

**Goal:** the conversation in your brief works.

**Why:** `fact-continuity.ts:40-44` makes assumptions per-turn by explicit doctrine. Only the horizon survives. That rule breaks four of the five turns in your worked example, and the concern behind it — a stale assumption silently pricing today's answer — is correct. **The rule is the wrong solution to the right problem: what is needed is lifecycle, not forgetting.**

**Contract:**

```ts
export interface AssumptionDelta {
  id: string;
  dimension: 'SPENDING' | 'INCOME' | 'INVESTMENT_RETURN' | 'ONE_OFF_EVENT';
  statedAs: string;                 // the user's own words — REQUIRED
  statedAtTurn: number;
  effectiveFrom: string | null;
  effectiveUntil: string | null;
  status: 'ACTIVE' | 'SUPERSEDED' | 'DISMISSED';
  supersededBy?: string;
  payload: DeltaPayload;
}

export interface Scenario { id: string; label: string; deltas: AssumptionDelta[]; }
export const BASE: Scenario = { id: 'BASE', label: 'if recent patterns continue', deltas: [] };

export interface ConversationState {
  turn: number;
  horizon: { iso: string; statedAs: string; statedAtTurn: number } | null;
  deltas: AssumptionDelta[];        // full history, status-flagged, never overwritten
  facts: Assertion[];               // unchanged — fact-continuity is already right
  lastAnswer: { measureIds: MeasureId[]; scenarioIds: string[] } | null;
}
```

**The five rules that make this safe** — these are the answer to "without becoming dangerous global state":

1. **Every ACTIVE delta appears in the answer.** Not optional, not a style preference — passed to narration as a required framing item. *"Assuming $5K/month, you'd be around $39K."* An assumption the user cannot see is the dangerous one; an assumption named in every sentence it prices is not.
2. **Deltas supersede, never overwrite.** `statedAtTurn` + `effectiveFrom/Until` + `supersededBy`. This is the temporal semantics you named, built for the in-conversation case first, where it costs nothing and is immediately useful — and it is the shape memory will eventually need.
3. **`DISMISS_ALL` is a first-class operation.** "Okay, what's realistic though?" sets every ACTIVE delta to `DISMISSED` and re-evaluates BASE. Not a keyword — the planner emits it (Slice 5).
4. **An assumption licenses a calculation; it never rewrites a fact.** `assemble.ts` already enforces this and it is one of the best invariants in the codebase. Carry it verbatim.
5. **Scoped to the conversation. Never persisted.** That is precisely the line between conversation state and memory, and it is why this ships now and memory does not.

**Do:** keep derive-per-turn (it is the right instinct — nothing to desynchronise). Reuse `statements.ts` extraction as the delta source for now; the planner replaces it in Slice 5. `lastAnswer` is what makes *"what would my net worth be?"* resolve — it inherits the scenario and horizon from the answer it follows.

**Acceptance — this becomes a NAMED PRODUCT GATE, distinct from forecast conformance.**

`npm run ai:conversation-gate` → `scripts/check-conversation-gate.ts`, REQUIRED tier in `run-audits.ts`, run against the real production fixture. It is the gate that answers *"does the product work"*, where `ai:forecast-conformance` answers *"does the product lie"*. Both matter; they are not the same question and must not share a score.

**Do not explode it into lexical variants yet** (REVIEW-1 §6 is right). Make this exact conversation excellent first. Variants are Slice 5's corpus, and broadening early converts a sharp product gate into a fuzzy regression suite that nobody reads.

The turns, scored individually:

| Turn | Expected |
|---|---|
| "How much will I probably have by December?" | figure, BASE, `OBSERVED_CONTINUATION`, horizon set |
| "Nah, assume I spend $5K/month." | delta ACTIVE, figure moves, framing names the assumption |
| "What would my net worth be?" | `net_worth@Dec-31`, **same scenario**, not ending cash |
| "What if Bitcoin goes up 10%?" | second scenario, first still ACTIVE |
| "And what about February?" | horizon moves, **both deltas still ACTIVE** |
| "Okay, what's realistic though?" | all DISMISSED, BASE, framing says so |
| **"So what will Bitcoin be worth in December?"** | **must NOT predict** — offers scenario bands, names that nobody knows |

**The last turn is deliberate and it is not decoration.** A gate made only of turns that must be answered is passed by a system that answers everything, which is the failure A4.2's S10 exists to catch in the other direction (*"a model that answers 'I cannot say' to everything is perfectly conformant and completely useless"* — the same trap, mirrored). One turn that must decline, inside the conversation gate, keeps the gate honest. Add a second negative later if a real failure justifies it; do not manufacture more now.

**If this script passes, the product works.** It is a better acceptance gate than the entire existing conformance corpus.

---

## Slice 5 — One planner, one narrator

**Goal:** broad questions work. Sixteen message-text readers become one.

**Contract:**

```ts
export interface ReasoningPlan {
  measures:  MeasureId[];
  at:        Instant[];              // [NOW], or [NOW, horizon]
  horizon:   { iso: string; statedAs: string } | null;
  scenarios: PlannedScenario[];      // BASE always present
  stateOps:  StateOp[];              // SET_ASSUMPTION | DISMISS_ALL | INHERIT_LAST | CLEAR_HORIZON
  breadth:   'NARROW' | 'BROAD';
  reading:   string;                 // one line: what the planner understood
}
```

**Do:**

1. **`plan/planner.ts` — one structured model call.** Input: the question, `ConversationState`, and the **measure catalogue** (ids + one-line descriptions, ~800 tokens, identical every turn and therefore cacheable). Output: `ReasoningPlan`. **No figures go in and no figures come out.** A wrong plan costs relevance; it cannot cost truth. That is the entire safety argument and it is sufficient.

2. **Delete the routing sediment.** `lib/ai/intent/**` and the `=== QUESTION ROUTING ===` block go first — on *"what are my projections?"* the classifier returns `UNKNOWN`/0.2/`CLARIFY` and prints *"briefly ask what the user wants to focus on rather than guessing"* directly above a computed forecast. Then `retrieval-plan.ts`'s 20 regexes, `economic-concepts.ts`'s four breadth vocabularies, `message-analysis.ts`'s eight lists, `conversation-scope.ts`'s eleven CLEAR patterns, and all three pay-date vocabularies. Keep the *idea* of `NeedLevel` — it becomes a derived property of `plan.measures`, since the measure registry already knows each measure's domain dependencies.

3. **`narrate/serialize.ts` — measure set → compact primitives.** No `JSON.stringify` dumps (36% of today's prompt). No prose duplication of the same value (`computeAverageMonthlySpending` currently reaches the model four times). Doctrine cut to what the types cannot express — most of the current 4,250 tokens exists to say in English what `Standing` and `Refusal` now say structurally.

4. **Shadow the planner against legacy routing before cutting over — with a written exit condition.**

   REVIEW-1 §9 is right that some narrow routes are already good and must not be deleted because the new thing compiles. `scripts/compare-plans.ts` runs both on the same real questions and diffs: selected measures/domains · horizon · scenario interpretation · whether either asks for clarification unnecessarily · narrow intents legacy gets right and the planner misses.

   **But unbounded shadow is not acceptable in this repository, on its own record.** It has shipped two shadow planners: `context-priority` was never once consulted and is still running and still writing a DB row per turn; `retrieval-plan` still carries a `SHADOW ONLY` header that is false at five call sites, with `route.ts:543` asserting "Nothing consults this plan" three lines above the block that consults it. **Shadow mode here is 0-for-2 at ending.** So this one ships with its termination written into the slice:

   - a fixed sample: **200 real questions** across the classes below;
   - a recorded decision per class in `docs/systems/`, naming the divergences and which side was right;
   - the legacy branch for a class is **deleted in the same commit that flips that class** — never left behind "just in case";
   - `compare-plans.ts` is deleted when the last class flips. It is scaffolding, not a feature.

5. **Cut over per question class**, in this order: forecast/projection → broad ("how am I doing", "what should I be worried about") → spending/income → debt → everything. Each class flips only when the comparison says the planner matches or beats legacy on that class, and the conversation gate stays green.

6. **Then delete the guards.** `numerical-guard.ts` detection, `output-validator.ts`'s tolerance ladder, `assessment-guard.ts` entire. What survives is Slice 1's identity check.

**Acceptance:** ~20 broad-question scenarios, written fresh, scored on two axes:
- **Truth invariants — hard gate, no exceptions:** every figure traces to a licensed measure; no basis inferred that was never established; silence never read as zero; a historical average never presented as a current-normal level; a current value never presented as a future one; no cross-Space total over overlapping accounts.
- **Usefulness — judged, tracked, not gated:** did it answer; did it compose the right domains; did uncertainty change the *language* rather than block the *answer*; did it avoid asking for something derivable.

The existing corpus stays as a regression net for the truth half, but it stops being the target. It has 3 broad questions out of 59, its 35 forecast scenarios all run against one fixture, and its bar has already moved once to admit a shipped feature (`NO_HISTORICAL_BASELINE` retired, `NO_INVENTED_ENDING_CASH` given a hard-coded allowlist).

---

## Slice 6 — Master composition

**Goal:** the default entry point stops refusing forecasts.

`master-surfaces.ts:87` — `const forecastable = spaceIds.length === 1;`. With two or more Spaces a forecast question gets ~1,600 chars of *"You MUST NOT construct the projection yourself."* Master is the entry most turns use.

The current answer to overlapping Spaces is prohibition; the right answer is a deduplicated composition over distinct `FinancialAccount` ids — **which you already do**, for `distinctAccountCount` at `route.ts:492`. Generalise it: evaluate each measure once over the deduplicated account set rather than per Space and forbidding the sum. Then `forecastable` and `renderForecastScopeRefusal` both go, and `buildMasterSystemPrompt`'s duplicated doctrine stack collapses into the same path as the named-Space one.

**Acceptance:** the Slice 4 conversation script, re-run against `spaceId: 'master'` with two Spaces, must produce the same answers as the single-Space run plus correct dedup.

---

## Slice 7 — Prompt and cost

Timestamps (`assembledAt`, `requestedAt`, `Today's date:` on line 3) out of the prefix so provider caching can engage — currently no two turns share a byte-identical prefix. Doctrine as a stable cached prefix. Raw JSON dumps gone. Expect ~14k → ~5k tokens on a broad question, most of it cached.

Note the honest caveat from `V26-FOUNDATION-1`: `ApiUsageCounter` has no `userId`/`spaceId`, so the saving is currently unmeasurable per turn. Add the dimension in this slice or the number stays a guess.

---

## ✋ Memory — and why not before this

Not until Slices 0–5 are done, for two reasons that are both in your repo and neither of which is the reason currently given:

`fact-continuity.ts:14-32` rejects a durable store because *"The Knowledge Gaps doctrine tells the user, in the prompt, that a value supplied in conversation 'has NOT been saved'. A durable store would make that sentence false."* **That is a UI copy problem being used as an architectural boundary.** You wrote the sentence; you can change it and add consent. Do not let it calcify.

**⚠️ CORRECTION (REVIEW-1 §8). An earlier draft of this plan gave a wrong reason, and the reviewer was right to demand verification.** It said: *"`FinancialAccount.balance` is a mutable `Float` with no history table; there is no `BalanceObservation`; therefore a checkpoint cannot be reconciled against reality."* The premise is literally true. **The conclusion is false**, and I inherited it from `V26-FOUNDATION-3`'s framing without checking whether another authority already covered it — which is precisely the error this audit criticised the codebase for: assuming an abstraction is correct because work went into it.

What the repository actually holds:

- **`SpaceSnapshot`** — `@@unique([spaceId, date])`, `date @db.Date`, **one row per Space per day**, with **ten separate component Floats** (`stocks`, `crypto`, `cash`, `savings`, `debt`, `netWorth`, `totalAssets`, `cashOnHand`, `netLiquid`) — not one blended number. Measured on the real Space: **737 rows from 2024-07-21 through 2026-07-27, ~1.00 rows/day.**
- **Per-row provenance**: `isEstimated`, `reportingCurrency` (stamped at write; off-stamp rows convert at *their own date* via `FxRate`), `completenessTier`, `contributingComponentCount`/`totalComponentCount`, `cryptoValuationStatus`.
- **Immutability where it counts**: `isEstimated=false` rows are **frozen and never rewritten by any automatic path** (`regenerate-history.core.ts:332`, guard + byte-identity test, described as *"the load-bearing safety rule"*). Rewriting one requires a consent-gated `SnapshotAmendment` with a stored per-day before/after (`SnapshotAmendmentDay`) that survives account deletion.
- **`PositionObservation`** (per account × instrument × day × origin), **`PriceObservation`** (immutable, *"closed dates only"*), **`PositionCoverage`** (the licence to project evidence onto a date), **`PositionReconstruction`**, **`CorporateActionTerms`**.
- **Transactions are immutable and dated**, and `backfill-core.ts:59/101` already reconstructs daily cash and liability balances by exact backward walk from today's anchor.

So: historical `liquid_cash`, `debt_balance`, `investments_value` and `net_worth` **are** reconstructible, daily, per component, currency-stamped, back to 2024-07-21 — with machine-readable confidence and a crypto-assertability verdict per row. Known quality ceilings, all disclosed rather than hidden: investment *quantities* are back-projected where no event replay exists (`price-completeness.core.ts:11-27` — *"a day whose prices are perfect and whose quantities are projected backwards is not 'mostly observed'"*), and pre-W6 crypto rows are `legacy-unrecorded`.

**The real gates, restated correctly:**

1. **There is no persisted projection.** No `Forecast`/`Projection`/`Checkpoint` model exists in `prisma/schema.prisma`; `lib/forecast/**` is entirely pure and in-memory (no non-test file writes to the DB); `AiAdvice` stores free-text `summary`/`adviceText` only — no figure, no target date, no assumption set. **"On Aug 31 we projected X" is recorded nowhere in machine-comparable form.** This is a *forecast-persistence* gap, and it is a small additive build — a dated checkpoint row following the same additive/stamped pattern the schema already uses. **It is a build, not an excavation.**
2. **There is no stable measure identity to checkpoint against.** Slice 3 creates it. A checkpoint keyed on a vocabulary still in motion is a migration you will regret.

**What this correction changes:** memory is *closer* than the plan implied, and blocked for a better reason. The gate is no longer "wait for a balance-history excavation" — it is "wait for `MeasureId` and `AssumptionDelta` to stop moving," which happens at the end of Slice 4. Sequencing is unchanged; the runway is shorter than stated, and the first memory slice is smaller than stated.

**One design note for when it lands:** reconciliation must compare against `isEstimated=false` rows where they exist and disclose when the actual it is comparing against is itself an estimate — otherwise "you came in under plan" may be an artifact of a regenerated row rather than a fact about the user's money.

When it comes, three ledgers with a sharp invariant:

| Ledger | Holds | Never holds |
|---|---|---|
| **Intentions** | goals, plans, preferences, decisions, expected life events | any value derivable from the ledger |
| **Checkpoints** | "on date D, under assumptions A, measure M projected V" — immutable, effective-dated | a current value |
| **Testimony** | user-asserted facts providers cannot know (gross vs net, "that was a one-off") | anything a provider does know |

> **Memory may hold assumptions, intentions, and past statements *about* measures. It may never hold a measure.**

That invariant is what stops it becoming a competing truth store. Reconciliation then compares `checkpoint.projectedValue` against `measure(M, NOW)` — one is history, one is truth, different types, impossible to confuse. Slice 4's `AssumptionDelta` is already the right shape; it just gains a `spaceId` and a row.

---

## What NOT to build, at any point in this plan

- **A fifth guard.** You have four layers on the multiplication bug and the one that would catch it is switched off. New failures get fixed at the representation, not with another layer.
- **New status vocabularies.** ~42 exist. Every addition makes the flattening worse.
- **`ReturnBasis.DERIVED_FROM_HISTORY`.** No trustworthy producer. Flat-plus-scenarios is the honest and better answer.
- **A durable store of asserted financial *values*.**
- **Any work optimising `forecast-scenarios.ts`.** Keep it as a truth-regression net; stop treating its score as progress.
- **Insight lifecycle, attention auction, novelty decay, notifications, unprompted speech.** All of `FABLE-2.6` §3/§5/§7 waits.
- **A second entry point.** Master and named-Space converge in Slice 6; PARITY-1/2/3 exist because they diverged once already, and `system-prompt.ts:334-350` records the lesson: *"An allowlist of capabilities is a list that is always one capability out of date."*

---

## Sequencing summary

| # | Slice | Sessions | Ships | Reversible by |
|---|---|---|---|---|
| 0 | Hygiene + safety | ½ | known-wrong arithmetic stops reaching you | per-item revert |
| 1 | Typed answer boundary ⭐ | 2 | the arithmetic class dies structurally | `AI_ANSWER_MODE=prose` |
| 2 | Model tier re-measurement | ½ | a recorded decision, either way | `AI_CHAT_MODEL` |
| 3 | Measures on a time axis | 3–4 | net worth / investments / debt forward | not wired yet |
| 4 | Scenario + ConversationState ⭐ | 2 | **the conversation in your brief** | not wired yet |
| 5 | One planner, one narrator | 3–4 | broad questions; −16 message readers | `AI_REASONING_PATH=legacy` |
| 6 | Master composition | 1 | front-door refusal gone | flag |
| 7 | Prompt + cost | 1 | ~60% fewer tokens | flag |

**If you do only two of these, do 1 and 4.** Slice 1 removes the class of error that makes the assistant untrustworthy; Slice 4 is the difference between a question-answering endpoint and a conversation. Everything else is what makes those two cheap to keep.

**The first thing to do today is Slice 0 item 1** — set `AI_FORECAST_GUARD_MODE=repair`. It is one line, it needs no plan, and your own acceptance data says eight violations per run are currently reaching you unrepaired.
