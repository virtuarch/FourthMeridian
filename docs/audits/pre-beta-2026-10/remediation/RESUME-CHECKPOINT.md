# RESUME-CHECKPOINT — read first after any interruption

_Refreshed: 2026-10-23 18:30 UTC (docs 26, 27)._

**Release 1: PASS.**
- **Production is public on v2.6:** `main` `87e5ac8`, `dpl_6NL1QND6ccmcNvDvtM7x5Mue2Kso`. Crons are on and `maintenance_mode` is unset.
- **Checks passed:** 135 migrations, data converged, strict RLS roles, monitoring and integrity.
- **Platform seed applied:** 5 platform Spaces.
- **AI controls in force:** $1/day allowance, $2 fleet alert, $25 project hard limit.
- **Rollback deployment:** `dpl_HRdMnpT3J9fSVXh3vpaP5RDjhRL2`.

**Open remediation items (doc 26 §11):**
1. `maintenance_mode` does NOT block paid AI; only the kill switch does.
2. The runbook needs `platform:seed-spaces` after migrate, plus an equality check.
3. Admin CONTROL wording.

**Release 2: PASS (doc 27).**
- `fourthmeridian.com` → marketing (`fourth-meridian-site` `dpl_5JHyp77…`).
- `app.fourthmeridian.com` → app (`dpl_u6xgziFf…`, `main` `383311d`).
- All 4 Plaid Items' webhooks → `app.` (acknowledged).
- Production has its own `NEXTAUTH_SECRET`; the old shared value is Preview-only.
- Rollback: §5 of doc 27.
- Follow-up: confirm the first organic Plaid webhook on `app.`.

**Private kit:** `~/fm-rehearsal-private/` (700/600).
- `release.log` is the step log.
- `pgpass` was recreated for Release 2 verification and destroyed again after C7.
- Delete the dumps after 2026-10-30.
