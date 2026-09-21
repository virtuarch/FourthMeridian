# STATUS.md drift audit — 2026-09-03

**Scope:** HEAD `6e933d9` (branch `v2.6`, 2026-09-02 22:21) vs STATUS.md as committed at `9ea50a5` (2026-08-17).
**Verdict: one commit this cycle — and it is the largest correctness commit in the arc. REASONING-8 closed all five blockers from yesterday's NO-GO audit, including one (D1) that was NEVER flag-contained and was corrupting the live forecast path by a factor of a million. STATUS.md recorded none of it as open and now records none of it as fixed. 17 days stale.**

| Check | 2026-09-02 | 2026-09-03 |
|---|---|---|
| HEAD | `f94237e` (09-01) | **`6e933d9`** (09-02 22:21) |
| STATUS.md last touched | `9ea50a5`, 08-17 | unchanged (**17 days**) |
| New commits since last audit | 0 | **1** (+1,733/−112, 22 files) |
| Untracked audit files | 2 | **0 — resolved** |
| Migrations on disk | 101 | 101 (STATUS.md:7 still says **88**) |
| Suite figures at HEAD | 516/516 · 21/21 | **517/517 · 21/21** (STATUS.md:42 says 492/492 · 18/18) |

Keyword check against STATUS.md — all still **zero hits**: `REASONING`, `reasoning-layer`, `magnitude`, `frame`, `MeasureId`, `answer boundary`, `planner`, `FORECAST`, `PARITY`, `PROJECTION`, `AI_ANSWER_MODE`, `typed`.

---

## New drift (this cycle)

**1. A production-reaching defect was found, fixed, and never entered the ledger in either state. *(highest severity)***
Evidence: `6e933d9` §D1, `lib/ai/forecast/statements.ts` (+37/−…), `lib/reasoning/figures/magnitude.ts` (new, 107 lines).
The magnitude suffix group `([kKmM])?` had no right-hand boundary, so it ate the leading letter of the following word:

- `"Assume I spend $5,000 monthly"` → spending level of **$5,000,000,000/month**
- `"I pay $1,200 mortgage"` → **$1,200,000,000**
- `valueOf("$50 million")` → **$50**

The commit is explicit that `AI_ANSWER_MODE` was **not** the containment here: the bug lived in four parsers and one of them feeds the forecast **engine on the path serving users today**. Every prior audit in this series — including yesterday's — described the reasoning work as "dark behind an unset flag." That mitigation was partly false, and STATUS.md has no record of the exposure window (the parser dates to the FORECAST arc, 08-27 onward) or its closure.
→ **Suggested correction:** open one KD, milestoned v2.6a, *closed on arrival*: "**KD-23 — magnitude-suffix over-scaling in stated-figure parsers.** Unbounded `[kKmM]` suffix scaled `$5,000 monthly` to $5B and downgraded `CURRENCY_PER_MONTH`→`CURRENCY`; reached the live forecast engine via `lib/ai/forecast/statements.ts`, i.e. *not* contained by `AI_ANSWER_MODE`. Grammar consolidated to `lib/reasoning/figures/magnitude.ts` with a positional rule + alphabet-sweep property test. Closed `6e933d9`." A defect that touched users deserves a ledger row even when it closes the same day.

**2. Yesterday's eight-defect NO-GO is now a GO-pending, and STATUS.md tracks neither end of it.**
Evidence: `6e933d9` closes D1, D2 (absolute-value sign equivalence in `verify.ts` — an overdraft narrating as a surplus), D3 (`systemAssumptions` computed then dropped, plus the misattribution that labelled a system fallback with the *user's* assumption), D4 (`Claim.frame: 'FACT' | 'ASSUMPTION'`, so a PREMISE can no longer be asserted as a MEASURE), D7 (typed call moved inside the route try/catch), and anti-vacuity (`{claims: [], prose: "You are on track…"}` no longer verifies clean). Seven mutation tests, seven reds. `NO FLAG CHANGED`.
Residual: **D8 (Slice 6 master-surfaces headline) is not addressed in this commit** and remains open; `ai:forecast-conformance typed` moved 31/35 → 29/35, which the commit argues is framing + one 429, not a regression.
→ **Suggested correction:** add a *Recently landed* clause — "**V26-REASONING Slice 8** (`6e933d9`): the five typed-path blockers from [V26-POST-IMPLEMENTATION-AUDIT](docs/plans/V26-POST-IMPLEMENTATION-AUDIT.md) §12, each reproduced before it was touched" — and a single open ledger row for D8 + the 29/35 corpus reconciliation.

**3. The prior blocker's code half is now closed; only the config act survives.**
Evidence: `lib/env.ts:178,188` — `AI_ASSESSMENT_GUARD_MODE` and `AI_FORECAST_GUARD_MODE` are both registered in the env surface (done in Slice 0, confirmed at HEAD); `.env.example:177` ships `AI_FORECAST_GUARD_MODE=repair`. What remains is purely operational: `vercel.json` still has no `env` block, so nothing in-repo evidences the Production value. Unset ⇒ `shadow` ⇒ the 8-violations-per-run posture FORECAST-15's acceptance rejected.
→ **Suggested correction:** promote to a numbered Blocker, narrowed: "**Set `AI_FORECAST_GUARD_MODE=repair` in Vercel Production** — registered in `lib/env.ts`, defaults to non-enforcing `shadow`. Config act only." Flagged 08-26, 08-27, 08-30, 08-31, 09-01, 09-02 — **seventh cycle**.

**4. Resolved from yesterday — worth recording as closed.** All three previously-untracked audit documents (`STATUS-DRIFT-AUDIT-2026-09-01.md`, `-09-02.md`, `V26-POST-IMPLEMENTATION-AUDIT.md`) were committed in `6e933d9`. Working tree is clean. No action.

## Inverse drift (STATUS says open / not-started but git shows shipped)

- **STATUS.md:45 "conversationId is the major unbuilt AI layer"** — re-verified at HEAD: still zero `conversationId` occurrences in `lib/ai/`, `lib/reasoning/`, `app/api/ai/`. But the *design* was rejected by name (FORECAST-13, REASONING-4); the lifecycle is derived per turn. The sentence describes an absence the repo chose. → rewrite, don't update. *Third cycle.*
- **KD-8 "master-mode unbounded prompt"** — superseded by PARITY-2 and REASONING-6; "unbounded" is now the wrong word. → restate or close. *Fourth cycle.*
- **KD-16** (window re-derivation per turn, by design) — unchanged. **Eighth** cycle carried. → close or restate.
- **KD-14** (`AiAdvice` no production write path) — re-verified accurate. Correctly open.
- **KD-15** — enforced in code, absent from the ledger in either state. Standing since 08-20.

## Carried from prior audits — still unremediated

STATUS.md untouched for 17 days; all verbatim:

- **STATUS.md:60** cites `app/api/spaces/[id]/goals/route.ts:62` as live evidence — **re-confirmed today: file does not exist.** Self-marked "kept for one cycle, then delete"; kept for **nine**.
- **STATUS.md:7 "88 migrations"** → actual **101**, incl. `20260826232626_position_coverage_licence`.
- **STATUS.md:42** hard-codes 492/492 · 18/18 · 339/339 → **517/517 · 21/21** at HEAD. The same line already contains a claim-correction paragraph explaining that hard-coded suite counts are unreproducible. → replace with "see `npm run test:unit`". *Fifth cycle.*
- No *Recently landed* clause for W1–W6f, A1–A6, W-M0→W-M3a, ETH-H1/H2, UI-C1/C2, PRODUCT-C1, CF-1→CF-12, FORECAST-1→17, PARITY-1→3, PROJECTION-1→3, REASONING-0→**8**. That is ~150 commits across 17 days.
- Blockers still missing `AI_ASSESSMENT_GUARD_MODE` and `ALCHEMY_API_KEY` / `ETH_RPC_URL` / `SOL_RPC_URL` (absent ⇒ ETH/SOL DARK).
- **Documentation map (line 72)** lists 11 subsystem docs; `docs/systems/` now holds 16. Missing: `crypto-networks.md`, `forecast.md`, `model-tier.md`, `planner.md`, `reasoning-layer.md`.
- `HOUSEHOLD` enum residue, DEBT-1, ops observability restore (`ce360b8`), W2 schema residue.
- 08-30 item: open a KD for the CF-11 planner NOT_NEEDED mis-route ("biggest purchase last month?" → three correct-but-irrelevant balances, no refusal, no telemetry). Still valid, still unapplied.

---

*Report-only. STATUS.md was not edited.*
