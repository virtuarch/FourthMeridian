# OPS-3 S5 — Producer Waves · Investigation & Rollout Plan

**Date:** 2026-07-07 · investigated against the working tree (S0–S4 complete)
**Status:** Investigation + Wave 1 rollout ruling. No STATUS update.
**Method:** every candidate traced to its actual call site (route/lib file), its audit action, its email, and its UI surface. Classifications are grounded in what exists, not the ideal inventory (which lives in the baseline investigation §2).

---

## 1. Producer inventory (traced, per candidate)

Legend: **Audit** = existing AuditLog write · **Email** = existing email · **UI** = existing user-visible surface · **Class** = notification priority class · **Wave** = rollout assignment.

### Account & security — every site already writes audit; five already email

| Event | Source (verified call site) | Audit | Email | UI | Class | Wave |
|---|---|---|---|---|---|---|
| Password changed | `app/api/user/password/route.ts` | `PASSWORD_CHANGED` | ✅ security-alert | Security History | **Critical** | **1** |
| Password reset completed | `app/api/auth/reset-password/route.ts` | `PASSWORD_RESET_COMPLETE` (free string) | ✅ security-alert | Security History | **Critical** | **1** |
| Email change requested | `app/api/user/email/request/route.ts` | `EMAIL_CHANGE_REQUESTED` | ✅ alert (old addr) + confirm link (new) | Security History | **Critical** | **1** |
| Email change completed | `app/api/user/email/confirm/route.ts` | `EMAIL_CHANGE_COMPLETED` | (sessions revoked) | Security History | **Critical** | **1** |
| 2FA enabled | `app/api/user/totp/verify/route.ts` | `TWO_FACTOR_ENABLED` | — | Security History | **High** | **1** |
| 2FA disabled | `app/api/user/totp/disable/route.ts` | `TWO_FACTOR_DISABLED` (in `$transaction`) | — | Security History | **Critical** | **1** |
| Session revoked (single) | `app/api/user/sessions/[sessionId]/route.ts` | `SESSION_REVOKED` (in `$transaction`) | — | Active Sessions | **High** | **1** |
| Sessions revoked (bulk "sign out everywhere") | `app/api/user/sessions/route.ts` | `SESSION_REVOKED` | — | Active Sessions | **Do not notify** — self-initiated bulk action; a ping per own click is noise. Revisit if an *admin*-revocation surface appears | — |
| Account deactivated | `app/api/user/deactivate/route.ts` | `ACCOUNT_DEACTIVATED` | ✅ security-alert | — | **High** (seen on return) | **1** |
| Account reactivated | `lib/auth.ts` reactivation leg | `ACCOUNT_REACTIVATED` | ✅ security-alert | — | **High** | **1** |
| Deletion requested | `app/api/user/delete/route.ts` | `ACCOUNT_DELETION_REQUESTED` | ✅ security-alert | delete card | **Critical** | **1** |
| Deletion cancelled | `lib/auth.ts` cancel-deletion leg | `ACCOUNT_DELETION_CANCELLED` | ✅ security-alert | — | **High** | **1** |
| Data exported | `app/api/user/export/route.ts` | `DATA_EXPORTED` | ✅ security-alert | Data & Privacy | **Critical** | **1** |
| Email verified | `app/api/auth/verify-email/route.ts` | `EMAIL_VERIFIED` | — | (the ceremony itself) | **Low** — the user is mid-ceremony, staring at the confirmation | 1b (deferred) |
| Recovery codes regenerated | `lib/recovery-codes.ts` | `RECOVERY_CODES_REGENERATED` | — | recovery UI | **Medium** | 1b (deferred) |
| Recovery code used | login path | `RECOVERY_CODE_USED` | — | Security History | **Medium** | 1b (deferred) |
| 2FA reset (admin) | admin flow | `TWO_FACTOR_RESET` | — | — | **Medium** — admin-on-behalf semantics need care (`performedByAdminId`) | 1b (deferred) |
| Account deleted (purge) | `lib/account-deletion/purge.ts` | `ACCOUNT_DELETED` | ✅ final email | — | **Do not notify** — no User row remains (named bypass #2) | — |
| Login / logout / failed login | `lib/auth.ts` | `LOGIN`/`LOGOUT`/`LOGIN_FAILED` | — | Security History | **Do not notify** — every session would open on a self-caused ping; Security History is the right surface. New-device login would be valuable but needs OPS-2 S8 device identity (deferred there) | — |

### Spaces — EV-1 events EXERCISED; one producer already wired (S1)

| Event | Source | Audit/Event | Email | Class | Wave |
|---|---|---|---|---|---|
| Invite received | `MemberInvited` EV-1 handler | ✅ | ✅ invite email | High | **wired (S1)** |
| Invite accepted | `MemberJoined` event (audit-only today) | ✅ | — | Medium (pings the inviter) | 2 |
| Member removed | `MemberRemoved` event (has snapshot handler) | ✅ | — | High (pings the removed) | 2 |
| Role changed | `MemberRoleChanged` event (audit-only) | ✅ | — | Medium | 2 |
| Member left | `MemberLeft` event | ✅ | — | Low (owner awareness) — evaluate at Wave 2 entry | 2? |
| Ownership transferred | feature does not exist (OPS-2 deferral) | — | — | vocabulary only | with its feature |

### Financial — fact substrates exist; no events at the right granularity yet

| Event | Source | Substrate | Class | Wave |
|---|---|---|---|---|
| Sync failed | `jobs/sync-banks.ts` / `lib/plaid` item error states | `PlaidItemStatus`, `SyncIssue` | **Critical** (actionable: reconnect) | 3 |
| Sync completed | `ConnectionSynced` event | — | open decision D2 (recommend: no rows; `/dashboard/connections` is the surface) | 3 (decide) |
| Duplicate detected | `DuplicateAccountCandidate` writes | ✅ table | Medium — needs the per-RUN collapse rule (one notification per run, not per candidate) | 3 |
| Import completed / with errors | import pipeline (`ImportBatch.status`) | ✅ table | Medium / High | 3 |
| Account disconnected / removed | remove-account routes (`ACCOUNT_REMOVE`) | ✅ audit | Low — self-initiated | 3 (evaluate) |
| Export completed | synchronous today (OPS-2 S6) — the download IS the completion | — | **Do not notify** until async export exists (OPS-4) | — |

### AI — producers are v2.6b by ratified roadmap; **no wave in OPS-3**

Daily Brief ready / opportunity / unusual spending / goal risk / debt alert: registry vocabulary shipped in S0; `jobs/run-ai-advice.ts` is an empty stub; brief is on-demand. Wave 4 exists as a *slot*, exercised by v2.6b, not by this initiative.

### Background jobs & platform

FX fetch, snapshots, purge-trash, process-deletions: operator-relevant, tenant-blind → **PO track (operator alerting), never user notifications** (trust boundary F14). Platform broadcasts (maintenance/feature/policy): admin-authored, deferred with OPS-5's admin surface.

---

## 2. Finding — the locked-category email duplication (resolved before Wave 1)

Wiring Wave 1 as S4 left things would **double-email every security event**: the OPS-2 routes send their dedicated `security-alert` email (support@, unconditional), and the S4 email leg — with `ACCOUNT_SECURITY` locked and S3's `locked → every channel forced on` resolution — would send a second, near-identical `notification` email (notifications@) for the same event. That violates this slice's own requirement ("do not duplicate email logic") and basic sense.

**Root cause:** S3 implemented `locked` as "all channels forced ON". The correct frozen meaning is **"the user cannot override"** — and the *email guarantee* for security events lives in the OPS-2 security-alert flow (outside the notification system, unconditional by construction), not in the notification email channel.

**Ruling (the S5 amendment, smallest correct form):**
1. `ACCOUNT_SECURITY` registry defaults become **IN_APP only** — the bell mirrors the alert; the email guarantee remains the existing security-alert email, untouched.
2. `locked` semantics: **registry defaults are authoritative; override rows are ignored** (`resolveChannelEnabled`: locked → `defaultChannels.includes(channel)`). This is also literally what S4's own scope froze: *"registry defaults remain authoritative."*
3. The matrix UI keeps rendering locked rows disabled — now showing the true defaults rather than all-on.

Consequence: no double emails, the user still cannot mute security notifications, and if a security event without an existing email ever needs one, the right fix is a security-alert email at its route (OPS-2 idiom, support@ identity) — not the notifications@ channel. (Noted gap for the OPS-2 track: 2FA-disable currently sends no email at all; out of OPS-3 scope.)

---

## 3. Recommended rollout

- **Wave 1 (this slice): Account & security — 12 producers**, inline `createNotification()` beside each existing audit write (capturing `auditLogId`), after the fact is committed. Highest user value (security awareness), lowest risk (every site already has audit + email anchors; notifications are additive best-effort).
  `PASSWORD_CHANGED · PASSWORD_RESET · EMAIL_CHANGE_REQUESTED · EMAIL_CHANGE_COMPLETED · TWO_FACTOR_ENABLED · TWO_FACTOR_DISABLED · SESSION_REVOKED (single) · ACCOUNT_DEACTIVATED · ACCOUNT_REACTIVATED · ACCOUNT_DELETION_REQUESTED · ACCOUNT_DELETION_CANCELLED · DATA_EXPORTED`
- **Wave 1b (fast follow, same category):** `EMAIL_VERIFIED`, `RECOVERY_CODE_USED`, `RECOVERY_CODES_REGENERATED`, `TWO_FACTOR_RESET` — deferred for value (mid-ceremony) or semantics (admin-on-behalf), not difficulty.
- **Wave 2: Spaces** — EV-1 handlers on `MemberJoined` (→ inviter), `MemberRemoved` (→ removed), `MemberRoleChanged` (→ target); decide `MemberLeft` at entry. Low risk: the dispatch seam and the S1 handler pattern already exist.
- **Wave 3: Financial** — `SYNC_FAILED` (dedupe suppress, key retirement on successful sync), `DUPLICATE_DETECTED` (per-run collapse), `IMPORT_COMPLETED(_WITH_ERRORS)`; resolve D2 (`SYNC_COMPLETED`). Highest care: producers live in job/sync code paths, and the suppress-retirement leg touches sync success handling.
- **Wave 4 (slot only): AI** — exercised by v2.6b through the same chokepoint; nothing in OPS-3.

Rationale for the order: value density (security first), anchor maturity (audit+email exist in Wave 1; events exist in Wave 2; only facts exist in Wave 3), and blast radius (routes → handlers → sync engine).

---

*Investigation ends. Wave 1 implemented in this slice; Waves 1b/2/3 are NOT started.*
