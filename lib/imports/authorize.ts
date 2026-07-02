/**
 * lib/imports/authorize.ts
 *
 * D2 Step 4D-5c-2 — shared account-resolution/authorization check for the
 * import feature's two routes (the existing confirm route and the new
 * preview route). Extracted verbatim from
 * app/api/accounts/[id]/import/route.ts's pre-4D-5c-2 inline block — same
 * two `db` reads, same NextResponse bodies/status codes, zero behavior
 * change. See docs/initiatives/d2/implementation/D2_STEP4D5C2_IMPLEMENTATION_PLAN.md §2 on
 * why this is shared rather than duplicated: a preview call against an
 * account the caller can't access must 404 identically to confirm — letting
 * the two checks drift would be an authorization bug, not a display bug
 * (see docs/initiatives/d2/investigations/D2_STEP4D5C_PREVIEW_INVESTIGATION.md §10 risk #7).
 *
 * `id` refers to a FinancialAccount.id. Import specifically requires a
 * FinancialAccount: ImportBatch.financialAccountId is a required FK to
 * FinancialAccount, not the legacy Account model, and the two id spaces
 * never overlap. A legacy-only match (no FinancialAccount counterpart) is
 * therefore a real "can't do this" case, not just a fallback to try — same
 * SpaceAccountLink-first, legacy-Account-fallback pattern as GET
 * .../transactions, unchanged by this extraction.
 *
 * D2 Slice B — Import Ownership Guard.
 *
 * The existing SpaceAccountLink check only gates visibility (the account is
 * linked to the current Space). Import is a write operation: it creates
 * ImportBatch and Transaction rows. A user who can _see_ an account because
 * they are a Space MEMBER should not be able to import into an account
 * they don't own or administer.
 *
 * After the visibility check passes, a second write-authority check
 * determines whether the caller may import:
 *
 *   1. Ownership: FinancialAccount.ownerUserId === userId, OR
 *                 FinancialAccount.createdByUserId === userId (D11 —
 *                 for Space-owned accounts where ownerUserId is null,
 *                 createdByUserId records the human who connected it).
 *
 *   2. Space authority: caller holds an ACTIVE SpaceMember row with
 *                       role OWNER or ADMIN for the current Space.
 *
 * Either condition is sufficient. If neither holds, 403 is returned —
 * same semantics as a read-only MEMBER who can view transactions but has
 * no write authority over the account itself.
 *
 * The `userId` parameter is new in Slice B. Both call sites (import/route.ts
 * and import/preview/route.ts) already hold a resolved `user` from
 * requireUser() and pass user.id here.
 */

import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { ShareStatus, SpaceMemberRole, SpaceMemberStatus } from "@prisma/client";

export type ImportAccountAccess =
  | { ok: true; financialAccountId: string }
  | { ok: false; response: NextResponse };

export async function resolveImportableFinancialAccount(
  userId: string,
  spaceId: string,
  id: string
): Promise<ImportAccountAccess> {
  // ── Step 1: Visibility check (unchanged from pre-Slice-B) ────────────────
  // Confirms the account is linked to this Space at all. 404 if the account
  // doesn't exist; 400 if it exists only in the legacy Account table (those
  // accounts don't support ImportBatch).
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

  // ── Step 2: Write-authority check (D2 Slice B) ───────────────────────────
  // Check ownership first. For USER-owned accounts ownerUserId is the owner;
  // for SPACE-owned accounts ownerUserId is null and createdByUserId (D11)
  // records the human who connected it — both convey write authority.
  const fa = await db.financialAccount.findUnique({
    where:  { id },
    select: { ownerUserId: true, createdByUserId: true },
  });

  if (fa?.ownerUserId === userId || fa?.createdByUserId === userId) {
    return { ok: true, financialAccountId: id };
  }

  // Not the account's owner/creator — check whether the caller holds a
  // write-capable role (OWNER or ADMIN) in this Space. MEMBER is read-only.
  const membership = await db.spaceMember.findUnique({
    where:  { spaceId_userId: { spaceId, userId } },
    select: { role: true, status: true },
  });

  const hasSpaceWriteAuthority =
    membership?.status === SpaceMemberStatus.ACTIVE &&
    (membership.role === SpaceMemberRole.OWNER ||
     membership.role === SpaceMemberRole.ADMIN);

  if (!hasSpaceWriteAuthority) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "You do not have permission to import into this account." },
        { status: 403 }
      ),
    };
  }

  return { ok: true, financialAccountId: id };
}
