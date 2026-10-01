/**
 * POST /api/transactions/[id]/correct  (MI1 M5 — user correction loop)
 *
 * Persists a durable Merchant Intelligence correction to a single transaction the
 * caller can see at FULL visibility (the same `transactionDetailWhere` gate the
 * read-only detail route uses). A sibling of the read-only TI-1 detail route so
 * that route stays a pure read (see lib/data/transaction-detail.privacy.test.ts).
 *
 * Three corrections, one per request:
 *   { correction: "merchant", selectMerchantId | (createDisplayName + confirmCreate) | proposedName }
 *   { correction: "category", category }   → USER MerchantRule + row stamped USER_RULE
 *   { correction: "override", category }   → row stamped USER_OVERRIDE (this row only)
 *
 * A merchant correction with only a proposed name (no explicit select/confirm)
 * returns 409 with the normalized identity + existing candidates — a Merchant is
 * NEVER minted from free text alone. Only the edited row changes here; future
 * transactions inherit corrections through the live write path (no historical
 * rewrite). No UI is added.
 *
 * RLS Slice 2 — WRITE AUTHORITY IS NOT READ VISIBILITY.
 * `transactionDetailWhere(id, spaceId)` is a READ predicate: it answers "may
 * this Space see this row's detail?" (an ACTIVE SpaceAccountLink at a
 * transaction-detail tier). It was the ONLY gate here, so a VIEWER of a Space
 * holding a FULL-tier link could perform three durable writes — stamp the row,
 * mint a USER MerchantRule that then steers every future transaction, or set a
 * category override. One of the two drifted write-authority shapes in
 * docs/plans/POSTGRES-RLS-ARCHITECTURE-INVESTIGATION.md §17.1 item 7.
 *
 * The role gate is now explicit: `requireSpaceAction(spaceId,
 * "transaction:correct")` (MEMBER+, ACTIVE). `transactionDetailWhere` is KEPT —
 * FULL visibility remains a NECESSARY condition, it is simply no longer a
 * sufficient one. Both must hold.
 */

import { NextRequest, NextResponse }  from "next/server";
import { requireUser }                from "@/lib/session";
import { requireSpaceAction }         from "@/lib/spaces/authorize";
import { getSpaceContext }            from "@/lib/space";
import { getTransactionDetail }       from "@/lib/data/transactions";
import { db }                         from "@/lib/db";
import { TransactionCategory }        from "@prisma/client";
import { transactionDetailWhere }     from "@/lib/transactions/detail-query";
import { resolveMerchantWrite }       from "@/lib/transactions/merchant-write";
import {
  planMerchantIdentityCorrection,
  findMerchantCandidates,
  applyMerchantIdentityCorrection,
  applyCategoryRuleCorrection,
  applyTransactionOverride,
  type CorrectionRow,
  type CorrectionAcct,
  type MerchantIdentityInput,
} from "@/lib/transactions/merchant-corrections";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const [user, err] = await requireUser();
  if (err) return err;

  const { spaceId } = await getSpaceContext();

  // Role gate BEFORE any body parse or row read: a durable write needs MEMBER+,
  // not merely a Space that can see the row (see module header).
  const [, spaceErr] = await requireSpaceAction(spaceId, "transaction:correct");
  if (spaceErr) return spaceErr;

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const correction = body.correction;

  // Load the row (FULL-visibility scoped) with the fields corrections need.
  const row = await db.transaction.findFirst({
    where: transactionDetailWhere(id, spaceId),
    select: {
      id: true, merchant: true, description: true, category: true, amount: true,
      merchantId: true, categorySource: true, merchantEntityId: true,
      pfcPrimary: true, pfcDetailed: true, pfcConfidenceLevel: true,
      // v2.6-OWN-1 — who owns this row's flow facts.
      flowAuthority: true,
      financialAccount: { select: { type: true, debtSubtype: true } },
    },
  });
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const acct: CorrectionAcct = {
    accountType: (row.financialAccount?.type as string | null) ?? null,
    debtSubtype: row.financialAccount?.debtSubtype ?? null,
  };
  const correctionRow: CorrectionRow = {
    id: row.id, merchant: row.merchant, description: row.description, category: row.category,
    amount: row.amount, merchantId: row.merchantId, categorySource: row.categorySource,
    merchantEntityId: row.merchantEntityId, pfcPrimary: row.pfcPrimary,
    pfcDetailed: row.pfcDetailed, pfcConfidenceLevel: row.pfcConfidenceLevel,
    flowAuthority: row.flowAuthority,
  };

  const validCategory = (v: unknown): v is TransactionCategory =>
    typeof v === "string" && (Object.values(TransactionCategory) as string[]).includes(v);

  try {
    if (correction === "merchant") {
      const decision = planMerchantIdentityCorrection(body as unknown as MerchantIdentityInput);
      if (decision.kind === "needs-confirmation") {
        const candidates = await findMerchantCandidates(db, decision.normalized.displayName);
        return NextResponse.json(
          { needsConfirmation: true, normalized: decision.normalized, candidates },
          { status: 409 },
        );
      }
      const { merchantId } = await applyMerchantIdentityCorrection(db, correctionRow, decision);
      const transaction = await getTransactionDetail(id, { spaceId });
      return NextResponse.json({ transaction, merchantId });
    }

    if (correction === "category") {
      if (!validCategory(body.category)) return NextResponse.json({ error: "Invalid category" }, { status: 400 });
      // The rule attaches to the row's merchant; ensure one exists (mint from the
      // provider descriptor — not free text — for any legacy row lacking it).
      let merchantRow = correctionRow;
      if (!merchantRow.merchantId) {
        const mi = await resolveMerchantWrite(db, {
          merchant: correctionRow.merchant, description: correctionRow.description,
          merchantEntityId: correctionRow.merchantEntityId, currentCategory: correctionRow.category,
          currentCategorySource: correctionRow.categorySource, currentMerchantId: null,
        });
        if (mi.merchantId) await db.transaction.update({ where: { id }, data: { merchantId: mi.merchantId } });
        merchantRow = { ...correctionRow, merchantId: mi.merchantId };
      }
      const { ruleId } = await applyCategoryRuleCorrection(db, merchantRow, acct, user.id, body.category);
      const transaction = await getTransactionDetail(id, { spaceId });
      return NextResponse.json({ transaction, ruleId });
    }

    if (correction === "override") {
      if (!validCategory(body.category)) return NextResponse.json({ error: "Invalid category" }, { status: 400 });
      await applyTransactionOverride(db, correctionRow, acct, body.category);
      const transaction = await getTransactionDetail(id, { spaceId });
      return NextResponse.json({ transaction });
    }

    return NextResponse.json({ error: "Unknown correction" }, { status: 400 });
  } catch (e) {
    console.error(`[POST /api/transactions/${id}/correct] correction failed:`, e);
    return NextResponse.json({ error: "Correction failed" }, { status: 500 });
  }
}
