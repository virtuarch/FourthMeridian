/**
 * scripts/check-snapshot-integrity.ts
 *
 * V26 P0 — snapshot component integrity probe. READ-ONLY.
 *
 * A balance component is a magnitude: it may be zero, never negative, and never
 * non-finite. `lib/snapshots/regenerate-history.core.ts` now refuses to WRITE a
 * violating value (the INVALID EVIDENCE guard, reason INVALID_VALUATION_EVIDENCE).
 * This probe reports values that are ALREADY STORED — rows written before the
 * guard existed, which the guard cannot retroactively repair.
 *
 * Run:
 *     npx dotenv -e .env.local -- npx tsx scripts/check-snapshot-integrity.ts
 *
 * Exit codes: 0 = clean · 1 = violations found (listed below) · 2 = query failure.
 *
 * READ-ONLY: every statement is a SELECT. This script never writes, and repair
 * is a deliberate, separate act — the writer must be guarded first, or a repair
 * is simply overwritten by the next regeneration.
 *
 * ── PostgreSQL non-finite detection ──────────────────────────────────────────
 * The columns are `double precision`, which CAN store 'NaN', 'Infinity' and
 * '-Infinity'. The usual IEEE-754 idiom `v <> v` does NOT detect NaN here:
 * PostgreSQL deliberately treats NaN as equal to itself (and greater than all
 * non-NaN values) so it can be sorted and indexed. Verified against the local
 * database before this probe was written:
 *
 *     v >= 0 AND v < 'Infinity'::float8    →  NaN:f  +Inf:f  -Inf:f  0:t  -1.5:f  42:t
 *
 * That expression is the exact SQL mirror of `isUsableValuation()` in the core,
 * so the probe and the guard agree on what "usable" means by construction.
 *
 * ── Which columns are checked ────────────────────────────────────────────────
 * NEGATIVITY is checked only on the two components the guard protects —
 * `stocks` and `crypto`. It is deliberately NOT checked on `netWorth` or
 * `netLiquid`, which are legitimately negative when debt exceeds assets
 * (production's earliest row is -13,831 and is correct).
 *
 * NON-FINITE is checked across the stored numeric set, because NaN/±Infinity is
 * never a valid value for any of them, signed or not.
 */

import { db } from "@/lib/db";

interface NegativeRow {
  spaceId: string;
  spaceName: string | null;
  component: string;
  rows: bigint;
  minValue: number;
  firstDate: Date;
  lastDate: Date;
  estimatedRows: bigint;
  observedRows: bigint;
}

interface NonFiniteRow {
  spaceId: string;
  component: string;
  rows: bigint;
}

async function main(): Promise<number> {
  let findings = 0;

  // ── 1. Negative component values (stocks / crypto) ─────────────────────────
  // Grouped per Space and component so an operator sees scope, magnitude, the
  // affected window, and — via the estimated/observed split — whether the bad
  // rows came from reconstruction (isEstimated=true) or were written as
  // observed truth (isEstimated=false, a strictly worse problem).
  const negatives = await db.$queryRaw<NegativeRow[]>`
    SELECT s."spaceId"                                  AS "spaceId",
           sp.name                                      AS "spaceName",
           c.component                                  AS "component",
           COUNT(*)                                     AS "rows",
           MIN(c.value)                                 AS "minValue",
           MIN(s.date)                                  AS "firstDate",
           MAX(s.date)                                  AS "lastDate",
           COUNT(*) FILTER (WHERE s."isEstimated")      AS "estimatedRows",
           COUNT(*) FILTER (WHERE NOT s."isEstimated")  AS "observedRows"
    FROM "SpaceSnapshot" s
    JOIN "Space" sp ON sp.id = s."spaceId"
    CROSS JOIN LATERAL (VALUES ('stocks', s.stocks), ('crypto', s.crypto)) AS c(component, value)
    WHERE c.value < 0
    GROUP BY 1, 2, 3
    ORDER BY "rows" DESC
  `;

  if (negatives.length === 0) {
    console.log("✓ negative components — none (stocks, crypto)");
  } else {
    findings += negatives.length;
    console.error(`✗ NEGATIVE COMPONENTS — ${negatives.length} (space, component) group(s):\n`);
    for (const n of negatives) {
      console.error(
        `  space ${n.spaceId} (${n.spaceName ?? "?"}) · ${n.component}\n` +
        `    ${n.rows} row(s), min ${Number(n.minValue).toFixed(2)}, ` +
        `${n.firstDate.toISOString().slice(0, 10)} → ${n.lastDate.toISOString().slice(0, 10)}\n` +
        `    source: ${n.estimatedRows} reconstructed (isEstimated=true), ` +
        `${n.observedRows} observed (isEstimated=false)`,
      );
    }
    console.error("");
  }

  // ── 2. Non-finite values (NaN / ±Infinity) anywhere in the numeric set ─────
  const nonFinite = await db.$queryRaw<NonFiniteRow[]>`
    SELECT s."spaceId" AS "spaceId", c.component AS "component", COUNT(*) AS "rows"
    FROM "SpaceSnapshot" s
    CROSS JOIN LATERAL (VALUES
      ('stocks', s.stocks), ('crypto', s.crypto), ('cash', s.cash), ('savings', s.savings),
      ('debt', s.debt), ('netWorth', s."netWorth"), ('totalAssets', s."totalAssets"),
      ('netLiquid', s."netLiquid"), ('cashOnHand', s."cashOnHand"), ('total', s.total)
    ) AS c(component, value)
    WHERE c.value IN ('NaN'::float8, 'Infinity'::float8, '-Infinity'::float8)
    GROUP BY 1, 2
    ORDER BY "rows" DESC
  `;

  if (nonFinite.length === 0) {
    console.log("✓ non-finite values — none (NaN, ±Infinity)");
  } else {
    findings += nonFinite.length;
    console.error(`\n✗ NON-FINITE VALUES — ${nonFinite.length} (space, component) group(s):`);
    for (const r of nonFinite) {
      console.error(`  space ${r.spaceId} · ${r.component}: ${r.rows} row(s)`);
    }
  }

  // ── 3. Corpus context ──────────────────────────────────────────────────────
  const [{ total, estimated }] = await db.$queryRaw<Array<{ total: bigint; estimated: bigint }>>`
    SELECT COUNT(*) AS "total", COUNT(*) FILTER (WHERE "isEstimated") AS "estimated"
    FROM "SpaceSnapshot"
  `;
  console.log(`\nsnapshots examined: ${total} (${estimated} reconstructed, ${total - estimated} observed)`);

  if (findings > 0) {
    console.error(
      `\n${findings} integrity finding(s). These rows predate the INVALID EVIDENCE guard in\n` +
      `lib/snapshots/regenerate-history.core.ts, which prevents new ones but cannot repair\n` +
      `existing rows — regeneration SKIPS a day it cannot honestly value, leaving the stored\n` +
      `value in place. Repair is a separate, deliberate slice.`,
    );
    return 1;
  }
  console.log("\ncheck-snapshot-integrity: CLEAN — every stored component is finite and non-negative.");
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error("check-snapshot-integrity: query failed:", e);
    process.exit(2);
  });
