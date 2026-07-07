# Fourth Meridian — Official Release Checklist

**Status:** Living document · **Owner of record:** Platform / PO1
**Complements:** `SECURITY_CHECKLIST.md`
**Last reviewed:** 2026-07-07

> `SECURITY_CHECKLIST.md` answers **"Is the platform secure enough?"**
> This document answers **"Is this release actually ready to ship?"**
>
> Walk it before every deployment: **internal releases**, **closed beta**, **public beta**, **production**, and **major feature releases**. Documentation only — it does not change code, schema, or STATUS. Scale the rigor to the release type (an internal build doesn't need a pen-test; production does — see Section 11).

**Legend**
- **Priority:** Critical · High · Medium · Low
- **Status:** ✅ Complete · ⚠️ Needs work · ⏳ Future (per-release; reset each cycle)
- **Owner:** UX · OPS-1 · OPS-2 · OPS-3 · OPS-4 · OPS-5 · PO1 · Future
- **Verify:** the exact steps an engineer performs to confirm the item.

> **How to use:** copy this file's checkboxes into the release ticket (or a dated copy) and fill Status per release. The Status marks below are the *template default* — treat ✅ as "process is established," ⚠️ as "must be actively confirmed this release," ⏳ as "not yet part of the process."

---

## 1. Planning

### □ Scope frozen
Priority: Critical · Status: ⚠️ Needs work (confirm per release) · Owner: PO1
Verify:
- The release ticket lists exactly what ships; no items added after freeze.
- Anything discovered mid-build is logged as follow-up, not folded in.

### □ Roadmap updated
Priority: High · Status: ⚠️ Needs work · Owner: PO1
Verify:
- `ROADMAP.md` reflects this release's initiative and moves completed items.

### □ STATUS.md updated
Priority: High · Status: ⚠️ Needs work · Owner: PO1
Verify:
- `STATUS.md` reflects the slice/initiative state. *(This checklist does not edit STATUS; the release owner does, as a release step.)*

### □ Investigation complete
Priority: High · Status: ⚠️ Needs work · Owner: OPS-owner
Verify:
- The relevant `docs/investigations/*` (or initiative doc) exists and is resolved; open questions closed before code.

### □ Architecture approved
Priority: High · Status: ⚠️ Needs work · Owner: PO1
Verify:
- Design decisions recorded (`docs/architecture/*` or initiative decision record); reviewer sign-off captured.

### □ No open blocking decisions
Priority: Critical · Status: ⚠️ Needs work · Owner: PO1
Verify:
- No unresolved "KD"/decision items gating the release; all marked ratified or deferred-with-owner.

### □ Slice boundaries respected
Priority: Medium · Status: ⚠️ Needs work · Owner: OPS-owner
Verify:
- The diff matches the named slice; no scope bleed into adjacent slices/initiatives.

---

## 2. Code Quality

### □ Smallest implementation completed
Priority: High · Status: ⚠️ Needs work · Owner: OPS-owner
Verify:
- Change is the minimum that satisfies scope; no speculative generality.

### □ No opportunistic refactors
Priority: Medium · Status: ⚠️ Needs work · Owner: OPS-owner
Verify:
- Diff contains only release-relevant changes; unrelated refactors split into their own PR.

### □ Dead code removed
Priority: Medium · Status: ⚠️ Needs work · Owner: OPS-owner
Verify:
- No unreachable branches, unused exports, or commented-out blocks introduced. Grep the diff for orphaned helpers.

### □ TODOs reviewed
Priority: Medium · Status: ⚠️ Needs work · Owner: OPS-owner
Verify:
- `grep -rn "TODO\|FIXME" <changed files>`; each is either resolved or ticketed. (Known open: rate-limit TODOs in `totp/setup`, `totp/disable` — track via SECURITY_CHECKLIST.)

### □ No debug logging
Priority: High · Status: ⚠️ Needs work · Owner: OPS-owner
Verify:
- No `console.log` of request bodies, secrets, tokens, or PII. Timing/diagnostic logs (e.g. session-callback ms logs) are intentional and secret-free — confirm they leak nothing sensitive.

### □ No temporary hacks
Priority: High · Status: ⚠️ Needs work · Owner: OPS-owner
Verify:
- No hardcoded bypasses, disabled guards, or `if (dev)` shortcuts reachable in prod.

### □ Naming reviewed
Priority: Low · Status: ⚠️ Needs work · Owner: OPS-owner
Verify:
- New symbols/routes/env vars follow existing conventions.

### □ Documentation updated
Priority: Medium · Status: ⚠️ Needs work · Owner: OPS-owner
Verify:
- File-header docblocks, `docs/*`, and `.env.example` updated for any new behavior or env var.

---

## 3. Database

### □ Migration reviewed
Priority: Critical · Status: ⚠️ Needs work · Owner: OPS-owner
Verify:
- `prisma/migrations/*` diff read line-by-line; no unintended drops/renames; additive-first.

### □ Rollback understood
Priority: Critical · Status: ⚠️ Needs work · Owner: OPS-owner / PO1
Verify:
- Down-path documented (reverse migration or forward-fix); destructive migrations have a backup taken immediately before.

### □ Prisma generate
Priority: High · Status: ⚠️ Needs work · Owner: OPS-owner
Verify:
- `npx prisma generate` runs clean; generated client matches schema; committed lockstep.

### □ No accidental schema drift
Priority: High · Status: ⚠️ Needs work · Owner: OPS-owner
Verify:
- `npx prisma migrate status` shows no drift; schema.prisma matches the latest migration.

### □ No orphaned relations
Priority: High · Status: ⚠️ Needs work · Owner: OPS-owner
Verify:
- New FKs have defined onDelete behavior (Cascade/SetNull) consistent with the deletion pipeline; no dangling references.

### □ Data backfill validated
Priority: High · Status: ⚠️ Needs work · Owner: OPS-owner
Verify:
- Any backfill script run on a copy first; row counts before/after checked; idempotent re-run safe.

### □ Migration tested on existing data
Priority: Critical · Status: ⚠️ Needs work · Owner: OPS-owner / PO1
Verify:
- Migration applied against a clone of production (not an empty DB); app boots and reads/writes correctly afterward.

---

## 4. Testing

### □ tsc clean
Priority: Critical · Status: ⚠️ Needs work · Owner: OPS-owner
Verify:
- `npx tsc --noEmit` exits 0.

### □ lint clean
Priority: High · Status: ⚠️ Needs work · Owner: OPS-owner
Verify:
- `npm run lint` (eslint) exits 0; no new suppressions.

### □ Unit tests passing
Priority: Critical · Status: ⚠️ Needs work · Owner: OPS-owner
Verify:
- Full test suite green (e.g. `lib/*.test.ts`, `lib/spaces/*.test.ts`, `lib/account-deletion/*.test.ts`, golden tests). No skipped tests without a ticket.

### □ New tests added where appropriate
Priority: High · Status: ⚠️ Needs work · Owner: OPS-owner
Verify:
- New logic (esp. auth/authz/visibility/money) has unit coverage; KD-tripwire tests still guard the single path they protect.

### □ Regression testing complete
Priority: High · Status: ⚠️ Needs work · Owner: OPS-owner
Verify:
- Core flows retested: register → verify → login (+TOTP) → space CRUD → Plaid link → export → deactivate/delete.

### □ Manual QA completed
Priority: High · Status: ⚠️ Needs work · Owner: UX / OPS-owner
Verify:
- The shipped feature exercised by hand against a preview deploy, including the unhappy paths.

### □ Edge cases reviewed
Priority: High · Status: ⚠️ Needs work · Owner: OPS-owner
Verify:
- Empty inputs, expired tokens, revoked sessions, deactivated/pending-deletion accounts, concurrent double-submit all behave.

### □ Mobile tested
Priority: Medium · Status: ⚠️ Needs work · Owner: UX
Verify:
- Feature verified at mobile width; no overflow, tap targets adequate, slow-network loading states don't invite duplicate submits.

### □ Desktop tested
Priority: Medium · Status: ⚠️ Needs work · Owner: UX
Verify:
- Verified at desktop width on a current Chromium + one other engine.

---

## 5. Performance

### □ No unnecessary queries
Priority: High · Status: ⚠️ Needs work · Owner: OPS-owner
Verify:
- Query count per request reviewed; reads use `select` field scoping; no query inside a render loop.

### □ No N+1 issues
Priority: High · Status: ⚠️ Needs work · Owner: OPS-owner
Verify:
- List endpoints use `include`/batched queries, not per-row fetches; inspect Prisma query logs on a representative dataset.

### □ Loading states reviewed
Priority: Medium · Status: ⚠️ Needs work · Owner: UX
Verify:
- Every async surface has a loading state; destructive buttons disable while pending (prevents double-fire).

### □ Suspense boundaries reviewed
Priority: Medium · Status: ⚠️ Needs work · Owner: UX / OPS-owner
Verify:
- Server components have sensible Suspense boundaries; no whole-page block on one slow query.

### □ Bundle impact acceptable
Priority: Medium · Status: ⚠️ Needs work · Owner: OPS-owner
Verify:
- New deps justified; check build output size delta; heavy libs are dynamically imported where possible.

### □ Expensive work cached where appropriate
Priority: Medium · Status: ✅ Complete (pattern established) · Owner: OPS-owner
Verify:
- Session revocation cache (30s), FX rates, snapshots reuse existing caching; no re-derivation of stable data per request.

### □ Large datasets tested
Priority: Medium · Status: ⚠️ Needs work · Owner: OPS-owner
Verify:
- Feature tested against a high-volume account (many transactions/holdings); pagination/limits hold; cron `maxDuration` budget respected.

---

## 6. Security

> Do not duplicate `SECURITY_CHECKLIST.md` — reference it. This section is the release-time gate that the security checklist has been consulted.

### □ Security checklist reviewed
Priority: Critical · Status: ⚠️ Needs work · Owner: OPS-owner
Verify:
- Relevant sections of `SECURITY_CHECKLIST.md` walked for this release; no open Critical item in scope.

### □ No new attack surface
Priority: Critical · Status: ⚠️ Needs work · Owner: OPS-owner
Verify:
- New routes/params/uploads/redirects enumerated; each authenticated + authorized; no unauthenticated expensive work.

### □ Rate limits considered
Priority: High · Status: ⚠️ Needs work · Owner: OPS-owner
Verify:
- Any new sensitive/expensive endpoint calls `limitByIp`/`limitByUser`; confirm `RATE_LIMIT_ENABLED=true` in the target env.

### □ Authorization reviewed
Priority: Critical · Status: ⚠️ Needs work · Owner: OPS-owner
Verify:
- New data access goes through `requireUser`/`requireSpaceRole`/`requireSpaceAction`/`requireSystemAdmin`; ownership proven on every `[id]` route (IDOR).

### □ Sensitive routes audited
Priority: High · Status: ⚠️ Needs work · Owner: OPS-owner
Verify:
- Destructive/identity routes use `requireFreshUser`; re-auth prompts present where the pattern requires; sessions revoked on identity change.

### □ Audit events present
Priority: High · Status: ⚠️ Needs work · Owner: OPS-owner
Verify:
- New sensitive actions write an `AuditLog` row with actor, IP/UA, and (for admin actions) `performedByAdminId`.

---

## 7. UX

### □ Copy reviewed
Priority: Medium · Status: ⚠️ Needs work · Owner: UX
Verify:
- Copy matches `fourth-meridian-product-language.md`; destructive-action wording is unambiguous; security messaging accurate (no false "invalid link").

### □ Empty states
Priority: Medium · Status: ⚠️ Needs work · Owner: UX
Verify:
- Zero-data views render intentional empty states, not blank/broken layouts.

### □ Error states
Priority: High · Status: ⚠️ Needs work · Owner: UX
Verify:
- Failures show actionable messages; no raw error strings; no false success on a failed write.

### □ Loading states
Priority: Medium · Status: ⚠️ Needs work · Owner: UX
Verify:
- Async actions show progress; buttons disable while pending.

### □ Mobile layout
Priority: Medium · Status: ⚠️ Needs work · Owner: UX
Verify:
- No horizontal scroll/overlap at mobile width across the changed screens.

### □ Accessibility
Priority: Medium · Status: ⚠️ Needs work · Owner: UX
Verify:
- Labels on inputs, sufficient contrast, focus visible, images have alt text, dialogs trap focus.

### □ Keyboard navigation
Priority: Medium · Status: ⚠️ Needs work · Owner: UX
Verify:
- All interactive elements reachable and operable by keyboard; logical tab order; Esc closes modals.

### □ Dark / light themes
Priority: Low · Status: ⚠️ Needs work · Owner: UX
Verify:
- Changed surfaces render correctly in both themes (`components/theme`); no hardcoded colors.

### □ Visual consistency
Priority: Low · Status: ⚠️ Needs work · Owner: UX
Verify:
- Uses the design system (`components/ui`, `docs/design-system`); spacing/typography consistent with siblings.

---

## 8. Operations

### □ Environment variables documented
Priority: High · Status: ⚠️ Needs work · Owner: PO1
Verify:
- New vars added to `.env.example` with comments AND set in preview/prod; required ones added to `validateEnv()` where appropriate.

### □ Feature flags
Priority: Medium · Status: ⚠️ Needs work · Owner: OPS-owner
Verify:
- New behavior behind a flag if risky; default state documented; flag fails safe (closed) when unset.

### □ Monitoring
Priority: High · Status: ⚠️ Needs work · Owner: PO1
Verify:
- Key metrics observable post-deploy (error rate, auth failures, cron success, latency).

### □ Logging
Priority: Medium · Status: ⚠️ Needs work · Owner: OPS-owner
Verify:
- Enough context to debug an incident; no secrets/PII; consistent `[area]` prefixes.

### □ Alerts
Priority: Medium · Status: ⏳ Future · Owner: PO1
Verify:
- Threshold alerts exist for error spikes, cron failures, auth-failure surges. *(Establish before public beta.)*

### □ Cron implications reviewed
Priority: High · Status: ⚠️ Needs work · Owner: OPS-owner / PO1
Verify:
- Changes to sync/FX/deletion jobs preserve idempotency + resumability; `vercel.json` schedule intact; `CRON_SECRET` still required; `maxDuration` sufficient.

### □ Deployment notes written
Priority: Medium · Status: ⚠️ Needs work · Owner: OPS-owner
Verify:
- Release ticket lists migration order, new env vars, flag flips, and any manual step.

### □ Rollback plan documented
Priority: Critical · Status: ⚠️ Needs work · Owner: PO1
Verify:
- Written revert path: which commit to redeploy, whether the migration is reversible, and data-safety steps. Verified feasible before shipping.

---

## 9. Production Readiness

> This mirrors the deploy walkthrough in `SECURITY_CHECKLIST.md` §11 from a release (not purely security) angle. For a production deploy, complete both.

### □ HTTPS verified
Priority: Critical · Status: ✅ Complete (verify per deploy) · Owner: PO1
Verify:
- Live domain serves https end-to-end; no mixed content in console.

### □ Domains correct
Priority: Critical · Status: ⚠️ Needs work · Owner: PO1
Verify:
- `NEXTAUTH_URL`, `NEXT_PUBLIC_APP_URL`, `PLAID_REDIRECT_URI` all point at the correct production host.

### □ Email provider verified
Priority: High · Status: ⚠️ Needs work · Owner: OPS-1 / PO1
Verify:
- `RESEND_API_KEY` set; sending domain verified; SPF/DKIM/DMARC configured; a test reset + security-alert lands in inbox.

### □ Analytics correct
Priority: Low · Status: ⏳ Future · Owner: PO1
Verify:
- If analytics exist, prod uses the prod project/key; no dev tracking bleed. *(N/A until analytics added.)*

### □ No localhost URLs
Priority: Critical · Status: ⚠️ Needs work · Owner: OPS-owner
Verify:
- `grep -rn "localhost\|127.0.0.1\|http://" <changed files>`; all runtime links come from trusted env base, never a hardcoded/dev URL or request Host.

### □ Build succeeds
Priority: Critical · Status: ⚠️ Needs work · Owner: OPS-owner
Verify:
- `npm run build` succeeds locally AND the Vercel production build is green.

### □ Production environment validated
Priority: Critical · Status: ⚠️ Needs work · Owner: PO1
Verify:
- `validateEnv()` passes; `RATE_LIMIT_ENABLED=true`; `CRON_SECRET` set and jobs firing; `ENCRYPTION_KEY` correct and not shared with lower envs; no seed accounts / default passwords in prod.

---

## 10. Final Go / No-Go

**Release gate — nothing ships with an open Critical or High blocker.**

| Gate | Item | Owner | Cleared? |
|---|---|---|---|
| **Critical blocker** | tsc + build green; unit tests passing | OPS-owner | ☐ |
| **Critical blocker** | Migration reviewed, tested on prod-like data, rollback understood | OPS-owner / PO1 | ☐ |
| **Critical blocker** | No open Critical in `SECURITY_CHECKLIST.md` for this scope | OPS-owner | ☐ |
| **Critical blocker** | Authorization/IDOR reviewed on new routes | OPS-owner | ☐ |
| **Critical blocker** | Production env validated (rate limit, CRON_SECRET, keys, no seeds) | PO1 | ☐ |
| **Critical blocker** | Rollback plan documented and feasible | PO1 | ☐ |
| **High-risk blocker** | Regression + manual QA on core flows complete | OPS-owner / UX | ☐ |
| **High-risk blocker** | New sensitive endpoints rate-limited + audited | OPS-owner | ☐ |
| **High-risk blocker** | Email deliverability verified (prod releases) | OPS-1 / PO1 | ☐ |
| **High-risk blocker** | Cron idempotency/resumability preserved | OPS-owner | ☐ |
| **Recommended before release** | Mobile/desktop + theme checks; error/empty/loading states | UX | ☐ |
| **Recommended before release** | N+1 / large-dataset performance check | OPS-owner | ☐ |
| **Recommended before release** | Monitoring visible; deployment notes written | PO1 | ☐ |
| **Safe after release** | Copy polish, a11y refinements, low-priority naming | UX | ☐ |
| **Safe after release** | Alerts thresholds, analytics wiring | PO1 / Future | ☐ |

**Release approval**

- □ **Release approved**
- Approved by: ________________________
- Date: ________________________
- Version / release name: ________________________
- Git commit (SHA): ________________________
- Environment: ☐ internal ☐ closed beta ☐ public beta ☐ production
- Notes / known-accepted risks: ________________________

---

## 11. Release Maturity

Each level is cumulative — a level is only checked when **all** its criteria (and every lower level's) are met. Use this to state honestly where the product stands.

### ☐ Internal Development
Ship freely to yourself/team.
Criteria:
- tsc + lint + build green; unit tests passing.
- No secrets committed; `.env.local` works.
- Core happy path functional on a preview deploy.

### ☐ Closed Beta Ready
Safe to invite a small, trusted cohort.
Criteria (all of Internal, plus):
- **All `SECURITY_CHECKLIST.md` "Must fix before beta" items resolved** (login rate limiting C2, `RATE_LIMIT_ENABLED` C1, TOTP replay protection H1, security headers H2).
- Regression + manual QA on register→login(+TOTP)→space→Plaid→export→delete.
- Database backups enabled; `CRON_SECRET` set; email deliverability verified.
- Rollback plan documented.
- Section 10 Critical + High blockers cleared.

### ☐ Public Beta Ready
Open to untrusted, unbounded signups.
Criteria (all of Closed Beta, plus):
- Account lockout + `users/search` hardening (M1) live; email-bombing/export caps effective.
- CSP enforcing (not just report-only); full security-header set live.
- Monitoring + alert thresholds active (auth-failure surges, cron failures, error spikes).
- Enumeration hardening decision made (M4); Plaid per-user limits (M3).
- Load/large-dataset performance verified; no known N+1 on hot paths.
- Formal security review / light pen-test completed.

### ☐ Production Ready
Real users' real money-adjacent data, general availability.
Criteria (all of Public Beta, plus):
- Restore test completed and documented (RTO/RPO recorded).
- `SECURITY_CHECKLIST.md` §11 deploy checklist fully green.
- Incident-response playbook exists (revoke sessions, disable admin, rotate keys).
- Admin de-privileging propagation addressed (H3); admin least-privilege review (OPS-5).
- `npm audit` clean of High/Critical; dependency review cadence established.
- SLOs defined; on-call/monitoring ownership assigned.

### ☐ Enterprise Ready
Organizations, compliance expectations, contractual guarantees.
Criteria (all of Production, plus):
- Key-rotation runbook exercised (OPS-4); per-tenant data isolation reviewed.
- Audit-retention + data-retention policy formalized and enforced.
- Third-party penetration test passed; findings remediated.
- SSO/role-model review; admin impersonation controls and audit trail.
- DPA / compliance posture (SOC2-style controls, data residency) documented.
- Disaster-recovery drill completed end-to-end.

---

*Living document. Use alongside `SECURITY_CHECKLIST.md` before every gate. Documentation only — no code, schema, or STATUS changes. Reset per-release Status marks each cycle; update criteria as the product and process mature.*
