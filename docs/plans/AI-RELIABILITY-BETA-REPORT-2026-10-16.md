# AI Reliability — beta-blocking investigation & fixes (2026-10-16)

Branch `fix/ai-reliability-beta` (worktree `~/dev/FourthMeridian-ai`), based on v2.6 `595886e` (= origin/v2.6).
Commit: `89a46ad`. **Not pushed, not merged, not deployed.** Development only; UI-hardening worktree untouched.
Companion: `AI-RELIABILITY-ISSUE1-FINDINGS-2026-10-16.md` (full forecast trace, pre-fix).

## 1. Root cause — projection discrepancy (Issue 1)

Every figure the AI quoted was a real tool output (reproduced to the cent). The defect was in the engine and the tools, not the data:

| # | Where | Defect |
|---|---|---|
| RC-1 | `lib/forecast/periodic-amount.ts` (backward walk) | The walk seeded its level from the NEWEST payment. One paycheck +28% above an 11-payment level (2026-10-09) became the "level", the older payments read as a 2-run break, and the payroll's amount was refused. The same spike mid-series was correctly an outlier. |
| RC-2 | `lib/forecast/projection.ts` fold → `project_cash` | A CURRENT payroll with no amount was silently excluded: projected income fell from $31,720.50 to $0.65, still labelled `EVIDENCE_BASED_ESTIMATE`, with the hard-coded sentence "future payroll is inferred from the observed deposit cadence". |
| RC-3 | `tools.ts` `incomeEventsCounted: f.events.length` | Counted generated events (12) beside $0.65 of income. |
| RC-4 | `reconcile_projection` | Returned the −$21,197.12 variance with a basis diff (spending rate unlabelled, a count, opening cash) in which nothing explained it. "+$178.79 daily drift" was the **spending** rate. |
| RC-5 | Model | Consequence: no tool output carried a quantified cause, so its explanations were unsupported, and asking for income was its only fallback. Payroll was present, correctly classified, and CURRENT throughout. |

Not causes (checked): payroll classification, transfers, card payments, duplicates, the detection window, page truncation. The stale **definition** of the Oct 3 checkpoint was a real factor: the spending window changed from 2 to 3 months on 2026-10-04 (67be59a).

## 2. Root cause — Prisma reservation failure (Issue 2)

`pg_advisory_xact_lock()` returns `void`. `$queryRaw` must deserialize every result column, and Prisma 5.22 refuses `void` (P2010). The transaction threw **on every real database**, so every turn took the fallback: the plain check with no in-flight count. The unit test passed because its fake `$queryRaw` returned `[]`. The fix is `$executeRaw` (same SELECT, returns a row count). The repo already uses this idiom for `set_config` in `lib/db/tenant-context.ts`.

**Consequence before the fix:** concurrent-turn protection never existed in any environment. The Preview "allowance verified" checks of 2026-10-15 exercised the plain check.

## 3. Files changed (`89a46ad`)

- `lib/platform/ai/allowance-reservation.ts` (+ `.test.ts`): `$executeRaw`; pin forbidding `$queryRaw`.
- `scripts/ai-allowance-acceptance.ts` (new), `package.json` (`rls:accept:allowance`), `scripts/lib/ci-contract.ts`, `.github/workflows/ci.yml`: new architecture-job step.
- `lib/forecast/periodic-amount.ts` (+ `.test.ts` D5–D12): head-outlier symmetry, `latestDeviation`.
- `lib/forecast/projection.ts`: additive `totals {inflow,outflow,spend,days}`.
- `lib/ai/forecast/income-completeness.ts` (+ test, new): per-stream income status, materiality, bounds.
- `lib/ai/conversation/tools.ts`: `project_cash` reports `recurringIncome`, `INCOMPLETE_ESTIMATE` + `incomplete` bound, `latestPaymentDeviates`, the identity, real counts, a conditional qualification and `rangeMeaning`. `reconcile_projection` reports `attribution`, `fieldMeaning` and `incomeCountedNow`. Tool descriptions are extended by one sentence each.
- `lib/ai/conversation/reconcile.ts` (+ `reconcile-attribution.test.ts`): `attributeInFlightVariance` (pure, still import-free).
- `lib/ai/conversation/memory-tools.ts`, `memory-model.ts`: an incomplete figure is never checkpointed; the basis records `incomeProjected` / `outflowsProjected`.
- `scripts/ai-baseline/baseline.test.ts`: the spine call-site pin moves from 3 to 4 (reconcile re-runs the same spine).

## 4. Mathematical reconciliation (Dev data, read-only)

Stored 2026-10-03: 15,925.25 + 31,720.50 − 230.548 × 89 = **27,126.97**.
Today, after the fixes: 19,517.62 + 26,433.85 − 0 − 178.795 × 76 = **32,363.05** (5 paychecks × 5,286.64 + 0.65 interest).

`reconcile_projection` attribution (residual **0.00**):

| Line | Amount |
|---|---:|
| INCOME_TIMING: the Oct 3–16 paycheck arrived and is now in opening cash | −5,286.65 |
| OPENING_CASH | +3,592.37 |
| INCOME_NET_OF_OUTFLOWS (remainder) | 0.00 |
| SPENDING_RATE (230.55 → 178.79 per day; window length changed from 2 to 3 months) | +4,606.03 |
| HORIZON_DAYS (89 → 76 days) | +2,324.33 |
| **Variance** | **+5,236.08 (AHEAD)** |

If the $6,770.32 paycheck is the new level: **39,781.45** (`latestPaymentDeviates`). With the pre-fix amount logic but the new safeguards, the same data yields `INCOMPLETE_ESTIMATE` 5,929.85, bound 39,781.45, and attribution `INCOME_NET_OF_OUTFLOWS −31,719.85`, also exact.

## 5. Live AI behaviour (real model, read-only Dev DB, writes refused)

- "Year-end cash?" → $32,363 with assumptions stated. *Residual: it did not volunteer the latest-paycheck deviation.*
- "Why did it change? Reconcile." → the five attribution lines, summing exactly, with timing called timing. No unsupported cause.
- Safeguard-only run → "$5,929.85 lower bound … ~$39,781.45 if payroll continues at its last observed level". It did not ask for income.
- An earlier iteration surfaced two defects, both fixed deterministically: the model read the spending-only `range` as income uncertainty, and called part of the income line "genuine change".

## 6. Allowance verification (real fm_system, throwaway PG 16)

`npm run rls:accept:allowance`: **before 6/14, after 14/14.**

- Single reservation: RESERVED, one counter row, released exactly once.
- 8 concurrent turns, same customer, 3-connection pool: exactly 4 admitted, in-flight sequence 0,1,2,3 then 4×4. Before the fix: **8/8 admitted**, all UNAVAILABLE.
- Different customers: not blocked (4 ms while the other customer's lock was held). The same customer waits on the lock (visible in `pg_locks`). No advisory lock survives commit.
- Exhaustion: refused with no counter row. The override ($2) is resolved through the real tenant entitlement loader and refuses where the plan default ($5) admits.
- Enforcement `false` ⇒ admitted. Garbage or missing ⇒ enforced. Pause `true`/invalid ⇒ paused; the route judges the pause before the lock.
- Lock execute revoked, or counter write revoked ⇒ rolled back, UNAVAILABLE, and the plain check still refuses over the allowance.
- Fallback limit, measured: with no transaction, 8/8 concurrent turns are admitted.

**Guarantee, stated plainly:** this is NOT a hard cap. Admitted spend ≤ allowance + Σ over concurrently admitted turns of (actual cost − RESERVE_USD $0.315). A lost release over-reserves for up to two hours. The fallback (now rare) has no concurrency bound beyond the per-minute and per-hour pacing windows. Spending alerts are observational (alert job over the 24-hour ledger) and never gate requests.

## 7. Latency (Issue 3)

| Measurement | Result |
|---|---|
| `next dev --webpack`, cold POST /api/ai/chat (401, no model work) | 18.6 s wall; Next log "next.js: 16.7s" = route-graph compilation |
| same, warm | 0.1–0.6 s ("next.js: 2–6ms") |
| Turn breakdown (harness, 6 turns) | model 93–98% (3 sequential calls: tool selection 1.8–3.1 s, answer 2.0–15.5 s, guidance label 1.9–2.0 s); tools 0.09–0.28 s; prologue/other 0.24–0.54 s |
| Prompt size | ~38k prompt tokens per call; answer time scales with completion tokens (1,081 tokens ≈ 13.5 s) |

Production build (`next build` + `next start`, same route): cold **0.063 s**, warm **0.004 s**. The reported "Next.js 19.7 s" is development compilation only. The "application 14.4 s" is model time, which is the same in every environment. No optimisation was implemented. Recommendations, highest yield first:
1. Stream the answer, so perceived latency becomes time-to-first-token.
2. Take the guidance labeller off the critical path (it costs about 2 s per turn).
3. Confirm prompt-cache hits on the ~38k stable prefix (`cachedPromptTokens` in AiInvocation).
4. Warm routes after `next dev` starts.

## 8–9. Tests & gate evidence (HEAD `89a46ad`)

- `npm run ci` (clean copy, Node 24.21.0, throwaway PG): **PASSED, every job**. test:unit **740/740**, typecheck, lint, migrate deploy, seed, audit:ci, rls:accept / app / ai / plaid / foreground, **rls:accept:allowance 14/14**, site verify.
- Production build `npm run build`: compiled (45 s). `next start` serves the route.
- New or changed unit suites: periodic-amount 127/127 (D5, D9, D10 fail on the old code), income-completeness 11/11, reconcile-attribution 14/14, allowance-reservation unit, baseline.test 0 failures.
- Not done: GitHub CI (nothing pushed), Preview verification (not authorized).

## 10. Remaining limitations & risks

- **The allowance is bounded, not absolute** (§6). **Fail-closed (owner-directed 2026-10-16, follow-up commit):** with enforcement ON, or the flag unreadable, a turn the reservation cannot judge is refused `503 AI_ALLOWANCE / RESERVATION_UNAVAILABLE` with `retryable: true` and `Retry-After: 15`. With enforcement explicitly OFF, the plain check decides as before. Real-PG suite: 15/15, and 8 concurrent turns with the transaction unavailable admit 0.
- **Latest-payment ambiguity:** whether $6,770.32 is a one-off or a raise is unknown until the next paycheck. The established level is used and the alternative is disclosed. A low newest payment is treated symmetrically, which could overstate income if pay really fell; it is disclosed with its sign.
- **The materiality threshold** (1% of opening cash + counted income, $50 floor) is a measured policy constant. Immaterial omissions are always listed.
- **Legacy checkpoints** attribute income as one net line. Timing is split using today's engine standing at the statement's date, and any approximation lands in the remainder line.
- **Model disclosure is not guaranteed**: the latest-deviation and lower-bound wording depend on the model reading fields that are always present. Prompt text was changed only in tool descriptions.
- SpaceMemory holds three identical Oct 3 checkpoint rows (two superseded). This is harmless and was left untouched.
- `get_income` and the answer called the payroll amount "net". Basis is UNKNOWN; this pre-existing model behaviour was out of scope.

## 11. Recommended beta acceptance checks

1. CI's `AI allowance reservation suite` green on GitHub. Then on Preview (after authorization), fire N parallel chat turns near the allowance: Platform Ops shows no `[ai/allowance] reservation unavailable` log lines, and admissions are bounded.
2. On Dev and Preview, ask "year-end cash?" then "why did it change since you told me X?". Every number in the answer appears in the `project_cash` / `reconcile_projection` output, and the attribution sums.
3. For a Space whose payroll amount is unestablished: the answer says "lower bound", names the stream, and does not ask for income.
4. Re-measure latency on a production build (§9) and decide on streaming and the labeller before beta.
