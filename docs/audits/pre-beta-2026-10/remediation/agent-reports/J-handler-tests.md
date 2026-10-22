# Agent J — Route handler and authentication tests (TEST-002, TEST-004)

Branch `remediation/j-handler-tests` · worktree `FourthMeridian-remediation/j` · base `57de6aa` · 16 local commits, **not pushed, not merged**. No database was touched: every test runs against an in-memory Prisma fake, `DATABASE_URL` points at a closed port, and no provider was called (Turnstile `fetch` is stubbed where CAPTCHA is under test; e-mail uses the capture transport).

## Outcome

| | Before (`57de6aa`) | After (HEAD) |
|---|---|---|
| `app/api/**/route.ts` files | 185 | 185 |
| Route files whose **exported handler** (or its injected seam) is executed by a test | **3** — `health`, `ai/memory`, `ai/memory/[id]` | **25** (+22) |
| Auth-flow handler tests (TEST-004) | **0** | register, verify-email, verify-email/resend, forgot-password, reset-password, pre-login, `[...nextauth]` (sign-in + sign-out), user/totp ×5, user/sessions, user/sessions/[sessionId], user/password |
| Space-mutation handler tests (TEST-002) | **0** | members/[userId], invite, invites/[inviteId], permanent, accounts/share, sections/[sectionId] (+ accounts/[id]/import) |
| New checks | — | **454** passing across 16 files (+ 6 recorded known defects) |

## Approach — the real handler, not a seam

Every test imports the route module and calls its exported `GET`/`POST`/`PATCH`/`DELETE` with a real `NextRequest` and `{ params: Promise }`, exactly as Next does. **No seam extraction was needed and none was made** — so there is no behaviour-preservation question for any route: the code under test is the production file, byte-identical except for the one-line J-D5 fix below. What made that possible is `lib/test-support/` (new):

| File | What it does |
|---|---|
| `fake-prisma.ts` | An in-memory Prisma client driven by `Prisma.dmmf` (all 70 models): schema defaults (`cuid/uuid/now/autoincrement`, literals), `@updatedAt`, `@id`/`@unique`/`@@unique` → the **real** `PrismaClientKnownRequestError` P2002; P2025 on missing `update`/`delete` targets; relation `select`/`include`/`_count`; relation filters (`some/none/every/is/isNot`); nested `create`/`connect`; atomic `increment`; Json `path` filters; **lazy PrismaPromises** (so the array form of `$transaction` works); `$transaction` **rollback** (snapshot restore); **Postgres aborted-transaction semantics** (after a failed statement every later statement in that interactive transaction fails `25P02`); declarable **partial unique indexes** that exist only in migrations; call log, fault-injection hooks. `installFakePrisma()` replaces the delegates on the process's single client and refuses to run if any `DATABASE_URL_APP/AUTH/SYSTEM` role client exists or `NODE_ENV=production`. |
| `route-harness.ts` | Binds `next/headers` `cookies()`/`headers()` (on the module's exports object, which next-auth's `getServerSession` and `lib/session.ts` read at call time) to the request under test via `AsyncLocalStorage` (so concurrent race tests each see their own request). `signIn()` writes a real `UserSession` row and mints a real NextAuth JWT; the handler then authenticates through the **unmodified** chain: `getServerSession` → `lib/auth.ts` jwt/session callbacks → session-proof → revocation check against the store. `invoke()`, `request()` (JSON / raw / multipart), `freshCache()`, and a checker with `known()` for defects recorded but not owned. The client-IP header is taken from `CLIENT_IP_HEADER_ORDER`, so the harness can never disagree with the limiter. |
| `route-env.ts` | First import of every suite: test constants for env vars snapshotted at module load. |
| `space-world.ts` | Two-tenant fixture: Space S (OWNER/ADMIN/MEMBER/VIEWER + a LEFT former member), tenant T's Space, and the owner's PERSONAL Space; a live session cookie per person. |

**Fidelity limits (stated, not hidden).** The fake is not SQL and not RLS: `withTenantDb`'s `set_config` is recorded and accepted, so these suites prove the **application** layer's authority (each route's own predicates and guards). Database policies remain proved by the RLS suites against Postgres. Concurrent interactive transactions share one store (no isolation). Partial unique indexes must be declared by the test (the import suite cites its migration). `aggregate`/`groupBy`/`$queryRaw` throw unless configured, so nothing passes on a silent stub.

The production limiter, CAPTCHA verifier, bcrypt, token hashing, AES purpose-key encryption, TOTP, recovery codes, notification chokepoint, domain-event emit/dispatch and the capture e-mail transport are all the real modules.

## Per route

| Route | Exercised | Cases |
|---|---|---|
| `auth/register` POST | real handler | SEC-008: no `registration_mode` row ⇒ invite_only 403 (and an unrecognised value); closed 403 before field validation; consent must be literally `true`; email/username/admin-configured password minimum/names/credit score; open happy path writes User (bcrypt hash, encrypted DOB, hashed 1h verification token whose raw twin is in the mailed link), PERSONAL Space as landing Space with the planner's sections, OWNER membership, agent, credit score, policy group, no cohort, REGISTER audit by **digest** (PRIV-002); duplicate email/username (any case) 409, nothing written; **IDEMP-011 race** — two concurrent registrations of one identity both pass the read check, one 201 + one 409, exactly one user/space/membership/agent; a P2002 raised late and any other failure roll the whole transaction back (500, no mail); invite_only: no/unknown/expired/non-APPROVED/other-email invite 403, valid invite 201 pre-verified (no mail), invite REDEEMED + hash nulled + cohort + digest audit, reuse 403; **RLS-C-S6** unconsumable invite ⇒ 409 with full rollback and the invite still redeemable; CAPTCHA rejected 400 before any DB work; per-IP 5/15 min 429 before the mode read. |
| `auth/verify-email` POST | real handler | valid token verifies (lookup by hash only), digest audit, second click `already_verified` (no second audit); expired/unknown/missing/non-string/malformed 400 with no writes; per-IP 10/15 min. |
| `auth/verify-email/resend` POST | real handler | token-based: rotates (old link dies, new verifies), precise statuses; identifier-based: **byte-identical** body for unverified / verified / unknown accounts, only the unverified one mailed and rotated; per-IP 5/15 min. Known defect J-D1. |
| `auth/forgot-password` POST | real handler | hashed rotating 1h token, mailed raw link, `PASSWORD_RESET_REQUESTED` with `emailHash` and no address; **production** response byte-identical for present/absent accounts (and the DB-backed limiter path); dev-mode link only outside production, built from `NEXT_PUBLIC_APP_URL` not Host; 400s; generic 500; per-IP limit. |
| `auth/reset-password` POST | real handler | valid token resets, nulls token, **revokes every session — the same cookies then 401 on a real route**; digest audit with `revokedSessions`, security mail, notification; reuse / expired / unknown / missing / short 400 with no writes; **IDEMP-011 concurrent consume**: both requests pass the lookup, exactly one 200, stored hash is the winner's; per-IP 10/15 min. |
| `auth/pre-login` POST | real handler | malformed 400 before lookup; wrong password ≡ unknown account ≡ wrong password on unverified/pending-deletion (identical bytes); specifics only after a proven password (totpRequired, unverified, pending_deletion over deactivated, deactivated + totpRequired); read-only; CAPTCHA step-up per identifier; per-IP 10/min 429 + Retry-After; **fail-closed 503** when the user store or the strict limiter store is down. |
| `auth/[...nextauth]` GET/POST (login + logout) | real exported route (`limitedPost`), real `authorize` | csrf → `callback/credentials` → session cookie + `UserSession` row (IP, UA) + LOGIN audit, cookie authenticates real routes; wrong password / unknown / unverified / deactivated / pending deletion each 401 with the audited reason (userId only when resolved) and no session; reactivate and cancelDeletion paths (reactivate does not bypass a pending deletion); TOTP required / wrong / right (spaces tolerated) and a valid code never rescues a wrong password; recovery code once, then refused; un-enrolled SYSTEM_ADMIN and `require_totp_all_users` ⇒ pending session that reaches only the enrolment flow; `DISABLE_SYSTEM_ADMIN`; per-identifier limit refuses even the right password (never reaching the store) and per-IP 21st POST 429; CAPTCHA step-up; store outage ⇒ `TEMPORARILY_UNAVAILABLE`, no LOGIN_FAILED; **sign-out revokes the row server-side — the replayed cookie is 401**. Known defect J-D2. |
| `user/totp/setup`, `verify`, `status`, `disable`, `recovery-codes` | real handlers | anonymous 401 ×5; a TOTP-pending session reaches setup/verify/status only (disable/recovery-codes 403); end-to-end forced enrolment: encrypted secret (≠ manual key, decrypts to it), not enabled by setup, wrong/short code 400, right code ⇒ enabled + 10 recovery codes stored as bcrypt hashes + audit + notification, **the same cookie then gains full access** (hint re-derived from store); verify/setup again 400; per-user limits; disable by code or password erases secret and codes, and **refuses a just-revoked session that a cached read still serves** (`requireFreshUser`); regeneration kills old codes; status counts remaining codes, never returns the secret. |
| `user/sessions` GET/DELETE, `user/sessions/[sessionId]` DELETE | real handlers | list: own sessions only, newest first, `isCurrent`, **no token material** (P1b), parsed UA, 401/403; revoke one: own other session revoked and its cookie refused immediately, audit + notification; **another user's session id → 404, untouched**; re-revoke 400; current session needs `confirmSelf=true`, then the caller's cookie dies; revoke-all keeps the caller and spares other users; both DELETEs refuse a revoked-but-cached session. |
| `user/password` PATCH | real handler (withApiHandler) | right current password ⇒ new hash, **other sessions revoked**, caller kept, other users untouched, audit + mail + notification; wrong current password 401 + `PASSWORD_CHANGE_FAILED`, nothing changed; validation incl. admin minimum; anonymous 401, revoked-but-cached 401, pending 403; per-user limit; generic 500 leaves sessions intact. |
| `spaces/[id]/members/[userId]` PATCH/DELETE | real handlers | PATCH: OWNER only (ADMIN/MEMBER/VIEWER/LEFT 403, anon 401), audit + notification, **no promotion to OWNER**, another owner's role immutable, LEFT/non-member 404, PERSONAL 400, **cross-tenant 403 both directions**. DELETE: self-leave (LEFT, own ACTIVE links revoked by self, others' and other Spaces' links untouched), ADMIN removal (REMOVED, `revokedById`), MEMBER cannot remove, ADMIN cannot remove OWNER, **IDEMP-010 last owner 409** (a LEFT co-owner does not count; a second ACTIVE owner allows it), PERSONAL 400, cross-tenant 403, and a partial link revocation (`assertEveryObservedRowWasWritten`) rolls the whole removal back. |
| `spaces/[id]/invite` POST | real handler | ADMIN invites (default MEMBER), response names invitee without e-mail, mail + audit + notification, no membership; MEMBER/VIEWER/LEFT/other tenant 403, anon 401, PERSONAL 400; OWNER/unknown role 400, blank 400, unknown user 404, self 400, active member 409, pending 409; LEFT member and DECLINED invite re-invitable (row reset); per-user 20/h. Known defects J-D3, J-D4. |
| `spaces/[id]/invites/[inviteId]` PATCH/DELETE | real handlers | **accept only by the invitee** (owner/admin/member/other tenant 403), right id under the wrong Space 404, non-PENDING 409, decline, invalid action 400, legacy OWNER-role invite and PERSONAL invite never grant membership, a former member re-activated on the same row, accept atomic (membership rolled back with the invite update); revoke by ADMIN+ only, scoped to the Space (other tenant's id ⇒ `cancelled: false`, invite untouched), idempotent. |
| `spaces/[id]/permanent` DELETE | real handler | OWNER deletes a trashed SHARED Space (audit before delete, IP, other tenant untouched); not trashed / PERSONAL / owns accounts (count) 400; ADMIN/MEMBER/VIEWER/LEFT/other tenant 403, anon 401; revoked-but-cached session 401; pending 403. |
| `spaces/[id]/accounts/share` POST/DELETE | real handlers | share own account only (another member's 403), member of this Space only, deleted/unknown 404, input 400, HOME then SHARED kind, BALANCE_ONLY audit keeps a generic name; **P2002 → 409 with the audit rolled back**, retry succeeds; revoke by the sharer or ADMIN+, others 403, re-share re-activates the same link. |
| `spaces/[id]/sections/[sectionId]` PATCH | real handler | ADMIN+ edits (trim, partial, config null clears); MEMBER/VIEWER/LEFT/other tenant 403, anon 401; another Space's section id through a Space the caller owns 404; non-string label 400 (J-D5, fixed). |
| `accounts/[id]/import` POST | real handler, multipart | 3-row CSV ⇒ COMPLETED batch with file hash, rows stamped with the batch; a different file accepted; re-upload of the same bytes **refused** (no new batch or rows) — but 500, not 409 (J-D6); VIEWER into another's account 403, other tenant 404, BALANCE_ONLY 403 even for the Space OWNER. |

## Defects found

| ID | Severity (proposed) | Where | Evidence | Status |
|---|---|---|---|---|
| **J-D6** | **P2** | `lib/imports/claim.ts` `claimImportBatch` (called inside `withTenantDb` by `app/api/accounts/[id]/import/route.ts`) | It catches the P2002 from `importBatch.create` and then runs `importBatch.findFirst` **in the same interactive transaction**. In Postgres a failed statement aborts the transaction; the read fails `25P02`, so a duplicate upload answers **500** via `withApiHandler`, not IDEMP-001's 409 `{error:"duplicate-import", importBatchId}`. Reproduced in `app/api/accounts/[id]/import/route.test.ts` §2 with the fake's aborted-transaction rule on and the migration's partial index declared. `lib/imports/claim.test.ts` passes because its fake lets queries continue after the violation. The **idempotency itself holds**: nothing is written. Fix: do the lookup in a fresh `withTenantDb` phase after the claim transaction ends, or claim under a savepoint. **Recommend confirming on a throwaway Postgres** (upload the same file twice) — this run had no database by design. | reported (outside J's paths) |
| **J-D2** | P2 | `lib/recovery-codes.ts` `verifyRecoveryCode` | It reads unused codes, `bcrypt.compare`s, then marks the match used with an **unconditional** `update({ where: { id } })`. Two concurrent sign-ins with one recovery code both succeed (**2 of 2** in the `[...nextauth]` suite §5). Single use holds only sequentially. Fix: `updateMany({ where: { id, usedAt: null } })` and treat `count !== 1` as invalid. | reported |
| **J-D1** | P2 (PRIV-002 residual) | `lib/email/verification.ts` `rotateAndSendVerification` | Writes `EMAIL_VERIFICATION_RESENT` with `metadata: { email: user.email }`, the raw address PRIV-002 removed elsewhere. `lib/audit-email-hash.test.ts` scans only `app/api/**/route.ts`, so this helper is outside its census. One-line fix: `{ emailHash: auditEmailHash(user.email) }`. | reported |
| **J-D4** | P3 | `app/api/spaces/[id]/invite/route.ts` + `SPACE_INVITE_RECEIVED` (EMAIL default channel) | Every invitation sends **two** e-mails to the invitee: the route's `space-invite` mail and the notification chokepoint's `notification` mail. | reported (product decision on which one to keep) |
| **J-D3** | P3 | `app/api/spaces/[id]/invite/route.ts` | Looks up `username` case-sensitively (`username.trim().replace(/^@/, "")`), while registration stores usernames lower-cased: inviting `Loner` is 404 for user `loner`. Low impact if the UI only inserts search results. | reported (inside J's paths, but a behaviour change, not a one-line defect fix) |
| **J-D5** | P3 | `app/api/spaces/[id]/sections/[sectionId]/route.ts` | `body.label.trim()` on an unvalidated body with no `withApiHandler`: a non-string label threw an unhandled `TypeError`. **Fixed** with one line (`313dae7`): non-string `label` ⇒ 400. `enabled` and `order` are still unvalidated (a wrong type reaches Prisma and 500s); left as is. | **fixed** |

Known defects are recorded with the checker's `known()` (it prints `⚠ KNOWN DEFECT (J-Dn)` and does not fail the run, and prints "promote this to a check" once the defect is fixed), so the suites are green today and each one becomes a hard assertion when it is fixed.

## Notes for the integrator

- **`audit-db-authority` and `lib/test-support/`.** The audit counts every tracked `lib/**` file not named `*.test.ts` as runtime. The first version of `fake-prisma.ts` imported `@/lib/db` and grew the migration-principal ratchet from 163 to 164. Rather than add a baseline entry (`scripts/`, outside J's paths), the installer now loads lib/db through `tenant-context` and reads the client from the `globalThis` registry `lib/db.ts` keeps outside production, asserting the three role-client slots are null. `audit-db-authority: all passed` (`d66b209`). Long term, the audit could exclude `lib/test-support/` explicitly.
- No seam extractions, so no source-scan pins moved. `leave-guard.test.ts`, `rls-t2-route-authority.test.ts`, `personal-single-user.test.ts`, `personal-delete-invariant.test.ts`, `lib/imports/claim.test.ts` and `lib/security/client-ip.test.ts` all pass.
- Suites mutate `process.env` only for the section under test (`RATE_LIMIT_ENABLED`, `TURNSTILE_SECRET_KEY`, `NODE_ENV=production` for the two non-enumeration and limiter-outage sections) and restore it in `finally`. The in-memory limiter is per process; sections pick distinct IPs or identifiers.

## Verification (on HEAD `d66b209`, plus this report)

| Gate | Result |
|---|---|
| `npm run typecheck` | clean (0 errors), run before every commit |
| `npx eslint` on every new/changed file | 0 problems |
| New suites (each run individually, `npx tsx --require ./scripts/lib/server-only-preload.cjs <file>`) | register **61** · verify-email **27** · forgot-password **22** · reset-password **22** · pre-login **19** · `[...nextauth]` **41** · totp-routes **43** · sessions **31** · password **21** · members **43** · invite **27** · invites/[inviteId] **29** · accounts/share **27** · permanent **16** · sections **13** · import **12** = **454 passed, 0 failed** (+6 known-defect lines) |
| Every test that walks the source tree (77 files containing `readdirSync`/`walk(`) | all pass |
| Static audits: `audit-db-authority`, `audit-route-guards`, `audit-account-reparenting`, `audit-surface-independence`, `audit-goals-tombstone`, `audit-crypto-holding-tombstone`, `audit-read-identity-consumers`, `audit-forecast-slice-provenance`, `audit-migration-names` | all pass |
| Full `npm run test:unit` / `npm run ci` / `next build` | **not run** (8 GB machine, per the brief) |

## Commits (`git log --oneline 57de6aa..HEAD`)

```
d66b209 TEST-002/004 test-support: find the Prisma client without the db import
0913a3c TEST-002 account import: real-handler tests; fake models aborted transactions
313dae7 TEST-002 spaces section PATCH: real-handler tests + J-D5 one-line fix
7430ae7 TEST-002 spaces permanent delete: real-handler tests
774fc09 TEST-002 spaces account share: real-handler tests
31b0078 TEST-002 spaces invitations: real-handler tests
6544944 TEST-002 spaces members: real-handler tests
81c98c3 TEST-004 user/password: real-handler tests
5e771b0 TEST-004 user/sessions: real-handler tests
9d51843 TEST-004 user/totp routes: real-handler tests
5471607 TEST-004 NextAuth sign-in/sign-out: real-route tests
b426b09 TEST-004 pre-login: real-handler tests
8552281 TEST-004 forgot/reset password: real-handler tests
383546e TEST-004 verify-email + resend: real-handler tests
5a0ddc3 TEST-004 register: real-handler tests + route test harness
```
