# 07 — Security and Privacy

Integration branch `remediation/beta-1`. Detail per finding: `agent-reports/A-security-privacy.md` (A), `C-idempotency-data.md` (C, database grants), `D-ai-reliability.md` (D, AI data minimisation). Test evidence: `04-TEST-EVIDENCE.md`.

## 1. Authentication and MFA

| Finding | Was | Now | Commit | Proof |
|---|---|---|---|---|
| **SEC-001** (P1, runtime-confirmed) | A browser `update()` could set `requireTotpSetup=false`; the admin and dashboard layouts never re-checked; a password-only admin rendered the user inventory | A client update may change only `username` (allow-list); the TOTP hint is re-derived from the session store on every update, failing closed; `/admin`, `/admin/*` pages and the dashboard layout call one page gate (`lib/auth/page-gate.ts`) that redirects any pending session to its enrolment surface, and `app/admin/page.tsx` gates before its inventory query | `e151e0e` | `lib/auth/token-update.test.ts` replays the exact runtime attack against the **real NextAuth handler** (csrf → `POST /api/auth/session {requireTotpSetup:false}`) and proves the session stays pending; `lib/auth/page-gate.test.ts` decision table + wiring pins |
| **SEC-006** | Admin 2FA reset accepted `adminTotpCode` unverified; SYSTEM_ADMIN targets allowed | Actor's live TOTP verified; SYSTEM_ADMIN targets refused; target notified; audit uses an e-mail digest | `c6f867e` | route tests |
| **SEC-010** | 30-day rolling JWT only | Session refused when idle > 30 days or older than 90 days (`judgeSessionLifetime`), on the API and session paths | `3f636f5` | fixed-clock tests |
| **SEC-008** (P1, config) | Code default `open` | Code default `invite_only`; an absent or unrecognised row fails closed | `aa50094` | `lib/registration-default.test.ts` |
| **SEC-005** | Any user could walk the directory with 1-character queries, unthrottled | ≥ 3 characters or exact `@username`; per-user limit | `d783746` | route tests |
| SEC-009 | `CRON_SECRET` compared with `!==` | timing-safe helper adopted in all six job routes | `8369a8c` (A), `2c3cb54` (C) | tests |
| SEC-013 | Raw `e.message` on merchant-ops decide | domain refusal only; other errors get a fixed message | `c82d604` | `raw-message.test.ts` |
| UI-004 / UI-005 / UI-022 | Permanent Space delete on cached auth; no limits on invite/correct; unbounded admin lists | fresh auth; 20/h and 60/h limits; bounded `take` | `51b5c56`, `c7444cf`, `1e9a89b` | pins |

## 2. Network identity and rate limiting (ARCH-003, P1)

One extractor (`lib/security/client-ip.ts`) for the limiter, audit and login. Trust order: `cf-connecting-ip` only when `CLIENT_IP_TRUST_CLOUDFLARE=true` (default off) → `x-vercel-forwarded-for` → `x-real-ip` → the **last** `x-forwarded-for` hop → one shared `unknown` bucket. A spoofed first XFF hop no longer rotates buckets. A census test fails if any other production file reads an IP header. **Owner:** confirm the Production edge (Vercel-direct or Cloudflare) and set the flag if Cloudflare fronts every request.

## 3. Database privileges (found and closed by C)

| Finding | Change | Migration |
|---|---|---|
| **SEC-014** | `fm_app` held INSERT/UPDATE/DELETE on `PlatformGrant` with permissive policies. No application path wrote it (latent), but a tenant-transaction bug or SQL-level compromise could have self-granted platform access. Writes revoked, SELECT kept | `20261022000500_sec014_platform_grant_read_only` |
| DB-004 | `RateLimit` had no RLS while `fm_app` held CRUD | ENABLE + FORCE; `fm_app` reaches only its own `user:*:<id>` buckets | `20261022000600_db004_rate_limit_rls` |
| DB-006 | No statement timeouts | `fm_app` 15 s, `fm_auth` 5 s, `fm_system` 60 s, conditional on role existence (needs `ALTER ROLE` rights on Supabase; else applied by hand — owner) | `20261022000700_db006_role_statement_timeouts` |

## 4. Dependencies and supply chain (SEC-002, TEST-005)

`next` 16.3.8, `next-auth` 4.24.15, transitive highs resolved: `npm audit --omit=dev` 14 (2 critical, 9 high) → 2 moderate. CI now runs `npm audit --omit=dev --audit-level=high`; Dependabot configured. Commit `e4c4031`.

## 5. Privacy

| Finding | Change | Commit | Residual |
|---|---|---|---|
| **SEC-AI-005** (P1) | Shared scrub (`lib/ai/privacy/scrub.ts`: digit runs ≥ 4 and `#`/`*` markers removed, 40-char clip) on every tool row with a descriptor/merchant; raw `description` no longer sent | `b4f8bc3` | — |
| **PRIV-010** (P1) | AI legal page enumerates what is actually sent (app and `site/` copies kept byte-identical) | `7102cc6`, `8d5856d` | **counsel review** |
| **PRIV-011** (P1) | Point-of-use sentence: conversation and Brief inputs are processed by OpenAI | `a667708` | counsel review |
| **PRIV-012** (P1) | Waitlist privacy notice + required consent (client and server); retention 180 days; deleted on account purge | `3d65608`, `26308c7`, `d3aa0ed`, `b9fe5fd` | counsel review; whether the operator intake e-mail keeps the applicant's note (owner) |
| **PRIV-001** (P1) | Sole-member SHARED Spaces and their accounts are deleted on purge | `b9fe5fd` | — |
| **PRIV-002** (P1) | Audit metadata references e-mails by digest on forgot/reset, beta approve/deny/resend/invitations, 2FA reset | `fa5d401` | historical rows keep raw e-mails until scrubbed (one-off owner-run script; not written) |
| PRIV-003 | Retention schedule for nine ledgers (`docs/operations/data-retention.md`) | `d3aa0ed` | trash hard-purge window = owner decision |
| PRIV-004 | Plaid token wiped after confirmed `itemRemove` | `1202478` | key rotation script deferred |
| PRIV-015 | Sentry breadcrumbs: console breadcrumbs dropped, query strings stripped | `4adc094` | `link-token` raw `plaid_error_data` log remains |
| SEC-004 | CSV export neutralises formula cells | `55b0b5c` | — |

## 6. Preserved controls (verified)

Session-row proof, `__Host-` cookies, write-origin CSRF boundary, fail-closed auth limiter, admin break-glass, AI kill switch, fail-closed allowance reservation, cross-user AI isolation (403 on Space mismatch), RLS acceptance suites — see `04` for the integrated-branch results.

## 7. Open (owner / deferred)

SEC-018 repository visibility (decision); Turnstile keys; `CLIENT_IP_TRUST_CLOUDFLARE` registration in `lib/env.ts`; counsel review of three texts; SEC-003 migration-principal residue (RLS-cutover programme); SEC-011 CSP enforcement; SEC-012 TOTP replay; SEC-AI-006 memory-field injection; PRIV-005 append-only audit; PRIV-006/007/008/009/013/016.
