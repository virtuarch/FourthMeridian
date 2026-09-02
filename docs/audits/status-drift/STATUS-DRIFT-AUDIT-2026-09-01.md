# STATUS.md drift audit — 2026-09-01

**Scope:** HEAD `f94237e` (branch `v2.6`, 2026-09-01 07:32) vs STATUS.md as committed at `9ea50a5` (2026-08-17).
**Verdict: 10 new commits, and an entire new top-level subsystem — `lib/reasoning/**`, 23 modules, ~10.3k insertions across 84 files — shipped with zero mention in STATUS.md. Four new env flags gate it, all defaulting to the legacy path. Three prior audit items were remediated this cycle (the audit series is committed; `docs/systems/forecast.md` exists; the forecast flags are registered in `lib/env.ts`/`.env.example`), and REASONING-0 explicitly restates the one that is not: `AI_FORECAST_GUARD_MODE` is still unset in Vercel production, so production still serves the 8-violations-per-run posture its own acceptance rejected. STATUS.md is 15 days stale.**

| Check | 2026-08-31 | 2026-09-01 |
|---|---|---|
| HEAD | `7abda2d` (08-31 19:52) | `f94237e` (09-01 07:32) |
| STATUS.md last touched | `9ea50a5`, 08-17 | unchanged (**15 days**) |
| New commits since last audit | 17 | **10** (PROJECTION-2/3, REASONING-0→7) |
| New env keys | 2 | **4** (`AI_ANSWER_MODE`, `AI_CHAT_MODEL`, `AI_REASONING_PATH`, `AI_PROMPT_SHAPE`) |
| New migrations | 0 | 0 (101 dirs; STATUS.md:7 still says **88**) |
| New committed `.md` docs | 0 | **14** — incl. `systems/{forecast,model-tier,planner,reasoning-layer}.md` and all 8 prior drift audits |
| New npm scripts | 2 | **3** (`ai:answer-boundary`, `ai:conversation-gate`, `ai:compare-plans`) |
| Unit suite (per commit trailers) | 508/508 | **516/516** · audit 21/21 (STATUS.md:10/:42 still say 492/492, 18/18, 339/339) |

Keyword check against STATUS.md — all **zero hits**: `REASONING`, `reasoning-layer`, `MeasureId`, `answer boundary`, `typed`, `planner`, `scenario delta`, `AssumptionDelta`, `model tier`, `PROJECTION`, plus every carry-over from prior cycles.

---

## New drift (this cycle)

**1. `lib/reasoning/**` — a new subsystem, substrate *and* wired, and STATUS.md does not know it exists. *(highest severity — the TI2 shape at its largest yet)***
`2fe3c58` REASONING-1 (typed answer boundary: `{ claims[], prose }` against a licensed figure table, verified by identity rather than by four layers of regex re-reading the model's English), `5640e1e` REASONING-3 (one measure primitive — `net_worth@now` and `net_worth@2026-12-31` are the same measure differently licensed; every evaluator a thin adapter over an existing authority, parity-pinned, six multiplications total), `7e4e197` REASONING-4 (scenario/assumption lifecycle — ACTIVE deltas, supersede, dismiss; seven-turn conversation gate 7/7 clean), `004a46e` REASONING-5 (structured planner, measured on 112 real questions; forecast and broad flip, three classes deliberately do not), `d561e7d` REASONING-6 (master-mode cross-Space deduplicated composition), `f94237e` REASONING-7 (prompt-cache prefix repair: shared cacheable prefix ~120 chars → 4,479 tokens).
→ A downstream assessment asking "does the product have a typed answer boundary / a planner / cross-turn assumption handling?" gets the TI2 answer today: **not started.** All three are shipped, measured, and browser-verified.
→ **Suggested correction:** new *Recently landed* clause — "V26-REASONING 0→7: a typed answer boundary (`lib/reasoning/**`), one measure primitive spanning current and future, a structured planner measured on 112 real questions, and a scenario/assumption lifecycle. All behind flags defaulting to the legacy path. See [`systems/reasoning-layer.md`](docs/systems/reasoning-layer.md), [`planner.md`](docs/systems/planner.md), [`model-tier.md`](docs/systems/model-tier.md)."

**2. Four new env flags, none in the Blockers section — and the *old* one is still the live production defect.**
- New: `AI_ANSWER_MODE` (unset ⇒ `prose`, today's pipeline), `AI_CHAT_MODEL` (unset ⇒ `gpt-4o-mini`), `AI_REASONING_PATH` (unset ⇒ `legacy`), `AI_PROMPT_SHAPE` (unset ⇒ `full`). All four are now properly registered in `lib/env.ts:196-231` and `.env.example` — the omission the last three audits flagged is fixed at the *code* layer.
- Still open: `62fea46` REASONING-0 states it in its own "Outstanding" section — **"Vercel production still needs `AI_FORECAST_GUARD_MODE=repair`; until it is set, production is serving the 8-violations-per-run posture this commit fixed locally."** `.env.example:177` now carries `repair`; production does not.
→ **Suggested correction:** *Blockers (beta gate)* item — "**Set `AI_FORECAST_GUARD_MODE=repair` in Vercel Production** — unset ⇒ `shadow`, which FORECAST-15 measured as 8 authority violations per corpus run reaching the user (repair: 0). Config act, not code." Also add `AI_ASSESSMENT_GUARD_MODE` (flagged 08-26, 08-27, 08-30, 08-31) and note the four REASONING flags default to legacy so an unset production is unchanged.

**3. The projection became the answer, and the acceptance corpus was rewritten under it.**
`a0150c3` PROJECTION-2 + `dd846fc` PROJECTION-3: the projection now renders **first, as the answer**, with the licensed path demoted to "STRICTER FORECAST"; the gate predicate moved from `FACTUALLY_LICENSED` to "any path with a closing figure has ANSWERED" (ASSUMPTION_DEPENDENT is the *ordinary* result once a user states a spending level). Two figure-provenance renames ("observed income" → "projected income from the observed payroll pattern"), one `NUMBER_RE` sign bug producing a spurious verification warning. F15 corpus realigned per-scenario: `NO_HISTORICAL_BASELINE`→`NO_NORMAL_RELABEL`, `NO_ENDING_CASH_FIGURE`→`NO_INVENTED_ENDING_CASH`. **F15 now 88/105** (was 78/105).
→ Note: the 08-31 audit's suggested next-step "update the F15 corpus for the PROJECTION-1 contract" is **done** — do not carry it forward.
→ **Suggested correction:** *Recently landed* clause; and a *Next steps* line for the residual, which the commits name honestly: the arithmetic-under-pressure family (D, Q2, Q3, Q5, I) plus A-facts-only, all guard-covered under `repair`.

**4. A recorded decision was reversed on re-measurement, and STATUS carries neither the decision nor the reversal.**
`f771222` REASONING-2: FORECAST-11 measured a stronger model tier against the *prose* architecture and answered no ("helps D, hurts I, 14× cost"). Re-measured against the typed boundary: truth is a **tie** (both tiers 7/7 gates — the boundary makes both safe), usefulness is not (gpt-4.1 7/7 answered, 0 fallbacks; gpt-4o-mini 4/7 answered, 3 fallbacks), cost ~9.7× and **latency p50 20.9s vs 3.9s** is the real price. Default unchanged; under `prose` the FORECAST-11 answer still stands.
→ This is exactly the kind of finding a stale STATUS invites someone to re-litigate from the superseded half.
→ **Suggested correction:** one line in *Where things stand* pointing at [`systems/model-tier.md`](docs/systems/model-tier.md) — "the tier decision is now conditional on `AI_ANSWER_MODE`; the two flags must move together."

**5. Seven shipped-code defects found and fixed with no ledger trace — same class as CF-12 and PARITY-1.**
- `$5K` read as **$5.00** in *four separate patterns* (`statements.ts`, `premise.ts`, the verifier's prose sweep, its `valueOf`) — a licensed figure, correct arithmetic, premise wrong by three orders of magnitude, nothing refused (`7e4e197`).
- The horizon resolver could not read a bare month — "And what about February?" silently kept December (`7e4e197`).
- Master composition returned **$0.00 digital assets** for a Space declaring `totalDigitalAssets: 19,014.63`, because rows were recomputed and a class with no rows vanished — W6's `nativeBalance ?? 0` and W-M3a's NOT-NULL-DEFAULT-0 wearing a third costume (`d561e7d`).
- `activeButUndatedCount` hard-coded `0`, turning "five bills we know about and cannot date" into "nothing to say" in a user-visible reason string (`5640e1e`).
- Three `daysBetween` implementations, two directions, one silent clamp; `median` returning `0` on an empty sample in one of three copies (`62fea46`).
→ **Suggested correction:** no KDs needed (all closed), but they belong in the landed clause. The recurrence — **an absent row is not an empty class** — is now the most-repeated defect in this repository's own record and deserves a doctrine line, not a fifth rediscovery.

**6. Deletions worth recording.** `62fea46` removed `lib/ai/context-priority/**` (800 lines: a shadow planner that ran *after* assembly, was never once consulted, and wrote a `db.auditLog.create` on every chat turn — 3 writes/turn → 2), plus ~12 dead forecast exports and the prose renderers' ~30 checks. `compare-plans.ts` survives deliberately, registered with its deletion condition in the audit registry.
→ **Suggested correction:** worth a half-line; this is partial payment on KD-12 (audit-log write amplification).

---

## Inverse drift (STATUS says open / not-started but git shows shipped)

- **STATUS.md:45 — "AI-5: conversational persistence (`conversationId`) is the major unbuilt AI layer."** Now wrong in a stronger way than last cycle. `conversationId` is still absent (literal fact holds), but `7e4e197` REASONING-4 **ships the capability it stands for**: an assumption lifecycle where every ACTIVE delta reaches narration, deltas supersede rather than overwrite, `DISMISS_ALL` runs before the same turn's deltas are collected, and nothing is persisted or held as mutable module state — verified 7/7 on a seven-turn live gate. The layer is built; it is deliberately not a store.
  → **Suggested correction:** rewrite line 45 — "cross-turn continuity ships as a derived scenario lifecycle (REASONING-4), not a persisted store; `conversationId` is declined by design (FORECAST-13)."
- **KD-8 "Master-mode chat: unbounded prompt remains."** No longer accurate. `d561e7d` REASONING-6 deleted the `spaceIds.length === 1` refusal and gave master a deduplicated cross-Space composition with four named refusals (rows-vs-declared-totals mismatch, `reportingBalance === null`, `redactedCount > 0`, `totalsUnconverted`), and it never falls back to summing totals. `f94237e` REASONING-7 *measures* the prompt: 10,768 tokens typed, 1,956 minimal, 4,479-token cacheable prefix.
  → **Suggested correction:** close KD-8, or restate it as the measured-and-bounded shape with the token figures.
- **KD-16** (window re-derivation per turn) — unchanged; **seventh** cycle carried. Close or restate.
- **KD-14** (`AiAdvice` no production write path) — re-verified accurate at HEAD (`app/api/brief/route.ts:454` says so in a comment). Correctly open.
- **STATUS.md:36 "AI5-0 / AI5-1 — failure-corpus reconstruction"** — substantially overtaken. The repository now holds F15 (35 scenarios → 105 checks), the answer-boundary corpus (7 cases), the conversation gate (7 turns), the multiturn harness (10/10), and a 112-question plan-comparison corpus. Restate or retire.
- **08-30 audit item 5** (open a KD for the CF-11 planner NOT_NEEDED mis-route) — **partially superseded**: `004a46e` fixes the symptom (the clarification invitation is withheld whenever CF-8 resolved any concept) and documents the cause — the legacy classifier returns UNKNOWN on **97 of 112** real questions. Restate as "measure catalogue has no vocabulary for transaction-record or coverage questions" rather than a routing bug.

## Carried from prior audits — still unremediated

- **STATUS.md:60** cites `app/api/spaces/[id]/goals/route.ts:62` as live evidence — **file still does not exist** (deleted by W2, `9352e41`). Self-marked "kept for one cycle, then delete"; kept for **eight**.
- **STATUS.md:7 "88 migrations"** → actual **101**. REASONING-7 adds the operational reason this matters: two are already unapplied against production and `build` never runs `migrate deploy`, which is why it *declined* to add a third dimension to `ApiUsageCounter`.
- No *Recently landed* clause for **W1–W6f, A1–A6, W-M0→W-M3a, ETH-H1/H2, UI-C1/C2, PRODUCT-C1, CF-1→CF-12, FORECAST-1→17, PARITY-1→3, PROJECTION-1→3, REASONING-0→7**.
- Blockers still missing the crypto acquisition credentials `ALCHEMY_API_KEY` / `ETH_RPC_URL` / `SOL_RPC_URL` (absent ⇒ ETH/SOL DARK).
- **Documentation map (STATUS.md:72) names 11 `docs/systems/` files; there are 16.** Missing: `crypto-networks`, `forecast`, `model-tier`, `planner`, `reasoning-layer`. `docs/README.md:34` is also stale — it lists 12 (has `crypto-networks`, missing the four new ones) and was last touched 2026-08-26.
- `HOUSEHOLD` enum residue, **DEBT-1**, ops observability restore (`ce360b8`), W2 schema residue.
- **Standing product gap, recorded only in `docs/systems/forecast.md`:** `obligation.ts` stays unwired because across every Space, five debt accounts carry stated minimums and APRs and **not one carries a due date**. The `dueDay` KnowledgeGap is the unlock. Nothing in STATUS.md.

## Remediated since the last audit *(recorded so it is not re-flagged)*

- The drift-audit series is **committed** — all eight prior files, previously `??`. Working tree is clean.
- **`docs/systems/forecast.md` now exists**, plus `model-tier.md`, `planner.md`, `reasoning-layer.md`, and the two V26-REASONING plan documents.
- The forecast/assessment flags are **registered in `lib/env.ts` and `.env.example`** (REASONING-0), with the "registering a flag is part of the slice" rule stated at the registration site.

## Minor — internal, not STATUS

`lib/env.ts:224-229` justifies `AI_PROMPT_SHAPE`'s `full` default with the *seven-case* measurement ("1,570 tokens against 11,400 with no change in compliance… stays `full` until the 35-scenario corpus says the same thing"). The **same commit** (`f94237e`) ran that corpus: `full` 31/35 vs `minimal` 16/35, with all 15 extra failures being `MISSING` and the `FORBIDDEN` count identical. The registered rationale understates its own finding — the answer is in, and it is "no".

---

*Report-only. STATUS.md was not edited.*
