# 17 — Preview infrastructure hardening (A3, A4b, D12)

**Date:** 2026-10-22.

**Authorised:** A3, A4b, D12, read-only inspection, local doc and test updates. **Not authorised:** A5 (Preview migrations), A6 (merge), anything in Production.

**Branch:** `remediation/beta-1`. GitHub head `2fe8eb7`; local commits after it are listed in §8. They are unpushed.

## 0. Baseline (before any change)

| Item | Value |
|---|---|
| `remediation/beta-1` | local = remote = `2fe8eb7522cea7de313242a1d716f17fe8d2a8f4` (A1b push confirmed) |
| `v2.6` / `main` | `cde8fa0` / `87e4df7`, untouched |
| PR #1 checks @ `2fe8eb7` | `test` ×2, `Architecture audits` ×2, `Public site` ×2, `status-drift-guard`, Vercel `fintracker1`: pass. `Deployment health`: UNVERIFIED-by-design (the secret-free `deployment_status` check). Mergeable; state `UNSTABLE` only from that check. |
| Vercel aliases | `preview-app.fourthmeridian.com` → `dpl_HL5AEPnb…` (`v2.6` `cde8fa0`). `preview.fourthmeridian.com` → `dpl_BQGwD8ac…` (site). `fourthmeridian.com` → `dpl_JcZ52DcQ…` (`fintracker1` Production `87e4df7`). |
| Vercel env | `fintracker1` 65 rows; `fourth-meridian-site` 6 rows. Recorded as key / target / gitBranch / type / id / updatedAt, **no values**, in the owner's private directory. |
| Preview DB fingerprint (read-only) | PG 17.6 · 126 migrations · newest `20261016000000` · `JobRun` 1 @ 2026-10-07 19:09:08.654 · 5 users · 14 Spaces · 67 accounts · 1,258 transactions · user-id hash `44fc14c1…`. `RateLimit` is volatile: the app counts health probes. |

## 1. Summary

| Phase | Outcome |
|---|---|
| A3 backups / PITR | **Partly closed.** Facts read from the dashboard (owner signed in; read-only; no Restore clicked). **PITR is disabled.** |
| A4b GitHub Environment + secrets | **Done.** `vercel-probe` admits branches `v2.6` and `main` only. Denial was **proven on GitHub with canary secrets** before the real values were installed: 4 of 4 untrusted runs refused, 0 steps run. Real per-project secrets installed; 0 repository-level secrets. |
| D12 branch isolation | **Interim applied and proven safe for `v2.6`. Full isolation blocked:** it needs a new database, which is either paid or requires owner-only creation (§4). |
| Health verification | `preview-app` (`cde8fa0`) HEALTHY; site HEALTHY; rebuilt branch build HEALTHY under strict RLS; DB fingerprint unchanged. |
| Browser readiness | **Not ready for the AI and provider rows.** The AI kill switch is OFF, and the OpenAI project and `PLAID_ENV` are unverifiable (Sensitive). See §6. |

## 2. A3: Supabase backup and PITR (dashboard, read-only)

| Question | Evidence | Answer |
|---|---|---|
| Plan and backup entitlement | Org **VirtuArch**: **Pro Plan**, 2 projects (`fourth-meridian-preview` Nano, `fourth-meridian-production` Micro, both ap-southeast-1). Spend cap ON. | Pro: daily backups |
| Most recent completed backup | Scheduled backups: **21 Oct 2026 22:53:42 UTC, PHYSICAL**. The "Restore to new project" list shows it COMPLETED. | about 15 h before this read |
| Retention | 7 listed: 15 → 21 Oct, one per day | **7 days** |
| PITR | Database → Backups → Point in time: "available as an add-on"; Add-ons: **Point in time recovery: DISABLED** | **No PITR** |
| Recovery window | daily granularity only | RPO up to about 24 h from platform backups |
| Where restores land | (1) **Restore** on a scheduled backup: **in place**, replaces the Preview database. (2) **Restore to new project (beta)**: creates a **separate** project; Preview untouched. | both offered |
| Roles and grants | Physical backups are cluster-level (WAL-G base backups), so roles and grants are included by construction. This is an inference from "PHYSICAL", not a restore test. A **logical** restore with grants and policies was proven locally in A2 (doc 16 §2). | preserved (physical, inferred); proven (logical) |
| Health of WAL shipping | SQL: `archive_mode=on`, `pg_stat_archiver` 8,209 archived, **0 failed**, last archived 3 min before the read | healthy |

**Open (A3 partial):**
- No restore was timed, so RTO is unmeasured.
- Physical-restore role preservation is inferred, not tested.
- PITR is off, so before A5 the runbook's **logical dump is the only point-in-time recovery point**. The runbook is updated.
- Decide PITR for **Production** before beta (G0c).

## 3. A4b: restricted GitHub Environment and secrets

**Design finding.** Vercel creates every GitHub Deployment with `ref` = **the commit SHA**, verified on the last three. A `deployment_status` run's ref is therefore a SHA:
- an environment restricted to branches `v2.6` and `main` can never admit it, not even for `v2.6`;
- any repository secret placed in that workflow is readable by whoever edits the workflow on a branch, because `deployment_status` runs the workflow file from the deployed commit.

So the design splits in two:

| Workflow | Trigger | Secrets | Verifies |
|---|---|---|---|
| `post-deploy-smoke.yml` | `deployment_status` (every deployment) | **none** | Public deployments (Production) for real. Protected Previews are **UNVERIFIED (red), by design**, never false green. |
| `trusted-deployment-health.yml` (new) | **push to `v2.6` / `main` only** | `vercel-probe` environment: `VERCEL_AUTOMATION_BYPASS_SECRET_APP`, `_SITE` | Waits for the commit's Vercel deployments via the GitHub API, then probes each through protection with **its own** project's secret. Fails on UNHEALTHY, UNVERIFIED, a failed deployment, still pending, or none found. Skips Ignored-Build-Step cancellations. |

**Environment as configured:**
- `vercel-probe`: deployment branches = **custom policies: `v2.6`, `main` (type branch)**; protected-branches mode off; no reviewers; no wait timer.
- Repository-level secrets: **0**. Environment secrets: the two above.

**Secret-access verification (on GitHub, canary values first):**
- A throwaway branch `probe/vercel-probe-denial` was cut from `v2.6` (`0cffc1e`).
- It carried a hostile workflow that referenced `environment: vercel-probe` and tried to print a SHA-256 prefix of each secret.
- It was triggered three ways: by push, by `workflow_dispatch` from that ref, and by `deployment_status` when Vercel built the branch.

| Run | Event | Outcome |
|---|---|---|
| 39794462933 | push | refused: "Branch "probe/vercel-probe-denial" is not allowed to deploy to vercel-probe due to environment protection rules."; no runner, 0 steps |
| 39794478013 | workflow_dispatch | refused (same annotation); no runner, 0 steps |
| 39794499634 | deployment_status | refused (same annotation); concluded `failure`; no runner, 0 steps; **no log exists** |
| 39794806911 | deployment_status (2nd deployment) | refused (same annotation); no runner, 0 steps |

**Correction to my earlier premise.** GitHub resolved the `deployment_status` runs to the **branch** (`head_branch = probe/vercel-probe-denial`) even though Vercel's deployment ref is the SHA. So the environment would also have judged a `deployment_status` run by branch. The push-only trusted design is still preferred, because it does not depend on that inference. The workflow comments are corrected.

**After the proof:**
- Held runs left to GitHub to finalise; they cannot be cancelled.
- Throwaway branch deleted on GitHub and locally.
- Canaries replaced by the real values, piped from each Vercel project's API straight into `gh secret set --env vercel-probe`, never printed.
- The branch's Vercel Preview deployment remains, as a build of `v2.6` code; deleting it is left to the owner.

**Behaviour verification (same code, run locally against real deployments; values never printed):**

| Case | Result |
|---|---|
| Trusted path, commit `2fe8eb7` (PR app build) with secrets | `Preview – fintracker1`: **HEALTHY** |
| Trusted path, commit `cde8fa0` (`preview-app` build) with secrets | **HEALTHY**, `commit cde8fa0 ⊂ cde8fa0e…` |
| Same, without secrets | **UNVERIFIED**, exit 1 |
| Site, own secret | `preview.fourthmeridian.com` and the PR site build: **HEALTHY** |
| Site with only the app's secret | not sent (`bypassFor`) ⇒ UNVERIFIED (unit-tested) |
| UNHEALTHY | unit-tested on captured shapes (5xx, 404, bare 401, HTML on the health route, commit mismatch, no response). Real instance: `app.fourthmeridian.com` gives no response ⇒ UNHEALTHY (doc 14 §1). |

**Not yet demonstrable:** a **GitHub-side** trusted run. The new workflow exists only on `remediation/beta-1` until PR #1 merges (A6), and pushing to `v2.6` is not authorised. The first `v2.6` push after the merge is that test.

## 4. D12: branch-deployment isolation

**Full isolation (preferred architecture): blocked, owner decision.**

| Option | Cost / plan | Why not done autonomously |
|---|---|---|
| A. New project in the Free org "chrhogan1997-2301's projects" (0 projects; **managed via Vercel Marketplace**) | free (Free tier: pauses when idle, 500 MB) | Creation requires setting a database password in Supabase's form, which I don't enter. A Marketplace-managed org can also **inject database env vars into linked Vercel projects**, which is the "silent move" risk to `preview-app` and Production. |
| B. Third project in VirtuArch (Pro) | Pro compute credit already used by 2 Micro-class projects (projected $34.95 this cycle); a third adds about $10/month | unplanned paid infrastructure |
| C. Supabase branching on Pro | billed per branch-hour | paid |

**Interim (applied): least privilege for branch builds, proven not to touch `v2.6`.**
- **Change:** four Sensitive variables added to `fintracker1` generic **Preview** scope only:
  - `DATABASE_URL_APP` (`fm_app.<ref>`), `DATABASE_URL_AUTH` (`fm_auth.<ref>`), `DATABASE_URL_SYSTEM` (`fm_system.<ref>`), all through the Supabase pooler on 6543;
  - `FM_RLS_STRICT=true`.
- **Before adding:** each credential authenticated **read-only** as its role, `rolbypassrls=f`, `rolsuper=f`.
- **Why `v2.6` cannot change:**
  - `Preview@v2.6` already defines all four keys, and branch-scoped values take precedence.
  - The diff of all 69 env rows against the baseline is **exactly 4 additions** at `target=preview, gitBranch=-`. Every `v2.6` row and every Production row is byte-identical (same id, same `updatedAt`).
  - Existing deployments are immutable, and the `preview-app` alias still points at `dpl_HL5AEPnb`.
- **Effect, verified on a rebuild of PR #1's branch deployment** (`vercel redeploy` → `dpl_Ah2ZJr71…`, Preview):
  - It **boots**. Strict mode refuses to start on a missing role URL or one naming the migration principal.
  - `/api/health` is `ok`.
  - A new `fm_system` backend appeared 70 ms after the probe (the scheduler reader on `systemDb`). Before, an unset role URL fell back to the migration principal.
- **Not achieved by the interim:**
  - Branch builds still get `DATABASE_URL` (the migration principal, BYPASSRLS) for the `db` client. The health ping, rate limiter and admin paths use it, so **branch builds can still reach shared Preview data through that client**.
  - Branch builds still inherit the Preview **OpenAI, Resend and Plaid** keys. Removing them from generic Preview would also remove them from `v2.6`, which inherits them and has no branch-scoped copies; the values are Sensitive and cannot be copied. Owner action: re-enter them at `Preview@v2.6` scope first.

**Full-isolation procedure, once the owner provides a database (owner creates it; then this order, each step verified):**
1. Add `DATABASE_URL` and `DIRECT_URL` at `Preview@v2.6` scope with today's shared-Preview values (owner pastes; Sensitive). Redeploy `v2.6`. Verify `preview-app` health and fingerprint.
2. In the new database: run the 135 migrations, create the roles as in the runbook, seed test data.
3. Repoint **generic** Preview `DATABASE_URL` / `DIRECT_URL` and the three role URLs to the new database.
4. Re-enter OpenAI, Resend and Plaid at `Preview@v2.6` scope. Then replace generic Preview with sandbox-only Plaid and remove OpenAI and Resend.
5. Redeploy one branch build. Verify its `/api/health` scheduler block differs from shared Preview (the one-row `JobRun` fingerprint).

## 5. Health verification after configuration

| Check | Result |
|---|---|
| `v2.6` shared Preview serves its existing code | `preview-app.fourthmeridian.com/api/health` (bypass): **HEALTHY**, `commit cde8fa0` |
| Its DB fingerprint unchanged | **identical** before and after (`v2.6` fields above; `RateLimit` 305 → 307 from probes only) |
| Public site checked on the site project's host and secret | `preview.fourthmeridian.com` → `fourth-meridian-site`: **HEALTHY** (200 HTML at `/`) |
| Branch build reaches the app, not the login wall | rebuilt branch deployment: **HEALTHY** with bypass, UNVERIFIED without |
| Strict RLS for branch applications | **enabled** (boots under `FM_RLS_STRICT=true`; role sessions observed) |
| Branch builds cannot access shared data / do not use the migration principal | **NOT met.** The interim keeps `DATABASE_URL` on shared Preview (§4). |

## 6. Browser-validation readiness (A7)

| Precondition | Status |
|---|---|
| Plaid environment is sandbox | **Unverified.** `PLAID_ENV` is Sensitive. In the DB, `PlaidItem.plaidEnvironment` is null on all 12 items and `environment` is `preview` on 2. **Owner check (D14).** The three ACTIVE items (created 2026-06-22, 06-23, 10-06) must not be refreshed. |
| OpenAI separate non-production project, or kill switch ON | **Neither verified.** `OPENAI_EXPECTED_ENVIRONMENT=preview` (a declared intent only); key and project id are Sensitive; `ai_paid_requests_paused=false` (kill switch **OFF**). AI rows (`15` §H) are **blocked** until the owner confirms the project or turns the switch ON. |
| No Production Resend credentials | **Unverified** (Sensitive). Owner check (D14). E-mail rows go only to owner-controlled addresses. |
| URLs and authentication | `preview-app.fourthmeridian.com` and `preview.fourthmeridian.com`, both behind Vercel SSO. A tester needs Vercel team access, or uses the trusted bypass only for automated probes. |
| Registration on `preview-app` | **open** (no `registration_mode` row; `cde8fa0` default). `invite_only` arrives with PR #1. Row C1 expectation depends on merge state. |
| Code under test | `preview-app` serves `cde8fa0`. The matrix (`15`) targets PR #1's code, which needs A5 + A6 first. Until then only the existing-behaviour rows are meaningful. |
| Test accounts and roles | Use owner-controlled plus-addresses. T1 (no TOTP), T2 (TOTP), ADM (system admin + TOTP), T3 (second member). Create through the app's invite flow after A6; record in the release ticket. No real customer data exists on Preview (5 test users). |

**Executable plan:** doc 16 §8 sessions 1–5, with two gates added:
- **Gate 0 (owner, before session 1):** D14 answers recorded (Plaid sandbox, OpenAI project, Resend) and A5 + A6 complete.
- **Session 4 (AI) runs only if** the OpenAI project is non-production **or** the kill switch is ON. In the latter case, execute H1 and H5 only.

## 7. Outstanding approvals and blockers

| # | Item | Owner action |
|---|---|---|
| **A1c** | Push local commits (§8) to PR #1 | approve |
| **A3 rest** | PITR for Production (G0c); a timed restore if wanted | decide |
| **D12 full** | Choose a database: option A (free; owner creates the project and confirms no Marketplace env injection) or B/C (paid) | choose + create |
| **D14** | Confirm `PLAID_ENV=sandbox`, the OpenAI project for Preview, and the Resend key scope; re-enter provider keys at `Preview@v2.6` if they are to leave generic Preview | read Vercel dashboard |
| **A5** | Preview migrations (runbook) | not approved |
| **A6** | Merge PR #1; the first `v2.6` push is the GitHub-side trusted-health test | not approved |
| **A7** | Browser pass | after Gate 0 |
| **cleanup** | Branch `probe/vercel-probe-denial` deleted; its Vercel Preview deployment (a build of `v2.6` code) and its GitHub deployment records remain | owner may delete the deployment |

## 8. Local commits (unpushed)

| SHA | Change |
|---|---|
| `22acbd1` | A4b: `trusted-deployment-health.yml` + `scripts/trusted-deployment-health.mjs` (+ 8 tests); `post-deploy-smoke` secret-free; `probeDeployment()` shared; ci-local pins |
| this commit | docs 17 / 11 / 14 / 16, runbook, checkpoint; corrected deployment_status rationale in comments |

The trusted workflow takes effect only once it is on `v2.6` (A6). Until then the secrets sit unused in `vercel-probe`.
