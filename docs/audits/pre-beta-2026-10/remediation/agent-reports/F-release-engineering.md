# Agent F — Release engineering, dependencies, CI gates, testing infrastructure

**Branch:** `remediation/f-release-eng` from `cde8fa0` · **worktree:** `/Users/chrstn/dev/FourthMeridian-remediation/f` · **Node:** 24.21.0 · **Date:** 2026-10-22 · **Commits:** 12, local only (nothing pushed, no remote setting changed, no live database touched).

Everything below was verified in this worktree. Claims about GitHub CI are not made: no run exists for these commits until they are pushed. The full local contract run (`npm run ci`) on the final committed HEAD is in §3.

## 1. Task ledger

| # | Finding(s) | Status | Commit |
|---|---|---|---|
| 1 | SEC-002, TEST-005 | DONE — next 16.3.8 / next-auth 4.24.15, 14 → 2 moderate; audit gate in CI; Dependabot | `e4c4031` |
| 2 | TEST-003 | DONE — GRANT↔POLICY census, cases 35–37, 37/37; negative proof 34/37 | `424ce9d` |
| 3 | TEST-002 | DONE — REQUIRED route-guard census, 187 routes / 210 methods / 200 guarded / 10 public; fixture test | `f98d9d0` |
| 4 | TEST-007, TEST-012 | DONE — job timeouts, `permissions`, `concurrency`, per-file watchdog 180 s + SIGKILL | `b63d580` |
| 5 | TEST-013, SEC-016 | DONE — tsconfig/eslint exclude `tmp/ backups/ _v26pre_bundle/`; `.gitignore`; settings placeholder | `7204569` |
| 6 | DB-008 | DONE — REQUIRED migration-name audit, 24-name legacy allowlist (audit said 15) | `fc857b6` |
| 7 | TEST-006 | DONE — `post-deploy-smoke.yml` (deployment_status, no secret); drift = OWNER step in release checklist | `3213ee9` |
| 8 | TEST-001, owner decision 7 | DONE (docs) — `branching-and-protection.md` with ruleset JSON + `gh api` | `769b1fc` |
| 9 | TEST-008 | DONE (docs) — `migration-safety.md` | `4ad6967` |
| 10 | backup/restore | DONE (docs) — `backup-restore-verification.md` | `e56935f` |
| 11 | CQ-001 | DONE — four packages uninstalled after independent verification | `CQ001_SHA` |
| 12 | cutover checklist | DONE (docs) — `production-cutover-checklist.md` | `98e7c9c` |

### Task 1 — SEC-002 + TEST-005 (`e4c4031`)

**Change.** `next` 16.2.7 → **16.3.8** (the lowest published 16.3.x ≥ 16.3.8: `npm view next versions` lists 16.3.0–16.3.8), `eslint-config-next` moved with it (exact pins kept, as before); `next-auth` ^4.24.14 → **^4.24.15** (the fixed 4.24.x; 4.24.15 is the newest 4.24). Transitive highs resolved by `npm audit fix` (no `--force`); no `overrides` needed; `react`/`react-dom` stay 19.2.4 (next 16.3.8 peer `^19.0.0`). `npm audit --omit=dev --audit-level=high` added to the `test` job directly after `npm ci`, mirrored in `TEST_JOB` (`scripts/lib/ci-contract.ts`) and pinned by `scripts/ci-local.test.ts` (step present, position 1, `.github/dependabot.yml` shape). `.github/dependabot.yml`: npm weekly for `/` and `/site` with minor+patch grouped, github-actions weekly.

**Files.** `package.json`, `package-lock.json`, `.github/workflows/ci.yml`, `.github/dependabot.yml`, `scripts/lib/ci-contract.ts`, `scripts/ci-local.test.ts`.

**Verification in the worktree (Node 24).** `npm run typecheck` 0 errors; `npm run lint` 0 errors (22 warnings, unchanged class); `npm run test:unit` 743/743; `npm run build` exit 0 (Turbopack compiled in 53 s, 152 static pages; the TypeScript phase took 32.9 min only because three other agents' `tsc` runs shared the machine, load 8–13). One trap recorded: a `.next/` left by the previous `next` version made the first post-upgrade build fail with a spurious `Cannot find module '@tailwindcss/postcss'`; `rm -rf .next` fixed it. CI and Vercel build from clean trees and are unaffected.

**Dependency audit, before → after** (`npm audit --omit=dev --json`, `metadata.vulnerabilities`):

| | before (`cde8fa0`) | after (`e4c4031`) |
|---|---|---|
| critical | 2 (`next`, `next-auth`) | 0 |
| high | 9 (axios, brace-expansion, browserslist, fast-uri, follow-redirects, nanoid, postcss, sharp, source-map-js) | 0 |
| moderate | 3 (baseline-browser-mapping, exceljs, uuid) | 2 (exceljs → uuid) |
| total | **14** | **2** |
| prod deps | 468 | 427 (after task 11) |

| package | before | after |
|---|---|---|
| `next` | 16.2.7 | 16.3.8 |
| `next-auth` | 4.24.14 | 4.24.15 |
| `eslint-config-next` | 16.2.7 | 16.3.8 |
| `axios` | 1.18.1 | 1.20.0 |
| `brace-expansion` | 1.1.15 (+nested 5.0.7, 2.1.1) | 1.1.21 |
| `browserslist` | 4.28.4 | 4.29.4 |
| `fast-uri` | 3.1.4 | 3.1.9 |
| `follow-redirects` | 1.16.0 | 1.16.1 |
| `nanoid` | 3.3.15 | 3.3.20 |
| `postcss` | 8.5.16 (+nested 8.4.31) | 8.5.23 |
| `sharp` | 0.34.5 | 0.35.5 |
| `source-map-js` | 1.2.1 | 1.2.2 |
| `baseline-browser-mapping` | 2.10.41 | 2.11.30 |
| `uuid` | 8.3.2 | 8.3.2 (moderate, open) |
| `exceljs` | 4.4.0 | 4.4.0 (moderate via uuid, open) |
| `react` / `react-dom` | 19.2.4 | 19.2.4 |

**Residual risk.** The two moderates (`uuid` < 11.1.1 via `exceljs` 4.4.0) are only "fixable" by npm through a semver-major *downgrade* of exceljs to 3.4.0; an `overrides` to uuid 11 would change exceljs's runtime dependency untested. Below the `high` gate; left open, listed for Agent G / post-beta. The gate uses the npm advisory database at run time, so a newly published HIGH advisory turns CI red without a code change — that is the intended behaviour, and Dependabot proposes the fix.

### Task 2 — TEST-003 RLS census (`424ce9d`)

**Change.** `scripts/rls-acceptance.ts` gains `censusProof()` (cases 35–37, run as the owner principal): every public table with any privilege for `fm_app` has `relrowsecurity`, `relforcerowsecurity` and ≥1 policy whose roles are `{public}` or name `fm_app` (35); the no-policy allowlist `REFERENCE_TABLES_WITHOUT_POLICY` = {`CorporateActionTerms`, `FxRate`, `Instrument`, `InstrumentAlias`, `Merchant`, `MerchantAlias`, `PriceObservation`, `RateLimit`} is exact — each granted and unpolicied, nothing else unpolicied (36); the converse stated on its own (37).

**Evidence.** Throwaway `postgres:16` container `rem-f-pg` (migrate deploy 126 + seed), `RLS_TARGET_URL=… npm run rls:accept`: **37/37** (baseline 34/34); census line: `57 granted, 49 tenant-scoped`. Negative proof on an identical clone with `create table "LeakyNewTable"… grant select, insert … to fm_app` and a policy added to `FxRate`: exactly **35, 36, 37 FAIL** naming `LeakyNewTable(rls=false,force=false,policies=0)` and `FxRate now has 1 policy(ies) — remove it from the allowlist`; 34/37. Containers removed with `docker rm -f -v`.

**Residual risk.** The census sees GRANTs on tables; a future SECURITY DEFINER function granted to `fm_app` that reads a tenant table is outside it (the function-EXECUTE matrix in `rls:accept:foreground` covers the existing ones).

### Task 3 — TEST-002 route-guard census (`f98d9d0`)

**Change.** `scripts/lib/route-guards.ts` (pure) + `scripts/audit-route-guards.ts` (REQUIRED, `needsDb: false`, registered). Recognisers: the eight `require*` guards, the CRON bearer check (`process.env.CRON_SECRET` + `Bearer`), `verifyPlaidWebhook`/`handlePlaidWebhook`, `NextAuth(`. Matched on comment-stripped source, per exported method (`export function GET`, `export const GET =`, `export { h as GET }`), credited directly, via a local helper, or one delegated hop (`./deps`, `./handlers`). Public routes: in-file `// PUBLIC: <reason ≥ 12 chars>` or the closed `PUBLIC_ROUTES` allowlist (10 entries with reasons, exact in both directions).

**Why an allowlist and not annotations.** The ten public files (`access-request`, `auth/{forgot-password,pre-login,register,reset-password,verify-email,verify-email/resend}`, `health`, `registration-policy`, `user/email/confirm`) belong to other agents this wave. The allowlist can only shrink: when an owner adds the in-file annotation, the audit fails until the entry is removed. **Recommendation to the orchestrator:** owners of those ten files add `// PUBLIC: <reason>` (reasons are in `PUBLIC_ROUTES`) and F deletes the entries at integration.

**Evidence.** Current tree: 187 route files, 210 exported methods, 200 guarded, 10 public, 0 findings. `scripts/audit-route-guards.test.ts` (25 checks) on a temp fixture tree: unguarded fails; each recogniser passes; comment-only mention fails; mixed-method file is a finding on the unguarded method; helper and one-hop credited, two hops not; annotation needs a reason and its own line; allowlist exact (missing / now-guarded / also-annotated all fail); the real census holds.

**Residual risk.** Name-based: a local function named `requireUser` that does nothing would pass; a guard called but its result ignored would pass (the census proves presence, not enforcement — TEST-004 handler tests are the complement).

### Task 4 — TEST-007 / TEST-012 (`b63d580`)

**Change.** `ci.yml`: `permissions: contents: read`; `concurrency: ci-${{ github.workflow }}-${{ github.ref }}` with cancel-in-progress; `timeout-minutes` test 20 / architecture 30 / site 15; `status-drift-guard.yml` 10. Action tags kept at `@v4` (no behaviour change; Dependabot proposes bumps). `scripts/run-tests.ts` → `scripts/lib/test-child.ts`: per-file watchdog, default 180 s (`TEST_FILE_TIMEOUT_MS`), SIGKILL, reported as FAILED with "`<file> TIMED OUT after N s`", run continues. `scripts/ci-local.test.ts` pins all of it (39 checks); `scripts/run-tests.test.ts` (11 checks) proves the watchdog with real children.

**Residual risk.** The wedge's root cause is still unknown; the watchdog converts it from "blocks forever" to "that file fails in 3 minutes". A legitimately slow file (> 180 s) would be killed — none is within 30× of that today.

### Task 5 — TEST-013 / SEC-016 (`7204569`)

`tsconfig.json` and `eslint.config.mjs` exclude `tmp`, `backups`, `_v26pre_bundle`; `.gitignore` gains `_v26pre_bundle/` (it was ignored only through one machine's `.git/info/exclude`; `tmp/` and `backups/` were already ignored). `.claude/settings.local.json` keeps its structure; the DB URL and two `PGPASSWORD` entries carry `<password>`/`<user>` placeholders. Verified: `git check-ignore` on all three; typecheck + lint green after.

### Task 6 — DB-008 (`fc857b6`)

`scripts/lib/migration-names.ts` + `scripts/audit-migration-names.ts` (REQUIRED, `needsDb: false`). Rule: `<YYYYMMDDHHMMSS>_<slug>`, real UTC instant, unique, monotone in apply order; `LEGACY_DATE_ONLY` closed allowlist. **Measured: 126 migrations, 102 timestamped, 24 date-only** (the audit's "15" undercounted). `scripts/audit-migration-names.test.ts` (15 checks): date-only, non-digit, uppercase, 13-digit, duplicate, month-13, Feb-30, back-dated, earlier-than-legacy and stale-allowlist all fail; checkout passes.

### Task 7 — TEST-006 (`3213ee9`)

`.github/workflows/post-deploy-smoke.yml`: `on: deployment_status`, job gated on `state == 'success'`, curls `${environment_url}/api/health` (3 attempts), requires `status == "ok"`, and when `commit` is present requires it to be a prefix of `deployment.sha`; SSO-protected Preview (302/401) reported as "protected — not probed", exit 0; no secret; `timeout-minutes: 5`; `permissions: contents+deployments read`. Pinned by `ci-local.test.ts`. `release-checklist.md` §3 names `npm run db:drift` as the OWNER step before promotion and states the smoke does not check schema. **UNVERIFIED until pushed:** that Vercel's GitHub integration emits `deployment_status` with `environment_url` on this repository (it does by default for Git-integrated projects; the first run after push is the proof — E5 on the cutover checklist).

### Tasks 8, 9, 10, 12 — docs (`769b1fc`, `4ad6967`, `e56935f`, `98e7c9c`)

`docs/operations/branching-and-protection.md`, `migration-safety.md`, `backup-restore-verification.md`, `production-cutover-checklist.md` — contents as described in §4 (owner actions) and the task table. Every remote fact is cited to the document it was read from; unreadable facts are marked UNVERIFIED (Supabase PITR status; Vercel `deployment_status` emission; other remote branches). **Ownership note:** `docs/operations/migration-safety.md` is not in F's listed paths in `02-AGENT-OWNERSHIP.md`; it was written because the brief asks for it and no other agent owns it — flagged for the orchestrator.

### Task 11 — CQ-001 (`CQ001_SHA`)

**Verification (independent of the audit).** `grep -rl` for `@dnd-kit/core`, `@dnd-kit/sortable`, `@dnd-kit/utilities`, `recharts`, `dnd-kit` across `app components lib jobs scripts site next.config.ts proxy.ts instrumentation.ts` (excluding node_modules/.next/tmp/backups): the only hits are one **comment** in `components/dashboard/SpacesClient.tsx:289` ("…than recharts; a card grid…") and seven **untracked** `components/charts/.fuse_hidden*` files from June (not in `git ls-files`). `git grep` over tracked files: the same comment plus four `docs/plans/*.md` mentions. No import, no dynamic import, nothing in `next.config.ts`. **Uninstalled:** 43 packages removed; prod deps 468 → 427; `npm audit` unchanged (2 moderate); `test:unit` CQ001_UNIT; typecheck CQ001_TSC.

## 2. Contract and test updates (one contract, three places)

| Place | Change |
|---|---|
| `.github/workflows/ci.yml` | `+ npm audit --omit=dev --audit-level=high` in `test`; `permissions`, `concurrency`, three `timeout-minutes` |
| `scripts/lib/ci-contract.ts` | `TEST_JOB` = `npm ci`, **audit**, `prisma generate`, `test:unit`, `typecheck`, `lint` (ARCHITECTURE_JOB / SITE_JOB unchanged) |
| `scripts/ci-local.test.ts` | 29 → **39** checks: audit step + position, dependabot shape, permissions, no job widening, concurrency, timeouts ≤ 60, action tags on majors, drift-guard timeout, smoke workflow shape |
| `scripts/audit-registry.ts` | +2 REQUIRED, `needsDb: false`: `audit-route-guards`, `audit-migration-names` → REQUIRED tier 22 → **24**, `audit:ci` runs 25 → **27** scripts |
| `scripts/run-tests.ts` | 743 → **746** test files (3 new: `audit-route-guards.test.ts`, `audit-migration-names.test.ts`, `run-tests.test.ts`) |
| `scripts/rls-acceptance.ts` | 34 → **37** cases |

## 3. Full `npm run ci` on committed HEAD

CI_TRANSCRIPT

## 4. OWNER action list (nothing below was executed)

1. **Push and read CI.** `git push origin remediation/f-release-eng` (or the integrated branch) and read the three jobs on the exact SHA; the new `test` step is `Dependency audit (production, high+)`. First `post-deploy-smoke` run on the next Preview deployment proves Vercel emits `deployment_status` here.
2. **Rulesets (G2)** — `docs/operations/branching-and-protection.md` §4:
   ```sh
   gh api --method POST -H "Accept: application/vnd.github+json" /repos/virtuarch/FourthMeridian/rulesets --input /tmp/ruleset-main.json
   gh api --method POST -H "Accept: application/vnd.github+json" /repos/virtuarch/FourthMeridian/rulesets --input /tmp/ruleset-v26.json
   gh api /repos/virtuarch/FourthMeridian/rulesets | jq '.[] | {id, name, enforcement}'
   ```
   Decisions left open there: PRs on `v2.6` (§4.2), admin bypass on `main` vs merge commits (§4.3), repository visibility (SEC-018).
3. **Dependabot** needs no action beyond the file; it starts proposing PRs on the default branch once pushed. Confirm "Dependabot version updates" is enabled in repository settings → Code security.
4. **`fm_backup` password + timed restore rehearsal** — `backup-restore-verification.md` §2–4; append the RPO/RTO row (§6). Read Supabase backup/PITR status (§5).
5. **Drift before promotion** — `npm run db:drift` with the env file pointed at the target (release checklist §3).
6. **Cutover sign-off sheet** — `production-cutover-checklist.md`, every row with its evidence line.
7. **Ten public routes** — ask their owners to add `// PUBLIC: <reason>` (reasons in `scripts/lib/route-guards.ts` `PUBLIC_ROUTES`), then F removes the entries.
8. **Moderates** — `exceljs`/`uuid`: decide post-beta (replace exceljs export, or pin uuid 11 via `overrides` with an export test).

## 5. Things learned worth keeping

- `npm audit fix --omit=dev` **prunes devDependencies from `node_modules`** (lockfile intact). Run `npm ci` after it.
- A `.next/` cache from an older `next` can fail the next build with a false "Cannot find module" from the Turbopack PostCSS transform; `rm -rf .next`.
- In zsh the pipe-status array is `pipestatus` (lowercase); `PIPESTATUS` is bash and expands empty.
- Editing TypeScript with `perl -pi` mangles `$` (template literals, regex anchors) and can leave a NUL byte; python heredocs with exact-string asserts are safe.
- The audit counted 15 date-only migrations; the tree has 24.
