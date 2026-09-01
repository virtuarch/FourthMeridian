# STATUS.md drift audit — 2026-08-23

**Scope:** HEAD `90af178` (branch `v2.6`, 2026-08-22 21:26) vs STATUS.md as committed at `9ea50a5` (2026-08-17).
**Verdict: 2 new commits since the last audit (both after it ran), both unmentioned. STATUS.md is still unchanged — every item from 08-20 through 08-22 remains unremediated. No new inverse drift.**

| Check | 2026-08-22 | 2026-08-23 |
|---|---|---|
| HEAD | `fca5e01` (08-22 16:47) | `90af178` (08-22 21:26) |
| STATUS.md last touched | `9ea50a5`, 08-17 | unchanged (6 days) |
| New commits since last audit | 9 | **2** |
| New committed `.md` docs | 0 | **0** |
| Migration dirs | 100 | 100 (STATUS.md:7 still says 88) |

Keyword check against STATUS.md — all **zero hits**: `A2`, `trajectory`, `assessment-contract`, `divergentSignals`, `W6`, plus every carry-over (`W1`, `W2`, `W5`, `scopeHint`, `ASSESSMENT_WINDOW`, `INV-19`, `DEBT-1`, `KD-15`, `FAMILY`). *(The single `A1` hit is `A10 investments` on line 60, a false positive.)*

---

## New drift (this cycle)

**1. A1 — deterministic assessment contract pinned.**
`24b1ac3` — `lib/ai/intelligence/assessment-contract.test.ts` (+267, no source change). Declares the ten graded dimensions and the COMPLETE verdict set each may return, checked against `annotations/types.ts` so **coverage cannot widen by merge**. Pins that `computeAssessment` is idempotent, is a function of its facts alone, and cannot be moved by context no grade reads; an empty context refuses every dimension with a DATA gap, never a scope choice.
→ This is a governance contract on AI grading — exactly the subject matter STATUS tracks under **KD-8/KD-16**. Neither row moved.
→ **Suggested correction:** add a *Recently landed* clause naming A1 as the declared-coverage contract for assessment grading; note that widening the graded set is now a deliberate act.

**2. A2 — trajectory assessment shipped as a graded dimension.**
`90af178` (8 files, +564/−4): new `trajectory` verdict derived from `SpendingTrendsSection`, net as arbiter, `divergentSignals` for counter-headline components, `MIXED` reserved for flat net from offsetting material moves; refusal via `ungraded[]` + `INSUFFICIENT_COMPLETE_MONTHS`; serializer emits the block even when refused; deliberately *not* wired into `currentStatePriority`/risks/opportunities. Joins `scripts/audit-brief-assessment-parity.ts` cross-scope diff (16/16 graded).
→ **This is a new claim the product makes about someone's finances**, and STATUS.md's AI section (line 45) still describes only "deterministic substrate strong; conversational persistence is the major unbuilt layer."
→ **Suggested correction:** add trajectory to *Recently landed*, and update line 45 — the deterministic substrate materially widened this cycle.

**3. Suite/audit figures moved again.**
A1 reports 461/461 unit · 21/21 REQUIRED; A2 reports 462/462 · 21/21. The REVIEW-3 report linked from STATUS.md:10/42 still carries "492/492 tests, 18/18 REQUIRED audits" (`def2292`).
→ **Suggested correction:** as last cycle — no STATUS body change (line 42 already defers to `npm run test:unit`), but a "figures superseded" marker where REVIEW-3 is linked would stop the stale numbers being re-cited.

**4. `_to_delete/` has grown again — and now holds W6 work.**
11 execution/decision `.md` records (W1–W5 + PHASE1 forensics + TSWAVE) plus three probe scripts, two dated 2026-08-22 20:43–20:44 and named `_probe-w6-ownership.ts` / `_probe-w6-preflight.ts`. Still gitignored (`.gitignore:97`), still unreachable from any committed doc.
→ Escalation of the same item flagged 08-21 (2 files) and 08-22 (8 files). **W6 is now being scoped entirely outside git and outside STATUS.** Highest-leverage act in this report, unchanged: extract or `git add` before the folder is deleted.

**5. Uncommitted AI-doctrine work in the tree (not drift yet — flagged so it doesn't become drift).**
Modified: `lib/ai/prompts/doctrine.ts` (+44/−2), `lib/ai/prompts/system-prompt.ts` (+13). Untracked: `lib/ai/prompts/authority-precedence.test.ts`. Reads as an in-flight A3/authority-precedence slice.
→ No correction needed today; note it so next cycle can tell "landed and unrecorded" from "still in progress."

## Inverse drift (STATUS says open / not-started but git shows shipped)

**None newly found this cycle.** Items 1–2 are unrecorded rather than mis-recorded. Two standing candidates, both re-confirmed:

- **KD-16** (window re-derivation) — W4's single `ASSESSMENT_WINDOW_DAYS` (`f03b4bc`) plus A1's determinism pin means the window clause is very likely fully closable now. Still carried as open. *Worth an explicit re-read before the next cycle — this is the closest thing to a live TI2-shaped case.*
- **KD-15** — the standing 08-20 case: checklist says "awaiting approval, no application code changes"; `TRANSACTION_DETAIL_VISIBILITY` is enforced across read paths today, and KD-15 appears in no STATUS ledger, open or closed.
- **KD-14** (`AiAdvice` no production write path) — spot-checked, still accurate; refs are read/export/purge paths only.

## Carried from prior audits — still unremediated

All items from [`STATUS-DRIFT-AUDIT-2026-08-22.md`](STATUS-DRIFT-AUDIT-2026-08-22.md) and [`2026-08-20`](STATUS-DRIFT-AUDIT-2026-08-20.md), unchanged because STATUS.md has not been touched since 08-17:

- **W2 Goals/Retirement retirement** — and the resulting **false line: STATUS.md:60 still cites deleted `app/api/spaces/[id]/goals/route.ts:62` as live evidence.** That block is self-marked "kept for one cycle, then delete" — deleting it is the fix.
- **W3/W3.1/W4 brief assessment authority**, **W5 crypto current-value authority** — no *Recently landed* clause for either.
- **W1 transaction-identity/FAMILY wave** (now 5 days old), `HOUSEHOLD` enum residue, **DEBT-1**, ops observability restore (`ce360b8`).
- **STATUS.md:7 "88 migrations"** — actual directory count is **100**.
- Deliberate schema residue from W2 (`SpaceGoal`/`GoalCheckIn`/`GoalContribution` + enums held until the migration train) still lives only in a commit message.

---

*Report-only. STATUS.md was not edited.*
