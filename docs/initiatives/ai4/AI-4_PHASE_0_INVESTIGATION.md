# AI-4 / KD-2 — Deterministic LLM Output Validator: Phase 0 Investigation

**Status:** Investigation only. No code, no refactor, no prompt change. Awaiting design approval before any implementation.
**Milestone:** v2.4.5 (exit criterion: "a reply quoting a number absent from context is detectably flagged"). Also a v2.6 entry criterion.
**Defect:** KD-2 — no deterministic validation of LLM output figures against context.

---

## 1. Investigation findings

### 1.1 Where the LLM reply is produced (the choke point)

Single, unambiguous choke point in `app/api/ai/chat/route.ts`:

```
1789  let reply: string;
1791    reply = await generateChatReply(systemPrompt, messages);   // only sanctioned OpenAI path
...
1811  return NextResponse.json({ message: reply, knowledgeGaps, knowledgeGapMode });
```

Both the specific-Space path (`buildSpaceSystemPrompt`, line 1770) and the
master path (`buildMasterSystemPrompt`, line 1725) converge here: each sets
`systemPrompt`, then this one call produces `reply`, then this one `return`
ships it. `generateChatReply` (`lib/ai/provider.ts`) is the only file allowed to
import the OpenAI SDK; it is non-streaming (`max_tokens: 1024`, `temperature:
0.3`) and returns a plain string. So a validator placed between line 1791 and
line 1811 sees **both** the exact `systemPrompt` the model was grounded on and
the exact `reply` — with no other reply path to cover.

### 1.2 What the authoritative numeric source set is

The `systemPrompt` string **is** the source of truth. It is assembled purely
from deterministic serializers:

- `serializeRoutingBlock(route)` — intent routing;
- `serializeAssessmentBlock(assessment, windowNote)` (route.ts:1080) — the
  deterministic assessment engine's figures (`lib/ai/intelligence/annotations.ts`);
- `serializeContextBlock(ctx)` (route.ts:562) — the assembled domain data
  (accounts, transactions summary, holdings, goals, drilldown).

Every figure the model is permitted to state is already rendered as a formatted
token inside `systemPrompt`. The architecture doctrine is explicit (route.ts:1313
"Facts only — the LLM …"; provider.ts:60 "the model must not invent data beyond
what is supplied here"): **the model narrates pre-computed numbers; it never
calculates.** Therefore the correct invariant is membership, not recomputation:

> Every monetary/numeric figure in `reply` must be reconcilable to a number
> present in `systemPrompt` (with the user's own prior messages admitted as a
> secondary source, since a user may quote a figure the model then echoes).

No new query, no assembler change, no access to the DB or the model is needed to
obtain the source set — it is a pure function of two strings already in scope.

### 1.3 How numbers are formatted in the prompt (defines normalization + tolerance)

| Class | Formatter | Example in prompt | Notes |
|---|---|---|---|
| Money | `fmtMoney` (route.ts:986) — `toLocaleString('en-US', 2dp)` | `$1,234.56` | always `$`, comma groups, exactly 2 dp |
| Coverage / months | `.toFixed(1)` | `3.2 months` | 1 dp |
| Percentage | `fmtPct` (`lib/format.ts`, "12.3%") | `12.3%` | 1 dp |
| Counts | bare integer | `3 account(s)`, `5 txn(s)` | small non-money ints |
| Dates | `YYYY-MM-DD`, `fmtMonthYear` | `2026-01-15`, `Jan 2026` | own class |

The model, at `temperature 0.3`, will legitimately **reformat** these:
`$1,234.56` → `1234.56`, `$1,235` (rounded), `about $1,200` (coarse), or
`$1.2k`. Normalization and tolerance must absorb faithful reformatting while
still catching invented figures.

### 1.4 Known false-positive hazards (must be designed around)

- **Number-class confusion:** years (`2026`), account/txn counts, ordinals
  (`1st`), list indices, and `$0` must not be judged as fabricated money.
- **KD-10:** two competing "monthly expense" figures already reach one prompt
  (assessment block vs context block). A membership check reconciles **both** —
  no false positive — but this confirms the validator must test *membership*,
  never *uniqueness*.
- **Rounding/approximation:** "about $1,200" for a `$1,234.56` source is faithful,
  not fabricated — tolerance must admit coarse rounding.
- **User-quoted numbers:** the user may state a figure the model repeats back;
  admitting prior user-message text into the source set prevents flagging it.

### 1.5 Test substrate

No jest/vitest in the repo. All existing tests are standalone `tsx` scripts
(`lib/ai/assemblers/transactions.privacy.test.ts`,
`lib/data/transactions.privacy.test.ts`) that `console.log [PASS]/[FAIL]` and
`process.exit(0|1)`. The validator's tests must follow that exact pattern — and
because the validator core is a pure function, it needs no DB shim.

### 1.6 Existing precedent to mirror

`logShadowSelectionPlans` (route.ts:74–104, "D6.3D-1") already runs an
**observational, swallowed, prompt-unchanged** side computation at chat time and
writes an AuditLog row (`AI_CONTEXT_SELECTION_PLANNED`). The validator should
adopt this exact shape: compute, log, never affect the response.

---

## 2. Recommended validator design (smallest safe)

**A pure core + a swallowed shadow call site. No prompt change, no model change,
no behavioral coupling to the response.**

### 2.1 New pure module — `lib/ai/output-validator.ts`

Dependency-free (types only; no DB, no LLM, no `server-only` needed):

- `extractSourceNumbers(systemPrompt: string, userMessages: string[]): SourceNumber[]`
  — tokenize all numeric literals from the prompt (and prior user turns),
  normalized to `{ value: number, class: 'money'|'percent'|'months'|'count'|'date' }`.
- `extractClaims(reply: string): NumericClaim[]` — same tokenizer over the reply.
- `reconcile(claims, sources, opts): ValidationResult` — for each money/percent/
  months claim, reconciled if some source of the same class matches within
  tolerance (§2.3). Returns `{ unreconciled: NumericClaim[], checkedCount,
  sourceCount }`. Counts and dates are extracted but, in v1, not treated as
  fabrication-eligible (logged as informational only) to keep false positives
  near zero.

Scope v1 to exactly the formats the prompt emits (§1.3). Document unsupported
forms (ranges `$100–$200`, `$1.2M`, scientific) as known gaps, not silent passes.

### 2.2 Single call site (shadow)

Between route.ts:1791 and :1811, wrapped in a `try/catch` that swallows **all**
errors (identical discipline to `logShadowSelectionPlans`):

```
// after: reply = await generateChatReply(systemPrompt, messages)
//   const result = validateOutput(reply, systemPrompt, priorUserMessages)
//   if (result.unreconciled.length) await logOutputValidation(...)   // swallowed
// return NextResponse.json({ message: reply, ... })   // reply UNCHANGED
```

The reply returned to the user is **byte-for-byte unchanged**. This is the
smallest thing that satisfies the v2.4.5 exit criterion ("detectably flagged")
and builds the exact substrate v2.6 later promotes to blocking.

### 2.3 Tolerance rules

- Normalize before compare: strip `$`, `,`, `%`, whitespace, trailing `.0`; parse float.
- A money claim `c` reconciles to source `s` (same class) if **any** holds:
  - exact match at 2 dp;
  - `|c − s| ≤ max($0.01, 0.5% of s)` (absorbs cent-rounding and reformatting);
  - `c` equals `s` rounded to a coarser unit the model plausibly used (whole
    dollar, nearest 10/100/1000) — i.e. `round(s, unit) === c` for unit ∈ {1,10,100,1000}.
- Percent/months: match at the emitted precision (1 dp) ± one unit in last place.
- Membership semantics only — a claim matching *any* qualifying source passes
  (this is what makes KD-10's dual figures safe).

---

## 3. Proposed failure mode

Three options were considered:

| Mode | Behavior | User-facing risk | Prompt change | Verdict |
|---|---|---|---|---|
| **A. Flag-and-annotate (shadow)** | Log unreconciled numbers to AuditLog; return reply unchanged | None | None | **Recommended (v1)** |
| B. Block-and-regenerate | Retry with stricter instruction, then fall back | Latency, changed output | Yes (retry instruction) | Defer to v2.6 |
| C. Strip/rewrite reply | Mutate the reply text | Can corrupt meaning | No | Reject |

**Recommendation: Mode A.** It is observational, cannot alter or delay the
response, requires no prompt/model change (honoring the constraints on this
task), literally satisfies the exit-criterion wording, and mirrors the proven
shadow-mode precedent already in the route. Promotion to Mode B is a v2.6
decision gated by a track record of low false positives — and is explicitly out
of scope here.

---

## 4. Exact implementation scope (for the later implementation slice — NOT now)

**Additive only. Smallest set:**

1. `lib/ai/output-validator.ts` — pure core (§2.1). New file.
2. One swallowed call site in `app/api/ai/chat/route.ts` (§2.2). ~10 lines,
   inside a new `try/catch`. No existing line's behavior changes.
3. `lib/audit-actions.ts` — add one action constant (e.g.
   `AI_OUTPUT_VALIDATION_FLAGGED`). Additive; `AuditAction` is a TS module, not
   a Prisma enum, so **no migration**.
4. `lib/ai/output-validator.test.ts` — `tsx` test (§5). New file.

**Explicitly out of scope:** any change to `serializeContextBlock` /
`serializeAssessmentBlock` / prompts / model params; regeneration/blocking;
streaming; touching assemblers or the assessment engine; KD-10/KD-11 heuristic
consolidation beyond what §2.3 membership semantics already neutralize.

**Audit-growth guard (KD-12 interaction):** write an audit row **only when
`unreconciled.length > 0`**, so the validator does not add a row per message and
does not worsen the existing 2-rows-per-chat amplification.

---

## 5. Tests to add (`lib/ai/output-validator.test.ts`, tsx, dependency-free)

Pure-function cases (no DB):

1. Money in prompt, reply repeats it verbatim (`$1,234.56`) → reconciled.
2. Reply reformats it (`1234.56`, `$1,234.56`, `$1,235`, `about $1,200`) → reconciled.
3. Reply states a money figure absent from prompt (`$9,999.99`) → **flagged**.
4. Comma/`$`/decimal normalization equivalence.
5. Rounding tolerance: whole-dollar and nearest-hundred coarsening pass; a value
   outside all coarsenings fails.
6. Percentage (`12.3%`) and months (`3.2 months`) reconcile at emitted precision.
7. Number-class exclusions: years (`2026`), counts (`3 accounts`), ordinals,
   `$0` → not flagged as fabricated money.
8. **KD-10 dual-figure:** two different monthly-expense values both in prompt;
   reply cites either → no false positive.
9. **User-quoted number:** reply echoes a figure present only in the prior user
   message → not flagged (source set includes user turns).
10. Empty reply / reply with no numbers → passes, zero flags.
11. Exit-criterion demonstration: a reply quoting a number absent from context
    is detectably flagged (asserts the literal v2.4.5 wording).

Plus the standard gate: `npx tsc --noEmit`, `npm run lint`.

---

## 6. Rollback plan

- **Coupling:** none. Shadow-only + all-errors-swallowed `try/catch` ⇒ the
  validator cannot change, delay, or fail the chat response.
- **Revert:** single additive commit → `git revert <sha>`. No schema, no
  migration (audit action is a TS constant), no data to unwind.
- **Kill switch (optional):** an early `return` / env flag in the validator call
  site disables it without revert.
- **Post-revert / post-disable state:** identical to today (KD-2 open); no
  corrupted or orphaned data possible because the reply path is untouched.

---

## 7. Validation plan (for the implementation slice)

1. `npx prisma generate` — sanity (no schema change expected).
2. `npx tsc --noEmit`.
3. `npm run lint`.
4. `npx tsx lib/ai/output-validator.test.ts` — new suite green (§5).
5. Regression: `npx tsx lib/ai/assemblers/transactions.privacy.test.ts` and
   `npx tsx lib/data/transactions.privacy.test.ts` still green (unrelated, must
   be unaffected).
6. Shadow-invariance smoke: send a chat message; assert (a) the returned
   `message` is byte-identical to the pre-change behavior, and (b) an audit row
   appears **only** when a fabricated number is present.
7. Exit-criterion demonstration (§5 case 11) recorded.

---

## 8. Risks

- **False positives** (top risk): mitigated by class filtering, membership (not
  uniqueness) semantics, coarse-rounding tolerance, admitting user-message
  numbers, and — decisively — **shadow-only** output so any residual false
  positive is log noise, never user harm. Tune tolerance against real logs
  before considering Mode B.
- **Extraction fidelity:** regex over prose misses exotic forms (`$1.2M`,
  ranges). v1 targets only the formats the prompt actually emits; gaps are
  documented (§2.1), not silently passed.
- **Audit-log amplification (KD-12):** neutralized by writing only on flag (§4).
- **Latency/tokens:** pure synchronous string work; negligible.
- **Scope creep toward blocking/regeneration:** explicitly deferred to v2.6.

---

## 9. Stopping point

This is the Phase 0 investigation deliverable only. No validator code, no route
edit, no prompt or assembler change has been made. Next action requires approval
of: (a) Mode A shade-only failure mode, (b) the membership-with-tolerance design
(§2), and (c) the write-only-on-flag audit rule. On approval, implement exactly
the four additive artifacts in §4 and run the §7 gate.
