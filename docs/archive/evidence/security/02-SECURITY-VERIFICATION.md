> Runtime verification deliverable · HEAD cde8fa0 (v2.6) · 2026-10-21 · isolated throwaway stack (synthetic data, OpenAI mocked, Plaid Items set REVOKED, no Preview/Production access). Classifications: CONFIRMED / SUPPORTED / REFUTED / PARTIAL / UNVERIFIED. This is the verifying workstream's report; the coordinator independently reproduced SEC-001 and cross-checked every promoted claim (see 09-STATIC-RUNTIME-RECONCILIATION.md).

# Workstream SEC (N=1) — Security runtime verification

Repo HEAD under test: cde8fa0 (v2.6). Server: http://127.0.0.1:3100 (Next dev/webpack, FM_RLS_STRICT=true, in-memory limiter, http cookies, OpenAI mocked, Plaid REVOKED).
All requests sent with `X-Forwarded-For: 10.1.0.x`. Synthetic accounts only. No tokens/cookies/secrets printed. Scripts/evidence under `$S/rtv/sec/`.

Environment deltas from Production (apply to every finding below): dev server (not Vercel/Fluid Compute); in-memory rate limiter (prod is DB-backed); session cookie is `next-auth.session-token` over http (prod `__Host-` + Secure); TURNSTILE unset ⇒ CAPTCHA is a no-op; RESEND unset ⇒ emails to in-memory adapter; no Cloudflare in front (decisive for ARCH-003).

Verification budget: one login (sysadmin jar created; jane/john/alex jars reused); ≤8 serial requests per probe; one synthetic manual account created for SEC-004 and deleted afterward; one synthetic `@rtv.invalid` user created for SEC-008.

Summary table:

| Finding | Severity (audit) | Runtime classification |
|---|---|---|
| SEC-001 TOTP page-gate bypass | P1 / high | **CONFIRMED** (sysadmin path, end-to-end at runtime) |
| SEC-004 CSV formula injection | P2 / high | **CONFIRMED** (live export, unescaped `=` cell) |
| SEC-005 user-search enumeration | P2 / high | **CONFIRMED** (single-char, unthrottled) |
| SEC-006 admin 2FA reset no step-up | P2 / high | **SUPPORTED** (code); runtime blocked by fixture (no enrolled 2nd admin) |
| SEC-008 registration_mode default open | P1 (config) / high | **CONFIRMED** (201, no invite) |
| SEC-010 no idle/absolute session lifetime | P2 / high | **SUPPORTED** (config + schema; 30-day window not time-testable) |
| SEC-013 raw `e.message` leakage | P3 / high | **PARTIAL** — decide leg returns raw message at runtime; amend leg is dead code (503 gate) |
| ARCH-003 IP-extractor inconsistency | P1 / — | **CONFIRMED** (limiter keyed on XFF, ignores cf-connecting-ip) |
| TEST-002 route handlers untested | P1 | **CONFIRMED** (187 routes / 6 route tests) |
| TEST-003 no RLS table-coverage gate | P1 | **SUPPORTED** (per-file ratchet only; no census gate) |
| TEST-004 no auth-flow handler tests | P1 | **CONFIRMED** (0 tests for auth/totp/sessions) |

---

## SEC-001 — Forced-TOTP page-gate bypass on SSR'd `/admin` (incl. admin inventory) — CONFIRMED

- **Initial state:** `sysadmin@example.com` is SYSTEM_ADMIN, not TOTP-enrolled ⇒ login yields a TOTP-pending session.
- **Method:**
  1. `login.sh sysadmin@example.com … sysadmin 10.1.0.1` → callback 200, but `/api/spaces` = 403 (pending).
  2. Baseline (jar `sysadmin`, XFF 10.1.0.1): `GET /api/admin/users` → **403**; `GET /admin` → **307 → /admin/security?setup2fa=true** (middleware TOTP gate).
  3. Reproduce the traced NextAuth `update` trigger with curl (no browser): `GET /api/auth/csrf`, then `POST /api/auth/session` with body `{"csrfToken":…,"data":{"requireTotpSetup":false}}` (this is exactly what `useSession().update({requireTotpSetup:false})` sends; `lib/auth.ts:562-565` copies client `session.requireTotpSetup` onto `token.requireTotpSetup`). → **200**, new session cookie.
  4. Re-probe with the mutated jar.
- **Expected (if sealed):** `/admin` keeps redirecting to enrolment; admin inventory never renders.
- **Actual:** `GET /admin` → **200** (was 307); page body 85 KB containing **all 4 synthetic users' emails (@example.com), the SYSTEM_ADMIN role pill, the Users stat card, and Space membership** (SSR'd `db.user.findMany`/`db.space.findMany`). `GET /admin/providers` → **200**. `GET /api/admin/users` and `/api/spaces` remain **403**.
- **Why:** `proxy.ts:175` gates on the client-updatable `token.requireTotpSetup`; `app/admin/layout.tsx`, `app/admin/page.tsx:33`, `app/(shell)/dashboard/layout.tsx:31` re-check `getServerSession` for session + role only and **never consult the DB-derived `session.requireTotpSetup`** (which the session callback *does* compute correctly at `lib/auth.ts:682` — that is why the API half stays 403). The page gate and the API gate disagree.
- **Evidence:** `$S/rtv/sec/admin_body.html` (4 distinct `@example.com` local-parts; `SYSTEM_ADMIN` pill; `>Users<` stat). Status transitions 403→(update 200)→/admin 200.
- **Reproducibility:** Deterministic.
- **Scope note:** The regular-USER variant (`require_totp_all_users` on → `dashboard/layout.tsx` same gap) is code-SUPPORTED only; I did not toggle that shared platform setting. The sysadmin break-glass path is fully runtime-confirmed.
- **Severity:** P1 / high (password-only read of SSR'd admin inventory + Plaid Items page while MFA is policy-mandatory). Confirmed.
- **Remediation (as audit):** drop the client-update branch or re-derive from DB; add `if (session.requireTotpSetup) redirect(enrolmentPath)` to both layouts; add a test that a pending session cannot render `app/admin/page.tsx`.

## SEC-004 — CSV formula injection in export — CONFIRMED

- **Initial state:** `lib/export/csv.ts` calls `Papa.unparse(rows)` at 4 sites with no `escapeFormulae` option (papaparse default = false). Export surface = **`POST /api/user/export`** (zip of CSVs), reachable by any authenticated user.
- **Method (jane, XFF 10.1.0.7):** created a manual account named `=RTVINJECT()+1` via `POST /api/accounts/manual` (201); `POST /api/user/export` → 200 `application/zip` (90,879 B); unzipped `accounts.csv`.
- **Expected (if safe):** the `=`-leading cell is neutralised (tab/quote prefix).
- **Actual:** the cell is written verbatim: `cmvij…,=RTVINJECT()+1,other,Manual Entry,…` — field begins with a bare `=`, i.e. a live formula if opened in Excel/LibreOffice (CWE-1236). `cat -v` confirms no control-char prefix.
- **Evidence:** `$S/rtv/sec/export_extract/accounts.csv`. User-controlled account names (and, by the same serialiser, Plaid transaction descriptors in `transactions.csv`) flow unescaped.
- **Cleanup:** fixture account soft-deleted (`DELETE …/manual/<id>` 200; re-export shows 0 matches).
- **Reproducibility:** Deterministic.
- **Severity:** P2 / high. Confirmed. **Remediation:** `escapeFormulae: true` + a serialiser test.

## SEC-005 — Unthrottled user-directory enumeration — CONFIRMED

- **Initial state:** `GET /api/users/search?q=` behind `requireUser()` only; `q.length < 1` is the only floor.
- **Method (alex — *no* grants, XFF 10.1.0.3):** single-char queries `a,e,o,s,j` returned 2/3/1/2/2 user objects each; 10 rapid identical requests → **0 non-200** (no throttle).
- **Actual:** each row exposes `id, name, username, firstName, lastName`. A handful of single-char probes walk the entire directory. The `&exclude=<spaceId>` membership-oracle *is* now gated (`requireSpaceAction(... "member:invite")`), but the unfiltered name search is open to every account.
- **Severity:** P2 / high. Confirmed. **Remediation:** require exact `@username` or ≥3 chars; per-user rate limit; restrict to shared-Space peers.

## SEC-006 — Admin 2FA reset without step-up — SUPPORTED (runtime blocked)

- **Code (verified):** `app/api/admin/security/users/[userId]/2fa-reset/route.ts` reads `body.adminTotpCode` but **never verifies it** — the actor-TOTP check is commented out ("Uncomment after TOTP verification is fully implemented"). Only `confirmToken === "RESET"` is required; there is no refuse-SYSTEM_ADMIN-target / second-approver branch.
- **Runtime:** not exercisable here — the route uses `requireFreshSystemAdmin` (live DB), and the only SYSTEM_ADMIN fixture (`sysadmin`) is deliberately TOTP-pending (its admin APIs 403, as SEC-001 showed). Enrolling it would mutate the shared pending-session fixture other workstreams depend on, so I did not. Classification: SUPPORTED by inspection.
- **Severity:** P2 / high. **Remediation:** require the actor's live TOTP; refuse SYSTEM_ADMIN targets without a second approver; notify the target.

## SEC-008 — `registration_mode` defaults to open — CONFIRMED

- **Method (XFF 10.1.0.20):** `POST /api/auth/register` with a fresh `@rtv.invalid` identity, `acceptedTerms:true`, **no inviteToken**.
- **Actual:** **201** `{"success":true,"userId":…,"verificationRequired":true}` — account created with no invite. Confirms `open` is the live default (`getRegistrationMode()` → ship default `open`; `register/route.ts` only rejects `closed`). CAPTCHA is a no-op (TURNSTILE unset).
- **Severity:** P1 (config) / high. Confirmed. **Remediation:** default `invite_only`; seed the setting in the cutover runbook; alert when absent.
- **Env note:** on Production the exposure depends on the cutover writing the setting before public DNS; the *code default* is what I confirmed.

## SEC-010 — No idle / absolute session lifetime — SUPPORTED

- **Code/schema (verified):** `lib/auth.ts:720-722` → `session.strategy:"jwt"`, `maxAge: 30*24*60*60` (30-day rolling, no DB sessions). `prisma/schema.prisma` `model UserSession` has `sessionToken, lastActiveAt, revokedAt, revokedById, createdAt` — **no `expiresAt`/absolute-expiry column**. No idle cutoff exists.
- **Runtime:** a 30-day window and absence of idle cutoff are not practically time-testable in a single session; the configuration is authoritative. Classification: SUPPORTED.
- **Severity:** P2 / high. **Remediation:** enforce idle + absolute cut-offs in `factsFromRow`.

## SEC-013 — Raw `e.message` returned to clients — PARTIAL

- **Code (verified):** `spaces/[id]/wealth/amend/route.ts:104` returns `{error:e.message}` at 403 and `:106-107` at 400; `merchant-ops/decide/route.ts:70-72` returns `{error:e.message}` at 422/409.
- **decide leg — runtime (jane, MERCHANT_OPS WRITE, XFF 10.1.0.4):** `POST /api/merchant-ops/decide` with nonexistent keys → **422** body `"not a pending merge candidate (…); only detector-proposed, undecided pairs can be decided"` — i.e. the raw exception message is passed through verbatim. (This input hit the controlled-domain `MergeReviewIneligibleError`; the 409 branch that would surface a raw Prisma message is live code but I did not force a Prisma-internal error.)
- **amend leg — runtime (jane owner of her Space, XFF 10.1.0.6):** `POST …/wealth/amend` → **503** `{"error":"Updating past net worth is temporarily unavailable…","code":"AMENDMENT_DISABLED"}`. The F1 flag `HISTORICAL_AMENDMENT_ENABLED` is **off**, so the route returns 503 *before* the try/catch — **the raw-`e.message` branch on this route is unreachable dead code on this build.**
- **Classification:** PARTIAL — pattern confirmed in code; decide passes raw messages at runtime; amend's raw path is gated out.
- **Severity:** P3 / high. **Remediation:** map known error classes to generic messages; never return `e.message` to clients.

## ARCH-003 — Inconsistent client-IP extraction; limiter XFF-keyed and spoofable — CONFIRMED

- **Code (verified):** `lib/rate-limit.ts:247-254 getClientIp()` reads `x-forwarded-for` → `x-real-ip` → `"unknown"`, and **never `cf-connecting-ip`**. `lib/auth.ts:172-175` (authorize) and `lib/api.ts` getRequestMeta prefer `cf-connecting-ip` first. Two subsystems, two header orders.
- **Method (register limiter, limit 5/900s, empty bodies ⇒ 400 past the limiter, 429 when limited):**
  - 7 POSTs at `XFF=10.1.0.30`: `400 400 400 400 400 429 429` (bucket fills at 6th).
  - Same `XFF=10.1.0.30` + `cf-connecting-ip: 203.0.113.9` → **429** (cf-connecting-ip ignored).
  - Fresh `XFF=10.1.0.31` → **400** (not limited — bucket keyed solely on XFF).
  - No XFF, only `cf-connecting-ip: 203.0.113.50` → **400** (not limited; cf never consulted; missing XFF degrades to a shared `"unknown"` bucket).
- **Actual:** the limiter bucket is a pure function of client-supplied `x-forwarded-for`; an attacker who can set that header rotates buckets at will, while audit/auth record a *different* IP. (Also the mechanism the README notes lets workstreams avoid sharing buckets.)
- **Severity:** P1. Confirmed as an inconsistency + XFF-spoofable limiter. **Production exploitability UNVERIFIED** — depends on whether Cloudflare fronts Vercel and whether Vercel strips/overwrites inbound `x-forwarded-for` (I cannot determine the Production edge topology from the dev instance). **Remediation:** one shared IP helper, trusting the same platform header everywhere.

## TEST-002 / 003 / 004 — testing gaps

- **TEST-002 — CONFIRMED:** `find app/api -name route.ts` = **187**; `route.test.ts` = **6** (`users/search`, `health`, `ai/memory`, `ai/chat`, `accounts/[id]/transactions`, `spaces/[id]/activity`). Route-handler coverage is ~3% of routes; the depth claim ("mirrors/text, ~1 real handler") is consistent with the cited mirror tests. SUPPORTED-to-CONFIRMED on counts.
- **TEST-003 — SUPPORTED:** no gate enumerates every fm_app-granted table and asserts an RLS policy exists. `scripts/rls-acceptance.ts` and `lib/platform/db-authority.ts` operate a per-file owner-client ratchet; the only "census" in the tree is `coverage_census` in `rls-ai-acceptance.ts` (AI read-coverage, a different concept). Absence confirmed by inspection; the live db-authority endpoint reports 62/70 tables FORCE (8 gaps) — consistent with there being no coverage gate.
- **TEST-004 — CONFIRMED:** `app/api/auth/**`, `app/api/user/totp/**`, `app/api/user/sessions/**` each have **0** `*.test.ts`. Authentication flows have no handler-level tests (release-checklist makes them manual).

---

### Artifacts (under `$S/rtv/sec/`)
- `admin_body.html` — SSR'd `/admin` rendered by a TOTP-pending session after the `update` mutation (SEC-001).
- `export_extract/accounts.csv` — unescaped `=` formula cell (SEC-004).
- `jane_spaces.json` — jane's Space ids used for the amend probe.

### Housekeeping
- Created jar `cookies/sysadmin.txt` (its token was mutated to `requireTotpSetup=false` for SEC-001; not relied on by other workstreams — sysadmin was not a pre-seeded jar).
- SEC-004 fixture account deleted; SEC-008 created one `@rtv.invalid` user (harmless).
- OpenAI mock untouched; no AI/chat/brief requests sent; no Plaid paths triggered; server not restarted.
