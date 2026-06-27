/**
 * lib/imports/authorize.ts
 *
 * D2 Step 4D-5c-2 — shared account-resolution/authorization check for the
 * import feature's two routes (the existing confirm route and the new
 * preview route). Extracted verbatim from
 * app/api/accounts/[id]/import/route.ts's pre-4D-5c-2 inline block — same
 * two `db` reads, same NextResponse bodies/status codes, zero behavior
 * change. See docs/initiatives/d2/D2_STEP4D5C2_IMPLEMENTATION_PLAN.md §2 on
 * why this is shared rather than duplicated: a preview call against an
 * account the caller can't access must 404 identically to confirm — letting
 * the two checks drift would be an authorization bug, not a display bug
 * (see docs/initiatives/d2/D2_STEP4D5C_PREVIEW_INVESTIGATION.md §10 risk #7).
 *
 * `id` refers to a FinancialAccount.id. Import specifically requires a
 * FinancialAccount: ImportBatch.financialAccountId is a required FK to
 * FinancialAccount, not the legacy Account model, and the two id spaces
 * never overlap. A legacy-only match (no FinancialAccount counterpart) is
 * therefore a real "can't do this" case, not just a fallback to try — same
 * SpaceAccountLink-first, legacy-Account-fallback pattern as GET
 * .../transactions, unchanged by this extraction.
 */

import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { ShareStatus } from "@prisma/client";

export type ImportAccountAccess =
  | { ok: true; financialAccountId: string }
  | { ok: false; response: NextResponse };

export async function resolveImportableFinancialAccount(
  spaceId: string,
  id: string
): Promise<ImportAccountAccess> {
  const link = await db.spaceAccountLink.findFirst({
    where:  { spaceId, financialAccountId: id, status: ShareStatus.ACTIVE },
    select: { id: true },
  });

  if (!link) {
    const legacyAccount = await db.account.findFirst({ where: { id, spaceId }, select: { id: true } });
    if (!legacyAccount) {
      return { ok: false, response: NextResponse.json({ error: "Not found" }, { status: 404 }) };
    }
    return {
      ok: false,
      response: NextResponse.json(
        { error: "This account does not support transaction import." },
        { status: 400 }
      ),
    };
  }

  return { ok: true, financialAccountId: id };
}
