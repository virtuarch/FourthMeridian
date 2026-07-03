# KD-2 — Promoting the AI Output Validator from Shadow to Live Enforcement: Investigation

**Status:** Investigation only. No code, tests, schema, migrations, or STATUS.md changed. Awaiting design approval before any implementation.
**Branch:** `feature/phase-2-architecture`
**Date:** 2026-07-02
**Ticket (STATUS.md L137):** KD-2 — "No deterministic validation of LLM output figures against context." High, target v2.4.5. Open — shadow validator landed (`f565a7e`, observational only); closes when promoted to live enforcement.
**Predecessor:** `docs/initiatives/ai4/AI-4_PHASE_0_INVESTIGATION.md` (Phase 0 shadow design, now implemented).

---

## 1. Executive summary

The Phase 0 shadow validator is **landed and observational**. `validateOutput()`
(`lib/ai/output-validator.ts`) is a pure membership-with-tolerance check that
reconciles every flag-eligible numeric claim in the model reply against the
numbers present in the grounded system prompt (plus prior user turns). It is
wired into the single chat choke point via `logOutputValidation()`
(`app/api/ai/chat/route.ts` L131–162, called at L1906) which writes an
`AI_OUTPUT_VALIDATION_FLAGGED` audit row **only when** `unreconciled.length > 0`
and returns the reply **byte-for-byte unchanged**.

KD-2 asks for the next step: make validation *affect the response* when a figure
cannot be reconciled. Against the stated constraints (deterministic first, no
prompt redesign, no broad route rewrite, no new model/provider abstraction,
preserve existing AI architecture), the **smallest safe live-enforcement design
is deterministic append-only annotation**, gated behind a three-state config flag
(`shadow` → `annotate` → `block`) that defaults to today's shadow behavior. This
converts the validator from observational to enforcing without a second LLM call,
without touching prompts, and without ever deleting or rewriting model text — so
the worst-case failure of a false positive is a spurious caveat (log/UX noise),
never a blocked user or corrupted reply.

**One precondition gates any enforcement:** there is currently **no surfaced
review** of the shadow `AI_OUTPUT_VALIDATION_FLAGGED` rows (the admin security
page does not display them). A false-positive baseline drawn from real shadow
logs must exist before `annotate` is enabled, and must be low before `block` is
ever considered.

---

## 2. KD-2 impact map

| Surface | File / location | Role today | Enforcement effect |
|---|---|---|---|
| Pure validator core | `lib/ai/output-validator.ts` | `validateOutput(reply, systemPrompt, userMessages) → { unreconciled, checkedCount, sourceCount }`; membership + tolerance; pure/total | **Unchanged.** Semantics already correct for enforcement. Optionally gains a small pure `applyEnforcement()` helper (or that helper lives in the route) — no change to reconciliation logic |
| Shadow call site | `app/api/ai/chat/route.ts` L131–162 (`logOutputValidation`) + L1906 (call) | Fire-and-forget; writes audit row on flag; discards result; reply untouched | Must **return** the `ValidationResult` to the handler (or be inlined) so the decision can influence `reply`. Still writes audit row on flag |
| Reply assembly / return | `app/api/ai/chat/route.ts` L1882–1912 | `reply = await generateChatReply(...)` → `return NextResponse.json({ message: reply, ... })` | In `annotate` mode, `message` gains a deterministic appended caveat when `unreconciled.length > 0`. Response **shape** (`message`, `knowledgeGaps`, `knowledgeGapMode`) unchanged |
| Audit action registry | `lib/audit-actions.ts` L90 | `AI_OUTPUT_VALIDATION_FLAGGED` (TS constant) | Reuse; optionally add `AI_OUTPUT_VALIDATION_ENFORCED` to distinguish "flagged in shadow" from "annotation actually shown." Additive TS constant → **no migration** |
| Enforcement config | env / config (new) | none | New `AI_OUTPUT_VALIDATION_MODE` flag (`shadow` default). Single read at the call site; doubles as kill switch |
| Provider boundary | `lib/ai/provider.ts` | Single-shot, non-streaming, returns `string` | **Untouched** for `annotate`/`block`. (Only a future `retry` mode would call it twice — out of scope) |
| Admin observability | `app/admin/security/page.tsx` | Does **not** surface validator flags today | Read-only viewer/counter for `AI_OUTPUT_VALIDATION_FLAGGED` needed to build the FP baseline. Additive; arguably a separate slice, but a **precondition** for turning enforcement on |
| Client chat UI | chat components consuming `{ message }` | Renders `message` as prose | No contract change; simply renders the (possibly caveated) `message`. No client edit required for `annotate` |

**Blast radius for the recommended (`annotate`) design:** one route file region
(the LLM-call/return block, ~30 lines, far from the KD-11 heuristic region), one
additive audit constant, one config flag, one new pure helper + its test. No
schema, no migration, no prompt, no provider, no assembler, no client change.

---

## 3. Current shadow validator behavior (as landed)

**Contract.** `validateOutput(reply, systemPrompt, userMessages = [])` returns
`{ unreconciled: NumericClaim[], checkedCount, sourceCount }`. Pure function of
strings — no DB, no LLM, no I/O, no `server-only`.

**What it checks (membership, not recomputation).** The architecture doctrine is
that the model *narrates* pre-computed, provenance-carrying numbers and never
calculates them; every figure it may legitimately state is already rendered in
`systemPrompt`. So the validator tokenizes numbers from the reply, keeps only the
**flag-eligible** ones (carrying a financial marker: `$`, `%`, a `months`/`mo`
unit, a `k/m/b` scale word, or a decimal fraction — bare integers like years,
counts, ordinals are excluded as the primary false-positive guard), and flags any
that fail to reconcile to **some** number present in the prompt or prior user
turns.

**Tolerance (`matches`).** A claim reconciles to a source if exact, or within
`max($0.01, 0.5% of |s|)`, or equal to the source coarsened to a plausible
rounding unit (whole dollar / nearest 10 / 100 / 1000). Absorbs faithful
reformatting ("about $1,200" for `$1,234.56`, `$1.2k`, `1234.56`).

**Membership, never uniqueness.** A claim matching *any* qualifying source
passes. This is deliberate and is exactly why KD-10's two competing
monthly-expense figures both pass — and equally why enforcement cannot police
provenance (see §5).

**Wiring (shadow).** `logOutputValidation()` (route L131–162) runs *after* the
reply exists and *before* the return; it filters user messages, calls
`validateOutput`, and — only if `unreconciled.length > 0` — writes one
`AI_OUTPUT_VALIDATION_FLAGGED` `AuditLog` row (`spaceId` nulled in master mode)
with `{ mode, unreconciled, checkedCount, sourceCount }` in metadata. All errors
are swallowed. The reply returned at L1908–1912 is byte-for-byte unchanged.
Write-only-on-flag keeps it from worsening KD-12 audit amplification.

**Test substrate.** `lib/ai/output-validator.test.ts` — a dependency-free `tsx`
script (`[PASS]/[FAIL]`, `process.exit`) covering verbatim/reformatted/coarse
money, fabricated money & percent flagged, scale abbreviations, bare-integer
exclusion, the KD-10 dual-figure no-false-positive case, user-quoted numbers,
empty/number-free replies, `$0`, and the literal exit-criterion assertion.

---

## 4. Enforcement options

Assessed against the five candidate behaviors named in the ticket, under the
task constraints (deterministic first; no prompt redesign; no route rewrite; no
new provider abstraction; preserve architecture).

| Mode | Behavior on `unreconciled > 0` | Deterministic? | LLM re-call / prompt change? | User-facing risk | Verdict |
|---|---|---|---|---|---|
| **Shadow** (today) | Audit row only; reply unchanged | Yes | No | None | Baseline — not enforcement |
| **Annotate** | Append a fixed caveat to `message`; audit row | **Yes** | No | Spurious caveat on a false positive (noise only) | **Recommended minimal live step** |
| **Block** | Suppress the model reply; return a safe canned message; audit row | Yes | No | Loses an entire mostly-correct reply over one flagged token; FP = user gets nothing | Later escalation, gated on proven-low FP |
| **Repair / rewrite** | Strip or overwrite the offending number in the prose | Yes | No | Can corrupt meaning of surrounding sentence | **Reject** (Phase 0 Mode C) |
| **Retry / regenerate** | Re-call `generateChatReply` with a stricter instruction, re-validate, then fall back | No (LLM non-determinism) | **Yes** (retry instruction ≈ prompt change) + double latency | Changed/slow output; violates "deterministic first / no prompt redesign" | **Defer** (this is the Phase 0 "Mode B", v2.6) |
| **Fallback (tiered)** | Annotate normally; block only when the reply is numeric-claim-dominated / high flag ratio | Yes | No | Middle ground; more logic to tune | Optional evolution of Annotate once FP baseline exists |

**Why annotate over block as the *first* live step.** Enforcement's dominant
risk is false positives (regex over prose, exotic formats, coarse rounding).
Blocking converts every false positive into direct user harm (a suppressed,
useful answer); annotating converts it into a redundant disclaimer. Annotate is
therefore the smallest change that makes validation *live* while keeping residual
FP cost near the shadow level. Block is a strict superset of trust requirements
and should follow only after the shadow/annotate logs prove FP is low.

---

## 5. Recommended minimal live-enforcement design

**Deterministic, append-only annotation behind a three-state flag. No prompt
change, no second LLM call, no reply mutation beyond a trailing caveat.**

1. **Keep `validateOutput` pure and unchanged.** Reconciliation semantics are
   already correct.

2. **Introduce a pure decision helper** (testable in isolation, since the route
   itself has no unit tests):
   `applyEnforcement(reply: string, result: ValidationResult, mode: 'shadow' | 'annotate' | 'block'): string`
   - `shadow` → returns `reply` unchanged (today's behavior).
   - `annotate` → if `result.unreconciled.length > 0`, returns
     `reply + '\n\n' + CAVEAT`; else `reply`. `CAVEAT` is a fixed, deterministic
     string (e.g. "⚠️ One or more figures above could not be automatically
     verified against your account data — please double-check before relying on
     them."). Append-only; never deletes or edits model text.
   - `block` → (later) if flagged, return a fixed safe message instead of `reply`.

3. **Gate on config, default off.** Read `AI_OUTPUT_VALIDATION_MODE`
   (default `'shadow'`) once at the call site. This is both the promotion control
   and the instant kill switch.

4. **Wire at the existing choke point only.** Have the validation step return the
   `ValidationResult` (refactor `logOutputValidation` to return it, or compute
   inline) so the handler can call `applyEnforcement` on `reply` before the
   existing `return NextResponse.json({ message: reply, ... })`. Keep the
   write-only-on-flag audit rule (KD-12). Optionally stamp
   `AI_OUTPUT_VALIDATION_ENFORCED` when an annotation is actually shown, so shadow
   flags and live annotations are distinguishable in the logs.

5. **Response contract unchanged.** Only the *content* of `message` may gain a
   trailing caveat; `message`/`knowledgeGaps`/`knowledgeGapMode` shape is
   identical. No client change required.

**Explicitly out of scope** (honoring constraints): any edit to prompts /
serializers / `generateChatReply` / model params; regeneration or retry;
streaming; any new model/provider abstraction; KD-10/KD-11 heuristic work; KD-5.

**Precondition before enabling `annotate`:** stand up a read-only view/counter of
`AI_OUTPUT_VALIDATION_FLAGGED` (admin security page or a query script) and
confirm a low false-positive rate on real traffic. Tune tolerance in the pure
core against those logs *before* flipping the flag.

---

## 6. Dependency notes — KD-7, KD-10, KD-11

**KD-7 (already FIXED & committed, `c0f290b`).** Despite being named as a
dependency in the KD-2 brief, KD-7 has landed. It added `truncated`,
`coverageStartDate`, and `fetchLimit` to the transactions-summary contract and a
`COVERAGE LIMIT` caveat plus `[INCOMPLETE month]` flags into the system prompt.
Effect on the validator surface: (a) the source-number set now legitimately
includes truncated / lower-bound figures, and since the validator checks
membership against whatever the prompt emitted, a model narrating a KD-7-caveated
figure still reconciles — no conflict; (b) KD-7 removes the prior "prompt asserts
exactness over truncated data" hazard, which otherwise could have produced
misleading-but-reconciled numbers that enforcement would *not* have caught (the
validator checks membership, never correctness). **Net: settled upstream,
supportive, no blocker.** Enforcement should continue to treat the prompt as
ground truth and must not attempt to re-derive truncation correctness.

**KD-10 (Open, in-flight — do not touch).** Two competing monthly-expense figures
reach one prompt (window-normalized assessment estimate vs complete-month context
average); the membership validator green-lights **both**. This is the hard limit
of live enforcement: a membership check **cannot** disambiguate provenance, so
`annotate`/`block` provide **zero** protection against the KD-10 class and must
not be represented as doing so. KD-10's real remedy is a single-source-of-truth
for monthly expense (collapsing the two figures), which also shrinks the source
set and marginally tightens the validator. Enforcement and KD-10 are orthogonal
and can ship independently. Do not modify KD-10 files as part of KD-2.

**KD-11 (Open, in-flight — do not touch).** Duplicated/drifting keyword
heuristics between the chat route and the intent classifier. Its relevance to
KD-2 is **file-level, not logical**: KD-11 edits the *same* file
(`app/api/ai/chat/route.ts`), shrinking it to a thin caller by moving heuristics
(≈L184–573) into `lib/ai/intent/`. The KD-2 enforcement change lives in the
LLM-call/return region (≈L1882–1912), well away from that block, so direct
conflict risk is low but real. KD-11 changes neither `IntentRoute` shape nor
`systemPrompt` content, so it does **not** affect the validator's source set.
**Recommendation:** keep the KD-2 edit minimal and localized to the return
region, and coordinate merge ordering with KD-11 to avoid churn. Do not modify
KD-11 files as part of KD-2.

**KD-12 (Low, Open).** Audit write amplification. Enforcement must preserve the
write-only-on-flag rule so it adds no per-message rows.

---

## 7. Files likely affected (implementation slice — NOT now)

Additive / minimal:

1. `app/api/ai/chat/route.ts` — refactor the validation step to return the
   `ValidationResult`; read `AI_OUTPUT_VALIDATION_MODE`; call `applyEnforcement`
   on `reply` before the existing return. ~20–30 lines in the L1882–1912 region.
2. `lib/ai/output-validator.ts` (or a sibling `output-enforcement.ts`) — add the
   pure `applyEnforcement()` helper and the fixed `CAVEAT` constant. Core
   `validateOutput` untouched.
3. `lib/audit-actions.ts` — (optional) add `AI_OUTPUT_VALIDATION_ENFORCED`
   constant. Additive TS, no migration.
4. env/config sample (`.env.example`) — document `AI_OUTPUT_VALIDATION_MODE`.
5. `app/admin/security/page.tsx` (or a read-only query script) — surface
   `AI_OUTPUT_VALIDATION_FLAGGED` counts for the FP baseline. Read-only; may be a
   separate precursor slice.

Explicitly **not** touched: prompts/serializers, `lib/ai/provider.ts`, assemblers,
`lib/ai/intelligence/annotations.ts`, intent classifier, schema, migrations,
STATUS.md.

---

## 8. Tests required (implementation slice — `tsx`, dependency-free)

1. **Core regression:** existing `lib/ai/output-validator.test.ts` stays green
   (reconciliation unchanged).
2. **New `applyEnforcement` unit tests** (new pure helper → directly testable):
   - `shadow` mode → reply identical for both clean and flagged results.
   - `annotate` + clean result (`unreconciled = []`) → reply **unchanged**.
   - `annotate` + flagged result → reply equals `original + CAVEAT`, exactly once,
     append-only (original substring intact, model text not mutated).
   - `block` + flagged → returns the fixed safe message; `block` + clean →
     returns the original reply.
   - Idempotence / no double-annotation when already caveated (if guarded).
3. **Contract shape test:** the handler still returns
   `{ message, knowledgeGaps, knowledgeGapMode }` with only `message` content
   affected.
4. **KD-10 guard (carried forward):** dual-figure prompt + reply citing either →
   no annotation (both reconcile) — proves enforcement does not regress on the
   known membership case.
5. **Shadow-invariance smoke:** with `AI_OUTPUT_VALIDATION_MODE=shadow`, a live
   chat message returns a `message` byte-identical to pre-change behavior and an
   audit row appears only on a fabricated figure.
6. Standard gate: `npx prisma generate` (sanity, no schema change),
   `npx tsc --noEmit`, `npm run lint`, plus the unrelated privacy suites
   (`lib/ai/assemblers/transactions.privacy.test.ts`,
   `lib/data/transactions.privacy.test.ts`) still green.

---

## 9. Rollback plan

- **Kill switch (no revert):** set `AI_OUTPUT_VALIDATION_MODE=shadow`.
  Instantly restores today's observational behavior; the validator still logs.
- **Revert:** the change is a single additive commit (pure helper + flag read +
  conditional append + optional audit constant) → `git revert <sha>`.
- **No schema / no migration** — the audit action is a TS constant; nothing to
  unwind in the database.
- **No data corruption is possible** in `annotate` mode: it only *appends* text
  and never edits or deletes the model reply, so the worst residual state after a
  false positive is a spurious caveat (log/UX noise). Post-revert/post-disable
  state is identical to today (KD-2 open, shadow-only).
- **Coordination note:** because the edit shares `route.ts` with KD-11, land or
  rebase relative to KD-11 to keep the revert a clean single commit.

---

## 10. Final recommendation

1. **Precondition first.** Surface and review the existing shadow
   `AI_OUTPUT_VALIDATION_FLAGGED` audit rows to establish a false-positive
   baseline. Do not enable any enforcement without it. Tune tolerance in the pure
   core against real logs.
2. **Ship the minimal live step = `annotate`** behind a three-state
   `AI_OUTPUT_VALIDATION_MODE` flag defaulting to `shadow`. Deterministic,
   append-only caveat; reuses the pure validator and existing audit action;
   isolates one pure `applyEnforcement()` helper for testability. This satisfies
   "deterministic first," "no prompt redesign," "no route rewrite," "no new
   provider abstraction," and "preserve existing AI architecture."
3. **Hold `block` as a gated escalation** once the annotate/shadow logs show low
   FP; **reject `repair`** (meaning-corruption) and **defer `retry`** (non-
   deterministic, needs a retry instruction ≈ prompt change, double latency — the
   deferred v2.6 Mode B).
4. **Scope discipline:** enforcement is orthogonal to KD-10 (a membership check
   cannot police provenance — do not claim otherwise) and must coordinate merge
   ordering with KD-11 (shared `route.ts`). KD-7 is already merged and supportive.
   Do not touch KD-5, KD-10, or KD-11 files.

---

## 11. Stopping point

Investigation only. No validator/route/config edit, no test, no schema, no
migration, no STATUS.md change has been made. Next action requires approval of:
(a) the `annotate` append-only failure mode as the first live step, (b) the
three-state flag defaulting to `shadow`, (c) the FP-baseline precondition before
enabling, and (d) reuse of the existing audit action with write-only-on-flag. On
approval, implement exactly the additive artifacts in §7 and run the §8 gate.
