# PO1 — Platform Operations Architecture · Investigation & Roadmap

**Status:** INVESTIGATION + ARCHITECTURE ONLY — no code, no schema, no roadmap edits, no STATUS.md changes
**Date:** 2026-07-06 · investigated against the working tree (post-MC1, post-FlowType P5, `f22de52` era)
**Proposed track:** `PO-x` (platform operations) — allocation in STATUS.md §4 happens at implementation approval, not by this document; this folder reserves the ID per the namespace rule
**Relationship to OPS-1:** `docs/initiatives/ops1/OPS1_OPERATIONAL_FLOOR_PLAN.md` (the operational floor) is **Phase 0 of this roadmap** — the entry gate, not a competing initiative. PO1 is the architecture that grows above the floor.
**Doctrine (inherited from MC1, binding):** investigation first · architecture before implementation · smallest additive slices · one seam per capability · behavior-neutral substrate before cutover · every phase independently shippable and revertible · validation gates throughout · no opportunistic refactors.

**Framing:** *"Fourth Meridian operating Fourth Meridian."* The endgame is that the platform's own primitives — dashboards, briefs, deterministic AI, lenses, snapshots — run the business itself. The central architectural claim of this document: that endgame is reachable **only** if telemetry is treated the way MC1 treated currency provenance — *captured first, because it cannot be reconstructed later* — and only if the customer-tenancy boundary is never bent to get there.

---

## PART 1 — CURRENT STATE AUDIT

All rows verified directly against the repository.

### 1.1 Capability inventory

| Capability | State | Evidence & notes |
|---|---|---|
| Authentication | **Strong for stage.** Credentials + bcrypt(12), TOTP + recovery codes (bcrypt-hashed, single-use), platform-level TOTP enforcement, admin kill switch (`DISABLE_SYSTEM_ADMIN`), failed logins audited | `lib/auth.ts`, `lib/totp.ts`, `lib/recovery-codes.ts`, `proxy.ts` |
| Authorization | **Two clean layers.** Route middleware (role split at `proxy.ts`) + centralized Space policy (`lib/spaces/policy.ts` — pure, tested). Known soft spot: documented "residuals" applied ad hoc at routes | SP-2 complete; policy header lists residuals |
| Sessions | **Weaker than advertised.** JWT strategy; `UserSession` table + revocation cache exist, but the schema comment is candid: *"This table is informational for now; full revocation requires a token blocklist"* | `prisma/schema.prisma` UserSession comment; `lib/session-cache.ts` |
| Email | **Nothing.** No provider, no send module | OPS-1 investigation §1 |
| Password reset | Token machinery production-grade; delivery is dev-only (URL in response body) | `app/api/auth/forgot-password/route.ts` |
| Verification | None (no `emailVerified*` field) | schema User model |
| Invitations | In-app only; `SpaceInvite` requires an existing `invitedUserId`; no email path, no beta invite concept | schema SpaceInvite |
| Deletion | No endpoint; `onDelete` graph unaudited | `app/api/user/` |
| Export | None (exceljs/papaparse serve import) | `lib/imports/` |
| Monitoring / error reporting | **Zero.** No Sentry-class tool; no `instrumentation.ts` (so `validateEnv()` is also never called) | `lib/env.ts` header |
| Health | No health endpoint, no uptime monitor, no status page | route inventory |
| Logging | `console.*` only; unstructured; FX failures explicitly console-logged with "no SyncIssue kind" as named residual debt | STATUS MC1 Phase 1 residuals |
| Metrics / observability | **The oldest named debt in the repo.** v2.4.5 counters (fallback hits, sync stats, LLM tokens) named 2026-07-02, still unimplemented | STATUS §5 v2.4.5 carry-forward |
| Rate limiting | Implemented, **off by default**, TOTP gaps, fails open silently | `lib/rate-limit.ts`; KD-3 |
| Security headers | None | `next.config.ts` |
| Secrets | Env-var based; live keys in cloud-synced local files (KD-13 root cause); no rotation story; `ENCRYPTION_KEY` is single point of total loss | 2026-07-06 audit §8.3 |
| Audit | **Best ops primitive in the repo.** Append-only, indexed on `(action, createdAt)`, `performedByAdminId` for on-behalf-of, `metadata Json` | schema AuditLog |
| Jobs / scheduler / background work | Two Vercel crons real (sync-banks 06:00, fetch-fx 06:30); `startScheduler()` **never invoked anywhere**; `sync-crypto.ts` is literally `export {}`; `run-ai-advice` stub; `purge-trash` never runs; **no job-run ledger of any kind** — a cron that silently stops firing is undetectable | `jobs/*`, `vercel.json`; KD-14 |
| Feature flags | Env vars only (`AI_OUTPUT_VALIDATION_MODE`, `RATE_LIMIT_*`); no per-user/cohort flags; flags undocumented in `.env.example` (named debt) | STATUS §5 |
| Platform settings | Exists but security-only (5 TOTP/password keys); clean helper chokepoint ready to grow | `lib/platform-settings.ts` |
| Admin capabilities | Real surface: users, spaces oversight, audit viewer, session revocation, TOTP enforcement, redacted Plaid diagnostics, expand-history workflow. Residue: `app/admin/workspaces/` still exists beside `spaces/`; `lib/admin/` holds only `provider-lifecycle.ts` | `app/admin/*`, `app/api/admin/*` |
| Analytics | **Absolutely none.** No product analytics, no aggregates, no counts endpoint — not even "how many users" exists as a query anywhere outside `admin/overview` | route inventory |
| Operational dashboards | Admin pages are entity CRUD/inspection, not operations (no time-series, no rates, no trends) | `app/admin/*` |
| Support workflows | None (ratified out of Phase 2 by D10; still true) | STATUS D10 |
| Legal / privacy / compliance | No ToS/Privacy/LLM disclosure (STATUS blocker 7); no retention policies; no DPA; SOC 2 nowhere (fine for stage) | STATUS §6.7 |

### 1.2 Strengths (real, reusable)

1. **Append-only fact tables already exist and are the correct pattern:** `AuditLog`, `FxRate` (immutable dated archive), `SyncIssue` (D2.x integrity gate M1), `SpaceSnapshot` (frozen daily computed totals). Platform operations is *mostly this same idiom pointed at the platform itself.*
2. **Chokepoint seams are the house style and they are exactly where telemetry originates for free:** single LLM import (`lib/ai/provider.ts` → token counts live here), single rate-limit module (→ hit/fail-open counters), single sync engine (`syncTransactionsForItem` → sync stats), single decrypt module, single visibility predicate, EV-1 emit/dispatch.
3. **The deterministic-AI stack is platform-agnostic in shape:** assembler registry → annotations → serializer → validator. Nothing in that pipeline is inherently about *personal* finance. It can be pointed at operational data — this is the load-bearing observation for the endgame (Part 7).
4. **Governance discipline** (STATUS single-authority, initiative ledgers, seam gates) is itself an operational capability — PO1 inherits a working change-control culture.

### 1.3 Weaknesses / missing primitives / debt

- **Missing primitives (in dependency order):** email; structured telemetry emission; job-run ledger; metric rollups; alerting; analytics read layer; support tooling.
- **Duplicated / drifting logic (existing):** `FLOW_COST` duplicated across two components vs assembler `EXPENSE_FLOWS` (FlowType residual); intent keyword sets intentionally forked (KD-11 caveat); `app/admin/workspaces` vs `spaces` residue. **Lesson for PO1:** every metric must have exactly one definition site or the platform's numbers about itself will disagree — the KD-10/KD-17 defect class ("two competing figures") reproduced at the ops layer, where it would be maximally embarrassing.
- **Future debt if unaddressed now (the "cannot reconstruct later" list):** LLM token/cost history (currently discarded at the provider boundary — every day without capture is a day of cost history gone forever); email delivery outcomes (no infra yet — capture from day one when OPS-1 lands); job execution history (silently-failing crons leave no corpse); rate-limit hit history (in-memory dev / row-per-window prod, swept); sync duration/latency (SyncIssue captures failures, not performance).
- **Existing reusable seams (build nothing twice):** `PlatformSetting` (runtime toggles), `AuditLog` (already the auth-funnel raw source), EV-1 (domain events — extend consumers, not shape), snapshot regeneration pattern, Vercel cron + `CRON_SECRET` pattern (fetch-fx-rates is the template job), the admin surface + SYSTEM_ADMIN gate, `lib/env.ts` + the future `instrumentation.ts` (OPS-1 Slice 6).

### 1.4 The constraint nobody has written down

`vercel.json` holds **2 cron entries, and STATUS calls fetch-fx "Hobby slot #2."** The Vercel Hobby plan's cron budget is effectively exhausted. Every phase below that needs scheduled work must either (a) consolidate into a single dispatcher cron that fans out internally, or (b) assume a paid plan. This is a real architectural forcing function and is treated as such in Part 4. **[speculation: exact Hobby limits should be re-verified at implementation time; the "slot #2" note implies the ceiling is 2.]**

---

## PART 2 — PLATFORM PHILOSOPHY

**Platform Operations is the practice of running Fourth Meridian with the same epistemic standards Fourth Meridian applies to users' money.** The product's creed — deterministic figures, provenance, honest estimation, append-only history, "would rather tell you less than tell you wrong" — applied reflexively. If the user-facing brand is *the AI that refuses to guess about your finances*, the operational brand is *an operator who refuses to guess about the platform*.

**What Platform Operations should own:** platform-level facts and their derivatives — identity lifecycle (requests, invites, verification, suspension, deletion); fleet health (sync, Plaid items, FX freshness, jobs, errors, latency); economics (LLM tokens/cost, email volume, provider costs per user); security posture (auth funnel, rate-limit pressure, fail-open events, session anomalies, audit trails); growth (users, Spaces, activation, retention, funnel); and the operational levers (platform settings, flags, cohorts, kill switches).

**What remains product:** everything inside a customer Space. A user's transactions, goals, briefs, AI conversations, and sharing choices are *product data*; operations sees only their aggregates and their failure shadows (a SyncIssue row, an error event, a token count). The Daily Brief is product; the *Ops Brief* is operations. Merchant rules as applied to a user's data are product; merchant-rule correction *rates* are operations.

**What must NEVER appear in Platform Operations:** individual transaction contents, merchant names from user data, balances, holdings, chat transcripts, prompt bodies, decrypted anything. The existing admin surface already models this correctly — Plaid diagnostics are *redacted* (STATUS §1 "redacted provider diagnostics"). PO1 hardens this into doctrine: **telemetry carries counts, durations, categories, and IDs — never financial values or user content.** A metric row that contains a merchant string is a defect of the same severity class as KD-1. This single rule is what makes an eventual ops-AI safe: an LLM reading ops telemetry can never leak what was never captured.

**Operations vs SYSTEM_ADMIN:** SYSTEM_ADMIN is an *authorization level* — today it is also, by accident, the entire operations *practice*. The distinction to build toward: SYSTEM_ADMIN remains the privilege boundary (who may act); Platform Operations is the capability layer (what can be known and done). Concretely: today's admin panel is entity inspection (look up a user, revoke a session); operations is state over time (are signups up, is Chase sync degrading, did last night's jobs run, what does OpenAI cost this month). The two converge on one surface but must not converge on one data plane — ops reads telemetry tables, never raw product tables, except through the same redaction seams the admin panel already uses.

**On the "Operations Space" itself — the D12 tension, addressed head-on.** STATUS §8 parks Internal-ops Spaces with the sharpest sentence in the whole document: *"putting privileged ops data inside customer tenancy would weaken the codebase's strongest boundary."* That decision is **correct and this roadmap does not overturn it.** The resolution is architectural, not rhetorical: the roadmap builds *capabilities* (telemetry → metrics → analytics → alerting → ops intelligence) that are presentation-agnostic, so that "the Platform Operations Space" arrives at the end as a **thin presentation decision** — either (a) the admin surface *adopts Space idioms* (dashboard widgets, brief, lenses — the components, not the tenancy), or (b) a true `isInternal` Space ships behind a **separate authorization gate** exactly as matrix D12 prescribes, evaluated against D12's own unpark condition. Every phase below is identical under both endings. This is MC1's provenance-before-conversion move: capture and structure first; the flip is small because everything was built for it.

---

## PART 3 — CAPABILITY GRAPH

The real dependency graph, derived from the §1 inventory (edges are hard dependencies, not preferences):

```
                    ┌─────────────────────────────────────────────┐
                    │  OPS-1 floor (Phase 0, external plan)       │
                    │  Email ──► Verification ──► Invites ──► Beta gate
                    │  instrumentation.ts ──► Error reporting, Health
                    │  Rate-limit ON · Headers · Legal · Delete/Export
                    └──────────────┬──────────────────────────────┘
                                   │
                 ┌─────────────────┴───────────────┐
                 ▼                                 ▼
   TELEMETRY SEAM (emit chokepoint)      JOB SUBSTRATE (run ledger + dispatcher)
   counters·events·costs at existing     every scheduled unit leaves a corpse;
   chokepoints; append-only; no readers  cron-budget solved once
                 │                                 │
                 └────────────┬────────────────────┘
                              ▼
                  ROLLUPS (computed daily facts)
                  PlatformSnapshot idiom: frozen, dated,
                  one definition site per metric
                              │
              ┌───────────────┼───────────────────┐
              ▼               ▼                   ▼
      ANALYTICS READ    ALERTING (thresholds   OPS CONSOLE capabilities
      LAYER (queries,    over rollups/events    (admin surface consumes
      funnels, trends)   → email via OPS-1)     read layer; levers)
              │               │                   │
              └───────────────┴───────┬───────────┘
                                      ▼
                        OPS INTELLIGENCE ("Ambient for the platform")
                        assemblers over telemetry · Ops Brief ·
                        platform lenses (PE pattern) · ops AiAgent
                                      │
                                      ▼
                        PLATFORM OPERATIONS SPACE (presentation flip;
                        D12 gate decides Space-vs-console — both endings
                        are one slice at this point)
```

Three structural facts about this graph:

1. **Email and the telemetry seam are the only two roots.** Everything else is derivable later; *these two are lossy if delayed* — un-sent emails are merely absent, but un-captured telemetry (tokens, job runs, delivery outcomes) is destroyed information. Hence the MC1-Phase-0 treatment.
2. **The user's proposed chain (Email → Identity → … → Platform Intelligence) is right in spirit, but Monitoring does not depend on Identity** — error reporting and telemetry are parallel to the identity track, not downstream of it. The graph forks at the floor and re-joins at Rollups. This matters: telemetry capture must NOT wait for beta identity work.
3. **Analytics is a read layer, not a store.** It has no capture of its own — if a question can't be answered, the fix is a new emission or rollup, never an analytics-side write. This kills the duplication risk (§1.3) by construction.

---

## PART 4 — ROADMAP

Phases mirror MC1's shape: provenance → substrate → computation → cutover → surface. Every slice: **one responsibility · one seam · one cutover · one validation gate.** No slice below requires any other initiative's unshipped work except as marked. Schema described here is *future* work — nothing in this document creates it.

### Phase 0 — Operational floor · **externally planned (OPS-1)**
The entry criteria for everything below: email seam live, `instrumentation.ts` + error reporting, health endpoint + uptime alerting, rate limiting on, headers, deletion/export, legal pages, beta gate substrate. See `docs/initiatives/ops1/OPS1_OPERATIONAL_FLOOR_PLAN.md` (11 slices, gates B1–B10). **PO1 phases 1–2 may begin in parallel with late OPS-1 slices; Phase 3+ hard-gates on OPS-1 closeout** (alerting needs email; consoles are pointless before monitoring exists).

### Phase 1 — Telemetry provenance (the MC1-Phase-0 move)
*Capture what cannot be reconstructed later. Behavior-neutral: zero readers, zero UI, nothing consumes these rows in this phase.*

- **Slice 1.1 — The emission seam.** One module (`lib/ops/telemetry.ts` shape), one write chokepoint, append-only storage (one narrow event/counter table — final shape at implementation). Doctrine embedded in types: counts/durations/kinds/IDs only — **a field for user content or monetary value does not exist in the schema, making the §2 privacy rule structural.** Fire-and-forget, never throws into a product path, fails silent-but-counted (its own dropped-write counter).
  *Seam:* the emit function. *Cutover:* none (new module). *Gate:* unit tests; grep-proof that no product table is touched; a deliberately failing emit provably cannot break a product request.
- **Slice 1.2 — Instrument the four chokepoints that already exist.** LLM provider boundary (model, token counts, latency, validator outcome — **not prompt text**); rate limiter (hits, blocks, shadow-blocks, fail-opens); sync engine (per-item duration, counts, outcome — joins the existing `SyncIssue` fact stream); auth funnel points (register/verify/reset/login outcomes — supplementing, not duplicating, AuditLog: telemetry counts, audit records).
  *Seam:* each chokepoint's single call site. *Cutover:* none (additive lines at four seams). *Gate:* the three named v2.4.5 observability counters (fallback hits, sync stats, LLM tokens) exist as queryable rows — **closing debt named since 2026-07-02**; product behavior byte-identical (no logic reads telemetry).
- **Slice 1.3 — Email + FX + import emission.** OPS-1's email seam emits delivery attempts/outcomes from birth; FX fetch job emits freshness/failure (retiring the "console-logged, no SyncIssue kind" residual); import pipeline emits batch outcomes.
  *Gate:* one week of dev-era rows demonstrating each stream; zero product-path regressions.

### Phase 2 — Job substrate (D5/KD-14 closure path)
*Every scheduled unit of work leaves a corpse. Solves the cron-budget constraint once.*

- **Slice 2.1 — Job-run ledger.** Append-only run record (job name, trigger source, started/finished, outcome, error summary, counts). Written by the two *existing* crons first — no new jobs.
  *Seam:* a `runJob(name, fn)` wrapper. *Cutover:* wrap sync-banks and fetch-fx-rates handler bodies (mechanical, revertible). *Gate:* both crons produce ledger rows in prod; a forced failure produces a failure row; "did last night's sync run?" becomes a query for the first time.
- **Slice 2.2 — Dispatcher.** One cron endpoint that fans out to registered jobs by schedule (internal registry mirrors `jobs/scheduler.ts`'s existing table of intents), replacing N-crons-for-N-jobs. Existing two crons migrate INTO it; `vercel.json` shrinks to one entry (+ headroom restored).
  *Seam:* the dispatcher route + registry. *Cutover:* two entries → one, each job individually revertible to its own cron. *Gate:* week-long ledger comparison shows identical execution pattern pre/post; a registered-but-failing job cannot block siblings (isolation test).
- **Slice 2.3 — Revive the dead jobs.** `purge-trash` (soft-delete promise becomes true) and snapshot-taking cadence audit ride the dispatcher; `sync-crypto`/`run-ai-advice` remain stubs — **their revival belongs to their own tracks** (no opportunistic scope). `startScheduler()`/`jobs/scheduler.ts` is formally retired-or-adopted here as a *decision*, closing the "entrypoint never invoked" limbo (recommendation: retire; the dispatcher is the entrypoint).
  *Gate:* trash purge provably runs on schedule; STATUS D5/KD-14 language can be updated truthfully (in that PR, not by this doc).

### Phase 3 — Rollups & the metrics doctrine
*The PlatformSnapshot idiom: frozen, dated, computed facts — SpaceSnapshot pointed at the platform.*

- **Slice 3.1 — Rollup substrate + first rollups.** Daily job (rides Phase 2) computing platform-day facts from raw sources: users (total/new/active), Spaces, connected items by status, sync success rate, LLM tokens/cost, emails sent/failed, rate-limit pressure, error count. Each metric has **exactly one definition site** (the rollup module) with source-of-truth annotations (which raw table, which predicate) — the anti-KD-10 rule as code organization.
  *Seam:* rollup module + one dated table. *Cutover:* none (new computation). *Gate:* rollups reproducible from raws (recompute-and-compare test, the FxRate `--verify` idiom); a backfill script can reconstruct history for any metric whose raws exist — and the gate documents which metrics have no pre-Phase-1 history *because* capture started at Phase 1 (the provenance lesson, stated in the table).
- **Slice 3.2 — Analytics read layer.** Query functions over rollups + raws (trend, funnel, breakdown), SYSTEM_ADMIN-gated API. No UI yet.
  *Gate:* the Part 5 question list answerable via documented queries; response payloads contain zero user-content fields (schema-level assertion test).

### Phase 4 — Operations console (capabilities on the existing admin surface)
*The admin panel graduates from entity inspection to operations. Consumes Phase 3; adds levers. One slice per panel; each independently shippable:*

- **4.1 Health & jobs** (fleet status, run ledger, failure drill-down) · **4.2 Growth & funnel** (users/Spaces/activation; beta funnel once OPS-1 S10 exists) · **4.3 Providers** (Plaid item health fleet-wide, FX freshness, SyncIssue triage with resolve/replay actions) · **4.4 Economics** (LLM + email + provider cost curves, per-user unit economics) · **4.5 Security posture** (auth funnel, rate-limit pressure, fail-open events, session anomalies) · **4.6 Levers** (PlatformSetting expansion beyond the 5 security keys, cohort tags, per-user AI toggle — the OPS-1 flag doctrine matured).
  *Gate per slice:* the panel answers its questions from the read layer ONLY (no direct product-table queries — grep-enforced); every lever action lands in AuditLog with `performedByAdminId`.

### Phase 5 — Alerting & operational automation
- **Slice 5.1 — Thresholds.** Declarative rules over rollups/events (sync success < X%, fail-open > 0, job missed, cost spike) evaluated by a dispatcher job → email via OPS-1 seam. Start with ~5 rules, solo-operator-tuned (alert fatigue is a §9 risk).
  *Gate:* injected threshold breach alerts within one evaluation cycle; a silent week sends zero mails.
- **Slice 5.2 — Runbook automation (conservative).** Alert → suggested action linkage (reconnect-item nudge email to affected user, replay import, re-run job) — **human-triggered from the console, never autonomous.** The parked-agents doctrine (STATUS §8) applies to ops exactly as to product: automation earns autonomy through a track record, and not in this phase.
  *Gate:* each action idempotent, audited, and reversible or harmless on double-fire.

### Phase 6 — Ops Intelligence & the presentation flip
- **Slice 6.1 — Ops assemblers.** The AI stack pointed inward: assemblers over telemetry/rollups (structurally incapable of touching product data — they import the read layer only), annotations ("sync degraded vs 30-day baseline"), serialized with the same provenance doctrine. Validator applies as-is: ops numbers get the same honesty enforcement as user numbers.
- **Slice 6.2 — Ops Brief + platform lenses.** The Daily Brief pattern for the operator ("since yesterday: 3 signups, sync 98.2%, $4.10 LLM spend, 1 alert"); PE-pattern lenses (platform-health lens, cost lens) — deterministic, injected-clock, tested like debt/liquidity lenses.
- **Slice 6.3 — The flip (D12 gate).** Only now is the Space-vs-console question decided, against matrix D12's own criteria and unpark condition. Both endings are thin: (a) console adopts Space presentation components; (b) `isInternal` Space with a **separate authz gate** (never `SpaceMember` semantics alone) whose widgets consume the same read layer. *This document deliberately does not pre-decide; it guarantees the decision stays cheap.*
  *Gate:* whichever ending — zero new data-plane code in the flip itself; the privacy grep-proofs of Phases 1–4 still pass; an external reviewer can verify ops surfaces cannot reach product content.

---

## PART 5 — ANALYTICS ARCHITECTURE

**Origination doctrine — metrics are born at chokepoints, never in UI or analytics code.** The seams already exist (§1.2): provider boundary → AI usage/cost; rate-limit module → pressure; sync engine + SyncIssue → provider health; AuditLog → auth/security funnel; email seam (OPS-1) → delivery; import pipeline → batch outcomes; job wrapper (Phase 2) → execution. A metric with no chokepoint is a smell: find or create the seam, don't scatter emissions.

**Collection — two write paths only:** (1) *derive from facts already recorded* wherever a fact table exists (users, Spaces, invites, SyncIssue, AuditLog, FxRate, ImportBatch — counting rows beats double-writing events; no second copy to drift); (2) *append-only telemetry* (Phase 1) solely for facts with no home: tokens, durations, deliveries, hits, run outcomes. Never both for the same fact — each §5 question below is assigned exactly one source of record at implementation time, recorded in the rollup module's annotations (Slice 3.1).

**Raw vs computed:** raws are append-only and never rewritten (FxRate discipline); rollups are frozen dated computations (SpaceSnapshot discipline) — recomputable from raws, verified by recompute-and-compare, but *history is never silently restated*; a definition change is a new metric version, not an edit (the MC1 "history never rewritten" rule, because operator trust in ops numbers has the same failure mode as user trust in balances).

**Mapping the question list:** users/active/Spaces/growth → row-derived + daily rollup · emails, reset requests, verification rate → telemetry + AuditLog funnel · sync success, Plaid health → SyncIssue + sync telemetry · FX freshness → FxRate directly (already queryable) · import failures → ImportBatch + telemetry · merchant/transaction corrections → **future emissions from MI/TI's own writers** (Part 7 — the correction *event* is the telemetry; the correction itself is product data) · AI usage/prompt volume/LLM cost → provider-boundary telemetry (prompt *counts and sizes*, never bodies) · jobs → run ledger · errors → Sentry (external) + error-count telemetry · rate-limit hits → limiter telemetry · feature adoption → row-derived where feature rows exist; sparse feature-use events otherwise · beta cohorts/request funnel → AccessRequest/InviteToken rows (OPS-1 S10) + rollup.

**What stays out:** no third-party product-analytics SDK (Amplitude/PostHog class) at this stage — the privacy positioning ("no user-content telemetry, structurally") is worth more than funnel convenience, and the client-side event firehose is exactly the duplication-and-PII risk this architecture exists to avoid. **[speculation: at genuine growth scale a dedicated analytics store becomes worth it; the read-layer seam is where it would slot in without touching emission.]**

---

## PART 6 — THE PLATFORM OPERATIONS SPACE (capabilities, not UI)

As it should exist post-Phase 6, capability by capability. Everything reads the Phase 3 layer; every action writes AuditLog; nothing displays user content.

- **Overview ("Ops Brief"):** since-last-visit platform delta — signups, activation, sync health, cost, alerts, job status; deterministic annotations with baselines; the Daily Brief pattern inverted.
- **Health:** fleet rollup (API errors, latency, job punctuality, provider status), current alert state, uptime history (external monitor's data referenced, not reimplemented).
- **Users:** lifecycle counts and cohort views; per-user *operational* profile (connection counts, sync failures, cost-to-serve, support flags) — expressly not their finances; suspend/verify-resend/reset-force/delete levers (OPS-1 machinery, audited).
- **Access & Invitations:** request queue with qualifying answers, approve/reject/hold + notes, invite issuance/expiry/resend, funnel conversion (requested→invited→registered→activated).
- **Spaces:** census by type/category/member-count, shared-Space adoption (the wedge metric), orphan/anomaly detection (Space with no AiAgent — the `37f96f3` defect class, as a monitored invariant rather than a one-time fix).
- **Emails:** volume/outcome by template, bounce/failure triage, per-user delivery history (metadata only).
- **Imports:** batch outcomes, failure taxonomies, replay lever (rides D2.x's replay residual when that lands).
- **Plaid:** item fleet by status, institution-level failure clustering ("Chase degraded for 9 users" — currently invisible), consent/expiry horizon, cost-per-item; redacted per-item diagnostics (existing admin capability, relocated).
- **FX:** archive freshness, provider failover history, staleness distribution of served conversions (walk-back telemetry from the resolver — **[speculation: worth a Phase 1 emission if cheap; decide at slice entry]**).
- **Jobs & queues:** run ledger, punctuality, duration trends, manual re-run lever; dead-job detection (expected-but-absent runs — the alert that catches a silently dropped cron).
- **Errors:** Sentry summary integration + error-rate telemetry correlated to deploys **[speculation: deploy-marker emission is a nice-to-have slice]**.
- **AI:** token/cost curves by surface (chat vs brief vs future ambient), validator outcome rates (clean/annotated/blocked — the honesty-system's own health), fail-open events, per-user cost outliers.
- **Costs:** unified economics — LLM + email + Plaid **[speculation: Plaid costs may need manual entry or invoice import; no API assumption]** → cost-to-serve per user per month, the pricing-model input.
- **Security:** auth funnel, brute-force pressure, TOTP adoption, fail-open ledger, session anomalies, admin-action review (everything `performedByAdminId`).
- **Audit:** the existing viewer, upgraded with the read layer's filters; retention policy status (OPS-1 §5.4 decision surfaced as a visible fact).
- **Feature flags / levers:** PlatformSetting registry with change history; cohort tags; per-user AI toggle; kill switches (validator mode, rate-limit mode, admin lockout) — every lever's current state visible in one place, because an invisible kill switch is an outage waiting for an archaeologist.
- **Analytics:** the Part 5 question list as saved queries/trends; export of *platform* metrics (CSV) for operator use.
- **Support:** lightweight case notes attached to users (OPS-1 S10 notes field grown up), linkable to SyncIssues/errors; **not a ticketing system** — that stays out per D10 until real volume justifies it.
- **Beta:** cohort dashboards (activation, retention, feedback flags by wave), graduation criteria tracking toward open registration.
- **Incident response:** the runbook index (OPS-1 B9's restore drill writeup and successors), incident log (start/end/impact/actions — append-only, naturally), alert-to-incident linkage, post-incident checklist. Culture-level: incidents are STATUS.md-grade honest records.

---

## PART 7 — FUTURE INTEGRATION

The pattern every future initiative inherits: **ship your feature with its telemetry emission at your own chokepoint; Platform Operations gets your health panel for one rollup's worth of work.** Specifically:

- **Merchant Intelligence:** rule-hit rates, correction events (user overrode category X→Y — the *event*, not the merchant string), rule-coverage ratio, the category-rewrite-invalidation contract as a *monitored invariant* (flow-desync seam count, alerting if >0 — turning MI's named entry-gate risk into a standing check).
- **Transaction Intelligence:** classifier confidence distributions, `classifierVersion` adoption curves after backfills, flow-vs-category disagreement rates — the data-quality dashboard that tells you when a classifier regression ships before a user does.
- **Receipt Intelligence [speculation — no repo evidence this is planned]:** OCR/parse success rates, per-receipt processing cost — a cost-heavy pipeline that must be born instrumented, because its unit economics decide its viability.
- **Ambient Intelligence (v2.6b):** the roadmap's own exit criterion — "one week of scheduled briefs with zero validator failures" — **is a Phase 1–3 query.** Ambient literally cannot certify its exit gate without this initiative's substrate; scheduled-brief outcomes, notification opt-out rates, and KD-12 amplification (audit-log growth bounded — another exit criterion that is a rollup) all land in the ops layer. This is the strongest sequencing argument in the document: **PO1 Phases 1–3 are v2.6b's measurement infrastructure.**
- **Business Spaces:** activation/retention by SpaceCategory (BUSINESS exists in the enum today), multi-member usage depth — the evidence base for the B2B decision (Part 8).
- **Scheduler (D5's fuller vision):** *is* Phase 2 — future scheduled capabilities register with the dispatcher and inherit the ledger for free.
- **Government/Enterprise Automation [speculation — aspirational, no repo evidence]:** any compliance-facing automation demands exactly what this architecture produces — append-only execution records, audited levers, provable non-access to user content. If that future arrives, PO1 is its audit substrate; if it doesn't, nothing was built for it.
- **Framework Marketplace (parked D9):** stays parked; if unparked, template installs/usage are row-derived metrics — nothing new needed. The graph absorbs it without an edge.

---

## PART 8 — LAUNCH READINESS THRESHOLDS

Minimum platform maturity per stage — cumulative:

| Stage | Requires | Rationale |
|---|---|---|
| **Private beta** (hand-picked, ~20) | OPS-1 complete (blockers B1–B10) + **Phase 1** (telemetry capturing from day one) + Phase 2 Slice 2.1 (job ledger) | Beta users generate the first real cost/health/funnel history — capture must precede them (irreproducibility) . Manual approval IS the abuse control; consoles can wait, capture cannot |
| **Public beta** (open registration, capped) | + Phases 2–3 complete, Phase 4.1/4.3/4.5 (health, providers, security panels), Slice 5.1 alerting, counsel-reviewed legal, tested restore cadence, Plaid production credentials in flight | Strangers at volume = you learn about outages from dashboards or from Twitter; also the KD-3 shadow data finally exists to tune real limits |
| **Public launch** (v3.0 / L-1) | + Phase 4 complete, 5.2 runbook automation, billing (D10 lift) *instrumented from birth* (revenue/churn join the rollups), support workflow live, incident log practiced (≥1 real drill), validator/fail-open track record clean over a defined window | The v3.0 exit ("a stranger can pay, connect, share, be supported and recovered") is operationally testable only with these panels |
| **Business customers** | + cost-to-serve knowably per-account (4.4 mature), uptime commitments backed by alert history, DPA + retention policies live, org-grade auth decisions (per-Space audit exports) **[speculation: SSO likely demanded; architect nothing until a customer asks]** | Businesses buy reliability evidence, not features |
| **Enterprise** | + SOC 2 program (the audit/telemetry substrate becomes evidence collection), SSO/SAML, data-residency posture, on-call beyond one human | Explicitly NOT a near-term target (Part 9 of the 2026-07-06 audit stands: enterprise would be a rebuild of identity assumptions) |

---

## PART 9 — RISKS

**Architectural:** (1) *Boundary erosion* — the gravitational pull to "just query the product table" from an ops panel; countered structurally (read-layer-only rule, grep-enforced per Phase 4 gate) but it will be attempted repeatedly, including by future-you in a hurry. (2) *Metric definition drift* — the KD-10/KD-17 defect class reborn in ops ("two competing signup counts"); countered by single-definition-site doctrine, but only as long as the rule is enforced in review. (3) *Telemetry schema churn* — event shapes are easy to get wrong early; mitigated by starting narrow (counts/durations/kinds) and versioning metric definitions rather than editing.

**Security:** (1) ops surfaces aggregate exactly the metadata an attacker wants for targeting (who has money movement, which institutions, cost outliers) — SYSTEM_ADMIN compromise becomes *more* valuable after PO1; TOTP-enforced admin + the kill switch + audit review are the mitigations, and Phase 4.5 must monitor its own admins. (2) Telemetry as exfiltration channel — a sloppy emission carrying a merchant string defeats the whole doctrine; the no-content-fields schema (Slice 1.1) is the structural answer, plus a periodic grep/scan gate. (3) The ops-AI (Phase 6) inherits prompt-injection surface only if telemetry ever carries user-authored strings — same answer.

**Operational:** (1) *Solo-operator alert fatigue* — 5 rules max at 5.1, tuned ruthlessly; an ignored pager is worse than none. (2) *The dispatcher as single point of failure* — one cron running everything means one silent failure kills all jobs; the dead-job detector (Part 6) must watch the dispatcher itself, from outside (external uptime check on the dispatcher endpoint). (3) *Vercel Hobby constraints* (§1.4) — cron budget, function duration ceilings on rollup jobs **[speculation: duration limits need verification against plan tier at implementation]**.

**Scaling:** telemetry row growth (KD-12 is the in-repo precedent for write amplification) — retention/compaction policy must ship WITH Phase 1, not after; rollups make raw pruning safe by design (raws older than N months compact once rolled up — decided at Slice 3.1, enforced by a Phase 2 job).

**Maintenance:** this initiative adds a second product (the ops platform) to a solo maintainer's surface — the single most honest risk in this document. Mitigations are real but partial: ops reuses product idioms (snapshots, briefs, assemblers, admin surface) rather than new frameworks; phases are independently valuable (stopping after Phase 3 still leaves capture + rollups + queries — the floor of the value curve is high and early).

**Developer experience:** emission calls sprinkled at chokepoints could rot into noise; the counter-pattern is the same as audit-actions — a typed registry of event kinds, so an unknown kind is a compile error, and dead kinds are grep-visible.

**Product:** (1) *Ops navel-gazing* — dashboards about a platform with 20 users can consume quarters; the phase gates are sized against solo capacity, and Phases 4–6 should be demand-pulled (build the panel when you've hand-run its query three times). (2) *The D12 flip decided by enthusiasm instead of criteria* — the Space ending is emotionally attractive ("Fourth Meridian operating Fourth Meridian" made literal); Slice 6.3's gate exists precisely so the boundary argument wins over the aesthetic one if they conflict.

---

## PART 10 — EXECUTIVE RECOMMENDATION

**Final roadmap, prioritized:** Phase 0 (OPS-1) → **Phase 1 (telemetry provenance) immediately, overlapping late OPS-1** → Phase 2 (job substrate) → private beta opens here → Phase 3 (rollups + read layer) → Phases 4–5 demand-pulled panel by panel during beta → Phase 6 only after v2.6b exists to consume it and D12's unpark condition is genuinely evaluated. Total shape: two structural phases before beta, computation during beta, surfaces as the operator's real questions demand them.

**Three highest-leverage phases:**
1. **Phase 1 — telemetry provenance.** Irreversibility makes it urgent (every pre-capture day is destroyed cost/health history); cheapness makes it easy (four chokepoints already exist); it closes the repo's oldest named debt (v2.4.5 counters).
2. **Phase 2 — job substrate.** Unblocks KD-14/D5, makes the soft-delete promise true, solves the cron ceiling once, and gives v2.6b the execution substrate its exit criteria assume.
3. **Phase 3 — rollups + read layer.** Converts capture into answers; everything after it is presentation. This is also where v2.6b's own exit gate ("one week of briefs, zero validator failures, bounded audit growth") becomes mechanically checkable — PO1 is Ambient's measurement rig.

**Three highest-risk gaps (today, repo-evidenced):**
1. **No observability of any kind** — prod failures are invisible; both safety nets fail open silently (`lib/rate-limit.ts`, `lib/ai/output-validator.ts`).
2. **No job execution record** — `startScheduler()` never invoked, stubs presenting as features (`sync-crypto.ts` = `export {}`), crons with no corpse; the platform cannot prove its own background work happened.
3. **Session revocation is weaker than its product claim** — the `UserSession` schema comment concedes it's "informational"; for a financial platform this belongs on the PO1-adjacent hardening list (short JWT lifetime + blocklist check on sensitive routes) before public beta.

**Three foundations that will survive the decade:**
1. **Append-only dated fact tables + frozen computed rollups** (AuditLog/FxRate/SyncIssue/Snapshot → telemetry/run-ledger/PlatformSnapshot) — the idiom is provider-agnostic, scale-tolerant, and audit-native; it will outlive every UI and probably the ORM.
2. **Chokepoint seams as the only emission sites** — the same discipline that made MC1 possible (one aggregation chokepoint) makes operations possible (one boundary per capability); this is the house architecture and it compounds.
3. **The tenancy boundary with no admin bypass** — reaffirmed by keeping ops data OUT of customer tenancy; it is simultaneously the security model, the privacy brand, and (eventually) the compliance evidence.

**"If Fourth Meridian becomes a company with employees operating entirely inside Fourth Meridian — what must exist first?"**

Four things, in order. **First, a telemetry plane that is structurally incapable of leaking customer content** — employees operating "inside" the platform means employees reading operational surfaces all day; the §2 no-content doctrine is what makes that safe by construction rather than by vigilance. **Second, real internal identity:** roles between USER and SYSTEM_ADMIN (support-read, ops-write, admin), sessions with genuine revocation, TOTP mandatory, every action attributed — today's two-tier model assumes the operator and the owner are the same person, and stops being safe the day they aren't. **Third, the D12 gate honestly passed:** an `isInternal` Space with its own authorization gate, per the matrix's original design — the parked decision already contains the correct blueprint; what's missing is the unpark condition (internal headcount whose workflows outgrow the console), and this roadmap's job is to make sure that when the condition arrives, the flip is one slice instead of one rewrite. **Fourth — and this is the honest one — a business that earns headcount:** every phase here is sized for a solo operator precisely because the vision fails not by architectural impossibility but by building the company's nervous system before the company has customers. The nervous system is cheap to grow correctly from Phase 1; it is impossible to reconstruct retroactively. Capture first. Surface later. Flip last.

---

*Sources: `prisma/schema.prisma` (AuditLog, UserSession, PlatformSetting, RateLimit, SyncIssue, FxRate, SpaceSnapshot), `lib/platform-settings.ts`, `lib/rate-limit.ts`, `lib/env.ts`, `lib/ai/provider.ts` (boundary), `lib/events/*` (EV-1), `jobs/*`, `vercel.json`, `app/admin/*`, `app/api/admin/*`, `.github/workflows/ci.yml`, STATUS.md §§1–8 (esp. D5, D12, KD-3, KD-12, KD-14, v2.4.5 carry-forward, §8 parked ideas), `docs/initiatives/ops1/OPS1_OPERATIONAL_FLOOR_PLAN.md`, and `PRELAUNCH_AUDIT_2026-07-06.md`. Speculation is labeled inline.*
