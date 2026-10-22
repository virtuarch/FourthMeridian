# RESUME-CHECKPOINT — read first after any interruption

_Refreshed: 2026-10-22, Preview infrastructure hardening (doc 17)._

**Git**
- **PR #1:** `remediation/beta-1` → `v2.6`, OPEN, **not merged**.
  - GitHub head `2fe8eb7`, CI green except the secret-free `Deployment health` (UNVERIFIED by design).
  - Local commits after it (unpushed, need A1c): see `17` §8.
- **Worktree:** `~/dev/FourthMeridian-remediation/base` only. The main checkout (`v2.6` `cde8fa0`) is untouched apart from untracked docs.

**Preview**
- **Database:** not migrated (A5 not approved). Fingerprint unchanged (`17` §5).
- **Live configuration changes this session (all Preview or repo-level, none in Production):**
  - GitHub Environment `vercel-probe`, branches `v2.6` and `main`, holding 2 secrets.
  - `fintracker1` generic-Preview env: +4 Sensitive rows (role URLs + `FM_RLS_STRICT`).
  - One Preview redeploy of PR #1's branch build (`dpl_Ah2ZJr71…`).
  - Throwaway branch `probe/vercel-probe-denial` pushed and then deleted.

**Rehearsal artefacts**
- In `~/fm-rehearsal-private/` (700): the Preview dump, its sha256, and the baselines. Delete after the cutover.
- No container running.

**Agents:** none.

**Next safe action:** owner reads `17` §7, then decides A1c, D12 full, D14, A5, A6.
