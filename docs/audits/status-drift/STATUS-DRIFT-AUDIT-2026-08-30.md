# STATUS.md drift audit — 2026-08-30

**Scope:** HEAD `3bcfce3` (branch `v2.6`, 2026-08-28 02:08) vs STATUS.md as committed at `9ea50a5` (2026-08-17).
**Verdict: 13 new commits since the 08-27 audit, all unmentioned — but the character changed. CF-9/10/11/12 are the first commits in this wave to alter what the production AI actually sends and answers, and FORECAST-1→7 is an entire new subsystem (`lib/forecast/`, 7 modules, ~8,000 LOC) that has no name anywhere in STATUS or the roadmap text. STATUS.md is now 13 days stale.**

| Check | 2026-08-27 | 2026-08-30 |
|---|---|---|
| HEAD | `93b46c0` (08-27 20:06) | `3bcfce3` (08-28 02:08) |
| STATUS.md last touched | `9ea50a5`, 08-17 | unchanged (13 days) |
| New commits since last audit | 28 | **13** |
| New schema migrations | 1 | **0** |
| Migration dirs | 101 | 101 (STATUS.md:7 still says 88) |
| New committed `.md` docs | 1 | **0** |
| New env keys | 5 | **0** |
| New npm audit scripts | 6 | **1** (`audit:retrieval-plan`) |

Note: nothing has landed since 08-28 02:08 — a ~2-day quiet stretch, and the 08-28/08-29 audits appear not to have run. All 13 commits landed in the six hours immediately after the last audit.

Keyword check against STATUS.md — all **zero hits**: `CF-7`…`CF-12`, `FORECAST`, `retrieval plan`, `retrieval-plan`, `ComponentState`, `ASSERTABLE`, `operating state`, `cadence`, `obligation`, `spending baseline`, `conditional serialization`, `AssetClass.CRYPTO`, plus every carry-over from prior cycles.

---

## New drift (this cycle)

**1. FORECAST-1→7 — a new subsystem with a new codename, ~8,000 LOC in one evening, absent from STATUS and from the roadmap vocabulary. *(highest severity this cycle)***
`abdf72f` FORECAST-1 (cadence: kind/anchor/occurrence, 26/12 as a property of the kind), `d720d1e` FORECAST-2 (stream activity — a historical cadence licenses shape, not continuation), `f849c05` FORECAST-3 (NET/GROSS/UNKNOWN basis; no `futureCashTotal` field exists by design), `f0af73d` FORECAST-4 (obligation ≠ habit; the module cannot see transaction history at all), `0506c67` FORECAST-5 (regime-bounded periodic amount, backward walk, 5% band), `5ca025a` FORECAST-6 (discretionary spending baseline — result on the real Space is **UNKNOWN**, and the refusal is the finding), `3bcfce3` FORECAST-7 (`CurrentOperatingState` — composition boundary, capability matrix: **6 conclusions license, 8 refuse, 2 blockers**).
Fourteen new files under `lib/forecast/`. **Substrate only — every commit states zero consumers**, so nothing user-visible changed.
→ STATUS's *Next 3–5 steps* and *Where things stand* describe no forecast/projection track at all. A downstream assessment asked "can the product project cash?" would today get the TI2 answer: "not started."
→ **Suggested correction:** add a *Recently landed* clause — "FORECAST-1→7: `lib/forecast/` is a deterministic forecasting substrate (cadence, stream activity, cash-event basis, obligation licence, regime-bounded periodic amount, spending baseline, `CurrentOperatingState`). Substrate only, zero consumers; readiness is a per-conclusion capability matrix (6 license / 8 refuse) blocked on no established spending level and no net income basis." Add a *Next steps* line for wiring it to a consumer.

**2. CF-9/CF-10/CF-11 — the CF wave stopped being observational. Production prompt assembly changed.**
`aa0a5e4` CF-8 built the retrieval plan in **shadow** (it found 5 planner defects before enforcement — the argument for shadow, worth recording). Then `ec3fa99` CF-9, `07325cd` CF-10 and `958ac23` CF-11 **enforced** it: `snapshot_history` raw JSON, `transactions_summary` raw JSON, and the transaction *analysis* sections are now conditional on the plan. Measured real-Space effect: investments prompt **22,373 → 13,080 tokens (−42%)**, coverage 21,704 → 12,411, crypto/stocks similar; REQUIRED classes byte-identical.
→ Every prior cycle's drift was engine-side or substrate. **This is a behavioural change to the shipped `app/api/ai/chat` surface**, and STATUS describes the AI context path nowhere.
→ **Suggested correction:** *Recently landed* clause naming CF-8 (shadow planner, `lib/ai/retrieval-plan.ts`) and CF-9→CF-11 (conditional serialization; authority/scope/disclosure blocks always render, analysis and raw payloads conditional; assessment output byte-identical, verified per acceptance class).

**3. CF-12 fixed a live, user-visible wrong answer — no ledger trace.**
`737fdcd`: asked "What stocks do I own?", the model answered with **Bitcoin at the top of the list**, reproduced identically at CF-7, CF-10 and CF-11. `AssetClass.CRYPTO` existed on every valued row; the holdings assembler dropped it when mapping to its own row type. Now carried through and filtered by CF-7's breadth, with the denominator narrowed to the filtered population ("8 of 8 securities") and portfolio totals deliberately left whole.
→ This is the class of defect the KD ledger exists to record — found, fixed, and now invisible.
→ **Suggested correction:** no KD needed (it is closed), but it belongs in a *Recently landed* clause; a "the AI names crypto as stocks" claim is exactly what a stale downstream assessment would repeat.

**4. Last cycle's suggested KD item is already obsolete — do not open it.**
The 08-27 audit (item 5) recommended opening a KD for CF-6's recorded `$19k` double-count. `7d4c0e8` CF-7 **closed it the next commit**: `holdings_summary` is the position spine and already contains digital assets; the disjoint pair is `accounts.totalInvestments + accounts.totalDigitalAssets`, and disjointness is now *proven* from `classifyAccounts`' single-scalar partition and asserted against the classifier source.
→ **Do not apply the 08-27 wording.** Second cycle running where a suggested correction expired before it could be applied — a symptom of STATUS not being touched at all rather than of bad findings.

**5. A new open defect is recorded in a commit body only — the same shape as CF-6's was.**
`958ac23` CF-11 §13: *"what is Dining made up of?" plans NOT_NEEDED while producing a live 15-of-126 drilldown, because neither the spending nor the detail vocabulary matches that phrasing.* Named as a **PLANNER defect**; the serializer's drilldown override masks it but does not fix it.
→ **Suggested correction:** open a KD item (Low/Medium, v2.6a) citing `958ac23` — "retrieval planner mis-routes component/composition phrasings to NOT_NEEDED; masked by the drilldown override."

**6. CF-11 published a correction to CF-10's own measurement — worth knowing before citing either.**
CF-10 reported transaction prose at 5,027 tokens and larger than its 3,715-token payload. CF-11 states this was wrong (the probe's `indexOf` matched the doctrine preamble): real prose is **2,039 tokens**, of which 1,512 is the conditional pool. CF-10's decision stands on its consumer-class argument, not on the sizes.
→ **Suggested correction:** none to STATUS, but do not quote CF-10's token figures.

**7. Suite figures moved again — and last cycle's audit-count claim was itself wrong.**
FORECAST-7 reports **504/504 suite, 21/21 audits**. STATUS.md:10/:42 still carry REVIEW-3's "492/492 tests, 18/18 REQUIRED audits" and the corrected-but-still-cited "339/339". Separately: the 08-27 audit asserted `audit-registry.ts` carries **29 REQUIRED** entries — it carries **21** (19 INFORMATIONAL, 18 OPERATIONAL, 21 REQUIRED, 5 RETIRED). The commit bodies' "21/21" is the accurate number.
→ **Suggested correction:** replace all hard-coded suite/audit figures in STATUS with "see `npm run test:unit`", as previously recommended.

## Inverse drift (STATUS says open / not-started but git shows shipped)

**One partial, and it is the standing line-45 problem — but be precise about it.**

- **STATUS.md:45** — *"AI-5: deterministic substrate strong; conversational persistence (`conversationId`) is the major unbuilt AI layer."* Re-checked at HEAD: **`conversationId` genuinely does not exist** in `lib/ai/` or `app/api/ai/` (zero files). So the literal claim is still accurate. What is wrong is the *implication* — CF-4 shipped multi-turn scope inheritance, CF-8 shipped a retrieval planner, and CF-9→CF-12 shipped conditional assembly, so "the major unbuilt layer" now describes a much smaller gap than the sentence suggests.
  → **Suggested correction:** keep the `conversationId` fact, rewrite the surrounding sentence around the CF track and the FORECAST substrate.

Standing candidates re-checked at HEAD:

- **KD-14** (`AiAdvice` no production write path) — **re-verified accurate**: zero `create`/`upsert` call sites across `app/`, `lib/`, `jobs/`, `scripts/`. Correctly open.
- **KD-8** (master-mode unbounded prompt) — **materially improved but not closed.** CF-9→CF-11 cut a typical prompt by up to 42% on the real Space. The item's wording ("unbounded") is now overstated; it is conditional but still unbounded in the worst case.
- **KD-16** (window re-derivation per turn) — unchanged; fifth cycle carried. Close or restate.
- **KD-15** — standing 08-20 case, unchanged: enforced in code, absent from the ledger in either state.

## Carried from prior audits — still unremediated

Unchanged, because STATUS.md has not been touched since 08-17 (13 days):

- **STATUS.md:60 cites `app/api/spaces/[id]/goals/route.ts:62` as live evidence — re-confirmed the file does not exist** (deleted by W2, `9352e41`). The block is self-marked "kept for one cycle, then delete"; kept for six.
- **STATUS.md:7 "88 migrations"** → actual **101**, including the unapplied-against-prod `20260826232626_position_coverage_licence`.
- No *Recently landed* clause for **W1, W2, W3/W3.1/W4, W5, A1–A6, W-M0→W-M3a, W6→W6f, ETH-H1/H2, UI-C1/C2, PRODUCT-C1, CF-1→CF-6** — and now CF-7→CF-12 and FORECAST-1→7.
- **Blockers section still missing** `AI_ASSESSMENT_GUARD_MODE` (flagged 08-26, 08-27) and the crypto acquisition credentials `ALCHEMY_API_KEY` / `ETH_RPC_URL` / `SOL_RPC_URL` (absent ⇒ ETH/SOL DARK).
- **`docs/systems/crypto-networks.md` still absent from the line-72 documentation map.**
- `HOUSEHOLD` enum residue, **DEBT-1**, ops observability restore (`ce360b8`), W2 schema residue held for the migration train.
- **The drift audit series is still untracked** — `STATUS-DRIFT-AUDIT-2026-08-{20,21,22,23,26,27}.md` all show `??`. This file makes seven.

---

*Report-only. STATUS.md was not edited. Working tree is clean apart from the untracked audit files.*
