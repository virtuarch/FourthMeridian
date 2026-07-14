# Fourth Meridian — SYSTEM_ADMIN Step-Up Investigation

**Date:** 2026-07-13
**Scope:** Investigation only — no code changes. Scope a "step-up" model for SYSTEM_ADMIN's break-glass bypass so elevated access becomes an explicit, logged, time-boxed action instead of a standing condition on every request from that role.
**Prompt:** `CLAUDE_CODE_PROMPT_sysadmin_stepup_investigation_2026-07-13.md`
**Prior context:** 07-07 break-glass ruling (`FOURTH_MERIDIAN_PO1_PLATFORM_ACCESS_INVESTIGATION_2026-07-07.md` — "SYSTEM_ADMIN is retained only as break-glass superuser"); PO1.0 platform-access seam (shipped 2026-07-13).

---

## 0. Executive summary

The full SYSTEM_ADMIN bypass surface today is **one platform-access adapter branch (feeding 8 platform API routes), 19 guard call sites across 16 `/api/admin/*` route files (13 cached + 6 fresh), the `proxy.ts` middleware role gate, 8 server-rendered `/admin` pages, and 2 rate-limit exemptions**. The inventory (§1) is complete and also surfaced four pre-existing gaps that any step-up design must account for — most importantly that **`requireFreshSystemAdmin` is NOT re-authentication** (it is only a live session-revocation check; option 2 in the prompt is built on a misreading of it) and that **SYSTEM_ADMIN TOTP enforcement is currently OFF in the live DB** despite the admin UI presenting it as permanently locked on.

Of the three candidate models (§2), the recommendation (§6) is a **combination: audit-visibility first (Option C) as a same-week slice, then a time-boxed elevated session (Option A) gating all mutation-capable admin surfaces**, with reads left un-elevated, an env-var escape hatch mirroring `DISABLE_SYSTEM_ADMIN`, and two prerequisite fixes (actually enforce SYSTEM_ADMIN TOTP; move the four Plaid ops POSTs to the fresh guard). Extending `requireFreshSystemAdmin` to reads (Option B) is rejected: it adds DB cost and zero friction against the stated threat, because a stolen session passes a freshness check by definition.

---

## 1. Full inventory — every path where `role === SYSTEM_ADMIN` grants access unconditionally

### 1.1 The platform-access bypass (`lib/platform/authorize.ts`)

The bypass exists at two layers of the same file, per the 07-07 ruling ("the bypass lives in the adapter, not the pure policy"):

| Location | Code | Effect |
|---|---|---|
| `decidePlatformAccess`, line 73 | `if (role === UserRole.SYSTEM_ADMIN) return true;` | Pure decision: SYSTEM_ADMIN allowed at every area × level, grants ignored (locked by `lib/platform/policy.test.ts` — the oracle at :213 and the source tripwire at :264-265 both pin this behaviour) |
| `resolvePlatformAccess`, lines 92-94 | `if (user.role === UserRole.SYSTEM_ADMIN) return [{ user, grant: null }, null];` | I/O short-circuit: **no `PlatformGrant` lookup is even attempted, no DB touch, no log**. `grant: null` is the only trace, and it never leaves the route handler |

Both public entry points inherit it: `requirePlatformAccess` (line 116, via `requireUser`) and `requireFreshPlatformAccess` (line 131, via `requireFreshUser` — defined for future WRITE routes, currently unused by any route).

**Consuming routes today (8, all READ, all GET):**

| Route | Gate |
|---|---|
| `GET /api/platform/security-ops/audit` | `requirePlatformAccess("SECURITY_OPS", "READ")` |
| `GET /api/platform/security-ops/auth-posture` | `requirePlatformAccess("SECURITY_OPS", "READ")` |
| `GET /api/platform/security-ops/sessions` | `requirePlatformAccess("SECURITY_OPS", "READ")` |
| `GET /api/platform/platform-ops/env-status` | `requirePlatformAccess("PLATFORM_OPS", "READ")` |
| `GET /api/platform/platform-ops/rate-limits` | `requirePlatformAccess("PLATFORM_OPS", "READ")` |
| `GET /api/platform/platform-ops/job-health` | `requirePlatformAccess("PLATFORM_OPS", "READ")` |
| `GET /api/platform/growth-revenue/signups` | `requirePlatformAccess("GROWTH_REVENUE", "READ")` |
| `GET /api/platform/customer-success/sync-issues` | `requirePlatformAccess("CUSTOMER_SUCCESS", "READ")` |

**Nuance worth stating:** the platform *page* (`app/(shell)/dashboard/platform/[area]/page.tsx`) has **no** SYSTEM_ADMIN bypass — it checks the grant row directly (lines 48-54) and SYSTEM_ADMIN never reaches it anyway (`proxy.ts:49` redirects them off `/dashboard/*`). So in practice the platform-access bypass is **API-only**: a SYSTEM_ADMIN session can `fetch` all 8 platform data routes directly, invisibly, but has no UI path to them. The bypass surface will grow with every PO1.x route added; any step-up hook placed inside `resolvePlatformAccess` covers all future routes automatically, which is the right chokepoint.

### 1.2 `requireSystemAdmin` call sites (`lib/session.ts:200`, role check at :205 — cached revocation, no re-auth)

| Route | Method | Notes |
|---|---|---|
| `/api/admin/overview` | GET | Counts/stats |
| `/api/admin/users` | GET | User list incl. emails, roles |
| `/api/admin/spaces` | GET | All Spaces |
| `/api/admin/audit` | GET | Full audit log, filterable |
| `/api/admin/security/settings` | GET | Platform settings read |
| `/api/admin/security/admin-status` | GET | Own 2FA status |
| `/api/admin/security/users` | GET | Per-user security posture |
| `/api/admin/security/users/[userId]/sessions` | GET | Target user's sessions |
| `/api/admin/platform-grants` | GET | Grant matrix read |
| `/api/admin/plaid/diagnostics` | **POST** | Read-ish diagnostics, but POST |
| `/api/admin/plaid/expand-history-token` | **POST** | **Mutation on cached guard** |
| `/api/admin/plaid/exchange-expanded-history-token` | **POST** | **Mutation on cached guard** |
| `/api/admin/plaid/retire-superseded-item` | **POST** | **Mutation on cached guard** |

⚠️ **Gap found during inventory:** the four Plaid ops routes are POSTs — three of them genuinely state-changing (token expansion/exchange, item retirement) — yet they sit on the *cached* guard, not `requireFreshSystemAdmin`. This violates the repo's own fresh-guard-for-mutations convention (`lib/security-surface.test.ts` locks the convention for the security routes but doesn't cover Plaid). Independent of step-up, these should move to the fresh guard.

### 1.3 `requireFreshSystemAdmin` call sites (`lib/session.ts:218`, role check at :223 — live revocation check, still no re-auth)

| Route | Method | Action |
|---|---|---|
| `/api/admin/security/settings` | PATCH | Change platform settings |
| `/api/admin/security/users/[userId]/sessions` | DELETE | Revoke target user's sessions |
| `/api/admin/security/users/[userId]/2fa-reset` | POST | Reset target user's 2FA |
| `/api/admin/security/users/[userId]/recovery-codes` | POST | Regenerate target's recovery codes |
| `/api/admin/platform-grants` | POST | Create/reinstate/level-change grant |
| `/api/admin/platform-grants/[grantId]` | PATCH | Revoke grant |

⚠️ **Critical clarification for the whole investigation:** "fresh" here means **the session-revocation check bypasses the 30s cache (`lib/session-cache.ts:47`) and hits `UserSession` live** — nothing more. It does **not** re-verify the password or TOTP. The prompt's option 2 describes it as "the same fresh-auth re-check" — that phrasing overstates it. The only re-auth machinery in the codebase is the *user-space* `currentPassword`/bcrypt-compare pattern (`/api/user/{password,deactivate,delete,email/request,totp/disable}`), and the **commented-out** admin TOTP guard in `2fa-reset/route.ts:55-64` ("future enforcement"). No admin route re-proves identity today.

### 1.4 Middleware and server-rendered pages

| Location | Check | Notes |
|---|---|---|
| `proxy.ts:49` | `token.role === "SYSTEM_ADMIN" && /dashboard/*` → redirect `/admin` | Role read from **JWT claim**, no DB |
| `proxy.ts:54` | `token.role !== "SYSTEM_ADMIN" && /admin/*` → redirect `/dashboard` | Ditto |
| `proxy.ts:68` | TOTP-setup redirect branches on role | Ditto |
| `app/admin/layout.tsx:21` | `session.user.role !== "SYSTEM_ADMIN"` → redirect | Gates all 8 admin pages |
| `app/admin/page.tsx:34`, `app/admin/providers/page.tsx:60` | Per-page re-check + direct `db.*` reads | `providers` reads `plaidItem` rows server-side |
| `app/admin/{audit,security,users,spaces,platform-access}/page.tsx` | Rely on layout gate; data via gated APIs | `workspaces` is a bare redirect to `spaces` |

⚠️ **Gap found during inventory:** the role claim in the JWT is written once at sign-in (`lib/auth.ts` jwt callback :399-406) and **never re-read from the DB** for the token's 30-day life (`maxAge`, `lib/auth.ts:517`). Demoting a compromised SYSTEM_ADMIN to USER in the DB does *not* strip an existing session; the only live kill is revoking its `UserSession` row — via an admin API the attacker controls, or direct SQL. Likewise the `DISABLE_SYSTEM_ADMIN` kill switch (`lib/auth.ts:82,107`) **only blocks new logins**, not live sessions. A step-up window is precisely the mechanism that shrinks this 30-day standing value.

### 1.5 Other unconditional role privileges (not access, but role-conditioned behaviour)

| Location | Behaviour |
|---|---|
| `app/api/ai/chat/route.ts:1945` | SYSTEM_ADMIN exempt from per-user AI rate limit |
| `app/api/user/totp/verify/route.ts:33` | SYSTEM_ADMIN exempt from TOTP-verify rate limit |
| `app/api/user/deactivate/route.ts:45`, `app/api/user/delete/route.ts:46` | SYSTEM_ADMIN blocked from self-deactivate/delete (protection, not privilege) |
| `lib/auth.ts:211` | Role selects `require_totp_system_admin` as the forced-TOTP-enrolment key |
| `prisma/seed.ts:315-320` | Dev-only seed SYSTEM_ADMIN (`sysadmin@example.com` / known password) |

### 1.6 Deliberate non-bypasses — the boundary the step-up model does NOT need to cover

These are load-bearing scope limits; a step-up design should not accidentally "fix" them:

- **Customer Space data:** `requireSpaceRole` (`lib/session.ts:268`) and `lib/space.ts` give SYSTEM_ADMIN **no bypass** (`lib/space.ts:165` states it explicitly). SYSTEM_ADMIN cannot read any user's transactions/accounts via customer routes.
- **Merchant ops:** membership-gated, explicitly not role-gated (`lib/merchant-ops-access.ts:6-7`).
- **Grant issuance targets:** grants may only be held by `role === USER` (`/api/admin/platform-grants/route.ts:102`), so the bypass can't be used to mint a second super-role.
- **Platform-surface tripwires:** `lib/platform-surface.test.ts` and `lib/platform/policy.test.ts` pin the current bypass semantics in tests — any step-up change to `decidePlatformAccess`/`resolvePlatformAccess` **must update these tests deliberately**, which is a feature (the bypass can't drift silently) but also a checklist item.

### 1.7 Pre-existing gaps surfaced by the inventory (independent of any step-up decision)

1. **SYSTEM_ADMIN TOTP is not actually enforced.** `require_totp_system_admin` is seeded `'false'` (migration `20260612100000_add_security_models`, line 66), defaults `'false'` in code (`lib/platform-settings.ts:22`), and is **`false` in the live DB** (`fintracker_backup.sql:2262`). The settings API refuses to *set* it to false (`/api/admin/security/settings/route.ts:40-42`) and the admin UI renders it as a locked always-on row (`app/admin/security/page.tsx:456-463`) — but nothing ever set it to `true`. Today a SYSTEM_ADMIN without voluntarily-enrolled TOTP logs in with password alone. Every step-up option below that leans on TOTP presumes this is fixed first.
2. **Plaid ops mutations on the cached guard** (§1.2).
3. **Kill switch is login-only; JWT role never re-read** (§1.4).
4. **The commented-out admin-TOTP guard** in `2fa-reset` (§1.3) — evidence the step-up need was already felt once and deferred.

---

## 2. What "step-up" could concretely mean — the three options

### Option A — time-boxed elevated session ("sudo mode")

**Mechanics sketch (for evaluation only):**
- Add a nullable `elevatedUntil DateTime?` (and `elevatedAt`, for audit) to `UserSession` — server-side state, additive migration, revocable with the session, deliberately **not** a JWT claim (a JWT claim would inherit the 30-day-unrevocable problem from §1.4).
- `POST /api/admin/elevate`: `requireFreshSystemAdmin` + **TOTP code required** (recovery code accepted as fallback) → stamps `elevatedUntil = now + WINDOW` (15–30 min), writes a distinct audit row (`ADMIN_ELEVATED`). Expiry is passive (timestamp comparison); no renewal — re-entering requires re-elevating. An explicit `DELETE` (drop elevation early) is cheap to add.
- Gating: `requireFreshSystemAdmin` (all 6 mutation routes) and the four Plaid POSTs check `elevatedUntil > now` in the same `UserSession` query they already run — **zero added DB round-trips** on those routes. The platform-access bypass branch (`resolvePlatformAccess:92`) and, if desired, cached admin reads would need one `UserSession` lookup where none exists today (reusable via the existing 30s session-cache pattern if latency matters).
- Every action taken while elevated is logged as such (metadata `{ elevated: true, elevatedAt }` on rows that already carry `performedByAdminId`).

**Trade-offs:**
- ✅ Directly addresses the stated threat: a stolen cookie/credential alone can no longer mutate anything — the attacker also needs the TOTP secret *at time of use*, not just at login.
- ✅ Shrinks the standing-compromise window from 30 days (JWT life) to ≤30 minutes per explicit elevation.
- ✅ Produces exactly the "explicit, logged, time-boxed" audit shape the prompt asks for.
- ➖ Largest build of the three: migration, elevate endpoint, guard changes, UI affordance in `/admin` (banner with countdown + "Elevate" prompt), test updates (§1.6 tripwires).
- ➖ Introduces a new mechanism that can itself fail (§3).
- ➖ Decision required on scope: elevate-for-mutations-only (recommended, §4) vs elevate-for-everything (touches every admin page load — pushes toward all-day elevation, defeating the point).

### Option B — extend `requireFreshSystemAdmin` to also gate the platform-access bypass and admin reads

**What it would actually do:** given §1.3's clarification, this option does **not** add any authentication friction. It would make every SYSTEM_ADMIN read do a live `UserSession` revocation query instead of trusting the 30s cache.

**Trade-offs:**
- ✅ Cuts revocation propagation on reads from ≤30s to 0 — marginally useful *after* a compromise is detected and sessions are being revoked.
- ✅ Tiny build (swap guard calls; add a fresh variant to the bypass branch).
- ❌ **Does not address the threat.** A compromised-but-unrevoked session passes a freshness check by definition. The attacker experiences no additional friction, ever.
- ❌ Re-introduces the exact per-request DB cost the session cache exists to avoid (`lib/session-cache.ts:8-15` documents 1.1–2.4s per live check in production) on the highest-frequency admin paths.
- Verdict: **not a step-up model at all** — at most a minor revocation-latency tweak, and an expensive one. If the fresh guard is ever upgraded to true re-auth-per-request instead, it becomes intolerable UX (TOTP on every page load). Reject in both readings.

### Option C — audit-only: log every bypass event, change nothing about access

**Mechanics sketch:**
- New canon constants (the SECOPS free-string lesson): e.g. `SYSTEM_ADMIN_BYPASS_USED` (platform-access branch) and `ADMIN_ACCESS` (admin guard successes), written from `resolvePlatformAccess` and the two admin guards with route/area/level metadata.
- **Volume control is the design problem:** `requireSystemAdmin` runs on every admin page load and API call — naive logging writes dozens of near-identical rows per working hour into an append-only table. Practical shape: log the platform-access bypass **always** (it is rare and currently invisible), and dedupe admin-surface access to one row per (session × route × hour) via a short-TTL in-memory guard, mirroring the session-cache pattern. Best-effort writes (never block the request).
- Surface the new actions in the admin audit filter groups and (deliberately or not) the Security Ops widget's `ADMIN_SECURITY_FILTER_ACTIONS` — with the caveat that platform staff with SECURITY_OPS READ would then see sysadmin activity, which may be exactly right (oversight) or unwanted (exposure); decide explicitly.
- Keep the new actions **out of** `USER_SECURITY_HISTORY_ACTIONS` (they are platform-forensic, not user-facing).

**Trade-offs:**
- ✅ Zero lockout risk, zero added friction, cheapest build.
- ✅ Fixes a real observability hole: today "SYSTEM_ADMIN viewed X via bypass" leaves no trace anywhere (the audit trail only records specific mutations).
- ❌ Detection-after-the-fact only — a compromised session's actions become *visible*, not *preventable*. And visibility only pays off if the log is actually watched; for a solo operator the honest answer is "occasionally, via the Security Ops widget".
- ❌ The audit rows are written by the same DB identity the attacker effectively controls at the app layer; append-only is convention here, not enforcement.

### Comparison

| | A — timed elevation | B — fresh everywhere | C — audit-only |
|---|---|---|---|
| Blocks a stolen session from mutating | **Yes** (needs TOTP at use) | No | No |
| Shrinks standing-access window | **Yes** (30d → ≤30min) | No | No |
| Makes bypass use visible | Yes (elevation + action rows) | No | **Yes** |
| Lockout risk introduced | Some (§3) | None | **None** |
| Build size | Medium | Small | **Small** |
| Daily friction (solo) | ~2–5 TOTP entries/day | None | **None** |
| Addresses prompt's core ask | **Fully** | No | Partially (logged, but not explicit/time-boxed) |

---

## 3. Lockout risk, explicitly, per option

The break-glass floor that must survive every design: **Chris owns the Postgres instance.** Direct SQL (`docker compose exec db psql …`) can flip any setting, null any elevation requirement, or re-role any account. No app-layer bug can remove that path; it is the true recovery mechanism of last resort, and it already backs the existing `DISABLE_SYSTEM_ADMIN` design (a DB `role = USER` flip is documented as equivalent in `lib/auth.ts:14`).

**Option A scenarios:**
- *TOTP device lost:* recovery codes (`RecoveryCode` model, bcrypt-hashed, one-time) already exist and should be accepted by the elevate endpoint — same fallback login already has. If codes are also lost: direct SQL to clear `totpSecret`/`totpEnabled` (the same recovery as being locked out of login today — elevation adds no *new* dead end).
- *Elevation mechanism has a bug:* mirror the existing kill-switch pattern — an env var (e.g. `DISABLE_ADMIN_ELEVATION=true`) that short-circuits the elevation check back to today's behaviour. This is the crucial escape hatch: one `.env` edit + redeploy, no DB needed, and it fails toward the current (working) model rather than toward lockout. It must be documented in `INCIDENT_RESPONSE_RUNBOOK.md` alongside `DISABLE_SYSTEM_ADMIN`.
- *DB in a bad state when emergency access is needed most:* the key property of putting `elevatedUntil` on `UserSession` is that **elevation requires no table that login doesn't already require.** Any DB state healthy enough to authenticate a session is healthy enough to elevate one. An empty/misconfigured `PlatformGrant` table — the original break-glass scenario — is untouched: SYSTEM_ADMIN still bypasses grants entirely; elevation only adds a time-boxed second factor in front of *mutations*. If the migration hasn't run (column missing), Prisma fails loudly at the guard — which is why the env escape hatch must exist *before* enforcement is turned on.
- *Fail-open vs fail-closed:* recommend fail-closed on elevation-check errors, with the env override as the documented fail-open lever. Fail-open by default would quietly reduce to Option C.

**Option B:** no new lockout risk (it can only deny sessions that are genuinely revoked). Its problem is efficacy, not safety — except one edge: if the DB is degraded (slow/flaky), fresh checks on every read make the admin surface unusable exactly when diagnosing the degradation, whereas today's cache rides through 30s blips.

**Option C:** zero lockout risk by construction. Worst failure is a lost/failed audit write, which must be best-effort (never block the request) — same posture as the existing `lastActiveAt` fire-and-forget.

**Cross-cutting:** solo-operator recovery *documentation* matters more than mechanism count. Whatever ships, the runbook needs a "locked out of admin" page: recovery codes → env override → direct SQL, in that order.

---

## 4. Solo-operator UX cost, realistically

Chris's actual daily admin usage (inferred from the surface): loading `/admin` dashboards (reads, many times/day), occasionally issuing/revoking a platform grant, rarely resetting a user's 2FA or revoking sessions, rarely running Plaid ops. Platform-area data he consumes as widgets require no admin mutation at all.

- **Option A, mutations-only scope:** elevation is needed a handful of times per day at most — one 6-digit TOTP entry buys a 15–30 min window covering a whole batch of grant edits. Reads (dashboards, audit browsing, user lists) never prompt. This is the same interaction pattern as GitHub's sudo mode or `sudo` itself, and it is well below the route-around threshold. **Recommend TOTP-only re-entry** (not password+TOTP): the marginal security of also re-typing the password is low against the actual threat (stolen cookie ⇒ attacker lacks the TOTP secret either way; stolen password ⇒ ditto), and halving the friction is what keeps a solo operator honest. 30 min window over 15 for the same reason.
- **Option A, everything-elevated scope:** every dashboard load inside an expired window bounces to a TOTP prompt — a dozen+ prompts/day. That is exactly the friction level that produces "elevate at 9am, re-elevate on expiry, all day" muscle memory, which converges back to a standing condition. **Avoid.**
- **Option B:** no visible friction (its cost is latency: +1 DB query per admin read, historically 1.1–2.4s worst-case in production per `lib/session-cache.ts`) — but no protection either.
- **Option C:** zero friction. The only "cost" is Chris occasionally reading his own access log.
- **Route-around risk check:** the strongest route-around temptation is not the window length — it's any prompt that appears during *read* workflows. Keeping reads free is the single most important UX decision in the design.

---

## 5. What is already true today (so the recommendation adds, not restates)

| Existing protection | Where | What it already covers |
|---|---|---|
| Fresh guard on destructive admin routes | 6 routes, §1.3 | Live revocation check on security mutations + grant writes |
| Append-only audit with `performedByAdminId` | `AuditLog` schema; grant/2FA/session routes | Specific admin **mutations** are attributed and immutable-by-convention |
| Login rate limiting | `lib/auth.ts:76` (per-identifier), NextAuth wrapper (per-IP) | Brute-force on the admin password |
| `DISABLE_SYSTEM_ADMIN` kill switch | `lib/auth.ts:82,107` | Blocks *new* admin logins (not live sessions — §1.4) |
| Email-verification gate incl. SYSTEM_ADMIN | `lib/auth.ts:140` | Unverified admin account can't log in |
| Session revocation machinery + 30s cache | `UserSession`, `lib/session-cache.ts` | Revoked sessions die within ≤30s (reads) / instantly (fresh guards) |
| TOTP + recovery codes available | `lib/auth.ts:228-282`, `RecoveryCode` | Second factor **at login** — if enrolled (§1.7: enforcement currently off) |
| Grant targets restricted to USER | `platform-grants/route.ts:102` | Bypass can't mint a second super-role |
| No Space-data bypass | `lib/space.ts:165` | Customer financial data outside the blast radius via customer routes |

**What step-up would genuinely ADD:** (1) a second factor **at time of use** rather than only at login — the only control in the list that a fully-hijacked live session doesn't already satisfy; (2) a bounded elevation window replacing 30 days of standing mutation capability; (3) first-trace visibility of bypass *reads*, which today leave no record at all; (4) an explicit, queryable "this happened under elevation" audit dimension.

---

## 6. Recommendation

**Ship in two slices, C then A — plus two prerequisite fixes. Reject B.**

**Prerequisites (independent hygiene, do first):**
1. Enforce SYSTEM_ADMIN TOTP for real: set `require_totp_system_admin = 'true'` (seed + live row), keeping the existing forced-enrolment flow (`requireTotpSetup` → `/admin/security?setup2fa=true`) as the migration path. Step-up-by-TOTP is meaningless while TOTP itself is optional (§1.7.1).
2. Move the four `/api/admin/plaid/*` POSTs to `requireFreshSystemAdmin` (§1.2) so the "fresh guard = mutation floor" convention is true before it becomes the elevation hook.

**Slice 1 — Option C (visibility):** log the platform-access bypass always + deduped admin-surface access rows, canon constants, admin-audit filter group. Zero risk, immediate value, and it produces the baseline data ("how often do I actually mutate vs read?") that validates the Slice 2 scope choice.

**Slice 2 — Option A (friction), mutations-only:** `elevatedUntil` on `UserSession`; `POST /api/admin/elevate` behind `requireFreshSystemAdmin` + TOTP/recovery-code; 30-minute window, no auto-renewal; enforced inside `requireFreshSystemAdmin` (zero extra queries) so all 6 security/grant mutations + the newly-upgraded Plaid POSTs are covered by one chokepoint; `DISABLE_ADMIN_ELEVATION` env escape hatch documented in the incident runbook before enforcement turns on; reads and the platform-access READ bypass stay elevation-free (they become visible via Slice 1 instead). Future platform WRITE routes inherit coverage automatically the day `requireFreshPlatformAccess` starts checking elevation for the `grant === null` branch — one line in the same chokepoint file.

**Why this split:** C alone leaves the prompt's core ask (explicit, time-boxed) unmet; A alone ships friction with no baseline to judge its scope against and no visibility into the read-side bypass it deliberately leaves open. Together they convert SYSTEM_ADMIN from "standing god-mode" to "observable read access + short-lived, second-factor-gated write access" while every recovery path (recovery codes → env override → direct SQL) survives.

Stopping here per the prompt — no implementation plan in this pass. Open decisions for Chris before planning: window length (15 vs 30 min), TOTP-only vs password+TOTP at elevation, whether Security Ops staff should see sysadmin bypass rows (§2C), and whether Slice 1's admin-read dedup granularity (session × route × hour) is the right noise floor.
