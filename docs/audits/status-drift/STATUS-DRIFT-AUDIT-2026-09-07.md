# STATUS.md drift audit — 2026-09-07

**Scope:** HEAD `2d5f533` (branch `v2.6`, 2026-09-07) vs STATUS.md as committed at `95512bb` (2026-09-07, the AI-reset commit).
**Verdict: STATUS.md moved for the first time in 21 days and several long-carried findings are genuinely closed. But it was updated *only* for the AI reset — the five commits that landed after it the same day are already unrecorded, and the 102-commit FORECAST/REASONING backlog is untouched.**

| Check | 2026-09-06 | 2026-09-07 |
|---|---|---|
| HEAD | `6e933d9` (09-02) | `2d5f533` (09-07) |
| STATUS.md last touched | `9ea50a5`, 08-17 (20 days) | **`95512bb`, 09-07 (same day)** |
| Commits in `9ea50a5..HEAD` | 102 | 108 |
| Commits after the STATUS update | — | **5** |
| Migrations on disk | 101 (STATUS says 88) | 101 (STATUS:7 still says **88**) |
| `docs/systems/` docs | 16 (STATUS lists 11) | **13** (STATUS:72 still lists **11**) |
| Untracked files | 2 | 3 (09-03, 09-04, 09-06 audit reports) |

---

## Closed this cycle — do not carry forward

Re-verified at HEAD; the AI conversation reset (`95512bb`) remediated these:

- **KD-8 / KD-16** — both restated and marked closed in the ledger. Correct.
- **`conversationId` inverse drift** (6 cycles) — STATUS:45 now frames it as a question for the next design, not an unbuilt backlog item. 0 occurrences in code. Correct.
- **`AI_FORECAST_GUARD_MODE` / `AI_ASSESSMENT_GUARD_MODE` config-act blockers** (10 and 7 cycles) — both flags were *deleted* from `lib/env.ts` (now a comment block at `lib/env.ts:169-180` naming all six removed flags). No longer a config act. Moot.
- **KD-23 magnitude over-scaling** (4 cycles) — `lib/reasoning/` no longer exists; `magnitude.ts` gone. Moot.
- **CF-11 planner mis-route / D8 residual** (8 and 4 cycles) — no planner exists in the repo. Moot against the removed layer; re-open only if the replacement reproduces them.
- **Hard-coded suite counts (492/492 · 18/18 · 339/339)** — STATUS:42 now carries the V26-PRE B5 correction and defers to `npm run test:unit`. Closed.
- **`ETH_RPC_URL` / `SOL_RPC_URL` blockers** — neither key exists in `lib/env.ts` any more. Only `ALCHEMY_API_KEY` survives (see below).

---

## New drift (this cycle)

STATUS.md was written at `95512bb` and five commits landed on top of it the same day. All five are shipped work; none is mentioned.

| # | Evidence | Suggested correction |
|---|---|---|
| N1 | **`c5ce686` `redesign(overview): consolidate net worth assets and debt`** — 31 files, +2,228/−372: new `lib/wealth/wealth-mode.ts`, `wealth-trend-points.ts`, `lib/perspectives/overview-lenses.test.ts`, reworked `WealthWorkspace`/`WealthHero`/`WealthTrendChart`, `use-space-navigation.ts`. Plus two new plan docs: `docs/plans/OVERVIEW-UI-CONSOLIDATION.md`, `OVERVIEW-UI-INVENTORY.md` (645 lines). STATUS's only "Overview" mention is REVIEW-3 *deleting* the old Overview canvas. | Add to *Recently landed*: "**Overview consolidation (`c5ce686`)** — net worth assets and debt consolidated into one wealth workspace; `lib/wealth/wealth-mode.ts` is the mode authority — [plans/OVERVIEW-UI-CONSOLIDATION.md](docs/plans/OVERVIEW-UI-CONSOLIDATION.md)." |
| N2 | **`02b7448` `fix(ai-data): preserve investment concentration scope`** — 8 files, +612/−58 in `lib/ai/assemblers/` (new `holdings-scope.test.ts`, 248 lines; `holdings-core.ts` reworked; `lib/ai/types.ts` +139). A correctness fix inside the surviving deterministic substrate, which STATUS:45 explicitly claims is "untouched". | Add a one-line landed clause, and soften STATUS:45 — the substrate survived the reset but is being *corrected*, not frozen. |
| N3 | **`49c6884`, `34ffcaf`, `2d5f533`** — investigation + golden conversations, then a model-first conversation baseline harness with interactive operator mode. New docs: `AI-CONVERSATION-INVESTIGATION.md`, `AI-CONVERSATION-GOLDENS.md`, `AI-CONVERSATION-BASELINE-HARNESS.md`. | Add to *Recently landed* / update the AI bullet: the exemplar corpus and a baseline harness now exist; the redesign has an evidence base. |

---

## Carried, re-verified at HEAD today

| # | Finding | Evidence re-verified today | Cycles |
|---|---|---|---|
| 1 | **No *Recently landed* clause for the six post-REVIEW-3 arcs** — W1–W6f, A1–A6, ETH-H1/H2, UI-C1/C2, PRODUCT-C1, CF-1→CF-12, FORECAST-1→17, PARITY-1→3, PROJECTION-1→3, REASONING-0→8 | 108 commits in `9ea50a5..HEAD`; keyword check on STATUS.md: `FORECAST` 0, `REASONING` 0, `PARITY` 0, `PROJECTION` 0 hits. **The reset did not delete this arc** — `lib/forecast/` (engine, cadence, obligation, projection…) is intact with tests, and `AI_FORECAST_PROJECTION` is a live shipped flag (`lib/env.ts:193`). | ongoing |
| 2 | **STATUS.md:7 "88 migrations"** | **101** on disk | 11th |
| 3 | **STATUS.md:60 cites `app/api/spaces/[id]/goals/route.ts:62`** as live KD-21 evidence | file **does not exist** (Goals retired `9352e41`). The block self-marks "kept one cycle, then delete" — delete it | 13th |
| 4 | **Documentation map (STATUS:72) lists 11 subsystem docs**; `docs/systems/` holds **13** | missing `crypto-networks.md`, `forecast.md`. (Count fell from 16 — the reset deleted `planner.md`, `reasoning-layer.md`, `model-tier.md`.) | 8th |
| 5 | **Blockers list omits `ALCHEMY_API_KEY`** (absent ⇒ ETH/SOL history DARK) | `lib/env.ts:63,520` confirmed live | 8th |
| 6 | **KD-15 never entered the ledger** — enforced in code, `docs/initiatives/kd15/KD-15_IMPLEMENTATION_CHECKLIST.md` exists; `grep KD-15 STATUS.md` → 0 | unchanged | standing since 08-20 |
| 7 | **KD-14** (`AiAdvice` no production write path) | re-verified — `lib/data/advice.ts` reads only, no `create` outside seed. **Correctly open.** | — |
| 8 | Housekeeping: **three audit reports exist only in the working tree** (`-09-03`, `-09-04`, `-09-06`) | `git status --porcelain` | 3rd |

## Inverse drift (STATUS says open / not-started; git shows otherwise)

- **STATUS.md:36, Next step 3** — "Design the replacement conversation layer from exemplar conversations… **not before the exemplars exist**." The exemplars now exist (`49c6884` goldens + investigation) and a baseline harness has been run twice (`34ffcaf`, `2d5f533`). → The precondition is met; restate the step as "design from the landed golden corpus", or the roadmap reads as blocked on work that shipped the same day.
- **STATUS.md:41 v2.6 bullet** describes the lens/explorer surface as settled, but `c5ce686` reshaped the Overview/Wealth workspace on top of it. → Reconcile the "Where things stand" v2.6 paragraph with the consolidation.

---

## Suggested minimum edit

If only one STATUS.md pass happens:

1. Add a *Recently landed* paragraph naming the post-REVIEW-3 arcs (W / A / CF / FORECAST / PARITY-PROJECTION / REASONING) with their plan docs — still the single largest gap, 102 commits deep.
2. Add today's five: Overview consolidation (`c5ce686`), holdings-scope fix (`02b7448`), goldens + baseline harness (`49c6884`, `34ffcaf`, `2d5f533`).
3. Line 7: `88 migrations` → `101`.
4. Delete the stale KD-21/KD-22 "closed since last reconciliation" block (lines 58–61) — it cites a deleted file.
5. Line 36: the exemplars exist; restate Next step 3.
6. Line 72: add `crypto-networks` and `forecast` to the subsystem list.

*Report-only audit — no STATUS.md edits made.*
