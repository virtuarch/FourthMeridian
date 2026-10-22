# RESUME-CHECKPOINT — read first after any interruption

_Refreshed: 2026-10-23, after A1d, A6, A7 and the Production-readiness assessment (docs 19, 20)._

**Git**
- **`v2.6` = `7d1cee7`.** History:
  - PR #1 merged as `0773008` (A6, 2026-10-22 20:10 UTC, head `a72a83d`);
  - PR #2 `d191968` (deployment-health fixes);
  - PR #3 `1a38f6b` (Space creation under strict RLS, P1);
  - PR #4 `7d1cee7` (invite rescind confirmed and audited);
  - this docs PR follows.
- **`main` = `87e4df7`**, untouched. A merge into `main` is not authorised.
- CI is green on every merged head. `Deployment health` (secret-free) stays UNVERIFIED (red) by design. The trusted push-time check probes the app HEALTHY.
- Branches `remediation/{beta-1,trusted-health-fixes,space-create-rls,rescind-invite-confirm}` are merged and can be deleted.

**Preview**
- **Database:** 135 migrations (A5). Data changed only by A7 test activity (doc 19 §6).
- **App:** `preview-app` serves `v2.6` `7d1cee7`. `/api/health` is ok with the `scheduler` block; the scheduler is overdue because crons are Production-only.
- **D14:** Plaid = Sandbox; OpenAI = `fourth-meridian-preview`. Resend: real key, scope unread.
- **Kill switch** OFF (restored).
- **Test accounts** `a7-20261022-{t1,t2,t3,adm}@example.test`:
  - adm is deactivated;
  - t2 is pending deletion;
  - credentials are in `~/fm-rehearsal-private/a7/` (600), never in the repository.

**Production:** untouched. No connection, deployment or env change.

**Private artefacts** (`~/fm-rehearsal-private/`, 700):
- the A2 and A5 dumps and evidence;
- the A7 harness, results and secrets.

Delete after the cutover. The Preview credentials copy used by A7 is deleted at session end.

**Agents:** none running.

**Next safe action:** the owner reads doc 20 §17 (Production **NO-GO**, 10 BLOCKERs) and doc 19 §4 (A7 49/2/7). In order:
1. Decide the live Production framework risk (row 2: hotfix `main` or cut over).
2. Run the ≈ 20-minute owner pass on the 7 BLOCKED A7 rows.
3. Decide D16 (TOTP disable policy).
4. Then start the Production cutover gates (backup/PITR, clone rehearsal, env, rulesets).
