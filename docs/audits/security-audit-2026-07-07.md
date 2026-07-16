# Fourth Meridian — Security Investigation

**Date:** 2026-07-07
**Type:** Investigation only — no code changed, no fixes applied.
**Method:** Direct source review of the auth stack, all 95 API route guards, encryption, secrets handling, background-job auth, injection/SSRF surfaces, and dependencies. Every finding below cites the file it came from. Where I couldn't verify something, I say so.

**Overall:** The security engineering here is genuinely strong — materially above the median for a pre-launch product. The core primitives (encryption, password/token hashing, session revocation, route-auth coverage) are correct. The findings below are mostly **hardening and defense-in-depth**, not open holes. There is **one design gap worth prioritizing** (forced-2FA not enforced at the API layer) and a **routine dependency-patch item**. I found no committed secrets, no SQL injection surface, no unauthenticated data routes, and no obvious IDOR.

---

## Severity summary

| # | Finding | Severity | Type |
|---|---------|----------|------|
| 1 | Forced-TOTP enrollment enforced only at page middleware, not on `/api/*` | **Medium** | Authorization / defense-in-depth |
| 2 | 5 moderate dependency vulnerabilities (`next`/`next-auth`/`uuid`) | **Medium** | Supply chain |
| 3 | CSP shipped in Report-Only mode (not enforced) | **Medium** | XSS mitigation (known/documented) |
| 4 | User enumeration via registration 409s + login timing side-channel | **Low–Medium** | Info disclosure |
| 5 | Login rate-limit IP extraction trusts `x-forwarded-for` (ignores `cf-connecting-ip`) | **Low–Medium** | Rate-limit evasion |
| 6 | `CRON_SECRET` compared with non-constant-time `!==` | **Low** | Timing (hard to exploit) |
| 7 | Weak password policy (8-char minimum, no breach/complexity check) | **Low** | Credential strength |
| 8 | Security-relevant `console.log` on every session check | **Low** | Log hygiene |

---

## Strengths (verified, concrete)

These are load-bearing and worth stating plainly, because they're what makes the residual findings minor:

- **Encryption (`lib/plaid/encryption.ts`):** AES-256-GCM with HKDF-SHA-256 **per-purpose subkey derivation** from one root key, and **versioned ciphertext** (`v1` legacy root-key / `v2` derived-key) with dual-format reads — key rotation with zero data migration. Purpose isolation means compromising/rotating one field's key doesn't touch the others.
- **Password & token hashing, each correct for its entropy:** user passwords use bcrypt cost **12** (`register/route.ts:91`); recovery codes bcrypt cost 10, consumed atomically (`lib/recovery-codes.ts`); the password-reset / email-verification tokens are **`crypto.randomBytes(32)` (256-bit) stored SHA-256-hashed at rest** with exact-match lookup and 1h single-use TTL (`lib/password-reset-token.ts`). The reasoning — fast hash for a high-entropy server token, slow hash for low-entropy human passwords — is explicitly documented and correct.
- **Complete route-auth coverage.** Every one of the 95 API routes self-authenticates. The only routes with no session guard are legitimately public: `auth/*` (register, login, verify-email, forgot/reset password, pre-login, email confirm) and `health`. All data routes resolve identity via `getSpaceContext()` (`lib/space.ts` — reads the live NextAuth session, **throws if unauthenticated**, validates Space membership, and falls back to the user's own Personal Space), so resource queries are scoped to a Space the caller actually belongs to. No unauthenticated data route; no obvious IDOR.
- **No SQL injection surface.** The only raw query in the codebase is a hardcoded `db.$queryRaw\`SELECT 1\`` health ping (`app/api/health/route.ts:35`). Everything else is Prisma's parameterized query builder.
- **Minimal SSRF surface.** The only outbound `fetch()` calls in `lib/` are the two FX providers hitting **fixed vendor URLs** (`lib/fx/providers/frankfurter.ts`, `openExchangeRates.ts`) with `AbortSignal.timeout`. No user-controlled hosts. (Crypto sync is currently a stub — see caveats — so no per-address fetch exists yet.)
- **Session revocation despite stateless JWT.** `lib/auth.ts` `session()` callback checks `UserSession.revokedAt` against the DB, cached 30s for low-stakes reads, with `requireFreshUser()` / `requireFreshSystemAdmin()` (`lib/session.ts`) bypassing the cache for sensitive actions (password change, disabling 2FA, regenerating recovery codes, revoking sessions).
- **No secrets in the repo.** `.gitignore` ignores `.env` and `.env.*` (except `.env.example`); `git ls-files` shows only `.env.example` tracked, and a pattern scan of tracked files found no keys.
- **Auth hardening breadth in `authorize()`:** per-identifier rate limit *before* any user lookup, email-verification gate (no admin exemption), deactivation/pending-deletion lockout legs, TOTP + recovery-code enforcement, generic `CredentialsSignin` to the client (no reason leaked to the caller), audit-log on every failure path.
- **Cron endpoints fail closed:** `if (!cronSecret || authHeader !== ...) return 401` (`app/api/jobs/dispatch/route.ts`) — a missing `CRON_SECRET` denies, and `lib/env.ts` requires it in production. `withApiHandler` returns a generic `Internal server error` (no stack leak), and `getRequestMeta()` prioritizes `cf-connecting-ip` (unspoofable behind Cloudflare) for audit IPs.
- **The privacy-leak class is closed with a shared predicate.** KD-1/KD-15/KD-19 (visibility tiers leaking into read paths) were fixed by routing the data layer and the AI assemblers through the *same* `grantsTransactionDetail` / `grantsAccountDetail` predicate (`lib/ai/visibility.ts`), so a UI read path and the AI can't diverge — verified in `app/api/accounts/[id]/transactions/route.ts:39`.

---

## Findings (detail, evidence, remediation direction)

### 1 — Forced-TOTP enrollment is not enforced on the API layer — **Medium**

**Evidence.** `proxy.ts` (the Next 16 middleware) is the *only* place that acts on `token.requireTotpSetup`, redirecting un-enrolled users to a setup page. But its `matcher` is:

```
matcher: ["/dashboard/:path*", "/admin/:path*"]
```

`/api/*` is **not matched**, and the middleware explicitly allow-lists `/api/auth` and `/api/user/totp` even within matched paths. `requireUser()` / `requireSystemAdmin()` / `requireSpaceRole()` (`lib/session.ts`) and `getSpaceContext()` do **not** check `requireTotpSetup`.

**Impact.** When the platform policy requires 2FA for a role (`require_totp_all_users` / `require_totp_system_admin`), a user who logged in with password only is issued a **fully valid session** flagged `requireTotpSetup=true` (`lib/auth.ts:203-217, 385`). The middleware bounces their *browser* to the enrollment page, but their JWT can call any `/api/*` data route directly (curl/fetch) without ever enrolling. For a `SYSTEM_ADMIN` under a TOTP mandate this means admin APIs are reachable during the setup-pending window without the mandated second factor. This is a policy-enforcement gap, not account takeover (the password was still proven), but it defeats the intent of "forced" enrollment.

**Direction.** Enforce `requireTotpSetup` server-side inside the shared session helpers (deny non-enrollment API calls with a 403 that the client maps to "complete 2FA setup"), so the guarantee lives at the authorization layer rather than the redirect layer.

### 2 — Dependency vulnerabilities — **Medium**

**Evidence.** `npm audit --omit=dev` reports **5 moderate** vulnerabilities: a `next-auth` advisory chain that "depends on vulnerable versions of `next`," and `uuid <11.1.1` (GHSA-w5hq-g745-h8pq, missing buffer bounds check in v3/v5/v6) pulled in transitively via `next-auth` and `exceljs`. Running `next@16.2.7`, `next-auth@4.24.14`.

**Impact.** The `uuid` issue only triggers when a caller passes a `buf` argument, which these transitive users don't expose to end users, so practical exploitability is low. The `next`/`next-auth` chain is the one to actually triage — framework advisories can be reachable. I could not fully enumerate the specific Next.js CVE offline.

**Direction.** Triage the `next`/`next-auth` advisory against your deployed version; patch `uuid` transitively (`npm audit fix`, avoiding the `--force` path that would downgrade `exceljs`). Add `npm audit` (or Dependabot/Renovate) to CI so this is continuous.

### 3 — CSP is Report-Only — **Medium (known)**

**Evidence.** `next.config.ts` ships `Content-Security-Policy-Report-Only` (confirmed in STATUS OPS-1 S5 and the config). All other headers (HSTS 180d, `X-Frame-Options: DENY`, nosniff, Referrer-Policy, Permissions-Policy) are enforced.

**Impact.** The single highest-value XSS mitigation observes but does not block. For a financial app rendering AI output and `react-markdown` content, an enforced CSP is meaningful defense-in-depth.

**Direction.** This is already a planned "flip after a clean report-only window." The finding is: don't let that window run indefinitely — the enforce flip is a launch-gating item, not a nice-to-have.

### 4 — User enumeration — **Low–Medium**

**Evidence.** Registration returns distinct statuses: `409 "An account with that email already exists."` and `409 "That username is already taken."` (`register/route.ts:87-88`). Separately, `authorize()` returns early *without* running `bcrypt.compare` when the user isn't found (`lib/auth.ts:90-99`), so a non-existent identifier responds measurably faster than a wrong password on a real account — a timing oracle. The two-step `pre-login` endpoint also surfaces verification state.

**Impact.** An attacker can reliably determine which emails/usernames have accounts — useful for targeted phishing/credential-stuffing. Common and often an accepted UX trade-off, but worth a conscious decision for a finance product.

**Direction.** For registration, a generic "if that address is available you'll receive a confirmation email" flow removes the oracle at the cost of some UX. For login timing, run a dummy bcrypt comparison on the not-found path to equalize response time. At minimum, document these as accepted.

### 5 — Login IP extraction ignores `cf-connecting-ip` — **Low–Medium**

**Evidence.** `authorize()` derives the rate-limit/audit IP from `x-forwarded-for` then `x-real-ip` (`lib/auth.ts:56-58`), whereas `getRequestMeta()` in `lib/api.ts` correctly prioritizes the unspoofable `cf-connecting-ip`. The two paths disagree.

**Impact.** Behind Cloudflare, `x-forwarded-for` is client-influenceable, so the **per-IP** login limit can be diluted by rotating the header. The **per-identifier** limit (10/900s keyed on the submitted identifier, checked before lookup — `lib/auth.ts:71`) still caps brute-force against any single account, which is the more important control, so this is evasion of the coarse layer only.

**Direction.** Use the same `cf-connecting-ip`-first extraction (`getRequestMeta`) everywhere an IP is used for a security decision.

### 6 — Non-constant-time `CRON_SECRET` comparison — **Low**

**Evidence.** All four job routes use `authHeader !== \`Bearer ${cronSecret}\`` (`app/api/jobs/dispatch/route.ts:44` and siblings).

**Impact.** Theoretically a timing side-channel on the bearer token. In practice, remote timing attacks across HTTP against a high-entropy secret are dominated by network jitter and are not realistically exploitable. Still a trivial, standard hardening.

**Direction.** `crypto.timingSafeEqual` on equal-length buffers.

### 7 — Weak password policy — **Low**

**Evidence.** Registration enforces only `password.length < 8` (`register/route.ts:69`). No complexity, no `zxcvbn`, no breached-password (HIBP k-anonymity) check.

**Impact.** 8-char minimum is a floor, not a wall; weak/breached passwords remain acceptable. bcrypt-12 protects at-rest but not against credential stuffing of a reused weak password.

**Direction.** Add a breached-password check and/or a strength estimator at registration and password change.

### 8 — Verbose security logging — **Low**

**Evidence.** The `session()` callback and `requireFreshUser`/`requireFreshSystemAdmin` `console.log` revocation timing and `valid=<bool>` on essentially every authenticated request (`lib/auth.ts:439,447`; `lib/session.ts:136,184`).

**Impact.** No tokens or secrets are logged, but it's high-volume operational noise that can bury real signal and marginally aids an attacker with log access. Left over from the latency investigation.

**Direction.** Downgrade to debug-gated logging before production.

---

## Areas checked that were clean

- **SQL injection** — none; Prisma parameterized throughout (only a static `SELECT 1`).
- **Secrets in VCS** — none tracked; `.env*` fully ignored.
- **Unauthenticated data routes** — none; only public auth/health endpoints are unguarded.
- **IDOR** — resource reads are Space-scoped through membership-validated `getSpaceContext()`; the account-transactions route additionally gates on the visibility tier of the *caller's* Space link.
- **Error leakage to clients** — `withApiHandler` returns generic 500s; the `credit/update-fico` handler logs server-side and returns a generic message.
- **Stack/secret exposure in `/api/health`** — a test explicitly asserts the body contains no env-var names.

---

## Caveats & limits of this review

- **Dynamic testing was not performed** — this is a static source review. No live requests, no fuzzing, no authenticated session was exercised. Timing-oracle and rate-limit-evasion findings are reasoned from code, not measured.
- **Crypto/market-data connectors** (`lib/crypto-apis.ts`, `lib/market-data.ts`) contained no `fetch`/URL construction at review time (consistent with `sync-crypto` being a stub per KD-14). **Re-audit the SSRF surface when live per-address/exchange fetching is implemented** — that's where user-influenced outbound requests would first appear.
- **CSV import pipeline** (`lib/imports/*`, papaparse) was not deep-reviewed for CSV-formula-injection on export or parser-DoS on malicious uploads — worth a dedicated pass before enabling untrusted imports at scale.
- **The specific Next.js advisory** behind the `npm audit` chain could not be pinned offline; triage against your deployed `next@16.2.7`.
- I reviewed the code as it exists on disk; I did not verify production environment configuration (actual header values served, `RATE_LIMIT_ENABLED`, CSP report endpoint, WAF/Cloudflare rules), which materially affect real-world posture.

---

## Prioritized remediation order

1. **Enforce `requireTotpSetup` server-side** in the session helpers (Finding 1) — closes the one real authorization gap.
2. **Triage & patch dependencies**; add `npm audit` to CI (Finding 2).
3. **Flip CSP to enforce** after a clean report window; treat as launch-gating (Finding 3).
4. **Unify IP extraction** on `cf-connecting-ip` for all security decisions (Finding 5).
5. **Decide on enumeration** posture; equalize login timing, generic registration response (Finding 4).
6. Housekeeping: `timingSafeEqual` for cron (6), breached-password check (7), quiet the session logging (8).
7. Before enabling them: dedicated passes on the **CSV import** parser and the **crypto connector** SSRF surface.
