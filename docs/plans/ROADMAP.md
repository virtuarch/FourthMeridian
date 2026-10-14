# Roadmap

*Phases are gated by **exit criteria**, not feature lists. The roadmap ends at launch; everything past it lives in [parked-ideas.md](./parked-ideas.md). This file is the owner's phase structure; **current state lives in [`/STATUS.md`](../../STATUS.md)**, and nothing here is evidence of completion on its own.*

**Re-baselined 2026-10-14** against the repository at `ece2ff6` (`v2.6`), the GitHub CI record and the dated program reports under `docs/plans/`. The previous baseline was 2026-09-07. Every item below carries one of four states, and the state is only as good as the evidence named beside it:

| State | Meaning |
|---|---|
| **COMPLETED** | Shipped on `v2.6` with a linked commit or report. Not the same as "on Production" — Production runs the July release until the cutover ([STATUS §14](../../STATUS.md)). |
| **ACTIVE** | Being built now, with a named owner. |
| **DEFERRED** | Consciously not scheduled; the unpark condition is stated here or in parked-ideas. |
| **BLOCKED** | Cannot proceed until a named gate or owner act clears. |
| *NOT VERIFIED* | A claim this re-baseline could not confirm from the repository without running something. |

The AI evolution ladder that framed the roadmap still stands, with one correction from experience: **v2.4.5 made every answer honest → v2.5 / REVIEW-3 made the data singular and semantically sound → the conversation layer was then deleted and rebuilt from exemplar conversations (September) → the product now speaks unprompted through the Daily Brief under a deterministic licence → the beta path is operability and tenancy (October) → v3.0 sells it.**

---

## v2.5 — Spaces Completion + Design Foundation — **COMPLETED (released)**

**Closed 2026-07-27 — tag `v2.5.0`, merged to `main`, production-verified.** Development ran on `feature/v2.5-spaces-completion` and finished on `main`. Full scope and the release-day verification record: [releases/v2.5.md](../releases/v2.5.md). Closure included the **V26-PRE B1–B5** production-hardening wave (update-path fact preservation, AI snapshot convergence, single debt-terms authority, BTC identity backstop, CI verification integrity), independently audited and independently certified before integration.

**Exit criteria: all met.** The last one — **Atlas/design-system closure** — landed in V25-CLOSE-2: the palette-ratchet fence scans `components/**` and `app/**`, and the pattern list was corrected so `bg-`/`border-` carry the same colour list as `text-`. See [the pre-migration documentation audit](../archive/completed-plans/documentation-audit-pre-migration.md).

*Also met:* `SpaceDashboard.tsx` decomposition (SD-x wave; host ~3,731 → ~1,480 LOC; SD-8 census clean — [SPACE_ARCHITECTURE](../architecture/SPACE_ARCHITECTURE.md)); legacy `Account` physically retired; WorkspaceAccountShare retired; BALANCE_ONLY guarantee proven end-to-end; new surfaces ship in Atlas; hygiene closed in V25-CLOSE-1.

**Absorbed into v2.5 without a roadmap entry** (recorded so the phase accounts for its own scope): Transaction Explorer TX-1→TX-4; connection lifecycle CONN-1→CONN-4A; TimelineLens v4 promotion to sole time selector; PO-4A/PO-5/PO-5A platform-ops and beta-gate work; marketing-boundary hardening; admin TOTP enrollment fix. *Process note: these shipped across 97 commits with no roadmap update — see the V25-CLOSE-1 audit for why the drift guard did not fire. The same failure recurred at a larger scale between 2026-09-07 and 2026-10-14; the fix adopted is to keep STATUS.md and this file in the same commit as any migration or program closure.*

### v2.5 remaining-work classification (historical, with 2026-10-14 state)

| Class | Meaning | Items and current state |
|---|---|---|
| **A** | Must complete before v2.5 closure | None — closed 2026-07. |
| **B** | v2.5 polish, does not gate closure | FX rate-miss disclosure (COMPLETED, V25-FINAL-1; the `display-conversion.ts` native-relabel residue is *NOT VERIFIED* closed); audit + fresh-access on `app/api/admin/plaid/*` (COMPLETED, V25-CLOSE-3); Debt/Liquidity zero-data states; Space template picker descriptions; dead-code sweep (REVIEW-3 removed 6,690 LOC — [report](v2.6-REVIEW-3-EXECUTION-REPORT.md)); `resolveSingleAccountScope` honouring `spaceIdHint`, `grantsTransactionDetail()` conversions, and the 937 baselined palette violations in `app/admin` / `components/admin` — all *NOT VERIFIED* in this re-baseline; treat as open polish. |
| **C** | v2.6 work | Conversation state (resolved by design: stateless turns + a sealed carrier + Financial Memory V2 — see v2.6a); `AiAdvice` write path KD-14 (open, v2.6b); `comingSoon` lenses (tax/property/businessHealth — DEFERRED); provider expansion (DEFERRED). |
| **D** | Later scaling work | TX-5 explorer query cost; PROV-6 provider-neutral ingestion payload (deferred until a second real ingesting provider, [ADR-006](../decisions/ADR-006-provider-abstraction-timing.md)); `SectionCard.tsx` legacy section-key data migration. All DEFERRED. |

**Boundary note (binding, still true):** everything conversational is additive and touches no financial code; the AI layer consumes authorities and never rebuilds them.

## v2.5.5 — Financial Intelligence — **COMPLETED by absorption, partly NOT VERIFIED**

This point milestone (pure data-semantics, zero new surface) did not run as a phase. Its exit criteria were absorbed by REVIEW-3 and later slices:

| Exit criterion | State | Evidence |
|---|---|---|
| Single-site `economicSpend` clamp | COMPLETED | REVIEW-3 report (`clampEconomicSpend` SINGLE owner) |
| Explicitly named net measures | COMPLETED | REVIEW-3 canonical net; the money-presentation and prose-money rules (`6c40490`, `2a201f7`); net-of-refund category authority (`cdbb047`) |
| Classifier v4 for liability payment-app outflow | COMPLETED and superseded | `FLOW_CLASSIFIER_VERSION = 5` (refund economics, `382897e`; liability-inflow income veto) |
| DayFacts sole-fold convergence (delete the dead folds) | *NOT VERIFIED* | `docs/systems/cash-flow.md` describes `DayFacts` as the one fold; no census of dead folds was run for this re-baseline |
| Transfer-evidence stamping decoupled from `flowType` | *NOT VERIFIED* | see the transfer-authority ledger under `docs/plans/v2.6-TRANSFER-*` |
| Cross-surface parity fixture; doctrine oracle | COMPLETED in substance | REVIEW-3: all 12 measured contradictions verified non-reproducible by an independent pass; the Cash Flow reconciliation slice (`7bdae15`, `3702bb3`) |
| Clean `audit:flow-desync` + `audit:pending-posted`; TI3/backfill runtime verification | *NOT VERIFIED* | requires running the audits against a database |

Nothing from this phase blocks anything else. The two *NOT VERIFIED* census items are good candidates for the next read-only audit pass.

## OPS-1 — Platform Operations Foundation — **mostly COMPLETED; the rest is BLOCKED on owner acts**

The S9 legal/public surfaces and the S10 beta-access system shipped in v2.5. The floor items, with their 2026-10-14 state (sources: [P0 report](OPERATIONALIZATION-P0-REPORT-2026-10-07.md), [production-readiness.md](../operations/production-readiness.md), [production-cutover-plan.md](../operations/production-cutover-plan.md)):

1. **Consent + disclosure.** `User.acceptedTermsAt` capture — COMPLETED (PO-5A). `/legal/ai` names OpenAI, what is sent and what is never sent — COMPLETED (P0, 2026-10-07; `legal-factual-basis-2026-10-07.md`); the **retention window is withheld pending the provider's answer** (owner/counsel). Support address published — COMPLETED (P0).
2. **Production verification.** `registration_mode=invite_only` — verified 2026-08-17, *NOT re-verified since*. Turnstile keys — **BLOCKED (absent on Production; CAPTCHA is a no-op)**. One end-to-end invite executed and recorded — *NOT VERIFIED*.
3. **Ops floor.** Sentry — DSN COMPLETED (code V25-FINAL-2; DSN present on Production as of 2026-10-06; event delivery last proven for the v2.5 build on 2026-07-26 — see STATUS §12); job and AI-provider failures now reach Sentry (P0). Uptime monitor on `/api/health` — **open, ops act**. Backup-restore drill — **open**; the cutover plan rehearses a dump/restore in a clone before any Production step. Production Plaid — COMPLETED in configuration (`PLAID_ENV=production`, real Items live). Resend/domain verification — *NOT VERIFIED*. **New since P0:** `PLATFORM_ALERTS_EMAIL` must be set on Production before the next deploy (boot refuses without it) — **BLOCKED on the owner**.

## v2.6 — what the plan said, what ran, and why — **ACTIVE**

Branch `v2.6`, opened 2026-07-27 from the `v2.5.0` tag. The 2026-07 plan ordered five workstreams by dependency: *1 Semantic Authority Convergence → 2 AI Truth Convergence → 3 Ambient Intelligence → 4 Mobile UX (parallel) → 5 Provider expansion.* Workstreams 1 and 2 ran exactly as planned and closed as REVIEW-3 on 2026-08-17. From September the sequence changed, for three recorded reasons, each with its own report:

- **The conversation layer failed its own dogfood and was deleted rather than patched** (2026-09-07, [AI-CONVERSATION-RESET.md](AI-CONVERSATION-RESET.md)). The v2.6a plan assumed additions to that layer; the replacement was designed from exemplar conversations and measured in a harness before it was promoted (2026-09-13, [AI-PRODUCTION-PROMOTION.md](AI-PRODUCTION-PROMOTION.md)). Workstream 3's gate — *the system may not speak unprompted until it cannot misquote a number* — was met for the Daily Brief by a deterministic licence rather than the deleted output validator.
- **Tenancy had to stop depending on application code before the first external user** (2026-10-01→06, [POSTGRES-RLS-ARCHITECTURE-INVESTIGATION.md](POSTGRES-RLS-ARCHITECTURE-INVESTIGATION.md)). Row-Level Security with role-scoped runtime principals was not on the July roadmap; it was pulled forward because the beta path exposed real financial data to a second tenant for the first time.
- **The founder could not operate five customers from inside the product** (2026-10-07, [OPERATIONALIZATION-INVESTIGATION-2026-10-07.md](OPERATIONALIZATION-INVESTIGATION-2026-10-07.md)). P0 and P1 were run ahead of everything else because every other milestone assumed an operable product.

Mobile UX (workstream 4) ran as slices, not a program; the first UX *program* of v2.6 is Platform Spaces UX Refinement P1, desktop-first by owner decision. Provider expansion (5) has not started, by design.

### Workstream state

| # | Workstream (July plan) | State | Evidence |
|---|---|---|---|
| 1 | Semantic Authority Convergence | **COMPLETED** 2026-08-17 as REVIEW-3 (64 commits; population, chronology, snapshot read boundary; 12/12 contradictions non-reproducible) | [v2.6-REVIEW-3-EXECUTION-REPORT.md](v2.6-REVIEW-3-EXECUTION-REPORT.md) |
| 2 | AI Truth Convergence | **COMPLETED** in REVIEW-3 (AI/Brief convergence onto canonical folds, real income classification, canonical net, authority debt legs); then **superseded in form** by the rebuilt runtime, whose tools read authorities and never rebuild them (`lib/ai/conversation/tools.ts`) | REVIEW-3 report; [AI-PRODUCTION-PROMOTION.md](AI-PRODUCTION-PROMOTION.md) |
| 3 | Ambient Intelligence | **PARTIALLY COMPLETED**: the Daily Brief ships (slices 1–4.1, `0e1cf1e` → `fd41f5a`; per-source data health, claim-scoped, version-gated reuse). `AiAdvice` write path, signals → notifications, AI Inbox, advisory modes — **DEFERRED** (see v2.6b) | STATUS §5 |
| 4 | Mobile UX refinement | **ACTIVE as slices**: workspace sidebar + rail-below-lg, one primary nav, site nav inside a Space, AI page UX (September). No mobile *program* has been chartered. The active UX program is **Platform Spaces UX Refinement P1** (desktop-first; `railVisibility="belowLg"` keeps the touch rail) | [UX P1 coordination](PLATFORM-SPACES-UX-REFINEMENT-P1-COORDINATION.md) |
| 5 | Provider expansion | **DEFERRED** by decision; a provider-neutral spine is budgeted as part of this work, not before it | [ADR-006](../decisions/ADR-006-provider-abstraction-timing.md), parked-ideas |

### Programs that ran in v2.6 beyond the five workstreams (all COMPLETED unless marked)

| Program | When | Record |
|---|---|---|
| Historical-truth arc (replay, provider-bound crypto history, aggregate authorisation, universal lens roots) | Aug | [universal lens roots](v2.6-INVESTIGATION-UNIVERSAL-LENS-ROOTS.md) |
| AI conversation reset → baseline harness → experiments → production promotion (`gpt-5.1`) | 09-07 → 09-13 | [reset](AI-CONVERSATION-RESET.md), [investigation](AI-CONVERSATION-INVESTIGATION.md), [goldens](AI-CONVERSATION-GOLDENS.md), [promotion](AI-PRODUCTION-PROMOTION.md) |
| Daily Brief 1–4.1; scenario ledger, goal seek, liquid floor, checkpoints, elapsed time; exact temporal predicates; transcript cache | 09-13 → 09-14 | STATUS §5 |
| Platform Ops cost accounting, policies (READ/WRITE/CONTROL), control plane, cockpit | 09-09 → 09-15 | [control-plane investigation](PLATFORM-OPS-CONTROL-PLANE-INVESTIGATION.md) |
| Post-M1 architecture program; Financial Memory V2; pre-execution planning continuity; I1 / M1 / L1 / S1 | 09-20 → 09-22 | [post-M1 closure](AI-POSTM1-ARCHITECTURE-PROGRAM-CLOSURE.md), [Memory V2 design](AI-FINANCIAL-MEMORY-V2-DESIGN.md), [planning continuity closure](AI-PREEXECUTION-PLANNING-CONTINUITY-CLOSURE.md), [I1 closure](AI-INCOME-CHANGES-I1-CLOSURE.md), [S1 investigation](AI-CATEGORY-SPENDING-S1-INVESTIGATION.md) |
| Debt Overview and per-liability payoff; Cash Flow reconciliation; refund economics; money presentation; Space workspace navigation; Markets skeleton | 09-20 → 09-21 | STATUS §5 |
| Pre-S1 full-system audit (the live defect register) + gate repair + CI parity on Node 24 | 09-21 → 09-22 | [audit](../audits/PRE-S1-FULL-SYSTEM-AUDIT-2026-09-21.md) |
| Crypto refresh incident and repair | 10-01 | [incident](CRYPTO-REFRESH-INCIDENT-2026-10-01.md), [closure](CRYPTO-REFRESH-REPAIR-CLOSURE-2026-10-01.md) |
| Postgres RLS: roles, policies, strict mode, Preview cutover | 10-01 → 10-06 | [investigation](POSTGRES-RLS-ARCHITECTURE-INVESTIGATION.md), [runbook](../operations/rls-preview-cutover.md) |
| Plaid hardening (identity exclusivity, liveness, revoke, pagination restart, webhook verification, sandbox lane) | 10-04 → 10-07 | STATUS §5; [sandbox lane](../operations/plaid-sandbox-lane-2026-10-06.md) |
| Public/app domain split — architecture, `site/`, Preview rehearsal; environment separation | 10-02 → 10-07 | [architecture](PUBLIC-APP-DOMAIN-SPLIT-ARCHITECTURE.md), [Preview record](../operations/domain-split-preview.md), [environment separation](../operations/environment-separation.md). **Production steps DEFERRED until after the cutover** |
| Operationalization P0 (facts, alerting, intake, legal) and P1 (human operability) | 10-07 → 10-08 | [P0](OPERATIONALIZATION-P0-REPORT-2026-10-07.md), [P1](OPERATIONALIZATION-P1-REPORT-2026-10-08.md) |
| **Platform Spaces UX Refinement P1** | 10-14 → | **ACTIVE** — [investigation](PLATFORM-SPACES-UX-REFINEMENT-P1-INVESTIGATION-2026-10-14.md), [coordination](PLATFORM-SPACES-UX-REFINEMENT-P1-COORDINATION.md) |

### v2.6 backlog

**DF-6 — Historical Production Duplicate Cleanup — DEFERRED, unscheduled.** Retire the three historical duplicate lineages left in production by the 2026-07-22 reconnect re-pull that predates DF-4 (T-Mobile −119.00 / 2026-07-08; YouTube Premium −15.99 / 2026-06-28; Anthropic −42.22 / 2026-07-01, one Amex account). Extend the DF-5 repair pattern: dry-run by default, `--apply` to write, soft-delete only, abort on shape mismatch, idempotent, scoped to the three proven `(date, amount, raw descriptor)` lineages; retire the later row of each pair. No commit has referenced DF-6 since August. **Not to be executed during a release window**, and not before the cutover's own duplicate-identity preflight (which measured 0 duplicate PLAID identities on 2026-10-06 — a different check; the three lineages are economic duplicates, not identity duplicates).

## v2.6a — Advisor Intelligence (AI-5) — **SUPERSEDED**

The July plan ([ai-5-advisor-intelligence.md](ai-5-advisor-intelligence.md)) scoped *additions* to a conversational layer that was deleted on 2026-09-07. The record of what was believed before the reset is preserved there and in the reset document; the plan's **solutions are void**, and the two **problems** it named have been answered differently by the rebuilt runtime:

| AI-5 problem | How the live runtime answers it | State |
|---|---|---|
| "Conversation state does not exist" | By design it still does not persist: each turn is stateless, the active hypothetical crosses turns in a sealed `HttpOnly` carrier, and what the user *states* about their money is held in Financial Memory V2 (user-stated figures only, with a user-visible panel). A durable transcript store was consciously not built. | COMPLETED (different design) |
| "A reply must not silently change its time window" | The per-turn heuristic window resolver (`lib/ai/intent/classifier.ts`) no longer exists. Time now enters through tool contracts: four separated temporal authorities (`lib/ai/temporal-scope.ts`: requested / selected / coverage / satisfied), the coverage envelope that states what exists versus what was loaded, two measured frames (`recent` 90-day, `activity` six-month) whose existence rules were measured, and exact temporal predicates taken off the model. | COMPLETED as to the defect; the **cross-turn** continuity criterion is open — see KD-16 in [STATUS §10](../../STATUS.md) |

The former exit criteria ("eight observed failures reproduced as green tests; KD-8 and KD-16 closed; validator authority unchanged") no longer describe anything buildable: the corpus measured a pipeline that is gone, the validator was deleted with it, and KD-8/KD-16 are assessed against the live runtime in STATUS §10 (recommendations pending owner decision — not changed here).

## v2.6b — Ambient Intelligence — **PARTIALLY COMPLETED; remainder DEFERRED**

| Item | State |
|---|---|
| Scheduler substrate | COMPLETED (typed job runtime; 15-minute dispatcher wake with ledger-driven cadence policy, P1) |
| Daily Brief generation | COMPLETED (slices 1–4.1): per-(Space, owner, day) rows, watermark/digest, deterministic licence that honours truncation, quiet derived from importance, two clocks with per-source data health |
| `AiAdvice` write path (KD-14) | DEFERRED — zero writers repo-wide (STATUS §10) |
| Signals → notifications; AI Inbox; advisory modes | DEFERRED — not started |
| Audit-log growth bounded (KD-12) | Open, low (STATUS §10) |
| "Start the Plaid production application during this window" | **Stale line, retired:** Production already runs `PLAID_ENV=production` against real Items (cutover plan §1) |

**Entry gate, restated:** the Daily Brief speaks unprompted under a deterministic licence; nothing else may speak unprompted until it has its own licence of the same kind. **Exit:** one week of scheduled Briefs with zero honesty failures, measured — the output validator the July criterion assumed is gone, so the measurement needs an owner in whatever ships next.

## Path to the first five beta users — **BLOCKED on owner-gated acts** (added 2026-10-14)

This is the critical path today and did not exist on the July roadmap. The code verdict is *GO, conditional* (P0 §I, P1 §O). What remains is external administration, in order:

1. **Production cutover** — v2.6 + RLS authority + secret rotation: candidate SHA fixed by a no-content merge, Preview provider acceptance and job-body execution on the candidate, clone rehearsal, staged-login rehearsal, then execution under the verbatim authorisation in [production-cutover-plan.md §10](../operations/production-cutover-plan.md). **NO-GO until its §6 gates are green.**
2. **Configuration acts** — `PLATFORM_ALERTS_EMAIL`, `FM_RLS_STRICT` + role URLs, Turnstile keys, operator grants confirmed, support inbox monitored.
3. **Domain split on Production** — [domain-split-preview.md §6.2](../operations/domain-split-preview.md), after the cutover.
4. **Invite the first five** — the P1 report's operational verdict covers routine operation from inside the product.

## v3.0 — Launch (L-1) — **not started**

Billing/subscription; onboarding funnel; counsel-reviewed legal/compliance posture; tested backups + incident response + alerting; support tooling; accessibility/perf polish. **Zero new product surface.** Production Plaid is already live, so that line of the July text is retired.

**Exit:** a stranger can pay, connect a bank, share a Space with a partner, and be supported and recovered.

---

## Sequencing changes log

| Date | Change | Why | Record |
|---|---|---|---|
| 2026-07-02 | v2.6 split into v2.6a / v2.6b; AI-5 approved | AI evolution ladder | git `bb60a04` |
| 2026-07-27 | v2.6 opened from the `v2.5.0` tag with five ordered workstreams | duplicated authority was the most expensive defect class (B2, B3) | this file's history |
| 2026-08-17 | Workstreams 1–2 closed as REVIEW-3 | one coordinated convergence pass | [REVIEW-3 report](v2.6-REVIEW-3-EXECUTION-REPORT.md) |
| 2026-09-07 | v2.6a superseded; conversation layer deleted | failed dogfood; redesign from exemplars | [reset](AI-CONVERSATION-RESET.md) |
| 2026-09-13 | Conversation runtime promoted to production ahead of any "ambient" work; Daily Brief followed | measured gates, not plan order | [promotion](AI-PRODUCTION-PROMOTION.md) |
| 2026-10-01 | RLS pulled forward ahead of UX and provider work | tenancy must not depend on application code before external users | [RLS investigation](POSTGRES-RLS-ARCHITECTURE-INVESTIGATION.md) |
| 2026-10-07 | Operationalization P0/P1 run before the cutover | first-five beta operability | [operationalization investigation](OPERATIONALIZATION-INVESTIGATION-2026-10-07.md) |
| 2026-10-14 | Platform Spaces UX Refinement P1 chartered as the first v2.6 UX program; roadmap re-baselined | owner authorisation D1–D14 | [UX P1 coordination](PLATFORM-SPACES-UX-REFINEMENT-P1-COORDINATION.md) |
