# Agent A — Security & Privacy · Wave 1 report

Branch `remediation/a-security` · worktree `FourthMeridian-remediation/a` · baseline `cde8fa0` · 2026-10-22.
Nothing pushed or merged. No live database, no provider keys, no `.env*` file was used. No throwaway Postgres was needed: every test runs on in-memory fakes or source scans.

**Verification at HEAD:** see the final section (typecheck / lint / test:unit counts).

## Summary

| Finding | Status | Commit |
|---|---|---|
| SEC-001 TOTP page-gate bypass | RESOLVED | `e151e0e` |
| SEC-006 admin 2FA reset without step-up | RESOLVED | `c6f867e` |
| ARCH-003 / CQ-004 three IP extractors | RESOLVED (code); prod edge topology still an owner question | `ecf3581` |
| ARCH-004 / OPS-003 withApiHandler 500s unobserved | RESOLVED | `c6af787` |
| SEC-008 registration default `open` | RESOLVED (code); **operator act needed** | `aa50094` |
| PRIV-002 / UI-013 raw e-mail in AuditLog.metadata | RESOLVED for new writes; historical rows untouched | `fa5d401` (+ `c6f867e` for 2fa-reset) |
| SEC-004 CSV formula injection | RESOLVED | `55b0b5c` |
| SEC-005 user-directory enumeration | RESOLVED (server); client floor is a follow-up | `d783746` |
| PRIV-011 no third-party AI disclosure | RESOLVED | `a667708` |
| PRIV-015 Sentry breadcrumbs unscrubbed | RESOLVED | `4adc094` |
| SEC-009 non-constant-time CRON_SECRET | PARTIAL: helper shipped, **adoption owed by C** | `8369a8c` |
| PRIV-010 legal page understates fields | RESOLVED as draft copy, **pending counsel review** | `7102cc6`, `8d5856d` (flagged) |
| PRIV-012 waitlist notice + consent | RESOLVED (notice + consent half) | `3d65608` (flagged), `26308c7` |
| SEC-010 no idle/absolute session lifetime | RESOLVED | `3f636f5` |
| SEC-013 raw `e.message` (merchant-ops/decide) | DEFERRED: not owned | — |
| UI-004 permanent Space delete on cached auth | RESOLVED | `51b5c56` |
| UI-005 no limits on invite / correct | RESOLVED | `c7444cf` |
| UI-022 unbounded admin reads | RESOLVED | `1e9a89b` |

Two commits touch paths outside A's ownership. Both are marked `(OUT-OF-OWNERSHIP, flagged)` in the subject and explained under "Ownership exceptions" below.

---

## Per finding

### SEC-001 — RESOLVED · `e151e0e`
**Root cause.** The jwt callback copied `session.requireTotpSetup` from the client-chosen `update` payload onto the token. `proxy.ts` trusted the token. `app/admin/layout.tsx`, `app/admin/page.tsx` and `app/(shell)/dashboard/layout.tsx` checked session + role only and never the DB-derived `session.requireTotpSetup`.

**Change.**
- `lib/auth/token-update.ts` is a pure allow-list. A client update may set only `username`; everything else (`requireTotpSetup`, `role`, `id`, …) is dropped.
- `lib/auth.ts`: on `trigger === "update"` the hint is **re-derived from the session store** (`rederiveTotpHint`: same row, same `factsFromRow`, cache refreshed). It fails closed: a missing row or store error leaves the hint unchanged. TotpSection's post-enrolment `update()` still clears the hint, but only because the store now says the user is enrolled.
- `lib/auth/page-gate.ts` (pure decision) and `lib/auth/totp-page-gate.ts` (server wrapper). A pending session renders only its role's enrolment surface. The path comes from the proxy-stamped `RETURN_TO_HEADER` via `validateReturnTo`. An unknown path means redirect (fail closed).
- All three server components call `enforceTotpPageGate(session)` after their session/role guards. `app/admin/page.tsx` also calls it before its inventory queries, because layouts and pages render concurrently.

**Tests.**
- `lib/auth/token-update.test.ts` drives the **real NextAuth handler** with the exact runtime reproduction: `GET /api/auth/csrf`, then `POST /api/auth/session {data:{requireTotpSetup:false}}`. It proves the re-issued token and served session stay pending, that injected `role`/`id` never reach the token, that real enrolment still clears the hint, and that a store outage leaves it unchanged.
- `lib/auth/page-gate.test.ts` covers the decision table (pending admin on `/admin` and `/admin/providers` redirects; the surface renders; lookalike prefix, wrong-role surface and unknown path all redirect). It pins the wiring in all three files, the order before `db.user.findMany`, and parity with proxy.ts's allow-list.
- The API gate is unchanged and still 403s. The token-update test asserts the served session stays `requireTotpSetup: true`, which is what `lib/session.ts` gates on, and the existing `admin-totp-enrollment-surface` and `session-proof` suites still pass.

**Residual risk.** The token hint is still what `proxy.ts` uses for navigation. It is now only ever store-derived, and the page gate is the authority. The `USER` variant (`require_totp_all_users`) is covered by the same gate.

### SEC-006 — RESOLVED · `c6f867e`
**Root cause.** `adminTotpCode` was read and never verified (the check was commented out), and SYSTEM_ADMIN targets were accepted.

**Change.**
- `lib/auth/admin-2fa-reset-policy.ts` is a pure rule. In order: SELF, CONFIRM_TOKEN, TARGET_IS_SYSTEM_ADMIN, ACTOR_NOT_ENROLLED, TOTP_CODE_MISSING/INVALID. The code is checked with `verifyTOTP` against the actor's decrypted secret, window 1, as login does.
- In the route:
  - `limitByUser(actor, 5/15 min)` bounds code guesses.
  - The decision runs before the transaction.
  - All of the target's sessions are revoked after the reset.
  - The target is notified via the `security-alert` e-mail (non-throwing).
  - The audit row carries `targetEmailHash` instead of the raw address.

**Test.** `lib/auth/admin-2fa-reset-policy.test.ts` uses real TOTP codes (wrong code, other secret, whitespace, missing, admin target, self, order) and pins the route wiring.

**Residual.** There is no second-approver flow. A peer admin's 2FA simply cannot be reset here; that needs DB/break-glass, as before.

### ARCH-003 / CQ-004 — RESOLVED (code) · `ecf3581`
**Root cause.** The limiter keyed on the **first** XFF entry (client-chosen). Audit and `authorize()` trusted `cf-connecting-ip` first, which is client-writable without Cloudflare.

**Change.** `lib/security/client-ip.ts` is the single extractor. Trust order:
1. `cf-connecting-ip`, only if `CLIENT_IP_TRUST_CLOUDFLARE=true` (off by default).
2. `x-vercel-forwarded-for`.
3. `x-real-ip`.
4. `x-forwarded-for`, **last** entry.
5. `"unknown"`, a single shared bucket.

Candidates are shape-checked. `limitByIp`/`checkIpLimitStrict`, `getRequestMeta` and `authorize()` all delegate to it.

**Tests.** `lib/security/client-ip.test.ts` covers spoofed XFF combined with platform headers, cf default-off, garbage rejection, and the plain-object header form. It also runs a census that no other production file reads an IP header. The `lib/rate-limit.test.ts` pin was **updated to the new truth** ("last hop wins" replaces "first hop wins", which was the spoofable key).

**Residual / owner.** Production edge topology is still unconfirmed: does Vercel overwrite XFF, and is Cloudflare in front? If Cloudflare fronts every request, set `CLIENT_IP_TRUST_CLOUDFLARE=true`. That env var is not registered in `lib/env.ts`, which A does not own.

### ARCH-004 / OPS-003 — RESOLVED · `c6af787`
**Change.**
- `lib/monitoring/capture.ts`: `buildApiHandlerFailureCapture` (tags-only: `area=api-handler`, static route label) and `captureApiHandlerFailure` (never throws).
- `withApiHandler` captures through an injectable `deps.capture` before building the generic 500. A throwing capture is contained.

**Test.** `lib/api.test.ts` runs the real wrapper with an injected capture: one capture per 500, none on success, and a throwing capture is contained. It also checks the default seam and its payload shape.

### SEC-008 — RESOLVED (code) · `aa50094`
**Change.** `DEFAULT_REGISTRATION_MODE = "invite_only"`. Both the DEFAULTS entry and `getRegistrationMode()`'s absent/unrecognised fallback use it. An explicit `open` row is honoured.

**Test.** `lib/registration-default.test.ts` runs the real reader and policy with the setting faked (null, typo, blank, open, closed). It shows a fresh DB gates the form, and pins the register route's 403 (no invite) before any write.

**OPERATOR ACTION.** Preview and Production are **invite_only from this commit** unless the row is written. If open registration is wanted:
`npx tsx scripts/set-platform-setting.ts --key registration_mode --value open --apply`
Add this line to the cutover runbook (F/orchestrator). CAPTCHA (Turnstile keys) is still an owner item.

### PRIV-002 / UI-013 — RESOLVED for new writes · `fa5d401`
**Change.** forgot-password, reset-password, growth-revenue approve / deny / resend / revoke and cold invitations now write `emailHash: auditEmailHash(...)`. Admin 2FA-reset was converted in `c6f867e`.

**Test.** `lib/audit-email-hash.test.ts` checks the digest's properties, pins every path, and runs a census over every `app/api` route that no `auditLog.create` metadata carries a raw address. The census needle is proven on a counterexample.

**Residual.**
- **Historical rows** still contain raw addresses. A scrub/backfill belongs to C's purge/retention work.
- UI-013's other half (moving growth mutations onto the `recordOperatorAction` envelope) was not done. It is a behavioural change to operator feeds and should get its own slice.

### SEC-004 — RESOLVED · `55b0b5c`
All four export sets go through one `unparse()` helper with `escapeFormulae: true`.

**Test.** The `lib/export/csv.test.ts` injection block covers `=RTVINJECT()`, `+cmd`, `@SUM`, `=HYPERLINK` and `-2+3`. It checks negative amounts are untouched, the parser round-trip, and that no bare `Papa.unparse` remains.

### SEC-005 — RESOLVED (server) · `d783746`
**Change.** `parseSearchTerm`: `@handle` means an exact case-insensitive username match; otherwise a substring needs ≥3 characters; shorter returns `[]`. There is also a `limitByUser` of 60/h before any read. The `member:invite` gate on `exclude` is unchanged.

**Tests.** `app/api/users/search/search-term.test.ts` is new. The existing `route.test.ts` still passes.

**Follow-up (UI owner).** `components/space/manage/UserSearchInput.tsx` still fires from one character. Results simply stay empty until the third character. A client floor would save requests.

### PRIV-011 — RESOLVED · `a667708`
**Change.** `AI_THIRD_PARTY_LINE` is one sentence: conversation input and the data used for answers and the Daily Brief "is sent to OpenAI (a third-party provider) for processing". It is in the About panel, and the always-visible line now ends "· Processed by OpenAI".

**Test.** `components/ai/ai-disclosure-third-party.test.ts` is a render test. `components/ai/ai.test.ts` still passes.

### PRIV-015 — RESOLVED · `4adc094`
**Change.** `scrubBreadcrumb` is wired as `beforeBreadcrumb`. It drops console breadcrumbs, strips query and fragment from `data.url`/`to`/`from` and from messages, and removes payload keys.

**Test.** `lib/monitoring/sentry-options.test.ts` §6.

**Residual.** `app/api/plaid/link-token` still logs raw `plaid_error_data`. That path is not owned by A (owned by G for comments only). Recommend D/E fix it.

### SEC-009 — PARTIAL · `8369a8c`
**Change.** `lib/security/cron-secret.ts` adds `timingSafeStringEqual` (sha256 to a fixed width, then `timingSafeEqual`) and `verifyCronAuthorization(header, secret)`, which returns `AUTHORIZED|SECRET_UNSET|MISSING|MISMATCH`.

**Test.** `lib/security/cron-secret.test.ts`.

**Agent C must adopt it** in every `app/api/jobs/**` route that compares with `!==`, e.g. `app/api/jobs/dispatch/route.ts:54` and `app/api/jobs/fetch-security-prices/route.ts:32`:
`if (verifyCronAuthorization(req.headers.get("authorization"), process.env.CRON_SECRET) !== "AUTHORIZED") return 401`.

### PRIV-010 — RESOLVED as draft copy, pending counsel · `7102cc6` + `8d5856d` (flagged)
**Change.**
- `content/marketing/legal-ai.md` "What is shared with the model provider" now enumerates questions and prior turns, Space name, member first names, account display name / institution / mask (generic names at balance-only level), balances / APR / minimums, transaction date / merchant / raw description / amount / category / pending / posting account / counterparty account, holdings and history, and memory.
- An HTML comment marks it **PENDING COUNSEL REVIEW** with the code sources (`lib/ai/conversation/tools.ts` ~L829, `lib/ai/assemblers/accounts.ts` L775-804).
- `components/marketing/LegalDocument.tsx` gains `skipHtml`. Rendering verified that react-markdown otherwise prints the comment as visible text.

**Truth dependency.** "(with long runs of digits removed)" is true for conversations only once Agent D's SEC-AI-005 scrub lands. Today only the Brief scrubs. Drop the parenthetical if D's fix does not ship with this copy.

### PRIV-012 (notice + consent) — RESOLVED · `3d65608` (flagged) + `26308c7`
**Change.**
- `components/marketing/access-request-consent.ts` holds the notice text, consent label, notice version and refusal text. It sits inside the marketing seam, so the form and server share it.
- `RequestAccessForm`: the notice, a Privacy Policy link, and a **required, unticked** checkbox. The client refuses to submit without it.
- `POST /api/access-request`: `consent` must be strictly `true`, otherwise 400 **before anything is stored or e-mailed**. The audit row records `consentNoticeVersion`.

**Test.** `components/marketing/access-request-consent.test.ts` renders the real form and calls the **real POST handler** with a faked DB. Consent absent, `false`, `"true"` or `1` returns 400 and writes nothing. `true` returns 200, writes all three rows, and records the notice version with no raw e-mail.

**Not A's.** Retention and purge on deletion belong to C. Restricting or stopping the operator e-mail of the applicant's note is undecided and should go to the owner.

### SEC-010 — RESOLVED · `3f636f5`
**Change.**
- `SESSION_ROW_SELECT` adds `createdAt` and `lastActiveAt` (no schema change).
- `judgeSessionLifetime` (pure, injectable clock and limits) and `factsFromRow` refuse a row idle for more than 30 days, older than 90 days, or missing a timestamp. This happens before the TOTP setting read. Both the session callback and `recheckSessionLive` inherit it, and propagation is bounded by the 30 s cache.

**Tests.** `lib/auth/session-lifetime.test.ts` uses fixed clocks. In `lib/auth/session-proof.test.ts`, the fake store now gives fixture rows fresh timestamps by default, and the pure edge cases carry explicit ones so each still tests its own condition. This is a pin update, noted in the commit.

**Residual.** Limits are code constants, not PlatformSettings. When a session expires the user simply has to sign in again; there is no in-app expired-session message.

### SEC-013 — DEFERRED
`app/api/merchant-ops/decide/route.ts` returns raw `e.message` at 422 and 409 (runtime-confirmed on 422). It is **not in A's owned paths**, and no agent owns it in Wave 1. Fix: map `MergeReviewIneligibleError` to a fixed message and return a generic 409 for anything else. `spaces/[id]/wealth/amend` is dead behind its 503 gate and was skipped as instructed.

### UI-004 — RESOLVED · `51b5c56`
`requireFreshUser()` now runs before `requireSpaceRole(..., OWNER)` and the delete. Pinned by `lib/security/ui-004-permanent-delete.test.ts`.

### UI-005 — RESOLVED · `c7444cf`
- Invite POST: `limitByUser(..., "space-invite", 20/h)`, after the role gate and before `sendEmail`.
- Correct: `limitByUser(..., "transaction-correct", 60/h)`, before the body parse.

Pinned by `lib/security/ui-005-mutation-limits.test.ts`.

### UI-022 — RESOLVED · `1e9a89b`
- Overview: `take: 25` for users and Spaces, with stat cards switched to `count()`.
- `/api/admin/{users,spaces}`: `take: 201`, and the response returns an additive `truncated` flag.

Pinned by `lib/security/ui-022-admin-bounds.test.ts`.

**Follow-up.** The admin list clients do not yet show "showing first 200 — refine search".

---

## Ownership exceptions (flagged commits; the orchestrator may drop them)
1. **`8d5856d`** — `site/content/legal/legal-ai.md` and `site/components/LegalDocument.tsx`. `lib/public-site-boundary.test.ts` pins the app and site legal copy **byte-identical**, so folding PRIV-010 into `legal-ai.md` (as the coordinator instructed) turns the suite red unless `site/` is mirrored. The site renderer also needed `skipHtml`, or the counsel comment would show publicly. `site/` is owned by no Wave-1 agent.
2. **`3d65608`** — `lib/marketing/request-access.ts` and its test. The only client of `/api/access-request` builds the body from fixed fields, so without this the consent flag cannot reach the server, and requiring it would break every waitlist submission. `lib/marketing/**` is owned by no agent. It **must land together with `26308c7`**.

## Pins updated to a new truth (stated in the commit messages)
- `lib/rate-limit.test.ts` §5: "x-forwarded-for first hop wins" became "LAST hop wins", plus a rotation check.
- `lib/auth/session-proof.test.ts`: fixtures carry `createdAt` and `lastActiveAt`.
- `lib/export/csv.test.ts`, `lib/monitoring/sentry-options.test.ts`, `lib/marketing/request-access.test.ts`: additive blocks only.

## Requests to other agents / owner
- **C:** adopt `verifyCronAuthorization` in every `app/api/jobs/**` cron check (SEC-009). Scrub historical raw e-mails in `AuditLog.metadata` for the actions above (PRIV-002). PRIV-012 retention and purge.
- **D:** SEC-AI-005 conversation-description scrub must ship for the PRIV-010 copy to be literally true. `app/api/plaid/link-token` raw `plaid_error_data` log (PRIV-015 residual; ownership unclear).
- **F / orchestrator:** cutover runbook line for `registration_mode` (SEC-008). Decide on registering `CLIENT_IP_TRUST_CLOUDFLARE` in `lib/env.ts`.
- **UI owner (wave 2 I):** 3-character floor in `UserSearchInput.tsx`; "truncated" hint in the admin Users/Spaces lists.
- **Owner:** confirm the Production edge (Vercel-direct vs Cloudflare) for ARCH-003. Counsel review of the PRIV-010 paragraph and PRIV-012 notice text. Whether the operator intake e-mail should keep forwarding the applicant's note. SEC-013 has no Wave-1 owner.

## Verification
See the final message for exact counts. All runs used Node 24.21.0 in this worktree.
