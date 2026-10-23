# RESUME-CHECKPOINT — read first after any interruption

_Refreshed: 2026-10-23 00:40 UTC, after the Production clone rehearsal (doc 24)._

**Production**
- `main` = `9ea5881`, `dpl_HRdMnpT3…`. **Unchanged** (final read-only check: 88 migrations, md5 `9ea5829f…`).
- D17 closed. PITR off.
- Fresh backup `prod-20261022T235646Z.dump` (SHA-256 `56f027df…`), restore-verified.
- The pgpass was **deleted**.

**Candidate**
- `v2.6` = `b9b92ef`. **PR #12** (data-convergence fixes found by the rehearsal) open → merge after CI. Then refresh draft **PR #10** (`release/v2.6-promotion`) from `v2.6`.
- **A7: 58 / 0 / 0.**
- Rehearsal: 47 migrations in 0.36 s; data convergence ≈ 35 s; `audit:ci` 27/28 (schema-drift clean as superuser); `rls:accept` 37/37; old and new app verified; failure drill passed.

**Cutover:** CONDITIONAL GO. Owner inputs: doc 23 §7.3–§7.5. Runbook: doc 23 §6 (C1 → C3 → **C3b data steps** → C4 …).

**Private evidence:** `~/fm-rehearsal-private/prod/` (700/600, 4.6 MB). Earlier: `a5/`, `a7/`, `d17/`. Delete after the cutover.

**Preview test data:** kept (doc 19 §6, doc 23 §2); remove after the cutover acceptance.
