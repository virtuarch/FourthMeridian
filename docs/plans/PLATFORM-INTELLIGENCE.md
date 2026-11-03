# Platform Intelligence: governed operational and business intelligence

> **Owner:** Session 1 · **Status:** ACTIVE · **Updated:** 2026-11-03 · **PRs:** #255, #257

**Owner directives (2026-11-03).** One extensible, permissioned intelligence system for every Fourth Meridian domain. It answers questions nobody listed in advance, navigates the operator to the right record, and never acts without explicit authorization. The order is fixed: **data model → deterministic intelligence → conversation and navigation.** Incidents are the first domain ([PB1-INCIDENT-LIFECYCLE](PB1-INCIDENT-LIFECYCLE.md)). Every important KPI leads to the records behind it.

## Rules (binding)

- **One truth.** The Platform UI, alerts and the future AI read the same versioned metric definitions and the same permissioned readers. There is no AI-only pipeline, no AI-only route map, and no second alert engine.
- **Permissions are enforced where data is read,** including aggregation and historical search, with existing gates: `requirePlatformAccess(area, level)`. Platform Ops output carries no identities; customer identity appears only for an authorised Customer Success operator.
- **Read-only first.** OBSERVE and NAVIGATE come first. ACT needs separate authorization, confirmation and an audit trail. Nothing runs in the background, and there is no unrestricted SQL.
- **Honest provenance.** Answers separate observed, calculated, inferred, recommended and hypothetical. Every question is classed as one of: measured · calculable · inferable · needs instrumentation · unknowable. No fabricated telemetry. Documentation is never presented as if it were current code.
- **Metric definitions** include: window and timezone, numerator and denominator, inclusion and exclusion rules, freshness, provenance, coverage gaps and the permission boundary. Interactive customer activity is kept separate from background sync. Comparisons use the same definition, or the difference is disclosed.
- **Platform AI is observable,** with its own category in AI & Costs (spend, tokens, latency, failures, per-operator use, budget). Its configuration lives in Policies.

## Inventory of develop (3cbfa34, 2026-11-03)

| Domain | Trustworthy today | Inconsistent | Not measured |
|---|---|---|---|
| Growth | `User` lifecycle dates; beta funnel (`BetaAccessRequest`); allowlisted acquisition source (180 d) | "signup cohort" vs policy `CustomerCohort` | Geography: only a country header that is probably always null |
| Auth and sessions | `UserSession`; login/2FA/password/session audit actions | none | Login method and device class |
| Engagement | 9 server-side `PRODUCT_EVENT_ACTIONS` (interactive by construction, 13 months) | **Four definitions of "active"** (growth, product analytics, customer detail, a reaped-session count) | Feature use outside Space, Brief and Transactions |
| Onboarding | The PB-7 import-status fold | none | Anything older than 60 days (RefreshExecution retention) |
| Entitlements and billing | Policy groups, assignments, versions | none | **No billing, subscription, payment or revenue data exists** |
| Provider cost | `ProviderCall` (60 d), `ApiUsageCounter` (90 d), versioned rate estimates | none | Real invoices (no reconciliation) |
| AI | `AiInvocation` (90 d) by surface | none | A Platform-AI category (needs only a new `surface` value) |
| Jobs and infrastructure | `JobRun` (90 d), `RefreshExecution` (60 d) with trigger, which separates user actions from background work | none | **Deployment and release history** (a SHA stamp is the only trace) |
| Incidents | `SyncIssue`/occurrences; PB-1 Phase 1 model (#255) | Six competing readers (PB-1 §13, D1–D8) | Searchable history UI (Phase 2B) |
| Security | Login outcomes, 2FA, grant and role changes, anomalies, operator actions | none | **Authorization denials and rate-limit blocks are not recorded.** No in-app dependency or vulnerability findings. Non-product audit rows (including login IPs) have no retention rule. |
| Merchants | `Merchant`, aliases, rules, merge decisions, user category overrides | none | Drilldown records (PB-9) |
| Privacy | Deletion/purge and export jobs and audits | none | Deletion and export service-level readers |
| Docs and code | `docs/architecture`, `systems`, `decisions` | none | No in-app docs or code inspection; `/dashboard/platform/ai` is a placeholder |

**Reusable route and permission infrastructure** for the navigation registry:
- gates: `lib/platform/authorize.ts`;
- workspaces and sections: `lib/platform/workspaces.ts`, `nav.ts`, `directory.ts`, `seed.ts`, `operations/registry.ts`;
- deep links: `lib/space/space-url.ts`.

## Smallest coherent foundation (after PB-1 Phase 2)

1. **A versioned metric-definition registry in code,** following the pattern of `lib/usage/pricing.ts`. Each entry records: id, version, definition, source, reader, area and level, retention cap, and whether identifiers are allowed.
2. **First metrics, each wrapping an existing permissioned reader:**
   - signups and verified users;
   - beta funnel conversion;
   - DAU/WAU/MAU (one canonical "active" definition, replacing the four);
   - new-connection import outcomes;
   - AI spend split by customer vs overhead surface;
   - estimated provider cost;
   - job and refresh health by trigger;
   - login failures by reason.
3. **The navigation registry derived from the existing workspace and section registry plus `space-url`** (typed targets, required permission, deep-link parameters), validated in CI against real routes.
4. **`AiInvocation.surface = platform_ai`**, counted as overhead.
5. **Minimal new instrumentation, each item needing owner approval:**
   - a deployment-event row;
   - an authorization-denial and rate-limit audit row (area and code only);
   - daily rollups so history outlives the 60/90-day windows.

## Open owner decisions

- Billing and revenue data has no source. Unit economics stay estimate-only until a billing system exists.
- Whether to record country at registration (two-letter code only).
- A retention rule for non-product audit rows, which today include raw login IPs.
