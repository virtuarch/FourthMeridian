# PO-3C — Beta Lifecycle Completion + Registration Control Plane

**Status:** IMPLEMENTED — the beta lifecycle is now complete end-to-end: operator control → public entry that honors it → invitation → account creation.
**Date:** 2026-07-19 · branch `feature/v2.5-spaces-completion`
**Verification:** tsc clean · eslint clean (changed files) · 288/289 unit (the 1 failure is a **concurrent session's** `MarketingNav.tsx` edit, not this slice — see §11) · browser-verified all four registration states on the public register page.
**Predecessors:** PO-3 audit (Track A/B), PO-3A read surface, PO-3B beta write controls, PO-1 security foundation.

---

## 1. The lifecycle (now closed)

```
Operator (Fourth Meridian HQ · Growth & Revenue)
   │  sets registration_mode (open | invite_only | closed)          [PO-3B]
   │  + direct [Invite User]                                        [PO-3C ·new]
   ▼
Registration Policy  (lib/registration-policy.ts — ONE authority)  [PO-3C ·new]
   │  read publicly by the register page, AND by the register API
   ▼
Public Entry (the register page HONORS the mode)                   [PO-3C ·new]
   ├─ open        → registration form
   ├─ invite_only → valid invite ? form (email LOCKED) : "request access"
   └─ closed      → "registration unavailable" → request access
   ▼
Invitation / Approval
   ├─ request → BetaAccessRequest → HQ queue → operator notified    [PO-3B email]
   ├─ approve → email-bound single-use invite emailed               [existing]
   └─ direct invite → same email-bound token, no request needed     [PO-3C ·new]
   ▼
Account Creation (register API — email-bound, single-use, expiry enforced)
   → User enters Fourth Meridian
```

The remaining gap PO-3C closed: the operator could change beta state, but the **public register page always showed the form**. Now the form is gated behind the authoritative policy *before* it renders.

---

## 2. Registration modes — exact meaning (the one contract, `lib/registration-policy.ts`)

| Mode | Public register page | API enforcement |
|---|---|---|
| **open** | full form, any email | anyone may register |
| **invite_only** | form ONLY with a valid invite (email locked to the bound address); otherwise → request-access | valid, unexpired, APPROVED, **email-bound** invite required (`register` route) |
| **closed** | "Registration is currently closed" → request-access | 403 before any validation |

`decideRegistrationPolicy(mode, invite)` is the pure decision (unit-tested, exhaustive over the three modes); `resolveRegistrationPolicy(token)` wraps it with the mode read + `validateInvite` lookup. **`validateInvite` is the single invite-validation authority** — the register API now calls the *same* function, so the public page and the API can never disagree, and the email-binding check (`invite.email !== normalizedEmail → 403`) is preserved verbatim.

---

## 3. Routes

| Method · Route | Auth | Purpose |
|---|---|---|
| `POST /api/registration-policy` | **public** (rate-limited, non-enumerating) | the register page reads the authoritative policy (mode + canRegister + invitedEmail) before showing the form; token in POST body (not query logs) |
| `POST /api/platform/growth-revenue/invitations` | `requireFreshPlatformAccess(GR, WRITE)` | **direct operator invite** — email-bound single-use token (default 7-day expiry), reuses the beta-invite template; rejects an existing account |
| `PUT /api/platform/growth-revenue/product-status` | ″ | set the **launch axis** (development/beta/live) — separate from the signup gate |
| `POST …/registration-mode` · `…/requests/[id]/{approve,deny,resend,revoke}` | ″ | unchanged from PO-3A/3B |
| `GET …/beta-status` | READ | now also returns `productStatus` |
| `POST /api/auth/register` | public | refactored to use the shared `validateInvite`; email-binding + redemption unchanged |

---

## 4. Mutations & confirmation

Every operator mutation obeys the PO-1 contract — `requireFreshPlatformAccess(GROWTH_REVENUE, WRITE)` → confirmation (ConfirmDialog for mode + product-status changes) → mutation → `AuditLog(performedByAdminId)` → Security Ops feed. The direct-invite form and product-status/mode segmented controls all run through the same `run()` helper (fresh WRITE gate server-side). READ operators get 403 by construction; SYSTEM_ADMIN keeps break-glass.

---

## 5. Audit events

New this slice: **`BETA_INVITATION_CREATED`** (direct invite) and **`PRODUCT_STATUS_CHANGED`** (launch axis). Both added to `OPERATOR_ACTION_FEED_ACTIONS` and humanized in the Security Ops feed.

**Naming note (deliberate):** the mission's requested names map to existing constants that were **kept, not renamed**, to preserve audit-history continuity and the security-history/feed allowlists (the same discipline PO-1 used keeping `LOGIN` over `LOGIN_SUCCESS`). Mapping: `REGISTRATION_MODE_CHANGED` = `BETA_MODE_CHANGED`; `BETA_REQUEST_APPROVED/DENIED` = `BETA_ACCESS_APPROVED/DENIED`. Renaming would orphan existing rows (the feed queries by action string). All six lifecycle actions + the two new ones surface in Security Operations with readable labels.

---

## 6. Email events (existing infrastructure, no duplicate system)

| Event | Template | Recipient | Trigger |
|---|---|---|---|
| Beta request intake | `beta-request` | `env.BETA_REQUESTS_EMAIL` (honest-skip when unset) | public request-access [PO-3B] |
| Invitation (approve / resend / **direct**) | `beta-invite` (single-use link + expiry) | applicant | operator [existing + PO-3C direct] |
| Account verification | `email-verification` | new user | register (skipped for invited signups — pre-verified) |

All go through the one `sendEmail` chokepoint; non-throwing; no duplicate sends.

---

## 7. Launch model (Product Status ⟂ Registration)

Two **orthogonal** axes, never collapsed into one control:
- **Product Status** (`product_status`: development / beta / live) — maturity/framing. Gates no signup behavior.
- **Registration** (`registration_mode`: open / invite_only / closed) — the only signup gate.

So "public beta" = `beta` + `open`; "soft launch" = `live` + `invite_only`. Both are shown and controllable in Growth & Revenue (product status as a segmented control with confirm; audited `PRODUCT_STATUS_CHANGED`).

---

## 8. Growth & Revenue UI (editorial, no CRUD)

`GrowthBetaRequestsWidget` now leads with **Platform Status** (Development/Beta/Live segmented + confirm), then the **Beta mode** control, funnel/lifecycle Figures, an **[Invite User]** inline form (email + expiry-days), pending requests → RightPanel (Approve/Deny), and invitations → RightPanel (Resend/Revoke). Atlas Surface/Block/Figure + panels throughout.

---

## 9. Browser verification (public register page — email-free, fully exercised)

- **open** → full registration form, empty email. ✓
- **invite_only, no invite** → "Fourth Meridian is invite-only… You need an invitation" + Request access. ✓
- **invite_only, valid `?invite=<token>`** → form shown, **email prefilled + locked** to the invite's bound address (`po3c-test@example.com`) — mismatch can't even be typed. ✓
- **closed** → "Registration is currently closed" + Request access. ✓

Operator-side additions (Platform Status control, [Invite User]) are covered by tsc + the source-scan guard and use the identical WRITE+audit `run()` path proven live in PO-3B; they were **not** fired live because direct invite / approve send **real** email (`RESEND_API_KEY` is set in this dev env). Dev state (registration_mode, the seeded invite) was restored after.

---

## 10. Testing

- **`lib/registration-policy.test.ts`** (new, unit): the pure `decideRegistrationPolicy` mapping, exhaustive over open/invite_only/closed (form gating + email lock).
- **`lib/platform/beta-ops-guards.test.ts`** (extended): the two new mutations are WRITE-gated + audited; the register page gates on the policy + steers to request-access; the register API uses the shared `validateInvite` + still enforces email-binding; the public policy route is unauthenticated + rate-limited; direct invite reuses the one invite system + rejects an existing account; product-status validates its enum.
- Modes/security/invitation/email invariants: enforced by construction (fresh WRITE gate, `validateInvite` single authority, untouched register redemption).

---

## 11. Boundaries honored / known state

Not implemented (separate PO slices): Plaid revocation, sync actions, provider lifecycle, customer-success CRM. Not created: new permission model, new admin route, replacement invite/audit system. The three axes stay separate; no customer financial data read.

**Known concurrent-branch state:** `lib/marketing-boundary.test.ts` fails because a **concurrent session** added `"use client"` to `components/marketing/MarketingNav.tsx` (not part of this slice; shown `M` in git, never edited here). That session should either add MarketingNav to the marketing-boundary allowlist or revert the client directive. All PO-3C changes are green in isolation.

---

## 12. Future PO slices

- Make the marketing landing nav CTA mode-aware from the same policy (the concurrent MarketingNav change appears to be reaching for this — should read `/api/registration-policy`).
- Beta invite TTL as a `PlatformSetting` (still a per-route constant).
- Per-target platform-ops actions (Track B3); provider authorization lifecycle (Track N1); Customer Success primitives (Track N3).
