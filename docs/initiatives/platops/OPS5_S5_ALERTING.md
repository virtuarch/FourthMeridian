# OPS-5 S5 — Alerting

**Status:** IMPLEMENTED · validated green (tsc · eslint · unit 273/273 incl. oracle) · committed, not pushed
**Date:** 2026-07-16 · branch `feature/v2.5-spaces-completion`
**Mission:** Platform Operations should proactively notify operators. *Intentionally small — not a generic enterprise alert engine.* One canonical alert evaluation; no duplicated health computation; consume existing health authorities.

---

## 0. What shipped

A minimal, declarative alert-rule system that **consumes the existing health authorities** and emails the operator on a breach — pull-only Platform Operations gains its first push.

- **Rule registry** (`lib/alerts/rules.ts`) — five initial rules, each a NAMED BINDING of a condition to an existing authority. No rule holds any health computation.
- **One canonical evaluation** (`lib/alerts/evaluate.ts`, pure) — classifies breach *signals* over already-fetched authority output. Never queries a product table, never re-derives a health state.
- **Orchestrator** (`lib/alerts/run.ts`) — the single I/O site: gather authorities → evaluate → suppress → deliver (OPS-1 email) → return an `AlertRunSummary`.
- **Scheduled job** (`jobs/evaluate-alerts.ts`, registered in `lib/jobs/registry.ts`) — rides the OPS-4 dispatcher on the 07:30 slot (no `vercel.json` change), sequenced last so it reads fresh state. Its **JobRun ledger row is the alert history and suppression store — no new table, no migration.**
- **Email destination** (`lib/email/templates/platform-alert.ts` + `platform-ops` sender) — the OPS-1 seam; `PLATFORM_ALERTS_EMAIL` env names the operator inbox.
- **UI** (`OpsAlertsWidget` + `GET /platform-ops/alerts`) — rules with Enabled/Disabled, Last Triggered, Destination, and a recent firing history.

## 1. The five rules → their authorities

| Rule | Consumes (existing authority) | Fires on | Severity | State |
|---|---|---|---|---|
| **resource-stale** | `checkResourceFreshness()` — OPS-5 S1 (`lib/platform/resource-freshness.ts`) | `stale` / `empty` archive | empty→critical, stale→warning | **LIVE** |
| **provider-unhealthy** | `getConnectionHealth()` (`lib/connections/health.ts`) | any non-`HEALTHY` connection | ERROR/REVOKED/NEEDS_REAUTH→critical, else warning | **LIVE** |
| **job-failing** | `checkScheduledJobHealth()` — OPS-4 S5 (`lib/jobs/health.ts`) | `failing` (failure streak) | critical | **LIVE** |
| **scheduler-silent** | `checkScheduledJobHealth()` (same authority) | `overdue` (schedule stopped) | critical | **LIVE** |
| **quota-low** | provider-quota authority — **not shipped** | — | — | **DORMANT** |

**Destination:** `sendEmail("platform-alert", …)` — OPS-1's chokepoint.

## 2. The dependency finding (why quota-low is dormant, and the correction)

The mission lists five rules and names "OPS-5 Resource Freshness" and "OPS-5 Provider Health" as authorities to consume. On investigation:

- **Freshness (`resource-stale`)** — the OPS-5 S1 authority (`checkResourceFreshness()`) **landed** during this work (commit `b209978`). Its own §6 explicitly hands off *"Alerting (push, not pull) — depends on the OPS-1 email seam"* to this slice. `resource-stale` therefore ships **LIVE**, consuming it read-only. (An earlier read of a stale git snapshot showed freshness absent; the corrected finding is that it exists.)
- **Quota (`quota-low`)** — there is **no quota authority anywhere**. `ApiUsageCounter` is call-volume only; the OXR `/usage.json` endpoint is never called; and the in-flight OPS-5 S3 "Provider Health" module (`lib/platform/provider-health.ts`) itself declares `remainingQuota: null` ("neither Plaid nor OXR exposes a quota figure this app persists"). Building a quota computation here would violate *"no duplicated health computation / if another slice owns a concern, consume it rather than recreating it."*

**Resolution (approved):** `quota-low` is a first-class rule KIND but `live: false` — inert (the engine never evaluates it, it cannot fire), surfaced in the UI as *"awaiting authority"*. It is **future-safe**: when OPS-5 S3 ships a real `remainingQuota`, activation is (1) flip `live: true`, (2) add one `provider-quota` field to `AuthorityOutputs`, (3) add one evaluator branch + one gather call. **No schema, no engine restructure, no UI change.** Adding any brand-new rule is the same shape.

## 3. Architecture (simple · deterministic · auditable · future-safe)

```
dispatcher (OPS-4)  →  runJob("evaluate-alerts")  →  evaluatePlatformAlerts()   [lib/alerts/run.ts]
                                                        │  gather (best-effort, null on failure)
                                                        ├── checkScheduledJobHealth()   (OPS-4)
                                                        ├── getConnectionHealth()       (connections)
                                                        └── checkResourceFreshness()    (OPS-5 S1)
                                                        │
   evaluateAlertRules(authorities, isEnabled)  ◀────────┘   [pure, lib/alerts/evaluate.ts]
        → AlertSignal[]  (one per breach; system ids/counts/states only — no PII)
        │
   decideDeliveries(signals, priorFired, now)  → suppress-while-open across cycles
        │
   sendEmail("platform-alert", PLATFORM_ALERTS_EMAIL, …)  [OPS-1, best-effort]
        │
   return AlertRunSummary  →  JobRun.summary  =  alert history + next-cycle suppression state
```

- **One canonical evaluation, no duplicated health computation** — pinned by a source-scan test: the pure engine imports no `db` client and touches no product table; the orchestrator consumes the three authorities by name. A green job over a cold archive still fires `resource-stale` because freshness is content-derived (S1), not job-status-derived.
- **Deterministic** — the engine + suppression + history derivation are pure functions of (authority output, prior summaries, injected clock). The whole slice unit-tests with no database or network (50 checks, `lib/alerts/alerts.test.ts`).
- **Auditable** — every evaluation is a JobRun row (the ledger the operator already reads); every firing is a `fired` record in its summary. "Did we alert on X, and when?" is a query.
- **Alert fatigue** — suppress-while-open (20h re-notify window < daily cadence) → an ongoing breach re-alerts at most once per day; a silent week sends zero mail; `never-ran` deliberately does not trip `scheduler-silent`.
- **Future channels possible** — the destination is a single seam (`sendAlertEmail` dep); a second channel (in-app, Slack) is a new branch, not an engine change. Email first.

## 4. Reuse / boundaries honored

- **Consumes, does not recreate:** reads `checkScheduledJobHealth` / `getConnectionHealth` / `checkResourceFreshness` and `sendEmail` — all read-only/existing. The engine consumes only the **minimal slice** of each authority (`AlertJobHealth` is a 4-field narrowing of the churning `JobHealthReport`), so it does not break when a sibling slice (OPS-5 S2 rich job health) adds fields.
- **No new schema / migration:** the JobRun ledger is the store. No `AlertEvent` table.
- **OPS-4 S3 ratchet updated, not weakened:** `lib/jobs/s3-workloads.test.ts` forbids alerting *logic* in the jobs core. The evaluate-alerts *registration* line (a dynamic-import by name, exactly like the S4 outbox consumer `notification-retry`) is stripped before the scan; `sendEmail` / dead-job-detection tokens stay forbidden. Alerting logic lives entirely in `lib/alerts` + `jobs/evaluate-alerts.ts` — outside the scan.
- **No PII:** alert payloads carry system identifiers (job/resource names, provider *types*, counts, states) only — never institution labels, monetary values, or user content.

## 5. Concurrency note

Sibling OPS-5 slices (S2 rich job health, S4 "Run Now", S3 provider health) were being built by a concurrent session on the same branch throughout this work — the working tree shifted repeatedly under this slice (the freshness authority appeared, then `JobHealthReport` gained fields, then S2/S4/S3 committed). Two mitigations kept this slice robust and its commit clean:

1. **Minimal-slice coupling** — the engine consumes a 4-field narrowing (`AlertJobHealth`) of the churning `JobHealthReport`, so a sibling adding job-health fields cannot break it.
2. **Explicit-pathspec commit** — this slice commits only its own files. By the time it committed, the sibling slices had landed (`6742a42` S2, `a815219` S4, `f31419f` S3), so the two shared UI files (`lib/platform/policy.ts` §`ops_alerts`, `PlatformSpaceDashboard.tsx` widget registration) held **only this slice's additions** on top of committed sibling work — verified by diff before staging — and are committed here. The one OPS-4 ratchet touched (`s3-workloads.test.ts`) was a deliberate, documented boundary update (§4), not a collision.

## 6. Validation

```
tsc --noEmit         → clean
eslint (changed)     → clean
npm run test:unit    → 273/273 (incl. financial-doctrine oracle)
lib/alerts/alerts.test.ts → 50/50 (registry · four live authorities · gating ·
  dormant quota inert · suppression · history derivation · orchestrator end-to-end
  incl. no-destination / delivery-failure / silent-platform · doctrine source-scan)
```

## 7. Deliberately deferred

- **`quota-low` activation** — waits on OPS-5 S3 producing a real `remainingQuota` (one-line activation, §2).
- **Interactive enable/disable toggle** — a WRITE lever (fresh-auth + AuditLog), split out exactly as OPS-5 S4 split "Run Now" from the read surfaces. Enablement today is a `PlatformSetting` override (`alert_rule_enabled:<id>`), read live; the widget displays state.
- **External uptime check on `/api/jobs/dispatch`** — the dispatcher is the single point of failure; the alerter cannot page on its own death. An out-of-band uptime monitor is the backstop (observability investigation §9).
- **Per-connection provider detail in alerts** — kept to one aggregate signal (alert fatigue); the Connection Health widget is the detail surface.
