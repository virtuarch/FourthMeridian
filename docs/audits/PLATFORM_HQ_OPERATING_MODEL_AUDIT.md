# Fourth Meridian HQ — Operating Model Audit & Implementation Plan (PO-3)

**Status:** INVESTIGATION + DESIGN + ROADMAP. No code in this deliverable.
**Date:** 2026-07-18 · branch `feature/v2.5-spaces-completion`
**Method:** four parallel read-only investigations (beta/invitation lifecycle · email infrastructure · security/growth/CS read surfaces · provider/sync/reauth lifecycle) cross-checked against `prisma/schema.prisma`, `lib/platform/**`, `lib/plaid/**`, `lib/connections/**`, `lib/email/**`, `app/api/platform/**`, `app/api/auth/register`, `app/api/access-request`.
**Predecessors:** `PLATFORM_OPERATIONS_CONVERGENCE_AUDIT.md` (capability map), `PLATFORM_SECURITY_BOUNDARY.md` (PO-1 3-axis boundary + audit foundation), `PLATFORM_HQ_EXPERIENCE_CONVERGENCE.md` (PO-2 editorial shell).

---

## 0. Thesis

Fourth Meridian HQ is not an admin console to build — it **already exists** as four grant-gated Spaces on the shared `SpaceShell`, and PO-2 gave it the editorial language. PO-3's job is to turn it into the **internal operating environment**: the place an employee with a `PlatformGrant` enters and has everything needed to run the platform safely.

The central finding: **most of the operating substrate already exists.** The beta lifecycle, the invitation model (email-bound, hashed, single-use), the read-models (funnels, DAU/WAU/MAU, provider health, anomaly detection), the email chokepoint, and the reactive Plaid reconnect flow are all built. The work ahead is mostly **(a) surfacing what exists in the right area, (b) completing three narrow contracts (operator-notification email, MFA-adoption rate, operator-action feed), and (c) two genuinely new pieces of architecture — the provider *authorization-age* lifecycle and the Customer Success primitives.** Almost nothing needs to be invented from scratch, and nothing needs a new permission system.

**The one hard constraint that shapes every design below:** the three authorization axes never merge (§7), and provider-lifecycle enforcement is **prompt-to-reauth, never auto-revoke** (§6).

---

## 1. Current state — what the operating substrate already provides

| Capability | State | Where |
|---|---|---|
| HQ as grant-gated Spaces on SpaceShell + editorial language | **DONE** (PO-2) | `/dashboard/platform/[area]`, `components/platform/*` |
| 3-axis authorization (SpaceMember ⊥ PlatformGrant ⊥ SYSTEM_ADMIN), tripwire-tested | **DONE** (PO-1) | `lib/platform/{policy,authorize}.ts`, `lib/platform-surface.test.ts` |
| Operator audit foundation (`recordAuditEvent`/`buildAuditData` over `AuditLog`) | **DONE** (PO-1) | `lib/audit.ts`, `lib/audit-actions.ts` |
| Mandatory admin MFA + fresh-auth gate for WRITE ops | **DONE** (PO-1) | `lib/auth-totp-policy.ts`, `requireFreshPlatformAccess` |
| Read-models: job/provider/connection health, freshness, cost, history, activity, growth, AI usage | **DONE** | `lib/platform/{provider-health,resource-freshness,activity,growth,cost,history,ai}` |
| Beta request → approve/deny → email-bound single-use invite → email-matched registration | **DONE** | `BetaAccessRequest`, `access-request`, `requests/[id]/{approve,deny}`, `register` |
| `registration_mode` (open/invite_only/closed) = the beta ON/OFF switch | **DONE** | `lib/platform-settings.ts` |
| Fleet job operations (run-now/dry-run over `sync-banks`, fx, prices, crypto), audited | **DONE** | `lib/platform/operations/{registry,execute}.ts` |
| Reactive Plaid reauth (ITEM_LOGIN_REQUIRED → NEEDS_REAUTH → reconnect via Link update mode → self-heal) | **DONE** | `lib/connections/health-transitions.ts`, `ReconnectAccountButton`, `exchangeToken` |
| Email chokepoint + typed template registry + Resend/capture transport | **DONE** | `lib/email/{send,templates,senders}` |
| Security anomaly detection (bursts, recovery-streaks, admin-probe) w/ operator email | **DONE** | `lib/security/{anomalies,anomaly-alerts}` |

**What is NOT present anywhere** (needs new architecture, §5/§6): provider *authorization-age* + reauth-after-N-days policy · per-customer operational profile · onboarding-state tracking · support/case workflow · billing/revenue · cohort-retention curves · a beta-request operator-notification email.

**Boundary confirmation (verified):** every HQ read surface touches only `User/UserSession/AuditLog/RecoveryCode/PlatformGrant/BetaAccessRequest/SyncIssue/JobRun/ApiUsageCounter/Connection/PlaidItem` — **zero** reads of transactions/balances/holdings. The one structural leak point, `SyncIssue.detail`, is explicitly never selected (`customer-success/sync-issues/route.ts`).

---

## 2. Target HQ architecture

No new shell, no second permission system, no `/admin` replacement. HQ stays four `PlatformArea` Spaces; each grows *operator actions* (write) on top of the read surfaces it already has, every action gated identically:

```
                       Fourth Meridian HQ  (PlatformGrant axis)
                                  │
   ┌───────────────┬─────────────┴─────────────┬────────────────────┐
   ▼               ▼                           ▼                    ▼
Platform Ops   Security Ops              Growth & Revenue      Customer Success
"operating     "secure?"                "growing?"            "who needs attention?"
 correctly?"
   │               │                           │                    │
 system health   auth/MFA/anomaly          signups/funnel/       sync-issue triage →
 provider/sync   sessions                  activation/retention  (new) per-customer
 job health      operator-action feed      BETA CONTROLS         operational profile,
 → operator      (grant changes)           (toggle+queue+        onboarding, support
   actions                                  invitations)          notes, access-requests
```

**The universal operator-action contract** (every write in every area, from PO-1):
`requireFreshPlatformAccess(area,"WRITE")` → operator confirms → mutate → `recordAuditEvent({actorType:"PLATFORM_OPERATOR", action, target, result})` in the same transaction → surfaced back in the Security Ops operator-action feed. Read is `requirePlatformAccess(area,"READ")`. `SYSTEM_ADMIN` retains the break-glass bypass but is not the daily path.

---

## 3. Four-space responsibility map (with classification)

Legend: **E** = already exists (presentation-migration only) · **P** = exists partially (needs API/workflow completion) · **N** = does not exist (needs new architecture).

### Platform Operations — "Is Fourth Meridian operating correctly?"
| Responsibility | Cls | Note |
|---|---|---|
| System/provider/sync/job health, integration status, failures | **E** | `provider-health`, `resource-freshness`, `job-health`, `connection-health` read-models — all shipping |
| Data-ops visibility (Plaid sync, FX refresh, price refresh, imports, jobs) | **E** | `JobRun` ledger + operations read + history |
| Fleet operator actions (rerun sync / refresh FX / prices / crypto) | **E** | `operations` registry `run-now`/`dry-run`, audited, WRITE-gated |
| **Per-target operator actions** (retry one job, refresh one provider, resync one connection) | **P** | `retry`/`refresh`/`backfill` `OperationKind`s are **reserved** (vocabulary-only); no per-`PlaidItem` command. The reserved slots are the seam — §8 Track B |

### Security Operations — "Is Fourth Meridian secure?"
| Responsibility | Cls | Note |
|---|---|---|
| Authentication events, sessions, audit history | **E** | `security-ops/{audit,sessions}`, anomaly detection fully built |
| Suspicious activity / anomalies | **E** | `lib/security/anomalies` + alerts |
| MFA **adoption rate** | **P** | numerator+denominator both computed (`auth-posture`), only the ratio math is missing — trivial |
| **Operator actions + access changes** (`PLATFORM_GRANT_*`) surfaced | **P** | rows are **written** (with `performedByAdminId`) but the feed's `ADMIN_SECURITY_FILTER_ACTIONS` **omits** them — needs a second feed/filter, not new data |

### Growth & Revenue — "How is Fourth Meridian growing?"
| Responsibility | Cls | Note |
|---|---|---|
| Users, signups, activation, product usage (Space-opens) | **E** | `signups`, `users`, `activity` (DAU/WAU/MAU + topSpaces) |
| Beta funnel (requested→approved→redeemed→activated) | **E** | `lib/platform/growth/growth.ts` computes real funnels + rates |
| **Beta Controls** (ON/OFF toggle + queue + invitation lifecycle in one operating surface) | **P** | all data exists; the toggle lives in **Admin/Security**, the queue in G&R — §4 unifies the operating view |
| Distinct "invited" funnel stage | **P** | `invitedAt` exists per row; `BetaFunnel` collapses approved+invited (no `invited` count) |
| Retention (cohort curves) | **P** | stickiness (returning7, DAU/WAU/MAU) exists; cohort-retention absent |
| Revenue | **N** | no billing/subscription model — honest "no source until v3.0" |

### Customer Success — "Who needs attention?" *(the emptiest area)*
| Responsibility | Cls | Note |
|---|---|---|
| Cross-user unresolved sync-issue triage | **E** | `cs_sync_issues` (only CS surface today) |
| Per-customer **operational** profile (connections, sync failures, cost-to-serve, flags — never finances) | **N** | no per-customer CS view exists |
| Onboarding-state | **N** | no onboarding model/tracking (only an in-app Brief prompt) |
| Support/case notes | **N** | none (ratified out until real volume; PO-4+) |
| Access-request triage (as a CS concern) | **P** | beta requests live in G&R; CS could re-view the same rows read-only |

---

## 4. Beta lifecycle design

**It already works end-to-end.** Verified flow: public `POST /api/access-request` (upsert `BetaAccessRequest`, audit `BETA_ACCESS_REQUESTED`, no enumeration) → operator queue (`requests/route.ts`, GROWTH_REVENUE READ) → `approve` (GROWTH_REVENUE WRITE, mints `randomBytes(32)`, stores SHA-256 `inviteTokenHash`, sets `inviteExpiresAt`, sends `beta-invite` email) or `deny` (nulls token) → registration in `invite_only` mode requires a valid unexpired APPROVED token **email-bound**: `register/route.ts:156` rejects `betaRequest.email !== normalizedEmail` — non-transferable, exactly the mission's requirement — → atomic redemption (`status→REDEEMED`, `inviteTokenHash:null`, pre-verified user).

**Beta ON/OFF = `registration_mode`:** `closed` (no signup) · `open` (default — anyone) · `invite_only` (**beta ON** — request→approve→email-bound invite required). This IS the toggle; it is complete and enforced at the register chokepoint.

**Design deltas (small, additive) to make it the operating model the mission describes:**

| Gap vs mission spec | Design |
|---|---|
| Toggle lives in Admin/Security, not the operating area | Surface a **Beta Controls** block in Growth & Revenue: read the current `registration_mode` + funnel counts + invitation lifecycle in one place. The *write* toggle may stay in Admin **or** be added to G&R behind `GROWTH_REVENUE WRITE` + `recordAuditEvent`. Recommend: mirror read in G&R now; add the WRITE toggle in G&R in Track B (keeps Admin as break-glass, not the daily path). |
| Invitation status vocabulary (`PENDING/APPROVED/DENIED/REDEEMED`) vs spec's `pending/accepted/revoked` | Keep the existing enum (richer + already wired). Map for display: APPROVED+unredeemed = "invited/pending", REDEEMED = "accepted", DENIED = "revoked/rejected", `inviteExpiresAt<now` = "expired". |
| No persisted `EXPIRED` state (expiry evaluated lazily at redeem) | Optional: a dispatcher sweep flips stale APPROVED rows to a display-expired state (or compute "expired" at read-time in the funnel — cheaper, no write). Recommend read-time derivation; add a persisted state only if the funnel needs it. |
| No standalone "revoke invitation" (revoke = side-effect of deny) | Add an explicit `revoke` on an APPROVED row (nulls token, keeps a distinct audit action) so an operator can pull an invite without "denying" the person. Track B. |
| 14-day TTL vs spec's 7 days | Make the TTL a `PlatformSetting` (`beta_invite_ttl_days`, default 14) rather than the hardcoded `INVITE_TTL_MS`; operator-tunable. Low-risk. |
| **Invitations must be email-bound, non-transferable** | **ALREADY TRUE** — no change needed; add a test pinning the email-match branch so it can't regress. |

**HQ Beta Controls (the operating concept), all over existing data:**
```
Growth & Revenue › Beta Access
  Status:       invite_only | open | closed        (registration_mode)
  Requests:     Pending N · Approved N · Rejected N (counts, live)
  Invitations:  Sent N · Accepted N · Expired N · Revoked N
                (Sent=invitedAt; Accepted=REDEEMED; Expired=inviteExpiresAt<now; Revoked=DENIED)
  Queue:        pending rows → RightPanel detail → Approve / Deny / Revoke (WRITE, audited)
```

---

## 5. Email automation design

**Reuse the existing chokepoint** (`sendEmail(name, to, data)` — non-throwing, typed registry, Resend-or-capture). Three additions:

1. **Beta request → operator notification** *(does not exist)*. New template `beta-request-received` (sender `platform-ops`/`beta@`) → emitted **non-throwing** from `access-request/route.ts` after the upsert. Recipient config `BETA_REQUESTS_EMAIL` in `lib/env.ts` following the **`PLATFORM_ALERTS_EMAIL` null-default honest-skip** pattern (unset ⇒ no send, no guessed mailbox). Content: applicant email + note + a deep-link to the G&R queue. No PII beyond what the operator already sees in the queue.
2. **Beta approval welcome enrichment** *(exists, bare)*. `beta-invite` already carries the registration link + 14-day expiry; enrich `lib/email/templates/beta-invite.ts` with onboarding guidance (what to do after creating the account). Presentation-only change to one template.
3. **Invitation expiration notice** *(does not exist, optional)*. A dispatcher-registered sweep reads APPROVED rows with `inviteExpiresAt` in a soon/expired window → optional `beta-invite-expiring` email to the applicant (and/or an operator digest). Rides the existing job dispatcher + `runJob` ledger; strictly additive.

**Do not** build a general email-delivery ledger in this slice — only `NotificationDelivery` exists (notification channel only), and ceremony/beta emails record outcome via `AuditLog.metadata.emailStatus`, which is sufficient for the operator surface. A delivery ledger is a future concern.

---

## 6. Provider access lifecycle design *(the largest genuinely-new piece)*

**What exists:** reactive reauth is complete — a Plaid `ITEM_LOGIN_REQUIRED`/`INVALID_ACCESS_TOKEN` flips `PlaidItem.status→NEEDS_REAUTH` via the single chokepoint `setPlaidItemHealth` (which also appends a `PLAID_ITEM_STATUS_CHANGED` audit transition), the owner is notified, `ReconnectAccountButton` opens Plaid Link **update mode** (preserving `item_id` + cursor), and `exchangeToken` self-heals the item on relink. Sync-staleness (`STALE` via `lastSyncedAt` beyond `PLAID_STALE_MS`=48h) is also detected and rolled into provider trust.

**What does NOT exist:** any notion of **authorization age** or a **reauth-after-N-days policy**. `createdAt` exists but is never interpreted as authorization age, and — critically — **update-mode relink does NOT reset it** (the `exchangeToken` upsert touches only token/`syncIncompleteAt`), so `createdAt` is the wrong proxy after a reauth.

**Design (safe, prompt-not-revoke):**

1. **`authorizedAt` / `lastReauthorizedAt`** (new `PlaidItem`/`Connection` columns) — written by `exchangeToken.ts` on **both** initial create and successful relink. This is the missing authoritative "authorization age" source. Schema addition + one writer change.
2. **Configurable reauth policy** — `PlatformSetting` `reauth_after_days` (default e.g. 90, `0`/null = disabled), following the `refreshCooldown.ts` "provider-configurable later" seam. Per-provider windows possible later.
3. **Derived `REAUTH_DUE` health state** — extend `deriveConnectionHealthState` with an **age-based** state computed from `lastReauthorizedAt ?? authorizedAt + reauth_after_days`, kept **orthogonal to** sync-`STALE` (age ≠ recency). Surfaced in `provider-health` / `connection-health` read-models and the Platform Ops provider surface ("Plaid · authorized 45d ago · reauth due in 45d").
4. **Proactive reauth prompts** — reuse the existing owner-notification + `ReconnectAccountButton` machinery, fired when `REAUTH_DUE` approaches (before Plaid rejects the credential), via the dispatcher + email seam. This is the pre-emptive analogue of today's post-breakage prompt.

**Hard constraint (from the investigation):** **never wire revocation to age/staleness.** `plaidClient.itemRemove` is irreversible at Plaid — it destroys `item_id` + cursor continuity and forces a full fresh re-link. The only revoke path today (`disconnectPlaidItemIfOrphaned`) runs solely on account-deletion orphaning, guarded. Provider-lifecycle enforcement is **prompt-to-reauth** (`REAUTH_DUE` + update-mode reconnect), full stop. Any operator "force reauth" action sets `NEEDS_REAUTH` (prompting the user) — it does not call `itemRemove`.

---

## 7. Security boundaries (reaffirmed — binding)

Unchanged from `PLATFORM_SECURITY_BOUNDARY.md`; every PO-3 design above obeys it:

- **`SpaceMember`** (customer Space access) ⊥ **`PlatformGrant`** (operator HQ access) ⊥ **`SYSTEM_ADMIN`** (break-glass). Separate models, separate policy modules, separate adapters — **never merged**. A grant mints no membership; a membership confers no operator power.
- Every operator **write** (beta approve/deny/revoke, registration-mode toggle, per-connection resync/force-reauth, deactivate/reactivate): `requireFreshPlatformAccess(area,"WRITE")` + confirmation + transactional `recordAuditEvent(performedByAdminId)`. No capability can mint capabilities (only SYSTEM_ADMIN issues grants, only to USER accounts).
- HQ surfaces read **operational aggregates/metadata only** — never customer financial data. New CS primitives (§3) must hold this line (the `SyncIssue.detail` exclusion is the model to copy).
- Do not replace the Admin Console; do not create a second permission system; do not add a dashboard without an authoritative data source; **no fake health scores** (every figure traces to a real ledger, tier honestly labelled — the read-models already do this).

---

## 8. Implementation roadmap

Separated by risk class, mapped to PO slices. Each slice: one responsibility · WRITE-gated + audited where it mutates · independently shippable.

### Track A — Surface what exists (presentation / contract-completion; low risk, no new architecture)
- **A1 — Beta Controls surface (G&R):** read `registration_mode` + funnel counts + invitation lifecycle (Sent/Accepted/Expired/Revoked derived from existing columns) as an editorial block; queue → RightPanel (read-only) reusing PO-2 idiom.
- **A2 — MFA adoption rate:** compute the ratio in `auth-posture` (numerator+denominator already there); render as a Figure.
- **A3 — Operator-action feed (Security Ops):** a second feed/filter selecting `PLATFORM_GRANT_*` + `PLATFORM_OPERATION_*` + beta/user operator actions (all already written with `performedByAdminId`). No new data — a new read view.
- **A4 — Distinct "invited" funnel stage + read-time "expired" derivation** in `growth.ts`.

### Track B — Operator write actions (backend; each PlatformGrant WRITE + confirm + audit, reusing PO-1 `recordAuditEvent`)
- **B1 — Beta operator actions in G&R:** registration-mode toggle + standalone invite `revoke` (+ resend already exists), all audited. TTL → `PlatformSetting`.
- **B2 — Beta-request operator notification email** (§5.1) + enriched approval template (§5.2).
- **B3 — Per-target job/provider actions:** wire the reserved `retry`/`refresh` `OperationKind`s + a per-`PlaidItem` operator resync (reuses `withPlaidItemSyncLock` body, authorized via `requireFreshPlatformAccess` instead of owner identity) — the capability audit's "targeted per-connection resync," top operational value.

### Track N — New architecture (schema + contract; sequence after A/B)
- **N1 — Provider authorization lifecycle** (§6): `authorizedAt`/`lastReauthorizedAt` columns + `exchangeToken` writer + `reauth_after_days` setting + `REAUTH_DUE` derived state + proactive prompts. **Never auto-revoke.**
- **N2 — Invitation-expiration sweep** (§5.3, optional) on the dispatcher.
- **N3 — Customer Success primitives:** per-customer *operational* profile (connections/sync-failures/flags, non-financial), onboarding-state model, access-request triage view. Largest new surface; demand-pull it as real operator need appears.
- **Future / out of scope:** billing/revenue (v3.0), cohort-retention curves, support/case ticketing, email-delivery ledger.

### Sequencing
Track A (all shippable now, pure surfacing) → Track B (operator power, on the PO-1 write contract) → Track N (new schema/contracts, provider lifecycle first as it has the clearest operator value and a clear safe design). Gate every mutating slice on: WRITE grant + confirmation + audit; every new surface on: authoritative data + non-financial + honest tier.

---

## 9. Answering the mission

> *"When an employee joins Fourth Meridian, they should enter HQ and have everything needed to operate the platform safely."*

**Reading** — an employee granted READ already sees, honestly and non-financially: system/provider/sync/job health, the security posture + anomalies + audit trail, the growth + beta funnels + user lifecycle, and sync-issue triage. Track A closes the last read gaps (beta controls in one place, MFA rate, operator-action feed).

**Acting** — Track B gives the safe operator actions the mission names (rerun/retry sync, refresh providers, beta approve/deny/revoke, mode toggle), each on the PO-1 contract: `PlatformGrant` WRITE + confirmation + `AuditLog`. Track N adds the provider authorization lifecycle (prompt-to-reauth) and the Customer Success surface.

**Safely** — nothing merges the three axes; nothing reads customer money; nothing auto-revokes a provider credential; no figure is fabricated. HQ becomes the place Fourth Meridian operates itself precisely because it reuses the platform's own primitives (Spaces, grants, audit, read-models, email, the reconnect flow) rather than bolting on an admin app beside them.

---

*Sources: `prisma/schema.prisma` (BetaAccessRequest, SpaceInvite, PlaidItem, Connection, AccountConnection, JobRun, AuditLog, PlatformGrant); `lib/platform-settings.ts`; `app/api/access-request`, `app/api/auth/register`, `app/api/platform/growth-revenue/{requests,users,signups,activity,growth}`, `app/api/platform/security-ops/{audit,sessions,auth-posture,anomalies}`, `app/api/platform/customer-success/sync-issues`; `lib/platform/{growth,activity,provider-health,resource-freshness}`; `lib/platform/operations/{registry,execute}`; `lib/email/{send,senders,templates}`, `lib/env.ts`; `lib/plaid/{errors,exchangeToken,refreshCooldown,disconnect}`, `lib/connections/{health,health-transitions}`, `jobs/sync-banks.ts`, `components/dashboard/ReconnectAccountButton.tsx`; `lib/security/{anomalies,anomaly-alerts}`; `lib/audit-actions.ts`. Four parallel read-only investigations, 2026-07-18.*
