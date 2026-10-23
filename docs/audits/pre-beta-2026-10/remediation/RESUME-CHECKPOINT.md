# RESUME-CHECKPOINT — read first after any interruption

_Refreshed: 2026-10-23, after final configuration and release preparation (doc 25)._

**Production**
- `main` = `9ea5881`. **Unchanged:** no migrations, role changes, env changes, financial edits or deploys.
- PITR is off; the recommendation is to keep it off (doc 25 §4).

**Candidate**
- `v2.6` = `ae9b380` (PR #12 merged).
- Draft **PR #10** (`release/v2.6-promotion`, head `29b7af9`): tree identical to `v2.6`, CI green (`Deployment health` UNVERIFIED by design), MERGEABLE.

**Configured**
- **Branch protection is live and enforcement-proven:** rulesets `25690160` (v2.6) and `25690163` (main). PR required, checks required, no force push or delete, admin bypass by PR only.
- Direct pushes to `main` and `v2.6` are now rejected, so docs land through PRs.

**Staged, not applied:** the cutover kit in `~/fm-rehearsal-private/prod-cutover/` (700/600):
- `roles.secret.json` (owner recovery copy);
- `c2-preflight.sql`;
- the C3b candidate check + expected 50 rows;
- the C4 SCRAM SQL + verifier;
- the guarded C5 Vercel env script.

**Cutover:** **GO, conditional on the owner decisions in doc 25 §8** (window, PITR no/yes, OpenAI O1–O3, OpenAI key alignment, GO for C0–C9). Runbook: doc 25 §7.

**Private evidence:** `~/fm-rehearsal-private/prod/` (dump `56f027df…`, repair evidence). Delete 7 days after the cutover.
