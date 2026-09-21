# STATUS.md drift audit — 2026-09-09

**Scope:** HEAD `0c0a84b` (branch `v2.6`, 2026-09-09) vs STATUS.md as committed at `95512bb` (2026-09-07).
**Verdict: 13 new commits in one cycle, including four `feat(ops)` commits that shipped *two* production schema migrations and a whole cost-accounting subsystem into `lib/`, plus a production change to the transaction query authority. STATUS.md mentions none of it. Migration count now 104 vs STATUS's stated 88.**

| Check | 2026-09-08 | 2026-09-09 |
|---|---|---|
| HEAD | `4f481b7` | `0c0a84b` |
| STATUS.md last touched | `95512bb`, 09-07 | unchanged (3 cycles stale) |
| New commits since last audit | 11 | **13** |
| Migrations on disk | 103 | **104** (STATUS:7 still says **88**) |
| `feat(...)` commits this cycle | 0 | **4** (all `feat(ops)`) |
| Untracked audit reports | 4 | **5** |

Keyword check against STATUS.md — all zero hits: `AiInvocation`, `invocation`, `cost`, `pricing`, `item-month`, `ItemMonth`, `SpaceMemory`, `memory`, `gpt-5`, `baseline harness`, `corpus-span`.

---

## New drift (this cycle)

**D1. Two more production migrations shipped with zero STATUS mention. *(highest severity — TI2 pattern, third consecutive cycle)***
`74c4260` adds `prisma/migrations/20260908222415_ai_invocation/` (+34 SQL lines, `prisma/schema.prisma` +84 — an immutable `AiInvocation` fact table). `2ae717d` adds `prisma/migrations/20260908224119_plaid_item_environment/` (`schema.prisma` +18). Both are in the canonical migration chain and apply on next deploy. Unlike last cycle's `SpaceMemory`, these are *not* labelled `experiment` — they are `feat(ops)`.
→ **Correction:** STATUS:7 `88 migrations` → **104**, naming `20260908224119_plaid_item_environment` as newest. Add a *Recently landed* clause for the AI/Plaid cost-accounting arc.

**D2. An entire Platform Ops cost-accounting subsystem landed in four slices, in `lib/`, unmentioned.**
`26ca0b9` (slice 1 — cached + reasoning tokens through `ApiUsageCounter`, `lib/usage/ai-tokens.ts` 124 lines + tests), `75d0eab` (slice 2 — subset-aware, time-versioned pricing; `lib/usage/pricing.ts` +229, plus edits to the live `/api/platform/platform-ops/api-usage` route and two Ops widgets), `74c4260` (slice 3 — `lib/ai/invocation.ts`, `invocation-context.ts`, `lib/platform/ai/invocation-economics.ts`, migration), `2ae717d` (slice 4 — `lib/platform/plaid/item-months.ts` 296 lines, `lib/plaid/exchangeToken.ts` touched, migration). ~1,700 net lines of production code with tests. Motivating investigation: [plans/PLATFORM-OPS-COST-ACCOUNTING-INVESTIGATION.md](../../plans/PLATFORM-OPS-COST-ACCOUNTING-INVESTIGATION.md) (`7b0b889`), which found the pre-existing AI cost figure **overstated by ~3×** (cached tokens billed at one-tenth were never read) and Plaid call-counts economically meaningless (billable unit is the Item-subscription-month).
→ **Correction:** add a *Recently landed* line — "**Platform Ops cost accounting (`26ca0b9`→`2ae717d`, 4 slices)** — cached/reasoning token capture, time-versioned subset-aware pricing, immutable `AiInvocation` per-turn economics, Plaid Item-month derivation. Corrects a ~3× overstatement in the prior AI cost figure. [plans/PLATFORM-OPS-COST-ACCOUNTING-INVESTIGATION.md]". Consider whether `docs/systems/platform-operations.md` needs the contract too — no systems doc was updated.

**D3. `lib/data/transaction-query.ts` — the Transaction Explorer read authority — gained a new public surface, unmentioned.**
`55a2c22` adds `transactionCorpusSpan()` (the DB authority) and the pure `transactionCoverage()` shaper in `transaction-query-core.ts`, plus `transaction-corpus-coverage.test.ts` (146 lines) and a new `package.json` script. STATUS's v2.5 bullet describes TX-1→TX-4 as the closed authority for this file; that description is now incomplete.
→ **Correction:** one clause on the transactions line — "extended by the corpus-span authority (`55a2c22`): a result now declares the boundary of its own population."

**D4. A six-experiment measurement arc on gpt-5.1 temporal framing produced a shipped intervention and a confirmed design finding — none of it visible.**
`658cfd2` (causal-evidence gap investigation) → `bb2f6ec` (CAUSAL-EXP: the retrieval window was the whole failure) → `55a2c22` (CORPUS-SPAN: hypothesis *falsified as stated* — no widening of search, 0/20 evidence retrieval — but confident false-absence claims fell 11/18 → 5/19) → `70ac794` (ANCHOR-PROBE) → `a774989` (TEMPORAL-FRAME) → `d34330b` (ACTIVITY-AVAILABLE: three availability *statements* ignored, one measured frame obeyed) → `0c0a84b` (TWO-FRAMES: **H1 confirmed**, 15/15 date-bearing tool arguments used the broader measured frame, 0/5 cross-frame contamination, cost +59 tokens). This is the substantive input to the conversation-layer redesign that STATUS Next-step 3 says has not started.
→ **Correction:** fold into the AI bullet — "temporal-frame arc (`658cfd2`→`0c0a84b`): a measured frame in the orientation is obeyed where availability statements are not; the finding is a redesign input, still harness-only."

**D5. `21499b0` adds gpt-5.1 as a `candidate` tier in the interactive picker** — model-selection surface changed (`scripts/ai-conversation-baseline.ts`). Minor; fold into D4.

---

## Inverse drift (STATUS says open / not started; git shows shipped)

- **STATUS:45 — "the deterministic substrate is untouched."** Now false in a fourth and fifth place, and no longer only in tuning: `lib/ai/provider.ts` was edited twice more (`26ca0b9`, `74c4260` +59), and `lib/ai/invocation.ts` / `invocation-context.ts` are *new* production files in `lib/ai/`. This has been carried as a finding for three cycles.
  → Restate: "the substrate survived the reset and is being actively extended and instrumented — see `597745a`, `edcfae5`, `02b7448`, `26ca0b9`, `74c4260`."
- **STATUS Next step 3 — "Design the replacement conversation layer… not before the exemplars exist."** Fourth cycle carrying this. Beyond last cycle's seven slices, a six-experiment discriminator arc has now *answered* a design question (temporal framing) with a confirmed verdict.
  → Restate as in-progress, with the open question being graduation from `scripts/ai-baseline/` into `lib/`.
- **KD-12 (audit-log write amplification, milestone `v2.6b`)** — `74c4260` introduces a new per-invocation immutable write path (`AiInvocation`). Not the same table, but the ledger's framing ("write amplification per chat/Space") should be re-examined against per-turn invocation rows before it is called reduced.

## Carried, re-verified at HEAD

| # | Finding | Evidence today | Cycles |
|---|---|---|---|
| 1 | No *Recently landed* clause for any post-REVIEW-3 arc (W / A / CF / FORECAST-1→17 / PARITY / PROJECTION / REASONING-0→8) | 132 commits in `9ea50a5..HEAD`; 0 keyword hits | ongoing |
| 2 | STATUS:7 "88 migrations" | **104** on disk | 13th |
| 3 | STATUS:60 cites `app/api/spaces/[id]/goals/route.ts:62` | file still does not exist; block self-marked "delete after one cycle" | 15th |
| 4 | Doc map lists 11 subsystem docs; `docs/systems/` holds 13 | missing `crypto-networks.md`, `forecast.md` | 10th |
| 5 | Blockers omit `ALCHEMY_API_KEY` (absent ⇒ ETH/SOL history DARK) | `grep` → 0 hits in STATUS.md | 10th |
| 6 | KD-15 never entered the ledger | `grep KD-15 STATUS.md` → 0 | standing since 08-20 |
| 7 | KD-14 (`AiAdvice` no production write path) | re-verified — correctly open | — |
| 8 | Audit reports untracked | now **5** (`-09-03` … `-09-08`) | 5th |
| 9 | `SpaceMemory` migration (`50de1aa`) still unmentioned | carried from 09-08 D1 | 2nd |

---

## Suggested minimum edit

1. STATUS:7 — `88 migrations` → **104**; name `20260908224119_plaid_item_environment` as newest.
2. One *Recently landed* line for the Platform Ops cost-accounting arc (D1, D2) — this is the largest genuinely-shipped production increment since REVIEW-3 and is currently invisible.
3. Fix STATUS:45 — the substrate is being extended and instrumented, not untouched (inverse-drift #1).
4. Restate Next step 3 as in progress; name the temporal-frame verdict (D4) as the current design input.
5. Add the corpus-span clause to the transactions line (D3).
6. Still outstanding from every prior cycle: the post-REVIEW-3 *Recently landed* paragraph, the stale goals-route citation, the doc map, `ALCHEMY_API_KEY`, KD-15.
7. Commit the five untracked audit reports.

*Report-only audit — no STATUS.md edits made.*
