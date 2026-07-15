/**
 * scripts/backfill-flowtype.ts
 *
 * FlowType P4 Slice 2 — DRY-RUN-ONLY backfill reporter.
 *
 * READ-ONLY: this slice performs NO database writes. It scans historical
 * Transaction rows that lack a current-version flow classification, classifies
 * each in memory using the exact same contract as the Phase B sync write
 * (buildFlowInputFromRow → classifyFlow), and prints an aggregate, non-PII
 * distribution so the classification can be reviewed before any write path is
 * added in a later slice.
 *
 * Design notes (see docs/initiatives/flowtype/P4_BACKFILL_CHECKLIST.md):
 *  - Selection predicate (§1): rows with null flowType/flowDirection/
 *    classifierVersion, or classifierVersion < FLOW_CLASSIFIER_VERSION.
 *    Idempotent and version-aware by construction.
 *  - Keyset pagination by id (§3.3): resume-safe, drift-free.
 *  - Account context from whichever FK is set: FinancialAccount (type +
 *    debtSubtype) or legacy Account (type only; debtSubtype null).
 *  - counterpartyAccountId is NOT computed or inferred here (§4).
 *  - Aggregate, non-PII output only (§5): --verbose prints id → flowType/reason,
 *    never merchant/amount/description.
 *
 * Run:
 *   npx tsx scripts/backfill-flowtype.ts [--verbose] [--batch=N] [--limit=N] [--exclude-deleted]
 *
 * Diagnostic mode (read-only):
 *   npx tsx scripts/backfill-flowtype.ts --diagnose
 *   Prints ONLY the rows where the classifier's coarse fold disagrees with the
 *   legacy assembler partition (the rows behind a legacyBucketAgreement < 100%),
 *   with non-PII facts only: id, category, amount SIGN (not amount), account
 *   type / debtSubtype, legacy bucket, and proposed flowType/flowDirection/
 *   reason. No merchant, description, amount value, or account name is printed.
 *   Purpose: confirm disagreements are expected classifier improvements, not bugs.
 *
 * Apply mode (writes):
 *   npx tsx scripts/backfill-flowtype.ts --apply [--batch=N] [--limit=N] [--exclude-deleted]
 *   Writes ONLY the flow columns returned by buildFlowWriteFields (flowType,
 *   flowDirection, counterpartyAccountId=null, classificationConfidence,
 *   classificationReason, classifierVersion, pfcPrimary/pfcDetailed/
 *   pfcConfidenceLevel, merchantEntityId) via a PARAMETERIZED RAW UPDATE that
 *   deliberately does NOT bump updatedAt and never touches category, amount,
 *   merchant, date, pending, accountId, financialAccountId, plaidTransactionId,
 *   importBatchId, or any timestamp. Dry-run is the default; --apply is required
 *   to write. Idempotent: a second --apply finds 0 rows (classifierVersion gate).
 *   --diagnose is always read-only and ignores --apply.
 */

import { db } from "@/lib/db";
import type { Prisma } from "@prisma/client";
import { classifyFlow, FLOW_CLASSIFIER_VERSION } from "@/lib/transactions/flow-classifier";
import {
  buildFlowInputFromRow,
  buildFlowWriteFields,
  createShadowStats,
  accumulateShadow,
  summarizeShadow,
  legacyBucket,
  classifierBucket,
} from "@/lib/transactions/plaid-flow-input";

const argv = process.argv.slice(2);

function intFlag(name: string, def: number): number {
  const a = argv.find((x) => x.startsWith(`${name}=`));
  if (!a) return def;
  const n = parseInt(a.split("=")[1] ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : def;
}

const VERBOSE         = argv.includes("--verbose");
const DIAGNOSE        = argv.includes("--diagnose");
const APPLY           = argv.includes("--apply");
const EXCLUDE_DELETED = argv.includes("--exclude-deleted");
const BATCH           = intFlag("--batch", 500);
const LIMIT           = intFlag("--limit", Number.POSITIVE_INFINITY);

// Dry-run is the DEFAULT. Writing requires --apply AND not --diagnose
// (--diagnose is always a read-only report and never writes).
const WILL_WRITE      = APPLY && !DIAGNOSE;

/** A single legacy-vs-classifier bucket disagreement, non-PII only. */
interface Disagreement {
  id:              string;
  category:        string;
  sign:            "+" | "-" | "0";
  accountType:     string | null;
  debtSubtype:     string | null;
  legacyBucket:    string;
  classifierBucket: string;
  flowType:        string;
  flowDirection:   string;
  reason:          string;
}

async function main(): Promise<void> {
  if (APPLY && DIAGNOSE) {
    console.log("Note: --diagnose is read-only; --apply is ignored in diagnostic mode.\n");
  }

  // §1 selection predicate — rows not yet classified at the current version.
  const versionWhere: Prisma.TransactionWhereInput = {
    OR: [
      { flowType: null },
      { flowDirection: null },
      { classifierVersion: null },
      { classifierVersion: { lt: FLOW_CLASSIFIER_VERSION } },
    ],
  };
  const baseWhere: Prisma.TransactionWhereInput = EXCLUDE_DELETED
    ? { AND: [versionWhere, { deletedAt: null }] }
    : versionWhere;

  console.log(`\n${WILL_WRITE ? "[APPLY] FlowType backfill — WRITING flow columns" : "[DRY RUN] FlowType backfill — READ-ONLY, no writes"}`);
  console.log(
    `Selection: flowType/flowDirection/classifierVersion null OR classifierVersion < ${FLOW_CLASSIFIER_VERSION}` +
    `${EXCLUDE_DELETED ? " (excluding soft-deleted)" : " (including soft-deleted)"}`,
  );
  console.log(`Batch: ${BATCH}${Number.isFinite(LIMIT) ? `   Limit: ${LIMIT}` : ""}\n`);

  const stats = createShadowStats();
  const byDirection: Record<string, number> = {};
  const disagreements: Disagreement[] = [];
  let scanned = 0;
  let updated = 0; // rows actually written (--apply only)
  let fine = 0;   // classified using stored PFC (finer)
  let coarse = 0; // classified from category + sign only
  let lastId = "";

  while (scanned < LIMIT) {
    const take = Math.min(BATCH, LIMIT - scanned);
    const rows = await db.transaction.findMany({
      where:   lastId ? { AND: [baseWhere, { id: { gt: lastId } }] } : baseWhere,
      orderBy: { id: "asc" },
      take,
      select: {
        id:                 true,
        category:           true,
        amount:             true,
        merchant:           true,
        description:        true,
        pfcPrimary:         true,
        pfcDetailed:        true,
        pfcConfidenceLevel: true,
        merchantEntityId:   true,
        financialAccount:   { select: { type: true, debtSubtype: true } },
      },
    });
    if (rows.length === 0) break;

    for (const r of rows) {
      const acct = {
        accountType: (r.financialAccount?.type as string | null) ?? null,
        debtSubtype: r.financialAccount?.debtSubtype ?? null,
      };

      const { input, captured } = buildFlowInputFromRow(
        {
          category:           r.category,
          amount:             r.amount,
          merchant:           r.merchant,
          description:        r.description,
          pfcPrimary:         r.pfcPrimary,
          pfcDetailed:        r.pfcDetailed,
          pfcConfidenceLevel: r.pfcConfidenceLevel,
          merchantEntityId:   r.merchantEntityId,
        },
        acct,
      );

      const c = classifyFlow(input);
      accumulateShadow(stats, c, r.category, r.amount);
      byDirection[c.flowDirection] = (byDirection[c.flowDirection] ?? 0) + 1;
      if (r.pfcPrimary || r.pfcDetailed) fine++; else coarse++;

      if (WILL_WRITE) {
        const f = buildFlowWriteFields(c, input, captured, FLOW_CLASSIFIER_VERSION);
        // Parameterized RAW UPDATE of ONLY the 10 flow columns. Deliberately not
        // db.transaction.update (which would auto-bump @updatedAt) — this leaves
        // updatedAt and every non-flow column byte-identical, per the Slice 3
        // rule. Enum columns are cast from the bound text parameter.
        await db.$executeRaw`
          UPDATE "Transaction" SET
            "flowType"                 = ${f.flowType}::"FlowType",
            "flowDirection"            = ${f.flowDirection}::"FlowDirection",
            "counterpartyAccountId"    = ${f.counterpartyAccountId},
            "classificationConfidence" = ${f.classificationConfidence},
            "classificationReason"     = ${f.classificationReason}::"FlowClassificationReason",
            "classifierVersion"        = ${f.classifierVersion},
            "pfcPrimary"               = ${f.pfcPrimary},
            "pfcDetailed"              = ${f.pfcDetailed},
            "pfcConfidenceLevel"       = ${f.pfcConfidenceLevel},
            "merchantEntityId"         = ${f.merchantEntityId}
          WHERE "id" = ${r.id}
        `;
        updated++;
      }

      if (DIAGNOSE) {
        const lb = legacyBucket(r.category, r.amount);
        const cb = classifierBucket(c, r.amount);
        if (lb !== cb) {
          disagreements.push({
            id:               r.id,
            category:         r.category,
            sign:             r.amount > 0 ? "+" : r.amount < 0 ? "-" : "0",
            accountType:      acct.accountType,
            debtSubtype:      acct.debtSubtype,
            legacyBucket:     lb,
            classifierBucket: cb,
            flowType:         c.flowType,
            flowDirection:    c.flowDirection,
            reason:           c.reason,
          });
        }
      }

      if (VERBOSE) console.log(`  ${r.id} → ${c.flowType}/${c.reason}`);

      lastId = r.id;
      scanned++;
    }

    if (rows.length < take) break;
  }

  if (scanned === 0) {
    console.log("Nothing to classify — every row is already at the current classifier version. ✓");
    return;
  }

  if (DIAGNOSE) {
    console.log(`Legacy-vs-classifier disagreements: ${disagreements.length} of ${scanned} scanned\n`);
    for (const d of disagreements) {
      console.log(
        `  id=${d.id}  category=${d.category}  sign=${d.sign}  ` +
        `accountType=${d.accountType ?? "null"}  debtSubtype=${d.debtSubtype ?? "null"}  ` +
        `legacyBucket=${d.legacyBucket} → classifierBucket=${d.classifierBucket}  ` +
        `flowType=${d.flowType}  flowDirection=${d.flowDirection}  reason=${d.reason}`,
      );
    }
    console.log("\nNon-PII only: no merchant, description, amount value, or account name shown.");
    console.log("Read-only diagnostic — no writes.");
    return;
  }

  const fmt = (rec: Record<string, number>) =>
    Object.entries(rec).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(", ");

  console.log(`Scanned:                  ${scanned}${scanned >= LIMIT ? " (--limit reached)" : ""}`);
  console.log(`  from PFC (fine):        ${fine}`);
  console.log(`  coarse (category+sign): ${coarse}`);
  console.log(summarizeShadow(stats));
  console.log(`flowDirection {${fmt(byDirection)}}`);
  console.log(`reason {${fmt(stats.byReason as Record<string, number>)}}`);
  console.log(`counterpartyAccountId:    null for all (no inference)`);
  if (WILL_WRITE) {
    console.log(`\nApplied — flow columns written to ${updated} row(s). Re-run --apply to verify 0 remain.`);
  } else {
    console.log("\nDry run only — no writes. Re-run with --apply to write.");
  }
}

main()
  .catch((err) => {
    console.error("backfill-flowtype failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.$disconnect();
  });
