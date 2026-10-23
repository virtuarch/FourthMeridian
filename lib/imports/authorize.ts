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
 * FinancialAccount. An account not resolvable via an ACTIVE SpaceAccountLink
 * to a live FinancialAccount is a real "can't do this" case (404) — same
 * SpaceAccountLink visibility gate as GET .../transactions.
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
 *
 * ── RLS-ACC-S2 — THE AUTHORITY IS REQUIRED, LEADING, AND IT TOOK AN INVENTORY ─
 * This is the ONE authorization gate six import routes share, and until now its
 * client was `client: DbClient = db`. A DEFAULTED authority is an AMBIENT one
 * that LOOKS converted, and that is strictly worse than an obvious one: not a
 * single one of the six production call sites passed anything, so every import
 * authorization in the product ran as the migration principal — the role that
 * owns every table, carries BYPASSRLS and is exempt from every policy — while
 * each route's own source scanned clean.
 *
 * `app/api/imports/[id]/rollback/route.ts` is the sharpest case and it is worth
 * naming. RLS-C-S8 converted that route completely: three `withTenantDb` phases,
 * no `db` import, and a test asserting `!/\bdb\s*\.\w/` over its source. It
 * passed. The authorization BETWEEN those phases was nonetheless running on the
 * migration principal, one file away, because the default resolved there. That is
 * the `holdings.ts` escape from RLS-AI-S6 repeated exactly — an authority reached
 * THROUGH a seam that defaults three files away, invisible to every scan for a
 * held client.
 *
 * So the client is now REQUIRED and LEADING, typed `ReadClient`:
 *   · required, because the call sites that forget an optional authority are
 *     precisely the ones nobody reviews — and here that was all six of them;
 *   · leading, so the authority is the first thing read at the call site, next to
 *     the function's own name;
 *   · `ReadClient`, because Prisma's ITXClientDenyList strips `$transaction` from
 *     that type, so this gate is STRUCTURALLY incapable of opening a phase of its
 *     own. The phase always belongs to the caller that earned the identity.
 *     `PrismaClient` stays structurally assignable, so a caller legitimately
 *     holding a wider client — or the test's faithful fake — can still pass one.
 *     What none of them can do is pass NOTHING.
 *
 * WHAT CHANGES UNDER fm_app, AND IT IS A STRENGTHENING. `spaceId` arrives from
 * `getSpaceContext()`, i.e. ultimately from the active-Space cookie, and nothing
 * in this function ever re-proved membership of it — Step 1 filtered on the
 * `spaceId` it was handed and nothing else. `SpaceAccountLink.fm_app_sel` is
 * `spaceId IN (SELECT fm_visible_space_ids())`, so on a tenant client a cookie
 * naming a Space the caller does not belong to now yields NO LINK and the 404
 * comes from the policy rather than from a resolver two modules away.
 */

import { NextResponse } from "next/server";
import { ShareStatus, SpaceMemberRole, SpaceMemberStatus } from "@prisma/client";
import { grantsTransactionDetail } from "@/lib/ai/visibility";
import type { ReadClient } from "@/lib/db/tenant-context";

export type ImportAccountAccess =
  | { ok: true; financialAccountId: string }
  | { ok: false; response: NextResponse };

export async function resolveImportableFinancialAccount(
  // RLS-ACC-S2 — REQUIRED AND LEADING. No default, ever: see the module header
  // on the six call sites an optional one hid, including a route whose own test
  // asserted it held no `db` and was right about its own source.
  client: ReadClient,
  userId: string,
  spaceId: string,
  id: string,
): Promise<ImportAccountAccess> {
  // ── Step 1: Visibility check ─────────────────────────────────────────────
  // Confirms the account is linked to this Space via an ACTIVE, non-deleted
  // link. 404 if the account doesn't exist / is soft-deleted (deletedAt filter
  // fails closed — a deleted account is never importable).
  const link = await client.spaceAccountLink.findFirst({
    where:  { spaceId, financialAccountId: id, status: ShareStatus.ACTIVE, financialAccount: { deletedAt: null } },
    select: { id: true, visibilityLevel: true },
  });

  if (!link) {
    return { ok: false, response: NextResponse.json({ error: "Not found" }, { status: 404 }) };
  }

  // ── Step 2: Write-authority check (D2 Slice B) ───────────────────────────
  // Check ownership first. For USER-owned accounts ownerUserId is the owner;
  // for SPACE-owned accounts ownerUserId is null and createdByUserId (D11)
  // records the human who connected it — both convey write authority. An
  // owner/creator has inherent full authority over their own account and is not
  // gated on the Space-link tier (the tier is only how THEY chose to expose the
  // account to OTHER members; their own imports go through the account's FULL
  // HOME link normally).
  const fa = await client.financialAccount.findUnique({
    where:  { id },
    select: { ownerUserId: true, createdByUserId: true },
  });

  if (fa?.ownerUserId === userId || fa?.createdByUserId === userId) {
    return { ok: true, financialAccountId: id };
  }

  // ── Step 2b: Visibility-tier gate for the non-owner path (P1-3) ──────────
  // Transaction import is a detail-mutating / detail-probing operation: it
  // writes and fingerprint-matches against the account's transaction rows. A
  // member who can only see this account at BALANCE_ONLY / SUMMARY_ONLY must
  // NOT be able to import into (or probe, via preview) an account whose detail
  // they cannot even inspect — mirrors the investment-import FULL gate
  // (app/api/investments/opening-position). Reuses the canonical
  // grantsTransactionDetail predicate so import can never disagree with the
  // read layer about who sees an account's detail. Fails closed for every
  // non-FULL tier; REVOKED/deleted links never reach here (Step 1 filters).
  if (!grantsTransactionDetail(link.visibilityLevel)) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "Full account visibility is required to import into this account." },
        { status: 403 }
      ),
    };
  }

  // Not the account's owner/creator — check whether the caller holds a
  // write-capable role (OWNER or ADMIN) in this Space. MEMBER is read-only.
  const membership = await client.spaceMember.findUnique({
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
