# OPS-5 Wave C — Platform Operations Activation Audit

**Status:** READ-ONLY INVESTIGATION — no implementation, no commits, no pushes, no schema changes. Design/roadmap only.
**Date:** 2026-07-17 · branch `feature/v2.5-spaces-completion` · HEAD-era
**Premise:** Waves A (workspace decomposition) + B (S7 History / S9 Convergence / S10 Cost) are complete. Wave C ACTIVATES operator capabilities on the existing substrate — it introduces no parallel authority, no second event system, no second history model. Everything **projects from** or **routes through** the existing authorities.

---

## 1. Capability census (current HEAD)

**Platform substrate — the canonical authorities (all shipped, all consumed, none to be recreated):**

| Authority | Module | Kind | What it answers |
|---|---|---|---|
| S1 Resource Freshness | `lib/platform/resource-freshness` | READ · derived | is an archive fresh (content-derived) |
| S2 Rich Job Health | `lib/jobs/health` | READ · derived | job execution health over JobRun |
| S3 Provider Health | `lib/platform/provider-health` | READ · derived | per-provider trust (consumes S1 + connection-health + JobRun + ApiUsageCounter) |
| S4 Manual Operations | `lib/platform/operations` | WRITE · manual action | Run-Now / Dry-Run through the ONE `runJob` path |
| S5 Alerting | `lib/alerts` | READ+scheduled | rule evaluation → email; alert store = evaluate-alerts JobRun |
| S7 Operational History | `lib/platform/history` | READ · projection | as-of/compare-to/trend over the ledgers, reusing live engines |
| S9 Convergence | `lib/platform/convergence` | READ · projection | correlated operational-story episodes |
| S10 Cost & Latency | `lib/platform/cost` | READ · derived | cost/latency purely derived over S7+S9 |

**Existing platform route surface (by area + kind):**

| Area | Route | Kind | Authz |
|---|---|---|---|
| PLATFORM_OPS | job-health · resource-freshness · provider-health · connection-health · rate-limits · env-status · api-usage · alerts · history · convergence · cost | READ | `requirePlatformAccess(PLATFORM_OPS, READ)` |
| PLATFORM_OPS | operations (Run-Now/Dry-Run) | WRITE | `requireFreshPlatformAccess(PLATFORM_OPS, WRITE)` |
| GROWTH_REVENUE | requests (list) · signups | READ | `requirePlatformAccess(GROWTH_REVENUE, READ)` |
| GROWTH_REVENUE | requests/[id]/approve · deny | WRITE | `requireFreshPlatformAccess(GROWTH_REVENUE, WRITE)` |
| SECURITY_OPS | audit · sessions · auth-posture · anomalies | READ | `requirePlatformAccess(SECURITY_OPS, READ)` |
| CUSTOMER_SUCCESS | sync-issues | READ | `requirePlatformAccess(CUSTOMER_SUCCESS, READ)` |

**Existing Workspaces (Wave A/B):** PLATFORM_OPS = Overview · Jobs · Providers · Operations · Alerts · **History** (S7 history + S9 convergence + S10 cost). Other areas render a single Overview grid.

**Classification of what EXISTS vs MISSING (the activation gap):**

| Capability | Status | Evidence |
|---|---|---|
| Read platform health (jobs/providers/freshness/alerts) | **EXISTS** | 11 READ routes + widgets |
| Operational history / convergence / cost | **EXISTS** (Wave B) | S7/S9/S10 + History workspace |
| Run-Now / Dry-Run (fx-rates, security-prices, sync-crypto) | **EXISTS** (S4) | `OPERATION_TARGETS` |
| Beta approve / deny (+ mint+email invite) | **EXISTS** | growth-revenue WRITE routes |
| Signups summary (total/verified/activated/active7) | **EXISTS** | signups route |
| Beta **resend** invite (surfaced) | **MISSING (surfacing)** | logic exists (re-POST approve); queue lists only PENDING |
| Beta **deactivate / suspend / re-enable** (operator) | **MISSING (route)** | `User.deactivatedAt` exists; only self-service writes it |
| **User search / filter / list** (operator) | **MISSING (route)** | only aggregate counts today |
| DAU / MAU (WAU exists as active7) | **MISSING (projection)** | trivial `UserSession` groupBy; no schema change |
| Retention / cohort / conversion trend | **MISSING (projection)** | projectable from UserSession + User; not emitted |
| Provider per-connection **Retry / Sync** by operator | **PARTIAL** | S4 fleet Run-Now for fx/prices/crypto; Plaid is per-item + excluded from S4 |
| AI usage (calls/tokens by provider/model/day) | **EXISTS** | ApiUsageCounter |
| AI cost/usage **per-user / per-workspace** | **MISSING (telemetry)** | ApiUsageCounter has NO user/space dimension |
| Operational activity feed / timeline | **MISSING (projection)** — is S9/S7, not a new system | — |

## 2. Activation roadmap

Wave C activates operator power WITHOUT new authorities. The whole roadmap sits inside Platform Operations (no second platform, no admin dashboard). Ordered by leverage × substrate-readiness:

1. **OPS-6A Connection Operations** — surface per-connection Retry/Sync as **new S4 manual-operation targets** (never bypassing S4) + a Connections view projecting S3/S7/S9. *Substrate: S4 + S3 + S7 + S9 (ready).*
2. **OPS-6B Beta Operations** — surface resend + add operator deactivate/suspend/re-enable (reuse `User.deactivatedAt`) + a user search/list route, all `GROWTH_REVENUE WRITE` + AuditLog. *Substrate: BetaAccessRequest + User lifecycle fields (ready; one small route family).*
3. **OPS-6C User Activity Intelligence** — project DAU/MAU/retention/last-login/most-active from `UserSession` (no schema). *Substrate: UserSession ledger (ready).*
4. **OPS-6D AI Intelligence** — project AI calls/tokens/estimated-cost by provider/model/day via S10's pattern + ApiUsageCounter. *Substrate: ApiUsageCounter (ready in aggregate; per-user/space blocked on telemetry).*
5. **OPS-6E Operational Timeline** — the activity feed IS an S9 projection (+ S7), NOT a new event system. *Substrate: S9 (ready).*
6. **OPS-6F Growth** — cohort/conversion/retention curves over UserSession + BetaAccessRequest, through S7's historical idiom. *Substrate: ready in projection; invite-conversion needs the BetaAccessRequest lifecycle joined.*
7. **OPS-6G Cost Expansion** — extend S10 metrics (provider/connection/beta-user cost, pricing truth-levels); per-user/per-workspace cost is **telemetry-blocked**. *Substrate: S10 (ready); attribution blocked.*

## 3. Connection Operations (OPS-6A)

Design — every manual action routes through **S4** (`runJob`), every historical/story read through **S7/S9/S3**; nothing bypasses the authorities.

| Operator capability | Route it through | Status |
|---|---|---|
| Run Sync (fx / prices / crypto) | S4 Run-Now (existing `OPERATION_TARGETS`) | **EXISTS** |
| Run Sync (Plaid banks, fleet) | S4 — but `sync-banks` is `EXCLUDED` (60-min per-item cooldown; a fleet sweep must respect per-item locks first) | **PARTIAL** — add a *cooldown-respecting* S4 target |
| Retry failed provider | a NEW S4 target keyed to the producing job (re-run `fetch-*`) — **through S4** — for archive providers. Per-connection Plaid/wallet retry needs more (see note) | **ADD (via S4)** |
| View provider history | **S7** (`getOperationalHistory`, provider = producing job + archive) | **EXISTS** |
| View provider failures | **S3** connection-health (`errorCode`, worst-first) + **S9** episodes | **EXISTS** |
| View freshness | **S1** via S3 (`freshness`) + the Providers workspace | **EXISTS** |
| View latency | **S7** latency series / **S3** `latencyMs` | **EXISTS** |
| View quota | **S3** (`quota`/`remainingQuota` — honestly null; no vendor quota API polled) | **EXISTS (honest-null)** |
| View operational episodes | **S9** convergence | **EXISTS** |
| View historical reliability | **S7** (job success-rate/punctuality over time) + **S3** availability | **EXISTS** |

**Net:** almost all Connection Operations READ capabilities already exist across S1/S3/S7/S9 — OPS-6A is mostly a *Connections workspace* that composes them, plus **new S4 targets** for Retry/Sync (never a second execution path).

**Two important nuances (from the census):**
1. **Per-item Plaid/wallet sync/refresh routes already exist** (`/api/plaid/sync`, `/api/plaid/refresh`, `/api/accounts/[id]/sync`) — but they are **owner-scoped** (`requireUser`, `userId: user.id`), 60-min per-item cooldown + in-flight lock. **An operator cannot trigger sync/refresh on another user's failed connection today.** So operator per-connection retry is a genuine gap, not just surfacing.
2. **S4's registry is job-target-only** (`OperationCommand` = kind × `targetJob` → a `SCHEDULED_JOBS.run` closure, no per-entity parameter). A per-connection retry needs a **parameterized manual op** (targetJob + connectionId) — a conscious registry extension, still landing a manual `JobRun` on the canonical path. Fleet Plaid retry = promote `sync-banks` into `OPERATION_TARGETS` with cooldown-respecting design.

**SyncIssue is strictly read-only** (`resolved` is never written by any code path; `REPLAY_*` kinds are reserved-unimplemented). Customer Success surfaces aggregates; an operator resolve/replay would be net-new (mutation + a manual op re-running the item's sync through `runJob`), deferred.

## 4. Beta Operations (OPS-6B)

**Existing (GROWTH_REVENUE WRITE, fresh-auth, AuditLog, best-effort email):** approve (mint + email `beta-invite`), deny (silent, revokes token), list queue, signups summary. Full `BetaAccessRequest` lifecycle PENDING→APPROVED→REDEEMED / DENIED, hashed single-use expiring invite token (password-reset idiom).

**Missing → what each needs (all consume existing schema; one small route family):**

| Capability | Needs | Authz |
|---|---|---|
| Resend invite | *surfacing only* — list APPROVED-unredeemed + a Resend button (server logic = re-POST approve, exists) | GROWTH_REVENUE WRITE |
| Reject (vs Deny) | already covered by `DENIED` (no new state needed) | — |
| Deactivate beta user | new route stamping `User.deactivatedAt` + `revokeAllUserSessions` + new audit action (reuses the self-service deactivation mechanism, operator-driven) | GROWTH_REVENUE WRITE (or SYSTEM_ADMIN) |
| Suspend / Re-enable | reuse `deactivatedAt` (or add a distinct `suspendedAt`/`suspendedById` to separate operator-suspend from self-deactivate) + reactivation route | GROWTH_REVENUE WRITE |
| Search / filter users | new paginated user-listing route (`where`/search) — aggregate-safe, respecting the no-PII-in-ops posture where it can | GROWTH_REVENUE READ |

**Audit trail:** every WRITE already lands an AuditLog with `performedByAdminId`; new actions follow suit (`BETA_USER_DEACTIVATED`, etc.). **Notification flow:** approve emails `beta-invite`; deactivate/suspend could reuse the existing email seam (OPS-1) if operator wants to notify — optional, not required.

## 5. User Activity Intelligence (OPS-6C)

**Authorities (two, both existing):** (1) the immutable, indexed **`AuditLog` event ledger** — `LOGIN`/`LOGOUT`/`LOGIN_FAILED` per login (indexed `[action,createdAt]`) and **`SPACE_SWITCH`** per Space open (`userId`+`spaceId`+`createdAt`, indexed `[spaceId,createdAt]`); (2) **`UserSession`** (one row per login; `createdAt` precise, `lastActiveAt` a coarse last-seen). NO new telemetry needed for the core metrics — all are projections.

| Metric | Projectable today? | Source |
|---|---|---|
| WAU | **YES (already emitted)** | `UserSession.lastActiveAt` ≥ 7d (`active7`, signups route) |
| DAU / MAU | **YES (not emitted; trivial)** | distinct `userId` on `AuditLog LOGIN` per 1d/30d (or UserSession) — no schema change |
| New users | **YES** | `User.createdAt` |
| Returning users / retention / cohort | **YES (projection)** | `User.createdAt` cohort × `AuditLog LOGIN` ledger over time |
| Invites accepted / conversion | **YES (projection)** | beta: `BetaAccessRequest` REDEEMED/APPROVED · member: `SpaceInvite` (status/createdAt/seenAt) + `MEMBER_INVITED`/`JOINED` events |
| Last login | **YES (already used)** | latest `AuditLog LOGIN.createdAt` per user (admin/security/users route) |
| Most active users | **YES** | `LOGIN`/`SPACE_SWITCH` event count per userId |
| **Most active Spaces** | **YES (space-level)** | `SPACE_SWITCH` audit event — a real Space-open ledger |
| **Most active workspaces / tabs (within a Space)** | **NO — missing** | no per-workspace/tab open event is emitted |
| Growth / retention curves over time | **YES (projection via S7 idiom)** | `AuditLog LOGIN` dated rows |

**Correction to a common assumption:** Space-level opens DO exist (`SPACE_SWITCH`); only **per-workspace/tab** opens are missing (an easy emission add). **Projection model:** a read module (`lib/platform/activity`) projecting the `AuditLog` event ledger + `UserSession` + `User` + invite tables — NO historical storage (the ledgers ARE the history, S7 idiom).

## 6. AI Operations (OPS-6D)

**Existing telemetry:** `ApiUsageCounter` — dimensions `provider` · `metric` (`chat.completions:<model>` for OpenAI — model IS captured) · `unit` (calls / prompt_tokens / completion_tokens) · `day`. Written fire-and-forget at the two chokepoints (`lib/ai/provider.ts`, `lib/plaid/client.ts`).

| Capability | Today | Note |
|---|---|---|
| AI requests / calls | **YES** | ApiUsageCounter unit=calls |
| prompt / completion tokens | **YES** | per model, per day |
| per provider / per model / per day | **YES** | the counter's native dimensions |
| estimated cost | **YES (via S10 pattern)** but **dormant** | `UNIT_PRICES_USD` ships empty → estimate null (honest) |
| growth (usage over time) | **YES (projection)** | ApiUsageCounter daily buckets → S10/S7 idiom |
| rate limits | **YES** | `RateLimit` table / rate-limits route |
| **per user** | **NO — missing dimension** | `recordApiUsage(provider, metric, unit, n)` carries NO userId |
| **per workspace / Space** | **NO — missing dimension** | no space dimension |
| top spenders | **NO** | requires per-user attribution (blocked) |

**Reuse of S10:** AI cost/latency intelligence is an S10 extension (derive over ApiUsageCounter + pricing) — **never a second cost engine**. Per-user/per-workspace AI cost is **structurally impossible** until `recordApiUsage` gains userId/spaceId (see §13).

## 7. Provider Intelligence (OPS-6E → into OPS-6A)

Extends Provider Health naturally — **all historical information comes through S7/S9**, no new provider model:

| Capability | Authority | Status |
|---|---|---|
| Historical reliability / success rate | S7 (job health over time) | **EXISTS** |
| Latency trends | S7 latency series | **EXISTS** |
| Quota trends | S3 (quota honestly null; no vendor quota polled) | **EXISTS (honest-null)** |
| Error families | S9 episodes + connection-health `errorCode` + SyncIssue `kind` | **EXISTS** |
| Provider comparison | S3 per-provider result (compose across providers) | **EXISTS (compose)** |
| Operational episodes | S9 | **EXISTS** |

Provider Intelligence = a *composition* of S3+S7+S9 in the Providers workspace, not new computation.

## 8. Operational Activity Feed (OPS-6E)

**This is a projection of S9 (+ S7), NOT a new event system.** Every example maps to an existing ledger already projected by S9's participants:

| Feed item | Source |
|---|---|
| Sync run / Provider failed / Provider recovered / Manual operation | S9 jobRun + auditLog participants (S7 for detail) |
| Alert fired / resolved | S9 alerts participant (S5 store) |
| User invited / Invite accepted | AuditLog (`BETA_ACCESS_APPROVED`/`REDEEMED`) — add a beta participant to S9 |
| Operational episode | S9 episodes |
| Deployment | **no telemetry** — a deploy-marker emission would be a small addition (S13) |

**Verdict: the timeline is S9** — extend `CONVERGENCE_PARTICIPANTS` with a beta/AuditLog-lifecycle participant (one registry entry), and render it as a feed. Do NOT create another event system.

## 9. Cost Intelligence (OPS-6G)

Extend **S10** only (no duplicate spend engine). S10 already derives runtime/latency/failure/retry/incident + honest unknown spend over S7+S9.

| Ask | Feasible via S10? |
|---|---|
| AI cost (aggregate) | **YES** — S10 + ApiUsageCounter + pricing |
| provider cost | **YES (aggregate/estimated)** — same |
| daily / weekly / monthly | **YES** — window over the daily buckets |
| unknown / estimated / configured pricing (truth level) | **YES** — S10 already tiers observed/derived/estimated/unknown; pricing state = the truth level |
| **per connection / per workspace / per org / per beta user** | **NO — attribution telemetry missing** (ApiUsageCounter has no user/space/connection dimension) |

Truth-level propagation is already S10's design (Unknown stays Unknown). Per-entity cost is the one hard blocker (§13).

## 10. Permission model

**Reality:** `PlatformAccessLevel = READ | WRITE` only. There is **no ADMIN or SYSTEM grant level** — `SYSTEM_ADMIN` is a `UserRole` break-glass bypass (never issued a grant). The mission's four-tier ask maps as:

| Tier | Mechanism today | Wave C surface |
|---|---|---|
| READ | `requirePlatformAccess(area, READ)` | all intelligence/read views |
| WRITE | `requireFreshPlatformAccess(area, WRITE)` (fresh re-auth) | S4 Run-Now, beta approve/deny/deactivate, connection retry |
| ADMIN | **no grant level** — `SYSTEM_ADMIN` break-glass only | destructive/irreversible (user deletion, purge) → keep behind `SYSTEM_ADMIN`, or introduce an `ADMIN` grant level (schema change — out of scope) |
| SYSTEM | `SYSTEM_ADMIN` role + kill switches (`DISABLE_SYSTEM_ADMIN`) | grant administration, key rotation |

**Per-surface required grant:**
- Connection Operations (retry/sync) → **PLATFORM_OPS WRITE** (through S4).
- Beta Operations (approve/deny/resend/deactivate/suspend) → **GROWTH_REVENUE WRITE**.
- User search / activity / growth / AI / cost READ views → the **area READ** (GROWTH_REVENUE for users/growth; PLATFORM_OPS for AI/cost/providers).
- Destructive (delete user, purge) → **SYSTEM_ADMIN** (no ADMIN grant exists).

Never bypass `requirePlatformAccess`/`requireFreshPlatformAccess`; every WRITE lands AuditLog with `performedByAdminId`.

## 11. Workspace roadmap

Derived (not assumed) from what has substrate. Extend the existing Platform Ops rail; keep low-signal capabilities as Overview cards.

| Workspace | Justified? | Content (existing authorities) |
|---|---|---|
| Overview | keep | summaries + doorways (Wave A) |
| Jobs | keep | S2 |
| Providers → **Connections** | keep, rename/extend | S3 + connection-health + S1 + **S4 retry/sync** + S9 episodes |
| Operations | keep | S4 Run-Now |
| Alerts | keep | S5 |
| History | keep | S7 + S9 + S10 (Wave B) |
| **Users** (GROWTH_REVENUE) | **NEW — justified** | beta queue + approve/deny/resend/deactivate + user search + activity (UserSession) |
| **Growth** (GROWTH_REVENUE) | **NEW — justified** | DAU/WAU/MAU, retention, conversion (projection) |
| **AI** (PLATFORM_OPS) | **NEW — justified (aggregate)** | ApiUsageCounter + S10 |
| Costs | **Overview cards / History** for now | S10; a dedicated workspace once per-entity attribution exists |
| Alerts/Connections/etc. Perspectives | later | see §12 |

Note: Users/Growth belong to the **GROWTH_REVENUE** area (its own Space + grant), not PLATFORM_OPS — the area boundary is the natural home, decomposed like Wave A did PLATFORM_OPS.

## 12. Perspective readiness

With Wave B's S7/S9/S10 substrate, operational Perspectives (temporal + comparative analytical workspaces) are now backable — but only where **dated history** genuinely exists:

| Perspective | Substrate | Verdict |
|---|---|---|
| **Reliability** (job success/punctuality over time) | S7 (JobRun dated) | **JUSTIFIED** |
| **Providers** (reliability/latency over time) | S7 + S9 + S3 | **JUSTIFIED** |
| **Cost** (spend/latency trend, truth-tiered) | S10 + S7 | **JUSTIFIED (aggregate)** |
| **Growth** (DAU/WAU/MAU, retention over time) | UserSession dated | **JUSTIFIED** (once OPS-6C projects it) |
| **AI** (usage/cost over time) | ApiUsageCounter dated | **JUSTIFIED (aggregate)**; per-user blocked |
| **Operations** (episode/incident trend) | S9 | **JUSTIFIED** |

All reuse Wave A's `kind:"perspective"` + `domain:"platform"` seam and the **non-finance operational temporal model** documented in Wave A (do NOT reuse the finance asOf/compareTo reducer verbatim; gate `PerspectiveShell` on `consumesShellTime`; amend the widgets⟹temporal ratchet). These are the S8-Perspective slices that were BLOCKED_ON_S7 and are now unblocked.

## 13. Missing telemetry

| Telemetry | Status | Effort |
|---|---|---|
| Login events (LOGIN/LOGOUT/failed) | **ALREADY EXISTS** | `AuditLog` event ledger (indexed `[action,createdAt]`) + `UserSession` |
| DAU/WAU/MAU, last-login, retention | **ALREADY PROJECTABLE** | AuditLog LOGIN / UserSession (projection only) |
| Invite conversion | **ALREADY PROJECTABLE** | `BetaAccessRequest` lifecycle + `SpaceInvite` (status/seenAt) + MEMBER_* events |
| **Space open events** | **ALREADY EXISTS** | `SPACE_SWITCH` audit event (userId+spaceId+createdAt) |
| Connection duration / uptime | **ALREADY PROJECTABLE** | `Connection.createdAt` + `PLAID_ITEM_STATUS_CHANGED`/`WALLET_*` transition audit events (S9 already reads them) |
| AI usage by provider/model/day | **ALREADY EXISTS** | `ApiUsageCounter` (model embedded in `metric`) |
| **Per-workspace/tab open events** | **MISSING** | **easy addition** — an emission on workspace/tab open (Space-level already exists via SPACE_SWITCH) |
| **AI dollar cost (even global)** | **MISSING (config)** | **easy** — populate `UNIT_PRICES_USD` (ships empty → estimate null) |
| **AI usage per USER** | **MISSING** | **major** — add a `userId` dimension to `ApiUsageCounter` **and** thread identity through the `lib/ai/provider.ts` / `lib/plaid/client.ts` chokepoints (they carry no user today) |
| **AI usage per WORKSPACE/Space** | **MISSING** | **major** — a `spaceId` dimension + threading space context through the chokepoints |
| **Top spenders / per-entity cost** | **MISSING** | **blocked on the per-user/space dimension above** |
| Deploy markers | **MISSING** | **easy addition** — a deploy-marker emission (optional, for the timeline) |

**The one genuinely-blocking gap is AI per-entity attribution** (a schema dimension + threading identity through the provider chokepoints — a *major*, schema-touching change). Everything user-activity, growth, space-open, connection-duration, and aggregate-AI is **projection over existing ledgers** — no new telemetry. Even the global AI dollar figure needs only a price-map populate.

## 14. Implementation slices

Each slice: compiles · validates · commits independently · consumes existing authorities · no new authority.

| Slice | Scope | Consumes | New telemetry? |
|---|---|---|---|
| **OPS-6A Connection Operations** | Connections workspace composing S3+S1+S7+S9; **new S4 targets** for per-provider Retry/Sync (Plaid via item-refresh, others via producing job) | S4 · S3 · S1 · S7 · S9 | none |
| **OPS-6B Beta Operations** | surface Resend (list APPROVED-unredeemed); operator Deactivate/Suspend/Re-enable (reuse `deactivatedAt`); user search/list route; Users workspace | BetaAccessRequest · User · AuditLog · OPS-1 email | none |
| **OPS-6C User Activity** | project DAU/MAU/retention/last-login/most-active; Growth/Users workspace content | UserSession · User | none |
| **OPS-6D AI Intelligence** | AI usage/estimated-cost by provider/model/day (aggregate); AI workspace | ApiUsageCounter · S10 · pricing | none (aggregate); per-user needs the seam |
| **OPS-6E Operational Timeline** | activity feed as an **S9 projection** — add a beta/lifecycle participant (one registry entry) | S9 (+ S7) | none |
| **OPS-6F Growth** | cohort/conversion/retention curves; Growth workspace + Perspective | UserSession · BetaAccessRequest · S7 idiom | none |
| **OPS-6G Cost Expansion** | extend S10 (provider/aggregate cost, pricing truth-levels); per-entity **deferred** on telemetry | S10 · ApiUsageCounter | per-entity blocked |
| **OPS-6H (telemetry seam)** | optional `userId`/`spaceId` on `recordApiUsage` — unblocks per-user/space AI cost (schema-touching → its own gated slice) | — | **adds the ONE missing dimension** |

## 15. Final verdict

Platform Operations already has the read-substrate to become the operating HQ; the activation gap is almost entirely **surfacing + WRITE routes + projections**, not new authorities. The **one genuinely-blocking telemetry gap is per-entity AI-cost attribution** (a `userId`/`spaceId` dimension on `ApiUsageCounter` + threading identity through the AI chokepoints — a major, schema-touching change). Space-level opens, connection-duration, and all user-activity/growth metrics are **already-projectable** off the existing `AuditLog`/`UserSession`/invite ledgers; only per-*workspace/tab* opens and the global-AI dollar figure are small additions.

```
Platform Operations ready to become Platform HQ?     PARTIAL  (read/history/manual-ops HQ: yes; user-management +
                                                              per-entity cost need OPS-6B + one telemetry seam)
Connection operations supported?                     PARTIAL  (all reads via S1/S3/S7/S9 exist; per-provider Retry/Sync
                                                              is an S4 target addition — never a bypass)
Beta operations supported?                           PARTIAL  (approve/deny exist; resend needs surfacing;
                                                              deactivate/suspend/search need small routes on existing schema)
Operational history sufficient?                      YES      (S7 + S9 cover job/alert/manual/freshness/provider history)
Growth intelligence supported?                       PARTIAL  (DAU/WAU/MAU/retention/most-active-Space all projectable from
                                                              AuditLog LOGIN/SPACE_SWITCH + UserSession — not yet emitted)
AI operational intelligence supported?               PARTIAL  (aggregate by provider/model/day: yes; per-user/per-workspace:
                                                              structurally missing — no user/space dimension on ApiUsageCounter)
Cost intelligence sufficient?                        PARTIAL  (aggregate + truth-tiered via S10: yes; global $ needs price-map
                                                              populate; per-entity: telemetry-blocked)
Missing telemetry blocks activation?                 PARTIAL  (ONLY per-entity AI cost is a hard blocker; per-workspace opens +
                                                              global-$ are small adds; everything else projects from existing ledgers)

Recommended execution order:
  OPS-6A Connection Operations   (highest leverage; substrate fully ready; strengthens S4)
  OPS-6B Beta Operations         (real operator power; small routes on existing schema)
  OPS-6C User Activity           (pure projection over UserSession; unblocks Growth)
  OPS-6E Operational Timeline    (one S9 participant; big operator value, tiny surface)
  OPS-6D AI Intelligence         (aggregate; S10 reuse)
  OPS-6F Growth                  (projection + first operational Perspective)
  OPS-6G Cost Expansion          (S10 extension; per-entity deferred)
  OPS-6H Telemetry seam          (optional userId/spaceId on recordApiUsage — unblocks per-entity cost; schema-gated, last)
```

*Read-only investigation. No implementation, no commit, no push, no schema change. Everything above projects from or routes through the existing authorities — no parallel authority, no second event system, no second history model.*
