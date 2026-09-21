# STATUS.md drift audit — 2026-09-12

**Scope:** HEAD `0c0a84b` (branch `v2.6`) vs STATUS.md as committed at `95512bb` (2026-09-07).
**Verdict: no new drift. Zero commits in three days — HEAD unchanged since 2026-09-09 04:58. Every prior finding re-verified and still uncorrected; STATUS.md is now 5 days / 32 commits stale, including 3 unmentioned production migrations.**

| Check | 2026-09-11 | 2026-09-12 |
|---|---|---|
| HEAD | `0c0a84b` | `0c0a84b` (unchanged) |
| STATUS.md last touched | `95512bb`, 09-07 | unchanged (6 cycles stale) |
| New commits since last audit | 0 | **0** |
| Migrations on disk | 104 | 104 (STATUS:7 still says **88**) |
| Untracked audit reports | 6 | **7** |

---

## New drift (this cycle)

**None.** No commits, no new `.md` docs, no migrations, no working-tree changes outside this audit directory. Nothing to report that wasn't already reported.

**One correction to the prior report:** the 09-09 and 09-11 audits both stated "27 commits since STATUS.md's last touch." The actual count is **32** (`git rev-list --count 95512bb..HEAD`). Findings are unaffected; the figure was understated.

---

## Carried, re-verified at HEAD (all still uncorrected)

| # | Finding | Evidence today | Cycles |
|---|---|---|---|
| 1 | **32 commits since STATUS.md's last touch, zero reflected.** Four `feat(ops)` cost-accounting slices (`26ca0b9`→`2ae717d`), `SpaceMemory` (`50de1aa`), `transactionCorpusSpan()` on the TX read authority (`55a2c22`), seven AI baseline slices, 19 new/changed docs under `docs/`. | `git log 95512bb..HEAD` | 4th–6th |
| 2 | **Three unmentioned production migrations** — `20260907234638_space_memory_user_owned`, `20260908222415_ai_invocation`, `20260908224119_plaid_item_environment`. All in the canonical chain; all apply on next deploy. | `prisma/migrations/` | 4th |
| 3 | STATUS:7 "88 migrations" | **104** on disk | 15th |
| 4 | STATUS:45 "the deterministic substrate is untouched" — false: 11 files / +900/−65 under `lib/ai/` since `95512bb`, incl. `provider.ts` (+207), `types.ts`, `assemblers/holdings-core.ts`, `assemblers/transactions.ts`, `forecast/assemble.ts`, plus two new modules (`invocation.ts`, `invocation-context.ts`) | `git diff --stat 95512bb..HEAD -- lib/ai/` | 5th |
| 5 | Next step 3 "not before the exemplars exist" — exemplars exist; seven slices built and measured on them | `scripts/ai-baseline/**`, `docs/plans/AI-BETA-REASONING-MEMORY-INVESTIGATION.md` | 4th |
| 6 | No *Recently landed* clause for the post-REVIEW-3 arcs (FORECAST-1→17 / PARITY / PROJECTION / REASONING-0→8) | 0 keyword hits in STATUS.md | ongoing |
| 7 | STATUS:60 cites `app/api/spaces/[id]/goals/route.ts:62` | file does not exist; block self-marked "delete after one cycle" | 17th |
| 8 | Doc map lists 11 subsystem docs; `docs/systems/` holds **13** (missing `crypto-networks.md`, `forecast.md`) | `ls docs/systems` | 12th |
| 9 | Blockers omit `ALCHEMY_API_KEY` (absent ⇒ ETH/SOL history DARK) | `lib/env.ts`; 0 hits in STATUS.md | 12th |
| 10 | KD-15 never entered the ledger | `grep KD-15 STATUS.md` → 0 | standing since 08-20 |
| 11 | Audit reports untracked | now **7** (`-09-03`→`-09-12`) | 7th |

**Correctly stated, re-verified:** `/api/ai/chat` returns `503 AWAITING_REDESIGN` (`app/api/ai/chat/route.ts:61`); KD-14 (`AiAdvice` has no production write path) — zero `aiAdvice.create` calls in `lib/`, `app/`, `jobs/`, `scripts/`.

---

## Suggested minimum edit

Unchanged from 09-09 — nothing has been applied. In priority order:

1. STATUS:7 `88 migrations` → **104**, naming `20260908224119_plaid_item_environment` as newest.
2. One *Recently landed* line for **Platform Ops cost accounting** (`26ca0b9`→`2ae717d`) — corrects a ~3× AI cost overstatement; two migrations.
3. One *Recently landed* line for the **AI redesign baseline** (`e6ea0f2`→`666cf6f`) + the `SpaceMemory` schema.
4. Fix STATUS:45 — the substrate is being corrected and tuned, not untouched.
5. Restate Next step 3 as in progress, not blocked on exemplars.
6. Housekeeping: post-REVIEW-3 landed paragraph, stale goals-route citation, doc map (13 not 11), `ALCHEMY_API_KEY` blocker, KD-15.
7. Commit the seven untracked audit reports.

**Process note:** six consecutive audits have now produced the same unapplied list. The backlog is no longer drift detection — it's a single 15-minute STATUS.md edit that keeps not happening. Consider applying items 1–5 in one pass and letting this task go back to catching *new* drift.

*Report-only audit — no STATUS.md edits made.*
