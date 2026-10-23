# RESUME-CHECKPOINT — read first after any interruption

_Refreshed: 2026-10-23 07:55 UTC, mid-cutover (doc 26)._

**Production: v2.6 is DEPLOYED but CLOSED (recoverable maintenance).**
- `main` = `87e5ac8` (PR #10 merged). Deployment `dpl_6NL1QND6ccmcNvDvtM7x5Mue2Kso` is serving `fourthmeridian.com`.
- The firewall denies all traffic. Crons are disabled. `maintenance_mode=true`.
- DB: 135 migrations, data converged. Role passwords and the 4 strict env vars are set.
- C0–C6 and automated C7 **PASS** (doc 26 §2).

**Waiting on the owner:**
1. C7 login/TOTP smoke test, using `maint.sh owner-on` (doc 26 §5).
2. Then C8 reopen + 30-minute monitoring, then C9.
3. Then OpenAI key alignment and app allowance settings (doc 26 §4).

**Rollback:**
- App: `vercel promote dpl_HRdMnpT3J9fSVXh3vpaP5RDjhRL2` (`9ea5881`).
- Data, only for data damage: C1 dump `7c9a01b3…` (03:46 UTC).

**Release 2 (domain split): BLOCKED.**
- It needs Release 1 PASS, plus an owner-created NameBright record for `app.fourthmeridian.com`.
- No domain or DNS changes have been made (doc 26 §6).

**Private kit:** `~/fm-rehearsal-private/` (700/600).
- `release.log` is the step log.
- `prod/pgpass` is kept until C9, then delete it with `rm -P`.
- Delete the dumps 7 days after the cutover.
