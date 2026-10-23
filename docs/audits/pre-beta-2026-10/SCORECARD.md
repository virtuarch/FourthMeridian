# SCORECARD — Fourth Meridian pre-beta audit

HEAD `cde8fa0e25d2c744933109b41611d1dd65a1f9a8` · `v2.6` · 2026-10-21 · read-only. Scale: 1-2 critical · 3-4 major weaknesses, not beta-ready · 5-6 functional with significant gaps · 7 generally sound · 8 strong, minor gaps · 9 very strong, verified · 10 exceptional. UNVERIFIED is used where evidence is insufficient; it is never converted to a number. Confidence: H/M/L. Beta impact: how much the item bears on the GO decision (blocks / high / medium / low / none).

## Master table

| Group | Score | Weight | Confidence | Evidence coverage | Beta impact |
|---|---|---|---|---|---|
| A. Architecture & engineering | **6.7** | 10 | H | import graph of 2,214 files; all 187 routes; core authority files read | medium |
| B. Security & privacy | **6.4** | 20 | H (code) / UNVERIFIED (live RLS catalog) | all routes guard-verified, 45 object-level reads, all RLS migrations, all AI entry points | blocks (SEC-001, SEC-002) |
| C. Financial integrity (incl. idempotency) | **6.1** | 20 | H (nothing executed) | lifecycle traced per source; 16 engines; 55-operation matrix | blocks (FIN-001/002, IDEMP-001/002) |
| D. Reliability & operations (incl. database) | **5.6** | 15 | H (structure) / all scaling PREDICTED | schema, migrations, jobs, every provider transport | blocks (OPS-002/013/015, DB-007) |
| E. Code quality & maintainability | **6.1** | 3 | H | whole-repo graph and greps | low |
| F. Testing & delivery | **4.6** | 10 | H | runner, CI, six acceptance suites, 36 tests read, `gh` branch protection | blocks (TEST-001/005) |
| G. Customer-facing Spaces | **6.1** | 7 | M (no runtime) | ~85% of customer routes; all workspace components | high |
| H. Operator-facing Spaces | **6.4** | 5 | M (no runtime) | 100% platform routes and widgets | medium |
| I. Internal observability | **5.2** | 10 | H (code) / L (live) | all alert, job, AI, freshness authorities | blocks (OBS-002/003) |
| **J. Overall beta readiness** | **5.9** | 100 | — | — | **CONDITIONAL GO** (§5 of `01-EXECUTIVE-SUMMARY.md`) |

Findings (counted once): P0 0 · P1 34 · P2 77 · P3 73.

## A. Architecture (`02`)

| Item | Score | Weight | Conf. | Beta impact |
|---|---|---|---|---|
| Overall layering | 7 | 5 | H | low |
| Frontend/backend separation | 5 | 3 | H | low |
| Service boundaries | 6 | 4 | H | low |
| API organisation | 7 | 3 | H | low |
| Business-logic placement | 7 | 4 | H | low |
| Domain modelling | 7 | 4 | H | low |
| Module cohesion | 6 | 3 | H | none |
| Dependency coupling | 5 | 3 | H | none |
| Shared libraries | 7 | 2 | M | none |
| Middleware | 8 | 3 | H | none |
| Authentication architecture | 7 | 5 | H | medium |
| Authorisation architecture | 7 | 5 | H | low |
| Database access patterns | 6 | 5 | H | medium |
| Background jobs | 7 | 3 | H | low |
| Scheduling | 6 | 2 | H | medium |
| AI orchestration | 8 | 4 | H | low |
| External provider integrations | 8 | 3 | H | low |
| Configuration management | 6 | 3 | H | low |
| Deployment architecture | 7 | 3 | H | low |
| Environment isolation | 5 | 4 | H (docs) / UNVERIFIED (live) | high |

## B. Security (`03`) and privacy (`11`)

| Item | Score | Weight | Conf. | Beta impact |
|---|---|---|---|---|
| Session management | 6 | 5 | H | blocks (SEC-001) |
| Cookie security | 9 | 3 | H | none |
| Token handling | 8 | 3 | H | none |
| Account recovery | 8 | 3 | H | low |
| Login abuse protection | 6 | 4 | M | config act |
| RBAC | 8 | 4 | H | none |
| Object-level authorisation | 8 | 5 | H/M | low |
| Tenant isolation | 7 | 5 | H | none |
| RLS | 7 | 4 | H (SQL) / UNVERIFIED (live) | cutover |
| Raw SQL / injection | 9 | 4 | H | none |
| Input validation | 6 | 3 | H | low |
| Rate limiting | 6 | 3 | H | low |
| CSRF | 8 | 3 | H | none |
| SSRF | 9 | 1 | H | none |
| Webhook verification | 9 | 3 | H | none |
| XSS | 8 | 3 | H | none |
| Secrets handling | 7 | 3 | H | none |
| Logging hygiene | 8 | 2 | H | none |
| Security headers / CSP | 5 | 2 | H | none |
| Supply chain | 4 | 4 | M | blocks (SEC-002) |
| AI: prompt injection | 7 | 3 | H | low |
| AI: tool authorisation | 8 | 4 | H | low |
| AI: cross-customer leakage | 8 | 5 | H | low |
| AI: provider data exposure | 5 | 4 | H | medium |
| AI: output trust boundary | 8 | 2 | H | low |
| AI: tool-call validation | 7 | 2 | M | low |
| AI: spending abuse | 7 | 4 | H | medium |
| AI: allowance bypass | 8 | 4 | H | low |
| AI: reservation races | 7 | 3 | H | low |
| AI: fail-open vs fail-closed | 8 | 4 | H | low |
| AI: emergency pause | 9 | 3 | H | low |
| AI: provider timeout / retry | 4 | 3 | H | blocks (SEC-AI-003) |
| Privacy: data minimisation | 6 | 3 | H | medium |
| Privacy: member boundaries | 8 | 3 | H | low |
| Privacy: consent flows | 5 | 2 | H | medium |
| Privacy: third-party sharing | 6 | 3 | H | medium |
| Privacy: AI disclosures | 5 | 2 | H | blocks (PRIV-010/011) |
| Privacy: export | 7 | 2 | H | low |
| Privacy: deletion | 5 | 3 | H | blocks (PRIV-001/002) |
| Privacy: retention | 3 | 2 | H | medium |
| Privacy: masking | 7 | 2 | H | low |
| Privacy: audit access | 6 | 2 | H | low |
| Privacy: administrator visibility | 7 | 3 | H | low |
| Privacy: incident procedures | 5 | 2 | H | low |
| Privacy: financial-data handling | 7 | 3 | H | low |
| Privacy: compliance posture | UNVERIFIED (correctly unclaimed) | 3 | H | counsel |

## C. Financial integrity (`04`) and idempotency (`05`)

| Item | Score | Weight | Conf. | Beta impact |
|---|---|---|---|---|
| Monetary precision | 6 | 6 | H | low |
| FX conversion / freshness | 8 | 5 | H | low |
| Reconciliation | 6 | 6 | M | medium |
| Duplicate prevention | 6 | 8 | H | medium-high |
| Balance consistency | 7 | 6 | H | low |
| Account aggregation | 7 | 7 | H | low-medium |
| Income / expense classification | 5 | 9 | H | blocks (FIN-002) |
| Transfer detection | 7 | 6 | H | low |
| Pending vs posted | 7 | 5 | H | low |
| Historical corrections | 5 | 5 | H | medium |
| Financial snapshots | 6 | 6 | H | low-medium |
| Forecast consistency | 5 | 10 | H | blocks (FIN-001) |
| Timezone / UTC boundaries | 7 | 4 | H | low |
| Completeness disclosures | 7 | 6 | H | low-medium |
| Missing / stale provider data | 6 | 5 | H | medium |
| Data lineage | 8 | 5 | H | low |
| Paycheck-level inference | 5 | 6 | H | high |
| Overall idempotency | 6 | 25 | H | blocks (IDEMP-001/002) |
| Concurrency safety | 6 | 20 | H | medium |
| Retry safety | 6 | 15 | H | medium |
| Job double-execution | 5 | 15 | H (Vercel semantics UNVERIFIED) | medium |
| Webhook replay | 6 | 10 | H | low-medium |
| Reservation integrity (AI) | 8 | 15 | H | low |

## D. Database and reliability (`06`)

| Item | Score | Weight | Conf. | Beta impact |
|---|---|---|---|---|
| Schema design | 7 | 3 | H | low |
| Relationships / FKs | 8 | 3 | H | low |
| Unique constraints | 8 | 2 | H | low |
| Indexes | 6 | 2 | H (static) | low |
| Query performance | UNVERIFIED | 2 | — | low now |
| Transaction boundaries | 6 | 3 | H | low |
| Connection pooling | 5 | 3 | M | low now, high at 100 concurrent |
| RLS coverage | 7 | 3 | H (SQL) / UNVERIFIED (live) | medium |
| Data retention | 3 | 2 | H | low now |
| Soft deletes | 6 | 2 | H | low |
| Cascading deletes | 7 | 3 | H | low |
| Audit trails | 6 | 2 | H | low |
| Migration discipline | 6 | 3 | H | medium |
| Backup strategy | 4 | 3 | H | blocks (DB-007) |
| Restore readiness | 3 | 3 | H | blocks (DB-007) |
| Data export | 7 | 2 | H | low |
| Customer deletion | 6 | 3 | H | medium |
| Tenant isolation (DB layer) | 7 | 3 | H | medium |
| API resilience | 5 | 3 | H | medium |
| Retry policies / backoff | 6 | 2 | H | low |
| Circuit breakers | 2 | 2 | H | low |
| Timeouts | 5 | 3 | H | medium |
| Background job reliability | 5 | 3 | H | medium → high at ~50 Items |
| Queue behaviour | 3 | 2 | H | low |
| Scheduled job overlap / locking | 6 | 2 | H | low |
| DB contention | 7 | 2 | H (static) | low |
| Memory usage | 6 | 2 | M | low |
| Serverless execution limits | 6 | 2 | H | low |
| Cache consistency | 7 | 1 | H | low |
| Rate limiting | 7 | 2 | H | low |
| Recovery after crashes | 5 | 3 | H | medium |
| Failure isolation | 6 | 3 | H | medium |
| Graceful degradation | 6 | 2 | H | low |
| Monitoring | 4 | 3 | H | medium |
| Alerting | 4 | 3 | H | blocks (OPS-002) |
| Incident response | 6 | 2 | H | low |

## E. Code quality (`07`)

| Item | Score | Weight | Conf. | Beta impact |
|---|---|---|---|---|
| Dead code | 5 | 2 | H | none |
| Duplication | 5 | 3 | H | medium (CQ-004) |
| Unused dependencies | 6 | 1 | H | low |
| Type safety | 8 | 2 | H | none |
| Error-handling consistency | 6 | 2 | H | low |
| Module boundaries | 6 | 2 | H | none |
| Query efficiency / N+1 | 7 | 2 | M | none |
| Naming / orientation | 6 | 1 | H | none |
| Complexity (largest units) | 5 | 2 | H | low |
| Legacy layers | 6 | 1 | H | none |

## F. Testing and delivery (`08`)

| Item | Score | Weight | Conf. | Beta impact |
|---|---|---|---|---|
| Unit tests | 7 | 3 | H | medium |
| Integration (service↔DB) | 7 | 3 | H | medium |
| API / route tests | 2 | 3 | H | high |
| Database acceptance | 7 | 2 | H | medium |
| RLS tests | 7 | 3 | H | medium-high |
| Authentication tests | 3 | 3 | H | high |
| Authorisation tests | 4 | 3 | H | high |
| Concurrency tests | 5 | 2 | H | medium |
| Financial calculation tests | 8 | 3 | H | low-medium |
| AI policy tests | 7 | 2 | H | low |
| UI interaction tests | 1 | 1 | H | medium |
| Accessibility tests | 2 | 1 | H | low |
| End-to-end | 1 | 2 | H | medium |
| Regression coverage | 7 | 2 | H | low |
| Negative-path | 7 | 2 | H | low |
| Failure injection | 6 | 1 | H | low |
| Recovery tests | 5 | 1 | M | medium |
| Deployment verification | 1 | 3 | H | high |
| GitHub Actions | 6 | 2 | H | medium |
| Branch protection | 1 | 3 | H | blocks (TEST-001) |
| Build reproducibility | 6 | 1 | H | low |
| Deployment controls | 5 | 2 | H | medium |
| Environment separation | 6 | 2 | M | medium |
| Preview validation | 3 | 2 | H | medium |
| Production release gates | 4 | 2 | H | medium |
| Rollback readiness | 3 | 2 | H | medium |
| Migration safety | 6 | 2 | H | medium |
| Secrets in CI | 9 | 1 | H | low |
| Artifact integrity | N/A | — | H | low |
| Docker resource cleanup | 7 | 1 | H | low |

## G/H. Spaces (`09`)

| Space | Overall | Conf. | Beta impact |
|---|---|---|---|
| My Space (Overview / Net Worth / Cash Flow / Activity / Accounts / Transactions / Members / Markets) | 6.4 | M | high |
| Daily Brief | 7.8 | M | low |
| AI (Analyze) | 7.5 | M | low |
| Connections | 7.3 | M | medium |
| Spaces management | 6.2 | M | medium |
| Credit (orphan) | 4.6 | M | low |
| Settings | 7.1 | M | low |
| **Customer-facing aggregate** | **6.1** | M | — |
| Platform Operations | 7.0 | M | medium |
| Security Operations | 6.6 | M | medium |
| Growth & Revenue | 5.9 | M | medium |
| Customer Success | 6.6 | M | medium |
| Merchant Operations | 6.4 | M | low |
| Admin area (legacy) | 6.3 | M | medium |
| **Operator-facing aggregate** | **6.4** | M | — |

## I. Observability (`10`)

| # | Item | Score | Class |
|---|---|---|---|
| 1 | Application health | 3 | B (external) |
| 2 | API health | 2 | N |
| 3 | Database health | 3 | A |
| 4 | Authentication failures | 6 | B |
| 5 | Authorisation failures | 1 | N |
| 6 | Provider connection health | 7 | D |
| 7 | Data freshness | 6 | B |
| 8 | Sync failures | 6 | C/D (un-alerted) |
| 9 | Background jobs | 7 | D |
| 10 | Scheduled jobs | 4 | B |
| 11 | Queue backlogs | 2 | N |
| 12 | Failed transactions | 3 | A |
| 13 | Reconciliation mismatches | 4 | B |
| 14 | AI request volumes | 6 | B |
| 15 | AI spending | 7 | D |
| 16 | AI allowance enforcement | 7 | D |
| 17 | AI reservation state | 3 | A |
| 18 | AI provider failures | 6 | B |
| 19 | Emergency pause state | 8 | D |
| 20 | Customer-specific errors | 7 | D |
| 21 | Subscription / billing failures | 1 | N (by design) |
| 22 | Audit logs | 7 | B |
| 23 | Security events | 5 | B |
| 24 | Deployment versions | 5 | B |
| 25 | System incidents | 5 | C |
| 26 | Alert delivery | 4 | B |
| 27 | Operational recovery | 6 | D |
| | **Aggregate** | **5.2** | |
