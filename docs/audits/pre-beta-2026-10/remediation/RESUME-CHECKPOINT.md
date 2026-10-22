# RESUME-CHECKPOINT — read first after any interruption

_Refreshed: 2026-10-22 19:35 UTC, after A5 (doc 18)._

**Git**
- **PR #1:** `remediation/beta-1` → `v2.6`, OPEN, **not merged** (A6 not approved).
  - GitHub head `1ca3085` (A1c pushed). CI green except the secret-free `Deployment health` (UNVERIFIED by design).
  - Local commit after it: the A5 docs commit (doc 18, this file, doc 11). **Unpushed**, needs A1d.
- **Worktree:** `~/dev/FourthMeridian-remediation/base` only. Main checkout (`v2.6` `cde8fa0`) untouched apart from untracked docs.

**Preview**
- **Database: MIGRATED (A5 done 2026-10-22, 19:28:53–19:29:07 UTC).**
  - 135 applied, 0 bad. Fingerprint otherwise unchanged: `JobRun` 1 @ 2026-10-07 19:09:08.654; 5 users.
  - All 70 data tables identical before and after.
  - `PlatformGrant`→`fm_app` = SELECT; `RateLimit` FORCE RLS; role `statement_timeout` 15s / 5s / 60s.
- **App:** `preview-app` still serves `v2.6` `cde8fa0`: `/api/health` ok, `db` ok, after the migration.
- **No** Vercel env, GitHub secret or Production change in A5.

**Recovery artefacts**
- In `~/fm-rehearsal-private/a5/` (700/600):
  - the pre-A5 dump `preview-pre-a5-20261022T192112Z.dump` (SHA-256 `3720830a…b0b1`), restore-verified;
  - the guard's SQL backup (`83cf7f03…2272`);
  - all evidence files.
- A2 artefacts remain in `~/fm-rehearsal-private/`.
- Delete both after the cutover.
- Credentials copy used for A5: deleted.
- No container running (volume count 23, unchanged).

**Agents:** none.

**Next safe action:** owner decides A1d (push docs) and **A6** (merge PR #1; the precondition "Preview migrated" is now met). Then D14 → A7. Do **not** re-run migrations: Preview is at 135.
