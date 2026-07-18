# PO-3A — Fourth Meridian HQ Read Surface (Implementation Record)

**Status:** IMPLEMENTED — Track A of the PO-3 operating-model roadmap. Read surfaces + two pure read projections. No new permissions, no new admin surface, no customer-Space change, no writes added.
**Date:** 2026-07-18 · branch `feature/v2.5-spaces-completion`
**Verification:** tsc clean · eslint clean (changed files) · 287/287 unit (incl. registry↔composition parity guard) · browser-verified all four HQ areas as a granted operator.
**Predecessor:** `docs/audits/PLATFORM_HQ_OPERATING_MODEL_AUDIT.md` (PO-3, Track A).

---

## 0. Pre-coding gate: every surface has an authoritative data source

The mission's hard rule — *no fabricated metrics, no fake health scores* — was enforced by verifying the backing data before writing each widget:

| Surface | Authoritative source | Fabrication risk → how avoided |
|---|---|---|
| Beta registration status | `registration_mode` PlatformSetting | read-only; no invention |
| Beta request counts | `requests` route `counts{}` (existing) | — |
| Beta invitation lifecycle | `BetaAccessRequest` columns (invitedAt / status / inviteExpiresAt) | pure counts, no derived score |
| Beta funnel | `growth` route `GrowthFunnel` (existing) | — |
| MFA adoption | `auth-posture` counts (totpEnabled / totalUsers) | ratio computed client-side; **null → "—"** when no users |
| Operator action feed | `AuditLog` rows w/ `performedByAdminId` (existing) | filtered projection, actor resolved honestly |
| Provider reliability | `provider-health` `availability` (existing) | **bar omitted when availability is null** (never shown as 0%) |
| CS sync issues | `sync-issues` route (existing; `detail` excluded) | counts/timings only, no customer financial content |
| Sync/job charts over time | `lib/platform/history` `OperationalHistorySeries` (existing, powers `ops_history`) | **already surfaced** — no new chart fabricated |

---

## 1. What was implemented

### Backend (two pure READ projections — no permission, no mutation, no new store)
- **`GET /api/platform/growth-revenue/beta-status`** (GROWTH_REVENUE READ) → `{ registrationMode, invitations: {sent, accepted, expired, revoked} }`. Backed by a new pure projection `getBetaInvitationLifecycle()` in `lib/platform/growth/growth.ts` (injected-reader pattern, unit-tested): sent = `invitedAt != null`, accepted = `REDEEMED`, expired = `APPROVED ∧ inviteExpiresAt < now`, revoked = `DENIED ∧ invitedAt != null`.
- **`GET /api/platform/security-ops/operator-actions`** (SECURITY_OPS READ) → recent operator-performed platform actions (grant changes, manual operations, beta decisions, operator account state changes). Filters `AuditLog` on the new `OPERATOR_ACTION_FEED_ACTIONS` set (`lib/audit-actions.ts`) **and `performedByAdminId != null`** (so end-user self-actions are excluded); resolves the acting operator's username in one batched follow-up query (`performedByAdminId` is a soft ref, no relation); PII-minimized target label (subject username or a non-PII metadata token — never email).

### New Security Ops section
- `sec_operator_actions` registered in `PLATFORM_AREAS` (policy.ts), the `SECURITY_OPS` composition (workspaces.ts), and `PLATFORM_WIDGET_REGISTRY` (PlatformSpaceDashboard). New widget `SecOperatorActionsWidget`. The registry↔composition parity guard (`workspaces.test.ts`) passes.

### Presentation (editorial, over existing/new data — Atlas Surface/Block/Figure + RightPanel)
- **`GrowthBetaRequestsWidget` → Beta Access block:** registration-mode status line, request-count Figures, invitation-lifecycle Figures (Sent/Accepted/Expired/Revoked), pending queue as rows → **RightPanel** detail. The existing (already-authorized) Approve/Deny actions moved into the panel footer — not new writes.
- **`SecAuthPostureWidget` → MFA adoption Figure:** leads with the adoption `%` (client-side ratio over existing counts; "—" when no users).
- **`CsSyncIssuesWidget` → weighted-bar ledger:** unresolved-total Figure + per-kind weight bars → **RightPanel** per kind (count + recent occurrences), with an explicit "counts/timings only, never customer financial content" note.
- **`OpsProviderHealthWidget` → reliability bar:** per-provider availability bar + `%` (honestly omitted when `availability` is null). Provider detail RightPanel was already delivered in PO-2.

---

## 2. Files changed

New: `app/api/platform/growth-revenue/beta-status/route.ts` · `app/api/platform/security-ops/operator-actions/route.ts` · `components/platform/widgets/SecOperatorActionsWidget.tsx`.
Changed: `lib/platform/growth/growth.ts` (+`getBetaInvitationLifecycle`) · `lib/platform/growth/growth.test.ts` (+lifecycle test) · `lib/audit-actions.ts` (+`OPERATOR_ACTION_FEED_ACTIONS`) · `lib/platform/policy.ts` (+section) · `lib/platform/workspaces.ts` (+composition) · `components/platform/PlatformSpaceDashboard.tsx` (+widget registration) · widgets: `GrowthBetaRequestsWidget`, `SecAuthPostureWidget`, `CsSyncIssuesWidget`, `OpsProviderHealthWidget`.

---

## 3. Browser verification (as a granted operator)

- **Growth & Revenue:** "Beta access · Open" status + counts (2 pending) + invitation lifecycle (0 sent/accepted/expired/revoked) + pending queue → RightPanel ("BETA REQUEST / probe@example.com" + requested time + Deny/Approve footer). ✓
- **Security Operations:** "0% MFA adoption · 0 of 5 users" Figure (honest — no dev users have TOTP) + Operator Actions feed showing real grant events attributed operator→target ("Changed access level · sysadmin → chrstn", "Granted platform access · sysadmin → chrstn"). ✓
- **Customer Success:** "36 unresolved sync issues" + weighted-bar ledger (Upsert error 22 / Balance tx mismatch 8 / Removed tombstone 6) → RightPanel per kind (count + recent + boundary note). ✓
- **Platform Operations:** provider health rows; reliability bar honestly **omitted** (dev `availability` is null) — the no-fake-metric path. ✓

*Dev-DB: a temporary test-operator grant was used to view the surfaces and reverted after. The section enablements (which make these widgets visible) were left in place — they are the PO-3A feature being active, and `ensurePlatformSections` materializes them on deploy.*

---

## 4. Deferred to later PO slices (backend work, per the mission's "produce a plan" clause)

Everything in PO-3A was read-only surfacing + pure projections. The following require write/schema work and are **out of scope for this read-surface slice** (already scoped as Tracks B/N in the PO-3 audit):

- **Beta write controls in G&R** (registration-mode toggle, standalone invite revoke, TTL setting) — `requireFreshPlatformAccess WRITE` + `recordAuditEvent` (Track B1).
- **Beta-request operator-notification email** + enriched approval template (Track B2).
- **Per-target operator actions** (retry one job, resync one connection) — reserved `OperationKind`s (Track B3).
- **Provider authorization lifecycle** (`authorizedAt`/reauth-after-N-days/`REAUTH_DUE`) — new schema + prompt-not-revoke (Track N1).
- **Customer Success primitives** (per-customer operational profile, onboarding, support) — new architecture (Track N3).
- **Sync/job success sparkline inside the Jobs widget** — the series exists (`OperationalHistorySeries`), a small presentation wiring; left as a follow-up so PO-3A stays scoped.

No capability in PO-3A required new permissions, an admin-console change, a customer-Space change, or a fabricated metric.
