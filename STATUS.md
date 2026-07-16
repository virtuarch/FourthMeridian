# Fourth Meridian — STATUS

*The current-state snapshot. Completed work is **linked, never described** — see git history and [release notes](docs/releases/). Doctrine, systems, and plans live under [`docs/`](docs/README.md); if this file conflicts with the code, fix this file.*

| | |
|---|---|
| **Version** | `2.4.5` (tagged; `package.json`) |
| **Active branch** | `feature/v2.5-spaces-completion` (28 commits ahead of origin, unpushed) |
| **Deployed** | Vercel (sin1) + Supabase Postgres |
| **Recently landed** | **OPS-5 platform observability** (S1–S5: resource-freshness, rich job health, provider health, manual operations, alerting — [systems/platform-ops.md](docs/systems/platform-ops.md)). **SpaceDashboard decomposition** is substantially complete — the host is down to ~1,480 LOC (from ~3,731) with the SD-7 standard-workspace extraction landed and the SD-8 census concluding the decomposition clean. |
| **Active initiative** | **v2.5 closure + OPS-1 beta-readiness**, running with early zero-schema **AI-5** foundation work in parallel (neither is convergence-gated). |

## Production readiness

**Not ready for external users.** The binding gap is verification / configuration / operations, not feature construction. Full blocker list: [audits/production-readiness.md](docs/audits/production-readiness.md). The most urgent single act is verifying production `registration_mode=invite_only` (DB default is `open`).

## Blockers (beta gate)

1. Registration consent capture (`User.acceptedTermsAt` absent) — code, small.
2. LLM/OpenAI disclosure + retention posture in `/legal/ai` — decision + copy.
3. Sentry (or equivalent) error monitoring — not configured.
4. Production config verification — `invite_only`, Turnstile keys, Plaid environment, uptime monitor, backup-restore drill, Resend/domain.

## Next 3–5 steps

1. **Push the branch** — 28 unpushed commits (OPS-5 wave + this docs cleanup) sit ahead of origin.
2. **OPS-1 consent capture + LLM disclosure** (C-S1/C-S2) — smallest code closing the largest gate.
3. **OPS-1 ops floor + production config flips** (C-S3) — verify `invite_only` first, then Sentry, uptime, backup drill, Turnstile, Plaid.
4. **AI5-0 / AI5-1** in a parallel worktree — failure-corpus reconstruction + window-characterization suite, bounds-not-dollars.
5. **v2.5.5 convergence** — DayFacts sole-fold, classifier v3, named net measures (data-semantics only; see [ROADMAP](docs/plans/ROADMAP.md)).

## Where things stand

- **v2.5 (architecture):** host decomposition is substantially done (SD-7 landed, SD-8 census clean). Remaining: Atlas ratchet-fence expansion + `.env.example` hygiene. Legacy `Account` physically retired; one dashboard system serves Personal and shared Spaces.
- **v2.5.5 (Financial Intelligence):** canonical aggregation is substantially landed (CF-3 `DayFacts` is the projection; Summary/History/Calendar parity test-enforced). Remaining is convergence + test enforcement, not construction.
- **OPS-1 / beta:** legal/public (S9) and beta-access (S10) substantially shipped; remaining is consent/disclosure + production floor.
- **AI-5:** deterministic substrate strong; conversational persistence (`conversationId`) is the major unbuilt AI layer — the eight-failure corpus must be reconstructed (AI5-0 prerequisite).

## Open known issues

Active tickets only (fixed defects live in git history):

| ID | Issue | Severity | Milestone |
|---|---|---|---|
| KD-8 | Master-mode chat: unbounded prompt, failed Spaces silently omitted with no disclosure | Medium | v2.6a (AI-5) |
| KD-12 | Audit-log write amplification (2 rows/chat/Space) | Low | v2.6b |
| KD-14 | `AiAdvice` still has no production write path (advice generation) | Medium | v2.6b |
| KD-16 | Contradictory data-availability claims across intent paths; window re-derived per turn with silent failure modes | Med-High | v2.6a (AI-5) |
| KD-21 | Visibility gaps on newer surfaces: A10 investments valuation, Goals, banking import authorization lack a `visibilityLevel` filter; activity-feed account-name a doctrine ruling | High / ruling | v2.5 (Phase 1) |
| KD-22 | AI trend-net omits refunds while its comment claims parity with `netCashFlow` | Medium | v2.5.5 / AI |

## Documentation map

| Looking for… | Read |
|---|---|
| Current state | **this file** |
| The rules that bind the code | [`docs/doctrine/`](docs/doctrine/) (financial-semantics · money-and-fx · historical-data · spaces · platform-and-security · intelligence) |
| Why a subsystem exists & its contracts | [`docs/systems/`](docs/systems/) (investments, wealth, cash-flow, liquidity, debt, transactions, spaces, connections, platform-ops, ai) |
| Decision records | [`docs/architecture/`](docs/architecture/) (PHASE_2_DECISION_MATRIX, PHASE_2_DOCTRINE, DEC-0, initiative-naming) |
| Roadmap / active plans / parked ideas | [`docs/plans/`](docs/plans/) |
| Runbooks / deploy / checklists | [`docs/operations/`](docs/operations/) |
| What shipped per version | [`docs/releases/`](docs/releases/) |
| Living audits (architecture · security · production-readiness) | [`docs/audits/`](docs/audits/) |
| Design language / Atlas | [`docs/design/`](docs/design/), [`docs/design-system/`](docs/design-system/) |
