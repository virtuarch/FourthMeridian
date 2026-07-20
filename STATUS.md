# Fourth Meridian — STATUS

*The current-state snapshot. Completed work is **linked, never described** — see git history and [release notes](docs/releases/). Doctrine, systems, and plans live under [`docs/`](docs/README.md); if this file conflicts with the code, fix this file.*

| | |
|---|---|
| **Version** | `2.4.5` (tagged; `package.json`) — HEAD is 633 commits past the tag |
| **Active branch** | `feature/v2.5-spaces-completion` (pushed; in sync with origin) |
| **Deployed** | Vercel (sin1) + Supabase Postgres |
| **Recently landed** | **v2.5 architectural completion wave.** **Transaction Explorer TX-1→TX-4** — read-scale investigation (`8d3823a`), bounded loaders + completeness note (`b241cc2`, `be836db`), keyset `queryTransactions()` authority (`537b817`, hardened `4cf86a0`), consumer migration and the closed find→inspect→act loop (`b1c9550`, `cd28478`, `5761892`), parity matrix + analytics cleanup (`6061966`) — [systems/transactions.md](docs/systems/transactions.md). **CONN-1→CONN-4A connection lifecycle** — lifecycle projection (`26c0a54`), financial-intelligence reconstruction (`7f521de`→`3412fb8`), freshness pipeline (`25ef845`), disconnect doctrine + Model A (`da679b0`, `9c9b4c0`) — [plans/connection-lifecycle-roadmap.md](docs/plans/connection-lifecycle-roadmap.md). **TimelineLens v4** promoted to sole canonical time selector (`05c7c80`→`8665d64`, exclusivity-guarded). **Platform Ops foundations** — operator connection controls (`5184c8b`), beta-readiness audit (`f1a0901`), beta launch-gate hardening (`630a84e`). **Admin TOTP enrollment lifecycle** fixed (`22810da`). **Marketing boundary** hardened to structural rules (`04c416d`). |
| **Active initiative** | **v2.5 closure (V25-CLOSE-x) + OPS-1 beta-readiness**, running with early zero-schema **AI-5** foundation work in parallel (neither is convergence-gated). **The V25-CLOSE-x arc is complete** — [CLOSE-1 ledger + containment](docs/archive/completed-plans/documentation-audit-pre-migration.md), CLOSE-1A CI green, [CLOSE-2 guard hardening](docs/archive/completed-plans/documentation-audit-pre-migration.md). v2.5 architecture is closed; the remaining gate is beta config/ops. |

## Production readiness

**Not ready for external users.** The binding gap is verification / configuration / operations, not feature construction. Full blocker list: [audits/production-readiness.md](docs/operations/production-readiness.md). The most urgent single act is verifying production `registration_mode=invite_only` (DB default is `open`).

## Blockers (beta gate)

*Registration consent capture closed in `630a84e` (PO-5A) — `User.acceptedTermsAt` + `acceptedTermsVersion` (`prisma/schema.prisma:367`), migration `20260719191719_po5a_terms_consent`, enforced at `app/api/auth/register/route.ts:76` and gated in the register UI. Verified V25-CLOSE-1.*

1. LLM/OpenAI disclosure + retention posture in `/legal/ai` — decision + copy. *(`content/marketing/legal-ai.md` names neither the provider nor a retention window, and its "not a chat window you have to prompt" line contradicts the shipped `app/api/ai/chat` surface.)*
2. Sentry (or equivalent) error monitoring — not configured (`instrumentation.ts:22` says so in prose).
3. Production config verification — `invite_only`, Turnstile keys, Plaid environment, uptime monitor, backup-restore drill, Resend/domain.
4. Published support address — exists only as a sender identity in `lib/email/senders.ts`; zero occurrences in user-facing surfaces.

## Next 3–5 steps

1. **OPS-1 LLM disclosure** (C-S2) — smallest copy closing the largest remaining gate; consent capture (C-S1) is already done.
2. **OPS-1 ops floor + production config flips** (C-S3) — verify `invite_only` first, then Sentry, uptime, backup drill, Turnstile, Plaid.
3. **AI5-0 / AI5-1** in a parallel worktree — failure-corpus reconstruction + window-characterization suite, bounds-not-dollars.
4. **v2.5.5 convergence** — DayFacts sole-fold + named net measures (data-semantics only; see [ROADMAP](docs/plans/ROADMAP.md)). *Classifier v3 landed (CCPAY-2); the remaining CCPAY debt is the [recorded follow-ups](docs/plans/ccpay-follow-ups.md) — btc-sync flow-authority convergence + the never-classified seed backlog.*

## Where things stand

- **v2.5 (architecture):** **COMPLETE — every scoped exit criterion met.** Host decomposition done (SD-7 landed, SD-8 census clean); legacy `Account` physically retired; one dashboard system serves Personal and shared Spaces; TimelineLens is the sole canonical time selector; Transaction Explorer read path is bounded and server-paged (TX-1→TX-4); connection lifecycle is modelled in three layers (CONN-1→CONN-4A). The V25-CLOSE-x arc closed the rest: ledger + artifact containment (CLOSE-1), CI green (CLOSE-1A), and guard hardening (CLOSE-2 — Atlas ratchet across `components/**`+`app/**`, prototype-route containment guard, Space visibility-resolver parity guard). What remains before beta is a **release** gate (config + ops), not an architectural one.
- **v2.5.5 (Financial Intelligence):** canonical aggregation is substantially landed (CF-3 `DayFacts` is the projection; Summary/History/Calendar parity test-enforced). Remaining is convergence + test enforcement, not construction.
- **OPS-1 / beta:** legal/public (S9) and beta-access (S10) substantially shipped; **consent capture landed (PO-5A `630a84e`)**. Remaining is LLM disclosure copy + the production ops/config floor — configuration and prose, not construction.
- **AI-5:** deterministic substrate strong; conversational persistence (`conversationId`) is the major unbuilt AI layer — the eight-failure corpus must be reconstructed (AI5-0 prerequisite).

## Open known issues

Active tickets only (fixed defects live in git history):

| ID | Issue | Severity | Milestone |
|---|---|---|---|
| KD-8 | Master-mode chat: unbounded prompt, failed Spaces silently omitted with no disclosure | Medium | v2.6a (AI-5) |
| KD-12 | Audit-log write amplification (2 rows/chat/Space) | Low | v2.6b |
| KD-14 | `AiAdvice` still has no production write path (advice generation) | Medium | v2.6b |
| KD-16 | Contradictory data-availability claims across intent paths; window re-derived per turn with silent failure modes | Med-High | v2.6a (AI-5) |

**Closed since the last reconciliation** (verified in code, V25-CLOSE-1 — kept here for one cycle so the correction is visible, then delete):

- **KD-21** — *closed.* All four sub-items land: A10 investments valuation via the new `lib/investments/account-scope.ts` scope authority (`ebda4b2`, consumed at `valuation.ts:284` + `investments-time-machine.ts:120`); Goals via `resolveFullVisibleAccountIds` + `filterVisibleContributions` (`6921337`, `app/api/spaces/[id]/goals/route.ts:62`); banking import authorization via the shared `grantsTransactionDetail` guard (`lib/imports/authorize.ts:109`); activity-feed account-name ruling implemented as `lib/activity/scrub-account-name.ts` + `account-name-privacy.ts`. Each is regression-pinned. *This was the only issue milestoned `v2.5` and was therefore falsely presenting as a v2.5 blocker.*
- **KD-22** — *closed.* `46772f4`; `lib/ai/intelligence/annotations/metrics.ts:177` now returns `incomeTotal + refundTotal - expenseTotal - debtPaymentTotal`, pinned by `lib/ai/intelligence/spending-trends-net.test.ts`.

## Documentation map

*(The documentation tree was restructured into a specification — start at [`docs/README.md`](docs/README.md) and [`docs/architecture/README.md`](docs/architecture/README.md).)*

| Looking for… | Read |
|---|---|
| Current state | **this file** |
| What is Fourth Meridian / how it all fits | [`docs/architecture/FOURTH_MERIDIAN_DOCTRINE.md`](docs/architecture/FOURTH_MERIDIAN_DOCTRINE.md) |
| The rules that bind the code | [`docs/architecture/`](docs/architecture/) (Financial Truth Spine · Space Architecture · Security Model · Time Model · UI Interaction Model) |
| Why a subsystem exists & its contracts | [`docs/systems/`](docs/systems/) (transactions, investments, wealth, cash-flow, liquidity, debt, connections, money-and-fx, historical-data, ai-foundation, platform-operations) |
| Decisions & rejected alternatives (ADRs) | [`docs/decisions/`](docs/decisions/) |
| Roadmap / active plans / parked ideas | [`docs/plans/`](docs/plans/) |
| Runbooks / deploy / admin ops / readiness | [`docs/operations/`](docs/operations/) |
| What shipped per version | [`docs/releases/`](docs/releases/) |
| Design language / Atlas | [`docs/design-system/`](docs/design-system/) |
| Historical decision context | [`docs/archive/completed-plans/`](docs/archive/completed-plans/) |
