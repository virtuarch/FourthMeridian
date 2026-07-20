# CCPAY — Recorded Follow-ups

Findings surfaced during CCPAY-2A…2F that were deliberately **not** implemented in
those slices (each would have broadened scope or changed a different authority).
Recorded here so they are not lost. None is required for CCPAY correctness; all
are honest debt with a known shape.

---

## FU-1 — BTC flow-authority convergence

**What.** `lib/crypto/btc-sync.ts` (`buildTransactionRow`, ~lines 247-286) authors
`flowType`, `flowDirection`, and `classificationReason` **by hand**, bypassing
`classifyFlow`. It is a sixth flow-classification authority, and it derives
`category` *from* `flowType` (`FLOW_TO_CATEGORY`) — the inverse of the canonical
`classifyFlow`, which derives flow from category.

**Why it was left alone (CCPAY-2F).** Its 25 live rows in `Chris' Space`
(`Bitcoin received`) carry `classifierVersion = null` and a hand-written
`SIGN_DEFAULT_INFLOW`. Because they have no resolved merchant, they currently
fire `needs-classification.ts` clause B (`UNKNOWN_INFLOW_SOURCE`) and feed the
Daily Brief's `unknownInflowTotal`. Routing them through `classifyFlow` would flip
the reason to `CATEGORY_FLOW_VALUE` and **silently retire that honesty signal**,
and would raise confidence `0.5 → 1.0` on a circular derivation. The v2→v3
backfill was scoped to `classifierVersion = 2` specifically to leave them untouched.

**Investigate.** Whether btc-sync should route through `classifyFlow` (eliminating
the sixth authority) or an explicit, documented crypto-flow authority — **without
destroying the unknown-inflow honesty signal**. If it converges, decide what
`classifierVersion` those rows should then carry and whether they enter the
certified population in `audit-flow-desync.ts` (they are currently
"FOREIGN-AUTHORITY", reported and not failed).

---

## FU-2 — Never-classified seed/demo backlog (P4)

**What.** 352 rows carry `classifierVersion = null` **and** `flowType = null` — the
demo/seed Spaces (Beacon Bank, Demo Bank, Example Credit Union, Summit Business
Bank). Nothing has ever classified them.

**Why it was left alone (CCPAY-2F).** This is the original P4 backfill's unfinished
job, not a CCPAY migration. The default `backfill-flowtype.ts` predicate (without
`--only-version`) is exactly the tool for it; it was simply out of CCPAY scope.
`audit-flow-desync.ts` reports them as an uncertified **backlog**, never as a
desync.

**Do.** Classify or migrate under its own initiative, using the default (non-scoped)
`backfill-flowtype.ts --apply` once someone owns the decision for demo data. Note
the seed source itself now emits a mix of classifiable rows; a fresh reseed would
still leave them null until a backfill runs (btc-sync rows aside).

---

## FU-3 — Existing seeded liability-payment fixture repair

**What.** CCPAY-2F corrected the 7 `CC Payment` fixtures in `prisma/seed.ts` from
negative to positive (a card payment is money *into* the liability). That fixed the
**source**. The 7 rows **already persisted** in the current database from an earlier
seed run are unaffected by a source edit.

**Status after 2F.** Those 7 rows are in the FU-2 never-classified backlog
(`flowType = null`), so they are not certified and not part of any CCPAY number.
Under the *corrected* seed, a fresh `prisma db seed` produces positive rows that
classify `DEBT_PAYMENT/INFLOW`. Under the *current* persisted (negative) rows, a
future default backfill would classify them `SPENDING/OUTFLOW` — correct for the
data as literally stored, wrong for the seeder's intent.

**Do — only if the 7 negative rows still exist when someone next touches demo data.**
Either reseed the affected demo Spaces from the corrected source, or (if preserving
ids matters) flip the sign on those 7 specific rows. This is demo-only; no
production or test path depends on it. Fold into FU-2 rather than running a
bespoke migration.
