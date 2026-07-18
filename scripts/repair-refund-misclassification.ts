/**
 * scripts/repair-refund-misclassification.ts
 *
 * SR-4 — safe historical repair for the FABRICATED-REFUND defect (SR-1).
 *
 * ── The corruption this repairs ──────────────────────────────────────────────
 * Before FLOW_CLASSIFIER_VERSION 4, a positive amount in the catch-all `Other`
 * category classified REFUND / SIGN_DEFAULT_INFLOW — the classifier manufactured a
 * spend reversal out of "the provider told us nothing". A pending paycheck
 * (Other / OTHER_OTHER / +5,286.63) became a $5k REFUND. SR-1 corrected the
 * classifier; this script corrects the rows the OLD classifier already wrote.
 *
 * ── SEMANTIC selection, NULL-safe (SR-4 completion) ──────────────────────────
 * The corruption is a SEMANTIC signature, not a version. Target rows whose
 * persisted classification IS the fabricated refund:
 *     flowType             = REFUND
 *     classificationReason = SIGN_DEFAULT_INFLOW
 *     category             = Other
 *     classifierVersion   <= 3               (auditing history; SR-1 guarantees no
 *                                             v4+ classifier can produce this shape)
 * and NEVER a human's intent:
 *     categorySource IS NULL  OR  categorySource NOT IN (USER_OVERRIDE, USER_RULE)
 *
 * The NULL arm is load-bearing and was the bug in the first cut: SQL
 * `NOT (categorySource IN (...))` evaluates to UNKNOWN — i.e. NOT MATCHED — when
 * categorySource IS NULL, so the plain `NOT IN` silently skipped exactly the rows
 * it had to fix (every corrupted row carries the "pre-MI, provenance unknown" NULL
 * default). `categorySource IS NULL OR NOT IN (...)` is the correct three-valued
 * guard: repair everything except explicit human category intent.
 *
 * ── What it does per row (the SAME chain a fresh sync runs) ───────────────────
 *   1. descriptor category rescue — resolveLiabilityPaymentCategory (card
 *      payment) then resolvePayrollIncomeCategory (payroll). Only Other is ever
 *      rescued; payroll evidence promotes Other → Income.
 *   2. re-run classifyFlow on the (possibly rescued) category and persist the new
 *      flow columns at classifierVersion = 4:
 *        · rescued to Income          → INCOME  / DESCRIPTOR_EVIDENCE
 *        · rescued to Payment (card)  → DEBT_PAYMENT / CATEGORY_FLOW_VALUE
 *        · still Other (no evidence)  → UNKNOWN / AMBIGUOUS_UNKNOWN  (honest valve)
 *      When the category was rescued, the `category` column is updated too, so
 *      category and flowType stay coherent (one decision, two columns). A payroll
 *      rescue is stamped DESCRIPTOR_EVIDENCE (the resolver, not the classifier,
 *      decided the kind) — the same reason a freshly-synced pending payroll gets.
 *
 * ── Safety ───────────────────────────────────────────────────────────────────
 *  - DRY RUN is the DEFAULT and prints a per-row candidate table (ID · Current →
 *    Proposed) plus totals (row count + summed |amount|). Review it, THEN --apply.
 *  - Parameterized RAW UPDATE of ONLY the flow columns (+ category when rescued);
 *    deliberately NOT db.transaction.update, so @updatedAt and every unrelated
 *    column stay byte-identical. Never touches USER_OVERRIDE / USER_RULE rows.
 *  - Keyset pagination by id — resume-safe.
 *  - Rollback log: under --apply each changed row prints a ROLLBACK line with its
 *    id + BEFORE→AFTER flow facts (non-PII), so the exact prior state is restorable.
 *  - Idempotent: after a run the target rows no longer match (category=Income /
 *    Payment, or flowType=UNKNOWN), so a second --apply finds 0.
 *
 * Run:
 *   npx dotenv -e .env.local -- npx tsx scripts/repair-refund-misclassification.ts [--apply]
 *                                        [--batch=N] [--limit=N] [--include-deleted]
 *   Dry run (default): prints the candidate table + totals, writes nothing.
 *   --apply:           writes the repair and prints the rollback log.
 */

import { db } from "@/lib/db";
import { classifyFlow, FLOW_CLASSIFIER_VERSION } from "@/lib/transactions/flow-classifier";
import { buildFlowInputFromRow, buildFlowWriteFields, withDescriptorEvidenceReason } from "@/lib/transactions/plaid-flow-input";
import { resolveLiabilityPaymentCategory } from "@/lib/transactions/liability-payment";
import { resolvePayrollIncomeCategory } from "@/lib/transactions/descriptor-evidence";
import type { Prisma, TransactionCategory } from "@prisma/client";

const argv = process.argv.slice(2);
function intFlag(name: string, def: number): number {
  const a = argv.find((x) => x.startsWith(`${name}=`));
  if (!a) return def;
  const n = parseInt(a.split("=")[1] ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : def;
}

const APPLY           = argv.includes("--apply");
const INCLUDE_DELETED = argv.includes("--include-deleted");
const BATCH           = intFlag("--batch", 500);
const LIMIT           = intFlag("--limit", Number.POSITIVE_INFINITY);

/**
 * The corruption signature — the EXACT triple the pre-SR-1 classifier wrote for a
 * fabricated refund, NULL-safe on the human-intent exclusion, version-audited.
 */
function selectionWhere(): Prisma.TransactionWhereInput {
  const signature: Prisma.TransactionWhereInput = {
    flowType:             "REFUND",
    classificationReason: "SIGN_DEFAULT_INFLOW",
    category:             "Other",
    // classifierVersion <= 3 (SR-1 guarantees no v4+ classifier emits this shape).
    classifierVersion:    { lte: FLOW_CLASSIFIER_VERSION - 1 },
    // NULL-safe human-intent exclusion: keep NULL-source rows (the corruption's
    // own default), drop only explicit USER_OVERRIDE / USER_RULE.
    OR: [
      { categorySource: null },
      { categorySource: { notIn: ["USER_OVERRIDE", "USER_RULE"] } },
    ],
  };
  return INCLUDE_DELETED ? signature : { AND: [signature, { deletedAt: null }] };
}

/** Resolve the repaired category via the SAME rescue chain the ingest seams run. */
function repairedCategory(row: {
  category: string; amount: number; merchant: string | null; description: string | null;
  accountType: string | null; debtSubtype: string | null;
}): string {
  const afterPayment = resolveLiabilityPaymentCategory(row.category, "Payment", {
    accountType: row.accountType, debtSubtype: row.debtSubtype,
    amount: row.amount, merchant: row.merchant, description: row.description,
  });
  return resolvePayrollIncomeCategory(afterPayment, "Income", {
    amount: row.amount, merchant: row.merchant, description: row.description,
  });
}

interface Candidate {
  id: string; amount: number; version: number | null;
  newCategory: string; newFlowType: string; newReason: string; descriptorRescued: boolean;
  fields: ReturnType<typeof buildFlowWriteFields>;
}

async function main(): Promise<void> {
  const baseWhere = selectionWhere();

  console.log(`\n${APPLY ? "[APPLY] SR-4 repair fabricated refunds — WRITING" : "[DRY RUN] SR-4 repair fabricated refunds — READ-ONLY, no writes"}`);
  console.log("Selection: flowType=REFUND AND reason=SIGN_DEFAULT_INFLOW AND category=Other");
  console.log(`           AND classifierVersion <= ${FLOW_CLASSIFIER_VERSION - 1}`);
  console.log("           AND (categorySource IS NULL OR categorySource NOT IN (USER_OVERRIDE, USER_RULE))  ← NULL-safe");
  console.log(`           ${INCLUDE_DELETED ? "including" : "excluding"} soft-deleted   → writing classifierVersion = ${FLOW_CLASSIFIER_VERSION}`);
  console.log(`Batch: ${BATCH}${Number.isFinite(LIMIT) ? `   Limit: ${LIMIT}` : ""}\n`);

  const candidates: Candidate[] = [];
  let scanned = 0;
  let lastId = "";

  while (scanned < LIMIT) {
    const take = Math.min(BATCH, LIMIT - scanned);
    const rows = await db.transaction.findMany({
      where:   lastId ? { AND: [baseWhere, { id: { gt: lastId } }] } : baseWhere,
      orderBy: { id: "asc" },
      take,
      select: {
        id: true, category: true, amount: true, merchant: true, description: true,
        pfcPrimary: true, pfcDetailed: true, pfcConfidenceLevel: true, merchantEntityId: true,
        classifierVersion: true,
        financialAccount: { select: { type: true, debtSubtype: true } },
      },
    });
    if (rows.length === 0) break;

    for (const r of rows) {
      const accountType = (r.financialAccount?.type as string | null) ?? null;
      const debtSubtype = r.financialAccount?.debtSubtype ?? null;

      // 1. descriptor category rescue (card-payment then payroll) — Other-only.
      const newCategory = repairedCategory({
        category: r.category, amount: r.amount, merchant: r.merchant, description: r.description,
        accountType, debtSubtype,
      });
      // A payroll promotion (Other → Income) is DESCRIPTOR-EVIDENCE provenance.
      const descriptorRescued = r.category === "Other" && newCategory === "Income";

      // 2. re-run the classifier on the resolved category at the current version.
      const { input, captured } = buildFlowInputFromRow(
        {
          category:           newCategory,
          amount:             r.amount,
          pfcPrimary:         r.pfcPrimary,
          pfcDetailed:        r.pfcDetailed,
          pfcConfidenceLevel: r.pfcConfidenceLevel,
          merchantEntityId:   r.merchantEntityId,
        },
        { accountType, debtSubtype },
      );
      const classification = classifyFlow(input);
      const fields = withDescriptorEvidenceReason(
        buildFlowWriteFields(classification, input, captured, FLOW_CLASSIFIER_VERSION),
        descriptorRescued,
      );

      candidates.push({
        id: r.id, amount: r.amount, version: r.classifierVersion,
        newCategory, newFlowType: classification.flowType,
        newReason: (fields.classificationReason ?? classification.reason) as string,
        descriptorRescued, fields,
      });
      lastId = r.id;
      scanned++;
    }

    if (rows.length < take) break;
  }

  if (candidates.length === 0) {
    console.log("No corrupted rows match the signature — nothing to repair. ✓");
    return;
  }

  // ── Candidate table (always shown) ────────────────────────────────────────
  console.log("SR-4 repair candidates\n");
  console.log("ID                          Current           Proposed");
  console.log("-".repeat(72));
  let totalAbs = 0;
  const outcome: Record<string, number> = {};
  for (const c of candidates) {
    const current  = `Other/REFUND`;
    const proposed = `${c.newCategory}/${c.newFlowType}`;
    console.log(`${c.id.padEnd(27)} ${current.padEnd(17)} ${proposed}`);
    totalAbs += Math.abs(c.amount);
    outcome[proposed] = (outcome[proposed] ?? 0) + 1;
  }
  console.log("-".repeat(72));
  console.log(`Total: ${candidates.length} rows   Σ|amount| = ${totalAbs.toFixed(2)}`);
  console.log("Outcome:", Object.entries(outcome).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(", "));

  if (!APPLY) {
    console.log("\nDry run only — no writes. Review candidates, then re-run with --apply.");
    return;
  }

  // ── Apply (writes) ────────────────────────────────────────────────────────
  console.log("\nApplying — rollback log follows (id · BEFORE → AFTER):\n");
  let updated = 0;
  for (const c of candidates) {
    const f = c.fields;
    // Parameterized RAW UPDATE of ONLY the flow columns (+ category when rescued).
    // Deliberately not db.transaction.update — leaves updatedAt + every non-flow
    // column byte-identical.
    if (c.newCategory !== "Other") {
      await db.$executeRaw`
        UPDATE "Transaction" SET
          "category"                 = ${c.newCategory as TransactionCategory}::"TransactionCategory",
          "flowType"                 = ${f.flowType}::"FlowType",
          "flowDirection"            = ${f.flowDirection}::"FlowDirection",
          "classificationConfidence" = ${f.classificationConfidence},
          "classificationReason"     = ${f.classificationReason}::"FlowClassificationReason",
          "classifierVersion"        = ${f.classifierVersion}
        WHERE "id" = ${c.id}
      `;
    } else {
      await db.$executeRaw`
        UPDATE "Transaction" SET
          "flowType"                 = ${f.flowType}::"FlowType",
          "flowDirection"            = ${f.flowDirection}::"FlowDirection",
          "classificationConfidence" = ${f.classificationConfidence},
          "classificationReason"     = ${f.classificationReason}::"FlowClassificationReason",
          "classifierVersion"        = ${f.classifierVersion}
        WHERE "id" = ${c.id}
      `;
    }
    updated++;
    console.log(
      `  ROLLBACK id=${c.id}  BEFORE category=Other flowType=REFUND reason=SIGN_DEFAULT_INFLOW version=${c.version ?? "null"}` +
      `  →  AFTER category=${c.newCategory} flowType=${c.newFlowType} reason=${c.newReason} version=${FLOW_CLASSIFIER_VERSION}`,
    );
  }
  console.log(`\nApplied — repaired ${updated} row(s) to classifierVersion ${FLOW_CLASSIFIER_VERSION}. Re-run --apply to verify 0 remain.`);
}

main()
  .catch((err) => {
    console.error("repair-refund-misclassification failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.$disconnect();
  });
