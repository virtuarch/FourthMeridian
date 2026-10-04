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
 *
 * RLS-PREP-C — ONE TENANT PHASE, ALL SIX SEAMS. RLS-T1 left this route passing
 * `db` (the migration principal) explicitly, because converting only the read
 * inside a write path would have produced a route that reads as the caller and
 * writes as the owner. This is the slice it was waiting for: the row load, the
 * merchant resolution, the rule mint, the row stamp and the read-back all run
 * inside ONE `withTenantDb` transaction on `fm_app`.
 *
 * Every table it touches is expressible under the existing policies, with no
 * policy changed:
 *   Transaction      account subtree — an ACTIVE link into a Space I can see,
 *                    or an account I own
 *   MerchantRule     `ownerUserId = me` (a USER rule is the caller's own)
 *   Merchant/Alias   global reference tables (no RLS; fm_app may read/insert/update)
 *
 * ⚠️ A REFUSED WRITE CANNOT REPORT SUCCESS HERE. Every row write is a
 * `transaction.update({ where: { id } })`, and Prisma RAISES (P2025) when an
 * UPDATE matches no row — which is exactly what a policy that hides the row
 * produces. There is no `updateMany` whose zero count could be read as a calm
 * outcome. The raise aborts the phase, the phase rolls back, and the caller gets
 * the 500; a half-applied correction (rule minted, row not stamped) cannot
 * commit, which the six separate autocommit statements used to allow.
 *
 * `transactionDetailWhere` and `requireSpaceAction` are KEPT. RLS is the tenancy
 * boundary, not the product permission: the policy would let any member of a
 * Space that links the account reach the row, and FULL visibility plus MEMBER+
 * are the narrower product rules. All three must hold.
 */

import { NextRequest, NextResponse }  from "next/server";
import { requireUser }                from "@/lib/session";
import { requireSpaceAction }         from "@/lib/spaces/authorize";
import { getSpaceContext }            from "@/lib/space";
import { getTransactionDetail }       from "@/lib/data/transactions";
import { withTenantDb }               from "@/lib/db/tenant-context";
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

  const validCategory = (v: unknown): v is TransactionCategory =>
    typeof v === "string" && (Object.values(TransactionCategory) as string[]).includes(v);

  type Outcome =
    | { kind: "not-found" }
    | { kind: "invalid-category" }
    | { kind: "unknown-correction" }
    | { kind: "needs-confirmation"; normalized: { canonicalKey: string; displayName: string }; candidates: Awaited<ReturnType<typeof findMerchantCandidates>> }
    | { kind: "done"; body: Record<string, unknown> };

  try {
    const outcome = await withTenantDb(user.id, async (tx): Promise<Outcome> => {
      // Load the row (FULL-visibility scoped) with the fields corrections need.
      const row = await tx.transaction.findFirst({
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
      if (!row) return { kind: "not-found" };

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

      if (correction === "merchant") {
        const decision = planMerchantIdentityCorrection(body as unknown as MerchantIdentityInput);
        if (decision.kind === "needs-confirmation") {
          const candidates = await findMerchantCandidates(tx, decision.normalized.displayName);
          return { kind: "needs-confirmation", normalized: decision.normalized, candidates };
        }
        const { merchantId } = await applyMerchantIdentityCorrection(tx, correctionRow, decision);
        const transaction = await getTransactionDetail(tx, id, { spaceId });
        return { kind: "done", body: { transaction, merchantId } };
      }

      if (correction === "category") {
        if (!validCategory(body.category)) return { kind: "invalid-category" };
        // The rule attaches to the row's merchant; ensure one exists (mint from the
        // provider descriptor — not free text — for any legacy row lacking it).
        let merchantRow = correctionRow;
        if (!merchantRow.merchantId) {
          const mi = await resolveMerchantWrite(tx, {
            merchant: correctionRow.merchant, description: correctionRow.description,
            merchantEntityId: correctionRow.merchantEntityId, currentCategory: correctionRow.category,
            currentCategorySource: correctionRow.categorySource, currentMerchantId: null,
          });
          if (mi.merchantId) await tx.transaction.update({ where: { id }, data: { merchantId: mi.merchantId } });
          merchantRow = { ...correctionRow, merchantId: mi.merchantId };
        }
        const { ruleId } = await applyCategoryRuleCorrection(tx, merchantRow, acct, user.id, body.category);
        const transaction = await getTransactionDetail(tx, id, { spaceId });
        return { kind: "done", body: { transaction, ruleId } };
      }

      if (correction === "override") {
        if (!validCategory(body.category)) return { kind: "invalid-category" };
        await applyTransactionOverride(tx, correctionRow, acct, body.category);
        const transaction = await getTransactionDetail(tx, id, { spaceId });
        return { kind: "done", body: { transaction } };
      }

      return { kind: "unknown-correction" };
    });

    if (outcome.kind === "not-found")        return NextResponse.json({ error: "Not found" }, { status: 404 });
    if (outcome.kind === "invalid-category") return NextResponse.json({ error: "Invalid category" }, { status: 400 });
    if (outcome.kind === "unknown-correction") return NextResponse.json({ error: "Unknown correction" }, { status: 400 });
    if (outcome.kind === "needs-confirmation") {
      return NextResponse.json(
        { needsConfirmation: true, normalized: outcome.normalized, candidates: outcome.candidates },
        { status: 409 },
      );
    }
    return NextResponse.json(outcome.body);
  } catch (e) {
    console.error(`[POST /api/transactions/${id}/correct] correction failed:`, e);
    return NextResponse.json({ error: "Correction failed" }, { status: 500 });
  }
}
