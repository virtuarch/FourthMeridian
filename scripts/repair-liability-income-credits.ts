/**
 * scripts/repair-liability-income-credits.ts
 *
 * REFUND-1 — historical repair for MERCHANT CREDITS ON A LIABILITY STORED AS INCOME.
 *
 * ── The corruption this repairs ──────────────────────────────────────────────
 * Before FLOW_CLASSIFIER_VERSION 5, a positive amount on a credit card that the
 * provider filed under the INCOME family was stored Income / INCOME — an Airbnb
 * booking refund became INCOME_RENTAL earnings. The read-time income taxonomy
 * already refused to count such a row as income (ISSUER_CREDIT → NOT_INCOME), so
 * the money reached NEITHER side of the economic fold: not income, not a refund,
 * and the purchase's category stayed gross. v5 corrects the classifier and the
 * ingest seam; this script corrects the rows the old pipeline already wrote.
 *
 * ── STRUCTURAL selection ─────────────────────────────────────────────────────
 *     flowType = INCOME   AND   amount > 0
 *     AND the row sits on a LIABILITY account (type = debt OR debtSubtype set)
 *     AND flowAuthority = CLASSIFIER or NULL          (v2.6-OWN-1 ownership gate)
 *     AND categorySource IS NULL OR NOT IN (USER_OVERRIDE, USER_RULE)   (NULL-safe)
 *     AND deletedAt IS NULL                           (unless --include-deleted)
 * No merchant string, no amount threshold, no date window.
 *
 * ── What it does per row (the SAME chain a fresh sync runs) ───────────────────
 *   1. readPriorPurchaseCategories — the same merchant's prior purchases on the
 *      same account (lib/transactions/merchant-credit-evidence.ts).
 *   2. resolveLiabilityMerchantCreditCategory — unanimous genuine spend category
 *      ⇒ that category; silent / split / Other-only history ⇒ Other.
 *   3. classifyFlow at v5 ⇒ REFUND (spend category) or UNKNOWN (Other). Never INCOME.
 *   `category` and the flow columns are written together (one decision, two
 *   columns). A provider provenance stamp that no longer describes the category
 *   (categorySource = PLAID_PFC beside a category the provider did not choose) is
 *   cleared to NULL — "provenance not claimed", never a false claim.
 *
 * ── Safety ───────────────────────────────────────────────────────────────────
 *  - DRY RUN is the DEFAULT: prints the candidate table + totals, writes nothing.
 *  - --apply: parameterized RAW UPDATE of ONLY category / categorySource / flow
 *    columns; @updatedAt and every other column stay byte-identical. Prints a
 *    ROLLBACK line per row (non-PII: id + before → after facts).
 *  - Idempotent: a repaired row is no longer flowType = INCOME, so a second run
 *    finds 0.
 *  - 🚨 Take a database backup before --apply. Never run `prisma migrate dev`.
 *
 * Run:
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs --env-file=.env.local \
 *     scripts/repair-liability-income-credits.ts [--apply] [--include-deleted] [--verbose]
 *   --verbose additionally prints merchant / date / amount per candidate (local review only).
 */

import { db } from "@/lib/db";
import { classifyFlow, FLOW_CLASSIFIER_VERSION } from "@/lib/transactions/flow-classifier";
import { buildFlowInputFromRow, buildFlowWriteFields } from "@/lib/transactions/plaid-flow-input";
import { resolveLiabilityMerchantCreditCategory, type MerchantCreditBasis } from "@/lib/transactions/merchant-credit";
import { readPriorPurchaseCategories, type MerchantCreditEvidenceClient } from "@/lib/transactions/merchant-credit-evidence";
import type { FlowAuthorityName } from "@/lib/transactions/flow-authority";
import type { Prisma, TransactionCategory } from "@prisma/client";

const CLASSIFIER_OWNED = "CLASSIFIER" as const satisfies FlowAuthorityName;

const argv = process.argv.slice(2);
const APPLY           = argv.includes("--apply");
const INCLUDE_DELETED = argv.includes("--include-deleted");
const VERBOSE         = argv.includes("--verbose");

function selectionWhere(): Prisma.TransactionWhereInput {
  const signature: Prisma.TransactionWhereInput = {
    flowType: "INCOME",
    amount:   { gt: 0 },
    financialAccount: { OR: [{ type: "debt" }, { debtSubtype: { not: null } }] },
    // NULL-safe human-intent exclusion (SQL NOT IN drops NULL rows).
    OR: [{ categorySource: null }, { categorySource: { notIn: ["USER_OVERRIDE", "USER_RULE"] } }],
  };
  const owned: Prisma.TransactionWhereInput = {
    OR: [{ flowAuthority: CLASSIFIER_OWNED }, { flowAuthority: null }],
  };
  return INCLUDE_DELETED ? { AND: [signature, owned] } : { AND: [signature, owned, { deletedAt: null }] };
}

interface Candidate {
  id: string; amount: number; date: string; merchant: string;
  oldCategory: string; oldSource: string | null; oldVersion: number | null;
  oldReason: string | null; oldConfidence: number | null; oldDirection: string | null;
  newCategory: string; basis: MerchantCreditBasis; priorPurchases: number;
  fields: ReturnType<typeof buildFlowWriteFields>;
}

async function main(): Promise<void> {
  console.log(`\n${APPLY ? "[APPLY] REFUND-1 repair — WRITING" : "[DRY RUN] REFUND-1 repair — READ-ONLY, no writes"}`);
  console.log("Selection: flowType=INCOME AND amount>0 AND account is a liability");
  console.log(`           AND flowAuthority = ${CLASSIFIER_OWNED} or NULL AND category not user-decided`);
  console.log(`           ${INCLUDE_DELETED ? "including" : "excluding"} soft-deleted   → writing classifierVersion = ${FLOW_CLASSIFIER_VERSION}\n`);

  const rows = await db.transaction.findMany({
    where:   selectionWhere(),
    orderBy: { id: "asc" },
    select: {
      id: true, category: true, categorySource: true, amount: true, date: true, merchant: true, description: true,
      pfcPrimary: true, pfcDetailed: true, pfcConfidenceLevel: true, merchantEntityId: true,
      classifierVersion: true, classificationReason: true, classificationConfidence: true, flowDirection: true,
      financialAccountId: true,
      financialAccount: { select: { type: true, debtSubtype: true } },
    },
  });

  const candidates: Candidate[] = [];
  for (const r of rows) {
    if (!r.financialAccountId) continue;
    const accountType = (r.financialAccount?.type as string | null) ?? null;
    const debtSubtype = r.financialAccount?.debtSubtype ?? null;

    const priorPurchaseCategories = await readPriorPurchaseCategories(db as unknown as MerchantCreditEvidenceClient, {
      financialAccountId: r.financialAccountId,
      merchantEntityId:   r.merchantEntityId,
      merchant:           r.merchant,
      description:        r.description,
      onOrBefore:         r.date,
    });
    // The stored category is whatever the provider mapping wrote; the claim being
    // repaired is "this liability inflow is income", so it is resolved AS that claim.
    const resolved = resolveLiabilityMerchantCreditCategory<string>("Income", "Income", "Other", {
      accountType, debtSubtype, amount: r.amount, priorPurchaseCategories,
    });

    const { input, captured } = buildFlowInputFromRow(
      {
        category:           resolved.category,
        amount:             r.amount,
        pfcPrimary:         r.pfcPrimary,
        pfcDetailed:        r.pfcDetailed,
        pfcConfidenceLevel: r.pfcConfidenceLevel,
        merchantEntityId:   r.merchantEntityId,
      },
      { accountType, debtSubtype },
    );
    const fields = buildFlowWriteFields(classifyFlow(input), input, captured, FLOW_CLASSIFIER_VERSION);
    if (fields.flowType === "INCOME") {
      throw new Error(`invariant: row ${r.id} still classifies INCOME at v${FLOW_CLASSIFIER_VERSION} — refusing to continue`);
    }
    candidates.push({
      id: r.id, amount: r.amount, date: r.date.toISOString().slice(0, 10), merchant: r.merchant,
      oldCategory: r.category, oldSource: r.categorySource, oldVersion: r.classifierVersion,
      oldReason: r.classificationReason, oldConfidence: r.classificationConfidence, oldDirection: r.flowDirection,
      newCategory: resolved.category, basis: resolved.basis, priorPurchases: priorPurchaseCategories.length,
      fields,
    });
  }

  if (candidates.length === 0) {
    console.log("No liability inflow is stored as INCOME — nothing to repair. ✓");
    return;
  }

  console.log("ID                          Current            Proposed           Basis (prior purchases)");
  console.log("-".repeat(110));
  let totalAbs = 0;
  const outcome: Record<string, { n: number; sum: number }> = {};
  for (const c of candidates) {
    const proposed = `${c.newCategory}/${c.fields.flowType}`;
    console.log(`${c.id.padEnd(27)} ${`${c.oldCategory}/INCOME`.padEnd(18)} ${proposed.padEnd(18)} ${c.basis} (${c.priorPurchases})`
      + (VERBOSE ? `   ${c.date}  +${c.amount.toFixed(2)}  ${c.merchant}` : ""));
    totalAbs += Math.abs(c.amount);
    const o = (outcome[proposed] ??= { n: 0, sum: 0 });
    o.n++; o.sum += Math.abs(c.amount);
  }
  console.log("-".repeat(110));
  console.log(`Total: ${candidates.length} rows   Σ|amount| = ${totalAbs.toFixed(2)}`);
  for (const [k, v] of Object.entries(outcome)) console.log(`  ${k.padEnd(20)} ${String(v.n).padStart(3)} rows   ${v.sum.toFixed(2)}`);

  if (!APPLY) {
    console.log("\nDry run only — no writes. Review candidates, back up the database, then re-run with --apply.");
    return;
  }

  console.log("\nApplying — rollback log follows (id · BEFORE → AFTER):\n");
  let updated = 0;
  for (const c of candidates) {
    const f = c.fields;
    // A provider provenance stamp survives only while the category is still the
    // provider's; otherwise NULL ("not claimed"). User sources never reach here.
    const newSource = c.newCategory === c.oldCategory ? c.oldSource : null;
    await db.$executeRaw`
      UPDATE "Transaction" SET
        "category"                 = ${c.newCategory as TransactionCategory}::"TransactionCategory",
        "categorySource"           = ${newSource}::"CategorySource",
        "flowType"                 = ${f.flowType}::"FlowType",
        "flowDirection"            = ${f.flowDirection}::"FlowDirection",
        "classificationConfidence" = ${f.classificationConfidence},
        "classificationReason"     = ${f.classificationReason}::"FlowClassificationReason",
        "classifierVersion"        = ${f.classifierVersion},
        "flowAuthority"            = ${f.flowAuthority}::"FlowAuthority"
      WHERE "id" = ${c.id}
    `;
    updated++;
    console.log(
      `  ROLLBACK id=${c.id}  BEFORE category=${c.oldCategory} categorySource=${c.oldSource ?? "null"} flowType=INCOME flowDirection=${c.oldDirection ?? "null"} reason=${c.oldReason ?? "null"} confidence=${c.oldConfidence ?? "null"} version=${c.oldVersion ?? "null"}`
      + `  →  AFTER category=${c.newCategory} categorySource=${newSource ?? "null"} flowType=${f.flowType} reason=${f.classificationReason} version=${FLOW_CLASSIFIER_VERSION}`,
    );
  }
  console.log(`\nApplied — repaired ${updated} row(s). Re-run (dry) to verify 0 remain.`);
}

main()
  .catch((err) => { console.error("repair-liability-income-credits failed:", err); process.exitCode = 1; })
  .finally(async () => { await db.$disconnect(); });
