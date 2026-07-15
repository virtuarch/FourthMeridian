# Legacy `Account` — Phase 0 Gate Results (LOCAL DB)

| | |
|---|---|
| Date | **2026-07-15** |
| Branch | `feature/v2.5-spaces-completion` |
| HEAD | `4074c75` (working tree dirty — pre-existing KD-20 read-site filters + Investments Allocation WIP preserved untouched) |
| Database | **LOCAL DEV DB ONLY** — `postgresql://fintracker@localhost:5432/fintracker` (Docker `fintracker-db`, healthy). **Not** Preview/Production. |
| Nature | READ-ONLY verification. **No writes, no migrations, no mutation/backfill, no Plaid API calls.** |

## Founder data / environment posture (recorded)

Fourth Meridian is **pre-beta**. The **local dev DB is the database that matters** for architecture and migration development right now. Current Preview/Production deployment databases **contain no external-user data that must be preserved** — the founder explicitly permits them to be wiped/reset before private beta once the canonical schema + migration path are correct. The deployed Production app is still **v2.4.5** (production Plaid credentials, no external users). Therefore preservation of current Preview/Production rows is **not** an architectural constraint, and direct Supabase production DB access is **not** required to complete this Phase 0. A correct Prisma migration history + clean reset/migrate strategy is still required.

## Exact commands run (read-only)

```
npx dotenv -e .env.local -- npx tsx scripts/phase0-seam-gates.ts      # Gates A/B/C/E
npx dotenv -e .env.local -- npx tsx scripts/audit-visibility-levels.ts # SAL visibility grouping
# plus a bespoke read-only aggregate probe (prisma .count / .groupBy only) for canonical-side context,
# written to a repo-root temp file, run, and DELETED afterward (no residue committed).
```

Both committed scripts declare themselves read-only and perform only `prisma.*.count` / `groupBy`. Verified by reading source before running: `scripts/phase0-seam-gates.ts` (only `.count`), `scripts/audit-visibility-levels.ts` (only `groupBy`).

## What Gates A/B/C/E actually measure (from source)

Per `scripts/phase0-seam-gates.ts` (Gate D was removed when `WorkspaceAccountShare` was dropped in v2.5-A Phase 4c):

| Gate | Exact invariant (from source) | Decision role |
|---|---|---|
| **A** | `Holding` rows with `accountId != null AND financialAccountId == null` (legacy-anchored holdings) | A=B=C=0 ⇒ Phase 5 Account-drop in scope |
| **B** | `Transaction` rows with `accountId != null AND financialAccountId == null` (legacy-anchored txns) | same |
| **C** | legacy `Account` rows (`count()` total + `deletedAt: null` live) | same |
| **E** | `visibilityLevel == "SHARED"` on `SpaceAccountLink` **and** on legacy `Account` | E(Account)>0 ⇒ `VisibilityLevel.SHARED` enum removal stays coupled to Phase 5 |

## Gate results — LOCAL DB (2026-07-15)

| Gate | Exact invariant | Local result | ZERO/NONZERO | Meaning | Later action |
|---|---|---|---|---|---|
| **A** | Holding legacy anchors (`accountId` set, `financialAccountId` null) | **0** (context: both-set 0, neither 0) | **ZERO** | No legacy-anchored holdings; all 49 Holding rows are `financialAccountId`-anchored | None locally; verify in prod before Phase 5 |
| **B** | Transaction legacy anchors (`accountId` set, `financialAccountId` null) | **0** (both-set 0, neither 0) | **ZERO** | No legacy-anchored txns; all 4,322 Transaction rows are `financialAccountId`-anchored | None locally; verify in prod |
| **C** | legacy `Account` rows | **0** total / **0** live | **ZERO** | Zero legacy `Account` rows exist locally — the table is empty | None locally; verify in prod |
| **E** | `SHARED` visibility residue | SAL **0** · Account **0** | **ZERO** | No `SHARED` residue anywhere; SAL groups: `FULL/ACTIVE` 55, `BALANCE_ONLY/ACTIVE` 8 | `SHARED` enum removal unblocked (rides with Phase 5) |

**Canonical-side context (read-only aggregate probe):**

- legacy `Account`: total **0**, live 0
- `FinancialAccount`: total **35**, live 35
- `Transaction`: total **4,322** — `financialAccountId` set **4,322** (100%), `accountId` set **0**, neither **0**
- `Holding`: total **49** — `financialAccountId` set **49** (100%), `accountId` set **0**, neither **0**

## Answers to the Phase 0 questions

1. **Is local legacy Account data fully re-anchored?** **Yes.** 0 legacy `Account` rows; 100% of transactions and holdings carry `financialAccountId` and none carry `accountId`. There is nothing left to re-anchor locally.
2. **Are Transaction rows still dependent on `accountId`?** **No** (0 of 4,322).
3. **Are Holding rows still dependent on `accountId`?** **No** (0 of 49).
4. **Are legacy Account rows still present?** **No** (0 total).
5. **Is `VisibilityLevel.SHARED` represented in current data?** **No** (0 on both SAL and Account). Enum-value removal is data-unblocked.
6. **Does source still dual-write any of these legacy fields?** Per the D3 closeout and prior seam work, **zero runtime writes** to legacy `Account` exist (the table is frozen). The remaining legacy *reads* are the corrected inventory in STATUS §5 (6 `Space.accounts` query sites / 7 usages across 5 files + 10 in-memory coalesce shims across 8 files + direct `db.account.*` accessors). No dual-write path repopulates `Transaction.accountId` / `Holding.accountId`. (The local DB being 100% canonical corroborates this — a fresh canonical seed produced no legacy anchors.)
7. **Does an M2 data re-anchor appear logically necessary?** **Not for the local DB** — it is already fully canonical. Whether an M2 re-anchor is needed *at all* depends only on whether any target DB still holds legacy-anchored rows. Given the disposable-deployment posture (below), the correct path is a **clean reset + canonical migrate**, which makes a data-preserving M2 re-anchor migration **unnecessary** for every environment.
8. **Deployment strategy — preserve/migrate vs reset fresh?** **Reset the disposable Preview/Production DBs and apply the canonical migration chain fresh** before private beta. There is no external-user data to preserve, local is already canonical, and a fresh apply guarantees a clean migration history with no bespoke re-anchor step. (See the Plaid pre-reset note below — Items must be removed at Plaid *before* wiping, while the access tokens still exist.)

## Implications

- **M2 re-anchor is not logically required.** The architecture can proceed on the assumption of an all-canonical dataset (true locally; achievable in deployment via reset).
- **Phase 5 (physical `Account` model/FK + `VisibilityLevel.SHARED` drop)** is *locally* clear (A=B=C=E=0) but remains gated on **production gate verification + explicit approval** per D3 — do not drop schema in Phase 0/1 on the strength of local counts alone.
- The **legacy-read retirement** (STATUS §5) is the real Phase 1 v2.5 item; it is a source-cutover, independent of the DB re-anchor question, and needs no DB gate (the local user-facing `dashboard/spaces` `_count.accounts` undercount is fixable immediately).

## What remains unverified (deployed DBs)

- **Production/Preview gate counts A/B/C/E are UNVERIFIED** (`NEEDS RUNTIME/DB VERIFICATION`). This Phase 0 did not (and per the task must not) require production DB access. Before any Phase 5 schema drop, run `scripts/phase0-seam-gates.ts` against the target DB — but given the reset strategy, the practical path is reset-then-migrate, after which the gates are zero by construction.

## Confirmation

**No mutation occurred.** Only `prisma.*.count` / `groupBy` and the two read-only committed scripts were run against the local DB. No migrations, no backfills, no `--apply`, no Plaid API calls, no DB writes. The temporary aggregate probe was deleted; no probe residue is committed.
