# STATUS.md drift audit — 2026-07-17 (automated)

Scope: git log through `5c640d8` vs STATUS.md as of `6f50971` (updated today for CCPAY-2G). Report-only; no edits made to STATUS.md.

## Findings

1. **KD-22 listed Open, but fixed 2026-07-15.**
   Evidence: `46772f4` "fix(ai): align trend net with canonical refund-aware net" + regression test `lib/ai/intelligence/spending-trends-net.test.ts` (+188 lines). Matches KD-22's text exactly.
   Correction: remove KD-22 from the open ledger.

2. **KD-21 partially stale — A10 sub-item fixed.**
   Evidence: `ebda4b2` "fix(investments): enforce detail visibility in A10 reads (KD-21a)" (2026-07-15).
   Correction: drop "A10 investments valuation" from KD-21's text; keep Goals, banking import authorization, activity-feed ruling.

3. **OPS-5 understated (says S1–S5); OPS-6 wave entirely absent.**
   Evidence: OPS-5 S6 `da6a539`, S7 `100dcfb`, S9 `a2d86c5`, S10 `131d2e0`; OPS-6A–G feat commits `3b416ce`, `ca2021c`, `1c2313a`, `fbe6b7c`, `521c4cd`, `0b1ac57`, `a413eef` (all 2026-07-17); roadmap doc `docs/audits/OPS5_WAVE_C_PLATFORM_ACTIVATION_AUDIT_2026-07-17.md`. "OPS-6" appears nowhere in STATUS.md.
   Correction: update "Recently landed" to OPS-5 S1–S10 + OPS-6A–G; OPS-6B (operator user management) is relevant context for the OPS-1 beta initiative.

4. **HIST workstream shipped with zero mention (TI2 pattern).**
   Evidence: `032dc14` (HIST-1A/B), `a23bf93` (HIST-1C/D), `c608bac` (HIST-2A), `bd5f601` (HIST-2C-lite), `7cda4bb` (HIST-2E); audit doc `docs/audits/HIST2_HISTORICAL_WRITER_AND_VALUATION_BASIS_AUDIT_2026-07-17.md`.
   Correction: add a HIST-1/HIST-2 line to "Where things stand" (wealth/history: shared computeAccountFloors authority, batched valuation reads, valuation-basis disclosure) linking the HIST2 audit.

5. **Minor: AI-ARCH Waves A–C (`567b35a`, `e61e9a1`, `99f82d2`), TEST-0–5 modernization (`95ab7b6`, `96029b2` et al.), and PROV consolidation (`5c640d8`, newest commit, post-dates STATUS's last touch) unreflected.**
   Correction (optional): one-line note beside the AI-5 bullet that the AI layer was decomposed (AI-ARCH), so downstream assessments don't assume the pre-decomposition shape.

## Verified as NOT drift

- Beta blockers 1–4 (consent capture, LLM disclosure, Sentry, config verification): no landing commits found — correctly still open.
- KD-8, KD-12, KD-14, KD-16: no fix commits found — correctly still open.
- Active branch `feature/v2.5-spaces-completion` matches STATUS.md.
