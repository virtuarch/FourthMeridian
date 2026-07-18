# PO-3B — Beta Operations Write Controls (Implementation Record)

**Status:** IMPLEMENTED — the first operator *mutation* slice. Beta access is now safely operable from Fourth Meridian HQ, entirely on the PO-1 security contract.
**Date:** 2026-07-19 · branch `feature/v2.5-spaces-completion`
**Verification:** tsc clean · eslint clean (changed files) · 288/288 unit (incl. a new source-scan guard) · browser-verified the mutation loop end-to-end (mode change + revoke → Security Ops feed).
**Predecessors:** `PLATFORM_HQ_OPERATING_MODEL_AUDIT.md` (PO-3, Track B), `PLATFORM_HQ_READ_SURFACE_PO3A.md` (PO-3A read block), `PLATFORM_SECURITY_BOUNDARY.md` (PO-1).

---

## 0. What this slice delivers

A `GROWTH_REVENUE` WRITE operator can now, from HQ → Growth & Revenue → Beta Access:
- **switch the beta mode** (open / invite_only / closed) with a confirmation;
- **approve / deny** a pending request (existing routes, surfaced in the panel);
- **resend / revoke** an issued invitation.

Every mutation goes through `requireFreshPlatformAccess("GROWTH_REVENUE","WRITE")`, records an `AuditLog` row with `performedByAdminId`, and appears in the **Security Operations operator-action feed**. No new permission model, no new admin route, no second invite/audit system — the existing `registration_mode` setting, `BetaAccessRequest` lifecycle, hashed single-use email-bound token, and `sendEmail` chokepoint are reused as-is.

---

## 1. Endpoints added

| Method · Route | Auth | Mutation | Audit |
|---|---|---|---|
| `PUT /api/platform/growth-revenue/registration-mode` | `requireFreshPlatformAccess(GROWTH_REVENUE, WRITE)` | `setSetting(registration_mode, open\|invite_only\|closed)` — validated against `REGISTRATION_MODES` | `BETA_MODE_CHANGED { previous, new }` |
| `POST /api/platform/growth-revenue/requests/[id]/resend` | ″ | rotate the single-use token on an APPROVED row + re-email (`beta-invite`) | `BETA_INVITATION_RESENT { betaRequestId, email, emailStatus }` |
| `POST /api/platform/growth-revenue/requests/[id]/revoke` | ″ | null the token + `status → DENIED` — **invitation only**; never a user/access change | `BETA_INVITATION_REVOKED { betaRequestId, email }` |

**Extended (read):** `GET /api/platform/growth-revenue/requests` now also returns `invitations` (APPROVED, un-redeemed rows with `invitedAt` / `inviteExpiresAt` / derived `expired`) for the invitation-management panel.

**Unchanged (reused):** `requests/[id]/approve` + `deny` (already WRITE-gated + audited from PO-3A), and the register route's **email-binding** enforcement (`register/route.ts` rejects an email mismatch — untouched, so it can't regress).

---

## 2. Authorization path (identical for every mutation)

```
Operator  →  requireFreshPlatformAccess("GROWTH_REVENUE","WRITE")   (READ ⇒ 403; SYSTEM_ADMIN keeps break-glass)
          →  UI confirmation (ConfirmDialog for mode change + revoke)
          →  mutation
          →  db.auditLog.create({ userId, performedByAdminId, action, metadata })   (same tx family as siblings)
          →  Security Ops operator feed (OPERATOR_ACTION_FEED_ACTIONS, performedByAdminId != null)
```

The three new actions were added to `OPERATOR_ACTION_FEED_ACTIONS` so they surface in the Security Ops feed. No mutation bypasses the WRITE gate or the audit write — locked by `lib/platform/beta-ops-guards.test.ts` (source-scan).

---

## 3. Audit events

`BETA_MODE_CHANGED` · `BETA_INVITATION_RESENT` · `BETA_INVITATION_REVOKED` (new, in `lib/audit-actions.ts`). Each carries actor (`userId` + `performedByAdminId`), action, target/result (`metadata`: `{previous,new}` for mode; `{betaRequestId,email,emailStatus?}` for invitations), and timestamp (`createdAt`). Approve/deny keep their existing `BETA_ACCESS_APPROVED/DENIED` actions (not renamed — that would break the security-history allowlists).

Note on the invitation-lifecycle counts (PO-3A): revoke sets `DENIED` with `invitedAt` already set, so the lifecycle's `revoked = DENIED ∧ invitedAt != null` counts it as a **revoked invitation**, distinct from a plain denial of a never-invited request. Verified live (Revoked 0 → 1).

---

## 4. Email events

Reuse the `sendEmail` chokepoint + typed template registry:
- **Approval invite** — `beta-invite` (existing), sent by approve/resend. Preserves email-binding, hashing, single-use, 14-day expiry.
- **Intake notification** (new) — `beta-request` template (sender `platform-ops`), emitted **non-throwing** from `access-request` **only when `env.BETA_REQUESTS_EMAIL` is set** (the `PLATFORM_ALERTS_EMAIL` honest-skip pattern — never a hardcoded personal address). Applicant-facing mail is unchanged; the applicant never receives the intake notice.

No duplicate sends: approve emails once; resend rotates + emails once; deny/revoke/mode-change send nothing.

---

## 5. UI flows (editorial — Atlas Surface / Block / Figure / RightPanel / ConfirmDialog)

`GrowthBetaRequestsWidget` is now the Beta Access operating block:
- **Mode control** — status line + a 3-way segmented control; selecting a non-active mode opens a `ConfirmDialog` before the `PUT`.
- **Funnel figures** — Pending / Approved / Activated / Declined + the invitation lifecycle (Sent / Accepted / Expired / Revoked).
- **Pending requests** → rows → **RightPanel** (Approve & invite / Deny in the footer).
- **Invitations** → rows (email · invited · Pending/Expired) → **RightPanel** (Resend / Revoke; revoke behind a `ConfirmDialog` that states no users/access are removed).

No tables/CRUD screens; the same row → RightPanel → action-footer idiom as the rest of HQ.

---

## 6. Testing

- **`lib/platform/beta-ops-guards.test.ts`** (new source-scan): every mutation route uses the fresh `GROWTH_REVENUE` WRITE gate + writes its `AuditLog` action + sets `performedByAdminId`; revoke nulls the token and never deletes a user / touches `SpaceMember`/`PlatformGrant`; mode change validates against `REGISTRATION_MODES`; the intake notification is honest-skip + non-throwing; resend reuses the one invite system and only acts on an APPROVED row; the new actions are in the operator feed.
- **`lib/platform/growth/growth.test.ts`**: the invitation-lifecycle projection (from PO-3A) still green.
- **Authorization** is enforced by construction: a READ operator hits `requireFreshPlatformAccess(…,"WRITE")` → 403; SYSTEM_ADMIN keeps its documented bypass (`lib/platform/policy.test.ts`). The email-binding / single-use / expiry invariants live in the untouched register + token modules.
- **Browser** (as a granted operator): mode change (Open → Invite Only) via ConfirmDialog persisted and re-rendered ("Beta access · Invite Only"); a seeded invitation → RightPanel → Revoke (ConfirmDialog) removed it and incremented **Revoked 0 → 1**; both actions appeared in the Security Ops feed (`BETA_MODE_CHANGED`, `BETA_INVITATION_REVOKED`, attributed to the operator). Approve/Resend (which send **real** email — `RESEND_API_KEY` is set in this dev env) were verified to render but deliberately **not** fired live; their behavior is covered by the source-scan + tsc. Dev state (registration_mode, the seeded row) was reverted after.

---

## 7. Boundaries honored

Not implemented (separate PO slices): Plaid resync, FX refresh, provider lifecycle, customer profiles, support tooling. Not created: new permission model, new admin route, replacement invite/audit system. `SpaceMember` / `PlatformGrant` / `SYSTEM_ADMIN` remain separate; no customer financial data is read; the beta mode *write* now lives in Growth & Revenue while Admin/Security keeps its own copy as break-glass (both write the same setting).

---

## 8. Future PO slices

- Beta invite **TTL as a PlatformSetting** (`beta_invite_ttl_days`, currently the 14-day constant duplicated in approve+resend — extract to a shared helper + setting).
- **Per-target platform-ops actions** (Track B3: retry one job, resync one connection) — the same WRITE+confirm+audit contract.
- **Provider authorization lifecycle** (Track N1, prompt-not-revoke) and **Customer Success primitives** (Track N3).
- Optional: a distinct persisted `EXPIRED`/`REVOKED` invitation status (today revoke reuses `DENIED`, disambiguated by `invitedAt` in the lifecycle counts).
