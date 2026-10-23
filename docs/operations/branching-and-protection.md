# Branching model and branch protection (TEST-001 · owner decision 7)

**Status:** PROPOSED 2026-10-22 by the remediation program (Agent F). Everything under "OWNER ACTION" is a remote change the owner applies; nothing in this document has been applied. Every fact about the remote was read from `docs/audits/pre-beta-2026-10/08-TESTING-DELIVERY.md` §6 (coordinator `gh` reads, 2026-10-21), `docs/operations/environment-separation.md` §2, `docs/operations/domain-split-preview.md`, `docs/operations/production-cutover-plan.md` §1/§5 and `STATUS.md` §2. Where a fact could not be read it is marked UNVERIFIED.

## 1. What exists today (read, not asserted)

| Fact | Value | Source |
|---|---|---|
| Repository | `virtuarch/FourthMeridian`, visibility **PUBLIC** | 08 §6, SEC-018 |
| Branch protection | none on `main` or `v2.6` (`…/branches/{main,v2.6}/protection` → 404); rulesets `[]` | 08 §6 |
| `main` | Production. Serving SHA `87e4df7` (2026-07-27). One content-identical cherry-pick ahead of what `v2.6` contains; 872 commits behind `v2.6`; 38 migrations behind | STATUS §2, cutover plan §1 |
| `v2.6` | the development/integration branch (from tag `v2.5.0`); direct pushes are the real workflow — the repository has never used pull requests | STATUS §2, status-drift-guard.yml header |
| CI | `ci.yml` runs on `push` to every branch, `pull_request`, `workflow_dispatch`; three jobs: `test`, `Architecture audits`, `Public site (zero-authority boundary)`; a red run has landed on `main` before (run 30118341969) | ci.yml, 08 §6 |
| Vercel project `fintracker1` (the app) | Production branch `main` → `fourthmeridian.com` (apex, auto-aliased on push); Preview custom domain `preview-app.fourthmeridian.com` attached with `gitBranch: v2.6`; any other branch builds in the generic Preview scope; crons (`vercel.json`) run against Production only | environment-separation.md §2–3, domain-split-preview.md |
| Vercel project `fourth-meridian-site` (the public site, `site/`) | production branch `main`; Preview custom domain `preview.fourthmeridian.com` with `gitBranch: v2.6` | domain-split-preview.md |
| Deployment protection | Vercel SSO covers Preview on both projects; Production custom domains exempt | domain-split-preview.md §2 |
| Promotion step in the cutover plan | step K: `git push origin <candidate>:main` (fast-forward of the exact tested SHA) after a staged `vercel deploy --prod --skip-domain` + `vercel promote` | cutover plan §5 |
| Other remote branches | UNVERIFIED from here (STATUS §6 names `uxp1/*` as live and not to be touched); the remediation branches `remediation/{a..g}-*` and `remediation/beta-1` exist locally as worktrees | STATUS §6, `git worktree list` |

## 2. Target model

```
main ──────────────────────────────────────────────● Production (fintracker1 + fourth-meridian-site)
  ▲ fast-forward of a CI-green, Preview-verified SHA only (cutover plan §5 step K)
v2.6 ───●───●───●───●───●───●───●───●───●───●───●── integration; Preview (preview-app. / preview.)
          ▲        ▲          ▲
remediation/f-release-eng, remediation/a-security, … ─ short-lived feature/remediation branches,
                                                         merged into v2.6 by the orchestrator
release/beta-1 (optional) ───────────────────────────── a frozen candidate when v2.6 must keep moving
                                                         during the cutover window
```

Rules of the model:

1. **`main` is Production.** It only ever receives a SHA that is already on `v2.6`, already green on all three CI jobs at that exact SHA, and already verified on Preview (cutover plan §6 gates). It is never pushed directly from a working tree.
2. **`v2.6` is integration and Preview.** The orchestrator integrates agent branches here; every push runs CI; Preview (`preview-app.` / `preview.`) follows its newest deployment. Direct pushes remain allowed (owner decision — see §4.2), but force-pushes and deletion do not.
3. **Feature / remediation branches** are short-lived, cut from `v2.6` (or `remediation/beta-1`), named `remediation/<letter>-<area>` during this program and `feat/…` / `fix/…` otherwise. They build in Vercel's generic Preview scope (no custom domain, SSO-protected). They are deleted after integration.
4. **`release/beta-1` (optional)** exists only if `v2.6` must keep accepting work while a candidate is being rehearsed. It is cut from the candidate SHA, receives cherry-picks only, and is what `main` fast-forwards to. If `v2.6` is frozen for the cutover window instead (cutover plan §5 freezes pushes to `main`/`v2.6` on execution day), it is not needed.
5. **No history rewriting** on `main` or `v2.6`, ever. A bad commit is reverted forward.

### Why `main` keeps a fast-forward rather than a PR merge

GitHub's merge button cannot fast-forward: "merge" creates a merge commit and "rebase" rewrites commits, so either way the SHA that lands on `main` is **not the SHA CI and Preview tested** (the cutover plan's §6 gate 1 principle). The ruleset below therefore requires a pull request on `main` for everything **except** the owner's own promotion push, which is the one bypass the model admits, and which the audit log records. If the owner prefers zero bypasses, the alternative is to accept the merge commit, let `ci.yml` run on it (it runs on every push), and rely on `post-deploy-smoke.yml` for identity — documented in §4.3 as the trade-off, not chosen here.

## 3. Required status checks (exact names)

The contexts GitHub records for the three `ci.yml` jobs are their `name:` (or the job id when there is no name):

| Job id | Context string required by the ruleset |
|---|---|
| `test` | `test` |
| `architecture` | `Architecture audits` |
| `site` | `Public site (zero-authority boundary)` |

`scripts/ci-local.test.ts` pins that `ci.yml` has exactly these three jobs; renaming one must update the ruleset too.

## 4. OWNER ACTION — ready-to-apply rulesets

Prerequisites: `gh auth status` shows an account with admin on `virtuarch/FourthMeridian`; `jq` installed. Rulesets need no paid plan on a public repository.

### 4.1 `main` — protected Production

Save as `/tmp/ruleset-main.json`:

```json
{
  "name": "main — production",
  "target": "branch",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["refs/heads/main"], "exclude": [] } },
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" },
    { "type": "required_linear_history" },
    {
      "type": "pull_request",
      "parameters": {
        "required_approving_review_count": 0,
        "dismiss_stale_reviews_on_push": true,
        "require_code_owner_review": false,
        "require_last_push_approval": false,
        "required_review_thread_resolution": false
      }
    },
    {
      "type": "required_status_checks",
      "parameters": {
        "strict_required_status_checks_policy": true,
        "do_not_enforce_on_create": false,
        "required_status_checks": [
          { "context": "test" },
          { "context": "Architecture audits" },
          { "context": "Public site (zero-authority boundary)" }
        ]
      }
    }
  ],
  "bypass_actors": [
    { "actor_id": 5, "actor_type": "RepositoryRole", "bypass_mode": "always" }
  ]
}
```

- `actor_id: 5` is the built-in **Repository admin** role. It exists so the cutover's fast-forward push (`git push origin <sha>:main`) by the owner is possible; every bypass is written to the repository audit log. Remove the `bypass_actors` entry to forbid it (then promotion is a PR merge — §4.3).
- `required_approving_review_count: 0` because the repository has one maintainer; raise it when a second reviewer exists.
- `strict_required_status_checks_policy: true` means the PR head must be up to date with `main` — for a `v2.6 → main` PR this is always true because `main` is an ancestor.

Apply:

```sh
gh api --method POST -H "Accept: application/vnd.github+json" \
  /repos/virtuarch/FourthMeridian/rulesets --input /tmp/ruleset-main.json
```

### 4.2 `v2.6` — integration (no force-push, no deletion)

Save as `/tmp/ruleset-v26.json`:

```json
{
  "name": "v2.6 — integration",
  "target": "branch",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["refs/heads/v2.6"], "exclude": [] } },
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" }
  ],
  "bypass_actors": []
}
```

Apply:

```sh
gh api --method POST -H "Accept: application/vnd.github+json" \
  /repos/virtuarch/FourthMeridian/rulesets --input /tmp/ruleset-v26.json
```

**Why no required checks on `v2.6`:** a `required_status_checks` rule refuses any push whose commit has not already passed the checks on another ref, which turns every direct push into a PR. The workflow today is direct pushes, and STATUS §2's drift guard was built for that. Adding the checks to `v2.6` is the "move to PRs" decision (§5, item 2); the JSON for it is the `required_status_checks` block from §4.1, unchanged.

### 4.3 Alternative for `main` with no bypass (not chosen)

Delete `bypass_actors` from §4.1. Promotion becomes: open a PR `v2.6 → main`, wait for the three checks on the PR head, merge with **merge commit** (`required_linear_history` must then be removed; or use squash, which also rewrites). `ci.yml` runs on the resulting push to `main`; `post-deploy-smoke.yml` verifies `/api/health` on the immutable per-deployment URL (the route publishes no commit since OPS-014, so identity is by that URL, not by a reported SHA). Cost: the deployed SHA is not the Preview-verified SHA.

### 4.4 Verify

```sh
gh api /repos/virtuarch/FourthMeridian/rulesets | jq '.[] | {id, name, enforcement}'
gh api /repos/virtuarch/FourthMeridian/rules/branches/main | jq '.[].type'
gh api /repos/virtuarch/FourthMeridian/rules/branches/v2.6 | jq '.[].type'
```

Expected: two active rulesets; `main` lists `deletion`, `non_fast_forward`, `required_linear_history`, `pull_request`, `required_status_checks`; `v2.6` lists `deletion`, `non_fast_forward`. Record the ruleset ids in STATUS §3 (G2 evidence).

### 4.5 Remove (rollback)

```sh
gh api --method DELETE /repos/virtuarch/FourthMeridian/rulesets/<id>
```

## 5. Owner decisions this document leaves open

1. **Repository visibility** (SEC-018, G2): PUBLIC today. Rulesets work either way; the decision is recorded separately.
2. **PRs on `v2.6`**: keep direct pushes (this document) or require PRs + the three checks (§4.2 note).
3. **Bypass on `main`**: keep the admin bypass for the fast-forward promotion (recommended, §2) or forbid it and accept merge commits (§4.3).
4. **`release/beta-1`**: cut one only if `v2.6` cannot be frozen for the cutover window.

## 6. What changes in existing documents when the rulesets are live

- `production-cutover-plan.md` §5 step K: unchanged in substance (fast-forward push by the owner, who holds the bypass); add "ruleset bypass recorded in the audit log" to its verify column.
- `release-checklist.md` §10: add "rulesets present (`gh api …/rulesets` non-empty)" as a GO item.
- `STATUS.md` §2 "Protected branches": replace the UX-branch note with the two ruleset ids.
