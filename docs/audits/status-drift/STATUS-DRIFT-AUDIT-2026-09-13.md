# STATUS.md drift audit — 2026-09-13

**Scope:** HEAD `f54a62b` (branch `v2.6`) vs STATUS.md as committed at `95512bb` (2026-09-07).
**Verdict: severe new drift — the largest single-cycle gap this task has recorded.** 29 commits landed in ~28 hours (26 of them today), rebuilding the AI conversation layer and **promoting it to production**. STATUS.md §45 still describes that layer as deleted and `/api/ai/chat` as returning `503 AWAITING_REDESIGN`. That refusal no longer exists in the code. This is the TI2 failure mode, at a larger scale.

| Check | 2026-09-12 | 2026-09-13 |
|---|---|---|
| HEAD | `0c0a84b` | **`f54a62b`** |
| Commits since STATUS.md's last touch | 32 | **61** |
| New this cycle | 0 | **29** (161 files, +19,297/−2,945) |
| Migrations on disk | 104 | **105** (STATUS:7 still says **88**) |
| New plan docs this cycle | 0 | **7** |

---

## New drift (this cycle) — highest severity first

**1. The conversation layer shipped to production. STATUS says it does not exist.**
STATUS:45 — *"the conversational layer was **deleted, not disabled**… `/api/ai/chat` returns an explicit `503 AWAITING_REDESIGN`; there is no prompt builder, router, planner… **No replacement architecture has been chosen**."*
All four clauses are now false. `app/api/ai/chat/route.ts` is a live production route owning auth, rate limit, Space re-derivation and transcript sanitation; its own test asserts *"the redesign refusal is gone"* (`route.test.ts:31`). `lib/ai/conversation/` holds 25 modules (engine, turn loop, tools, evidence, scenario ledger, compaction, memory). The only surviving `AWAITING_REDESIGN` string in the repo is a stale comment at `lib/ai/provider.ts:180`.
*Evidence:* `4c5fb8c` (runtime moves to `lib/ai/conversation`), `fbf3611` + `989d63d` (PROMOTION 2/3 — turn loop leaves the harness, route answers), `c373d6d`, `docs/plans/AI-PRODUCTION-PROMOTION.md`, `docs/plans/AI-GPT51-PROMOTION-DOGFOOD-GATE.md`.
*Correction:* replace §45 wholesale — the reset is over; the replacement runtime is in production behind the trust boundary the route documents. Also fix the dead comment in `provider.ts:180`.

**2. A user-facing AI surface shipped — and it re-breaks the `/legal/ai` blocker's own reasoning.**
Blocker §1 currently argues the marketing line *"not a chat window you have to prompt"* "no longer contradicts a shipped surface." It does again: `app/(shell)/dashboard/analyze/page.tsx` now renders a conversation-first composer, docked into `BottomNav`/`DashboardChrome`.
*Evidence:* `e7f220f` (AI PAGE), `89385c8` (AI SURFACE), `components/ai/AiShell.tsx`. `content/marketing/legal-ai.md:7` unchanged; still zero occurrences of a provider name or retention window.
*Correction:* upgrade blocker §1 from "disclosure still owed" to **"disclosure owed AND marketing copy actively contradicted by a shipped surface"** — this is now a launch-blocking factual inaccuracy, not just a gap.

**3. Daily Brief 1→4.1 shipped with an unmentioned production migration.**
`20260913114002_daily_brief` creates the `DailyBrief` table (cached brief keyed `spaceId+ownerUserId+briefDay`, with `sourceWatermark`/`materialDigest` invalidation). Routes under `app/api/brief`, page at `app/(shell)/dashboard/brief`, authority in `lib/ai/brief/`.
*Evidence:* `0e1cf1e`, `673d41d`, `07bb7d3`, `b025468`, `fd41f5a`.
*Correction:* one *Recently landed* line for Daily Brief 1–4.1; bump STATUS:7 migration count 88 → **105**, naming `20260913114002_daily_brief` as newest.

**4. Refresh-policy authority + unified wallet refresh (today's HEAD) — no mention.**
New `lib/platform/refresh-policy.core.ts` + Platform Ops route; `lib/crypto/wallet-refresh.ts` puts every wallet on one pipeline; "overdue" now judged against expected cadence and reaches `lib/connections/space-data-health`.
*Evidence:* `f54a62b` (24 files).
*Correction:* one line under Platform Ops / connections; this changes connection-freshness semantics documented in `docs/systems/connections.md`.

**5. Scenario continuity + memory are shipped product, not experiments.**
Active-scenario envelope sealed across turns (`c5874ea`, `1d67786`, `2f39023`), surplus-share rule (`72d686e`), goal seek + scenario ledger (`0b6d794`, `b6c7cf1`), `SpaceMemory` (`50de1aa`, migration `20260907234638`). STATUS mentions none of it.

**6. Partial correction to STATUS:45's persistence claim.** *"Conversational persistence (`conversationId`) remains unbuilt"* is still literally true server-side (zero `conversationId` in `lib/`/`app/`; the route stores nothing), but a client-side transcript cache shipped (`e01414b`, `components/ai/transcript-cache.ts`, 281 LOC + tests). Restate as: no server-side persistence by design; browser-side transcript restore exists.

**7. Seven new plan docs describing finished work, unreferenced by STATUS.**
`AI-PRODUCTION-PROMOTION.md`, `AI-GPT51-PROMOTION-DOGFOOD-GATE.md`, `AI-GPT51-TWO-FRAME-PRODUCT-GATE.md`, `AI-SCENARIO-CONTINUITY-INVESTIGATION.md`, `AI-SCENARIO-RESULT-CONTINUITY-DESIGN.md`, `AI-TRANSACTION-PAGE-COVERAGE.md`, `AI-ACTIVITY-FRAME-PERIOD-DECISION.md`.

---

## Carried from prior cycles, re-verified at HEAD (all still uncorrected)

| # | Finding | Cycles |
|---|---|---|
| 1 | STATUS:7 "88 migrations" → **105** | 16th |
| 2 | STATUS:45 "the deterministic substrate is untouched" — now **69 files / +13,452/−87** under `lib/ai/` since `95512bb` | 6th |
| 3 | Next step 3 "not before the exemplars exist" — superseded twice over; the layer designed from those exemplars is now **in production** | 5th |
| 4 | No *Recently landed* clause for post-REVIEW-3 arcs (FORECAST / PARITY / PROJECTION / REASONING) | ongoing |
| 5 | STATUS:60 cites `app/api/spaces/[id]/goals/route.ts:62` — file does not exist; block self-marked "delete after one cycle" | 18th |
| 6 | Doc map lists 11 subsystem docs; `docs/systems/` holds **13** (`crypto-networks.md`, `forecast.md` missing) | 13th |
| 7 | Blockers omit `ALCHEMY_API_KEY` (absent ⇒ ETH/SOL history DARK) | 13th |
| 8 | KD-15 never entered the ledger | standing since 08-20 |
| 9 | Platform Ops cost accounting (`26ca0b9`→`2ae717d`, 2 migrations) unmentioned | 5th |
| 10 | Audit reports untracked — now **8** | 8th |

**Correctly stated, re-verified:** KD-14 (`AiAdvice` has no production write path) — zero `aiAdvice.create`/`upsert` calls repo-wide. KD-8/KD-12/KD-16 are marked moot on the grounds that the prompt builder and turns were deleted — **those grounds have now expired** and each should be re-examined against the promoted runtime.

---

## Suggested minimum edit (priority order)

1. **Rewrite STATUS:45** — the AI reset is closed; the replacement runtime is promoted and serving `/api/ai/chat`.
2. **Rewrite blocker §1** — `/legal/ai` copy now contradicts a shipped surface; provider + retention still unnamed.
3. STATUS:7 `88 migrations` → **105**.
4. Add *Recently landed* lines: Daily Brief 1–4.1 (+ migration), AI production promotion, scenario continuity + SpaceMemory, refresh policy, Platform Ops cost accounting.
5. Re-open or re-justify KD-8 / KD-12 / KD-16 against the promoted runtime.
6. Housekeeping: stale goals-route citation, doc map 11→13, `ALCHEMY_API_KEY` blocker, KD-15, commit the 8 untracked audit reports.

**Process note:** seven consecutive audits produced an unapplied list; this cycle the drift crossed from "stale" into "STATUS.md asserts the opposite of what is in production." Any downstream assessment reading §45 today would conclude Fourth Meridian has no AI conversation — which is exactly the TI2 failure this task exists to catch.

*Report-only audit — no STATUS.md edits made.*
