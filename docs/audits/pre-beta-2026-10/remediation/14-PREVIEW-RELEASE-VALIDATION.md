# 14 — Preview release validation (PR #1, pre-merge)

**Date:** 2026-10-22.

**Branch:** `remediation/beta-1`. PR #1 is open, **not merged**.

**Commits:** base PR head `1e697a6`; this phase adds the commits in §8.

**What this phase did not do:** no remote migration, no Preview configuration change, no deployment or promotion, no merge.

Every database fact below was read with `BEGIN TRANSACTION READ ONLY`, except the first batch of preflight queries. That batch relied on `PGOPTIONS=default_transaction_read_only`, which the Supabase pooler ignored (`transaction_read_only` read back `off`). Every statement in it was a `SELECT`, so nothing was written. The method was corrected for every later query.

## 1. Post-deploy health check: defect and fix

**Defect.** On PR #1, `Health and commit identity` was **green** after three `HTTP 401`s. The inline script mapped any `30x/401` to `exit 0` ("protected — not probed"), so the check passed without ever reaching the application. Runs:
- `39786312772`: `Preview – fintracker1`, 401 ×3, success.
- `39786016159`: `Preview – fourth-meridian-site`, 401 ×3, success.

**Two more defects found while fixing it:**
1. **The public site was probed at `/api/health`.** The site has no API by design, so the first public site deploy would have raised a false alarm (404).
2. **`/api/health` no longer publishes `commit`** (OPS-014 / OBS-010, `bf2da56`, a deliberate decision). The workflow's commit-identity comparison could therefore never run on this branch. This was a cross-workstream seam (E removed the field; F's workflow relied on it).

**Fix (`0bd88ee`).**
- **Verdict code.** The verdict moved into `scripts/post-deploy-smoke.mjs` (pure `classifyProbe`, no dependencies), with three verdicts:
  - **HEALTHY:** the app answered 200 JSON `status: ok`. On builds that still publish `commit`, it must prefix the deployed SHA. The site answered 200 `text/html` at `/`.
  - **UNHEALTHY:** anything else that answered, including a bare `401/30x` **without** Vercel's markers, `5xx`, `404`, HTML on the health route, or no response.
  - **UNVERIFIED:** Vercel Deployment Protection answered. That is a redirect to `https://vercel.com/sso-api`, or a `401/403` carrying `_vercel_sso_nonce` / "Vercel Authentication". The job **fails** on this verdict, so it can never read as a pass.
- **Identity.** It rests on the immutable per-deployment `*.vercel.app` URL (`deployment_status.environment_url`). On an alias host the reason says "build identity NOT verified". The job is renamed `Deployment health`.
- **Optional secret.** Per-project GitHub secrets `VERCEL_AUTOMATION_BYPASS_SECRET_APP` / `_SITE` (`7a81f9c`; scoping in doc 16 §5). Adding them is an owner action and they are absent today. It is sent only as `x-vercel-protection-bypass`, and only to `https` `*.vercel.app` / `*.fourthmeridian.com` (`mayCarryBypass`).
- **Tests.** `scripts/post-deploy-smoke.test.ts` has 28 checks on response shapes captured from the real deployments. Reintroducing the old `401 ⇒ pass` mapping fails 5 of them (mutation run). The `ci-local.test.ts` pins are updated. Three operations docs that promised a `commit` from `/api/health` are corrected.

**Corrected evidence.** The new script was run locally against the real deployments, GET only:

| Target | Without bypass | With the project's existing automation-bypass secret (read via the Vercel API, never printed) |
|---|---|---|
| PR deployment `fintracker1-alrkntl0t…vercel.app` (`1e697a6`) | **UNVERIFIED**, exit 1: "Vercel Deployment Protection answered (HTTP 401); the application was not reached" | **HEALTHY**, exit 0: `status ok`; no commit published, so identity rests on the immutable per-deployment URL |
| `preview-app.fourthmeridian.com` (`cde8fa0`) | UNVERIFIED (302 → `vercel.com/sso-api`) | **HEALTHY**: `status ok, commit cde8fa0 ⊂ cde8fa0e…` |
| `fourthmeridian.com/`: **correction (doc 16 §6):** this domain is attached to `fintracker1` (the app's July Production build), not to the site project, so this was the old app's root page, not the site | 200 `text/html` | n/a |

The new workflow first runs on the deployments of the pushed fix commit. Without the GitHub secret it will report **UNVERIFIED (red)** for Preview, which is the correct signal. Adding the secret is approval A4 (§9).

## 2. Preview environment map

| | PR branch deployment | Shared `preview-app.fourthmeridian.com` | Public site Preview `preview.fourthmeridian.com` |
|---|---|---|---|
| Vercel project | `fintracker1` | `fintracker1` | `fourth-meridian-site` (root `site/`) |
| Code | `remediation/beta-1` @ `1e697a6` (`dpl_J8du…`, the project's current `targets.preview`) | `v2.6` @ `cde8fa0` (custom domain bound with `gitBranch: v2.6`) | latest `site/` change on `v2.6`; PR build `dpl_88iy…` @ `1e697a6` |
| Env scope | generic **Preview** | generic Preview **+** branch-scoped `Preview@v2.6` | site project's own (zero-authority: no secrets, no DB) |
| Database principal | `DATABASE_URL` only, the migration principal (`postgres`, BYPASSRLS) | `DATABASE_URL` (migrations, limiter, admin) **plus** `DATABASE_URL_APP` / `_AUTH` / `_SYSTEM` (`fm_app` / `fm_auth` / `fm_system`) and `FM_RLS_STRICT` | none |
| Tenant isolation exercised | **No:** no role URLs, no strict flag, so the code falls back to the single principal | **Yes:** the RLS cutover (2026-10-06), strict | n/a |
| Deployment Protection | Vercel Authentication, Standard Protection (`ssoProtection: all_except_custom_domains`) | **Protected, as designed:** Standard Protection exempts only *production* custom domains, and `preview-app` is bound to `gitBranch: v2.6`, which makes it a Preview domain (doc 16 §6) | same setting; `preview.fourthmeridian.com` is likewise a Preview domain |
| Automation bypass | one `automation-bypass` secret exists on each project; not stored in GitHub | same | same |
| Crons | Production only (`vercel.json`; Preview never runs crons) | same | n/a |
| Production | `main` @ `87e4df7` (`dpl_JcZ5…`, 2026-07-27), serving `fourthmeridian.com` (apex is attached to **this** project), **untouched** | — | site project Production `f339e57` (2026-10-04) has **no** production custom domain (only `fourth-meridian-site.vercel.app`); untouched |

### Environment-variable differences

Names and types only (`vercel api /v9/projects/fintracker1/env`); no value was read.

| Variable | Preview (generic) | Preview@v2.6 | Production |
|---|---|---|---|
| `DATABASE_URL`, `DIRECT_URL` | ✓ | inherits generic | ✓ |
| `DATABASE_URL_APP` / `_AUTH` / `_SYSTEM`, `FM_RLS_STRICT` | — | ✓ | **—** (Production is not RLS-cut-over; cutover gate G-RLS) |
| `NEXTAUTH_URL`, `NEXT_PUBLIC_APP_URL` | ✓ | ✓ (overrides to the custom domain) | ✓ |
| `NEXT_PUBLIC_SITE_URL` | — | ✓ | — |
| `AI_FORECAST_GUARD_MODE` | — | — | ✓ (Production only) |
| `NEXTAUTH_SECRET`, `CRON_SECRET` | ✓ | ✓ | ✓ |
| All provider keys (OpenAI, Plaid, Resend, Alchemy, CoinGecko, OXR, Tiingo), `ENCRYPTION_KEY`, feature flags, `PLATFORM_ALERTS_EMAIL`, `RATE_LIMIT_ENABLED` | ✓ | inherits | ✓ |
| `CLIENT_IP_TRUST_CLOUDFLARE` (new in this PR) | — | — | — (owner decision D3; unset = safe default) |
| `REGISTRATION_MODE`-type rows | stored in `PlatformSetting`, not env | | |

## 3. Which deployment talks to which database

Proven without reading any secret:
- **PR deployment → shared Preview database.** Its `/api/health` scheduler block reported `lastDispatchAt = lastAlertEvaluationAt = 2026-10-07T19:09:08.654Z`. The Preview database's entire `JobRun` ledger is **one row**: `evaluate-alerts` at `2026-10-07 19:09:08.654`. That is an exact match. Production's ledger receives a dispatch every 15 minutes, so it cannot be Production.
- **`preview-app` → the same Preview database.** Its generic `DATABASE_URL` is the same Sensitive variable the PR deployment inherits. The role URLs were configured in the 2026-10-06 RLS cutover against this project (Supabase ref `lqag…`). They were not re-read today (Sensitive). Health reports `db: ok`.
- **Preview database facts** (read-only): PostgreSQL **17.6**, database `postgres`, user `postgres` (BYPASSRLS, not superuser, `CREATEROLE`). 126 migrations applied, newest `20261016000000`, none unfinished, all nine pending. 5 users, 12 Plaid Items, 304 `RateLimit` rows, 0 `ImportBatch`, 0 `running` JobRun. 62 FORCE-RLS tables. `max_connections` 60. No other non-idle session.

**Consequences:**
1. **The PR deployment is running the new code against the unmigrated Preview database right now.** Paths touching the new columns (e.g. sign-in reading `User`) will error there. It is SSO-protected and has no crons. Do not use it for testing until the migrations land.
2. **PR and branch deployments share the Preview database with `preview-app`, as the migration principal.** Anything clicked there writes to shared Preview data without RLS. This is a standing environment risk, not introduced by this PR. Recommendation (owner decision D12): scope `DATABASE_URL` for generic Preview to a separate disposable database, or add the role URLs and `FM_RLS_STRICT` to generic Preview.

## 4. Migration readiness assessment

Order:
- The nine are strictly after `20261016000000`.
- Their lexical order is their dependency order. None depends on another; `…000600` depends on `current_fm_user_id()` from `20261002000100`, which is applied.
- CI applied 135 from empty on PG16 (GitHub run `39785972082`). The 17.6 rehearsal is in §5.

| Migration | Operation | Privilege needed (Preview: ✓ held) | Destructive? | PG 17.6 | Rollback limits |
|---|---|---|---|---|---|
| `…000000_user_purge_claim` | `ADD COLUMN` nullable | table owner ✓ | no | ✓ | drop column only after a code rollback |
| `…000100_import_batch_file_sha256` | `ADD COLUMN` + partial `UNIQUE INDEX` | owner ✓ | no (0 rows) | ✓ partial predicates on enum text | drop index/column after a code rollback |
| `…000200_job_run_one_running_per_job` | 2 × `UPDATE` (stale/duplicate `running` → `failed`) + partial `UNIQUE INDEX` | owner ✓ | **data change** (0 rows affected on Preview: no `running` rows) | ✓ | the UPDATE is not reversible (and needs no reversal: those runs were dead) |
| `…000300_plaid_item_resume_backoff` | 2 × `ADD COLUMN` (one `NOT NULL DEFAULT 0`) | owner ✓ | no; a constant default is metadata-only on PG ≥ 11 | ✓ | drop columns after a code rollback |
| `…000400_db009_operational_indexes` | 4 × `CREATE INDEX` (not concurrent) | owner ✓ | no; brief write lock, tables ≤ 82 rows | ✓ | `DROP INDEX` |
| `…000500_sec014_platform_grant_read_only` | `REVOKE INSERT/UPDATE/DELETE` from `fm_app`; drop 3 policies | owner ✓ | **privilege removal** (intended; before state read) | ✓ | must **not** be reversed (reopens self-grant) |
| `…000600_db004_rate_limit_rls` | `ENABLE` + `FORCE RLS`; 3 policies | owner ✓ | no data change; **behaviour change** for `fm_app` / `fm_auth` / `fm_system` | ✓ | `DROP POLICY` + `NO FORCE` / `DISABLE` |
| `…000700_db006_role_statement_timeouts` | `ALTER ROLE … SET statement_timeout` | `ADMIN` on `fm_*` ✓ (`set_option` false does not matter for `ALTER ROLE`) | no; role default, new sessions only | ✓ | `ALTER ROLE … RESET` |
| `…001000_db008_provider_capability_index_name` | `ALTER INDEX IF EXISTS … RENAME` (old name present ✓) | owner ✓ | no; metadata only | ✓ | rename back |

**Compatibility.**
- **Old code on the new schema:** the current `v2.6` code writes `PlatformGrant` only through the `db` principal (admin routes), so `…000500` does not break it.
- **The rate limiter** runs on `db`, which has BYPASSRLS on Supabase, so `…000600` does not change it.
- **The allowance reservation** runs on `fm_system`, which gets `fm_system_all`.
- **The 15 s / 5 s / 60 s timeouts** apply to the old code too. The longest known statements are system jobs under 60 s. Watch `fm_system` after the merge.

**Risks:**
- R1: PR deployment pointed at the unmigrated DB (§3).
- R2: `statement_timeout` cutting a real query, which recovers with `ALTER ROLE … RESET`.
- R3: `npm run db:backup` dumps without privileges, which is insufficient for `…000500` / `…000600`. The runbook adds a privileges-preserving dump and a restore check.
- R4: no PITR status recorded for Preview yet (owner).

**Verdict:** ready to apply **after** the 17.6 rehearsal (§5) and the owner approvals in §9. The procedure is `docs/operations/preview-migration-runbook-beta1.md`.

## 5. PostgreSQL 17.6 rehearsal

Options, from lowest to highest fidelity:

| Option | What it proves | What it does not | Shared systems touched | Status |
|---|---|---|---|---|
| **A. Local disposable `postgres:17.6`, full CI contract** (`FM_CI_PG_IMAGE=postgres:17.6 npm run ci`, `58c57b3`) | 135 migrations from empty, 28 REQUIRED audits, all 5 RLS suites and the allowance suite on the 17.6 server | Supabase specifics: non-superuser `postgres` with BYPASSRLS, the pooler, Preview's real rows and grants | none | **PASSED** at `58c57b3`: unit 829/829; 135 migrations applied; 28 REQUIRED audits; RLS 37/98/72/20/67; allowance 15/15; site verify. Banner recorded "not GitHub-CI parity evidence". |
| **B. Restore a Preview dump into local `postgres:17.6`, apply the nine with `prisma migrate deploy`, run the runbook's §5 checks** | the exact Preview schema, grants and data state taking the nine migrations | the pooler; Supabase role attributes (recreated by hand) | one read-only `pg_dump` of Preview (test data: 5 users) to the owner's disk | needs approval A2 |
| **C. A Supabase branch or a fresh Supabase project on 17.6**, restore B's dump, apply the nine | everything incl. pooler and Supabase role model | — | a new billable Supabase resource | owner choice; optional |

**Recommendation:** A (done) plus B before touching shared Preview. C only if B surfaces a role or privilege question.

## 6. Browser smoke-test matrix

`15-BROWSER-SMOKE-MATRIX.md` has 52 rows over:
- authentication;
- MFA;
- registration and invitations;
- Spaces;
- connections (Plaid **Sandbox** only, never the two legacy Items);
- forecasting;
- CSV import;
- AI (about 10 real turns);
- operator workflows;
- Markets;
- the public site.

Each remediation fix it proves is tagged with its finding ID.

## 7. Lint warnings

GitHub shows at most ten annotations per step, so the run listed 10 of **20** warnings. `b646f23` removes the **13** that are pure deletions of unused imports and locals:
- the forecast assembler, conversation evidence, forecast engine and policy imports;
- AssetValueWidget and ConnectionCard;
- three unused test fixtures;
- an unread result in RLS app case 34, whose assertion reads the row afterwards.

**Checks made first:** no source-scan pin or forecast mutation anchor references a removed line. `tsc` is clean and unit tests pass **829/829**. The RLS suite edit runs in GitHub CI and in rehearsal A.

**Remaining (7), left on purpose:**

| Warning | Why not now |
|---|---|
| `window.location.href` after sign-out (`UserMenu`, `AdminUserMenu`) | Deliberate full reload that clears client state and transcripts after sign-out. The rule's suggested router push would keep the client cache. A justified per-line disable is acceptable, but this phase adds no suppressions. |
| `<img>` for the TOTP QR (`TotpSection`) | A generated `data:` URL; `next/image` gives no benefit. Same: leave, or one justified per-line disable. |
| `exhaustive-deps` × 2 (`DebtWorkspace`, `LiquidityWorkspace`) | `useMemo` would stabilise identities and change re-render timing of charts. No render test covers it, so this belongs with the browser pass. |
| `label`, `describeAssumption` unused in `lib/forecast/policy.ts` | Dead explanation helpers (about 30 lines) that look like unwired functionality. Deleting them is a product decision, not a lint fix. |

**Also noted, not changed:**
- `actions/checkout@v4` and `actions/setup-node@v4` run on Node 20 (forced to 24). Bump to v5 in a separate PR; Dependabot is configured to propose it.
- `ubuntu-latest` is moving to Ubuntu 26. Optionally pin `ubuntu-24.04`.
- The `site/` install reports 1 critical / 7 high advisories that the new audit gate (root only) does not cover.

## 8. Commits in this phase (on `remediation/beta-1`)

| SHA | Change |
|---|---|
| `0bd88ee` | TEST-006: post-deploy smoke classifier + tests + workflow + doc corrections |
| `b646f23` | Lint: remove 13 unused imports/locals |
| `58c57b3` | `ci-local`: `FM_CI_PG_IMAGE` rehearsal override |
| (this doc) | 14, 15, `docs/operations/preview-migration-runbook-beta1.md` |

## 9. Owner approvals needed to proceed

Each is separate; none is implied by another.

| # | Approval | Exact scope |
|---|---|---|
| **A1** | Push this phase's commits to the PR #1 branch | Fast-forward `origin/remediation/beta-1` from `1e697a6` to the new head (no force). Re-runs CI. The new smoke workflow will report UNVERIFIED (red) for Preview deployments until A4. |
| **A2** | Read-only `pg_dump` of Preview to local disk for rehearsal B | One `pg_dump --format=custom` with the Preview credentials; restore only into a local disposable `postgres:17.6`; delete the dump after the cutover. |
| **A3** | Confirm Preview backup posture | Owner reads the Supabase dashboard: last daily backup time and whether PITR is on, recorded in the release ticket. |
| **A4** | Add GitHub secret `VERCEL_AUTOMATION_BYPASS_SECRET` | The value of the **existing** automation-bypass secret on `fintracker1` (and the site's, if it differs: one secret serves only one project, so the site check stays UNVERIFIED unless both match or a second secret is added). Repository-settings change. |
| **A5** | Apply the nine migrations to Preview | `npm run db:migrate:safe` per the runbook §1–§5, with the privileges-preserving dump in §2. Preview only. |
| **A6** | Merge PR #1 into `v2.6` | Only after A5's §5 checks pass and CI is green on the final head. Triggers the `preview-app` redeploy. |
| **A7** | Browser smoke pass | Execute `15` on Preview (real OpenAI turns on the Preview key; Plaid Sandbox only). |
| **D12** (decision) | Preview database isolation for branch deployments | Keep the shared Preview DB for PR deployments, or give generic Preview its own disposable database or the RLS role URLs. A Vercel configuration change if chosen. |
| **D13** (decision) | `preview-app` protection | The project says custom domains are exempt from SSO, yet `preview-app` answered with the SSO redirect. Confirm the intended setting. |

Production stays untouched throughout. Its gates remain `11` §D (G0–G8).
