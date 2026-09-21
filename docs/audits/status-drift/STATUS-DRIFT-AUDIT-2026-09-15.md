# STATUS.md drift audit — 2026-09-15

**Scope:** HEAD `4752ec2` (branch `v2.6`) vs STATUS.md as committed at `95512bb` (2026-09-07).
**Verdict: drift widened again — 9 new commits, and Platform Ops crossed from a read surface into a control plane.** STATUS.md is now **70 commits / 293 files / +44,882−3,252 behind**. Every finding from 2026-09-13 re-verified at HEAD; none applied.

| Check | 2026-09-13 | 2026-09-15 |
|---|---|---|
| HEAD | `f54a62b` | **`4752ec2`** |
| Commits since STATUS.md's last touch | 61 | **70** |
| New this cycle | 29 | **9** (80 files, +6,207/−613) |
| Migrations | 105 (STATUS:7 says 88) | **105 committed + 1 uncommitted** (STATUS:7 still **88**) |
| Untracked plan docs | 3 | **4** |
| Untracked audit reports | 8 | **9** |

---

## New drift (this cycle)

**1. Platform Ops now has a control plane. STATUS describes only "foundations".**
Two commits shipped a policy authority and the first CONTROL-gated mutation: `lib/platform/policies/{refresh-policies,mutate}.ts`, `lib/platform/scheduler-capability.ts`, `lib/platform/settings/descriptor.core.ts`, new route `app/api/platform/platform-ops/policies/route.ts`, `OpsPoliciesWidget`, new audit action, all with tests. Refresh cadence is chosen from what the scheduler can honour and applied atomically with its audit record.
*Evidence:* `34e592c` (PLATFORM OPS POLICIES), `27d6d22` (PLATFORM OPS CONTROL).
*Correction:* STATUS's *Recently landed* "Platform Ops foundations" clause needs a successor line — Platform Ops has an audited write path now, not just operator read surfaces.

**2. The 09-13 audit's own suggested correction is already stale.** That report asked for a line about the "Platform Ops refresh-policy route" (`f54a62b`). That route was **deleted** a day later (`D app/api/platform/platform-ops/refresh-policy/route.ts`) and replaced by `/policies`. Apply the current shape, not last cycle's.

**3. Primary navigation was restructured — no mention anywhere in STATUS.**
The desktop rail now mirrors the mobile bar and Settings has left primary navigation (`BottomNav`, `ContextualNavbar`, `DashboardChrome`, `lib/space-nav.ts`, `lib/space/mount-context.ts`, `chrome.test.ts`, `space-nav.test.ts`).
*Evidence:* `0a60cc2` (ONE PRIMARY NAV).
*Correction:* one *Recently landed* line; likely also a change to the UI Interaction Model doc STATUS's map points at.

**4. Four more compositional scenario capabilities shipped into the promoted runtime.**
Liquid floor — keep a cash floor, invest a share above it (`0d80404`, `liquid-floor-contribution.test.ts`); checkpoint contract — rows at the requested cadence, missing ones named (`201be37`, `lib/ai/conversation/scenario-checkpoints.ts`); elapsed-time + substitution disclosure (`f070f6d`); bounded `project_cash` evidence with per-row distance and unlicensed events grouped (`4c6d6ab`). Two new baseline checks under `scripts/ai-baseline/`.
*Correction:* STATUS:45's "**No replacement architecture has been chosen**" is now four cycles of shipped product past false. Rewrite (already the #1 item on 09-13's list).

**5. Crypto history + pricing changed semantics.**
Incremental ETH history — reuse proven history after verification, prove only what is new (`891458f`, `lib/crypto/eth-history-incremental.ts`, `eth-history-rows.ts`); BTC refresh now prices the USD column from the canonical archived close and names a provider that never answers (`4752ec2`).
*Correction:* touches `docs/systems/crypto-networks.md` (a doc STATUS's map still doesn't list — see carried #6).

**6. In-flight uncommitted work includes a schema migration.**
`prisma/migrations/20260915180000_refresh_execution_source/` is **untracked**, with `prisma/schema.prisma`, `lib/plaid/refresh-execution*.ts`, `lib/jobs/run.ts`, `lib/crypto/wallet-sync-dispatch.ts` modified and `lib/plaid/refresh-verdict.core.ts` untracked. Not drift in STATUS yet — flagged because an uncommitted migration is exactly how the TI2 gap opened. Migration count on disk is **106**.

**7. Untracked plan docs describing finished work (now 4).**
`PLATFORM-OPS-CONTROL-PLANE-INVESTIGATION.md` (its own verdict — "zero CONTROL-gated anything" — was obsoleted by `34e592c`/`27d6d22` the same day), `AI-SCENARIO-LIQUID-FLOOR-INVESTIGATION.md`, `AI-COMPOSITIONAL-FINANCE-INVESTIGATION.md` (all three describe shipped slices), plus `AI-LIABILITY-DYNAMICS-L1-INVESTIGATION.md` (2026-09-15, verdict READY TO IMPLEMENT — not yet code).
*Correction:* commit them; STATUS's next-steps should name L1 as the live next slice instead of "design the replacement conversation layer from exemplar conversations".

---

## Carried from prior cycles, re-verified at HEAD (all still uncorrected)

| # | Finding | Cycles |
|---|---|---|
| 1 | STATUS:7 "88 migrations" → **105 committed** | 17th |
| 2 | STATUS:45 asserts the AI conversation layer is deleted and `/api/ai/chat` returns `503 AWAITING_REDESIGN`; the route answers, and its test asserts the refusal is gone | 3rd |
| 3 | STATUS:45 "the deterministic substrate is untouched" — `lib/ai/` is **+14,625/−87 across 72 files** since `95512bb` | 8th |
| 4 | Blocker §1 — `/legal/ai` copy contradicted by the shipped AI surface; provider + retention still unnamed | 3rd |
| 5 | Stale comment `lib/ai/provider.ts:180` still cites the 503 refusal | 3rd |
| 6 | Doc map lists 11 subsystem docs; `docs/systems/` holds **13** (`crypto-networks.md`, `forecast.md` missing) | 15th |
| 7 | STATUS:60 cites `app/api/spaces/[id]/goals/route.ts:62` — file does not exist; block self-marked "delete after one cycle" | 20th |
| 8 | Blockers omit `ALCHEMY_API_KEY` (present in `lib/env.ts:63`, blank in `.env.example`; absent ⇒ ETH/SOL history DARK) | 15th |
| 9 | KD-8 / KD-12 / KD-16 marked moot on grounds ("the prompt builder was deleted", "there are no turns") that **expired with the promotion** — re-open or re-justify | 3rd |
| 10 | KD-15 never entered the ledger | standing since 08-20 |
| 11 | Platform Ops cost accounting (`26ca0b9`→`2ae717d`, 2 migrations) unmentioned | 7th |
| 12 | Daily Brief 1–4.1 + migration `20260913114002_daily_brief` unmentioned | 2nd |
| 13 | Audit reports untracked — now **9** | 10th |

**Correctly stated, re-verified:** KD-14 — zero `aiAdvice.create/upsert/update` calls repo-wide.

---

## Suggested minimum edit (priority order)

1. **Rewrite STATUS:45** — the reset is closed; the replacement runtime is in production and has since gained scenario continuity, memory, checkpoints, a liquid-floor rule and bounded cash projection.
2. **Rewrite blocker §1** — disclosure owed *and* marketing copy contradicted by a shipped surface.
3. STATUS:7 `88 migrations` → **105**.
4. Add *Recently landed* lines: Platform Ops **control plane** (not just foundations), Daily Brief 1–4.1, AI production promotion, scenario continuity + SpaceMemory, refresh policy, primary-nav consolidation, incremental ETH history + BTC canonical-close pricing, Platform Ops cost accounting.
5. Replace *Next 3–5 steps* item 3 with **Liability dynamics L1** (`AI-LIABILITY-DYNAMICS-L1-INVESTIGATION.md`, verdict READY TO IMPLEMENT).
6. Re-open or re-justify KD-8 / KD-12 / KD-16 against the promoted runtime; enter KD-15.
7. Housekeeping: stale goals-route citation, doc map 11→13, `ALCHEMY_API_KEY` blocker, commit the 4 plan docs + 9 audit reports + the in-flight `refresh_execution_source` migration.

**Process note:** nine consecutive audits have produced an unapplied list. The cost is now concrete and compounding: this cycle's top finding (Platform Ops has no control authority) was written down as a *current-state verdict* in a plan doc on 2026-09-14 and falsified by commits landed the same day — the TI2 failure reproducing inside the very documents meant to compensate for STATUS.md being stale.

*Report-only audit — no STATUS.md edits made.*
