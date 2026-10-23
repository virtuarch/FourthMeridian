# V26 Reasoning Layer — Post-Implementation Audit

**Audited:** `dd846fc` → `f94237e` (8 commits, 2026-09-01) · branch `v2.6`, unpushed
**Method:** direct source inspection at HEAD, six parallel deep reads, five load-bearing findings re-verified by hand
**Constraint:** the test suite cannot be executed from this session (`node_modules/@esbuild` is `darwin-arm64`; the audit shell is `linux-arm64`). **No reported test count in this document was independently re-run.** Every finding below is from reading code, and where a number is quoted it is traced to the artifact that records it.

---

## 1. Executive verdict

**The right architecture was built. It was shipped with three defects that make it unsafe to enable, one inverted invariant, and a strangler whose deletion half never ran.**

The load-bearing ideas are real and they work. `Resolution` is a genuine discriminated union that makes the codebase's most-repeated defect unrepresentable. The subject-exclusion on the persistence fallback is enforced on the first line of the function, wired from the planner, and pinned by two tests. The rate-versus-stock axis held against five separate attacks — `$5,000/month` is structurally incapable of satisfying a claim written as `$5,000`, which is precisely the hole r2 was written to close. `renderFigure` is a single rounding edge. No Prisma change, no persisted measure, no memory. And the Slice 7 commit reports a *disconfirmation* of the plan's own prediction rather than quietly conforming to it.

Against that:

- **Three severe defects** in the extractor and verifier, one of which converts `"I spend $5,000 monthly"` into a licensed figure of **$5,000,000,000**.
- **Invariant 6 was inverted by the slice whose purpose was to satisfy it.** 22 new vocabularies, ~61 members. The eight spellings of "unknown" became eleven.
- **Invariant 4 fails for system-proposed assumptions.** The disclosure string is computed and dropped on the floor by a no-op line whose comment claims the opposite.
- **Slices 1–7 deleted 77 lines total.** All 1,335 deletions came from Slice 0. Sixteen message-text readers became **twenty**.
- **Slice 6 did not ship its headline.** `master-surfaces.ts` is byte-identical to the base commit; the front door still refuses on Space count.
- **Three modules whose deletion condition is "Slice 5 deletes this" are still live and load-bearing.** Slice 5 shipped as `004a46e`.

None of this reaches users today — the entire 5,096-line layer is dark behind `AI_ANSWER_MODE`, which is unset. That is the single most important safety fact in this audit, and it is why the correct posture is patient rather than alarmed.

**Verdict: NO-GO on enabling the typed path. GO on exactly one thing — verifying `AI_FORECAST_GUARD_MODE=repair` is actually set in Vercel.**

---

## 2. Ten-invariant scorecard

| # | Invariant | Verdict | Evidence |
|---|---|---|---|
| 1 | Code owns every figure | **PASS** (typed path only) | `answer/schema.ts:13-54` strict schema; `verify/verify.ts:159-201` rejects unbacked tokens; one repair then deterministic fallback, `generate.ts:66-84`. The `"or any number the user typed"` hatch is explicitly closed (`verify.ts:26-32`). |
| 2 | The address determines the meaning | **PARTIAL** | The **unit** axis is genuinely structural — `statedAsRendersUnit` (`figures/types.ts:162-180`) is a total function and it survived five attacks. But `kind`, `horizon` and `role` are **carried and never checked**. `figures/types.ts:120-122` claims *"the verifier enforces identity, unit, horizon and kind"* — it is wrong on two of four. |
| 3 | Fallback holds a MEASURED value, never for the subject | **PASS on enforcement** | `evaluate.ts:459-472`: `if (c.subject === id) return null` is the first line; then `kind !== 'VALUE'` and `standing !== MEASURED` both return null. Exactly two call sites, pinned by `parity.test.ts:195-198`. One flaw: `MeasureContext.subject` is **optional**, and absence gates the fallback **on**, not off — the header at `:40-43` argues the reverse and is mistaken. |
| 4 | Every active assumption visible in the answer it prices | **FAIL** | See §12 D3. `persistenceFallback` builds `"holding today's ${label} flat because ${why}"` and **every call site discards it**. `evaluate.ts:439` is a no-op spread. User deltas do reach the prompt (`render.ts:57-61`) but as an instruction, not a checked obligation — PARTIAL at best on that half. |
| 5 | Value or reasons, never both, never neither | **PARTIAL** | `Resolution` is a real discriminated union (`measure/types.ts:64-66`) and the dangerous half — a null wearing a confident standing — is structurally closed. But `unresolved()` is variadic with no minimum, so `{kind:'UNRESOLVED', reasons: []}` compiles; `resolved(NaN, …)` compiles; and `range`/`dispersion` sit outside the union, so a refusal carrying a band is a legal `Measure`. Closed by test, not by type. |
| 6 | One vocabulary per concept | **FAIL** | 22 new vocabularies, ~61 members. `Standing` parallels `ConclusionStatus` with the adapter written **twice** (`evaluate.ts:294-301`, `table.ts:81-88`), both taking `unknown`, both defaulting `REFUSED → OBSERVED_CONTINUATION`. `DeltaDimension` parallels `AssumptionDimension` with no adapter at all — the bridge is an English round-trip. `FigureHorizon` and `Instant` are each declared **twice inside the new layer**. Unknown-spellings went 8 → 11. One genuine unification: `MeasureUnit = FigureUnitName`. |
| 7 | Uncertainty changes standing and language | **PASS** | `weakestStanding` (`evaluate.ts:177-181`); `composeNetWorth` refuses only when a leg is unresolved *and* has no fallback; `illustrativeBands` answers "what will Bitcoin be worth" with three evaluations plus an explicit `NO_EVIDENCE` withholding. |
| 8 | A refusal never overlays a licensed answer | **PASS** (typed) / **NOT TESTABLE** (default) | `cashAtDate` reads `fullCashPath` before `f.projection`, pinned structurally by `parity.test.ts:145-151`. The default path is unchanged from `dd846fc`. |
| 9 | Every shadow mode ships with its deletion condition | **PARTIAL** | `compare-plans.ts` is the model citizen — fixed sample, recorded per-class decision, written termination. Against it: three modules whose condition is met and unexecuted (§11), and the pre-existing CF-8 shadow `auditLog` write at `route.ts:130-152` still runs every turn with no condition at all. |
| 10 | Memory may never hold a measure | **PASS** | `git diff dd846fc f94237e -- prisma/` is **empty**. One `auditLog.create`, conditional on non-clean outcome, carrying counts and failure kinds. `ConversationState` is derived per turn and written nowhere. Three tests assert the absence of persistence. |

**Score: 4 PASS, 4 PARTIAL, 2 FAIL** — with the caveat that PASSes 1, 3, 7, 8 are properties of a path that does not execute.

---

## 3. Typed-boundary adversarial audit

**The claim "zero unlicensed figures is an architectural property" is FALSE as stated.** It is a property of one narrow token class.

The whole boundary rests on one regex, `verify/verify.ts:55-56`:

```js
/(?:\$|\bUSD\s*)-?\d[\d,]*(?:\.\d+)?\s*[kKmM]?(?:...)?|-?\d[\d,]*(?:\.\d+)?\s*(?:%|percent\b|months?\b)/g
```

A numeral is visible **only** if preceded by `$`/`USD` or followed by `%`/`percent`/`month(s)`. Executed against byte-verbatim ports of the real code, these all return `ok: true` with `claims: []`:

| Counterexample | Note |
|---|---|
| `You will have 30,000 left.` | bare numeral — invisible |
| `$ 30,000` | **one space after the dollar sign defeats it** |
| `thirty thousand` | words |
| `30k`, `3e4`, `30,000 dollars` | formats |
| `EUR 30,000` | **any non-USD currency disables the sweep wholesale** |
| `\| cash \| 30,000 \|` | markdown table without a currency symbol |
| `3 accounts`, `6 paychecks` | counts |
| `Your savings will roughly double.` | relational arithmetic, no numeral |

`6 paychecks` is not a benign exemption: `table.ts:233-243` adds a `COUNT` figure *specifically* because seven-versus-six is the arithmetic `H-pressure-biweekly` exists to defend. The figure was added to make 7 sayable; the sweep cannot tell 7 from 6.

**Wrong-fid: value equality, never identity.** `sameValue` compares only the number. Nothing compares `label` to the prose. Verified passing: a table with `f01 = 30000 "liquid cash TODAY"`, prose *"Your projected ending cash in December will be $30,000.00"*, claim `{fid:'f01'}` → `ok: true`. This is PARITY-3's original defect reachable through the new boundary. **The boundary licenses numbers, not statements.**

**Anti-vacuity is absent from the gated suite.** `verifyAnswer({claims: [], prose: 'You are on track and can comfortably afford it.'})` → `ok: true`. `claims` has no `minItems`; `provider.ts:129-132` asserts `strict:true` makes an empty claims array *"unrepresentable at the provider"* — **that is false**; `strict` forbids missing/extra properties, not empty arrays.

**What genuinely held.** The rate-versus-stock axis. Five attacks, no bypass: `CURRENCY_PER_MONTH` + `statedAs: "$5,000.00"` → `UNIT_NOT_RENDERED`; claiming `"$5,000.00 a month"` against prose reading `"$5,000.00 for the month"` → `UNCLAIMED_FIGURE`. The two-sided check (identity + sweep) closes that door properly, and it is the single most valuable thing this arc built.

**The honest restatement of what the boundary guarantees:**

> No `$`- or `USD`-prefixed numeral, percentage, or month-count can appear in a typed answer without matching the value and unit of some figure in this turn's table — modulo a sign flip, a self-selected rounding tolerance, and a magnitude parser that reads `monthly` as "million". Nothing constrains what that number is said to *mean*.

That is narrower than advertised and still worth having.

---

## 4. Conversation-state audit

**The gate passes lexically, not architecturally.** Every one of the seven turns is triggered by a hand-tuned regex in the *production* path, and the model-driven replacement is wired up and discarded.

`scenario/derive.ts:44-70` contains the whole trigger set, and its own comments name the gate:

- `ASSUME_RE` includes the alternation `nah,?\s*assume` — **the literal opening of turn 2**, redundant with `assume` already in the same union.
- `DISMISS_ALL_RE`'s first alternate is `what(?:'s| is) realistic` — **turn 6 verbatim**.
- `RETURN_RE` is `goes? up` + digits + `%` — turn 4's shape.
- `turn.ts:73-78` describes `selectMeasures` as *"Six patterns, chosen to cover the conversation this slice is graded on and nothing more."*
- `horizon.ts:125` carries `⚠️ FOUND BY THE V26-REASONING SLICE 4 CONVERSATION GATE` above a bare month-name list.

**`stateOps` has zero consumers.** The planner prompts for `DISMISS_ALL` (`planner.ts:80-83`), schemas it (`:140-146`), validates it (`:252-254`), returns it (`:261`) — and `resolveTurn` accepts only `{ measures, horizon }` (`turn.ts:220`). Repo-wide grep for `stateOps` outside its own declaration returns nothing. Same for `plan.scenarios`, `plan.at`, `PlannedScenario`, `BASE_PLANNED`.

**`lastAnswer` is never threaded in production.** `answer/for-request.ts:255-259` and `plan/for-request.ts:152-164` both omit it; `turn.ts:227` therefore always evaluates to `null`. The inheritance branch at `turn.ts:101-102` is dead code, and the planner's *"The previous answer was about: …"* line is never emitted. **The gate harness supplies the mechanism it is testing** (`check-conversation-gate.ts:450-454`). Turn 3 passes only because `/\bnet worth\b/` matches; turn 5 would return `LIQUID_CASH` in production, not the gate's asserted measure.

**Adversarial paraphrases, tested against the source regexes:**

| Input | Result |
|---|---|
| `Okay, what’s realistic though?` (typographic apostrophe) | **FAILS.** `what(?:'s\| is)` matches U+0027 only. One codepoint from an iOS autocorrect, and both deltas stay ACTIVE. |
| `actually let's say 5 grand a month` | **FAILS twice** — `let's say` isn't in `ASSUME_RE`, and `AMOUNT_RE` requires a literal `$`. Silently answered under BASE with no indication anything was ignored. |
| `forget that assumption` | Works. `Forget it.` / `drop the assumptions` / `scrap that` all fail. |
| `make it March instead` | Works — but survives by luck: the past-tense blocklist contains `made`, not `make`. |

The apostrophe case cascades: `turn.ts:171` suppresses illustrative bands while an `INVESTMENT_RETURN` delta is active, so a missed turn-6 dismissal silently removes turn 7's *"nobody can know"* withholding, and the system prices Bitcoin's December value off the user's own +10%.

**What is genuinely architectural here** and would survive replacing every regex: derive-per-turn statelessness (pinned by source scan at `lifecycle.test.ts:189-191`); the ACTIVE/SUPERSEDED/DISMISSED lifecycle including `dismissedAtTurn`; the independence of horizon inheritance from delta inheritance; BASE as an emergent zero-delta scenario; and the absence of `ReturnBasis.DERIVED_FROM_HISTORY`, which makes a modelled market return unrepresentable rather than merely discouraged.

The gate's assertions are also mostly on typed state rather than prose (`check-conversation-gate.ts:99-104`), which is the right design. It is calendar-bound (`:124` hardcodes `/^2026-12/`) and its promised lexical-variant corpus does not exist.

---

## 5. Planner / cutover audit

**The implementer's diagnosis is CORRECT. It is a vocabulary problem, not a planner problem — and it is one layer deeper than reported.**

`MeasureId` has 12 members, all Space-wide scalars at an instant (`measure/types.ts:32-45`). The planner's entire selectable catalogue is those 12 ids plus one description each (`planner.ts:32-49`). `MeasureId` **is** a closed enum in the JSON schema (`planner.ts:105`), so hallucination is impossible at the provider — which means the failure mode is never "invalid plan", it is always **a confident wrong-but-valid selection**.

Traced: *"what was my biggest purchase last month?"* → the planner returns `real_assets_value, debt_balance, net_worth` (recorded at `plan/for-request.ts:26-28`), all three resolve MEASURED, three correct-but-irrelevant balances get licensed, and **no refusal, no `UNRESOLVED`, no telemetry** is emitted. There is no path that says "I cannot express this."

**The separation of the two hypotheses is clean:** on `forecast` the planner picks the same measures as legacy 13/14, and on `debt` 5/5. Where the vocabulary covers the question, the planner finds the answer. That exonerates the planner.

**And there is a second wall behind the first.** Even a perfect selection could not be narrated: `buildFigureTable` has zero transaction sources, so `$487.32 at Whole Foods` has no `fid` and the verifier rejects it. Legacy can *reach* the row and cannot verify it; the new path can verify and cannot reach.

**Two corrections to the reported picture:**

- `FLIPPED_CLASSES = ['forecast','broad']` (`plan/for-request.ts:71`) is a **dead constant** — one grep hit, its own declaration. The runtime cutover is `const owned = isForecast || plan.breadth === 'BROAD'` (`:115`), which lets **the planner declare its own jurisdiction**. Any question the model labels BROAD is owned regardless of the recorded class decision.
- The `other` class's *"legacy blank 21"* is an instrument artifact. `COVERAGE` maps to `[]` in the harness's concept→measure table, so coverage questions score as legacy-blank on both sides. Legacy answers coverage correctly via the envelope; the comparison cannot see a non-measure answer.

**The measurement is not reproducible.** `compare-plans.ts` writes to `/tmp/compare-plans.json`; nothing is committed. The only surviving record is the prose table in `docs/systems/planner.md:33-39`.

**The exit condition is unreachable as written.** ~29% of the 112-question corpus is not measure-expressible. `compare-plans.ts` is deleted "when the last class flips"; the last class cannot flip under the current vocabulary. The diagnosis and the termination condition are mutually blocking.

---

## 6. The 15 MISSING failures — taxonomy

**Two corrections first.** The MISSING delta is **+17** (3 → 20), not +15; "15" is the *scenario* delta (31 → 16), and one scenario can fail on several checks. `check-forecast-conformance.ts` was modified **+14/−4**, not +100. The commit names only 7 of the 17; transcripts went to `/tmp` and **the per-scenario breakdown is not reproducible from the repo.**

The corpus holds **51 `required` blocks across 35 scenarios**, collapsing into six categories:

| # | Category | Blocks | Scenarios | Typed data exists? | Reaches model as |
|---|---|---|---|---|---|
| 1 | **Conditionality / scenario-not-prediction** | 15 | A,B,D,G,G1–G5,K,M,O,P1–P3 | **Yes** — `Standing` + `STANDING_NOTE` + the "NOTHING MEASURED THIS" line | Data — but the *duty* is doctrine |
| 2 | **Assumption / input disclosure** | 8 | A,B,D,G1–G5 | Partly — `framing[]`, `basis` | **Neither, in the measured run** |
| 3 | **Basis (gross vs net)** | 4 | A,B,E,Q6 | Yes — `AmountBasis`, `STATED_NOT_CASH` section, `BASIS_NOT_ESTABLISHED` | Mixed |
| 4 | **Withheld / limitation** | 3 | D,J,I | **Yes** — `FigureTable.withheld[]` | Data — the one fully typed category |
| 5 | **Negative-crossing** | 1 | F | **No** | Doctrine only |
| 6 | *Figure recall — not framing* | 20 | C,H,L,N,Q1–Q5,R2,S1–S5,… | Yes by construction | Data |

**Categories 1–5 = 31 framing checks over 20 scenarios.** Minimal failed 19 scenarios and missed 20 checks. The correspondence is close enough to corroborate the diagnosis independently.

**Three qualifications that change what the measurement means:**

1. **The typed framing channel was never enabled in either arm.** `check-forecast-conformance.ts:186-189` calls `buildTypedPromptSuffix({forecast, ctx, assessment, messages, scope})` — **no `measures`, no `framing`, no `turnWithheld`.** So `renderFigureTable(table, [])` took the empty path and the `=== ASSUMPTIONS IN FORCE ===` block **never rendered in either arm**. The experiment compared *doctrine against silence*, not *typed framing against doctrine*.
2. **Category 1 is already typed and still failed.** `Standing` reached the model as a column in both arms; dropping the doctrine still lost ~13 conditionality checks. **Serializing the data is demonstrably not sufficient** — the requirement must be enforced, not merely present.
3. **One named failure is a figure miss, not a framing miss.** *"must state the engine's ending cash"* is category 6: the figure was in the table and the model did not utter it. So the slogan is imprecise — it is a **one-directional** licensing boundary. It constrains what may be said and never what must be.

**Three separate places compute exactly the disclosure the framing categories need, and drop all three:** `persistenceFallback.statedAs` (§12 D3), `Measure.dispersion` (computed by `spendingDispersion` from the fixture's 6.1× spread, referenced only at its definition and one comment — **no serialization path at all**), and the full `framing[]` list, of which only `[0]` survives to `basis`.

---

## 7. Framing-boundary recommendation

**Yes — the same move works, and it is smaller than a `RequiredFramingItem` type.**

The boundary today is one-directional: *every figure written must be licensed*. The missing half is *every required disclosure must be discharged*. Both are checkable with machinery that already exists.

**Split by category, because two different mechanisms cover all five:**

**(a) Assumption disclosure — categories 2 and 3 (12 of 31 checks). Zero new types.**
An assumption is already a `PREMISE` figure with a `pid`. So the obligation is *"claim `p01`"* — expressible as one field on the table:

```ts
requiredClaims: readonly string[];   // fids that MUST appear in claims[]
```

The verifier already parses `claims[]`. This is one array, one loop, and it reuses the entire identity mechanism. The model still writes whatever sentence it likes; it simply cannot omit the premise.

**(b) Epistemic obligations — categories 1, 4, 5 (19 checks). One field each side.**

```ts
// on FigureTable
obligations: readonly { id: string; why: string }[];
// on Answer
covered: readonly string[];
```

Verifier: every obligation id appears in `covered`. Symmetric with `claims`/`fid` — the same move, one more field. No canned sentences, no prose parsing, no regex, no new status vocabulary. The model owns the words; code owns the *list of things that must be spoken*.

The honest limit: a model can declare `covered` without genuinely covering. That is the same trust boundary as `claims`, and it is acceptable for the same reason — declaring is a strong prior, it is sampleable, and it converts a silent omission into a detectable lie.

**Before building any of it: re-run the Slice 7 experiment with `framing`/`measures`/`turnWithheld` actually passed.** The current 16/35 measures a channel that was switched off. Designing the fix from it would be designing from an untested hypothesis.

---

## 8. Planner-vocabulary recommendation

**Do not add a new primitive family, and do not add `BIGGEST_PURCHASE` to `MeasureId`.** The repository already contains the axis, one layer down.

`retrieval-plan.ts:110-119` defines `EvidenceDepth = { ENVELOPE, AGGREGATE, DETAIL }`, documented at `:318-323` with the exact distinction the planner lacks:

> *"Superlatives and evidence asks — the questions an aggregate cannot answer. 'How much did I spend in 2025' is a total; 'what was my largest purchase in 2025' is a row."*

The legacy layer had already typed this and the planner's vocabulary threw it away.

And the data is already computed. `assemblers/transactions.ts` emits `largestExpense: {merchant, amount, date}` (line 1229-1236, currency-converted *before* selection), `merchants[]`, `byCategory[]`, and a bounded `drilldown`. `resolveDrilldown` (`message-analysis.ts:335-398`) already resolves `{category?, merchant?, startDate?, endDate?, limit?}` including a `largest|biggest|top|highest` pattern.

**The decisive precedent is inside the new layer already:** `concentration_top_weight` is a superlative over an entity set. It answers "which holding is largest" by reading a precomputed verdict and reducing it to **one licensed scalar whose label carries the identity**. `largestExpense` is the same shape, one domain over, already computed.

So the smallest change is:

1. **One field on `ReasoningPlan`** — `depth: 'ENVELOPE' | 'AGGREGATE' | 'DETAIL'` plus the selector shape `resolveDrilldown` already returns. This makes the planner a *replacement* for those twelve regexes rather than a subsystem beside them, which is the strangler's stated purpose.
2. **Two or three figures out of the existing payload** — `largestExpense.amount` as `CURRENCY` with label `` `largest expense — ${merchant}, ${date}` `` (labels already carry identity via `measureSubject`); `merchants[i].total` likewise; `envelope.transactions.span.count` as `COUNT`, a unit `FigureUnit` already has.
3. **Nothing new in `MeasureId`.** The closed-set argument survives intact.

**One line: the missing thing was never a type, it was an address.** A ranking is N labelled figures bounded by the `limit` the selector already parses — a loop, not a type. An existence claim (*"do you have my Amex?"*) is genuinely outside the figure model and belongs in `LicensedRefusal`, whose shape is `{subject, code, detail}` and already renders verbatim.

---

## 9. Model-topology recommendation

**Correct the premise first: the latency figures in the brief are reversed.** `docs/systems/model-tier.md:105` reads *"p50 **20.9 s** against mini's **3.9 s**"* — **20.9s is gpt-4.1; mini is 3.9s.** Mini is 5.4× *faster*. Any decision made on "mini is 5× slower" is being made backwards.

**Three further corrections:**

- **`11` vs `12` calls.** `reasoning-layer.md:151-154` records mini as `2 clean · 2 repaired · 3 fallback` = **12** calls; `model-tier.md` says 11. Two HEAD documents disagree about the same run. Cite neither until re-measured.
- **The 9.7× cost figure rests on an unrecorded run.** The gpt-4.1 side reconciles exactly (27 clean + 5 repaired + 3 fallback = 43 calls ✓). The mini-typed 35-scenario denominator exists in one document and nowhere else, and mini's forecast-corpus truth cell is `—`. **"Truth is a tie" is established on 7 cases, not 35.**
- **The tier split was recorded as a decision and never implemented.** `resolvePlannedTurn` does not pass `model`; `answerThisTurn` does not pass `model`. Both fall through to `CHAT_MODEL`. Setting `AI_CHAT_MODEL=gpt-4.1` buys the frontier tier **for the planner too** — exactly the spend and latency the split existed to avoid.

**The honest per-useful-answer numbers**, which the docs gesture at and never compute:

| | calls/answer | cost/answer | latency/answer |
|---|---|---|---|
| mini | 11/4 = 2.75 | $0.0047 | ~6.8 s |
| gpt-4.1 | 7/7 = 1.00 | $0.0223 | 20.9 s |
| multiple | — | **4.8×** | **3.1× slower** |

**Which stage benefits from intelligence? The evidence does not say, and cannot.** Every mini-vs-4.1 measurement predates the planner (both were taken against `2fe3c58`, Slice 1). `planner.md:4` is explicitly mini-only. The one datum offered as plan-quality evidence — the `I-stale-premise` case — comes from a run with no planner in it, and is narrator behaviour presented as planner behaviour.

**Recommendation: change nothing, and run the experiment that already exists.**

```
npm run ai:compare-plans -- --model=gpt-4o-mini
npm run ai:compare-plans -- --model=gpt-4.1
```

`compare-plans.ts:53` already accepts `--model=`. 224 planner calls at temperature 0, **under $0.50 total.** The decisive subset is the 21 questions in the two flipped classes: if both tiers select the same measures, the planner is proven tier-insensitive and cheap-planner/strong-narrator is justified by evidence rather than architecture. If they diverge, the split is wrong.

My prediction, stated in advance so it can be wrong: selection among 12 closed options with a well-written catalogue is an easy task, and the planner will prove tier-insensitive on the flipped classes. But the argument for the split is currently aesthetic, and a $0.50 experiment converts it to evidence.

---

## 10. Flag-by-flag deployment recommendation

| Flag | Unset ⇒ | Recommendation | Reasoning |
|---|---|---|---|
| `AI_FORECAST_GUARD_MODE` | `shadow` | **ENABLE — verify in Vercel today** | The only action item in this audit. Read via bare `process.env`; `vercel.json` has **no `env` block**; `.env.example` is a template Vercel never reads. Slice 0 is titled *"the enforcement that was already decided, actually switched on"* — what it switched on was local dev and the example file. Unset in production ⇒ the posture FORECAST-15 measured and rejected (8 violations, all 8 reaching users). |
| `AI_ANSWER_MODE` | `prose` | **DO NOT ENABLE** | Three blocker defects (§12 D1, D2, D4). This is the master switch; everything else is downstream of it. |
| `AI_REASONING_PATH` | `legacy` | **DO NOT ENABLE** | Dead under `prose` anyway. 3 of 5 classes unflipped; ownership is self-declared by the model at runtime, not by `FLIPPED_CLASSES`. |
| `AI_PROMPT_SHAPE` | `full` | **DO NOT ENABLE** | Its own measurement is invalid (§6). Re-measure with the framing channel on before touching it. |
| `AI_CHAT_MODEL` | `gpt-4o-mini` | **KEEP OLD DEFAULT** | The split is unimplemented; raising it would retier the planner too. Run the $0.50 experiment first. |
| `AI_FORECAST_PROJECTION` | **ON** | **KEEP — but re-baseline the corpus** | The only AI flag whose unset default is new behaviour. Deliberate and correct as a product decision; the ~21/35 vs 32/35 delta is a knowingly stale acceptance corpus nobody has rebased. Graduated by definition, with no removal plan. |
| `AI_ASSESSMENT_GUARD_MODE` | `shadow` | **ENABLE in production** (`repair`) | Already `repair` locally. A6 measured `off` 33/38 vs `repair` 38/38. Same omission risk as the forecast guard. |
| `AI_OUTPUT_VALIDATION_MODE` | `annotate` | **KEEP OLD DEFAULT** | Long-shipped KD-2 default; append-only, so a false positive costs a caveat. |

**Three structural flag problems worth one ticket:**

1. **No AI flag is validated or surfaced.** All eight are mirrored into `lib/env.ts`'s internal `_e` object, but **none has a getter on the exported `env`**, none appears in `getEnvReport()` or `validateEnv()`, and every resolver silently swallows unrecognised values — `AI_ANSWER_MODE=typo` is indistinguishable from unset. `QUANTITY_AUTHORITY_MODE` in the same file *does* get a warn row. The precedent exists and was not applied.
2. **Harness/production drift, uncaught.** `check-forecast-multiturn.ts:171` defaults `AI_FORECAST_GUARD_MODE` to **`repair`** where production defaults to `shadow` — the same class of drift the HF2e test exists to catch, in the opposite direction.
3. **`answerThisTurn` sits outside the route's `try` block** (`route.ts:595` vs `:607`). Harmless under `prose`; under `typed` it makes a provider call and a DB write, and a throw becomes an unhandled 500 instead of the 502/503 envelope. **Fix before enabling `typed` anywhere.**

---

## 11. Scar-tissue and simplification assessment

**This is architecture replacement with net growth, and the growth is real.**

```
Total:      +10,013 / −1,359   (82 files)
Slice 0:       +382 / −1,335   (code only; +1,854 was markdown)
Slices 1–7:  +7,777 /    −77
```

**Seven of eight commits deleted a combined 77 lines.** The strangler's deletion half never ran. `plan/for-request.ts:65-69` states *"the legacy branch for a class is DELETED IN THE SAME COMMIT that flips that class"*; Slice 5 flipped two classes and deleted 35 lines, none of them a routing branch.

**Message-text readers: 16 → 20.** One deleted (`context-priority`, and it was genuinely dead). Fourteen survive and are **live in the default path**. Five added, three of them regex-based — `derive.ts`, `selectMeasures`, `premise.ts`. The layer that exists to collapse sixteen readers shipped five more.

**Three deletion conditions met and unexecuted.** `derive.ts:21-31`, `turn.ts:6-11` and `premise.ts:39-45` each say some version of *"TEMPORARY — Slice 5 deletes this."* Slice 5 shipped as `004a46e`. All three are live and load-bearing: `deriveConversationState` is called unconditionally, `selectMeasures` is the fallback whenever the planner returns nothing, and `premiseFigures` is called on every table build. `compare-plans.ts:9-18` observes that *"shadow mode here is 0-for-2 at ending"* and then shipped three more. **The score is now 0-for-5.**

**Six compatibility adapters, zero exit conditions.** The consequential one is `effectiveQuestion` (`turn.ts:129-135`), which re-serialises typed `AssumptionDelta[]` into a synthetic English question and lets `statements.ts` re-parse it — because `assembleForecast` reads suppositions from `question` and nothing else. **The typed layer's entire reason for existing is that flattening types to English and re-parsing them is the defect, and its bridge to the forecast substrate does exactly that.** Its header defends the choice accurately; it remains a permanent adapter with no removal plan.

**Slice 6 did not ship.** `master-surfaces.ts` is byte-identical to `dd846fc`, and `const forecastable = spaceIds.length === 1;` is still at line 87. The dedupe is reachable only from the typed branch. The commit titled *"the front door stops refusing"* did not change the front door in the path that serves users.

**The real metric — teaching one new capability:**

| Task | Production files | Edit sites | Compiler-caught |
|---|---|---|---|
| A new measure | **4** | **7** | 3 of 7 |
| A new refusal reason | **1** | **1** | n/a |

The two silent failure sites for a new measure are the dangerous ones: `evaluate.ts:508`'s `default:` produces a plausible number with the wrong standing, and `selectMeasures` silently makes the measure unreachable. The refusal vocabulary is the design working as intended; the measure vocabulary leaks at exactly the four uncaught sites. And both numbers describe the path that is switched off — teaching the *shipping* system a new capability still means twenty readers.

**Tests that assert source text rather than behaviour:** roughly 15 of ~90 assertions. `parity.test.ts:384-386` asserts *that a comment exists* (`/THREE LEDGERS MEET HERE/`) — delete the comment, red suite; delete the double-count protection while keeping the comment, green suite. `:148-151` asserts statement order in a function body. `lifecycle.test.ts:191` enforces a style rule (`no let/var`) as a test. The behavioural core — A1–A9 parity against the real fixture, B1–B4 union integrity, D4/D6/D7 fallback constraints, E6 subject refusal — is genuinely good and is the strongest artifact the arc produced.

---

## 12. Critical defects

**D1 — `premise.ts:67` magnitude parser reads `monthly` as "million". SEVERITY: CRITICAL. BLOCKER.**
`MONEY_RE`'s `([kKmM])?` group has no `\b`. Verified by execution against the live regex:

```
"I spend $5,000 monthly."   → num 5,000  suffix "m"  → 5,000,000,000
"I pay $1,200 mortgage"     → num 1,200  suffix "m"  → 1,200,000,000
"I have $50 million"        → num 50     suffix "m"  → 50,000,000  (correct by accident)
```

`premiseFigures` is **ungated** — it scans every user turn's full text with no verb requirement. So `"I spend $5,000 monthly"` mints a licensed PREMISE of **$5 billion**, and because `after` is `"onthly."` the rate marker also misses, downgrading `CURRENCY_PER_MONTH` to `CURRENCY` — losing the one axis that actually holds. A million-fold corruption plus a unit downgrade, in one of the most common phrasings a user can type. The comment directly above the regex warns about precisely this class of error: *"THE MAGNITUDE SUFFIX IS PART OF THE NUMBER. Omitting it is a silent thousand-fold error, and it was found twice in one slice."* It was fixed in the wrong direction. Corollary: `PROSE_TOKEN_RE` carries the same greedy suffix, so correct model prose *"You spend $5,000 monthly"* tokenises as `$5,000 m` and **always** fails the sweep, inflating the fallback rate on good answers.

**D2 — `verify.ts:98` accepts a sign flip. SEVERITY: CRITICAL. BLOCKER.**
`return q(parsed) === q(f.value) || q(parsed) === q(Math.abs(f.value));`
A figure of `−4000` verifies against prose reading `"$4,000.00"`. Worse, it is *forced*: `renderFigure` emits `$-4,000.00`, and the natural `-$4,000.00` is rejected by the sweep — so the only renderings that verify are the malformed one and the sign-flipped one. **A projected overdraft reported as a positive balance is the worst output this product can produce.**

**D3 — Invariant 4 fails; `evaluate.ts:439` is a no-op whose comment claims otherwise. SEVERITY: HIGH. BLOCKER.**
```ts
      dependsOn,
      // The fallbacks are carried in `dependsOn` and named here so narration can
      // say them. An assumption the user cannot see is the dangerous one.
      ...(fallbacks.length > 0 ? { range: undefined } : {}),
```
`fallbacks` is write-only. `dependsOn` carries ids, not sentences, and is rendered nowhere. `debtAtDate:527` likewise takes `fb.value` and drops `fb.statedAs`. Compounding it, `table.ts:356` sets `basis: args.framing?.[0]` — so a figure resting on a **system** fallback is labelled with the **user's** first unrelated assumption, and `render.ts:59` prints it as `- the user said: "…"`. The one place the codebase's own stated principle is asserted in a comment and contradicted by the line beneath it.

**D4 — A PREMISE stock is assertable as a MEASURE. SEVERITY: HIGH. BLOCKER.**
`verifyAnswer` never reads `f.kind`. Verified: prose *"You have $50,000.00 saved."* + claim `{fid:'p01'}` → `ok: true`. `premise.ts:11-12` quotes the audit sentence describing this exact failure as the hole it closes. It is closed for rates and open for stocks.

**D5 — `horizon` and `kind` documented as enforced, verified nowhere.** `figures/types.ts:120-122` is wrong on two of its four claims. Either enforce them or correct the comment; a false invariant in a header is worse than an absent one.

**D6 — No anti-vacuity in the gated suite.** `claims: []` with confident prose passes. `provider.ts:129-132`'s assertion that `strict: true` prevents this is incorrect.

**D7 — `answerThisTurn` outside the route try/catch.** Unhandled 500 under `typed`.

**D8 — Slice 6 not shipped in the default path.** `master-surfaces.ts` unchanged; the front door still refuses on Space count.

---

## 13. Smallest justified next phase

Chris's hypothesis was A (framing) → B (planner vocabulary) → C (manual conversational exercise). **I would reorder it, and put something before all three.**

**Phase 0 — the five blockers. ~1 day. Not optional.**
D1 (`\b`-anchor the suffix in both regexes), D2 (delete the `Math.abs` clause; fix `renderFigure` to emit `-$4,000.00`), D3 (thread `fallbacks` into a real field and stop misattributing `basis`), D4 (reject a PREMISE claim in a declarative frame, or split the address spaces), D7 (move the call inside the try). Add one property test over arbitrary `LicensedFigure`s and an anti-vacuity assertion to the gated suite. **None of these is a design question; all five are wrong on their own terms.**

**Phase 1 — C, moved to the front. Half a day.**
Enable `typed` **locally only**, with the framing channel actually passed, and have a real conversation. Every measurement in this arc was taken by a harness; the product has never been used. The Slice 7 experiment that motivates the entire framing question compared *doctrine against silence* because `buildTypedPromptSuffix` was called without `framing`/`measures`/`turnWithheld`. **You cannot design the framing mechanism from a measurement that never enabled it.** Re-run that experiment with the channel on, and the taxonomy in §6 becomes evidence instead of inference.

**Phase 2 — A, informed by Phase 1.** `requiredClaims: fid[]` for the assumption categories (zero new types, reuses the claims mechanism entirely), plus `obligations`/`covered` for the epistemic ones. Two fields, one loop.

**Phase 3 — B.** The `depth`+selector axis, reusing `EvidenceDepth` and `resolveDrilldown`'s shape, plus two or three figures out of `largestExpense`/`merchants`/`envelope.span`. No new primitive family.

**Phase 4 — execute the three met deletion conditions**, and either implement the tier split or delete the recorded decision. Also worth one ticket: register the AI flags in `validateEnv()`/`getEnvReport()` so an unset production flag can never again be silent — which is the failure that produced the single action item in this audit.

**What should NOT be built:** a `RequiredFramingItem` vocabulary (two fields suffice); anything added to `MeasureId`; a new primitive family for records; another guard of any kind; memory.

---

## 14. GO / NO-GO

**NO-GO on enabling `AI_ANSWER_MODE=typed` in any deployed environment.** Four blockers, of which D1 and D2 corrupt values rather than merely permitting bad ones. `"I spend $5,000 monthly"` → a licensed $5 billion figure, and a projected overdraft narrated as a surplus, are both reachable today with no adversarial intent.

**NO-GO on `AI_REASONING_PATH=new` and `AI_PROMPT_SHAPE=minimal`** — both are downstream of the master switch, and the measurement motivating the latter is invalid.

**GO on exactly one thing: confirm `AI_FORECAST_GUARD_MODE=repair` is set in the Vercel environment**, and add it plus `AI_ASSESSMENT_GUARD_MODE` to `validateEnv()` so the omission is visible at boot. Nothing in this repository can evidence that flag's production value, `vercel.json` has no `env` block, and unset means the posture the project's own acceptance data rejected.

---

**The judgment underneath all of it.** This arc built the right thing. The typed boundary is a genuinely better idea than the 450 lines of regex it replaces, `Resolution` is a genuinely better shape than `value: number | null`, and the rate-versus-stock axis is a real architectural property that survived deliberate attack. What went wrong is not the design — it is that eight slices ran continuously without a checkpoint, and the pressures that predicts arrived on schedule: deletion deferred and then forgotten, invariants asserted in comments rather than enforced in types, a headline shipped without its mechanism, and three modules marked for deletion by a slice that had already shipped.

The defects are cheap. The architecture is not. Fix the five, use the product for an hour, and then decide what framing needs — in that order.
