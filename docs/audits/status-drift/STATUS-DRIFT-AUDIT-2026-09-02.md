# STATUS.md drift audit — 2026-09-02

**Scope:** HEAD `f94237e` (branch `v2.6`, 2026-09-01 07:32) vs STATUS.md as committed at `9ea50a5` (2026-08-17).
**Verdict: zero new commits this cycle — the first quiet day since 08-20. But the drift got worse anyway: an untracked 40KB post-implementation audit landed today (`docs/plans/V26-POST-IMPLEMENTATION-AUDIT.md`, mtime 09-02 18:07) that names **eight defects, five of them blockers**, in the `lib/reasoning/**` layer — including a magnitude parser that turns "I spend $5,000 monthly" into a licensed **$5,000,000,000**, and a verifier that accepts a sign flip so a projected overdraft narrates as a surplus. None of the eight is in the KD ledger. STATUS.md is 16 days stale.**

| Check | 2026-09-01 | 2026-09-02 |
|---|---|---|
| HEAD | `f94237e` (09-01 07:32) | unchanged |
| STATUS.md last touched | `9ea50a5`, 08-17 | unchanged (**16 days**) |
| New commits since last audit | 10 | **0** |
| New env keys | 4 | 0 |
| Migrations on disk | 101 | 101 (STATUS.md:7 still says **88**) |
| New `.md` docs | 14 committed | **1, untracked** (`V26-POST-IMPLEMENTATION-AUDIT.md`) |
| Untracked audit files | 1 | **2** (09-01 drift audit + the post-impl audit) |

Keyword check against STATUS.md — all still **zero hits**: `REASONING`, `reasoning-layer`, `MeasureId`, `answer boundary`, `planner`, `FORECAST`, `PARITY`, `PROJECTION`, `AI_ANSWER_MODE`, `typed`.

---

## New drift (this cycle)

**1. Eight named defects — five blockers — with no ledger entry anywhere. *(highest severity)***
Evidence: `docs/plans/V26-POST-IMPLEMENTATION-AUDIT.md` §12, auditing `dd846fc`→`f94237e`. Verdict is **NO-GO on `AI_ANSWER_MODE=typed`, `AI_REASONING_PATH=new`, `AI_PROMPT_SHAPE=minimal`**.

| Ref | Defect | Sev |
|---|---|---|
| D1 | `premise.ts:67` `MONEY_RE` suffix group lacks `\b` → `"$5,000 monthly"` = **$5,000,000,000**, plus a `CURRENCY_PER_MONTH`→`CURRENCY` unit downgrade. `premiseFigures` is ungated over every user turn. | CRITICAL |
| D2 | `verify.ts:98` `\|\| q(parsed) === q(Math.abs(f.value))` → a `−4000` figure verifies against `"$4,000.00"`. Forced, because `renderFigure` emits the malformed `$-4,000.00`. | CRITICAL |
| D3 | `evaluate.ts:439` is a no-op spread; `fallbacks` is write-only, so a system assumption is invisible in the answer it prices. `table.ts:356` then labels it with the *user's* unrelated assumption. | HIGH |
| D4 | `verifyAnswer` never reads `f.kind` → a PREMISE stock is assertable as a MEASURE. | HIGH |
| D5–D8 | False invariant comment (`figures/types.ts:120-122`); no anti-vacuity (`claims: []` + confident prose passes); `answerThisTurn` outside the route try/catch; Slice 6 headline not shipped (`master-surfaces.ts` byte-identical to base). | MED |

Mitigating and worth recording alongside: **the whole 5,096-line layer is dark** — `AI_ANSWER_MODE` is unset, so none of this reaches users today.
→ **Suggested correction:** open KD entries for D1–D4 (or one KD "V26-REASONING typed-path blockers, layer dark behind `AI_ANSWER_MODE`") milestoned v2.6a, and add a *Next steps* line: "Phase 0 — the five typed-path blockers (~1 day) before any flag flip."

**2. The one GO in that audit is a production act STATUS.md's Blockers section still doesn't list.**
Its single unambiguous recommendation: *confirm `AI_FORECAST_GUARD_MODE=repair` in Vercel, and add it plus `AI_ASSESSMENT_GUARD_MODE` to `validateEnv()`*. `vercel.json` has no `env` block, so nothing in the repo can evidence the value. Unset ⇒ `shadow` ⇒ the 8-violations-per-run posture FORECAST-15's own acceptance rejected.
→ **Suggested correction:** promote to a numbered Blocker: "**Set `AI_FORECAST_GUARD_MODE=repair` in Vercel Production** — default `shadow` serves known-wrong arithmetic by design. Config act, not code." Flagged 08-26, 08-27, 08-30, 08-31, 09-01 — **sixth cycle**.

**3. Two audit documents are untracked.**
`docs/audits/status-drift/STATUS-DRIFT-AUDIT-2026-09-01.md` and `docs/plans/V26-POST-IMPLEMENTATION-AUDIT.md` both show `??`. The eight audits before them were committed on 09-01 — good — but the pattern reopened immediately. A NO-GO verdict that exists only in an uncommitted file is one `git clean` from gone.
→ **Suggested correction:** commit both; link the post-impl audit from *Recently landed*.

## Inverse drift (STATUS says open / not-started but git shows shipped)

Re-verified at HEAD, unchanged from 09-01:

- **STATUS.md:45 "conversationId is the major unbuilt AI layer"** — literal fact still holds (no `conversationId` in `lib/ai/`, `app/api/ai/`, or `lib/reasoning/`), but FORECAST-13 and REASONING-4 **rejected the store by name**; the ACTIVE/SUPERSEDED/DISMISSED lifecycle is derived per turn and pinned by `lifecycle.test.ts:189-191`. The sentence points at a design the repo has declined. → rewrite, don't just update.
- **KD-8 "master-mode unbounded prompt"** — rewritten twice over by PARITY-2 and REASONING-6 (cross-Space dedup composition). "Unbounded" is the wrong word. → restate or close. *Third cycle.*
- **KD-16** (window re-derivation per turn) — unchanged. **Seventh** cycle carried. → close or restate.
- **KD-14** (`AiAdvice` no production write path) — re-verified accurate. Correctly open.
- **KD-15** — standing 08-20 case: enforced in code, absent from the ledger in either state.

## Carried from prior audits — still unremediated

STATUS.md untouched for 16 days, so all of these stand verbatim:

- **STATUS.md:60** cites `app/api/spaces/[id]/goals/route.ts:62` as live evidence — **re-confirmed today: the file does not exist.** Self-marked "kept for one cycle, then delete"; kept for **eight**.
- **STATUS.md:7 "88 migrations"** → actual **101**, incl. the unapplied-against-prod `20260826232626_position_coverage_licence`.
- No *Recently landed* clause for W1–W6f, A1–A6, W-M0→W-M3a, ETH-H1/H2, UI-C1/C2, PRODUCT-C1, CF-1→CF-12, FORECAST-1→17, PARITY-1→3, PROJECTION-1→3, **REASONING-0→7**.
- Hard-coded suite figures (492/492, 18/18, 339/339) vs 516/516 · 21/21 at HEAD. → replace with "see `npm run test:unit`". *Fourth cycle.*
- Blockers still missing `AI_ASSESSMENT_GUARD_MODE` and `ALCHEMY_API_KEY` / `ETH_RPC_URL` / `SOL_RPC_URL` (absent ⇒ ETH/SOL DARK).
- Documentation map (line 72) still omits `crypto-networks.md`, `forecast.md`, `model-tier.md`, `planner.md`, `reasoning-layer.md` — five subsystem docs now exist that the map doesn't list.
- `HOUSEHOLD` enum residue, DEBT-1, ops observability restore (`ce360b8`), W2 schema residue.
- 08-30 item: open a KD for the CF-11 planner NOT_NEEDED mis-route. Still valid, still unapplied — and §5 of today's audit deepens it: *"what was my biggest purchase last month?"* returns three correct-but-irrelevant balances with **no refusal and no telemetry**.

---

*Report-only. STATUS.md was not edited. Working tree carries three untracked files including this one.*
