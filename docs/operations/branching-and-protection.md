# Branching model, deployment mapping and branch protection

**Status: LIVE.** Migrated from `v2.6` to `develop` on 2026-10-25/26 (owner-approved, create-and-switch).
- Audit: [`docs/plans/BRANCHING-DEVELOP-MIGRATION-AUDIT-2026-10-25.md`](../plans/BRANCHING-DEVELOP-MIGRATION-AUDIT-2026-10-25.md).
- **`v2.6` soak:** started 2026-10-26, minimum 7 days, ends no earlier than **2026-11-02**. During the soak `v2.6` is frozen but kept as a fallback (§6). It must not be deleted or renamed until the owner retires it (§7).

## 1. Branch and deployment map

```
feature/*, fix/*, chore/*, sec/*  ──PR, 4 required checks──▶  develop  ──Vercel (auto)──▶  preview-app.fourthmeridian.com  (fintracker1)
                                                                │                     └─▶  preview.fourthmeridian.com      (fourth-meridian-site)
                                                                │
                                              promotion PR develop → main (owner approval; 2 strict checks)
                                                                ▼
                                                              main  ──Vercel (auto)──▶  app.fourthmeridian.com          (fintracker1 production)
                                                                │                   └─▶  fourthmeridian.com              (fourth-meridian-site production)
                                                                │
                                              annotated tag vX.Y.Z on the Production commit (immutable)
                                                                │
                                              back-sync PR main → develop after each promotion
```

| Branch | Role | Vercel | GitHub protection |
|---|---|---|---|
| `main` | **Production** and the GitHub **default branch** | `productionBranch: main` on both projects; `app.` and the apex have no `gitBranch` | Ruleset `main — production (PR + CI required)` (25690163) |
| `develop` | **Integration + Preview**. Every feature PR targets it. | Domains `preview-app.` / `preview.` carry `gitBranch: develop`; branch-scoped Preview env records for `develop` (§3) | Ruleset `develop — integration (PR + CI required)` (25836806) |
| `v2.6` | **Retired integration branch, frozen.** Soak fallback only (§6). | Its branch-scoped env records are kept; its domains moved to `develop` | Ruleset `v2.6 — integration (PR + CI required)` (25690160), kept during the soak |
| `feature/*`, `fix/*`, `chore/*`, `sec/*` | Short-lived, cut from `develop`, merged by PR | Generic Preview scope: their own `*.vercel.app` URL, SSO-protected, never a custom domain | — |
| `release/*` (optional) | A frozen candidate, only when `develop` must keep moving during a promotion | Generic Preview scope | Add a ruleset if one is created |
| `hotfix/*` | Cut from `main` → PR to `main` → back-sync to `develop` | Generic Preview scope | — |

## 2. Rulesets (live, read 2026-10-26)

| Ruleset | Target | Rules |
|---|---|---|
| 25690163 `main — production (PR + CI required)` | `refs/heads/main` | deletion · non_fast_forward · pull_request (0 approvals, dismiss stale) · required checks **`test`, `status-drift-guard`**, **strict** |
| 25836806 `develop — integration (PR + CI required)` | `refs/heads/develop` | Identical to 25690160: deletion · non_fast_forward · pull_request · required checks **`test`, `Architecture audits`, `Public site (zero-authority boundary)`, `status-drift-guard`**, not strict |
| 25690160 `v2.6 — integration (PR + CI required)` | `refs/heads/v2.6` | (unchanged; delete at retirement) |

- All three allow the Repository-admin role to bypass in **pull_request mode only**. No direct-push bypass.
- Verify with: `gh api repos/virtuarch/FourthMeridian/rulesets` and `gh api repos/virtuarch/FourthMeridian/rules/branches/develop`.

**Strict `main`:** a `develop → main` PR must contain `main`'s tip. After every promotion (and every hotfix), merge `main` back into `develop` by PR, so the next promotion PR is up to date without a release branch.

## 3. Vercel Preview configuration for `develop`

Both projects keep their Production configuration exactly as before. Preview differs only by branch.

**Domains:**
- `fintracker1`: `preview-app.fourthmeridian.com`, `gitBranch: develop`.
- `fourth-meridian-site`: `preview.fourthmeridian.com`, `gitBranch: develop`.

DNS is unchanged (NameBright → Vercel). Each READY `develop` deployment is attached to its project's domain automatically. The site project's Ignored Build Step cancels builds when `site/` is unchanged, so `preview.` advances only when the site changes.

**Branch-scoped Preview env records.** These override the generic Preview records for `develop` deployments only. Each has a twin scoped to `v2.6`, kept for the soak.

| Project | Key | Type | `develop` value (how it was set, 2026-10-26) |
|---|---|---|---|
| fintracker1 | `DATABASE_URL_APP` / `_AUTH` / `_SYSTEM` | sensitive | The Preview pooler role URLs (`fm_app` / `fm_auth` / `fm_system`, project ref `lqagrry…`). Copied from the cutover credentials, verified live as those roles (no RLS bypass) before use. A Postgres role has a single password, so these are the same credentials the `v2.6` records hold. |
| fintracker1 | `FM_RLS_STRICT` | sensitive | `true` |
| fintracker1 | `NEXTAUTH_URL`, `NEXT_PUBLIC_APP_URL` | encrypted | `https://preview-app.fourthmeridian.com` (read back equal to `v2.6`) |
| fintracker1 | `NEXT_PUBLIC_SITE_URL` | encrypted | `https://preview.fourthmeridian.com` (read back equal to `v2.6`) |
| fintracker1 | `NEXTAUTH_SECRET` | sensitive | **New random value.** The `v2.6` value is write-only and exists nowhere else. Effect: a `v2.6`-era Preview session must sign in again on `develop`. |
| fintracker1 | `CRON_SECRET` | sensitive | **New random value.** Vercel crons never run on Preview. |
| fourth-meridian-site | `NEXT_PUBLIC_APP_ORIGIN`, `NEXT_PUBLIC_SITE_ORIGIN` | plain | Identical to `v2.6` |

⚠️ **A branch with no scoped records falls back to the generic Preview scope.** That includes different database URLs and auth secret, and no `NEXT_PUBLIC_SITE_URL`. Never attach a custom Preview domain to a branch before its scoped records exist and a deployment built with them has been verified (§5).

Vercel only accepts a branch-scoped record for a branch that already exists ("Branch not found in the connected Git repository").

## 4. Automation bound to branch names

| Where | Binding |
|---|---|
| `.github/workflows/trusted-deployment-health.yml` | `push: branches: [develop, v2.6, main]`. Runs in GitHub Environment `vercel-probe`. |
| GitHub Environment `vercel-probe` | Deployment-branch policy: `develop`, `main`, `v2.6`. It is the only holder of `VERCEL_AUTOMATION_BYPASS_SECRET_APP` / `_SITE`. |
| `.github/workflows/status-drift-guard.yml` | `pull_request` + `push: branches: ["develop", "v2.6"]` |
| `scripts/ci-local.test.ts` | Pins the trusted-health trigger text exactly. Change both together. |
| `.github/dependabot.yml` | `target-branch: develop` on all three ecosystems. `main` stays the default branch. |
| `ci.yml`, `post-deploy-smoke.yml` | Branch-agnostic |

Feature PRs **target `develop`**: `gh pr create --base develop`. GitHub's default base is `main`, because `main` is the default branch, so always pass `--base`. A PR into `main` is a **promotion** (from `develop` or a `release/*`) or a **hotfix**, and needs the owner's approval.

## 5. Changing a Preview branch: verification sequence

This is the order used on 2026-10-26. Reuse it for any future branch change.

1. Create the branch at the verified SHA. Create its ruleset first if it's new.
2. Create the branch-scoped records (§3). Read back every non-sensitive value. Prove sensitive credentials work against the Preview database read-only, as the expected role.
3. Create a Git-sourced Preview deployment of the branch for each project. Do **not** touch domains yet.
4. Through protection (automation bypass, never printed), verify:
   - `/api/health` → `ok` / `db ok`, with the scheduler record **identical to Preview's** and different from Production's (Preview runs no crons).
   - `/api/auth/providers` callback host = `preview-app.`.
   - `/privacy` → **308 to `https://preview.fourthmeridian.com/privacy`**. This proves the branch overrides were applied: there is no generic `NEXT_PUBLIC_SITE_URL`, so a generic build serves `/privacy` itself (200).
   - The site's links point to `preview-app.` and never to `app.`.
5. Switch each Preview domain's `gitBranch`. Vercel reattaches it to the newest READY deployment of that branch. Re-run step 4 on the real domains.
6. Confirm Production: same deployment on `app.` and the apex, `productionBranch: main`, health ok.

## 6. Fallback and rollback (during the soak)

`v2.6` is frozen at `7435ded`. Its fallback deployments are:
- app `dpl_HJVUJuf5wiiVe7hyVdpeCVr3tLNY`;
- site `dpl_5cC5eW8RBEPua92CzY1AsUJG3Kvi`.

| Problem | Rollback (minutes, no DNS change) |
|---|---|
| `develop` Preview misbehaves | PATCH each domain back to `gitBranch: v2.6`; if Vercel doesn't reattach, `vercel alias set <fallback deployment> <domain>`. The `v2.6` env records were never changed. |
| Automation | Revert the migration PR. `vercel-probe` and the drift guard already admit `v2.6`. |
| Abandon `develop` entirely | Do the two steps above, then delete the `develop`-scoped env records and ruleset 25836806. Remove `develop` from `vercel-probe`. |

## 7. Retiring `v2.6` (owner approval, not before 2026-11-02)

1. Remove `v2.6` from:
   - the `trusted-deployment-health.yml` and `status-drift-guard.yml` triggers;
   - the pin in `scripts/ci-local.test.ts`;
   - the `vercel-probe` policy.
2. Delete the 11 `v2.6`-scoped Preview env records (9 fintracker1, 2 site).
3. Delete ruleset 25690160.
4. Archive: tag `v2.6` HEAD (e.g. `archive/v2.6`), then delete the branch, or keep it read-only. Leave local `v2.6` checkouts alone.

## 8. Releases

Production releases are identified by **annotated tags** on the commit `main` deployed to Production. `v2.6.0` is `ee95fed` (Production deployment `dpl_Dq2joJaa5tx2vvUtPERuszdG1K8M`, 2026-10-23). Tags are never moved or deleted.
