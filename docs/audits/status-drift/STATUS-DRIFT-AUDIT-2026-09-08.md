# STATUS.md drift audit — 2026-09-08

**Scope:** HEAD `4f481b7` (branch `v2.6`, 2026-09-08) vs STATUS.md as committed at `95512bb` (2026-09-07).
**Verdict: 11 new commits in one cycle, including a real production schema migration (`SpaceMemory`) and two edits to the "untouched" deterministic substrate. STATUS.md has no mention of any of it. This is the TI2 pattern reproducing — schema + tests + docs shipped, doc silent.**

| Check | 2026-09-07 | 2026-09-08 |
|---|---|---|
| HEAD | `2d5f533` | `4f481b7` |
| STATUS.md last touched | `95512bb`, 09-07 | unchanged |
| New commits since last audit | 5 | **11** |
| Migrations on disk | 101 | **103** (STATUS:7 still says **88**) |
| `docs/systems/` docs | 13 (STATUS lists 11) | 13 (unchanged) |
| New `.md` plan docs | 3 | **4** |
| Untracked audit reports | 3 | **4** (`-09-03`, `-09-04`, `-09-06`, `-09-07`) |

Keyword check against STATUS.md — all zero hits: `SpaceMemory`, `memory`, `scenario ledger`, `goal seek`, `compaction`, `baseline harness`, `gpt-5`, `cost`, `FORECAST`, `REASONING`, `PARITY`, `PROJECTION`.

---

## New drift (this cycle)

**D1. A real schema migration shipped with zero STATUS mention. *(highest severity — TI2 pattern)***
`50de1aa` `experiment(ai): SpaceMemory — user-owned within a Space (slice 6)` adds migration `prisma/migrations/20260907234638_space_memory_user_owned/` (two new enums `MemoryKind`, `MemoryStatus`; new `model SpaceMemory`), `prisma/schema.prisma` +102 lines, plus `memory-store.ts` (252 lines), `memory-tools.ts`, and a 162-line invariant check. The commit is labelled `experiment(...)`, but the migration is in the canonical migration chain and the model is in the production schema — it will apply on the next deploy.
→ **Suggested correction:** add to *Recently landed*: "**`SpaceMemory` (`50de1aa`)** — user-owned memory within a Space (`MemoryKind`/`MemoryStatus`, migration `20260907234638_space_memory_user_owned`), landed as part of the AI redesign baseline. Schema is live; no production write path yet." And raise the migration count.

**D2. STATUS:45's claim that the deterministic substrate is "untouched" is now false twice over.**
`597745a` edits `lib/ai/assemblers/transactions.ts` (rank a whole window, not its newest page) and `edcfae5` edits `lib/ai/provider.ts` (+43/−…, A2 tool-contract tuning). Both are production `lib/` files, not harness scripts. This repeats N2 from the 09-07 audit (`02b7448`), so it is now a pattern rather than a one-off.
→ **Suggested correction:** rewrite the AI bullet clause to "the deterministic substrate survived the reset and is being actively corrected and tuned against the baseline harness" and name `597745a`, `edcfae5`, `02b7448`.

**D3. Five experiment slices built a scenario/memory reasoning stack that STATUS doesn't know exists.**
`e6ea0f2` (as-of coherence + information ceiling, slices 1–3), `b6c7cf1` (deterministic scenario ledger over the cash spine, `scenario-ledger.ts` 590 lines), `0b6d794` (goal seek), `50de1aa` (SpaceMemory), `666cf6f` (checkpoint-on-projection + reconciliation). ~4,200 net lines across `scripts/ai-baseline/**` with tests in `baseline.test.ts`.
→ **Suggested correction:** one *Recently landed* line — "AI redesign baseline: seven slices (`e6ea0f2`→`666cf6f`) — as-of coherence, scenario ledger, goal seek, SpaceMemory, checkpoint/reconcile — [plans/AI-BETA-REASONING-MEMORY-INVESTIGATION.md](docs/plans/AI-BETA-REASONING-MEMORY-INVESTIGATION.md)."

**D4. A named beta blocker was identified *and closed* in the same cycle, and appears in neither the Blockers list nor the ledger.**
`docs/plans/AI-BETA-REASONING-MEMORY-INVESTIGATION.md` §412–423 names a `get_net_worth_history.cash` / `liquid` naming collision as "the beta blocker's root cause"; slices 1–3 (`e6ea0f2`) closed it (the doc records the corrected `$9,517 liquid / $37,316 debt` first-answer result).
→ **Suggested correction:** either record it as a closed KD (so the fix is traceable) or add a landed clause. A blocker that exists only inside a plan doc is invisible to the Blockers section by construction.

**D5. Three new investigation docs describing finished analysis, unreferenced.**
`cf729e8` `AI-CONVERSATION-DOGFOOD-TUNING.md` (405 lines), `d1ecff0` `AI-BETA-COST-ECONOMICS-INVESTIGATION.md` (819 lines), `4f481b7` `AI-COST-CLIP-4-GPT-5-1-EVALUATION.md` (458 lines, verdict **DO NOT ADOPT — CONDITIONAL**, gpt-5.1 79.4% cheaper / 52% faster but fails 4 of 7 decision gates; default model stays `gpt-5.5`).
→ **Suggested correction:** add a line to the AI bullet — "model/cost economics evaluated (`d1ecff0`, `4f481b7`); default remains `gpt-5.5`, gpt-5.1 evaluated and not adopted."

**D6. `ccd6fa9` context compaction (Clip 6)** — `compaction.ts` (157 lines) + probes, garbage-collecting old tool payloads. Unmentioned.
→ Fold into the D3 line.

---

## Inverse drift (STATUS says open / not started; git shows shipped)

- **STATUS.md Next step 3 — "Design the replacement conversation layer from exemplar conversations… not before the exemplars exist."** Carried from 09-07 and now much worse: not only do the exemplars exist, seven design slices have been built and measured on top of them, with a schema migration. The roadmap reads as *not started* on work that is well underway. → Restate as "in progress — seven slices landed against the golden corpus; open question is which slices graduate from `scripts/ai-baseline/` into `lib/`."
- **STATUS.md:45 "no replacement architecture has been chosen"** — literally still true (nothing has graduated into `lib/`), but the shape has been substantially chosen and exercised: tool contracts, scenario ledger, memory model, compaction. → Soften rather than delete.

## Carried, re-verified at HEAD

| # | Finding | Evidence today | Cycles |
|---|---|---|---|
| 1 | No *Recently landed* clause for the post-REVIEW-3 arcs (W / A / CF / FORECAST-1→17 / PARITY-1→3 / PROJECTION-1→3 / REASONING-0→8) | 119 commits in `9ea50a5..HEAD`; 0 keyword hits in STATUS.md | ongoing |
| 2 | STATUS.md:7 "88 migrations" | **103** on disk | 12th |
| 3 | STATUS.md:60 cites `app/api/spaces/[id]/goals/route.ts:62` | file still does not exist; block self-marked "delete after one cycle" | 14th |
| 4 | Documentation map lists 11 subsystem docs; `docs/systems/` holds 13 | missing `crypto-networks.md`, `forecast.md` | 9th |
| 5 | Blockers omit `ALCHEMY_API_KEY` (absent ⇒ ETH/SOL history DARK) | `lib/env.ts` | 9th |
| 6 | KD-15 never entered the ledger | `grep KD-15 STATUS.md` → 0 | standing since 08-20 |
| 7 | KD-14 (`AiAdvice` no production write path) | re-verified — correctly open | — |
| 8 | Audit reports untracked | now **4** (`-09-03`, `-09-04`, `-09-06`, `-09-07`) | 4th |

---

## Suggested minimum edit

1. Line 7: `88 migrations` → **103**, and name `20260907234638_space_memory_user_owned` as the newest.
2. One *Recently landed* line for the seven baseline slices + the `SpaceMemory` schema (D1, D3).
3. Fix STATUS:45 — the substrate is being corrected, not untouched (D2).
4. Restate Next step 3: the redesign is in progress, not blocked on exemplars.
5. Still outstanding from every prior cycle: the post-REVIEW-3 *Recently landed* paragraph, the stale goals-route citation, and the doc map.
6. Commit the four untracked audit reports.

*Report-only audit — no STATUS.md edits made.*
