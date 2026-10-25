# Git branching & Vercel environment migration audit: `v2.6` → `develop`

**Date:** 2026-10-25
**Mode:** read-only. No branch, ruleset, Vercel or Production setting was changed.
**Recommendation:** **create-and-switch, not rename.** Create `develop` at the current `v2.6` HEAD (`15e6172`). Move each binding over and verify it while `v2.6` keeps working. Retire `v2.6` only after a soak period.

---

## 1. Current state

### 1.1 Branch and deployment map

```
feature/*, fix/*, sec/*  ──PR──▶  v2.6 (15e6172)  ──Vercel──▶  preview-app.fourthmeridian.com   (fintracker1, branch domain gitBranch=v2.6)
                                       │                    └▶  preview.fourthmeridian.com       (fourth-meridian-site, branch domain gitBranch=v2.6)
                                       │
                         release/v2.6-promotion-N  (main merged in, then PR → main)
                                       ▼
                                 main (ee95fed)  ──Vercel──▶  app.fourthmeridian.com          (fintracker1 production, dpl_Dq2joJaa…, built from ee95fed)
                                                         └▶  fourthmeridian.com              (fourth-meridian-site production)
```

| Item | Current value |
|---|---|
| GitHub default branch | `main` (repo is public) |
| Merge methods | merge, squash and rebase all allowed; `delete_branch_on_merge: false` |
| `main` ruleset (25690163) | No deletion, no force-push. PR required, 0 approvals. Required checks: `test` and `status-drift-guard`, **strict** (PR must be up to date with `main`). Admin bypass allowed (PR mode only). |
| `v2.6` ruleset (25690160) | No deletion, no force-push. PR required, 0 approvals. Required checks: `test`, `Architecture audits`, `Public site (zero-authority boundary)` and `status-drift-guard`, not strict. Admin bypass allowed (PR mode only). |
| Classic branch protection | none (rulesets only) |
| `main` vs `v2.6` history | `main` has 11 commits not in `v2.6`: promotion merges, the D17 hotfix merge, and `87e4df7` (whose content is in `v2.6` as `146a0dd`). `v2.6` has 5 commits not in `main`: PRs #29 and #30. |
| `main` vs `v2.6` trees | The only difference is #29 + #30 (19 files). `main`'s content is fully contained in `v2.6`. |
| Tags | `v2.0` … `v2.5.0`. **No `v2.6.0` tag exists**, although Production runs 2.6.0 (`ee95fed`). |
| Open PRs | **#31** `fix/brief-ai-paused-message` → **v2.6** (green, awaiting approval). #14–#23 are Dependabot PRs → `main`. |
| Dependabot | No `target-branch`, so it opens PRs against the default branch (`main`). This already bypasses integration. |
| Local worktrees | 20 worktrees. The main checkout is on a **stale** local `v2.6` (`cde8fa0`); owner instruction is to leave it alone. |

### 1.2 Vercel projects (read via API; nothing modified)

| | `fintracker1` (SaaS app) | `fourth-meridian-site` (marketing) |
|---|---|---|
| Git | `virtuarch/FourthMeridian`, **productionBranch `main`** | Same repo, **productionBranch `main`**, rootDirectory `site` |
| Production domain | `app.fourthmeridian.com` | `fourthmeridian.com` (+ `fourth-meridian-site.vercel.app`) |
| Preview domain | `preview-app.fourthmeridian.com`, **`gitBranch: v2.6`** | `preview.fourthmeridian.com`, **`gitBranch: v2.6`** |
| Ignored Build Step | none: every push builds | `git diff --quiet $VERCEL_GIT_PREVIOUS_SHA HEAD -- .`: **cancels** builds when `site/` is unchanged (most `v2.6` site deploys show CANCELED) |
| Deployment Protection | `ssoProtection: all_except_custom_domains` (Vercel "Standard": only **production** custom domains are public; `preview-app.` / `preview.` redirect to Vercel SSO, verified with 302 → vercel.com/sso-api) | same |
| Protection bypass | 1 automation bypass, used by GitHub `vercel-probe` | 1 |
| Crons (`vercel.json`) | `/api/jobs/dispatch` */15 and `/api/jobs/resume-stale-imports` */5. **Vercel runs crons on Production only**, so Preview never runs them. | none |
| Custom Environments | none | none |

**Environment variables scoped to the `v2.6` branch.** This is the critical finding. All are target `preview`. Values were not read: most are *Sensitive* and can't be read by anyone.

| Project | Key | v2.6-scoped record | Generic Preview record (used by other branches) |
|---|---|---|---|
| fintracker1 | `DATABASE_URL_APP` / `_AUTH` / `_SYSTEM` | sensitive, 2026-10-06 (RLS cutover) | sensitive, 2026-10-22 |
| fintracker1 | `FM_RLS_STRICT` | sensitive, 10-06 | sensitive, 10-22 |
| fintracker1 | `CRON_SECRET` | sensitive, 10-06 | sensitive, 06-30 |
| fintracker1 | `NEXTAUTH_SECRET` | sensitive, rotated 10-07 (domain split §4.4) | sensitive, updated 10-23 |
| fintracker1 | `NEXTAUTH_URL`, `NEXT_PUBLIC_APP_URL` | encrypted, 10-06 (= `https://preview-app.fourthmeridian.com`) | sensitive, 07-27 |
| fintracker1 | `NEXT_PUBLIC_SITE_URL` | encrypted, 10-06 | **no generic record** |
| site | `NEXT_PUBLIC_APP_ORIGIN`, `NEXT_PUBLIC_SITE_ORIGIN` | plain, 10-06 | encrypted, 10-04 |

The remaining 22 Preview keys are shared by all Preview branches: OpenAI, Plaid, encryption key, `DATABASE_URL`, `DIRECT_URL`, and others.

### 1.3 How `preview-app.fourthmeridian.com` is assigned and redeployed

- It's a **project domain with `gitBranch: v2.6`** on `fintracker1` (no DNS change is involved; DNS is at NameBright and points at Vercel).
- Each **successful (READY) deployment of a push to `v2.6`** is automatically aliased to it. Today that's `dpl_BUTSmN8p…` = `15e6172`.
- Only a push to `v2.6` (a PR merge) moves it, or a manual `vercel alias`. Feature-branch and PR deployments get their own `*.vercel.app` URLs and **never** touch it.
- The branch-scoped env vars above are applied **at build time** of a `v2.6` deployment. A deployment keeps the values it was built with.
- `preview.fourthmeridian.com` works the same way on the site project, but only advances when a `v2.6` push changes `site/`, because of the Ignored Build Step.

### 1.4 GitHub Actions

| Workflow | Trigger | Bound to `v2.6`? |
|---|---|---|
| `ci.yml` (`test`, `Architecture audits`, `Public site`) | push `**`, pull_request, dispatch | No, branch-agnostic |
| `status-drift-guard.yml` | pull_request + **push `branches: ["v2.6"]`** | **Yes** (push trigger) |
| `trusted-deployment-health.yml` | **push `branches: [v2.6, main]`**, environment `vercel-probe` | **Yes** |
| `post-deploy-smoke.yml` ("Deployment health") | `deployment_status` from vercel[bot] | No. It fails with 401 on every Preview deployment by design (no bypass secret), and isn't required. |
| GitHub Environment **`vercel-probe`** | deployment-branch policy = **`main`, `v2.6`** only; holds `VERCEL_AUTOMATION_BYPASS_SECRET_APP` / `_SITE` | **Yes** |
| `scripts/ci-local.test.ts:83` | pins the exact text `branches: [v2.6, main]` in the trusted-health workflow | **Yes**, must change in the same commit |

No release automation exists: no tag-triggered workflows, no `release-please`, no deploy scripts. Deploys are entirely Vercel Git integration.

### 1.5 `v2.6` references

There are 1,356 hits for `v2.6` (lock file excluded). **About 1,300 are version or work-stream labels** in comments, tests and docs ("v2.6 Phase 3", `v2.6-OWN-2`, `lib/release-version.test.ts` asserting package version 2.6.0). They aren't branch references and need no change.

48 are references to the **branch**. These need to change:

| File | What |
|---|---|
| `.github/workflows/trusted-deployment-health.yml:30` | `branches: [v2.6, main]` (+ comments at lines 3, 12, 14, 24) |
| `.github/workflows/status-drift-guard.yml:27` | `branches: ["v2.6"]` (+ comment at line 16) |
| `.github/workflows/post-deploy-smoke.yml:36` | comment only |
| `scripts/ci-local.test.ts:83` | pin on the trusted-health trigger text |
| `scripts/trusted-deployment-health.mjs:2,11,25`, `scripts/post-deploy-smoke.mjs:149` | comments only |
| `docs/operations/branching-and-protection.md` | the branching runbook (§1 table, §2 diagram, §4 ruleset JSON, promotion steps). It's also **already stale**: it says the app's production domain is the apex. |
| `docs/operations/domain-split-preview.md` | Preview domain and env record (`gitBranch: v2.6`) |
| `docs/operations/production-cutover-plan.md:41` | historical comparison; leave as history |
| `STATUS.md` | historical "pushed `origin/v2.6` HEAD" rows; leave as history and add a migration row |
| `docs/plans/*` (~25) | historical reports; leave unchanged |

Nothing in the **application code** reads the branch name. The code keys on `VERCEL_ENV` (`lib/env.ts`, `lib/db/strict-mode.ts`, Sentry). No `VERCEL_GIT_COMMIT_REF` is used anywhere.

---

## 2. Answers to the specific questions

**Can the existing Preview project and deployment stay intact while the source branch changes?** Yes.
- Branch is a per-domain and per-env-var attribute of the same project. No new project or domain is needed, and no DNS change.
- The live `v2.6` deployment keeps serving `preview-app.` until a READY `develop` deployment replaces it, so there's no gap.
- The one hard requirement: the **branch-scoped env vars must apply to `develop` before the `develop` build that gets aliased**. Otherwise that build silently uses the generic Preview database URLs, auth secret and auth URL.

**Would a rename disrupt open PRs or ongoing work?** Yes. A rename breaks every binding at the same moment, with no way to verify anything in between.

| Binding | GitHub rename v2.6 → develop |
|---|---|
| Open PR #31 | Retargeted automatically. This part is fine. |
| Ruleset `refs/heads/v2.6` | **Not updated.** `develop` is unprotected until edited. |
| Vercel domains (`gitBranch: v2.6`) | **Not updated.** `preview-app.` and `preview.` freeze. |
| Vercel branch-scoped env (11 records) | **Not updated.** The next `develop` build gets the generic Preview database, auth secret and URLs. |
| Workflows and `vercel-probe` policy | **Not updated.** Trusted health stops; the drift guard's push trigger stops. |
| 20 local worktrees, scripts, notes | Upstream `origin/v2.6` shows "gone". |
| Rollback | Rename back, but anything that already built from `develop` must be undone by hand. |

Create-and-switch lets each binding move one at a time, with `v2.6` as a working fallback.

**Environment-specific risks:**

| Area | Risk | Assessment |
|---|---|---|
| Preview database (Supabase pooler, ref `lqagrry…`) and RLS roles | The `develop` build falls back to the **generic** `DATABASE_URL_APP/_AUTH/_SYSTEM` and `FM_RLS_STRICT` (created 10-22, values unknown) | **High if mis-sequenced.** Must re-scope (or re-enter) before the aliased build. |
| Authentication (NextAuth) | Generic `NEXTAUTH_URL` / `NEXTAUTH_SECRET` differ from the v2.6 records | Same mitigation. Hostname is unchanged, so OAuth or email callback URLs need no change. Re-entering a **new** secret just signs Preview users out. |
| `NEXT_PUBLIC_SITE_URL` | **No generic record.** A `develop` build without it is missing the variable entirely. | Must move with the others |
| Plaid | Webhook and OAuth redirect come from the deployment's own origin (`87e4df7` / `146a0dd`); the host is unchanged | Low. Sandbox Items on Preview are unaffected. |
| Scheduled jobs | Vercel crons run on Production only | None for Preview. Production isn't touched. |
| OpenAI, encryption key, other secrets | Not branch-scoped | None |
| Marketing site | Ignored Build Step may **cancel** the site redeploy that would apply the moved env | Medium. Use a manual redeploy for the site, or point the domain at the first `develop` site build after its env is moved. Verify that a manual redeploy isn't cancelled. |
| `vercel-probe` secrets | The policy admits only `main` / `v2.6`, so a `develop` push is refused | Add `develop` before switching. Refusal fails closed (health is unverified, nothing leaks). |
| Production | No setting involved | `productionBranch` stays `main`, and the `app.` / apex domains have no gitBranch |

---

## 3. Recommended target workflow

```
feature/*, fix/*, sec/*  ──PR (4 required checks)──▶  develop  ──auto──▶  preview-app. / preview.
                                                          │
                                       promotion PR develop → main (approval; 2 strict checks)
                                                          ▼
                                                        main  ──auto──▶  app. / fourthmeridian.com
                                                          │
                                       annotated tag vX.Y.Z on the main merge commit (immutable)
                                                          │
                                       back-sync main → develop (PR) so the next promotion is up to date
release/* only when a freeze is needed; hotfix/* from main → main, then back-sync to develop
```

Notes:
- Because `main`'s check policy is **strict**, a `develop → main` PR must contain `main`'s tip. Today that's why the `release/v2.6-promotion-N` branches merge `main` in. A routine **main → develop sync PR after each promotion** removes the need for those branches.
- Make **`develop` the default branch**. New PRs then default to `develop`, and Dependabot targets it. If you'd rather keep `main` as default, add `target-branch: develop` to the three Dependabot ecosystems instead. **This is an owner choice.**
- Tag Production now: create an annotated `v2.6.0` on `ee95fed`, the commit Production runs. This is a separate approval.
- Optional, later: a Vercel Custom Environment ("staging", `branchMatcher: develop`) would bind env vars to an environment rather than a branch name, so future branch changes wouldn't need env edits. It isn't needed for this migration.

---

## 4. Migration sequence (each step is gated; nothing done yet)

**Phase 0: prepare** (no settings changes)
1. Settle **PR #31**: merge it into `v2.6` (needs your approval), or plan to retarget it after step 5. Merging first is simplest.
2. Freeze merges to `v2.6` for the migration window (about 1 hour). Record the frozen SHA as `S`.
3. Have the values for the 9 sensitive app records ready **in case** re-scoping isn't possible: `tmp/rls-preview-cutover/preview.env` plus your password manager. They're needed only for the fallback in step 7b.

**Phase 1: GitHub**
4. Create `develop` at `S` with `gh api repos/:o/:r/git/refs -f ref=refs/heads/develop -f sha=S`.
   - Vercel builds an **un-aliased** `develop` Preview with the generic env. That's harmless: it gets no domain, and Preview doesn't run crons.
5. Create ruleset **"develop — integration (PR + CI required)"**, an exact copy of 25690160 with `include: ["refs/heads/develop"]`.
6. Add `develop` to the GitHub Environment `vercel-probe` deployment-branch policy, keeping `main` and `v2.6` for now.

**Phase 2: Vercel**, in this order: env vars first, then domains.
7. For each of the 9 app records and 2 site records scoped to `v2.6`:
   - **a.** Preferred: edit the record's `gitBranch` from `v2.6` to `develop`. The value is preserved and never re-entered or exposed. Test this on a site `plain` record first, to confirm the edit keeps the value.
   - **b.** Fallback: add a new `develop`-scoped record with the value from step 3, and delete the `v2.6` record later.
8. Redeploy the `develop` app deployment with **no build cache**. Confirm it's READY and has the `develop`-scoped values (by behaviour, see §7: health, sign-in, database identity read through the app).
9. Change domain `preview-app.fourthmeridian.com` `gitBranch` from `v2.6` to `develop`. Then, if Vercel doesn't reassign it automatically, alias it to the step-8 deployment.
10. Do the same for the site:
    - manually redeploy `develop` (bypassing the ignore step if needed);
    - change `preview.fourthmeridian.com` `gitBranch` to `develop`;
    - verify.

**Phase 3: repo** (one PR into `develop`)
11. PR "Branching: develop replaces v2.6":
    - `trusted-deployment-health.yml` becomes `[develop, main]`;
    - `status-drift-guard.yml` becomes `["develop"]`;
    - the pin in `ci-local.test.ts`;
    - the comments in the scripts and workflows;
    - rewrite `docs/operations/branching-and-protection.md` and the Preview section of `domain-split-preview.md`;
    - a `STATUS.md` row.

    Merging it is the first real push to `develop`. It exercises the full path: CI, the Vercel build with the moved env, the `preview-app.` alias, and Trusted deployment health with secrets.
12. Optional: open a "sync main → develop" PR. The content is a no-op, since trees already match apart from #29/#30; it only brings `main`'s merge commits into `develop`. After it, the first `develop → main` promotion PR can satisfy the strict policy without a release branch.
13. Optional, owner choice: set the default branch to `develop`, or add Dependabot `target-branch: develop`. Retarget the open Dependabot PRs if you want.

**Phase 4: retire `v2.6`** (after about 7 days of soak)
14. Remove `v2.6` from the `vercel-probe` policy.
15. Delete the `v2.6` ruleset. Delete any leftover `v2.6`-scoped env records (if step 7b was used).
16. Optionally tag `v2.6` HEAD (e.g. `integration/v2.6-final`), then delete the branch, or keep it as a read-only archive. Leave the local `v2.6` checkouts alone, as instructed.

---

## 5. Settings that change

| System | Setting | From → To |
|---|---|---|
| GitHub | branch | add `develop` @ `S` (and later remove `v2.6`) |
| GitHub | ruleset | add `develop` ruleset (copy of 25690160); later delete 25690160 |
| GitHub | Environment `vercel-probe` → branch policy | `main, v2.6` → `main, develop` (both for a while) |
| GitHub | default branch *(optional)* | `main` → `develop` |
| GitHub | Dependabot `target-branch` *(optional, alternative to the default-branch change)* | none → `develop` |
| Vercel fintracker1 | domain `preview-app.fourthmeridian.com` | `gitBranch v2.6 → develop` |
| Vercel fintracker1 | 9 Preview env records | `gitBranch v2.6 → develop` |
| Vercel site | domain `preview.fourthmeridian.com` | `gitBranch v2.6 → develop` |
| Vercel site | 2 Preview env records | `gitBranch v2.6 → develop` |
| Repo | 2 workflow triggers, 1 test pin, runbooks | per §1.5 |
| **Unchanged** | Vercel `productionBranch` (main), `app.` and apex domains, Production env, crons, DNS, Supabase, Plaid, OpenAI, protection bypass secrets | — |

## 6. Rollback

All of these are reversible in minutes, and `v2.6` stays intact until Phase 4.

| Failure found at | Rollback |
|---|---|
| Step 4–6 | Delete the `develop` branch and ruleset; remove `develop` from `vercel-probe`. |
| Step 7–8 (env) | Edit the records' `gitBranch` back to `v2.6`. The live `preview-app.` is still the `v2.6` deployment at this point, so it isn't affected. |
| Step 9–10 (domains) | Set the domain `gitBranch` back to `v2.6` and alias it to `dpl_BUTSmN8p…` (or the newest `v2.6` deployment). This takes effect at the Vercel edge immediately; no DNS change. |
| Step 11 | Revert the PR (only workflow triggers and docs). |
| After Phase 4 | Recreate `v2.6` from the archive tag and reverse the steps above. |

## 7. Risks and expected downtime

- **Production:** no downtime and no change.
- **Preview:** no downtime expected. `preview-app.` keeps serving the current `v2.6` deployment until a verified `develop` deployment replaces it. If something goes wrong, Preview shows a slightly old build; it doesn't go down.
- **Session impact:** none if the auth secret is re-scoped (7a). If it's re-entered with a new value (7b), Preview users sign in again.
- **Highest risk:** a `develop` build gets aliased before its env is moved. It would then run against the generic Preview database credentials and auth secret. The ordering in §4 (env, then redeploy, then domain) prevents this, and the verification below catches it.
- **Unknowns to confirm during the migration (not knowable read-only):**
  - whether editing a Sensitive record's `gitBranch` keeps its value (tested first on a plain site record);
  - whether a manual site redeploy is subject to the Ignored Build Step;
  - whether Vercel accepts `gitBranch: develop` before that branch exists. The sequence avoids depending on this by creating the branch first.

## 8. Verification checklist

**After each Vercel step**
- [ ] `preview-app.fourthmeridian.com` resolves to a `develop` deployment (`vercel inspect`): READY, with commit `S` or later.
- [ ] Preview health: `GET /api/health` returns `status: ok, db: ok`. Check through protection: Trusted deployment health (bypass secret), or a signed-in browser. An anonymous curl only gets the SSO redirect.
- [ ] The database is the Preview database, under strict RLS. Signing in works, and the panels that show the environment read **PREVIEW** (Operational Controls badge).
- [ ] Sign-in on `preview-app.` works; the callback stays on `preview-app.`. No `NEXTAUTH_URL` mismatch in logs.
- [ ] `preview.fourthmeridian.com` serves the site, and its links point to `preview-app.` (not `app.`).
- [ ] No `v2.6`-scoped env record remains needed (Phase 4).

**After the repo PR (step 11)**
- [ ] On the `develop` push: CI (`test`, `Architecture audits`, `Public site`) green; `status-drift-guard` ran; **Trusted deployment health** ran in `vercel-probe` and verified both projects through protection.
- [ ] `npm run ci` green on HEAD (includes the updated pin).

**Isolation**
- [ ] `app.fourthmeridian.com` is still `dpl_Dq2joJaa…` (or the expected Production), health ok, and there's no new Production deployment.
- [ ] Vercel `productionBranch` is still `main` for both projects; Production env is untouched; crons are untouched.
- [ ] Open PRs target `develop` (or `main` for Dependabot, as decided); #31 was resolved before the migration.

## 9. Decisions needed from the owner

1. Approve **create-and-switch** (recommended) rather than rename.
2. PR #31: merge it into `v2.6` before the migration, or retarget it to `develop` after.
3. Default branch: `develop`, or keep `main` and add Dependabot `target-branch: develop`.
4. Tag Production `v2.6.0` on `ee95fed`.
5. Soak period before retiring `v2.6` (proposed: 7 days). Then delete the branch, or keep it as an archive.

---

## 10. Execution record (2026-10-25/26)

**Owner decisions:**
- Create-and-switch: approved.
- PR #31: merge into `v2.6` first.
- Keep `main` as the default and Production branch.
- Tag `v2.6.0` on `ee95fed`.
- Keep `v2.6` for a soak of at least 7 days.

| Step | Result |
|---|---|
| PR #31 | Head `80a2906` unchanged and green on all required checks. Merged with `--match-head-commit` → **`7435ded`**. The `v2.6` push ran green: test, Architecture audits, Public site, status-drift-guard, **Trusted deployment health**. Preview at `dpl_HJVUJuf5…`. |
| Ruleset | **25836806** `develop — integration (PR + CI required)`, created *before* the branch. Rules identical to 25690160 (diffed). |
| Branch | `develop` created at `7435ded` (v2.6 HEAD re-verified first). Vercel made no automatic deployment (the commit was already deployed), so nothing ever built with the generic Preview env. |
| Env records | 11 `develop`-scoped Preview records created (9 fintracker1, 2 site). The 11 `v2.6` records, every other record, and all 37 Production records are unchanged (`updatedAt` compared). Key sets and types are equal. All 5 non-secret values read back equal to `v2.6`. |
| Sensitive values | DB role URLs were copied from the cutover credentials after proving them live, read-only, as `fm_app` / `fm_auth` / `fm_system` (no RLS bypass) on the Preview ref. `FM_RLS_STRICT` = `true`. **`NEXTAUTH_SECRET` and `CRON_SECRET` are new random values**: the `v2.6` values are write-only and stored nowhere else. Nothing was printed. |
| Deployments (Git-sourced, Preview) | App **`dpl_F8GwppcW53M78ByCM7kMzor8asaA`** and site **`dpl_ECSqcAnCjra9EWbE1b2M26ihVjDG`**, both `develop` @ `7435ded`, both READY. |
| Verified before the switch (automation bypass, never printed) | Health ok, db ok. The scheduler record is identical to the `v2.6` Preview record (last dispatch 10-07) and differs from Production's (20:15 today), so this is the **Preview DB**. Auth callback is on `preview-app.`, and the CSRF endpoint works (auth secret present). **`/privacy` → 308 `https://preview.fourthmeridian.com/privacy` on `develop`**, while a generic-env build serves 200: the branch overrides were applied. The site links to `preview-app.` 12 times and to `app.` 0 times, same as live `preview.`. |
| Domain switch | `preview-app.` and `preview.` set to `gitBranch: develop`. Vercel reattached them at once to `dpl_F8Gwppc…` / `dpl_ECSqcAn…`. All checks re-run on the real domains: pass. Anonymous requests still get the SSO 302. |
| Production | `app.` = `dpl_Dq2joJaa…`, apex = `dpl_5JHyp77j…`, `productionBranch: main` on both projects, health ok. No Production setting touched. |
| Preview side effects | AiInvocation is still 236 (0 new). No AuditLog rows. `maintenance_mode` is absent. |
| `vercel-probe` | Branch policy is now `develop`, `main`, `v2.6`. |
| Fallback | `v2.6` frozen at `7435ded`. App `dpl_HJVUJuf5wiiVe7hyVdpeCVr3tLNY`, site `dpl_5cC5eW8RBEPua92CzY1AsUJG3Kvi`. |

**Soak started 2026-10-26.** `v2.6` can be retired no earlier than 2026-11-02, per `docs/operations/branching-and-protection.md` §7.
