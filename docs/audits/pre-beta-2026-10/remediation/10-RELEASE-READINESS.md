# 10 — Release Readiness

Candidate: local branch **`remediation/beta-1`**, code HEAD **`01098bd`** (docs-only commits follow). Baseline `cde8fa0` (`v2.6`). 176 non-merge commits + 10 integration merges; 501 files changed. Nothing pushed, merged, deployed or applied to any live database.

## 1. Findings

| | Count |
|---|---|
| Audit baseline | P0 0 · P1 34 · P2 77 · P3 73 |
| P1 register rows (33, some aliased) | **28 resolved in code** (8 with an owner/counsel follow-up) · 4 owner-only (SEC-018, TEST-001, SEC-AI-001 project limit, OPS-013/015 + DB-007 cutover) · 1 STATUS re-baselined locally |
| P2 register rows (54) | 33 resolved · 6 partial · 14 deferred with reasons · 1 owner |
| P3 | ~35 closed in passing (e.g. SEC-009, SEC-013, SEC-014, SEC-016, SEC-AI-004, FIN-015, IDEMP-011/013, DB-004, DB-009, OPS-012/014, TEST-012/013/014, UI-011/014/015/018/021/022, OBS-010/011, ARCH-009/012, CQ-002/008, PRIV-006/014); the rest deferred as listed in `01` |
| Refuted / reclassified (runtime) | TEST-003 exposure refuted (gate added anyway); UI-001 → P3 (fixed anyway) |
| New findings (remediation) | 11: 10 resolved, 1 deferred to an owner design choice (NEW-010, duplicate invite e-mail) |
| Severity changes | none upward; no P0 discovered |

## 2. Test coverage change

| | Baseline `cde8fa0` | Candidate `01098bd` |
|---|---|---|
| Unit test files (all green) | 743 (runtime audit: 743/743) | **828/828** |
| Route files with a real-handler test | 3 | **25** (all auth flows; all Space-mutation routes; import) |
| REQUIRED invariant audits | 25 | **28** (+ route-guard census, migration names, schema drift) |
| RLS acceptance | 34 / 98 / 72 / 20 / 67 | **37** / 98 / 72 / 20 / 67 (+ GRANT↔POLICY census) |
| AI allowance suite | 15/15 | 15/15 |
| CI gates | test, architecture, site | + dependency audit, job timeouts, test watchdog, least-privilege token, concurrency |
| Runtime P1 reproductions as regression tests | 0 | 11/11 (`04` §4) |

## 3. Readiness by area

| Area | Ready (local evidence) | Not ready / unproven |
|---|---|---|
| Security | MFA page gate (proven against the real handler), step-up 2FA reset, invite-only default, session lifetimes, IP trust, dependency gate, self-grant revoked | repo public; CSP report-only; Turnstile; edge topology |
| Privacy | descriptor scrub, disclosures drafted, deletion completeness, digests in audit, retention, export completeness | counsel review; historical scrub not yet run; PRIV-013 |
| Financial integrity | FIN-001/002/003/005/009/011; invariant audits green | FIN-004 convention; Float money; holdings refresh |
| Idempotency | import, purge, job dispatch, webhook, recovery codes, races → 409 | duplicate-institution partial unique |
| AI cost & reliability | bounded retries/timeouts/deadline, awaited ledger, fail-closed on ledger loss, guidance reserved, pacing fail-closed; allowance + kill switch re-proven | fleet ceiling (owner: project limit) |
| Observability | dead-job alert, delivery truth, age-gated posture, health scheduler block, sync-incident rule | no external monitor; delivery never proven to a mailbox |
| Migrations | 9 additive, migrate-from-empty 135/135, schema-drift audit = 0 | never applied to Preview/Production; PG17.6 untested; DB-006 may need manual application |
| Rollback | every migration additive (expand-only); app rollback = redeploy previous build (`docs/operations/migration-safety.md`) | restore never rehearsed |
| Operator surfaces | READ holders see no write controls; no fabricated reasons; kill switch independent | Security Ops action gap (owner) |
| Customer surfaces | confirm dialogs, honest failure states, boundaries | no browser verification |

## 4. Production-only gates

`11` §D — G0 cutover (checklist), G0a jobs on Preview, G0b PG17.6 RLS rehearsal, G0c PITR + restore, G0d env (registration row, Turnstile, alert e-mail, Resend), G3 external monitor + delivery proof, G5a OpenAI spend limit, G6 historical scrub, G7 drift check, G8 browser pass.

## 5. Beta invite readiness

**Not yet.** The code-level GO conditions (audit G1–G13 code halves) are met on the local candidate with green local gates, but the beta cannot be invited until: the candidate is pushed and green on GitHub, merged and verified on Preview (migrations applied, browser pass), and the Production cutover gates in `11` are executed and recorded. Decision: **CONDITIONAL GO**, overall **7.2/10** for the local candidate (`12`).

## 6. Recommended next release step

1. Owner reviews this directory and `MORNING-HANDOFF.md`; pushes `remediation/beta-1` and reads its GitHub run.
2. PR into `v2.6`; on green, let Preview deploy; apply the 9 migrations on Preview with `db:migrate:safe`; run the G8 browser pass and G0a jobs-on-Preview.
3. Apply rulesets (D2) and decide visibility (D1) before anything reaches `main`.
4. Rehearse the restore (G0c) and the PG17.6 suites (G0b), then execute the cutover checklist.
