# Production cutover checklist — beta-1 candidate (G0 · G1 · G2 · G3 · G5)

**Status:** checklist, 2026-10-22 (remediation Agent F). Derived from `12-BETA-RELEASE-PLAN.md` §1 (gates G0–G5), `production-cutover-plan.md` §6 (preflight gates 1–11) and §8 (issues 1–6), and this remediation program's own gates. It does not replace the cutover plan's ordered runbook (§5); it is the sign-off sheet that says the runbook may start. **Every row is verified by its command, by the named owner, on the candidate SHA — a row without its evidence line is not ticked.** OWNER = the repository/Vercel/Supabase owner; ENG = engineering (an agent or developer, with no live credentials).

Candidate SHA: `________________` (filled at freeze) · Freeze declared: `________` UTC · Sign-off: `________`

## A. The candidate

| # | Item | Verification command / evidence | Owner | ☐ |
|---|---|---|---|---|
| A1 | Exact candidate SHA fixed; it is on `v2.6` (or `release/beta-1`) and `main` is an ancestor of it (fast-forwardable) | `git merge-base --is-ancestor origin/main <sha> && echo ff-ok`; `git branch -r --contains <sha>` | ENG | ☐ |
| A2 | GitHub CI green at that exact SHA on all three jobs (`test`, `Architecture audits`, `Public site (zero-authority boundary)`) — **read the run** | `gh run list --commit <sha> --json databaseId,conclusion,name`; run id recorded in STATUS §3 | ENG | ☐ |
| A3 | Local contract run green on the same committed SHA | `npm run ci` (clean depth-1 copy; 10–20 min); transcript summary attached | ENG | ☐ |
| A4 | Dependency gate clean at HIGH+ and the two accepted moderates unchanged | `npm audit --omit=dev --audit-level=high` exit 0; `npm audit --omit=dev --json \| jq .metadata.vulnerabilities` = `{moderate:2,…}` (exceljs→uuid) or better | ENG | ☐ |
| A5 | STATUS.md §3 row for the candidate SHA with the CI run id (G5) | `grep -n "<sha>" STATUS.md` | ENG → OWNER reads | ☐ |

## B. Schema and data

| # | Item | Verification | Owner | ☐ |
|---|---|---|---|---|
| B1 | Migration inventory: the pending set against Production is listed by name and class (additive / constraint / RLS / enum), per cutover plan §2 | `ls prisma/migrations \| wc -l` (126 at HEAD) vs Production `_prisma_migrations` count (88 as measured 2026-10-06); the diff list attached | ENG lists, OWNER reads Production | ☐ |
| B2 | Migration names conform (DB-008) | `npx tsx scripts/audit-migration-names.ts` exit 0 (runs in CI too) | ENG | ☐ |
| B3 | Drift assessment on Production, read-only, within 1 h of the migration step (cutover §6.11) | `npm run db:drift` with the env file pointed at Production's session pooler; output line attached | OWNER | ☐ |
| B4 | Data preflight zeros on Production (null `financialAccountId` 0/0, `MerchantRule` scope 0, PLAID duplicates 0) | `scratchpad/prod-preflight.sql` (cutover §5 A2); counts attached | OWNER | ☐ |
| B5 | **PG 17.6 / Supabase RLS rehearsal on a clone of Production's rows** (cutover §6.6): migrate the pending set, backfill, `audit:ci`, `rls:accept` 37/37 incl. the GRANT/POLICY census; `CREATE ROLE fm_backup … BYPASSRLS` succeeds as Supabase's `postgres` (rls-preview-cutover.md §: UNVERIFIED on Supabase) | `migration-safety.md` §2 record row attached | ENG drives, OWNER supplies the dump | ☐ |
| B6 | Enum-value deferral honoured: no row uses `MERCHANT_OPS` before promotion; Merchant Ops Space seeded at step I only | `select count(*) from "Space" where area='MERCHANT_OPS'` = 0 before H | OWNER | ☐ |

## C. Backup, restore, rollback

| # | Item | Verification | Owner | ☐ |
|---|---|---|---|---|
| C1 | Supabase backup/PITR status for `qirfzvvaeddukjiphims` read and recorded (cadence, newest backup time, PITR on/off) | dashboard → Database → Backups; `backup-restore-verification.md` §5 | OWNER | ☐ |
| C2 | `fm_backup` password set and stored; role shape verified | `select rolbypassrls, rolsuper, rolcanlogin from pg_roles where rolname='fm_backup'` → t,f,t | OWNER | ☐ |
| C3 | Pre-cutover dump taken over the session pooler, sha256 recorded (cutover §5 A1) | `backups/production-…-pre-v26-<ts>.sql.sha256` | OWNER | ☐ |
| C4 | **Timed restore rehearsal PASSED with RPO/RTO recorded** (G0) | `backup-restore-verification.md` §6 row: counts equal, health ok, login ok | OWNER (+ENG) | ☐ |
| C5 | Rollback plan read and agreed: redeploy previous build for app faults (`vercel promote <prev>`), schema stays additive, fix-forward for policy faults, no `DISABLE ROW LEVEL SECURITY` | `migration-safety.md` §3; cutover §9 | OWNER | ☐ |
| C6 | Local-dump policy applied to every dump taken above (encrypted or deleted within 24 h) | `ls backups/` shows only `.gpg`/`.age` + `.sha256` | OWNER | ☐ |

## D. Deployment mapping and configuration

| # | Item | Verification | Owner | ☐ |
|---|---|---|---|---|
| D1 | Vercel mapping verified as documented: `fintracker1` Production branch `main` → apex; Preview `v2.6` → `preview-app.`; `fourth-meridian-site` production `main`, Preview `v2.6` → `preview.`; crons on `fintracker1` Production only | `vercel project ls`; `vercel inspect https://fourthmeridian.com`; `vercel domains ls`; `branching-and-protection.md` §1 | OWNER | ☐ |
| D2 | Env var inventory for Production complete, names only (no values): `DATABASE_URL_APP/AUTH/SYSTEM`, `FM_RLS_STRICT=true`, new `NEXTAUTH_SECRET` (Production-only record), new `CRON_SECRET`, `ENCRYPTION_KEY` unchanged, `PLATFORM_ALERTS_EMAIL`, Turnstile keys, `OPENAI_API_KEY`/`OPENAI_PROJECT_ID`/`OPENAI_EXPECTED_ENVIRONMENT`, `RESEND_API_KEY`, `NEXTAUTH_URL`/`NEXT_PUBLIC_APP_URL`/`NEXT_PUBLIC_SITE_URL` | `vercel env ls production` (names + updatedAt); compared with `environment-separation.md` §4 and cutover §1 | OWNER | ☐ |
| D3 | Staged deployment boots with strict mode and the three role URLs (cutover §5 G/G′): `db-authority` 200, strict, 3 roles, residue 0, RLS 56/56 (or the current count) | staged URL + owner session | OWNER | ☐ |
| D4 | Staged-URL login with TOTP rehearsed on a non-alias host (cutover §6.7) | one login on the staged URL; session lands on that host | OWNER | ☐ |
| D5 | `registration_mode` row = `invite_only` on Production (G0) | `select value from "PlatformSetting" where key='registration_mode'` | OWNER | ☐ |
| D6 | Branch rulesets live on `main` and `v2.6` (G2) | `gh api /repos/virtuarch/FourthMeridian/rulesets \| jq length` ≥ 2; `branching-and-protection.md` §4.4 | OWNER | ☐ |
| D7 | Repository visibility decision recorded (SEC-018, G2) | written decision in STATUS §3 | OWNER | ☐ |

## E. Jobs, providers, monitoring, alerts

| # | Item | Verification | Owner | ☐ |
|---|---|---|---|---|
| E1 | Every registered job body exercised once on Preview under the role topology (cutover §8.2); `sync-banks` only after E2 | `select name, status from "JobRun" …` on Preview shows one row per registered job | OWNER (signed-in console) | ☐ |
| E2 | Plaid Sandbox provider acceptance on Preview on the candidate (cutover §8.1): link, sync, refresh, webhook, disconnect | `plaid-sandbox-lane-2026-10-06.md` re-run record on the candidate SHA | OWNER | ☐ |
| E3 | **External monitor** polling `/api/health` on the apex with `lastEvaluatedAt`, alerting on non-200 / `degraded` (G3) | monitor dashboard record (provider, interval, contact) | OWNER | ☐ |
| E4 | **Alert delivery verified**: a forced `evaluate-alerts` Run Now on Production delivers `sent` to `PLATFORM_ALERTS_EMAIL` (G3) | the delivered mail + the alert ledger row | OWNER | ☐ |
| E5 | Post-deploy smoke workflow present and its last run on a Preview deployment read (TEST-006) | `gh run list --workflow post-deploy-smoke.yml` | ENG | ☐ |
| E6 | Sentry receiving from Preview on the candidate (one deliberate capture) | event id attached | ENG/OWNER | ☐ |

## F. People

| # | Item | Verification | Owner | ☐ |
|---|---|---|---|---|
| F1 | Operator acceptance: the owner has used the candidate on Preview as a user for one full day (connect, sync, Brief, AI turn, Spaces, platform ops) and signed the acceptance line in the release ticket | release ticket | OWNER | ☐ |
| F2 | AI disclosure texts present and counsel-signed (G4) | `AiDisclosure.tsx`, `RequestAccessForm.tsx`; sign-off record | OWNER | ☐ |
| F3 | Execution window agreed (cutover §5: 08:00–11:30 UTC, pushes to `main`/`v2.6` frozen) and both people available for the first `sync-banks` slot (06:00 next day) | calendar | OWNER + ENG | ☐ |
| F4 | **Owner sign-off** that A–F are ticked with evidence; the runbook (cutover §5) may start | signature + date on this sheet; copy into STATUS §3 | OWNER | ☐ |

## After promotion (not a gate, a record)

- `GET https://fourthmeridian.com/api/health` → `status: ok`, `commit` = candidate prefix (G0); `post-deploy-smoke` run green.
- Cutover §7 post-cutover acceptance green; first `resume-stale-imports` `JobRun` on the new code; 12:00 `sync-crypto`; next-day 06:00 `sync-banks`.
- `git push origin <candidate>:main` (fast-forward; ruleset bypass recorded) and the resulting Production rebuild's smoke run green.
- STATUS.md §3: the beta SHA row with CI run id, ruleset ids, restore-rehearsal row reference, monitor record (G5).
