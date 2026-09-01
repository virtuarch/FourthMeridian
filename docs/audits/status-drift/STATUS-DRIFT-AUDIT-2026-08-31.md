# STATUS.md drift audit — 2026-08-31

**Scope:** HEAD `7abda2d` (branch `v2.6`, 2026-08-31 19:52) vs STATUS.md as committed at `9ea50a5` (2026-08-17).
**Verdict: 17 new commits since the 08-30 audit — and the wave crossed the line. FORECAST is no longer substrate: `FORECAST-10` wired it into `app/api/ai/chat/route.ts`, `PARITY-1/2` made it reach the *default* entry point (master mode), and `PROJECTION-1` ships a second, weaker projection path that is ON by default. Three commits record verified-in-the-real-browser user-visible answers. STATUS.md is now 14 days stale and describes none of it. Two new env flags gate this behaviour and neither is in the blocker list; one defaults to the posture the acceptance slice explicitly rejected.**

| Check | 2026-08-30 | 2026-08-31 |
|---|---|---|
| HEAD | `3bcfce3` (08-28) | `7abda2d` (08-31 19:52) |
| STATUS.md last touched | `9ea50a5`, 08-17 | unchanged (**14 days**) |
| New commits since last audit | 13 | **17** |
| User-visible AI behaviour changed | CF-9→CF-12 | **FORECAST-10, 16, 17; PARITY-1/2/3; PROJECTION-1** |
| New env keys | 0 | **2** (`AI_FORECAST_GUARD_MODE`, `AI_FORECAST_PROJECTION`) |
| New migrations | 0 | 0 (101 dirs; STATUS.md:7 still says 88) |
| New committed `.md` docs | 0 | **0** — the entire wave is recorded only in commit bodies |
| New npm scripts | 1 | **2** (`ai:forecast-conformance`, `ai:forecast-multiturn`) |

Keyword check against STATUS.md — all **zero hits**: `FORECAST`, `PARITY`, `PROJECTION`, `pay dates`, `numerical guard`, `LicensedFigure`, `retrieval plan`, `master-surfaces`, `observed spending`, plus every carry-over from prior cycles.

---

## New drift (this cycle)

**1. The forecast substrate reached production and then reached the default door. *(highest severity — and the exact TI2 shape)***
`69c1051` FORECAST-10 (nine slices wired into the chat route; FORECAST as a CF-8 concept, not a rival router; forecast context 477–710 tokens vs ~11,065 before), `6edfc78` FORECAST-16 (`PAY_DATES` as its own concept — "when is my next paycheck?" is answerable, 20/20), `5190c29` FORECAST-17 (user-named one-off events — "$15,500 gross bonus on October 15" — routed to `FutureCashEvent`), `26443dc` PARITY-1 + `b8766a4` PARITY-2 (master mode — the default `AnalyzeClient` entry — took no `question` at all, so CF-7 composition, FORECAST-16 pay dates, CF-6 holdings and FORECAST-10 all existed *only* on the named-Space path; now one shared `renderSpaceEvidenceBody` seam).
→ **A downstream assessment asking "can the product answer forward-looking cash questions?" would today get the TI2 answer: "not started."** It is shipped, measured, and browser-verified.
→ **Suggested correction:** *Recently landed* clause — "FORECAST-8→17 + PARITY-1→3: the deterministic forecast substrate is wired into `app/api/ai/chat` and reaches the default master entry point. Pay dates, cash forecast, user-asserted facts/assumptions/one-off events, and a numerical-authority boundary on model output. No cross-Space cash forecast by design (shared accounts ⇒ new aggregation authority); master refuses it explicitly."

**2. PARITY-1 was a live wrong answer at the product's front door — no ledger trace.**
`26443dc`: master mode answered "how much do I have in investments?" off raw `totalInvestments` = **$5,006.64**, silently dropping every digital asset from a figure the user reads as complete (correct answer: $5,006.64 + $19,014.63 = $24,021.27). Same commit: `loadForecastIncomeStreams` paged from the **oldest** end of a 730-day window, so seven months of the current payroll regime were unreadable and live streams were judged SILENT.
→ Same class as CF-12's "Bitcoin listed as a stock" — found, fixed, invisible.
→ **Suggested correction:** *Recently landed* clause naming both; no KD needed (closed).

**3. Two new env flags, neither in the Blockers section — and the guard defaults to the rejected posture.**
- `AI_FORECAST_GUARD_MODE` (`lib/ai/forecast/numerical-guard.ts:772`) defaults to **`shadow`**. `80406b1` FORECAST-15's acceptance measured shadow at **8 raw authority violations → 8 reach the user**, repair at **10 → 0**, and its rollout decision was explicit: *"Controlled active should launch with repair enabled."* Unset in production ⇒ the boundary observes and changes nothing.
- `AI_FORECAST_PROJECTION` (`lib/ai/forecast/assemble.ts:141`) defaults **ON** (only the literal `'off'` disables). Read via bare `process.env`, absent from `lib/env.ts`.
→ **Suggested correction:** add both to *Blockers (beta gate)* alongside the still-missing `AI_ASSESSMENT_GUARD_MODE` (flagged 08-26, 08-27, 08-30): "`AI_FORECAST_GUARD_MODE` must be set to `repair` in production — the default `shadow` serves known-wrong arithmetic by design."

**4. PROJECTION-1 ships a second projection path whose default state fails the accepted conformance corpus.**
`7abda2d`: an evidence-based projection beside the licensed forecast — `ObservedSpendingRate` (most recent complete months, capped at 3, window disclosed because on this data the window *is* the answer: 2mo → $4,156.68, 3mo → $8,349.66, 13mo → $6,567.02) and `observedCashContribution` as a second gate admitting settled-depository UNKNOWN-basis credits. Real UI, master mode: **$42,597.20 by December**. The commit flags it itself: **F15 conformance 32/35 with the flag off, ~21/35 with it on** — "CONTRACT, not regression", because ten scenarios forbid exactly what this slice was authorised to provide. **The acceptance corpus was deliberately not rewritten.**
→ **Suggested correction:** *Next steps* line — "update the F15 forecast acceptance corpus for the PROJECTION-1 contract (currently ~21/35 in the shipped default state)." Also worth a *Recently landed* note that the DEBT_PAYMENT double-count was investigated and closed as correct-by-existing-population (every payment appears twice, debit + card credit).

**5. Two failures were measured, deliberately not closed, and are recorded only in commit prose.**
- **D/I premise echo** (`722b868` FORECAST-11A, `817501a` FORECAST-12): the model multiplies a rate found in the *conversation* by a period found in the conversation, ignoring the deterministic figure (30 samples, `$30,000` printed 30×, deterministic `$30,226.49` cited 0×). Tier experiment answered **no** — gpt-4.1 helps D and *hurts* I at 14× cost. Closed at `1dae906` FORECAST-14 not by prompt but by a **response boundary** (redact-and-restore), 20/20.
- **Assistant-history contamination** (`b8766a4` PARITY-2): reported open at 5/5 in *both* modes after three failed interventions; then closed at `fcc54dc` PARITY-3 by giving `LicensedFigure` a **horizon axis** (CURRENT vs FUTURE), measured on live replays 5/5 → 0/6 in both modes.
→ **Suggested correction:** none open, but these belong in the landed clause — the reasoning ("shadow is not a safety posture", "model routing is not the answer") is the kind of finding a stale STATUS invites someone to re-litigate.

**6. Suite/audit figures moved again.** PARITY-1/2 report **508/508 unit**, 21→**23** parity checks, route ceiling 695–697/700. STATUS.md:10/:42 still carry "492/492 tests, 18/18 REQUIRED audits" and the corrected-but-still-cited "339/339".
→ **Suggested correction:** as recommended three cycles running — replace all hard-coded figures with "see `npm run test:unit`".

## Inverse drift (STATUS says open / not-started but git shows shipped)

- **STATUS.md:45 — "AI-5: conversational persistence (`conversationId`) is the major unbuilt AI layer."** Re-verified: `conversationId` still does not exist anywhere in `lib/ai/` or `app/api/ai/` — the literal fact holds. But `b494636` FORECAST-13 **answers the underlying need and rejects the store by name**: facts are re-derived from `role === 'user'` messages every turn (mirroring CF-4's `resolveConversationScope`), because a durable store would falsify the Knowledge Gaps doctrine's "has NOT been saved" line. The sentence now points at a design the repo has explicitly declined.
  → **Suggested correction:** rewrite line 45 — keep the `conversationId` fact, add "cross-turn fact/assumption continuity is derived, not stored (FORECAST-13, by design)."
- **KD-8 (master-mode unbounded prompt)** — materially rewritten by PARITY-2, not just improved: master now plans, carries an evidence envelope, and renders the *same shared body* as named-Space mode. "Unbounded" is no longer the accurate word for it.
  → **Suggested correction:** restate KD-8 against the PARITY-2 shape or close it.
- **KD-14** (`AiAdvice` no production write path) — re-verified accurate at HEAD. Correctly open.
- **KD-16** (window re-derivation per turn) — unchanged; **sixth** cycle carried. Close or restate.
- **KD-15** — standing 08-20 case, unchanged: enforced in code, absent from the ledger in either state.
- **08-30 audit item 5** (open a KD for the CF-11 planner NOT_NEEDED mis-route) — **still valid, still unapplied.** `6edfc78` FORECAST-16 touched `retrieval-plan.ts` for pay dates but did not address component/composition phrasings.

## Carried from prior audits — still unremediated

STATUS.md has not been touched in 14 days, so every prior item stands verbatim:

- **STATUS.md:60** cites `app/api/spaces/[id]/goals/route.ts:62` as live evidence — **file still does not exist** (deleted by W2, `9352e41`). Self-marked "kept for one cycle, then delete"; kept for **seven**.
- **STATUS.md:7 "88 migrations"** → actual **101**, incl. the unapplied-against-prod `20260826232626_position_coverage_licence`.
- No *Recently landed* clause for **W1–W6f, A1–A6, W-M0→W-M3a, ETH-H1/H2, UI-C1/C2, PRODUCT-C1, CF-1→CF-12, FORECAST-1→17, PARITY-1→3, PROJECTION-1**.
- Blockers still missing `AI_ASSESSMENT_GUARD_MODE` and the crypto acquisition credentials `ALCHEMY_API_KEY` / `ETH_RPC_URL` / `SOL_RPC_URL` (absent ⇒ ETH/SOL DARK) — now joined by the two forecast flags above.
- **`docs/systems/crypto-networks.md`** still absent from the line-72 documentation map; there is still **no `docs/systems/forecast.md`** for a subsystem that is now ~20 modules and user-visible.
- `HOUSEHOLD` enum residue, **DEBT-1**, ops observability restore (`ce360b8`), W2 schema residue.
- **The drift audit series is still untracked** — `STATUS-DRIFT-AUDIT-2026-08-{20,21,22,23,26,27,30}.md` all show `??`. This file makes eight.

---

*Report-only. STATUS.md was not edited. Working tree clean apart from the untracked audit files.*
