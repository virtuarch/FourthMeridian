# Fourth Meridian — STATUS

*The one authoritative current-state document. Completed work is **linked, never re-described** — the record is git history, the reports under [`docs/plans/`](docs/plans/) and the runbooks under [`docs/operations/`](docs/operations/). Doctrine lives under [`docs/`](docs/README.md). If this file conflicts with the code, the code wins; fix this file.*

**Last updated: 2026-10-14 (documentation consolidation `ece2ff6`, then the reconciliation pass P2 — roadmap re-baselined, RLS runbook status reconciled, Sentry rows corrected, KD-8/KD-16 reassessed, drift guard inspected; repository read at local `749bdf0` → `1bea4cc`, remote `origin/v2.6` at `dd39087`).**

**Evidence labels used below:** **VERIFIED** = read in the repository, in GitHub CI results or in a dated report in this repository · **NOT VERIFIED** = stated by a report or memory but not re-checked in this pass · **UNKNOWN** = no evidence available without an action this pass was not authorised to take (no database, Vercel or Production access was used).

---

## 1. Project overview

Fourth Meridian is a multi-tenant personal-finance intelligence platform: Next.js 16 (App Router) + Prisma + PostgreSQL (Supabase) on Vercel. Members organise accounts into collaborative **Spaces**; a deterministic financial spine (ledger, snapshots, forecast and scenario engine) computes every figure, and a model-driven conversation layer and Daily Brief narrate those figures without calculating them. Operators run the product from five **Platform Spaces** (Platform Operations, Security Operations, Growth & Revenue, Customer Success, Merchant Operations) inside the same application. The public marketing site is a separate, zero-authority project (`site/`).

What it is and how it fits: [`docs/architecture/FOURTH_MERIDIAN_DOCTRINE.md`](docs/architecture/FOURTH_MERIDIAN_DOCTRINE.md).

## 2. Version and branch

| | |
|---|---|
| **Version** | `2.6.0` — **IN DEVELOPMENT** (`package.json`, the sole version authority; mirrored in `package-lock.json`; pinned by `lib/release-version.test.ts`). |
| **Last release** | `2.5.0`, tag `v2.5.0`, carried by `main` — [releases/v2.5.md](docs/releases/v2.5.md). |
| **Development branch** | `v2.6` (branched from the `v2.5.0` tag). `main` = Production. `main` is exactly one content-identical cherry-pick (`87e4df7`) ahead of what `v2.6` contains (VERIFIED by the cutover plan's merge-tree check, 2026-10-06). |
| **Node** | 24 (`.nvmrc`, `engines`, Vercel, CI). |
| **Protected branches** | `uxp1/base` + `uxp1/agent-1…5` are Claude 1's live Platform Spaces UX Refinement branches (see §6). Do not touch. |

## 3. Latest verified commits

| Commit | Date | What | Verification |
|---|---|---|---|
| `dd39087` | 2026-10-08 | OPERATIONALIZATION-P1-REPORT (docs only) — `origin/v2.6` HEAD | GitHub CI run 37701282029 `success` (VERIFIED) |
| `83bb03e` | 2026-10-08 | Last **code** commit; the Production **candidate** named by the P1 report | GitHub CI 37699926892 `success`; Preview `/api/health` reported `commit: 83bb03e` (VERIFIED by the P1 report §L/§M) |
| `749bdf0` | 2026-10-14 | UX-P1-BASE — local, **not pushed**; shared primitives + Overview composer stubs for the UX P1 program; no migration | Gate state **UNKNOWN** (the commit records no gate run; owned by Claude 1) |
| `1bea4cc` | 2026-10-14 | UX-P1-HERO — local, **not pushed**; the Platform area hero trimmed (one file, coordinator-owned) | Gate state **UNKNOWN** (in-flight program; owned by Claude 1) |

Every commit in the Operationalization series (`0c73f31` → `83bb03e`) has an exact-SHA GitHub run marked `success` (VERIFIED via `gh run list`).

## 4. Current development phase

**Pre-beta: code-complete for the first five beta users, awaiting Production cutover.** The Operationalization P0 and P1 programs closed on 2026-10-07/08 with the verdict *FIRST-FIVE BETA OPERATIONAL VERDICT: GO*, conditional on owner configuration acts and the Production cutover ([P0 report](docs/plans/OPERATIONALIZATION-P0-REPORT-2026-10-07.md), [P1 report](docs/plans/OPERATIONALIZATION-P1-REPORT-2026-10-08.md)). Production still serves the July release (§13). In parallel, **Platform Spaces UX Refinement P1 is IN PROGRESS** (§6).

## 5. Completed milestones (linked, newest first)

- **2026-10-14 — UX P1 base** (`749bdf0`): five shared primitives, status-token aliases, `WidgetMessage` live regions, the Overview composer with frozen block contract. Local only. The investigation and coordination contract: [investigation](docs/plans/PLATFORM-SPACES-UX-REFINEMENT-P1-INVESTIGATION-2026-10-14.md) · [coordination](docs/plans/PLATFORM-SPACES-UX-REFINEMENT-P1-COORDINATION.md).
- **2026-10-07/08 — Operationalization P0 + P1** (`0c73f31`, `8d64468`, `cc790cd`; `da015fe` → `83bb03e`): AI attribution and failure rows, Plaid webhook facts, alerting floor with the Preview alert path proven, beta intake, factual public/legal copy (`docs/operations/legal-factual-basis-2026-10-07.md`); then the Customer Success spine, entitlement catalogue + resolver, policy groups and cohorts, 15-minute dispatcher wake with ledger-driven cadence, Refresh All, the operator action envelope with reason and before/after. Migrations `20261007100000_operationalization_p0_facts`, `20261008000000_p1_customer_policy_cohort`.
- **2026-10-07 — Conversations: advice boundary, hardening, liquidity access** (`df61ac6`, `3ff9e0f`, `a6a9c61` → `049c669`, `e8fc400`): deterministic guidance notes, Markdown image exfiltration sink closed, provenance carrier, `providerSubtype` + liquidity access (HSA / retirement out of unrestricted cash). Doctrine: [`docs/systems/ai-financial-guidance-boundary.md`](docs/systems/ai-financial-guidance-boundary.md), [`docs/systems/ai-conversations-security-model.md`](docs/systems/ai-conversations-security-model.md).
- **2026-10-02 → 10-07 — Public/app domain split**: architecture ([plan](docs/plans/PUBLIC-APP-DOMAIN-SPLIT-ARCHITECTURE.md)), Stage A/B (`f75f792`), `site/` as a separate zero-authority Vercel project, Preview two-origin rehearsal run end to end ([record](docs/operations/domain-split-preview.md), `60af144`), Ignored-Build-Step fix (`f541133`), revoked-session shell fix (`c7e72ed`), environment separation inventory ([record](docs/operations/environment-separation.md), `d2869a2`).
- **2026-10-04 → 10-07 — Plaid hardening**: DB-level PLAID identity exclusivity (`d02b61b`/`16c638a`), liveness (`772f845`), revoke (`f339e57`), pagination-mutation restart (`1988067`), webhook `kid` verification fix (`ea48807`), Connections truth (`fc86771`), Investments consent truth (`7e91477`), Preview Plaid Sandbox lane ([record](docs/operations/plaid-sandbox-lane-2026-10-06.md), `0bc1fed`).
- **2026-10-01 → 10-06 — Postgres Row-Level Security rollout** (`RLS-0`…`RLS-16`, the C/AI/P/ACC/D1/PREP series, `RLS-EXECUTE` `1ef016c`, `STRICT-PRODUCTION` `dc3755f`, `TENANT-IDLE` `b280766`, `LOGIN-FM_AUTH` `bfb6cbd`): three runtime roles (`fm_app`, `fm_auth`, `fm_system`) plus `fm_backup`, strict mode, the `db-authority` ratchet. Architecture: [investigation](docs/plans/POSTGRES-RLS-ARCHITECTURE-INVESTIGATION.md). Runbook: [rls-preview-cutover.md](docs/operations/rls-preview-cutover.md). Merchant Operations platform area (`ff6395c`, `01ab98a`).
- **2026-10-03/04 — PERF-1…4** dev-server memory (`f930ac5`); goal-seek return + spending baseline (`a9430a4`, `ec741ba`; [investigation](docs/plans/V26-INVESTIGATION-SHORT-HORIZON-GOAL-SEEK-AND-SPENDING-BASELINE.md)); Brief quota handling (`db1950b`); Plaid cleanup ops (`158a427`).
- **2026-10-01 — Crypto refresh incident and repair** ([incident](docs/plans/CRYPTO-REFRESH-INCIDENT-2026-10-01.md), [closure](docs/plans/CRYPTO-REFRESH-REPAIR-CLOSURE-2026-10-01.md), [operator procedure](docs/plans/CRYPTO-REFRESH-REPAIR-OPERATOR-PROCEDURE.md)).
- **2026-09-21/22 — Pre-S1 full-system audit + gate repair + S1 category spending**: the [PRE-S1 audit](docs/audits/PRE-S1-FULL-SYSTEM-AUDIT-2026-09-21.md) (`7a0a3ef`, 73 findings — the live defect register, §10), gate repair (`52d91a7`), CI parity on Node 24 with the clean-copy `npm run ci` contract (`c0edb87`, `8ceafec`), S1 (`377ef1e` → `e750055`; [investigation](docs/plans/AI-CATEGORY-SPENDING-S1-INVESTIGATION.md)).
- **2026-09-20/21 — Space and finance surfaces**: Debt Overview APR + per-liability payoff (`c357660`, `1192598`, `1134b65`), Cash Flow spending reconciliation and tiers (`7bdae15`, `3702bb3`; [investigation](docs/plans/TRANSACTION-REFUND-ECONOMICS-INVESTIGATION.md)), refund economics (`382897e`), money presentation contract (`6c40490`, `2a201f7`), workspace sidebar + Net Worth parent + Markets skeleton (`12a6e44` → `f3ef01b`, `496bf7b`), Space history contract (`a6c098c`), one primary nav (`0a60cc2`), site nav inside a Space (`2ff01a2`).
- **2026-09-20/21 — AI programs on the promoted runtime**: post-M1 architecture program (`b9e9fd6`, 47 commits; [closure](docs/plans/AI-POSTM1-ARCHITECTURE-PROGRAM-CLOSURE.md)), Financial Memory V2 ([design](docs/plans/AI-FINANCIAL-MEMORY-V2-DESIGN.md)), planning continuity (`264d91e`; [closure](docs/plans/AI-PREEXECUTION-PLANNING-CONTINUITY-CLOSURE.md)), I1 income changes ([closure](docs/plans/AI-INCOME-CHANGES-I1-CLOSURE.md)), M1 measures/comparison (`d056898`), L1 liability dynamics (`2c59c04`).
- **2026-09-13/15 — Conversation runtime promoted to production** (`989d63d`, `POST /api/ai/chat`, model `gpt-5.1`; [record](docs/plans/AI-PRODUCTION-PROMOTION.md), [dogfood gate](docs/plans/AI-GPT51-PROMOTION-DOGFOOD-GATE.md)); Daily Brief 1–4.1 (`0e1cf1e` → `fd41f5a`); scenario continuity + liquid floor + checkpoints + elapsed time; exact temporal predicates (`0700c56`); transcript cache (`e01414b`); Platform Ops policies, control and cockpit (`34e592c`, `27d6d22`, `e94da68`, `a655b38`; [investigation](docs/plans/PLATFORM-OPS-CONTROL-PLANE-INVESTIGATION.md)); incremental ETH history (`891458f`); the dev-database guard (`cdeac7e`, `b26fbeb`) after the [2026-09-15 recovery](docs/plans/DATABASE-ROLLBACK-RECOVERY-2026-09-15.md) — [`docs/operations/database-safety.md`](docs/operations/database-safety.md) is binding.
- **2026-09-07 → 09-09 — AI conversation reset and rebuild**: the previous conversation layer was deleted (`95512bb`; [record](docs/plans/AI-CONVERSATION-RESET.md)), then re-designed from exemplar conversations through a measured baseline harness and a series of recorded experiments (`docs/plans/AI-CONVERSATION-*.md`, `AI-GPT51-*.md`, [cost economics](docs/plans/AI-BETA-COST-ECONOMICS-INVESTIGATION.md)). Platform Ops cost accounting (`26ca0b9` → `2ae717d`).
- **2026-08-17 — v2.6 REVIEW-3 Semantic Authority Convergence** closed as a program (64 commits; [report](docs/plans/v2.6-REVIEW-3-EXECUTION-REPORT.md)); the **historical-truth arc** (replay, provider-bound crypto history, aggregate authorisation, universal lens roots — [investigation](docs/plans/v2.6-INVESTIGATION-UNIVERSAL-LENS-ROOTS.md)).
- **2026-07-27 — v2.5 released** ([releases/v2.5.md](docs/releases/v2.5.md)); V26-PRE B1–B5 production hardening integrated and production-verified.

## 6. Active workstreams and ownership

| Workstream | State | Owner | Record |
|---|---|---|---|
| **Platform Spaces UX Refinement P1** | **IN PROGRESS** (started 2026-10-14). Base `749bdf0` committed locally on `v2.6` and mirrored as `uxp1/base`; five agent worktrees (`/Users/chrstn/dev/FourthMeridian-uxp1/agent-1…5`, branches `uxp1/agent-1…5`). At the time of this pass all five branches were still at the base commit with clean trees (VERIFIED). Merge order 1 → 5 into `v2.6` with `--no-ff`, then build, `npm run ci`, push, GitHub CI, Preview seed (label converge only) and verification. | Claude 1 (coordinator) + agents 1–5; owner decisions D1–D14 in force | [coordination](docs/plans/PLATFORM-SPACES-UX-REFINEMENT-P1-COORDINATION.md) · [investigation](docs/plans/PLATFORM-SPACES-UX-REFINEMENT-P1-INVESTIGATION-2026-10-14.md) |
| **Production cutover** (v2.6 + RLS authority + `NEXTAUTH_SECRET` / `CRON_SECRET` rotation) | **PLAN ONLY — NO-GO** until the plan's §6 preflight gates and §8 issues 1–6 are green. Nothing executed on Production. | Owner (every Production step needs explicit authorisation, verbatim scope in the plan's §10) | [production-cutover-plan.md](docs/operations/production-cutover-plan.md) |
| **Domain split, Production** | Rehearsed on Preview; Production steps **NOT done** (they follow the cutover) | Owner | [domain-split-preview.md §6](docs/operations/domain-split-preview.md) |
| **Status documentation** | This pass (2026-10-14): STATUS rewritten, drift audits retired (§15) | — | this file |

File ownership during the UX P1 program is exclusive and listed in the coordination contract (platform widgets, `lib/platform/**`, platform routes, navigation files, the shared primitives). Anything not listed there must not be edited without asking the coordinator.

## 7. Outstanding tasks

**Before the Production cutover (from the plan, all owner-gated):**
1. Fix the candidate SHA: the no-content merge of `origin/main` into `v2.6` so `main` fast-forwards to the tested SHA; the candidate must be at or after `83bb03e` (the plan's addenda name `1988067`, `ea48807`, `fc86771`, `7e91477` as mandatory).
2. Plaid Sandbox provider acceptance on Preview **on the candidate**; every scheduled job body exercised once on Preview under the role topology (no scheduled job has ever run in a deployed v2.6 environment — 0 `JobRun` rows on Preview, ever).
3. Clone rehearsal of the 35 pending migrations + the `economicDate` backfill + audits + `rls:accept` on a copy of Production's rows; staged-URL login rehearsal; backup/restore rehearsal.
4. Owner configuration acts: `PLATFORM_ALERTS_EMAIL` on Production (the candidate **refuses to boot** without it), `FM_RLS_STRICT=true` + the three role URLs at cutover, Turnstile keys, confirm the operator account's grants and the monitored `support@` inbox.

**After the cutover:** domain-split Production steps 1–10 (`app.` host, Plaid allowlist, apex move, per-Item webhook URL update before the apex moves, second `NEXTAUTH_SECRET` rotation); `main` fast-forward.

**Engineering P2 (deferred by the P0/P1 reports, not beta-blocking):** beta-queue and `/admin` break-glass actions onto the operator envelope; AuditLog DB-level append-only; `next build` added to the local CI contract; readers/retention for `PlaidWebhookEvent` and `BetaAccessRequestEvent`; `AiInvocation.userId` scrub on purge; an operator "pause this job" lever; wallet Refresh All proven on Preview (no wallet connection exists there).

**Documentation re-baseline owed (P1-7 of the operationalization investigation):** `docs/systems/ai-foundation.md` (carries its own stale banner, FM-AUDIT-066), `docs/systems/platform-operations.md` (2026-07-25), `docs/operations/admin-operations.md`, `incident-response.md`, `background-jobs.md` (July), `app/api/platform/README.md` (2026-07-13). *Done 2026-10-14:* the [roadmap](docs/plans/ROADMAP.md) re-baselined with a sequencing-changes log; the RLS runbook header reconciled to "executed on Preview 2026-10-06, not on Production" with its evidence named; the Sentry rows corrected (§12).

**Owner / counsel decisions (unchanged since P0):** OpenAI API retention window; whether Vercel/Supabase/Resend/Sentry are named as sub-processors; regulatory sufficiency of the guidance posture; counsel review of terms/privacy (deferred to v3.0 by the readiness doc).

## 8. Known blockers and risks

| # | Blocker / risk | Evidence | Class |
|---|---|---|---|
| 1 | **Production runs the July release** (`87e4df7`, deployed 2026-07-27): pre-RLS, pre-P1 session model (a JWT signed with the shared `NEXTAUTH_SECRET` is accepted without a session-row proof), 35 migrations behind, Plaid webhook `kid` defect (`ea48807`) present on `main`. | cutover plan §1 (measured 2026-10-06, read-only) | Cutover |
| 2 | **v2.6's Plaid paths have never touched Production Plaid Items**; after promotion `sync-banks` (06:00) and inbound webhooks run v2.6 code against 3 ACTIVE real Items. | cutover plan §8 issue 1 | FIX BEFORE CUTOVER (or explicit owner risk acceptance) |
| 3 | `PLATFORM_ALERTS_EMAIL` absent from Production and now in `PROD_REQUIRED_KEYS` — a Production deploy of the candidate will not boot until it is set. | cutover plan §1; P0 report §I | Config act |
| 4 | Turnstile keys absent from Production ⇒ CAPTCHA is a no-op (`verifyCaptchaToken` returns true without a secret). | readiness doc gate 4; cutover plan §1 env list (not present) | Config act before external beta |
| 5 | `registration_mode = invite_only` verified on Production 2026-08-17; **not re-verified since**. | REVIEW-3 census | NOT VERIFIED |
| 6 | `ENCRYPTION_KEY` and `PLAID_CLIENT_ID` are one record shared by Preview and Production; no keyring, so rotation is not possible without re-encryption. `OPENAI_API_KEY` owner-stated same value in both. | environment-separation.md §4 | Launch debt, SAFE TO DEFER |
| 7 | `DISABLE_SYSTEM_ADMIN` Production value unknown; the admin account may be locked out (the owner operates as `USER` with grants). | cutover plan §8 issue 11 | UNKNOWN, deferable |
| 8 | Preview is behind Vercel SSO and Vercel never runs crons there, so Preview cannot prove scheduled execution or public-internet exposure; four named differences from Production. | environment-separation.md §3; domain-split-preview.md §6.3 | Accepted limitation |
| 9 | The local CI contract has no `next build`; one server-only/client-boundary defect reached a Preview build before it was caught (`c20c741`). | P1 report §N | P2 |
| 10 | Money is `Float` ([ADR-005](docs/decisions/ADR-005-numeric-precision.md)); solo-maintainer bus factor; documentation weight versus maintenance capacity. | readiness doc | Standing |
| 11 | Dev database was reset by a non-interactive `prisma migrate dev` on 2026-09-15 and restored from the 2026-08-26 backup; the guard that prevents a repeat is in place (`cdeac7e`, `b26fbeb`). | [recovery record](docs/plans/DATABASE-ROLLBACK-RECOVERY-2026-09-15.md) | Closed in code; data loss on Dev stands |

## 9. Architecture and infrastructure status

- **Application:** Next.js 16 App Router, TypeScript strict, Prisma, Tailwind v4, NextAuth (session rows with revocation on `v2.6`), AES-256-GCM with HKDF per-purpose keys. Region `sin1`. Hosting project `fintracker1` (app) and `fourth-meridian-site` (public site, `site/`).
- **Domains (target topology, rehearsed on Preview):** `fourthmeridian.com` = public site, `app.fourthmeridian.com` = application. Preview: `preview.fourthmeridian.com` (site) and `preview-app.fourthmeridian.com` (app). **Production today:** the apex serves the application; `app.` is not configured.
- **Financial spine:** one ledger with canonical balances, snapshot read boundary, Financial Truth Spine and Time Model doctrine ([`docs/architecture/`](docs/architecture/)); forecast + scenario engine with liability dynamics, income changes, category spending, liquid floor and goal seek ([`docs/systems/forecast.md`](docs/systems/forecast.md)).
- **AI:** `POST /api/ai/chat` is live (model `gpt-5.1`, via the single provider seam) — a tool-calling conversation engine under `lib/ai/conversation`, the active-scenario envelope in a sealed `HttpOnly` cookie, Financial Memory V2 (user-stated money only), the Daily Brief with per-source data health, `AiInvocation` cost and attribution facts. The guidance boundary and conversations security model are doctrine ([`docs/systems/`](docs/systems/)). *`docs/systems/ai-foundation.md` still describes the pre-reset state and says so in its banner.*
- **Jobs:** `vercel.json` schedules `/api/jobs/dispatch` every 15 minutes (wake only; per-job cadence resolved by `lib/jobs/cadence-policy.core.ts` from policy and ledger) and `/api/jobs/resume-stale-imports` every 5 minutes (VERIFIED in `vercel.json`). Runbook `docs/operations/background-jobs.md` predates the cadence policy.
- **Platform Spaces:** five areas with READ / WRITE / CONTROL grants, fresh-session gating on writes, the operator action envelope (`recordOperatorAction`: actor, target, reason, before/after), identity-minimised PLATFORM_OPS projections, Customer Success spine with entitlement resolution (POLICY → OVERLAY → CEILING). Design studies: [`docs/design-studies/`](docs/design-studies/).
- **Providers:** Plaid (bank/brokerage; sandbox on Preview since the 2026-10-06 lane, production secret on Production), BTC via Esplora/blockstream, ETH via Alchemy, SOL, CoinGecko quotes, Open Exchange Rates, Tiingo. Provider-neutral ingestion remains deferred by design ([ADR-006](docs/decisions/ADR-006-provider-abstraction-timing.md)).

## 10. Known issues register

**The live defect register is [`docs/audits/PRE-S1-FULL-SYSTEM-AUDIT-2026-09-21.md`](docs/audits/PRE-S1-FULL-SYSTEM-AUDIT-2026-09-21.md)** (73 numbered findings, FM-AUDIT-001…073). Since it was written, commit messages have cited 19 distinct FM-AUDIT ids as addressed (VERIFIED by `git log`); a citation is not a verified closure, and no closure census has been run since — treat the per-finding state as NOT VERIFIED until one is.

Legacy KD tickets still carried:

| ID | Issue | State (2026-10-14) |
|---|---|---|
| KD-12 | Audit-log write amplification per chat turn | Open, low. `AI_CONTEXT_ASSEMBLED` once per context build; the promoted runtime's per-turn audit shape has not been re-measured (NOT VERIFIED). |
| KD-14 | `AiAdvice` has no production write path | **Open.** Zero `aiAdvice.create/upsert/createMany` call sites repo-wide (VERIFIED 2026-10-14). The Daily Brief ships without it. |
| KD-15 | UI transaction-privacy leak | The KD-15 visibility predicate exists in code (`lib/transactions/detail-query.ts` and consumers); the [checklist](docs/initiatives/kd15/KD-15_IMPLEMENTATION_CHECKLIST.md) still reads "awaiting approval". Closure NOT VERIFIED against the checklist. |
| KD-8 | *Original (2026-07-02):* master-mode chat with an unbounded prompt; failed Spaces silently omitted (`Promise.allSettled`) with no disclosure. *Marked MOOT 2026-09-07* because the prompt builder was deleted. | **SUPERSEDED — owner decision 2026-10-14.** History: the 2026-09-07 "moot" ground expired when the conversation runtime was promoted (2026-09-13), but the live runtime never rebuilt a multi-Space prompt. Every turn binds to exactly one Space re-resolved server-side (`app/api/ai/chat/route.ts`: a named Space that does not resolve is a 403, never a fallback), and the client's `'master'` sentinel now means "no Space named → the user's own Space" (`lib/ai/conversation/request.ts`). Prompt size is bounded by turn, message and transcript ceilings plus compaction. The two recorded requirements (deduped cross-Space figure; UNAVAILABLE-Space disclosure) have no surface to apply to. *Residual, not a defect:* the sentinel's name would misdescribe a single-Space answer if a client label still said "all Spaces"; no client file sends the literal today (grep, VERIFIED). Re-open only if a cross-Space prompt is ever reintroduced. |
| KD-16 | *Original:* contradictory data-availability claims across intent paths; the active window re-derived per turn from message-text heuristics with silent failure modes (`"since <year>"` → closed calendar year; undisclosed `MAX_EXPLICIT_WINDOW_DAYS` clamp). *Marked MOOT 2026-09-07* because "there are no turns". | **Reassessed 2026-10-14 — recommend SUPERSEDED as to the root cause, and REOPENED in narrowed form.** The heuristic resolver (`lib/ai/intent/classifier.ts`) no longer exists; time now enters through tool contracts with separated authorities (`lib/ai/temporal-scope.ts`: requested / selected / coverage / satisfied), the coverage envelope that states what exists versus what was loaded, two measured frames with measured existence rules (`lib/ai/conversation/activity-frame.ts`), and exact temporal predicates taken off the model. That closes the defect as filed. What is **not** closed: the AI-5 acceptance criterion "no reply silently changes its time window" was a *cross-turn* property, and the runtime is stateless by design (the sealed carrier holds the scenario, not the answered window), so nothing today pins that a follow-up answers over the same window as the previous reply or discloses a change. **Recommend a new ticket for that narrowed criterion against the live runtime, measured in the harness before any code; owner decision needed.** |
| FM-AUDIT-066 | `docs/systems/ai-foundation.md` describes the deleted conversation layer | Open; banner in place. |

## 11. Database and migration status

| Environment | Migrations | Roles / RLS | Evidence |
|---|---|---|---|
| **Repository** | **123** on disk; newest `20261008000000_p1_customer_policy_cohort`. The UX P1 base adds none. | Ten RLS migrations + function least-privilege (`20261006000000`) | VERIFIED (`prisma/migrations`) |
| **Dev** | P1 migration applied via `db:migrate:safe` on 2026-10-08; `migrate diff` clean apart from a pre-existing truncated index name | Guarded by `FM_DB_GUARD`; agent worktrees carry no `DATABASE_URL` (clone-only) | P1 report §K — NOT re-verified (no database access this pass) |
| **Preview** (`lqagrryecvhbaqvczjgc`) | Up to date at the P1 migration ("Database schema is up to date!", 2026-10-08); platform sections seeded | `fm_app` / `fm_auth` / `fm_system` live, `FM_RLS_STRICT=true`, `db-authority` green | P1 report §K; environment-separation.md §4 — NOT re-verified |
| **Production** (`qirfzvvaeddukjiphims`, Micro, PG 17.6) | **88 applied, 35 pending** (additive, old-client compatible per the plan); `economicDate` backfill ×2 pending | No `fm_*` roles; 0/55 tables RLS; Data API exposes 0 tables | cutover plan §1 (measured 2026-10-06) — NOT re-verified; **Production not accessed this pass** |

Binding rules: [`docs/operations/database-safety.md`](docs/operations/database-safety.md) (never `prisma migrate dev` non-interactively; `db:migrate:safe`; `DATABASE_URL`/`DIRECT_URL` sameness is provable). The `db-authority` baseline (`scripts/lib/db-authority-baseline.json`: owner-client importers, owner-default sites, implicit owner calls) may only shrink.

## 12. Security and authorization status

- **Tenancy:** Postgres RLS with role-scoped runtime principals on `v2.6` (Preview live; Production pending cutover). Tenant phases via `withTenantDb`; system work as `fm_system`; residue on the migration principal is enumerated and ratcheted (`rls-preview-cutover.md` §0).
- **Sessions:** `v2.6` requires a session-row proof and revokes cleanly (revoked-session shell fix `c7e72ed`); Production's deployed model is the pre-P1 shared-secret JWT (cutover plan §1). Preview `NEXTAUTH_SECRET` and `CRON_SECRET` are separated from Production; the Production rotation is part of the cutover.
- **Plaid:** webhook verification no longer fetches keys for an unauthenticated attacker-chosen `kid` (`ea48807`, on `v2.6` only); access tokens AES-256-GCM `v2:`; identity exclusivity enforced by a partial unique index; secrets never reach logs from any catch block (`706e62a`).
- **Platform access:** three-rank grants with fresh-session gating; every platform route calls `requirePlatformAccess(area, level)`; CONTROL mutations audited with reason; PLATFORM_OPS projections carry no email, user id, address or token (pinned by `observability-privacy.test.ts`, `read-boundary.test.ts`, `capability-control.test.ts`).
- **Public site:** zero-authority project; `lib/public-site-boundary.test.ts` pins the content twins and the boundary.
- **Monitoring:** Sentry wired (`instrumentation.ts`, job and AI-provider failure capture since P0). **Configured ≠ delivering.** `NEXT_PUBLIC_SENTRY_DSN` is **present** on Production by name (2026-10-06 measurement; the readiness doc's older "absent" row is corrected). Production *event delivery* was last proven on 2026-07-27 for the v2.5 build ([investigation](docs/plans/Sentry-Production-Health-Investigation.md): last event 2026-07-26, all issues fixed); delivery from v2.6 code is unproven until the cutover deploys it, and Preview delivery has never been asserted. The cutover acceptance should include one deliberately captured event.
- **Open:** CAPTCHA no-op on Production (§8 #4); CSP is Report-Only per the readiness doc (NOT re-verified); failed `/api/auth/pre-login` attempts write no `LOGIN_FAILED` row (observability gap, domain-split record §6.3).
- Doctrine: [`docs/architecture/SECURITY_MODEL.md`](docs/architecture/SECURITY_MODEL.md); checklists under [`docs/operations/`](docs/operations/) (July baseline, pre-RLS).

## 13. Testing and CI status

- **GitHub CI** (`ci.yml`): `test`, `Architecture audits`, `Public site (zero-authority boundary)`. Last run on the pushed HEAD `dd39087`: 37701282029 `success` (VERIFIED). `status-drift-guard.yml` is an advisory, PR-only tripwire that flags migrations landing without a STATUS.md change. **Inspected 2026-10-14 after the drift-audit folder was deleted:** it never referenced that folder (its inputs are the PR diff, `STATUS.md`, `prisma/migrations/`, and `docs/initiatives/**` closeout names), its YAML parses, and a local dry run of its shell logic behaves as written (a range touching `STATUS.md` → no flag; `0c73f31` and `da015fe`, each adding a migration without STATUS → would flag). It has **never run**: the repository has never had a pull request and the workflow fires only on `pull_request`, so direct pushes to `v2.6` — the actual workflow — are invisible to it. Proposed change, **not applied**: add a `push` trigger diffing against the previous SHA (as the site's Ignored Build Step now does) and extend the closeout pattern to `docs/plans/*-REPORT-*.md` / `*-CLOSURE*.md`, keeping it advisory. Owner decision.
- **Local contract:** `npm run ci` runs GitHub's jobs on a clean copy of committed HEAD, on Node 24, against a throwaway `postgres:16` (`c0edb87`). It does **not** run `next build` (§8 #9). Push explicit SHAs after a green run.
- **Last recorded figures** (P1 report at `83bb03e`): 692/692 unit test files; typecheck clean on committed trees; lint no errors in tracked files; ratchets green (`db-authority`, `read-boundary`, `platform-surface`, `observability-privacy`, `security-surface`); site 45/45; `rls:accept:foreground` 67/67 and all five RLS suites green in the clean copy. These figures are not re-measured here; the authoritative count is whatever `npm run test:unit` prints.
- **Known harness caveat:** `npm run ci` has blocked on a varying child test with 0% CPU (root cause unknown); affected tests pass alone. Never kill `fm-ci-*` processes unscoped — a peer's gate may be live.

## 14. Deployment status by environment

| | Dev | Preview | Production |
|---|---|---|---|
| **Code** | Main worktree on `v2.6` at the unpushed UX P1 commits (`749bdf0` base, `1bea4cc` hero, this docs commit); five agent worktrees cut from the base, with agents 1–3 already carrying uncommitted edits at the time of this pass | Follows the newest `v2.6` deployment. Last **verified** health commit `83bb03e` (P1 report). `dd39087` (docs-only) was pushed afterwards, so Preview is expected to be on it — **NOT VERIFIED** this pass | `87e4df7` on `main`, deployment created 2026-07-27, aliases `fourthmeridian.com` (cutover plan §1, measured 2026-10-06) — **not accessed this pass** |
| **Database** | Dev DB with `FM_DB_GUARD`; restored 2026-09-15 from the 2026-08-26 backup | 123 migrations, RLS roles, strict mode (§11) | 88 migrations, no RLS (§11) |
| **Auth / secrets** | `.env.local` | Own `NEXTAUTH_SECRET` and `CRON_SECRET` on the `v2.6` scope; behind Vercel SSO | Shared `NEXTAUTH_SECRET` record with generic Preview; `PLATFORM_ALERTS_EMAIL` absent |
| **Plaid** | per `.env.local` | Sandbox lane (2026-10-06); legacy Preview Items are owner-verified sandbox data | `PLAID_ENV=production`; 3 ACTIVE, 1 NEEDS_REAUTH, 3 REVOKED Items (2026-10-06) |
| **Jobs** | manual | Vercel crons never run on Preview (proven: 0 `JobRun` rows ever) | Crons healthy at measurement (0 failures in 7 days) |
| **Public site** | `site/` | `preview.fourthmeridian.com` (separate project) | Apex still served by the app; site project's Production branch is `main` |
| **Users** | local | test accounts + Sandbox lane customer | 2 users (1 SYSTEM_ADMIN), both TOTP-enrolled; 1 active in the last 30 days |

**Do not assume Production matches Preview.** Production is a July build with a July schema; every v2.6 behaviour described in this file is Preview-proven at best until the cutover runs.

## 15. Next priorities (in order)

1. **Land Platform Spaces UX Refinement P1** (Claude 1): agent work → merge 1→5 → build + `npm run ci` → push explicit SHA → GitHub CI → Preview seed and verification → report.
2. **Production cutover preflight** (owner): fix the candidate SHA, Preview provider acceptance and job-body execution on the candidate, clone rehearsal, staged-login rehearsal, config acts (§7). Then the cutover itself under the verbatim authorisation in the plan's §10.
3. **Domain split on Production** (owner), after the cutover.
4. **Documentation re-baseline** of the systems and operations docs named in §7 (the roadmap, the RLS runbook header and the Sentry rows were reconciled on 2026-10-14; the owner decisions on KD-8/KD-16 and on the drift-guard trigger are open — §10, §13).
5. **P2 engineering list** (§7), starting with `next build` in the CI contract.

## 16. Documentation map

| Looking for… | Read |
|---|---|
| Current state | **this file** (the drift-audit series under `docs/audits/status-drift/` was retired on 2026-10-14 after this rewrite consumed its findings; history is in git) |
| What is Fourth Meridian / how it fits | [`docs/architecture/FOURTH_MERIDIAN_DOCTRINE.md`](docs/architecture/FOURTH_MERIDIAN_DOCTRINE.md) |
| The rules that bind the code | [`docs/architecture/`](docs/architecture/) |
| Why a subsystem exists & its contracts | [`docs/systems/`](docs/systems/) |
| Decisions & rejected alternatives | [`docs/decisions/`](docs/decisions/) |
| Live defect register | [`docs/audits/PRE-S1-FULL-SYSTEM-AUDIT-2026-09-21.md`](docs/audits/PRE-S1-FULL-SYSTEM-AUDIT-2026-09-21.md) |
| Roadmap / plans / investigations / program reports | [`docs/plans/`](docs/plans/) ([ROADMAP.md](docs/plans/ROADMAP.md), [parked-ideas.md](docs/plans/parked-ideas.md)) |
| Runbooks / cutover / readiness / environment facts | [`docs/operations/`](docs/operations/) |
| What shipped per version | [`docs/releases/`](docs/releases/) |
| Design language / Atlas / Platform design studies | [`docs/design-system/`](docs/design-system/) · [`docs/design-studies/`](docs/design-studies/) |
| Historical decision context | [`docs/archive/completed-plans/`](docs/archive/completed-plans/) |
