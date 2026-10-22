# 20 — Production readiness assessment (pre-beta)

**Date:** 2026-10-22, finalised 2026-10-23 after A6/A7 (doc 19). §0 rows marked ⟳ were superseded by the A6 run; the verdict is in §17.
**Method:** read-only. The sources were repository documents, `git log`/`git show`, and `gh api` GET calls for branches, protection, rulesets, visibility, PR #1 and check runs. No database, Vercel, Supabase, Plaid, OpenAI or Resend connection was made, and no build or test was run.
**Labels:** **DONE** = closed with evidence · **PARTIAL** = some of it closed · **OPEN** = engineering can close it · **OWNER** = needs owner credentials, a decision or a live action · **UNVERIFIED** = could not be read from here.

## 0. Facts this assessment rests on

| Fact | Value | Evidence |
|---|---|---|
| Production app | Vercel `fintracker1` Production serves `87e4df7` (2026-07-27) on `fourthmeridian.com` | doc 17 §0; `production-cutover-plan.md` §1; `gh api …/branches/main` → `87e4df7` |
| Production DB | Supabase `fourth-meridian-production` (`qirfzvvaeddukjiphims`), Micro, PG 17.6, ap-southeast-1 | cutover plan §1 "Database" |
| Production migration count | **UNVERIFIED today.** Last measured 2026-10-06 at **88 applied**, newest `20260727_v26pre_b4_btc_identity_backstop` | cutover plan §1 |
| Integration | ⟳ `v2.6` = **`7d1cee7`** (PR #1 merged as `0773008`, then PRs #2–#4); Preview `preview-app` serves it | doc 19 §1 |
| Candidate | ⟳ security bump pushed and merged (`32114c9`, `a72a83d`): next 16.4.2, Sentry 10.76.2 | doc 19 §1 |
| PR #1 | ⟳ **MERGED** 2026-10-22 20:10:23 UTC at head `a72a83d` → `0773008` | doc 19 §1 |
| CI | ⟳ green on every merged head (`a72a83d`, PRs #2–#4) except the secret-free `Deployment health` (UNVERIFIED by design); the trusted push-time health check probes the app HEALTHY on `v2.6` | doc 19 §1–§2 |
| Preview DB | 135 migrations applied (A5, 2026-10-22 19:29 UTC) | doc 18 §0, §5; RESUME-CHECKPOINT |
| Repository | `virtuarch/FourthMeridian`, **public**; default branch `main` | `gh api repos/…` → `visibility: public` |
| Branch protection / rulesets | none on `main`, `v2.6` or `remediation/beta-1` (each `…/protection` → 404); rulesets `[]` | gh api, 2026-10-22 |

## 1. Production backup and PITR requirements

| Requirement | Status | Evidence | Gap |
|---|---|---|---|
| Supabase plan entitles daily backups | DONE (org level) | doc 17 §2: org VirtuArch on **Pro**, covering both projects | — |
| Production backup cadence, newest backup, retention read and recorded | **UNVERIFIED** | only Preview was read (doc 17 §2: 7 daily PHYSICAL backups, WAL archiving healthy). Checklist C1 is unticked | owner reads Dashboard → Database → Backups for `qirfzvvaeddukjiphims` |
| PITR on Production | **UNVERIFIED** (Preview: DISABLED) | doc 17 §2; `11` G0c: "Decide PITR for Production before beta (paid add-on)" | owner decision. Without PITR the platform RPO is up to about 24 h |
| `fm_backup` role exists with a password | OPEN | the role is created by migration `20261002000100` (not yet on Production, §3); `backup-restore-verification.md` §2 | after migration: set the password, verify `t,f,f,f,t` (checklist C2) |
| Pre-cutover logical dump with sha256 | OPEN | cutover plan §5 A1; checklist C3 | executed on cutover day |
| Local-dump policy (encrypt or delete within 24 h) | procedure exists | `backup-restore-verification.md` §7; checklist C6 | applied per dump |

`fm_backup … BYPASSRLS` creation on Supabase was flagged UNVERIFIED in checklist B5. Preview's preflight shows `fm_backup` present with `ADMIN` held by `postgres` (doc 18 §3), so the migration does create it on Supabase PG 17.6. That half of B5 is effectively answered for Supabase. Production itself is not yet proven.

## 2. Restore and rollback strategy

| Element | Status | Evidence |
|---|---|---|
| Timed restore rehearsal with RPO/RTO (the G0 line item) | **OPEN: no row recorded** | `backup-restore-verification.md` §6 table reads "_none yet_". Checklist C4 unticked |
| Logical restore into PG 17.6 proven (Preview data) | DONE for Preview | doc 16 §2 (21,081 rows, every grant and policy); doc 18 §4 (71 tables row-hash identical; 1,196 catalog lines identical) |
| Physical (platform) restore preserves roles and grants | UNVERIFIED (inferred from "PHYSICAL") | doc 17 §2 "Roles and grants" |
| Restore targets offered | in-place (destructive) or "restore to new project (beta)" | doc 17 §2 |
| Known restore caveat | `ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin` fails outside Supabase. Run without `--exit-on-error` | doc 18 §4 "Recovery note" |
| App rollback | `vercel promote <previous>` swaps the alias atomically. The old app tolerates the new schema (BYPASSRLS `postgres`) | cutover plan §5 "Vercel facts", §2 verdict, §9 |
| App rollback caveat | promoting `dpl_JcZ52…` (87e4df7) **reopens the shared-`NEXTAUTH_SECRET` session defect**, and its crons may 401. For total outage only, then fix forward | cutover plan §9 row H |
| Schema rollback | none (no down migrations). Fix forward. Never `DISABLE ROW LEVEL SECURITY` | `migration-safety.md` §3; cutover plan §9 |
| Emergency "unset strict" lever | **does not exist on Production**: the candidate refuses to boot in Production without strict mode (`dc3755f`) | cutover plan §9 last paragraph; `lib/db/strict-mode.ts:246-259` |

**Assessment.** The strategy is fix-forward with a pre-migration dump. That is coherent, but its one recovery mechanism, the restore, has never been timed against Production-shaped data. RTO is unmeasured.

## 3. Production migration plan

**Pending set (derived; the live count is UNVERIFIED).** The repository has 135 migration directories (`ls prisma/migrations`). `87e4df7`/`main` carries 88. If Production is still at the 88 measured on 2026-10-06, it needs **47**: 38 from `v2.6` plus the 9 beta migrations. Nothing in the documents records a Production migration after 2026-10-06, but that is not proof.

| # | Range | Count | Class | Classified against the old app (87e4df7)? | Source |
|---|---|---|---|---|---|
| 1–19 | `20260801_*` … `20261001120000_connection_facet_freshness` | 19 | additive schema | yes: compatible | cutover plan §2 rows 1–19 |
| 20 | `20261002000000_tenancy_integrity` | 1 | constraint (data-dependent, RAISEs) | yes: compatible if preflight 0/0/0 | §2 row 20 |
| 21–28 | `20261002000100` … `20261003000100` (roles + RLS on 56 tables) | 8 | RLS / role / grant | yes: inert for `postgres` BYPASSRLS | §2 rows 21–28 |
| 29 | `20261004000000_plaid_identity_global_exclusivity` | 1 | partial unique index | yes | §2 row 29 |
| 30 | `20261006000000_rls_function_execute_least_privilege` | 1 | grant | yes | §2 row 30 |
| 31 | `20261006010000_platform_area_merchant_ops` | 1 | enum ADD VALUE | yes: seed Merchant Ops only **after** promotion | §2 row 31 |
| 32–34 | `…sync_origin_cursor`, `…provider_subtype`, `…operationalization_p0_facts` | 3 | additive (+2 RLS-forced tables) | yes | cutover plan addendum |
| 35–38 | `20261008000000_p1_customer_policy_cohort`, `20261015100000_plaid_item_environment`, `20261015120000_rls_asset_valuations`, `20261016000000_customer_ai_allowance_override` | 4 | additive + RLS (inferred from names) | **NO: not in the cutover plan** | `ls prisma/migrations` |
| 39–47 | the nine `20261022000000` … `20261022001000` | 9 | additive columns/indexes; SEC-014 REVOKE; DB-004 RateLimit RLS; DB-006 role statement timeouts; index rename | **against `cde8fa0` only** (doc 18 §3 gate 9), not against `87e4df7` | doc 18 §2–3 |

**Data steps outside migrations:**
- `scripts/backfill-economic-date.ts`: run after the migrations and again after promotion (cutover plan §2; Production about 4,909 rows).
- `scripts/seed-platform-spaces.ts`: run after promotion (step I).
- Optional, owner decision D6: `scripts/backfill-flowtype.ts` for corrections made before FIN-002.
- G6: `scripts/scrub-audit-emails.ts`.

| Plan element | Status | Evidence |
|---|---|---|
| Ordered runbook (A1–K, staged-then-promote) | exists. **Stale counts**: it says 31 pending (88→119), with an addendum saying 34; reality is about 47 (88→135) | cutover plan §5 step B, §10.2 |
| Checklist B1 inventory | stale: it quotes "126 at HEAD" | `production-cutover-checklist.md:21` |
| Clone rehearsal on Production's rows (PG 17.6): migrate, backfill, `audit:ci`, `rls:accept` | **OPEN** | cutover plan §6.6 and §8 issue 4; checklist B5; `11` G0b ("local proof is PG16 only"). Preview (PG 17.6) now runs 135 under strict RLS, which is partial evidence |
| Drift check within 1 h of step B | OPEN (procedure exists) | checklist B3; `11` G7 |
| Data preflight zeros re-read | OPEN (last read 2026-10-06: zeros) | cutover plan §1 "Data preflight"; checklist B4 |
| Old-app compatibility of migrations 35–47 | **OPEN** | not written down. Likely inert because the old app runs as BYPASSRLS `postgres`, but this is unproven |
| DB-006 `ALTER ROLE` rights on Supabase | DONE on Preview (applied directly, no NOTICE) | `11` §A.3; doc 18 |

## 4. Environment variable inventory for Production (names only)

The boot gate is `lib/env.ts:293-331`. `REQUIRED_KEYS` applies in every environment. `PROD_REQUIRED_KEYS` applies when `VERCEL_ENV=production`. There are further boot refusals at `lib/env.ts:499-518` (Plaid) and `lib/db/strict-mode.ts:246-259` (role URLs).

| Name | Gate | Production state (last read) | Action at cutover | Evidence |
|---|---|---|---|---|
| `DATABASE_URL` | REQUIRED | present (username form UNVERIFIED) | owner confirms the `postgres.<ref>` form | cutover plan §3, §8 issue 6 |
| `DIRECT_URL` | migrations only | present | keep for migrations. Remove from runtime later (class C) | `environment-separation.md` §4 |
| `NEXTAUTH_SECRET` | REQUIRED | **shared Production+Preview record** (2026-06-16) | split, then a new Production-only value (forced sign-out) | cutover plan §4 |
| `ENCRYPTION_KEY` | REQUIRED | shared record | **unchanged** (no keyring; rotating it strands ciphertext) | cutover plan §4; `key-rotation.md` |
| `NEXTAUTH_URL`, `NEXT_PUBLIC_APP_URL` | PROD_REQUIRED | present | verify the apex values | `lib/env.ts:310-311` |
| `RESEND_API_KEY` | PROD_REQUIRED | present (own record) | verify sending scope | `lib/env.ts:312` |
| `CRON_SECRET` | PROD_REQUIRED | present (own record) | rotate before the staged build | `lib/env.ts:313`; cutover plan §4 |
| `NEXT_PUBLIC_SENTRY_DSN` | PROD_REQUIRED | present | — | `lib/env.ts:323` |
| `PLATFORM_ALERTS_EMAIL` | PROD_REQUIRED | brief: separate Production row exists (Sensitive; value unread). Absent on 2026-10-07 | verify it is a monitored mailbox | `lib/env.ts:330`; orchestrator brief 2026-10-22 (row list, values unread) |
| `DATABASE_URL_APP` / `_AUTH` / `_SYSTEM` | strict-mode boot refusal in Production | **absent** | add (SCRAM role passwords first) | cutover plan §1, §5 D |
| `FM_RLS_STRICT` | Production requires strict | **absent** | `true` | `environment-separation.md` §4 |
| `PLAID_CLIENT_ID` | optional (both keys ⇒ Plaid on) | shared record (by design) | — | `environment-separation.md` §4 |
| `PLAID_SECRET`, `PLAID_ENV` | `PLAID_ENV` must be `production` when Plaid is configured | separate Production rows | verify `production` | `lib/env.ts:509-518` |
| `OPENAI_API_KEY`, `OPENAI_PROJECT_ID`, `OPENAI_EXPECTED_ENVIRONMENT` | optional; the seam refuses on a mismatch | Production rows exist; pin created 2026-10-15; key value replacement **unverifiable** | verify `production` guard + the prod project | `openai-environment-separation.md` §8 |
| `NEXT_PUBLIC_TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY` | optional | **absent** | owner decision (registration is invite-only) | `environment-separation.md` §4; `01` SEC-008 |
| `CLIENT_IP_TRUST_CLOUDFLARE` | optional | unset | set only if Cloudflare fronts the apex (D3) | `11` D3 |
| `RATE_LIMIT_ENABLED`, `DISABLE_SYSTEM_ADMIN`, `QUANTITY_AUTHORITY_MODE`, feature flags | optional / warn | present (values unknown) | confirm rate limiting is not `false`; quantity mode off | `lib/env.ts` report |
| `SECURITY_ALERTS_EMAIL`, `BETA_REQUESTS_EMAIL`, `EMAIL_FROM_DEFAULT`, market and crypto keys | optional | partly present | — | `lib/env.ts:83-135` |

## 5. Secrets and provider isolation

| Item | Status | Evidence |
|---|---|---|
| Provider keys on separate Preview and Production Sensitive rows (`OPENAI_API_KEY`, `OPENAI_PROJECT_ID`, `PLAID_ENV`, `PLAID_SECRET`, `RESEND_API_KEY`, `PLATFORM_ALERTS_EMAIL`) | DONE (structure). Values UNVERIFIED (Sensitive) | brief; `environment-separation.md` §4 |
| `PLAID_CLIENT_ID` shared | ACCEPTED (by design: the secret selects the environment) | same §4 |
| `NEXTAUTH_SECRET` shared Prod+generic-Preview | **OPEN**: rotated at cutover step E | cutover plan §4 |
| `ENCRYPTION_KEY` shared Prod+Preview | DEFERRED (launch debt). No rotation script exists | cutover plan §8 issue 8; `key-rotation.md` "ENCRYPTION_KEY" |
| OpenAI: Production still runs the **legacy pre-split key** baked into `87e4df7`'s build | OPEN until the candidate deploys. The legacy key must not be revoked before then | `openai-environment-separation.md` §8 |
| Preview provider values (D14: sandbox Plaid, non-prod OpenAI, Resend scope) | OWNER (open) | `11` D14; doc 17 §6 |
| Branch builds isolated from shared Preview data (D12) | PARTIAL (interim role URLs; `DATABASE_URL` still the migration principal) | doc 17 §4–5 |
| GitHub secrets | DONE: 0 repository-level secrets; `vercel-probe` environment admits `v2.6`/`main` only, with denial proven | doc 17 §3 |

## 6. CI and branch protection

| Item | Status | Evidence |
|---|---|---|
| CI at the candidate's GitHub head | **RED**: `test` fails on `7d38bf5` | check runs (§0) |
| Fix for the 2026-10-22 advisories | DONE locally in `32114c9` (next 16.4.2, @sentry/nextjs ^10.75.2 → 10.76.2). **Not pushed**, so GitHub has never run it | `git show 32114c9`; gh 422 |
| Dependency gate | DONE: `npm audit --omit=dev --audit-level=high` in `ci.yml:100-101` | `.github/workflows/ci.yml` |
| Dependabot | config on the branch only (`.github/dependabot.yml`); absent on `main`/`87e4df7`. Repo vulnerability-alerts GET → 404 (disabled, or not visible to this token: UNVERIFIED) | `git show`, gh api |
| Branch rulesets on `main` and `v2.6` | **OWNER, not applied**. JSON is ready in `branching-and-protection.md` §4.1/§4.2 | gh api: `[]`; checklist D6 |
| Repository visibility | **OWNER decision pending (public)** | `11` D1; `01` SEC-018 |
| Post-deploy smoke / trusted health | `post-deploy-smoke.yml` secret-free; `trusted-deployment-health.yml` runs on push to `v2.6`/`main` only. First GitHub-side trusted run awaits A6 | doc 17 §3 |
| Local `npm run ci` | last full green on `01098bd` (828/828, 28 audits, RLS suites) | MORNING-HANDOFF §6 |

## 7. Security regression coverage

| Area | Status | Evidence |
|---|---|---|
| All 11 runtime-reproduced P1s encoded as regression tests | DONE (candidate) | `04` §4 |
| Auth handler tests (13 routes + NextAuth) | DONE | `01` TEST-004 |
| Route-guard census, GRANT↔POLICY census, migration names, schema drift | DONE (REQUIRED audits 25 → 28) | `10` §2 |
| RLS acceptance suites | All six green on **PG 17.6** (local `npm run ci` with `FM_CI_PG_IMAGE=postgres:17.6` at `a72a83d`, and on the restored Preview copy in A2); foreground now **71** (+4 Space-creation cases); CI runs PG16. Not run against a Production clone | doc 19 §1, §5; doc 16 §2 |
| Browser / e2e | no automation (TEST-010 deferred). The G8 pass ran 2026-10-22/23 (doc 19 §4) | `01` TEST-010; `11` G8 |
| **Production today** | runs `87e4df7`, which has **none** of these fixes. The SEC-001 pattern is present: `87e4df7:lib/auth.ts:545-547` copies a client-supplied `requireTotpSetup` into the token on `trigger === "update"` (runtime exploit on 87e4df7 not tested; both Production users are TOTP-enrolled, cutover plan §1) | `git show 87e4df7:lib/auth.ts` |
| **Production framework versions** | `87e4df7:package.json`: `next` **16.2.7**, `next-auth` **^4.24.14**, `@sentry/nextjs` **^10.67.0**. All three are inside the ranges flagged by SEC-002 and the 2026-10-22 advisories (next ≤16.4.0: GHSA-2464-fhr4-w9xw, GHSA-673q-mjm6-r5xr; @sentry/nextjs <10.75.2: GHSA-mchm-gjx6-7h55). Exploitability on this build is **UNVERIFIED**: no `"use server"`, `"use cache"` or `images` config at `87e4df7`, but `next/image` is used in 5 files | `git show 87e4df7:package.json`; `git grep` |

## 8. RLS and database privileges

| Item | Status | Evidence |
|---|---|---|
| Production RLS | **NOT ENABLED**: 0 of 55 tables, 0 policies, no `fm_*` roles; the app runs as `postgres` (BYPASSRLS) | cutover plan §1 "Database" |
| Preview RLS | live and strict: 62 FORCE-RLS tables, 246 policies, three role URLs on `v2.6` | doc 18 §3 |
| Candidate privilege fixes | SEC-014 (`PlatformGrant` read-only for `fm_app`), DB-004 (`RateLimit` FORCE RLS), DB-006 (role statement timeouts 15 s/5 s/60 s) | `07` §3; doc 18 §2 |
| Data API exposure on Production | closed (0 tables exposed, 0 grants to `anon`/`authenticated`/`service_role`) | cutover plan §1 |
| Role safety settings at cutover | planned: `idle_in_transaction_session_timeout` 15 s ×3, `postgres` 30 s, pool 15 → 12 | cutover plan §3 |
| Pool sizing under load (DB-005) | OWNER / unmeasured | `01` DB-005/006 |
| Migration-principal residue (SEC-003) | DEFERRED (163 files on `db`) | `12` row A |

## 9. Scheduler and monitoring

| Item | Status | Evidence |
|---|---|---|
| Candidate cron config | `vercel.json`: `/api/jobs/dispatch` **every 15 min** (ledger-driven due-ness since `da015fe`), `/api/jobs/resume-stale-imports` every 5 min | `vercel.json`; `git log -S'*/15'` |
| Production cron config | `87e4df7`: dispatch at `0,30 0,6,7,12,18 * * *` | `git show 87e4df7:vercel.json` |
| **Plan assumption now stale** | the cutover plan's "dispatch-free window 08:00–11:59 UTC" and "first Plaid calls at 06:00 next day" describe the **old** schedule. After promotion the candidate wakes every 15 min and decides due-ness from the ledger, so the first post-promotion wake can run due jobs (Plaid included) within the window | cutover plan §1 "Cron callers", §5 J, §10.8 |
| Every registered job body run once in a deployed v2.6 | **OPEN**: Preview `JobRun` = 1 row ever (2026-10-07) | doc 18 §1; `11` G0a; cutover §8 issue 2 |
| Plaid paths on the candidate (link/sync/refresh/webhook/disconnect) | OPEN on the candidate. The Sandbox lane passed on an earlier SHA | cutover §8 issue 1 (BLOCKS CUTOVER unless owner-accepted); checklist E2 |
| `/api/health` scheduler block | DONE (code) | `external-monitoring.md` §2; `01` OPS-002 |
| Bank sweep budget and continuation; one running job per name | DONE (code) | `01` OPS-001, IDEMP-003 |

## 10. External alerting

| Item | Status | Evidence |
|---|---|---|
| External monitor on the Production `/api/health` with body assertions | **OWNER, not registered** | `external-monitoring.md` §3; checklist E3; `11` G3 |
| Alert delivery proven to a mailbox (`sent`, not `captured`) | **OWNER, never proven** | checklist E4; `12` row I |
| Dead-evaluator runbook walked once on Preview | OWNER | `runbooks/alerting-dead-evaluator.md`; `11` G3 |
| Sentry alert rules (`area:alert-delivery`, `area:operational-ledger`) | OWNER | `11` G3 |
| Sentry receiving from the candidate | OPEN | checklist E6 |

## 11. AI spending limits

| Layer | Status | Evidence |
|---|---|---|
| In-app per-customer allowance ($5/day default, $20 ceiling), kill switch, fleet alert $10/24 h, per-customer alert $3/24 h | DONE in the candidate. **Not on Production**: `87e4df7` predates AI cost controls (2026-10-16) | `openai-environment-separation.md` §6.2; memory index "AI cost controls" |
| Bounded retries and turn deadline (SEC-AI-003); awaited ledger (IDEMP-009) | DONE (candidate) | `09` §1 |
| OpenAI `fourth-meridian-prod` project hard limit ($150) and alert ($60), recommended | **OWNER, unrecorded** (G5a; `01` SEC-AI-001 partial) | `openai-environment-separation.md` §6.3, §7 |
| Fleet ceiling in the reservation transaction (SEC-AI-001 P2) | DEFERRED; the project hard limit is the backstop | `01` P2 row |
| `project_spend_limit_exceeded` classified as quota, not retried | UNVERIFIED whether the hand-off in §6.1 landed | `openai-environment-separation.md` §6.1 |

## 12. Outstanding P1 / P2 risks

**P1 register (33 rows, `01`):**

| Bucket | Rows |
|---|---|
| RESOLVED in code (candidate only) | SEC-001, SEC-006, SEC-002*, TEST-005, OBS-001, OBS-002, SEC-AI-003, IDEMP-009, SEC-AI-005, PRIV-001, IDEMP-002, FIN-001, FIN-002, IDEMP-001, UI-003†, UI-006†, UI-002, TEST-004, TEST-003, TEST-002, OBS-004, OPS-001 |
| RESOLVED in code + owner/counsel follow-up | SEC-008 (Production row; Turnstile), ARCH-003 (edge, D3), OBS-003 (Resend key), OPS-002 (monitor), PRIV-010 / PRIV-011 / PRIV-012 (counsel), PRIV-002 (historical scrub), TEST-006 (Vercel wiring) |
| OWNER-only | SEC-018 (visibility), TEST-001 (rulesets), SEC-AI-001 (OpenAI project limit), OPS-013 / OPS-015 / DB-007 (Production cutover) |
| Resolved locally | SEC-AI-011 (STATUS re-baseline; GitHub record pending) |

\* **SEC-002 has reopened in effect.** The 2026-10-22 advisories made the candidate's `next` 16.3.8 vulnerable again. The fix `32114c9` is unpushed, and Production is on 16.2.7.
† Not verified in a browser.

**None of the P1 fixes are on Production.** Every RESOLVED row above is closed only on `remediation/beta-1`.

**P2 (54 rows): 33 resolved, 6 partial, 14 deferred, 1 owner** (`12` severity view). The partial or deferred P2s that matter for Production:
- IDEMP-008: needs a Production data check.
- DB-005: pool sizing.
- FIN-004: owner convention.
- FIN-006.
- SEC-AI-001: fleet ceiling.
- PRIV-013: sub-processors (counsel).
- UI-020: Security Ops.
- SEC-011 / SEC-012: CSP enforcement, TOTP replay.
- NEW-010: double invite e-mail.

## 13. Legal and privacy gates

| Gate | Status | Evidence |
|---|---|---|
| AI legal page enumerates what is sent to OpenAI | drafted; **counsel review pending** | `11` §C; `01` PRIV-010 |
| Point-of-use OpenAI disclosure | drafted; counsel pending | `01` PRIV-011 |
| Waitlist notice + consent + 180-day retention | drafted; counsel pending; D9 owner choice | `01` PRIV-012; `11` D9 |
| Sub-processor naming (Vercel, Supabase, Resend, Sentry generic) | OWNER/COUNSEL | `legal-factual-basis-2026-10-07.md` §2 item 3; PRIV-013 |
| Regulatory posture of guidance; untouched clauses (liability, governing law) | COUNSEL | same §2 items 2, 5 |
| Re-consent for the bumped `TERMS_VERSION` (no re-consent flow exists) | OWNER decision | same §2 item 6 |
| Historical raw e-mails in audit rows (scrub) | OWNER-run script | `11` G6 |
| Counsel sign-off recorded (checklist F2) | OPEN | checklist F2 |

## 14. Production cutover checklist: row-by-row summary

Source: `docs/operations/production-cutover-checklist.md`. **Every row is unticked.** Candidate SHA, freeze and sign-off are blank.

| Row | Subject | State today | Note |
|---|---|---|---|
| A1 | candidate SHA fixed; `main` ancestor | OPEN | `main` 87e4df7 is not on `v2.6` (one content-identical commit; cutover §8 issue 3) |
| A2 | GitHub CI green at the exact SHA | **RED** | `7d38bf5` `test` failed; `32114c9` never run |
| A3 | local `npm run ci` green on that SHA | OPEN | last green `01098bd` (pre-bump) |
| A4 | `npm audit` high+ clean | OPEN | expected clean on `32114c9`; unverified on GitHub |
| A5 | STATUS §3 row with the CI run id | OPEN | — |
| B1 | migration inventory vs Production | OPEN | row text is stale (126); the live count is UNVERIFIED; about 47 pending |
| B2 | migration names audit | likely PASS | in CI (`Architecture audits` passed on 7d38bf5) |
| B3 | drift on Production within 1 h | OPEN | cutover day |
| B4 | data preflight zeros | OPEN | last zeros 2026-10-06 |
| B5 | PG 17.6 clone rehearsal + `rls:accept` | OPEN | `fm_backup` creation on Supabase now evidenced by Preview |
| B6 | no `MERCHANT_OPS` rows before step H | OPEN | sequence rule |
| C1 | Production backup/PITR read | **OPEN (UNVERIFIED)** | Preview only so far |
| C2 | `fm_backup` password + shape | OPEN | after migration |
| C3 | pre-cutover dump + sha | OPEN | cutover day |
| C4 | timed restore rehearsal, RPO/RTO | **OPEN** | §6 table empty |
| C5 | rollback plan agreed | OPEN | plan exists (§2 here) |
| C6 | local-dump policy | OPEN | per dump |
| D1 | Vercel mapping verified | PARTIAL | aliases read 2026-10-22 (doc 17 §0); full `vercel inspect`/domains not re-read |
| D2 | Production env inventory | OPEN | §4 here; role URLs + strict absent |
| D3 | staged deployment boots strict, `db-authority` green | OPEN | — |
| D4 | staged-URL login with TOTP | OPEN | cutover §6.7 |
| D5 | `registration_mode=invite_only` row | **UNVERIFIED** | the candidate's code default is `invite_only`; Production on 87e4df7 has the old default |
| D6 | rulesets on `main` and `v2.6` | **OPEN** | gh api `[]` |
| D7 | visibility decision recorded | **OPEN** | public |
| E1 | every job run once on Preview | **OPEN** | 1 `JobRun` ever |
| E2 | Plaid Sandbox acceptance on the candidate | OPEN | — |
| E3 | external monitor | **OPEN** | — |
| E4 | alert delivery proven | **OPEN** | — |
| E5 | post-deploy smoke present and read | PARTIAL | workflows exist; first trusted run after A6 |
| E6 | Sentry from Preview on the candidate | OPEN | — |
| F1 | owner one-day acceptance on Preview | OPEN | after A6/A7 |
| F2 | counsel-signed disclosures | **OPEN** | §13 |
| F3 | execution window agreed | OPEN | the window premise is stale (§9) |
| F4 | owner sign-off | OPEN | — |

**Tally:** 35 rows, 0 ticked, 3 partial or likely-pass (B2, D1, E5), 32 open or unverified.

## 15. Consolidated classification of remaining issues

**BLOCKER** = must close before the Production cutover is executed, or is a live Production risk. **REQUIRED BEFORE BETA** = may follow the cutover but must close before the first invite. **ACCEPTABLE DEFERRED** = documented and tolerable for an invite-only beta.

| # | Issue | Class | Evidence |
|---|---|---|---|
| 1 | ~~Candidate CI red; security fix unpushed~~ — **CLOSED** (doc 19 §1) | closed | §0, §6 |
| 2 | **Production live today on `next` 16.2.7 / `next-auth` 4.24.14 / `@sentry/nextjs` ^10.67** (critical RCE advisory ranges; exploitability UNVERIFIED). This is a live risk independent of beta; a cutover or a hotfix is the only remedy | **BLOCKER** | §7 |
| 3 | PR #1 merged (A6 done). **Remaining:** promote `v2.6` → `main` (owner; `main` is not fast-forwardable, cutover §8 issue 3) | **BLOCKER** | §0; checklist A1 |
| 4 | ~~Preview validation~~ — **DONE**: 49 PASS / 2 FAIL / 7 BLOCKED (doc 19 §4); the BLOCKED rows are rows 11, 34 | closed | §16 placeholder; `11` G8 |
| 5 | Production backup posture unread; PITR decision; no timed restore with RPO/RTO | **BLOCKER** | §1, §2; C1, C4 |
| 6 | Clone rehearsal of about 47 migrations + backfill + `rls:accept` on Production's rows (PG 17.6); live migration count UNVERIFIED | **BLOCKER** | §3; B1, B5 |
| 7 | Migrations 35–47 not classified for compatibility with the old app (87e4df7) | **BLOCKER** (documentation; likely inert) | §3 |
| 8 | Cutover plan and checklist stale: 31/34 vs about 47 pending; "126 at HEAD"; dispatch-free window and 06:00-first-Plaid assumptions invalid under the 15-min dispatcher | **BLOCKER** (refresh before execution) | §3, §9 |
| 9 | Production env: role URLs + `FM_RLS_STRICT` absent (boot refuses); `NEXTAUTH_SECRET` split; `CRON_SECRET` rotation; `DATABASE_URL` username form | **BLOCKER** | §4 |
| 10 | Every job body run once in a deployed v2.6 (Preview `JobRun` = 1) | **BLOCKER** | §9; E1 |
| 11 | Plaid acceptance on the candidate (owner may downgrade to accepted risk) | **BLOCKER** | cutover §8 issue 1; E2 |
| 12 | Rulesets on `main`/`v2.6` before anything reaches `main` | **BLOCKER** | §6; `10` §6.3; D6 |
| 13 | Repository visibility decision (public repo with ops docs) | REQUIRED BEFORE BETA | `11` D1; D7 |
| 14 | External monitor on the Production `/api/health` | REQUIRED BEFORE BETA | §10; E3 |
| 15 | Alert delivery proven to `PLATFORM_ALERTS_EMAIL`; Sentry alert rules | REQUIRED BEFORE BETA | §10; E4 |
| 16 | OpenAI Production project hard limit + alert recorded; Production key/pin verified after deploy | REQUIRED BEFORE BETA | §11; G5a |
| 17 | Counsel review of three texts + sub-processor list; re-consent decision | REQUIRED BEFORE BETA | §13; F2 |
| 18 | `registration_mode=invite_only` row on Production (and on Preview, D15) | REQUIRED BEFORE BETA | D5; `11` D15 |
| 19 | Historical audit e-mail scrub per environment (G6) | REQUIRED BEFORE BETA | §13 |
| 20 | D14: Plaid **Sandbox** and OpenAI **`fourth-meridian-preview`** verified (doc 19 §3). Remaining: Resend key scope (owner glance) | ACCEPTABLE DEFERRED | §5 |
| 21 | Owner one-day acceptance (F1) and owner sign-off (F4) | REQUIRED BEFORE BETA | §14 |
| 22 | D3 Production edge (Cloudflare or not) for client-IP trust | REQUIRED BEFORE BETA | `11` D3 |
| 23 | D6 FIN-002 pre-fix correction backfill decision | REQUIRED BEFORE BETA (decision only) | `11` D6 |
| 24 | `ENCRYPTION_KEY` shared Prod+Preview; no rotation script | ACCEPTABLE DEFERRED | §5 |
| 25 | D12 full branch-DB isolation (interim in place) | ACCEPTABLE DEFERRED | §5 |
| 26 | Turnstile keys (acceptable while invite-only) | ACCEPTABLE DEFERRED | §4 |
| 27 | SEC-AI-001 fleet ceiling (project hard limit is the backstop) | ACCEPTABLE DEFERRED | §11 |
| 28 | DB-005 pool sizing; OPS-011 queue; IDEMP-005 cursor CAS; IDEMP-008 partial unique | ACCEPTABLE DEFERRED | `09` §6 |
| 29 | SEC-011 CSP enforce; SEC-012 TOTP replay; SEC-003 migration-principal residue; PRIV-005 append-only audit | ACCEPTABLE DEFERRED | `07` §7 |
| 30 | `exceljs`/`uuid` moderate advisories (D10) | ACCEPTABLE DEFERRED | `11` D10 |
| 31 | FIN-004 period convention, FIN-006 holdings refresh, NEW-010 double invite e-mail, UI-020 Security Ops | ACCEPTABLE DEFERRED | `01`; `11` |
| 32 | TEST-010 browser/e2e automation (the manual G8 pass substitutes for beta) | ACCEPTABLE DEFERRED | `01` |
| 33 | Physical-restore role preservation (inferred, not tested) | ACCEPTABLE DEFERRED, provided row 5's logical restore passes | §2 |

| 34 | A7 rows needing the owner's hands: A4 reset-link reuse, C2 invite redemption, C3 verify-link reuse (token only in the e-mail), E1/E2/E4 Plaid Sandbox Link, F1 late paycheck (no payroll data on Preview; covered by unit tests) | REQUIRED BEFORE BETA (≈20 min owner pass) | doc 19 §4 |
| 35 | BUG-4: TOTP can be disabled with the password alone (route documents "code OR password") | REQUIRED BEFORE BETA (owner decision D16) | doc 19 B4 |
| 36 | BUG-5: a double-clicked waitlist approve sends two invites and the first link dies | ACCEPTABLE DEFERRED (P3) | doc 19 I4 |
| 37 | N1: a revoked session's server-rendered pages stay readable ≤ 30 s (per-instance cache, by design; APIs refuse at once) | ACCEPTABLE DEFERRED | doc 19 A5 |
| 38 | N3: `ConfirmDialog` does not move initial focus into the dialog | ACCEPTABLE DEFERRED (P3 a11y) | doc 19 UI-003 |
| 39 | A7 test data on shared Preview (4 `a7-20261022-*` users, admin deactivated; "A7 Shared Space"; test imports/wallet; Resend test-sink invites) | ACCEPTABLE DEFERRED (owner may keep or remove) | doc 19 §6 |

**Count (after A6/A7):** **10 BLOCKER** (2, 3, 5–12) · **12 REQUIRED BEFORE BETA** (13–19, 21–23, 34, 35) · **16 ACCEPTABLE DEFERRED** · rows 1 and 4 closed. Fixed during A7 and no longer listed: BUG-0 (critical deps), BUG-1 (Space creation 500 under strict RLS, P1), BUG-2 (health tooling), BUG-3 (one-click invite rescind).

## 16. Preview validation results (filled by orchestrator)

| Check | Result | Evidence |
|---|---|---|
| Deployed SHA on `preview-app` | `v2.6` `7d1cee7` (READY); `/api/health` carries no commit by design (OPS-014) | doc 19 §2 |
| `/api/health` | 200 `status ok`, `db ok`, `scheduler` block present, `alertEvaluatorOverdue:true` (crons are Production-only) | doc 19 §2 |
| Trusted deployment health | HEALTHY on the app after the PR #2 fix (it was a false green before) | doc 19 §2 |
| Browser matrix (`15`) + extensions | **49 PASS · 2 FAIL (B4 P2 decision, I4 P3) · 7 BLOCKED** | doc 19 §4 |
| SEC-001 (TOTP bypass via forged session update) | **holds** live | doc 19 B1/I1 |
| SEC-014, RLS user isolation, Space role boundaries | hold live | doc 19 I3, D2 |
| IDEMP-001 (concurrent duplicate import) | holds live (409/409, 6 rows) | doc 19 G2 |
| Jobs on Preview (G0a) | **not run** (`JobRun` = 1); still a BLOCKER (row 10) | — |
| Plaid Sandbox acceptance (E2) | credentials proven Sandbox; Link flow BLOCKED (owner) | doc 19 §3, E1 |
| Sentry capture (E6) | not exercised | — |
| New P1 found and fixed | BUG-1 Space creation 500 under strict RLS → PR #3, `rls:accept:foreground` 71/71 | doc 19 §5 |

## 17. Verdict

**Production: NO-GO** (2026-10-23).

The candidate is now merged, CI-green and validated on Preview, and the validation found and fixed a P1 that would have broken Space creation for every user. **But the Production side has not started.** In order of weight:

1. **Live Production risk now (row 2).** `fourthmeridian.com` runs `87e4df7` on `next` 16.2.7, inside the 2026-10-22 critical-advisory ranges. Exploitability on that build is UNVERIFIED. The remedies are a hotfix to `main` or the cutover; both are owner actions (merge to `main` is not authorised here).
2. **Recovery unproven (row 5).** Production backups and PITR have never been read, and no timed restore has been done.
3. **Migrations unrehearsed on Production data (rows 6–8).** About 47 pending (count UNVERIFIED), never rehearsed on a Production clone. The cutover plan's counts and quiet-window assumptions are stale.
4. **Production env not prepared (row 9).** The candidate refuses to boot without the role URLs and `FM_RLS_STRICT`.
5. **Operational proof missing (rows 10–11).** No job has ever run on a deployed v2.6; Plaid acceptance is pending.
6. **Governance (row 12).** There are no rulesets on `main`/`v2.6` before promotion.

**What would make it GO:** close the 10 BLOCKERs (most are owner actions or owner-approved runs of documented procedures), then the 12 REQUIRED-BEFORE-BETA items before the first invite. **Preview is ready** to serve as the acceptance environment for the owner's ≈ 20-minute pass on the BLOCKED rows (row 34).
