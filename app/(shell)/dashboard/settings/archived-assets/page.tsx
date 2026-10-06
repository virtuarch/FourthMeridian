import { getServerSession } from "next-auth";
import { authOptions }      from "@/lib/auth";
import { withTenantDb }     from "@/lib/db/tenant-context";
import { redirectToLogin }  from "@/lib/auth/login-redirect";
import {
  ArchiveBinClient,
  type ArchivedAsset,
  type ArchivedSpace,
  type TrashedSpace,
} from "@/components/dashboard/ArchivedAssetsClient";

// Derive a display source from the fields that already distinguish how a
// FinancialAccount was created — no schema change needed. Self-custody
// wallets always have walletAddress set (see app/api/accounts/wallet/route.ts);
// manual assets are syncStatus="manual" (see app/api/accounts/manual/route.ts);
// everything else came in through Plaid (syncStatus="synced"/"pending"/"error").
function deriveSource(a: { syncStatus: string | null; walletAddress: string | null }): ArchivedAsset["source"] {
  if (a.walletAddress) return "wallet";
  if (a.syncStatus === "manual") return "manual";
  return "plaid";
}

export default async function ArchivedAssetsPage() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return redirectToLogin();

  const userId = session.user.id;

  // ── RLS-T3 — THE ARCHIVE BIN IS ONE ANSWER, SO IT IS ONE TRANSACTION ───────
  //
  // All three reads execute as the viewer, with the identity taken from
  // getServerSession above and nothing else. They share one short transaction
  // because the three tabs are one coherent answer about one person's archive,
  // and because none of them calls out of the process — the loadSpaceAccounts
  // precedent from RLS-B4, not the mount fan-out one. Prisma puts an interactive
  // transaction's statements on a single connection, so the `Promise.all` below
  // no longer overlaps them; three indexed reads is not a fan-out worth a
  // connection each.
  //
  // ── SOFT-DELETED ROWS ARE POLICIED NORMALLY, AND THAT IS THE POINT ─────────
  // No fm_app policy mentions `deletedAt`, so a soft-deleted FinancialAccount is
  // exactly as visible to its owner as a live one. The account list is served by
  // the `"ownerUserId" = current_fm_user_id()` arm of
  // `FinancialAccount.fm_app_sel` (§14, added so a just-created account is
  // visible to its creator before any link exists) — which is also why this page
  // CANNOT reach the known no-ACTIVE-link coverage gap: that gap is that the
  // account-SUBTREE tables (AccountConnection, Transaction, DebtProfile) have no
  // ownerUserId arm, and this page reads none of them.
  //
  // ⚠️ ONE DEGRADATION, AND IT IS A CHIP NOT A 404. `spaceAccountLinks` is read
  // through `SpaceAccountLink.fm_app_sel` = `spaceId IN
  // fm_visible_space_ids()`, which has no ownerUserId arm either. A link is
  // therefore visible whatever its STATUS (the policy never mentions status, so
  // the REVOKED links a deletion leaves behind still come back) but only while
  // the owner is an ACTIVE member of the Space it points at. An archived asset
  // that was once shared into a Space the owner has since LEFT loses that
  // Space's chip. The relation is to-MANY, so it degrades to `[]` rather than
  // raising, and the nested `space` is safe despite being REQUIRED: a link is
  // only visible when its spaceId is in `fm_visible_space_ids()`, which is
  // exactly the predicate `Space.fm_app_sel`'s membership arm tests.
  const [accounts, archivedMemberships, trashedMemberships] = await withTenantDb(userId, (tx) => Promise.all([
    // All of the current user's soft-deleted accounts — Plaid, manual, and
    // wallet alike — not just manual assets. Restore/delete actions in
    // ArchiveBinClient branch per-row based on `source`.
    tx.financialAccount.findMany({
      where: {
        ownerUserId: userId,
        deletedAt:   { not: null },
      },
      select: {
        id:            true,
        name:          true,
        balance:       true,
        currency:      true,
        deletedAt:     true,
        type:          true,
        syncStatus:    true,
        walletAddress: true,
        institution:   true,
        // D3 Step 4E read cutover — replaces the prior workspaceShares
        // (WorkspaceAccountShare) include. SpaceAccountLink is kept in sync
        // with it by the D3 Step 3 dual-write
        // (lib/accounts/space-account-link.ts), so this read returns the
        // same set of spaces either way. No status filter, matching the
        // prior workspaceShares behavior (active and revoked links both
        // surface here). Response shape (spaces: {id, name}[]) is unchanged
        // — see docs/initiatives/d3/D3_LEGACY_RETIREMENT_AUDIT.md.
        spaceAccountLinks: {
          select: {
            space: { select: { id: true, name: true } },
          },
        },
      },
      orderBy: { deletedAt: "desc" },
    }),

    // Archived (not yet trashed) spaces the user is still an active
    // member of. Shown to any member; restore/trash actions are gated to
    // OWNER in the client.
    //
    // Both membership reads are served by the `"userId" =
    // current_fm_user_id()` arm of `SpaceMember.fm_app_sel` (§12), and the
    // REQUIRED `space` relation resolves because `fm_visible_space_ids()` keys
    // on membership and ACTIVE status ONLY — it never filters on archivedAt or
    // deletedAt, so an archived or trashed Space stays visible to the member
    // whose archive bin is listing it. That is the whole page.
    tx.spaceMember.findMany({
      where: { userId, status: "ACTIVE", space: { archivedAt: { not: null }, deletedAt: null } },
      select: {
        role:      true,
        space: { select: { id: true, name: true, type: true, category: true, archivedAt: true } },
      },
      orderBy: { space: { archivedAt: "desc" } },
    }),

    // Trashed spaces the user is still an active member of.
    tx.spaceMember.findMany({
      where: { userId, status: "ACTIVE", space: { deletedAt: { not: null } } },
      select: {
        role:      true,
        space: { select: { id: true, name: true, type: true, category: true, deletedAt: true } },
      },
      orderBy: { space: { deletedAt: "desc" } },
    }),
  ]));

  const assets: ArchivedAsset[] = accounts.map((a) => ({
    id:          a.id,
    name:        a.name,
    balance:     a.balance,
    currency:    a.currency,
    deletedAt:   a.deletedAt!.toISOString(),
    institution: a.institution,
    source:      deriveSource(a),
    spaces: a.spaceAccountLinks.map((l) => ({
      id:   l.space.id,
      name: l.space.name,
    })),
  }));

  const archivedSpaces: ArchivedSpace[] = archivedMemberships.map((m) => ({
    id:         m.space.id,
    name:       m.space.name,
    type:       m.space.type,
    category:   m.space.category,
    archivedAt: m.space.archivedAt!.toISOString(),
    myRole:     m.role,
  }));

  const trashedSpaces: TrashedSpace[] = trashedMemberships.map((m) => ({
    id:        m.space.id,
    name:      m.space.name,
    type:      m.space.type,
    category:  m.space.category,
    deletedAt: m.space.deletedAt!.toISOString(),
    myRole:    m.role,
  }));

  return (
    <ArchiveBinClient
      assets={assets}
      archivedSpaces={archivedSpaces}
      trashedSpaces={trashedSpaces}
    />
  );
}
