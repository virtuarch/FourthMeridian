# Roadmap

*Phases are gated by **exit criteria**, not feature lists. The roadmap ends at launch; everything past it lives in [parked-ideas.md](./parked-ideas.md). Completed work is not described here — see release notes and git history.*

The AI evolution ladder frames the whole roadmap: **v2.4.5 makes every answer honest → v2.5 / v2.5.5 make the data singular and semantically sound → v2.6a makes conversations coherent → v2.6b earns the right to speak unprompted → v3.0 sells it.** Each phase's exit criteria are the next phase's entry criteria.

## v2.5 — Spaces Completion + Design Foundation — *in progress*

Branch: `feature/v2.5-spaces-completion`.

**Remaining exit criteria:**
1. **Atlas/design-system closure** — a ruling + one cheap slice, not a migration: expand the palette-ratchet fence to the currently-unscoped trees and record explicit exemptions (`business_accounts`, admin/merchant-ops, marketing/public). Product surfaces already satisfy the criterion. **This is the only unstarted scoped v2.5 exit criterion** (`lib/atlas/palette-ratchet.test.ts:28` still scans 3 dirs; `ALLOWLIST_FILES` empty). Slice: V25-CLOSE-2.

*Already met:* **`SpaceDashboard.tsx` decomposition substantially complete** (the SD-x wave — SpaceShell, workspace registry, declarative loading, and standard/perspective workspace extraction all landed; host reduced ~3,731 → ~1,480 LOC; SD-8 census concluded the decomposition clean — see [../doctrine/spaces.md](../doctrine/spaces.md)); legacy `Account` physically retired; WorkspaceAccountShare retired; BALANCE_ONLY guarantee proven end-to-end; new surfaces ship in Atlas; **hygiene closed** — `.env.example` drift resolved and the latent `.gitignore` `.env*` re-ignore ordering fixed in V25-CLOSE-1.

**Absorbed into v2.5 without a roadmap entry** (recorded here so the phase can account for its own scope): Transaction Explorer **TX-1→TX-4**; connection lifecycle **CONN-1→CONN-4A**; **TimelineLens v4** promotion to sole time selector; **PO-4A/PO-5/PO-5A** platform-ops and beta-gate work; marketing-boundary hardening; admin TOTP enrollment fix. Commit references in [STATUS.md](../../STATUS.md). *Process note: these shipped across 97 commits with no roadmap update — see the V25-CLOSE-1 audit for why the drift guard did not fire.*

### Remaining-work classification

Every open item below is classified. Nothing sits in an unlabelled "future" bucket.

| Class | Meaning | Items |
|---|---|---|
| **A** | Must complete before v2.5 closure | Atlas palette-ratchet fence expansion (exit criterion 1) · **green the CI lint gate** — `npm run lint` exits 1 on five pre-existing React correctness errors in tracked components, and `ci.yml` runs it as a blocking step. *V25-CLOSE-1 closed the rest of class A: ledger reconciliation, prototype containment, test-discovery boundary, archive removal, `.gitignore` ordering.* |
| **B** | Good v2.5 polish — improves honesty/safety, does not gate closure | FX rate-miss disclosure (`lib/money/convert.ts:59` passes native amounts through as target currency behind only an `≈`); audit + fresh-access on the three `app/api/admin/plaid/*` operator routes; cross-authority parity guard for the three Space visibility resolvers; Debt/Liquidity zero-data workspace states; Space template picker descriptions; dead-code sweep (~694 LOC). |
| **C** | v2.6 work — do not pull forward | Conversation state / `conversationId` (v2.6a); `AiAdvice` write path KD-14 (v2.6b); `context-priority` planner activation; `comingSoon` lenses (tax/property/businessHealth); provider expansion. |
| **D** | Later scaling work | TX-5 explorer query cost (gated on KD-15 boundary relocation); PROV-6 provider-neutral ingestion payload (correctly deferred until a second real ingesting provider); `SectionCard.tsx:160-163` legacy section-key data migration. |

**Boundary note (binding):** the only v2.5-side obligations that v2.6 genuinely depends on are relocating `lib/ai/visibility.ts` out of the AI namespace (13 non-AI files import it, making the privacy predicate load-bearing for the financial data layer) and btc-sync flow-authority convergence. Everything conversational is additive and touches no financial code.

## v2.5.5 — Financial Intelligence — *convergence/doctrine closeout*

Point milestone: pure data-semantics, **zero new product surface**. The canonical aggregation architecture is substantially implemented (see [../systems/cash-flow.md](../systems/cash-flow.md)); what remains is convergence + test enforcement, not construction.

**Exit criteria (must-have):** DayFacts sole-fold convergence (delete the four dead folds); single-site `economicSpend` clamp; explicitly named net measures; classifier v3 for liability payment-app outflow (version-gated backfill, recorded); transfer-evidence stamping decoupled from `flowType === "TRANSFER"`; compact doctrine oracle + the four named gap tests green; cross-surface parity fixture; multi-currency assembler rollup threading; clean `audit:flow-desync` + `audit:pending-posted`; TI3/backfill runtime verification recorded. **Should-have:** minimum transaction-correction tooling. **Explicitly out:** any new surface, `refundCandidate`, review-queue platform, Decimal money migration.

## OPS-1 — Platform Operations Foundation — *gates private beta, runs in parallel*

S9 legal/public surfaces and S10 beta-access system are substantially shipped. Remaining is **consent + disclosure + a production operational/config floor** — see the production-readiness audit in [../audits/](../audits/).

1. **Consent + disclosure (code + decision):** `User.acceptedTermsAt` capture at registration; `/legal/ai` names OpenAI + a retention posture; legal effective-dates precise; support address published.
2. **Production verification:** `registration_mode=invite_only` verified in prod; Turnstile keys live; one end-to-end invite executed and recorded.
3. **Ops floor:** Sentry (or equivalent) error monitoring; external uptime monitor on `/api/health`; backup-restore drill written up (verify Supabase PITR); production Plaid decision/credentials; Resend/domain verification.

## v2.6a — Advisor Intelligence (AI-5)

Conversation-state substrate (no `conversationId` exists today); active-window + context-change disclosure; confidence/completeness propagation; intent-path consistency (KD-16); graceful context compression; advisor-quality presentation. KD-8 rides here.

**Layered entry gates (do not collapse):** zero-schema foundation (AI5-0 failure-corpus reconstruction, AI5-1 window semantics, AI5-2 disclosure) may begin now in a parallel worktree under a **bounds-not-dollars** test rule; shadow persisted-state integration gates on v2.5 A1-M1 + v2.5.5 items 1–4; live user-facing state persistence gates on full v2.5.5 closeout + the OPS-1 beta floor.

**Exit criteria:** the reconstructed eight observed conversation-quality failures reproduced as green tests; no reply silently changes its time window; no contradictory data-availability claims across intent paths; every derived metric carries or suppresses its input caveats; KD-8 and KD-16 closed; validator authority unchanged.

## v2.6b — Ambient Intelligence

Scheduler substrate; `AiAdvice` write path; Daily Brief generation; signals → notifications; AI Inbox; context-priority planner; advisory modes. KD-9, KD-12, KD-14 close here. Start the Plaid production application during this window (longest external lead time).

**Entry:** v2.6a exit — the system may not speak unprompted until it cannot misquote a number **and** can hold a coherent conversation when prompted. **Exit:** one week of scheduled briefs with zero validator failures; notification opt-in/out; audit-log growth bounded.

## v3.0 — Launch (L-1)

Billing/subscription; onboarding funnel; production Plaid live; counsel-reviewed legal/compliance posture; tested backups + incident response + alerting; support tooling; accessibility/perf polish. **Zero new product surface.**

**Exit:** a stranger can pay, connect a bank, share a Space with a partner, and be supported and recovered.
