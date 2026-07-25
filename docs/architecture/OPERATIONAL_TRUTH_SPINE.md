# Operational Truth Spine

*Governs which single module decides each **operational** truth, what that authority means, and what each surface must never be used for. The operational counterpart to [FINANCIAL_TRUTH_SPINE.md](./FINANCIAL_TRUTH_SPINE.md). See also [REFRESH_EXECUTION_DOCTRINE.md](./REFRESH_EXECUTION_DOCTRINE.md), [REFRESH_COVERAGE_DOCTRINE.md](./REFRESH_COVERAGE_DOCTRINE.md), [platform operations](../systems/platform-operations.md), [connections](../systems/connections.md).*

> **Status: OPS-2A.** Sections A–H are **binding doctrine over code in `main`** — every
> authority named below exists and is cited by module path. Sections I–K describe the
> **designed but unbuilt** layers (infrastructure facts, the metric-provider contract,
> the projection inventory) and are labelled as such throughout. Where this document
> states a gap, the gap is real and named — it is never implied away.

Fourth Meridian's central law — **one authoritative model · one semantic layer · one
aggregation path · many consumers** — is not a financial rule. It is an
*architectural* rule that happens to have been proven first on money. This document
applies it to the platform's knowledge of **itself**.

The one question to answer before writing any operational calculation is the same
one: **"which authority already owns this, and am I re-deciding it?"** If you find
yourself re-classifying a run, re-deriving a health state, or reconstructing a
history from a mutable status column, stop — you are creating a parallel operational
authority, which is a defect, not a feature.

---

## A. The historical problem — why operational truth ends up in logs

Operational state historically lives in logs, dashboards, and infrastructure consoles
rather than in canonical domain facts, for four structural reasons. All four have
already produced real defects in this repository.

**1. Operational data is treated as exhaust, not as a domain.** A refresh computes a
rich result and then `console.log`s it. DF-2 found exactly this: `RefreshItemResult`
and `SyncTransactionsResult` were *computed, returned, and discarded* — the facts
existed in memory for milliseconds and were then irrecoverable. A log line is not a
fact: it cannot be joined, aggregated, or asked a question, and it expires on a
vendor's retention schedule.

**2. Live status columns are mistaken for history.** `PlaidItem.status`,
`Connection.status`, `FinancialAccount.lastUpdated` and `syncStatus` are *overwritten
on every write*. A healthy→broken→healthy flip leaves no trace, so "how long has this
been broken?" is unanswerable. CH-2 (`lib/connections/health-transitions.ts`) exists
solely because this was discovered the hard way; DF-2E's freshness doctrine names the
same failure at account grain.

**3. Execution success is read as outcome truth.** The incident that shaped Platform
Ops: the platform reported a **green FX job over a cold FX archive**, because
`JobRun.status = "succeeded"` was being consumed as data health. A job can succeed
and produce nothing. This is the **false-green** class of defect, and it generalizes
far beyond FX (see §D).

**4. The dashboard becomes the model.** When no canonical operational fact exists,
each surface invents its own interpretation at read time. Before
`lib/platform/sync-issue-semantics.ts`, six unrelated producers wrote to one
`SyncIssue` table and every consumer re-guessed severity from `kind` alone — with the
result that the member activity feed told a customer to "reconnect" over an internal
investment-repair failure. The interpretation lived in the consumer, so it was wrong
in each consumer differently.

**The cost of the alternative — CloudWatch-shaped operations.** An infrastructure
console can tell you a function timed out. It cannot tell you *which customer's
connection was left stale, for which endpoint, since when, and whether the money on
their dashboard is therefore wrong.* Those are **domain** questions about
**operational** subjects, and only a domain model can answer them. That is why this
spine exists and why recreating CloudWatch inside Fourth Meridian would be the wrong
build.

---

## B. Operational philosophy

Five rules, each the operational restatement of a rule the financial spine already
proved.

1. **Operational consumers consume canonical authorities; they never construct their
   own interpretation.** Platform Operations, Support, AI, alerting, and future
   automation are *consumers*. Not one of them is a source of operational truth.
2. **Facts are written once and never rewritten.** An execution records what was
   attempted and known *at that time*. A correction is a **later fact**, never a
   mutation of an earlier one (`REFRESH_EXECUTION_DOCTRINE.md` §K).
3. **Health is derived, never stored.** Severity, staleness, trust, and health are
   **projections computed at read time** from facts that already exist. A stored
   severity drifts from the rule that produced it the moment the rule changes — the
   argument `lib/platform/sync-issue-semantics.ts` and `lib/debt/balance-semantics.ts`
   both make, and the reason neither has a column.
4. **Unknown stays unknown.** Absence of evidence is never rendered as health,
   freshness, or success. "We did not observe this account" must never become "this
   account is fresh."
5. **Telemetry never changes outcomes.** Every operational write is best-effort and
   non-throwing. A ledger failure must never turn a successful provider refresh into
   a customer-visible failure — nor a failed one into a success.

---

## C. The six categories of operational state

Every operational thing in the system is exactly one of these. Misfiling one is the
root cause of most operational defects.

| Category | Definition | Owner | Mutability |
|---|---|---|---|
| **Operational Fact** | Something the platform did, observed, or was told, recorded at the grain it occurred | **The domain that performed the work** | Immutable (append-only) |
| **Infrastructure Fact** | Something about the machine the platform runs *on* | **An external provider** — imported, never authored | Immutable once imported. **One exists: deployment identity** (OPS-2B′) — the sole infrastructure fact the platform can author truthfully from inside itself, because a process reads its own build's identity from its own environment. Everything else (§I) is still absent |
| **Transient Runtime State** | The current value of a live column or in-memory counter | The subsystem that maintains it | Overwritten; **carries no history** |
| **Operational Projection** | A read-time derivation over facts | The projection module | Never persisted |
| **Historical Operational Fact** | The append-only subset of Operational Facts, queried over time | Same as the fact | Immutable |
| **Operational Consumer** | A surface that reads projections | Itself | Owns nothing |

### C.1 Operational Facts — what exists today

| Fact | Grain | Writer (sole chokepoint) | Immutable |
|---|---|---|---|
| `RefreshExecution` | one item-level refresh lifecycle | `runFullRefresh()` — `lib/plaid/refresh-execution.ts` | yes (one start + one completion write) |
| `RefreshEndpointResult` | one stage within an execution | same | yes (persisted at close) |
| `ProviderCall` | one external provider request **attempt** | the Plaid client Proxy — `lib/plaid/client.ts` + `provider-call.ts` | yes |
| `RefreshEndpointAccountCoverage` | one (execution, endpoint, account) | `closeExecution` via the `StageRecorder` | yes |
| `JobRun` | one scheduled/manual **batch** | `runJob()` — `lib/jobs/run.ts` | yes (one start + one completion write) |
| `SyncIssue` | one integrity condition or event | `recordSyncIssue` | append-only; `resolved` flag reserved |
| `AuditLog` | one actor-attributed event | *many* direct writers — **see §H.3** | append-only |
| `NotificationDelivery` | one delivery attempt | notification pipeline | append-only |
| `ApiUsageCounter` | daily `(provider, metric, unit)` **rollup** | `lib/usage/record.ts` | **counter, not a fact stream** — see §H.2 |
| `FxRate` | one dated rate | FX adapters | insert-only for closed dates |

**Rule:** an Operational Fact is owned by the domain that *performed the work* — not
by Platform Operations. `lib/plaid/` owns refresh facts. `lib/jobs/` owns batch facts.
Platform Operations owns **no facts at all**; it owns projections and UI. This is the
single most important ownership statement in this document.

### C.2 Transient Runtime State — never a history

These are live-only. Reading them as history is a defect, and each has already caused
one:

- `PlaidItem.status` / `errorCode`, `Connection.status` / `errorCode` — no history;
  CH-2's `AuditLog` transition rows are the durable trace.
- `FinancialAccount.lastUpdated` / `balanceLastUpdatedAt` / `syncStatus` — current
  only; per-execution history is `RefreshEndpointAccountCoverage`.
- `PlaidItem.syncIncompleteAt`, the in-flight sync lock, the "non-stale `running`
  `JobRun`" manual-run lock — liveness, not evidence.
- `RateLimit` fixed-window counters — buckets, swept.
- `UserSession.lastActiveAt`, `PlatformSetting` values.

> **Binding:** reconstructing operational history from `lastSyncedAt`, status columns,
> `JobRun.summary`, or `SyncIssue` timestamps is **forbidden** — they cannot recover
> per-stage or per-call facts (`REFRESH_EXECUTION_DOCTRINE.md` §K).

### C.3 Operational Projections — what exists today

Every one is read-time, persists nothing, and creates no table.

| Projection | Authority | Answers |
|---|---|---|
| Job execution health | `lib/jobs/health.ts` `classifyJobHealth` | did each registered job run when it should |
| Resource freshness | `lib/platform/resource-freshness.ts` | is the underlying archive actually fresh — **content only** |
| Provider health | `lib/platform/provider-health.ts` `deriveProviderTrust` | per-provider trust, worst-wins over the axes below it |
| Connection health | `lib/connections/health.ts` `deriveConnectionHealthState` | per-connection health across both provider tables |
| Sync-issue semantics | `lib/platform/sync-issue-semantics.ts` | what a `SyncIssue` row **means** (domain · severity · nature) |
| Stall projection | `lib/platform/stall-projection.ts` | is an item stalled, since when, after how many **attempts** |
| Connection diagnostics | `lib/platform/connection-diagnostics.ts` | which layer (acquisition · intelligence · freshness) is behind |
| Email delivery health | `lib/platform/email-health.ts` | are notification emails failing |
| Operational history | `lib/platform/history/history.ts` | every source's state **as-of** a date + trend |
| Convergence | `lib/platform/convergence/convergence.ts` | which events cluster into one operational **episode** |
| Cost & latency | `lib/platform/cost/cost.ts` | latency/load/spend, purely over history + convergence |
| AI usage trend | `lib/platform/ai/ai-usage.ts` | per-day AI volume + **estimated** spend |
| User activity | `lib/platform/activity/activity.ts` | DAU/WAU/MAU over the `AuditLog` ledger |
| Alert evaluation | `lib/alerts/evaluate.ts` | which authority outputs breach a rule |
| **Refresh / provider-operation / coverage / failure summaries + execution timeline** (OPS-2B) | `lib/platform/refresh/projections.ts` (pure core in `projections-core.ts`) | the aggregate read model over the DF-2 ledger |
| **Execution Query Seam** (OPS-2B) | `lib/platform/refresh/execution-query.ts` (pure core in `execution-query-core.ts`) | bounded row-level forensics — the `queryTransactions` analogue |

---

## D. Authority doctrine

**Operational truth never originates from a dashboard. Dashboards consume truth.
Dashboards never own truth.**

Four binding rules:

**D.1 — The producing domain owns the fact.** A fact is written by the code that did
the work, through **one chokepoint**, at the grain the work occurred. Adding a second
writer to an existing fact table is a defect. Current chokepoints: `runFullRefresh`,
`runJob`, the Plaid client Proxy, `recordSyncIssue`, `recordConnectionTransition`.

**D.2 — Execution success is never evidence of outcome.** This is the false-green
invariant, generalized from FX to the whole spine:

```
job succeeded        ≠  resource is fresh
execution SUCCEEDED  ≠  every account under the item is fresh
endpoint SUCCEEDED   ≠  every provider attempt succeeded
account COVERED      ≠  data changed
provider 200         ≠  the data was persisted
```

Each side of each line is a **separate fact with a separate home**
(`REFRESH_COVERAGE_DOCTRINE.md` closes with the six-fact enumeration). A consumer that
collapses any pair is reintroducing the incident that created Platform Ops. Execution
facts are surfaced **beside** outcome facts, never used to derive them.

**D.3 — Trust vocabulary is already ratified; do not invent a second one.** The
operational trust tier **is** `CompletenessTier` from
`lib/perspective-engine/types.ts` — `observed · derived · estimated · incomplete ·
unknown` — aliased as `OperationalTier` in `lib/platform/history/types.ts` and
composed with `worstTier`. A point is `observed` when a ledger row exists,
`derived` when a live engine reconstructs a verdict from observed rows, `estimated`
when it is a projection (e.g. dollar spend from a price table), `unknown` when the
ledgers do not cover the period. **A new operational health scale is forbidden.**

**D.4 — Authorities are never re-derived downstream.** Provider health *imports*
freshness and connection health rather than recomputing staleness. Cost consumes only
history + convergence. The alert engine classifies over authority **output** and never
queries a product table (`lib/alerts/authorities.ts` holds zero computation by
construction). Composition is permitted; recomputation is not.

---

## E. Projection doctrine

**Every operational projection must declare, in its module header: its canonical
inputs, its derived outputs, and its trust tier. No projection is authoritative, and
no projection is persisted.**

Rules that bind every projection:

1. **Inputs are named authorities, not tables.** A projection that reaches past an
   authority into its raw table is re-deriving that authority (§D.4).
2. **Trust degrades, never improves.** A projection over an `unknown` input is
   `unknown`. Use `worstTier`. A projection may *lower* a tier (a derivation over
   observed rows is `derived`; a dollar figure over a price table is `estimated`) but
   may never raise one.
3. **Best-effort per source.** One source failing degrades that source to `unknown` —
   it never fabricates a value and never breaks the whole read
   (`lib/platform/history/history.ts`).
4. **Pure core + injected I/O.** The house pattern, already uniform across
   `health.ts`, `resource-freshness.ts`, `provider-health.ts`, `convergence.ts`,
   `cost.ts`, `activity.ts`: the classifier is a pure function unit-testable with an
   in-memory fake; the impure gather is one thin edge.
5. **A projection creates no table and performs no write.** If a projection needs
   persistence, the missing thing is a **fact**, not a cached projection — introduce
   the fact at its producing domain instead.
6. **Honest null over confident zero.** Provider quota is `null` because neither Plaid
   nor OXR exposes a pollable quota this app stores. `estimatedSpendUsd` is `null`
   when no pricing is configured. A metric with no evidence is `null`, never `0`.

**Composition is the sanctioned extension mechanism.** S10 Cost consumes S7 History +
S9 Convergence and re-derives neither. That is the template for every new projection:
*name the upstream authorities, reduce purely over them, stamp provenance and tier.*

### E.1 — Determinism, and what follows from it

A projection is **deterministic** iff *every* input is an immutable fact **and** its
window is **closed** (`windowTo` strictly before today). Two classes follow, and they
must be labelled in each projection's contract:

| Class | Inputs | Deterministic | Consequence |
|---|---|---|---|
| **Historical** | immutable facts only, closed window | **yes** — same args always yield the same answer, forever | safely cacheable; safe to cite in an incident record |
| **Current** | open window, **or** any Transient Runtime State (§C.2) | **no** — the answer changes as the world changes | never cacheable beyond a short TTL; must carry `checkedAt` |

This is the operational restatement of an argument the repository already makes twice:
`FxRate` is insert-only for closed dates *precisely so* read-time conversion is
"deterministic and history-stable"; and `getCurrentPositions` (cheap, today-only) is
kept structurally distinct from A10 (as-of, historical), with a pinned invariant that
neither derives from the other. **Operational projections inherit that split exactly:
a current projection is never a historical portal, and a historical projection is
never rebuilt from a current one.**

**Caching is deferred, not designed in.** No platform route caches today. A cached
projection is one refactor away from being a stored health state (§E.5), so caching is
introduced only against a measured read cost, keyed on
`(projectionId, scope, windowFrom, windowTo)`, and **only for the historical class**.
An open window is never cached — "a cached health check is a lie" (`app/api/health`).

---

## F. Historical doctrine

**Operational history is immutable, and it is reconstructed — not stored twice.**

- Historical executions, provider calls, coverage rows, job runs, and failures are
  **facts**. Health scores over them are **projections**.
- **History is a read model, not a second fact stream.** `lib/platform/history/` adds
  no table: it re-runs each subsystem's *own live engine* at the as-of point over the
  append-only ledgers that already exist. This is what forbids a second `JobRun`
  interpretation and a second freshness model, and it guarantees historical values are
  computed the same way live values are.
- **Operational history shares the financial time model.** The same
  `asOf` / `compareTo` / window contract (`TIME_MODEL.md`) — there is no second date
  authority for operations.
- **Soft references, no FKs, on every historical operational row.** `plaidItemId`,
  `financialAccountId`, `parentJobRunId`, and `decidedByUserId` are plain indexed
  strings so the evidence **survives deletion of the entity it observed**. A stored ID
  may stop resolving and remain historically valid. An FK cascade would erase exactly
  the evidence an incident investigation needs.
- **No speculative backfill.** History before a fact model existed is simply absent,
  and absent is acceptable. Fabricating it is not.
- **Retention is a future decision, not a silent one.** No operational fact table has
  a retention policy today. When one is needed it becomes an explicit, documented
  decision — never an incidental deletion.

---

## G. Consumer doctrine

Consumers of the operational spine, and what each is **not**:

| Consumer | Consumes | Is **not** |
|---|---|---|
| **Platform Operations** | every projection in §C.3 | an authority; a place where health is computed |
| **Support / Customer Success** | connection diagnostics, stall, sync-issue semantics | a second diagnostic model |
| **Customer Diagnostics** (in-product) | connection health, coverage, freshness | a customer-facing copy of Platform Ops |
| **Ambient Intelligence / AI** | projections, as canonical scalars | a re-deriver of operational meaning |
| **Alerting** | authority **output** only (`lib/alerts/authorities.ts`) | a query over product tables |
| **Future automation** | projections + the command registry | a second execution path |

### G.1 — The read boundary (binding)

**No operational consumer issues its own query against an operational fact table.**
Consumers read through exactly two seams, mirroring the financial spine's own
two-seam shape — `DayFacts` for aggregates, `queryTransactions` for rows:

```
Immutable operational facts
      ├─ Operational Projections   ← aggregates, health, summaries   (the DayFacts analogue)
      └─ Execution Query Seam      ← bounded rows for forensics      (the queryTransactions analogue)
                                      composes scope + redaction + DTO
                                      performs NO aggregation, NO health derivation
```

The row seam is **a seam, not a bypass**: exactly as `queryTransactions` composes
`bankingTransactionWhere` (population + visibility) rather than re-deciding them, the
execution query seam composes scope and redaction rather than letting a caller reach
past them. "Reads facts directly" always means *through this seam* — never
`db.refreshExecution.findMany` at a consumer.

| Consumer class | Reads | Row seam? | Why |
|---|---|---|---|
| **Platform Operations** | projections | **yes**, for drill-down | summary surfaces are aggregates; the execution detail panel is genuinely row-level |
| **Support / Customer Success** | projections | **yes**, scoped to one connection | a support question is always "this customer, this connection" |
| **Customer Diagnostics** (in-product) | projections **only** — and a *narrowed*, redacted one | **no** | the seam returns operator-grain fields (`providerRequestId`, `errorCode`, `httpStatus`) that are support artifacts, not customer information |
| **Ambient Intelligence / AI** | projections **only**, as canonical scalars | **no** | financial spine §9 unchanged — AI projects truth, never recreates it; and unbounded ledger rows into a context window repeats the TX-1 unbounded-read defect |
| **Alerting** | authority **output** only | **no** | `lib/alerts/authorities.ts` holds zero computation *by construction*; a refresh rule adds refresh projection output to `AuthorityOutputs`, nothing else |
| **Future automation** | projections to decide; the command registry to act | **no** | never a second execution path |

**The four sanctioned exceptions** — none is a product consumer:

1. **The writer** (`lib/plaid/refresh-execution.ts`, `lib/jobs/run.ts`).
2. **The query seam itself** — the one module allowed raw access, by definition.
3. **Operator-run forensic scripts** (`scripts/`, read-only) — the same sanctioned
   standing `scripts/audit-flow-desync.ts` holds in the financial spine.
4. **Migrations / backfills.**

**Binding constraints on consumers:**

- **No consumer mutates or overloads a fact row for presentation convenience.**
- **Every consumer respects the operator/customer boundary.** Operational surfaces
  carry operational **metadata** — status, counts, timestamps, institution labels — and
  **never** balances, transaction amounts, or snapshot value columns
  (`connection-diagnostics.ts` states this as a binding boundary and reads
  `SpaceSnapshot.date` only, never its value columns).
- **The authorization axis stays orthogonal.** Platform access is decided from
  `PlatformGrant` rows alone; `lib/platform/policy.ts` knows nothing about
  `SpaceMemberRole`. Operating the product is categorically not a tenant capability —
  conflating them is a confused-deputy risk (`SECURITY_MODEL.md`).
- **One execution path.** An operator action and a cron tick are the *same* execution
  with the same ledger evidence (`runJob(trigger:"manual")` runs the byte-identical
  body). A consumer never gains a private way to make the system do work.

---

## H. Known overlaps — deliberate, and the one that is not

Naming these prevents a future hand from "fixing" a deliberate separation, or from
assuming a real problem is deliberate.

**H.1 `JobRun` vs `RefreshExecution` — DELIBERATE, with a named gap.** Different
grains: `JobRun` is one **batch**; `RefreshExecution` is one **item**. The nightly
`sync-banks` writes one `JobRun` and N executions. Neither is derivable from the
other. **Gap:** cron does not yet pass its `JobRun.id` into item executions, so
`parentJobRunId` is null for cron runs — tracked as **DF-2B.1**, not an ambiguity.
For reconnect/webhook, `null` is *correct*: no batch exists.

**H.2 `ApiUsageCounter` vs `ProviderCall` — DELIBERATE (Option A).**
`ApiUsageCounter` is the independent daily usage/billing **rollup**; `ProviderCall` is
per-attempt execution **attribution**. They are written by the same Proxy but answer
different questions, and reconciliation between them is explicitly deferred. Neither
is derived from the other. **Note:** `ApiUsageCounter` has no user/space dimension, so
per-customer cost attribution is *structurally impossible* today — an honest gap, not
a missing query.

**H.3 `AuditLog` overload — NOT deliberate; and the diagnosis is sharper than "it is
overloaded."** One table carries three concerns: security/actor audit, CH-2 connection
status transitions, and (via `LOGIN` / `SPACE_SWITCH`) the OPS-6C activity ledger.
`AuditLog.action` is a plain `String` with **no schema and no enum**, so nothing
prevents a fourth; and `lib/audit.ts` `recordAuditEvent()` — the intended chokepoint —
has **zero callers** while direct `auditLog.create` calls are spread across the
codebase (violating §D.1).

**But the three concerns are not equally misplaced, and only one is load-bearing:**

- **Connection status transitions are a homeless operational fact.** They are an
  operational fact *of the connections domain* (§D.1), currently squatting in the audit
  ledger because CH-2 needed durability without a migration. **Four** consumers now
  recover them by string-matching two action constants and parsing JSON metadata:
  `lib/connections/health.ts` (the `since` field), the S9 convergence transition
  participant, the reauth route, and the transitions writer itself. The refresh ledger
  does **not** subsume them — a status transition happens *outside* any
  `runFullRefresh` (webhook-driven ERROR, revocation, reauth completion, deletion), so
  building refresh projections relieves none of this load. They meet DF-2E's own
  normalization trigger — real per-subject status/reason, reverse lookup as a primary
  query, and time-window aggregation — and belong in their own immutable fact.
- **Lifecycle events** (`BETA_ACCESS_*`, `ACCOUNT_DEACTIVATED`, …) are **genuinely
  audit events** — "who did what to whom." They stay. Convergence reading them as one
  participant among ledgers is legitimate: an audit event may be *operationally
  relevant* without the audit log becoming an operational authority.
- **Activity metrics** (`LOGIN` / `SPACE_SWITCH` → DAU/WAU/MAU) are product analytics
  riding the audit ledger. Weakest fit, but there is no second home and no demonstrated
  harm — ADR-006 discipline says note it and wait for evidence, not pre-build a home.

**Target end state:** `AuditLog` is an **audit ledger only** — actor-attributed
security/compliance events, with their own retention and access semantics. Operational
history lives on canonical operational facts.

**H.4 Connection-state derivation is spread across three modules** —
`lib/sync/status.ts` `deriveConnectionState`, `lib/connections/health.ts`
`deriveConnectionHealthState`, and `lib/connections/intelligence.ts`. They are
consistent and each answers a different question (lifecycle · health · reconstruction
depth), but there is no single document stating which owns what. Convergence
candidate, not a live divergence.

---

## I. Infrastructure facts — the designed, unbuilt layer

> **This layer does not exist.** Nothing in the repository observes the machine.
> Sentry is initialized for **error capture only** — `instrumentation.ts` names
> "no tracing/APM, dashboards, or metric pipelines" as an **explicit non-goal**. There
> is no pool metric, no function-duration fact, no deploy identity, no request-grain
> record. This section is the contract a future slice implements, not a description of
> code.

**Why this is not optional.** A production incident (PS-0/PS-1) ran the connection pool
to exhaustion; the session query timed out, the session read as null, and the customer
saw *"Not authenticated"* and a 500 on `/dashboard`. Every operational authority in
§C.3 read healthy throughout — because the *cause* was an infrastructure fact the
platform cannot see, and the *symptom* was a domain-level error string with two
unrelated causes. No amount of additional domain projection can close that gap.

**The ownership rule:** **infrastructure facts are IMPORTED, never authored.** The
platform does not measure its own pool, its own cold starts, or its own deploy times;
it reads them from whoever owns them and records *that it read them*. A fact the
provider did not return is `unknown` — never inferred, never defaulted.

### The pipeline (design)

```
Operational Metric Provider     adapter per external system — the ONLY I/O
        ↓                       returns normalized samples, never throws
Operational Metrics             OperationalMetricSample[] — {at, value|null, tier}
        ↓
Infrastructure Facts            imported, attributed to a provider + a read time
        ↓
Operational Projections         the SAME §C.3 layer — infra becomes a new source
        ↓
Consumers                       unchanged
```

### The provider-neutral contract (design)

The critical design decision — and the anti-duplication move — is that **this is not a
new pipeline.** `OperationalMetricSample` is shaped to be structurally assignable to
`OperationalHistoryPoint` (`{ at, tier, label, value, detail? }`), so an
infrastructure provider registers as **one more `OperationalHistorySource`
descriptor** in the existing S7 registry. Adding CloudWatch adds a descriptor; it adds
no engine, no table, and no second historical model.

```ts
// Design sketch — not shipped.
interface OperationalMetricDescriptor {
  id: string;                      // "db.pool.utilization"
  label: string;
  unit: "ms" | "count" | "percent" | "bytes" | null;
  kind: "gauge" | "counter" | "event";
  ownership: "external";           // ALWAYS external — the platform never authors these
}

interface OperationalMetricProvider {
  id: string;                      // "vercel" | "aws-cloudwatch" | "postgres" | "local"
  label: string;
  capabilities: readonly string[]; // descriptor ids this provider can answer
  /** Best-effort, non-throwing. Unavailable → an `unknown`-tier empty series. */
  read(query: { metricId: string; from: Date; to: Date }): Promise<OperationalMetricSeries>;
}

interface OperationalMetricSeries {
  metricId: string;
  providerId: string;              // provenance is part of the value
  samples: readonly { at: string; value: number | null; tier: OperationalTier }[];
  tier: OperationalTier;           // worstTier over samples; `unknown` when unavailable
  checkedAt: string;
}
```

**Binding constraints on the contract:**

1. **Pull, not push.** No agent, no background collector, no metric write path. Read
   on demand at the projection boundary — the same read-time posture every existing
   projection has. This keeps the "no counter tables to drift" property.
2. **Provenance travels with the value.** A metric without a `providerId` is not a
   fact. Two providers answering the same descriptor is a `conflict`, surfaced, never
   silently resolved by preference order.
3. **Provider unavailable ⇒ `unknown`, never `0`, never omitted.** An adapter that
   throws is an adapter bug; the contract's failure mode is an `unknown`-tier series.
4. **Infrastructure facts never become authorities.** They are inputs to projections
   exactly like domain facts. "Infrastructure Health" is a projection, not a table.
5. **Adapters hold no semantics.** The adapter knows the vendor's API shape and
   nothing else — the `TransferEvidence` sibling-adapter pattern
   ([ADR-006](../decisions/ADR-006-provider-abstraction-timing.md)), verbatim.
6. **Build the neutral abstraction at the SECOND provider, not the first.** ADR-006 is
   binding here too: designing a "neutral" contract against one emitter bakes that
   emitter's quirks into a type. Ship the first adapter thin, generalize when a second
   real one arrives. The sketch above is a *target*, not a licence to build an
   adapter framework before there is anything to adapt.

**Candidate providers, in the order their absence hurts:** local runtime
instrumentation (pool state, function duration — cheapest, closes the PS-0 gap) ·
PostgreSQL/Prisma (`pg_stat_*`, pool counters) · Vercel (function duration, cold
starts, **deployment identity** — the missing input for deployment correlation) ·
OpenTelemetry · AWS CloudWatch · Prometheus/Grafana. **PgBouncer** is listed in the
mission but is not in this stack today.

---

## J. Platform Operations information architecture

**Platform Operations is Fourth Meridian operating Fourth Meridian. It is not an admin
panel — it is an internal Space using the exact same Space architecture as customer
Spaces**, and this is already true in code, not aspirational:

- Platform workspaces are **universal `WorkspaceDefinition`s** unioned into the one
  `WORKSPACE_REGISTRY` (`lib/platform/workspaces.ts`) — not a parallel identity system.
- Each Platform area is backed by exactly one **system-singleton `Space`**
  (`Space.platformArea`), rendered through the shared `SpaceShell` workspace slot.
- Identity (label/icon/kind) and composition (order + section keys) are separated,
  exactly as customer Spaces separate them.
- Access is `PlatformGrant`-only, orthogonal to `SpaceMemberRole`.

**Shipped workspaces (PLATFORM_OPS):** Overview · Jobs · Providers · Operations ·
Alerts · History · AI · Costs.

The mission proposes Overview · Refresh Operations · Provider Operations · Connections
· Infrastructure · Customers · Deployments · Diagnostics · History. Validated against
what exists:

| Proposed | Verdict | Why |
|---|---|---|
| Overview | **exists** | summary + doorways; keep |
| **Refresh Operations** | **BUILD — the real gap** | four shipped authorities (§C.1) have **zero** read consumers; this is the missing workspace |
| Provider Operations | **exists** as *Providers* | already composes provider health + connection health + diagnostics + email + freshness + usage |
| Connections | **do NOT split** | already sections inside Providers; a separate workspace would duplicate composition without adding a question |
| Infrastructure | **BUILD — after §I** | has no inputs today; building the workspace first would be a dashboard that owns its own truth |
| Customers | **BUILD — but as Customer Success**, not Platform Ops | customer-impact is a distinct *area* with its own grant; `CUSTOMER_SUCCESS` already exists with one Overview |
| Deployments | **BLOCKED** | no deployment identity fact exists anywhere; see §K |
| Diagnostics | **not a workspace** | it is a *drill-down surface* per connection/customer; forcing it into a top-level workspace inverts Preview → Browser → Detail (`UI_INTERACTION_MODEL.md`) |
| History | **exists** | S7/S9/S10 already compose here |

**The IA rule:** a Platform workspace exists when it answers a **distinct operational
question with a distinct action on failure**. It does not exist because a subsystem
exists. Decomposition is demand-pulled — the other three areas deliberately keep a
single Overview until they earn more.

---

## K. Architectural gap analysis

### Already exists (do not rebuild)
Refresh execution / endpoint / provider-call / account-coverage facts · batch facts ·
sync-issue facts + semantics · connection transition history · job health · resource
freshness · provider health · connection health · stall projection · connection
diagnostics · email health · operational history (as-of + trend) · convergence
episodes · cost & latency · AI usage trend · user activity · alert engine · manual
operations command registry · the Platform Space + 8 workspaces · the trust
vocabulary.

### Exists but incomplete
| Gap | Detail |
|---|---|
| ~~Refresh ledger has zero consumers~~ | **CLOSED by OPS-2B.** The ledger now has exactly two read seams — `lib/platform/refresh/projections.ts` (aggregates) and `lib/platform/refresh/execution-query.ts` (rows) — and `read-boundary.test.ts` ratchets the rule that nothing else in the product tree may touch it. *Remaining:* no UI consumes them yet (OPS-2C). |
| Cron ↔ execution correlation | `parentJobRunId` null for cron (DF-2B.1) |
| TRANSACTIONS per-account coverage | item-level cursor ⇒ no per-account grain |
| HOLDINGS coverage is manual-path only | cron/reconnect/webhook do not run holdings |
| Whole-stage failures have no per-account rows | reason lives on the endpoint result |
| `SyncIssue.resolved` never written | no resolution path exists |
| Provider quota always `null` | no quota authority; `quota-low` rule is `live:false` |
| `AuditLog` overload + unused chokepoint | §H.3 |
| Auth emails invisible | bypass `NotificationDelivery` |
| Reconnect inline fast-slice outside the ledger | by doctrine (§J of the execution doctrine) — must be resolved coherently, not partially |

### Must be built
Infrastructure fact layer + metric-provider contract (§I) · refresh projections
(success/retry/latency/timeline/coverage/staleness) · deployment identity fact ·
customer-impact projection · Refresh Operations workspace · customer-facing connection
diagnostics · operational retention policy.

### Must never exist
A second health scale beside `CompletenessTier` · a persisted health/severity column ·
a stored operational-history table · a second execution path beside `runJob` /
`runFullRefresh` · a metric agent or background collector · a dashboard that computes
its own health · an operational surface that reads balances or transaction amounts ·
a projection whose failure changes an outcome · a "generic operational event" table
that lets any domain dump anything.

---

## L. Roadmap

The mission's OPS-2A…2H sequence assumes the projection layer and the Platform Space
are greenfield. They are not — so the sequence is re-ordered around the **actual**
gap: four shipped authorities that nothing reads.

| Slice | Scope | Why here |
|---|---|---|
| **OPS-2A** ✅ | **This document.** Operational Truth Spine. | Names the model before anything consumes it |
| **OPS-2B** ✅ | **Refresh projection layer + execution query seam** — `lib/platform/refresh/`. Five projections (Refresh Summary incl. endpoint roll-up · Provider Operation Summary · Coverage Summary · Failure Summary · Execution Timeline) + the row seam, with a repository-wide boundary ratchet. Closes **DF-2F**. *Deferred within the slice, with reasons:* Refresh Health and Account Staleness (both need a per-endpoint cadence authority that does not exist — `lib/connections/health.ts` already owns the only staleness threshold); **DF-2B.1** cron correlation (a writer change, not a read-model one) | Highest value, zero new facts, unblocks everything downstream |
| **OPS-2B′** ✅ | **Deployment stamp** — `lib/monitoring/deployment.ts` `currentDeploymentSha()` is the ONE resolver (Sentry's `release` now reads it too, so an incident and the fact that produced it share a key). Nullable `deploymentSha` on `JobRun` + `RefreshExecution`, stamped once at the start write; the completion data types omit the field, so immutability is **compiler-enforced**. A *stamp*, not a pipeline — no `Deployment` table, no FK, no provider. | **Time-sensitive: unstamped history is permanently unstamped.** Marginal cost is one column and two writes; deferring it permanently holes the correlation record |
| **OPS-2C** ✅ | **Operations Workspace** (2C-1…2C-8) — refresh read routes · the `platform-refresh` workspace · execution inspection panel · deployment evidence · Provider Operations under Providers · workspace-owned shared consumption · scheduler observation · docs. The DF-2 read model now has rendered consumers. | First consumer; proves the projections in a real surface |
| **OPS-2D** | **Connection transition fact extraction** — lift CH-2 transitions out of `AuditLog` into an immutable, `lib/connections/`-owned fact; repoint its four existing consumers. | **Moved earlier — earned dependency.** Every "since when" projection (staleness, timeline, customer impact) is otherwise forced to string-match `action` and parse JSON metadata *inside the projection layer* — the exact defect `sync-issue-semantics.ts` exists to kill, and `groupBy` cannot group a JSON path |
| **OPS-2E** | **Customer-impact projection** + Customer Success workspace decomposition. | Needs 2B (coverage/staleness) **and** 2D (truthful "since"). Operator-internal, so it validates the projections before any customer exposure |
| **OPS-2F** | **Operational metric provider contract** + **one** local-runtime adapter (pool + function duration), registered as an S7 source. | Closes the PS-0 blind spot with the cheapest possible provider. ADR-006: thin adapter, generalize at provider #2 |
| **OPS-2G** | **Infrastructure Health projection** + Infrastructure workspace. | Only after 2F gives it inputs |
| **OPS-2H** | **Customer diagnostics** — the in-product face of connection health and freshness. | Needs 2B; deliberately after 2E so the projections are operator-validated before a customer sees any of them. Projections only, redacted — never the row seam (§G.1) |
| **OPS-2I** | **`AuditLog` chokepoint repair (residual)** — enforce `recordAuditEvent`, constrain the action vocabulary. | Much smaller once 2D has lifted transitions out. Has **no dependents in either direction** — pull it forward opportunistically whenever there is slack |
| **OPS-2J** | **Ambient operational intelligence** — AI as a consumer of projections. | Last: AI is always a consumer, never an authority |
| *deferred* | Usage ↔ `ProviderCall` reconciliation · retention policy · queue/worker health (**no queue and no worker exist** — building the authority would mean inventing its subject) · a Deployments *workspace* (2B′ makes deployment a **dimension** on existing projections, which is the better answer) | Named, not scheduled |

**What changed from the first proposal, and why.** Deployment identity moved from
*deferred* to **2B′** — it is not blocked on the metric contract at all, because the
commit sha is already in-process (`/api/health` reads it; Sentry stamps it as
`release`); the only thing missing is persisting it onto facts, and that gap widens
every day. Connection-transition extraction moved from a late "AuditLog repair" to
**2D**, ahead of every projection that needs "since when", because leaving it late
would push string-matching and JSON parsing into the projection layer. The rest of the
AuditLog work moved *later*, because after 2D nothing depends on it.

**Sequencing rule:** each slice ships **authority → projection → consumer**, in that
order, and never a consumer without an authority. The reason DF-2A…2E is a *success*
with a *gap* is that it correctly refused to build UI before facts — OPS-2B is the
symmetric obligation: do not build more facts before the existing ones are read.

---

## M′. Doctrine capture — what OPS-2C proved

Seven implementation slices (2C-1…2C-7) surfaced a number of principles. Most were
implementation detail. A few recurred until they were clearly load-bearing. The rule
applied here is the repository's own (ADR-006): **a principle is promoted when it has
been useful in at least three independent slices** — not when it merely sounds true.

### Promoted to doctrine

**1. The consumption boundary — two seams, no third path.**
*Every slice, 2C-1 through 2C-7.* An operational consumer reads either a **projection**
(aggregates, summaries, verdicts) or the **query seam** (bounded rows for forensics).
Nothing else. A widget importing a projection module would "work", bypass the route's
authorization gate, and create a second consumption path for the same value. This is
enforced repository-wide by `read-boundary.test.ts`, and per-consumer by the widget
guards — never by review.

**2. An attribute is never a subject.**
*2C-4 (deployment), 2C-5 (provider operations), 2C-7 (expected slots).*

```
Execution → deploymentSha        ✅ an observed attribute of the object
Deployment → execution summary   ❌ the inversion
```

Operational tooling drifts into that inversion quietly: a divider becomes a heading, a
heading acquires a count, and within two slices the attribute owns the objects that
describe it. The defence is **structural, not editorial** — `isDeploymentBoundary`
returns a per-index boolean, so no bucket, key, or group exists for a caller to render
as a heading. Where two surfaces describe the same noun (Provider Operations vs Provider
Health), each names its own question and neither recomputes the other.

**3. Absence is a state of its own.**
*2C-2, 2C-4, 2C-5, 2C-7 — the most frequently useful principle of the slice.* Five
conditions must never collapse into one another:

```
loading · error · UNOBSERVED · a real counted ZERO · UNAVAILABLE (null)
```

`tier: "unknown"` means *there was nothing to look at* — it is not health, and must never
render as green, "0%", or "all clear". A counted zero over real observations IS a fact and
must render. The discriminator is always the **tier, never the number**. Its sharpest
form, and the one to preserve permanently:

```
never observed   →   expected   →   overdue
```

Three distinct states. `never-ran` is an operator-decides state and is never inflated into
`overdue`; an expected slot is configuration and is never evidence that anything ran.

**4. Workspace-scoped vs object-scoped resources.**
*2C-3, 2C-6.* Two genuinely different lifecycles, and conflating them produces stale data
presented as current:

| | Workspace resource | Object inspection |
|---|---|---|
| Identity | a stable endpoint | one object's id |
| URL | static literal | identity-keyed |
| Lifetime | the workspace session | until the panel closes |
| Sharing | shared by many widgets | never shared |
| Safety | static-url invariant | remount via React `key` |

A changing URL on a shared hook renders the *previous* resource's data with
`loading: false`. The two mechanisms exist because that failure is silent.

### Emerged, kept as a recurring pattern (not yet doctrine)

- **Workspace session ownership.** The workspace owns *when* a resource is fetched and
  how long it is the session's answer; the widget still owns *what it needs*. Correct and
  structurally in place, but only one duplicate pair has exercised it. Promote when a
  second workspace needs it.
- **A guard must assert its intent, not a lexical proxy for it.** Four guards in this
  initiative were broader than the doctrine they stood for and blocked legitimate work
  (OPS-2B′'s "no deployment identity in read models", two dated fences in 2C-2, one in
  2C-5). Each was narrowed to what it actually protects. The companion habit — **a fence
  written for a future slice names that slice** — made every expiry obvious rather than
  archaeological.

### Confirmed pre-existing doctrine, not created here

Panel = inspect / Modal = decide (`WORKSPACE_CONTRACT_DOCTRINE`); projections consume
authorities and never recompute them (§D.4); trust vocabulary is `CompletenessTier`
(§D.3); platform widgets self-fetch by the OPS-5 S6 decision.

### Implementation detail — deliberately not promoted

The `useKeyedFetch` local reader; the 7-character sha; section ordering within a
workspace; the specific `attemptSemantics` copy; per-widget icon choices.

---

## M. The question, answered honestly

> **Can Fourth Meridian evolve into a platform that explains not only a customer's
> financial state, but also its own operational state, using the exact same
> architectural philosophy of canonical authorities, immutable facts, derived
> projections, and domain-neutral consumers?**

**Yes — and the philosophy is already applied further than most teams get.** The
proof is not aspiration: immutable per-item execution facts with a single writer;
per-attempt provider attribution via one Proxy chokepoint; per-account coverage with
soft references that survive deletion; health computed read-time by pure classifiers
over injected readers; a history layer that reconstructs rather than duplicates; a
trust vocabulary shared verbatim with the financial spine; and Platform Operations
already living inside the universal Space architecture rather than in an admin panel.

**Three gaps stand between here and the full claim, stated precisely:**

1. **The facts are not yet consumed.** Four shipped refresh authorities have zero
   readers. Until OPS-2B, Fourth Meridian *records* its operational truth without
   *explaining* it. This is a build gap, not an architectural one.

2. **The platform is blind to the machine it runs on.** There are no infrastructure
   facts of any kind. A pool exhaustion that produced customer-visible 500s was
   invisible to every operational authority simultaneously. Until §I ships, the
   platform can explain everything it *did* and nothing about *where it ran* — and a
   whole class of incident has no operational explanation at all.

3. **One authority is genuinely overloaded.** `AuditLog` carries three concerns with
   no schema and an unused chokepoint (§H.3). Left alone, it becomes the operational
   spine's `Holding` table.

**None of the three is closed by building around it.** Do not ship an Infrastructure
workspace before infrastructure facts; do not ship a Deployments workspace before a
deployment identity fact; do not add a fifth concern to `AuditLog`. The rule that
earned the financial spine its integrity applies unchanged: **build the authority,
then the projection, then the consumer — and never the consumer first.**
