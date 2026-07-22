# Fourth Meridian — STATUS

*The current-state snapshot. Completed work is **linked, never described** — see git history and [release notes](docs/releases/). Doctrine, systems, and plans live under [`docs/`](docs/README.md); if this file conflicts with the code, fix this file.*

| | |
|---|---|
| **Version** | `2.4.5` (tagged; `package.json`) — HEAD is 633 commits past the tag |
| **Active branch** | `feature/v2.5-spaces-completion` (pushed; in sync with origin) |
| **Deployed** | Vercel (sin1) + Supabase Postgres |
| **Recently landed** | **v2.5 architectural completion wave.** **Transaction Explorer TX-1→TX-4** — read-scale investigation (`8d3823a`), bounded loaders + completeness note (`b241cc2`, `be836db`), keyset `queryTransactions()` authority (`537b817`, hardened `4cf86a0`), consumer migration and the closed find→inspect→act loop (`b1c9550`, `cd28478`, `5761892`), parity matrix + analytics cleanup (`6061966`) — [systems/transactions.md](docs/systems/transactions.md). **CONN-1→CONN-4A connection lifecycle** — lifecycle projection (`26c0a54`), financial-intelligence reconstruction (`7f521de`→`3412fb8`), freshness pipeline (`25ef845`), disconnect doctrine + Model A (`da679b0`, `9c9b4c0`) — [plans/connection-lifecycle-roadmap.md](docs/plans/connection-lifecycle-roadmap.md). **TimelineLens v4** promoted to sole canonical time selector (`05c7c80`→`8665d64`, exclusivity-guarded). **Platform Ops foundations** — operator connection controls (`5184c8b`), beta-readiness audit (`f1a0901`), beta launch-gate hardening (`630a84e`). **Admin TOTP enrollment lifecycle** fixed (`22810da`). **Marketing boundary** hardened to structural rules (`04c416d`). **v2.5 close-out slices:** **V25-FINAL-1 FX honesty** (`e3c91d0`) — unavailable conversion is `amount: null`, never a native relabel or fake zero; **V25-SIDE-1 liability balance semantics** (`f4e357f`) — one `lib/debt/balance-semantics.ts` authority for owed-vs-credit; **V25-FINAL-2 production ops gate** (`f8ad187`) — Sentry monitoring, runtime `DISABLE_SYSTEM_ADMIN` enforcement, production Plaid-env validation, admin-Plaid-audit verified, Emergency-access doctrine documented; **V25-FINAL-3 closure gate** — verified no v2.5 architectural/correctness/security blocker remains (verdict **B**: close with named before-beta gates). |
| **Active initiative** | **v2.5 closure (V25-CLOSE-x) + OPS-1 beta-readiness**, running with early zero-schema **AI-5** foundation work in parallel (neither is convergence-gated). **The V25-CLOSE-x arc is complete** — [CLOSE-1 ledger + containment](docs/archive/completed-plans/documentation-audit-pre-migration.md), CLOSE-1A CI green, [CLOSE-2 guard hardening](docs/archive/completed-plans/documentation-audit-pre-migration.md). v2.5 architecture is closed; the remaining gate is beta config/ops. |

## Production readiness

**Not ready for external users.** The binding gap is verification / configuration / operations, not feature construction. Full blocker list: [audits/production-readiness.md](docs/operations/production-readiness.md). The most urgent single act is verifying production `registration_mode=invite_only` (DB default is `open`).

## Blockers (beta gate)

*Registration consent capture closed in `630a84e` (PO-5A) — `User.acceptedTermsAt` + `acceptedTermsVersion` (`prisma/schema.prisma:367`), migration `20260719191719_po5a_terms_consent`, enforced at `app/api/auth/register/route.ts:76` and gated in the register UI. Verified V25-CLOSE-1.*

1. LLM/OpenAI disclosure + retention posture in `/legal/ai` — decision + copy. *(`content/marketing/legal-ai.md` names neither the provider nor a retention window, and its "not a chat window you have to prompt" line contradicts the shipped `app/api/ai/chat` surface.)*
2. ~~Sentry error monitoring — not configured~~ **code-closed (V25-FINAL-2 `f8ad187`); remaining act = set `NEXT_PUBLIC_SENTRY_DSN` in production** (prod boot now fails without it).
3. Production config verification — `invite_only`, Turnstile keys, **production Plaid credentials + `PLAID_ENV=production`** (the sandbox-in-prod *guard* is code-closed in V25-FINAL-2; the credentials remain a config act), uptime monitor, backup-restore drill, Resend/domain.
4. Published support address — exists only as a sender identity in `lib/email/senders.ts`; zero occurrences in user-facing surfaces.
5. ~~**Sync cursor-ahead-of-data robustness**~~ **CODE CLOSED (PRE-V26-PLAID-CLOSE, `986d97a`).** A page with any unmet persistence obligation (`MISSING_ACCOUNT` or a transaction `UPSERT_ERROR`) no longer writes its cursor — it throws `PlaidSyncIncompleteError`, so the same page replays and a returned result now *means* complete persistence. Replay is idempotent (`plaidTransactionId` unique, findUnique→update before create, fingerprint fallback). Stalls are visible in Platform Ops with duration + distinct failed attempts, and sync-incomplete state reaches the financial trust envelope (`657e850`).
6. ~~**Account-deletion Plaid `itemRemove` fail-open**~~ **CODE CLOSED (PRE-BETA-OPS-CLOSE, `657e850`).** Revocation failure no longer destroys the retry path: only a *confirmed* outcome marks the item `REVOKED`, a retryable failure holds the deletion (token and User row intact) and the existing daily cron retries. Bounded to 3 daily attempts (≈72h) counted in distinct calendar days so a duplicate cron run cannot burn the budget; after that the deletion completes and writes durable `ACCOUNT_DELETED_UNREVOKED` evidence (item id + institution, **never a token**) that survives the User delete.
7. **Set `NEXT_PUBLIC_SENTRY_DSN` in Vercel Production** — it is in `PROD_REQUIRED_KEYS` (`lib/env.ts`), enforced at boot by `instrumentation.ts`. Verified absent from the Production environment: **deploying this branch without it fails boot.** Config act, not code.
8. **Verify `PLAID_ENV=production` and `INVESTMENT_OBSERVATIONS_ENABLED=true` in Vercel Production** — both keys are present but their values are encrypted and **were not verifiable** from the repository. A wrong `PLAID_ENV` trips the V25-FINAL-2 boot guard; a disabled observations flag leaves `getCurrentPositions()` (canonical, no Holding fallback) returning an empty portfolio silently. Manual verification required.
9. **Turnstile production keys** — both absent from Production. `verifyCaptchaToken` returns `true` when no secret is configured (`lib/captcha.ts`), so **CAPTCHA is currently a no-op in production**. Before external beta.
10. **Verify `registration_mode = invite_only`** — a DB `PlatformSetting` whose ship default is `open`; not verifiable without production DB access. Before external beta.

## Next 3–5 steps

1. **OPS-1 LLM disclosure** (C-S2) — smallest copy closing the largest remaining gate; consent capture (C-S1) is already done.
2. **OPS-1 ops floor + production config flips** (C-S3) — verify `invite_only` first, then Sentry, uptime, backup drill, Turnstile, Plaid.
3. **AI5-0 / AI5-1** in a parallel worktree — failure-corpus reconstruction + window-characterization suite, bounds-not-dollars.
4. **v2.5.5 convergence** — DayFacts sole-fold + named net measures (data-semantics only; see [ROADMAP](docs/plans/ROADMAP.md)). *Classifier v3 landed (CCPAY-2); the remaining CCPAY debt is the [recorded follow-ups](docs/plans/ccpay-follow-ups.md) — btc-sync flow-authority convergence + the never-classified seed backlog.*

## Where things stand

- **v2.5 (architecture):** **COMPLETE — every scoped exit criterion met.** Host decomposition done (SD-7 landed, SD-8 census clean); legacy `Account` physically retired; one dashboard system serves Personal and shared Spaces; TimelineLens is the sole canonical time selector; Transaction Explorer read path is bounded and server-paged (TX-1→TX-4); connection lifecycle is modelled in three layers (CONN-1→CONN-4A). The V25-CLOSE-x arc closed the rest: ledger + artifact containment (CLOSE-1), CI green (CLOSE-1A), and guard hardening (CLOSE-2 — Atlas ratchet across `components/**`+`app/**`, prototype-route containment guard, Space visibility-resolver parity guard). The V25-FINAL slices closed the remaining correctness/security review findings (FX honesty, liability semantics, ops gate). **The V25-FINAL-3 closure gate (2026-07-22) re-verified the foundation and returned verdict B: the architecture is closed. The two fault-tolerance items it named (sync cursor-ahead robustness, deletion `itemRemove` fail-open) were then CLOSED IN CODE by PRE-V26-PLAID-CLOSE (`986d97a`) and PRE-BETA-OPS-CLOSE (`657e850`). The final closure review (339/339 tests, `tsc` clean, lint clean, 13/13 architectural guard suites green, no regressions, no schema migration or backfill required) found no remaining v2.5 code blocker — what remains is a release gate: production configuration and operator acts, none of which is an architectural defect.**
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
