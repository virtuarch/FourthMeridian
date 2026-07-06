# Desync Remediation — Certification Report

**Initiative:** Desync Remediation (FlowType/Category corpus certification)
**Plan:** `DESYNC_REMEDIATION_2026-07-06.md`
**Status:** ☐ PENDING Phase 3 execution — finalize the bracketed fields below after the runbook is applied.

---

## Certified invariant

> For every `Transaction` row, `(flowType, flowDirection) == classifyFlow(current inputs)` at algorithm version `classifierVersion`. The classifier is the only writer of flow values. The three deterministic categories map 1:1: `Transfer→TRANSFER`, `Payment→DEBT_PAYMENT`, `Fee→FEE`.

## Permanent certification artifacts (committed)

| Artifact | Path | Proves |
|---|---|---|
| Validation command / repeatable audit | `scripts/audit-flow-desync.ts` (`npm run audit:flow-desync`) | Live corpus has 0 deterministic-category desyncs; exit 1 on any drift |
| Regression test (pure, no DB) | `lib/transactions/flow-desync-invariant.test.ts` | The classifier contract the audit relies on cannot silently change (13 checks) |
| Remediation runbook | `docs/initiatives/desync/RUNBOOK.sql` | Reproducible, id-pinned remediation over the 701-row population |

## Execution record — fill in after running

| Phase | Expected | Actual | Notes |
|---|---|---|---|
| P0 `Payment IS DISTINCT FROM DEBT_PAYMENT` | 51 | ☐ | |
| P0 distribution | `{REFUND: 51}` | ☐ | |
| P0 `Fee = SPENDING` | 0 | ☐ | |
| P0 `Transfer ≠ TRANSFER` | 0 | ☐ | |
| P0 population match | 701 / 701 | ☐ | |
| P2 invalidate | `UPDATE 701` | ☐ | |
| P3 dry-run "to classify" | 701 | ☐ | |
| P3 `--apply` written | 701 | ☐ | |
| P4 `npm run audit:flow-desync` | PASSED | ☐ | |
| P4 backfill dry-run "to classify" | 0 | ☐ | |
| P4 snapshot diff | 51 changed / 650 identical | ☐ | REFUND→DEBT_PAYMENT |
| P4 `npm test` | green | ☐ | |

## Sign-off

- ☐ All P4 checks pass → **the transaction corpus is certified: zero FlowType/Category desynchronizations.**
- ☐ Rollback insurance retained: `flow-desync-preimage-2026-07-06.csv`.
- ☐ Merchant Intelligence may begin.

**Certified by:** ______  **Date:** ______
