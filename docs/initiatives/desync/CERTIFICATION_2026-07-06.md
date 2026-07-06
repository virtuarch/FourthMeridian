# Desync Remediation — Certification Report

**Initiative:** Desync Remediation (FlowType/Category corpus certification)
**Plan:** `DESYNC_REMEDIATION_2026-07-06.md` (see its **RESOLUTION** section for the full reconciliation)
**Status:** ✅ **CERTIFIED — 2026-07-06.** Outcome was **certification, not remediation**: the live corpus already held zero desynchronizations; no rows were changed.

---

## Certified invariant

> For every `Transaction` row, `(flowType, flowDirection) == classifyFlow(current inputs)` at algorithm version `classifierVersion`. The classifier is the only writer of flow values. The three deterministic categories map 1:1: `Transfer→TRANSFER`, `Payment→DEBT_PAYMENT`, `Fee→FEE`.

## Permanent certification artifacts (committed)

| Artifact | Path | Proves |
|---|---|---|
| Validation command / repeatable audit | `scripts/audit-flow-desync.ts` (`npm run audit:flow-desync`) | Live corpus has 0 deterministic-category desyncs; exit 1 on any drift |
| Regression test (pure, no DB) | `lib/transactions/flow-desync-invariant.test.ts` | The classifier contract the audit relies on cannot silently change (13 checks) |
| Remediation runbook (unused; retained) | `docs/initiatives/desync/RUNBOOK.sql` | Reproducible, id-pinned remediation over the 701-row population, should the seam ever reopen |

## Execution record — actual results (2026-07-06)

| Step | Expected (derivation) | Actual (live) | Verdict |
|---|---|---|---|
| `backfill-flowtype.ts` (dry-run) | 701 to classify | **Nothing to classify** | Corpus already at `classifierVersion ≥ 1`, no null flow |
| `backfill-flowtype.ts --apply` | write 701 | **Nothing to classify** (0 written) | No write needed |
| Phase-2 invalidate `UPDATE` | `UPDATE 701` | **not run** (unnecessary) | Skipped — no stale rows |
| `audit:flow-desync` → Payment→DEBT_PAYMENT | 0 after fix | **0** | ✓ |
| `audit:flow-desync` → Transfer→TRANSFER | 0 | **0** | ✓ |
| `audit:flow-desync` → Fee→FEE | 0 | **0** | ✓ |
| `npm run audit:flow-desync` | PASSED | **PASSED** | ✓ |
| `npm test` | green | **45/45 passed** | ✓ |

**Why the derivation's 51 was not present:** the 51 was a documented derivation from 2026-07-04 apply-logs, never a live measurement (DB was unreachable from the analysis sandbox; the plan instructed "stop and re-derive if live count ≠ 51" — that guard fired). The CC-1 rule was promoted into the live sync write path (`mapPlaidCategory`, commit `275a9c8`, 2026-07-04 21:57, five minutes after the standalone backfill), and sync writes `category` + `flow` atomically (`b6278be`); ordinary re-syncs (D2x history sync, 07-04/07-05) rewrote the affected rows consistently before execution. Full reconciliation in the plan's RESOLUTION section.

## Sign-off

- ✅ All checks pass → **the transaction corpus is certified: zero FlowType/Category desynchronizations.**
- ✅ No rollback insurance required — no rows were modified (no `flow-desync-preimage` snapshot needed).
- ✅ **Merchant Intelligence may begin.**
- ◽ Architectural items (version-gate input blindspot, backfill `--rollback` modes, single category-write choke point) remain open by design — MI entry-gate items, not closed by this data certification. See plan §1.8 / §5.

**Certified by:** Chris (operator-run execution, 2026-07-06)  ·  **Analysis & apparatus:** Desync Remediation initiative
