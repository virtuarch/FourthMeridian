# RESUME-CHECKPOINT — read first after any interruption

_Refreshed: 2026-10-23, after D17 closure and the final-readiness work (docs 21–23)._

**Production**
- `main` = `9ea5881` (D17 security hotfix, PR #6), `dpl_HRdMnpT3J9fSVXh3vpaP5RDjhRL2`.
- **D17 CLOSED**: 30-minute monitor 12/12; 0 × 5xx; owner login + TOTP PASS.
- Rollback target for any later promotion: this deployment.
- 88 migrations; 47 pending (exact; doc 23 §4); preflight clean (doc 22).
- No `fm_*` roles. PITR off; 8 daily physical backups.

**Candidate**
- `v2.6` = `c1d4597` (+ this docs PR): PR #8 (B4) and PR #9 (I4) merged and verified live on Preview.
- **A7: 55 PASS · 0 FAIL · 3 BLOCKED** (E1/E2/E4 Plaid Link, owner).
- **Draft PR #10** `release/v2.6-promotion` → `main`: tree identical to `v2.6`, D17 reconciled. **Do not merge without cutover approval: merging deploys Production.**

**Owner blockers** (doc 23 §7):
1. Production clone access: DB password in a 600 file, **or** approve a paid restore-to-new-project.
2. Plaid Sandbox E1/E2/E4, about 5 minutes.
3. Cutover inputs: role passwords, 4 env rows, rulesets, OpenAI spend limit.

**Preview test data:** `a7-20261022-*` accounts (adm deactivated; t2 pending deletion), `a7_20261022_inv`, "A7 Shared Space", A7 imports, payroll fixture, wallet, Resend-test-sink requests. Kept for the owner's E-row pass; remove after.

**Private artefacts** (`~/fm-rehearsal-private/`, 700): A2/A5 dumps, A7 harness and secrets, D17 monitor logs.

**Next:** on owner access (§7.1), run the clone rehearsal (WS3/WS4), then cutover per doc 23 §6.
