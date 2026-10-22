# 08 — Financial Integrity

Integration branch `remediation/beta-1`. Detail: `agent-reports/B-financial-integrity.md`. Evidence: `04` §3–§4.

## 1. P1 fixes

### FIN-001 — a late paycheck no longer zeroes projected payroll under a "complete" label
**Was (runtime):** 11 biweekly $3,000 paychecks with the newest slot 5 days overdue ⇒ stream SILENT/UNKNOWN ⇒ `LAPSED` (non-blocking) ⇒ `project_cash` returned `EVIDENCE_BASED_ESTIMATE` with **$15,000 of payroll dropped to $0**.
**Rule now (owner-readable):**
- *The feed's reach is the feed's clock.* How far an account's ledger "looked" is the later of its connection's last successful transaction sync and its newest income row (never past the as-of date).
- Continuation statuses: **CURRENT** (projected as before) · **RECENTLY_SILENT** (schedule intact; ≤ 2 unpaid slots the feed covered — *blocking*) · **UNKNOWN** (due slots the feed has not reached — *blocking*, however far behind) · **LAPSED** (3+ unpaid covered slots, user said it ended, or no schedule — disclosed, never blocking).
- A blocking stream makes the projection **INCOMPLETE_ESTIMATE** with the omitted bound (remaining scheduled slots × last observed amount, 1%/$50 materiality), and the model receives the omitted stream, its status and its silence (orchestrator wiring `b04e4f1`). `get_baselines` carries `incomplete` instead of silently falling from CADENCE to MEASURED.
**Commits:** `07d59a8` (B), `b04e4f1` (tools.ts wiring + `fin001-wiring.test.ts`).
**Tests:** audit fixture ⇒ INCOMPLETE, bound **$15,000**; skipped-then-resumed ⇒ CURRENT; changed amount; 2 unpaid ⇒ RECENTLY_SILENT, 3 ⇒ LAPSED; stale feed ⇒ UNKNOWN; on-time control ⇒ $15,000 projected, COMPLETE; INTEREST never blocks.
**Residual:** the 2-slot threshold is a judgement, not measured; `Connection.lastSyncedAt` is item-level, so a per-account lag inside one Item is invisible (the failure direction is the safe one: blocking).

### FIN-002 — a user's category correction now moves the economics
**Was (runtime):** on any Plaid row with a personal-finance-category code, re-categorising never changed `flowType` (PFC won), so totals, baselines, streams and projections kept the old economics.
**Rule now:** when a row's category source is `USER_RULE` or `USER_OVERRIDE`, the user's category is the classification signal; the provider code is kept verbatim on the row (immutable provider fact) but suppressed for classification. Transfer-authority and crypto-ledger rows still refuse. Applied in the correction path (`f51ed98`), the USER-rule sync path for future rows, the REQUIRED `audit-flow-desync` and the backfill script (`33cb67f`).
**Residual (owner decision):** rows corrected *before* this change still carry the PFC-derived flow until corrected again; a one-off reclassification via the fixed `backfill-flowtype` would converge them.

## 2. P2/P3

| ID | Change | Commit | Residual |
|---|---|---|---|
| FIN-003 | Income folds signed (a clawback nets); window total floored at 0 like refunds; AI assembler clamps too | `66ed6bf`, `b04e4f1` | a clawback in the month after its deposit lowers that later month |
| FIN-005 | The unrestricted/restricted split is computed and the liquid basis labelled; history now matches the hero | `dad72a6` | the stored snapshot column is unchanged (schema follow-up: `SpaceSnapshot.restrictedCash`) |
| FIN-009 | Ambiguous fingerprint adoption refused; incident recorded (`fingerprint-adoption-ambiguous`, registered `37a5e6f`) | `db5ee8d` | an operator reviews the possible duplicate |
| FIN-011 | Freshness stamped only when Plaid observed a balance | `ff2480f` | — |
| FIN-013 | One `round2` + one `MONEY_EPSILON` in `lib/money/round.ts` for B's paths | `59dd238` | remaining copies listed in B's report |
| FIN-015 | Net-worth comment fixed | `dad72a6` | schema comment |
| FIN-007 | ITEM/ERROR and USER_PERMISSION_REVOKED webhooks change Item health (C) | `5e59c89` | PENDING_EXPIRATION deliberately left syncing until expiry |
| FIN-004 | Documented (Cash Flow page: pending + local clock; AI: settled + UTC) | — | **owner decision**: one timezone/pending convention |
| FIN-006, FIN-008, FIN-010, FIN-012, FIN-014, FIN-016, FIN-017, CQ-017 | Deferred (design work, non-USD only, or cosmetic) | — | listed in `01` |

## 3. Invariants preserved

Net worth is one function across every surface; FX never substitutes 1.0; insert-only price/FX archives; pending→posted event model; the 26 REQUIRED invariant audits pass on the integrated branch (`4834697`), including `audit-flow-desync`, `audit-pending-posted-desync`, `audit-transfer-authority`, `audit-ai-read-parity`; the forecast engine's 16 real-mutant checks still pass.
