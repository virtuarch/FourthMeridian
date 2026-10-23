# RESUME-CHECKPOINT — read first after any interruption

_Refreshed: 2026-10-23 15:10 UTC (doc 26)._

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

**Release 2 (domain split): not started; resumable.**
- The `app` CNAME resolves to Vercel. The site's Production deployment at `87e5ac8` is READY.
- **Prerequisites (doc 26 §10):**
  - Plaid allowlist entry for `app.`;
  - a webhook decision for the 3 ACTIVE Items;
  - `NEXTAUTH_SECRET` rotation (shared with Preview).

**Private kit:** `~/fm-rehearsal-private/` (700/600).
- `release.log` is the step log.
- `pgpass` has been destroyed.
- Delete the dumps after 2026-10-30.
