# 16 — Preview rehearsal (A2) and the next approval boundary

**Date:** 2026-10-22.

**PR #1 head on GitHub:** `0502dc7` (A1 pushed, fast-forward from `1e697a6`).

**Local, unpushed:** `9483231`, `7a81f9c` and this document. They need a further push approval.

**Not done:**
- No migration on shared Preview (A5 not approved).
- No merge (A6 not approved).
- No GitHub secret or Vercel setting changed.

## 1. A1: push and PR checks

- `origin/remediation/beta-1` = `0502dc7afd322d418b5b49fdb2311e91d639d4dc` (verified with `git fetch`).
- The PR is mergeable; state `UNSTABLE` only because of the intended red check below.

| Check | Result |
|---|---|
| `test` (push run `39791160574`; PR run `39791169840`) | pass, pass |
| `Architecture audits` | pass, pass |
| `Public site (zero-authority boundary)` | pass, pass |
| `status-drift-guard` | pass |
| Vercel `fintracker1` | built |
| Vercel `fourth-meridian-site` | canceled by its Ignored Build Step (no `site/` change), as designed |
| **`Deployment health`** (run `39791304431`) | **fail, as designed**: `HTTP 401 → UNVERIFIED (Vercel Deployment Protection answered (HTTP 401); the application was not reached)`; bypass not configured |

## 2. A2: rehearsal against restored Preview state

**Dump**
- One `pg_dump --format=custom --schema=public --no-owner` of Preview, run as the Preview migration principal. `pg_dump` reads inside a read-only snapshot.
- It keeps ACLs (88), policies (246) and row-security (62) entries.
- The file is 1.13 MB, SHA-256 `9b3418d9…ec8c26`.
- It is stored in `~/fm-rehearsal-private/` (directory 700, files 600, outside the repository, not uploaded anywhere). No connection string or personal data appears in any report.

**Environment**
- A disposable `postgres:17.6` container (PostgreSQL 17.6, Debian 17.6-2.pgdg13+1), bound to `127.0.0.1` only. It has been **removed with its volume**.
- Supabase's role model is reproduced:
  - a non-superuser `postgres` with `BYPASSRLS` and `CREATEROLE` creates `fm_app`, `fm_auth`, `fm_system` and `fm_backup` (BYPASSRLS) itself;
  - this yields `admin_option = t, set_option = f`, **identical to Preview**;
  - the `idle_in_transaction_session_timeout = 15s` role settings are copied from Preview's catalog.
- The restore ran as that non-superuser. One fidelity gap: three `ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin` entries were skipped. They govern only objects Supabase's own admin role creates, and none of the nine migrations runs as that role.

**Restore fidelity:** every Preview fingerprint value matches.

| Value | Preview copy |
|---|---|
| Migrations applied | 126 (newest `20261016000000`) |
| `JobRun` | 1 row at `2026-10-07 19:09:08.654` |
| Users | 5 |
| FORCE-RLS tables | 62 |
| Policies | 246 |
| `PlatformGrant` `fm_app` privileges | `DELETE,INSERT,SELECT,UPDATE` |
| Tables / rows | 71 / 21,081 |

| Requirement | Evidence | Result |
|---|---|---|
| **Migration success and ordering** | `db-guard --mode=migrate-deploy` then `prisma migrate deploy` at `0502dc7`, as the non-superuser principal. Applied in lexical order `…000000 → …000100 → … → …000700 → …001000` (start times 13:58:44.366 → .403). Total 135, none unfinished. `…000700` applied with **no** NOTICE fallback. | ✅ |
| **Schema** | 4 new columns (types and default as designed). 7 indexes present and `indisvalid`. Old truncated index name gone. | ✅ |
| **Privileges** | `PlatformGrant` → `fm_app` = `SELECT` only; policies `fm_app_sel, fm_system_all`. `RateLimit` RLS on and FORCE; policies `fm_app_own_user_buckets(fm_app), fm_auth_all(fm_auth), fm_system_all(fm_system)`. FORCE-RLS tables 62 → 63; policies 246 (+3 −3). Role defaults `statement_timeout` 15s / 5s / 60s alongside the existing idle timeout. | ✅ |
| **Role behaviour (logged in as each role, real Preview rows)** | **`fm_app` with no identity:** 0 `RateLimit`, 0 `FinancialAccount` (fails closed), `statement_timeout` 15s. **`fm_app` as a real user:** sees exactly that user's 139 buckets and 0 of anyone else's; `INSERT` into `PlatformGrant` denied (`permission denied`); `INSERT` of another user's bucket refused (`violates row-level security policy`); `UPDATE` of another user's buckets touches 0 rows. **`fm_auth`:** all 304 buckets; `FinancialAccount` still `permission denied`; `pg_sleep(6)` cancelled by the 5 s timeout. **`fm_system`:** all 304 buckets, timeout 1min. **`fm_backup`:** all 304 (BYPASSRLS). | ✅ |
| **RLS isolation, all application roles (suites, on the migrated Preview copy)** | `rls:accept` **37/37** (after `9483231`, see §3); `rls:accept:app` **98/98**; `rls:accept:ai` **72/72**; `rls:accept:plaid` **20/20**; `rls:accept:foreground` **67/67**; `rls:accept:allowance` **15/15**. | ✅ |
| **Existing-data compatibility / no unexpected destructive effects** | Per-table row count + MD5 of every row, before and after, excluding only the four new columns. **All 70 data tables identical**; the only difference is `_prisma_migrations` 126 → 135. New columns hold only NULL / default 0. The `JobRun` cleanup UPDATEs touched 0 rows. | ✅ |
| **Application regression tests** | Unit (hermetic) 829/829 at `0502dc7`. REQUIRED audits on the migrated Preview data: **26 of 28 pass**. The 2 failures are **pre-existing / harness**, not migration effects (below). | ✅ with notes |

**The two audit failures, isolated:**
1. **`audit-event-identity`: "INV-7 is not vacuous"** (41 multi-observation events, 0 pinned by a pending observation). It fails **identically on a second, unmigrated restore** under both this branch's code and `v2.6` code (`cde8fa0`).
   - This is a property of Preview's data: no event there was ever first observed pending. The non-vacuity guard was written for the seeded CI corpus.
   - Every structural invariant (INV-1, 2, 4, 5, 7, 17, projection, dates) passes on Preview data.
   - Follow-up: either seed or accept vacuity on non-CI corpora. This is not a migration blocker.
2. **`audit-schema-drift`: P3006** when the non-superuser principal replays migration `20261002000100` into a scratch shadow database (`permission denied to alter role … SUPERUSER`). Run as the container's superuser it reports **0 drift statements**. The audit is a CI (superuser) check, and GitHub CI ran it green on `0502dc7`.
   - Consequence for the runbook: run `db:drift` (`check-schema-drift.ts`, a single `SELECT`) against Preview, not `audit-schema-drift`.

## 3. Found and fixed during A2 (local, unpushed)

| SHA | Change |
|---|---|
| `9483231` | `rls:accept` case 12 asserted `out.includes("1")`. It passed on CI's one seeded FxRate row and failed on Preview's 8,785 rows, which are readable, the very property the case tests. It now asserts `Number(out) >= 1`. Re-run on the Preview copy: 37/37. |
| `7a81f9c` | Per-project bypass secrets (§5). |

## 4. A3: instructions for checking Supabase backup and recovery (owner, dashboard)

Supabase's dashboard labels change over time. Where a label differs, record what the dashboard shows.

1. Open the **Preview** project (ref begins `lqag…`; region and name as shown). Confirm in **Project Settings → General** that this is Preview, not Production.
2. **Plan:** Organization → Billing. Record the plan (Free / Pro / Team / Enterprise). Free projects have no dashboard-restorable backups. Daily backups and their retention are tied to the plan: Pro is 7 days, Team 14, Enterprise up to 30 (verify against the dashboard).
3. **Database → Backups → Scheduled backups.** Record:
   - (a) whether the list is populated;
   - (b) the newest backup time (UTC);
   - (c) the oldest available, which gives the effective retention;
   - (d) whether a **Download** action is offered.
4. **Database → Backups → Point in Time** (or **Project Settings → Add-ons → Point in Time Recovery**). Record:
   - (a) enabled or disabled;
   - (b) the retention window;
   - (c) the earliest recovery point shown.

   PITR is a paid add-on and may require a minimum compute size.
5. **Recovery capability.** For each mechanism above, note **where** a restore lands:
   - In-place restore **replaces the Preview database and causes downtime**.
   - A "restore to a new project" or branch option, if offered, does not touch Preview.

   Do **not** click Restore. Reading the screen is the whole check.
6. **Database → Settings** (or Infrastructure): confirm the Postgres version **17.6**, and note the compute size and `max_connections` (we read 60).
7. **Record** in the release ticket: plan, newest scheduled backup, retention, PITR status and window, restore target options, and the time you read it.
8. **Independent of Supabase:** the A2 dump is a verified logical backup of Preview's `public` schema as of 2026-10-22 13:55 UTC.
   - It restored cleanly into 17.6 with all 21,081 rows and every grant and policy.
   - The runbook (§2) takes a fresh one immediately before A5.
   - It does **not** contain Supabase's `auth`/`storage` schemas, which the app does not use.

## 5. A4: how the bypass secret should be scoped

**Facts** (read-only, values never printed):
- Each project has exactly one `automation-bypass` secret, and **the two values differ** (SHA-256 prefixes compared).
- A bypass secret opens **every** protected deployment of its project, including `preview-app` and every branch build.

**Recommendation:**

| Item | Recommendation |
|---|---|
| Secret names | Two secrets: `VERCEL_AUTOMATION_BYPASS_SECRET_APP` (from `fintracker1`) and `VERCEL_AUTOMATION_BYPASS_SECRET_SITE` (from `fourth-meridian-site`). `7a81f9c` selects by target and never sends one project's secret to the other's deployment, and only over https to `*.vercel.app` / `*.fourthmeridian.com`. |
| Where to store them | A **GitHub Environment** (e.g. `vercel-probe`) with a deployment-branch rule of `v2.6` and `main` only, not repository secrets. Reason: `deployment_status` runs the workflow file **from the deployed commit**, so anyone who can push a branch could edit the workflow on that branch and print a repository secret. With an environment restricted to `v2.6` and `main`, branch builds get no secret and stay **UNVERIFIED (red)**. That is honest, and it is the trade-off. |
| Workflow change needed for that | Add `environment: vercel-probe` to the job. Not done: referencing a non-existent environment makes GitHub **create it** on the next run, which is a repository-settings change. Owner creates the environment first; then a one-line commit. |
| Rotation | Regenerate each project's bypass in Vercel and update the matching GitHub secret together. The values were created on 2026-10-06 (app) and 2026-10-07 (site). |
| Until then | No secret is present, and every Preview probe reports UNVERIFIED (red). It never reports a false green (verified: run `39791304431`). |

**Local proof:** with both secrets in the environment, all three of these came back **HEALTHY** with the matching secret:
- the PR app deployment (`fintracker1-33qx5ycnw…`, `0502dc7`);
- the PR site deployment;
- `preview.fourthmeridian.com`.

Without the secrets, each was **UNVERIFIED**.

## 6. D13: why `preview-app` is behind the login wall (read-only)

- Both projects have `ssoProtection.deploymentType = all_except_custom_domains`. That is Vercel's **Standard Protection**: it protects every deployment **except production custom domains**.
- `preview-app.fourthmeridian.com` is attached with **`gitBranch: v2.6`**, which makes it a **Preview** domain. It is therefore protected, as is `preview.fourthmeridian.com` on the site project (also `gitBranch: v2.6`).
- No password protection, trusted IPs or OPTIONS allowlist is configured.

**Conclusion:** configuration and behaviour agree. My earlier note ("despite the custom-domain exemption") misread the setting. To make `preview-app` public would need Protection "None" or "Only Production Deployments" (the latter removes protection from **every** Preview URL), which is not recommended for an environment sharing data.

**Correction to doc 14:** `fourthmeridian.com` is attached to **`fintracker1`**, whose Production deployment is `87e4df7` (2026-07-27). The site project has no production custom domain. The "Production site HEALTHY" row probed the old app's root page. Doc 14 is corrected. This matters for the cutover: moving `fourthmeridian.com` to the site project is still a Production step (`domain-split-preview.md` §6.2).

## 7. D12: least-privilege configuration for branch deployments

**Today:**
- Generic Preview (every non-`v2.6` branch, including PR #1) gets only `DATABASE_URL` / `DIRECT_URL`, which is the **migration principal (BYPASSRLS) on the shared Preview database**. It also gets every provider secret.
- `Preview@v2.6` overrides only the role URLs, `FM_RLS_STRICT`, `NEXTAUTH_URL`, `NEXT_PUBLIC_APP_URL` and `NEXT_PUBLIC_SITE_URL`. **It inherits `DATABASE_URL` / `DIRECT_URL` from generic Preview.**

| Option | Minimum change (Vercel env only; owner) | Effect | Implications |
|---|---|---|---|
| **1. RLS for branch builds** (smallest) | Add `DATABASE_URL_APP`, `_AUTH`, `_SYSTEM` and `FM_RLS_STRICT=true` to **generic** Preview (same values as `Preview@v2.6`) | Branch builds run tenant code as `fm_app` / `fm_auth` / `fm_system` under RLS, as `preview-app` does | Still the **shared** Preview data and the same provider keys. The migration principal stays (admin and limiter paths need it). Takes effect on the next build of each branch. |
| **2. Isolated branch database** (recommended) | **(a) First**, add `DATABASE_URL` and `DIRECT_URL` scoped to `Preview@v2.6`, pointing at today's shared Preview database. Without this step, (b) silently moves `preview-app`'s migration principal too: split brain. **(b)** Point generic Preview `DATABASE_URL` / `DIRECT_URL` at a **new disposable database** (a separate Supabase project or a Supabase branch on 17.6), with roles created as in the runbook, role URLs, and `FM_RLS_STRICT=true`. **(c)** In generic Preview, remove or replace provider secrets: Plaid **Sandbox** keys only, no `OPENAI_API_KEY` (or a separate capped OpenAI project), no `RESEND_API_KEY` (e-mail captured). | Branch builds can neither read nor write shared Preview data, and cannot spend on production-grade providers | The new database needs all 135 migrations and the roles created, and must be migrated **before** a branch that adds migrations is useful (as PR #1 shows today). Costs a second database. A redeploy of `preview-app` after (a) is required to confirm it still reads the shared database (health plus one login). |
| **3. No branch deployments** | Restrict Vercel Git deployments to `v2.6` and `main` (an Ignored Build Step or git-branch setting) | Nothing runs off-branch | Loses per-PR previews. Validation happens only on `preview-app` after merge, so it suits a solo workflow but delays feedback. |

**Recommendation:** Option 2, with step (a) strictly first. If a second database is not wanted yet, use Option 1 plus the step (c) secret reduction as the interim.

**Today's exposure from PR #1's branch build:** it runs `0502dc7` code against the **unmigrated** shared Preview database, as the BYPASSRLS principal. It is SSO-protected, and no crons run on Preview. Do not open it until A5.

## 8. A7: browser validation execution plan (prepared, not executed)

**Preconditions:** A5 done (runbook §1–§5 green), A6 merged, `preview-app` redeployed. `Deployment health` HEALTHY once A4 is in place (otherwise verify `/api/health` by hand through SSO).

**Data and integrations rule:**
- Preview test accounts only, on addresses the owner controls (plus-addressing on the owner's mailbox). No real customer data.
- Plaid **Sandbox** institutions only, never the two legacy ACTIVE Items.
- Before any row that reaches a provider, confirm the Preview value of `PLAID_ENV` is `sandbox`. The values are Sensitive, so this is an owner check in the Vercel dashboard.
- Also confirm whether Preview's `OPENAI_API_KEY` belongs to a **non-production** OpenAI project. If it is the production project, run the AI rows (`15` §H) with the kill switch **ON** and verify only refusals (H5), deferring answer-quality rows until a separate key exists.
- Resend: deliver only to owner-controlled addresses.

**Order and stop rules:**

| Session | Rows | Stop if |
|---|---|---|
| 1. Access and identity (about 30 min) | `15` A1–A6, B1–B4, C1–C5 | any SEC-001 / registration-mode / TOTP failure: stop and report |
| 2. Spaces and data (about 40 min) | D1–D6, E1–E4 (Sandbox), G1–G4 | any cross-Space visibility, or a duplicate-import 500 |
| 3. Money correctness (about 20 min) | F1–F4 | a figure contradicting the ledger |
| 4. AI (about 15 min, at most 10 turns) | H1–H6, gated by the OpenAI-key check | retry storm or provider error loop: kill switch ON |
| 5. Operator and public (about 30 min) | I1–I7, J1, K1–K5 | an operator write available to a read-only role |

**Evidence per row:** UTC time, tester, pass/fail, screenshot, and any console error. A P1-class failure becomes a register row and blocks the beta gate (`11` G10).

**Cleanup after:**
- Disconnect the Sandbox Item.
- Archive the test Spaces.
- Leave the test accounts, and record them.

## 9. Next approval boundary

> **Superseded by doc 17 §7 (2026-10-22, later):**
> - A3 partly closed (PITR off).
> - A4b done: the `vercel-probe` environment, denial proven, real secrets installed.
> - D12 interim applied (full isolation awaits a database choice).
> - The table below is kept for history.

| # | Needed for | Scope |
|---|---|---|
| **A1b** | Push `9483231`, `7a81f9c` and this doc to PR #1 | Fast-forward from `0502dc7`; no force; CI re-runs. `Deployment health` stays red (UNVERIFIED) until A4b. |
| **A3 (you)** | Backup posture recorded | §4 checklist |
| **A4b** | Create the `vercel-probe` GitHub Environment (branches `v2.6`, `main`) with the two secrets | Then I add `environment: vercel-probe` to the workflow in a one-line commit |
| **D12** | Choose option 1, 2 or 3 | Vercel env changes (owner); option 2 step (a) first |
| **A5** | Apply the nine migrations to shared Preview | Runbook; rehearsal evidence above |
| **A6** | Merge PR #1 | After A5 §5 checks and green CI |
| **A7** | Execute the browser pass | §8 preconditions met |

Production remains untouched.
