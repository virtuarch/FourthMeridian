# Roadmap

*Phases are gated by **exit criteria**, not feature lists. The roadmap ends at launch; everything past it lives in [parked-ideas.md](./parked-ideas.md). Completed work is not described here — see release notes and git history.*

The AI evolution ladder frames the whole roadmap: **v2.4.5 makes every answer honest → v2.5 / v2.5.5 make the data singular and semantically sound → v2.6a makes conversations coherent → v2.6b earns the right to speak unprompted → v3.0 sells it.** Each phase's exit criteria are the next phase's entry criteria.

## v2.5 — Spaces Completion + Design Foundation — *released*

**Closed 2026-07-27 — tag `v2.5.0`, merged to `main`, production-verified.** Development ran on `feature/v2.5-spaces-completion` and finished on `main`. Full scope and the release-day verification record: [releases/v2.5.md](../releases/v2.5.md). Closure included the **V26-PRE B1–B5** production-hardening wave (update-path fact preservation, AI snapshot convergence, single debt-terms authority, BTC identity backstop, CI verification integrity), independently audited and independently certified before integration.

**Remaining exit criteria: none.** The last one — **Atlas/design-system closure** — landed in V25-CLOSE-2: the palette-ratchet fence now scans `components/**` and `app/**` (exclusions: vendored third-party, untracked prototypes, `lib/` which holds no JSX), and the pattern list was corrected so `bg-`/`border-` carry the same colour list as `text-`. That correction is why the baseline moved from `{}` to 41 files / 937 violations — the fence had been reporting clean because it was not looking, not because the burn-down had finished. See [audits/V25_CLOSE_2_GUARD_HARDENING.md](../archive/completed-plans/documentation-audit-pre-migration.md).

*Already met:* **`SpaceDashboard.tsx` decomposition substantially complete** (the SD-x wave — SpaceShell, workspace registry, declarative loading, and standard/perspective workspace extraction all landed; host reduced ~3,731 → ~1,480 LOC; SD-8 census concluded the decomposition clean — see [../doctrine/spaces.md](../architecture/SPACE_ARCHITECTURE.md)); legacy `Account` physically retired; WorkspaceAccountShare retired; BALANCE_ONLY guarantee proven end-to-end; new surfaces ship in Atlas; **hygiene closed** — `.env.example` drift resolved and the latent `.gitignore` `.env*` re-ignore ordering fixed in V25-CLOSE-1.

**Absorbed into v2.5 without a roadmap entry** (recorded here so the phase can account for its own scope): Transaction Explorer **TX-1→TX-4**; connection lifecycle **CONN-1→CONN-4A**; **TimelineLens v4** promotion to sole time selector; **PO-4A/PO-5/PO-5A** platform-ops and beta-gate work; marketing-boundary hardening; admin TOTP enrollment fix. Commit references in [STATUS.md](../../STATUS.md). *Process note: these shipped across 97 commits with no roadmap update — see the V25-CLOSE-1 audit for why the drift guard did not fire.*

### Remaining-work classification

Every open item below is classified. Nothing sits in an unlabelled "future" bucket.

| Class | Meaning | Items |
|---|---|---|
| **A** | Must complete before v2.5 closure | **None — class A is empty.** V25-CLOSE-1 closed ledger reconciliation, prototype containment, test-discovery boundary, archive removal and `.gitignore` ordering; V25-CLOSE-1A greened the CI lint gate; V25-CLOSE-2 expanded the Atlas ratchet and added the prototype-route and visibility-parity guards. |
| **B** | Good v2.5 polish — improves honesty/safety, does not gate closure | FX rate-miss disclosure (*anchor corrected V26-PRE:* `convertMoney` now returns `amount: null` on a known-currency miss — V25-FINAL-1 landed; the one surviving native-relabel is `lib/investments/display-conversion.ts:59`, which returns the unconverted magnitude under the target label and drops the `estimated` taint on partial-coverage contexts); audit + fresh-access on the three `app/api/admin/plaid/*` operator routes; Debt/Liquidity zero-data workspace states; Space template picker descriptions; dead-code sweep (~694 LOC). **From V25-CLOSE-2:** `resolveSingleAccountScope` should honour `spaceIdHint` when supplied (a semantics decision, not a guard); convert the in-memory `=== VisibilityLevel.FULL` comparisons to `grantsTransactionDetail()`; burn down the 937 baselined palette violations (551 in `app/admin`, 223 in `components/admin` — both retiring into Platform HQ). |
| **C** | v2.6 work — do not pull forward | Conversation state / `conversationId` (v2.6a); `AiAdvice` write path KD-14 (v2.6b); `context-priority` planner activation; `comingSoon` lenses (tax/property/businessHealth); provider expansion. |
| **D** | Later scaling work | TX-5 explorer query cost (gated on KD-15 boundary relocation); PROV-6 provider-neutral ingestion payload (correctly deferred until a second real ingesting provider); `SectionCard.tsx:160-163` legacy section-key data migration. |

**Boundary note (binding):** the only v2.5-side obligations that v2.6 genuinely depends on are relocating `lib/ai/visibility.ts` out of the AI namespace (13 non-AI files import it, making the privacy predicate load-bearing for the financial data layer) and btc-sync flow-authority convergence. Everything conversational is additive and touches no financial code.

## v2.5.5 — Financial Intelligence — *convergence/doctrine closeout*

Point milestone: pure data-semantics, **zero new product surface**. The canonical aggregation architecture is substantially implemented (see [../systems/cash-flow.md](../systems/cash-flow.md)); what remains is convergence + test enforcement, not construction.

**Exit criteria (must-have):** DayFacts sole-fold convergence (delete the four dead folds); single-site `economicSpend` clamp; explicitly named net measures; classifier v4 for liability payment-app outflow (version-gated backfill, recorded — `FLOW_CLASSIFIER_VERSION = 4`; earlier drafts of this line said v3, which never matched the code); transfer-evidence stamping decoupled from `flowType === "TRANSFER"`; compact doctrine oracle + the four named gap tests green; cross-surface parity fixture; multi-currency assembler rollup threading; clean `audit:flow-desync` + `audit:pending-posted`; TI3/backfill runtime verification recorded. **Should-have:** minimum transaction-correction tooling. **Explicitly out:** any new surface, `refundCandidate`, review-queue platform, Decimal money migration.

## OPS-1 — Platform Operations Foundation — *gates private beta, runs in parallel*

S9 legal/public surfaces and S10 beta-access system are substantially shipped. Remaining is **consent + disclosure + a production operational/config floor** — see the production-readiness audit in [../audits/](../audits/).

1. **Consent + disclosure (code + decision):** `User.acceptedTermsAt` capture at registration; `/legal/ai` names OpenAI + a retention posture; legal effective-dates precise; support address published.
2. **Production verification:** `registration_mode=invite_only` verified in prod; Turnstile keys live; one end-to-end invite executed and recorded.
3. **Ops floor:** Sentry (or equivalent) error monitoring; external uptime monitor on `/api/health`; backup-restore drill written up (verify Supabase PITR); production Plaid decision/credentials; Resend/domain verification.

## v2.6 — Milestone plan — *opened 2026-07-27 from the `v2.5.0` tag*

Branch: `v2.6`, branched from the tag (not from `main`) so the baseline is exactly what was released and production-verified.

Five workstreams, **in this order**. The ordering is not preference — it is dependency. v2.5's own evidence is that duplicated authority is this codebase's most expensive recurring defect class: two of the five V26-PRE production blockers (B2, B3) were one fact with two owners, and both survived until an external audit. Every AI workstream *consumes* financial metrics, so a metric with two owners becomes a confidently-stated wrong number the moment the product speaks unprompted.

**1. Semantic Authority Convergence** — *foundation; do first*
Every percentage and derived financial metric has exactly one canonical owner. Extends the pattern proven by B3: a single resolver module plus a source-scan guard that bans inline re-derivation repo-wide (`lib/debt/effective-terms.ts` + `effective-terms.test.ts` is the reference implementation). Absorbs the v2.5.5 exit criteria that are the same shape — DayFacts sole-fold, single-site `economicSpend` clamp, explicitly named net measures.
*Exit:* no displayed percentage or derived metric is computed at more than one site; each has a named owner and an enrolment guard.

**2. AI Truth Convergence** — *consumes 1*
B2 converged exactly one assembler onto the canonical snapshot authority. Sweep the rest (`accounts`, `transactions`, `holdings`, `goals`) the same way: consume the canonical authority, never rebuild, exclude-and-disclose what cannot be converted. Feeds directly into the v2.6a substrate below.
*Exit:* no AI assembler holds an independent financial truth source; every derived figure carries or suppresses its input caveats.

**3. Ambient Intelligence throughout Spaces** — *gated on 1 + 2*
Contextual insight surfaced naturally across the product. Detailed exit criteria live in **v2.6b** below; the gate is unchanged and binding — *the system may not speak unprompted until it cannot misquote a number.*

**4. Mobile UX refinement** — *parallel track, any time*
Interaction, hierarchy and integration. Presentation-layer and low-coupling to the semantic work, so it runs alongside 1–3 rather than queuing behind them.

**5. Provider expansion** — *last of the majors*
Extend a **provider-neutral** ingestion architecture to further institutions. Deliberately last: PROV-1 found `plaidAdapter` decorative with no provider-neutral `persistAccountSpine`, and B1/B4 hardened Plaid and BTC identity *separately*. Budget the provider-neutral spine (PROV-6) as part of this work — not as a prerequisite blocking it, and not as a follow-up after a second hardcoded path exists.

### v2.6 backlog

**DF-6 — Historical Production Duplicate Cleanup.** Retire the three historical duplicate lineages left in production by the 2026-07-22 reconnect re-pull that predates DF-4 (T-Mobile −119.00 / 2026-07-08; YouTube Premium −15.99 / 2026-06-28; Anthropic −42.22 / 2026-07-01 — all on one Amex account). Extend the **DF-5** repair pattern: dry-run by default, `--apply` required to write, **soft-delete only** (preserve forensic evidence), abort on shape mismatch, idempotent, narrowly scoped to the three proven `(date, amount, raw descriptor)` lineages. Retire the later row of each pair — the earlier row is the lineage the provider still maintains. **Not to be executed during a release window.**

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
