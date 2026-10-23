# Data Retention Schedule

Implemented by the daily `purge-trash` job (07:30 UTC) on the beta-1 candidate (commit `d3aa0ed`, PRIV-003 / DB-001 / OBS-007 / PRIV-012). Source: pre-beta remediation, Agent C. Changing a window is a code change in the retention job plus this table.


| Table | Kept for | Deleted when | Notes |
|---|---|---|---|
| `UserSession` | 30 days after revocation | `revokedAt < now − 30 d` | Live sessions are never touched |
| `AiInvocation` | 90 days | `occurredAt < now − 90 d` | `userId` set to null on account purge |
| `JobRun` | 90 days | `startedAt < now − 90 d` AND status ≠ `running` | |
| `RefreshExecution` (+ `RefreshEndpointResult`, `ProviderCall`, `RefreshEndpointAccountCoverage` by cascade) | 60 days | `startedAt < now − 60 d` | |
| `ProviderCall` | 60 days | `startedAt < now − 60 d` | |
| `PlaidWebhookEvent` | 30 days | `receivedAt < now − 30 d` | |
| `SyncIssue` (+ `SyncIssueOccurrence` by cascade) | 90 days after resolution | `resolved` AND `resolvedAt` (or `updatedAt` on legacy rows) `< now − 90 d` | Open issues are kept at any age |
| `ApiUsageCounter` | 90 days | `day < now − 90 d` | |
| `BetaAccessRequest` | 180 days | DENIED (`decidedAt`), PENDING (`createdAt`), APPROVED with invite expired (`inviteExpiresAt`) older than 180 d | REDEEMED kept until account deletion, which deletes it by e-mail |
| `BetaAccessRequestEvent` | 180 days | `receivedAt < now − 180 d` | Also deleted on account purge |
| `DailyBrief` | 90 days | `briefDay < now − 90 d` | |
| Unchanged | — | — | `AuditLog` security rows (forensic); product events (13 months, existing job); `Notification` (existing cleanup); `RateLimit` (24 h sweep) |

Runs daily at 07:30 UTC as the `purge-trash` job.

## Not automatic (owner decision pending)

Trashed Spaces and accounts are restorable and are **not** hard-purged on a timer. A purge window and customer notice are an owner decision.
