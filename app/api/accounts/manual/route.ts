/**
 * POST /api/accounts/manual
 *
 * Creates a manually-entered asset account (property, vehicle, equipment, etc.).
 * Unlike Plaid accounts, balance is user-supplied and never synced automatically.
 *
 * Creates:
 *   FinancialAccount     — type=other, syncStatus='manual', balance=user-provided
 *   AccountConnection    — manual connection row (no PlaidItem, no walletAddress)
 *   SpaceAccountLink      — always shares into the user's PERSONAL space
 *                           + any additional space IDs passed in `spaceIds`
 *
 * Body: {
 *   name:          string             // display name, e.g. "Austin Home"
 *   balance:       number             // current estimated value
 *   currency?:     string             // ISO 4217, default "USD"
 *   assetKind?:    string             // "real_estate" | "vehicle" | "equipment" | "other"
 *   purchasePrice?: number            // for gain/loss in asset widgets
 *   purchaseDate?:  string            // ISO date string, e.g. "2020-04-15"
 *   notes?:         string            // free-text display note
 *   spaceIds?:  string[]          // additional (non-personal) spaces to share into
 * }
 *
 * Returns: { accountId: string }
 *
 * ── RLS-ACC-S3 — THE WRITE ORDER WAS ONE RLS FORBIDS ─────────────────────────
 * This route created the `AccountConnection` BEFORE the `SpaceAccountLink`, and
 * under `fm_app` that order cannot work. The two policies are asymmetric by
 * design (migration §14 vs §15):
 *
 *   FinancialAccount.fm_app_ins   WITH CHECK ("ownerUserId" = current_fm_user_id())
 *   AccountConnection.fm_app_ins  WITH CHECK (fm_account_visible("financialAccountId"))
 *
 * `fm_account_visible` is true only while an ACTIVE `SpaceAccountLink` exists in
 * a Space this identity belongs to. A brand-new account has NO link yet, so the
 * connection insert is refused with SQLSTATE 42501 — and an INSERT refusal
 * RAISES, so the whole `$transaction` rolls back and the manual asset is simply
 * never created. The pivot has an `ownerUserId` arm for exactly the "visible to
 * its creator before any link exists" case; its subtree does not.
 *
 * So the order is INVERTED: FinancialAccount, then the Space links, then the
 * connection. Measured as succeeding in that order against a real `fm_app` role.
 * This is the FOURTH instance of this phenomenon in the codebase — RLS-C-S7
 * (b42e8e0) recorded two opposite orderings for disconnect and restore, and
 * RLS-ACC-S4 inverts the shared `persistAccountSpine` writer for the same
 * reason. The loop stays SEQUENTIAL inside the transaction, because
 * `computeLinkKind` counts existing links to decide HOME vs SHARED and a
 * concurrent loop could assign HOME twice (KD-5); inverting the order does not
 * disturb that, and the first target is still `personalSpaceId`, so it is still
 * the one that becomes HOME.
 */

import { NextRequest, NextResponse }        from "next/server";
import { withTenantDb }                     from "@/lib/db/tenant-context";
import { getSpaceContext }              from "@/lib/space";
import { AccountType, AccountOwnerType, ShareStatus, VisibilityLevel, SpaceMemberStatus, SpaceMemberRole } from "@prisma/client";
import { requireUser }                      from "@/lib/session";
import { isSupportedCurrency }              from "@/lib/fx/config";
import { withApiHandler }                   from "@/lib/api";
import { dualWriteSpaceAccountLink }        from "@/lib/accounts/space-account-link";
import { regenerateSnapshotsForAccounts }   from "@/lib/snapshots/regenerate";

export const POST = withApiHandler(async (req: NextRequest) => {
  const [user, err] = await requireUser();
  if (err) return err;
  const userId = user.id;

  const body = await req.json() as {
    name?:          string;
    balance?:       number;
    currency?:      string;
    assetKind?:     string;
    purchasePrice?: number;
    purchaseDate?:  string;
    notes?:         string;
    spaceIds?:  string[];
  };

  const {
    name,
    balance,
    currency     = "USD",
    assetKind    = "other",
    purchasePrice,
    purchaseDate,
    notes,
    spaceIds = [],
  } = body;

  // ── Validation ─────────────────────────────────────────────────────────────
  if (!name?.trim())           return NextResponse.json({ error: "Asset name is required."   }, { status: 400 });
  if (balance === undefined || balance === null)
                               return NextResponse.json({ error: "Current value is required." }, { status: 400 });
  if (typeof balance !== "number" || isNaN(balance) || balance < 0)
                               return NextResponse.json({ error: "Value must be a non-negative number." }, { status: 400 });

  const VALID_KINDS = ["real_estate", "vehicle", "equipment", "other"];
  if (!VALID_KINDS.includes(assetKind))
                               return NextResponse.json({ error: `Invalid assetKind. Use: ${VALID_KINDS.join(", ")}` }, { status: 400 });

  // REVIEW-3 B-5 — the currency goes through the SAME allowlist rule the
  // reporting-currency boundary enforces (lib/spaces/reporting-currency.ts →
  // isSupportedCurrency: FX_BASE + SUPPORTED_QUOTES). This route used to
  // uppercase ARBITRARY input and store it: an unsupported-but-real code was
  // permanently FX-unavailable (excluded from every converted total forever),
  // and a malformed code ("US", "DOLLARS") throws RangeError inside the Intl
  // formatters at render. Rejecting at the boundary is the same 400 contract
  // the Space PATCH route applies.
  if (typeof currency !== "string" || currency.trim() === "")
                               return NextResponse.json({ error: "currency must be a non-empty string." }, { status: 400 });
  const normalizedCurrency = currency.trim().toUpperCase();
  if (!isSupportedCurrency(normalizedCurrency))
                               return NextResponse.json({ error: `Unsupported currency "${normalizedCurrency}" — must be USD or one of the supported quote currencies.` }, { status: 400 });

  // ── Get user's personal space ──────────────────────────────────────────
  // ONE short tenant read phase for both membership questions. `SpaceMember`'s
  // policy is `spaceId IN (SELECT fm_visible_space_ids()) OR "userId" =
  // current_fm_user_id()`, so the caller's OWN membership rows are exactly what
  // is visible — which is all either question asks about. The `userId:` filters
  // are kept: they now SELECT rather than ISOLATE, and the `role`/`status`
  // narrowings are still the route's own rule, not the policy's.
  const ctx = await getSpaceContext();
  const resolved = await withTenantDb(userId, async (tx) => {
    const personalSpaceId = ctx.space.type === "PERSONAL"
      ? ctx.spaceId
      : (await tx.spaceMember.findFirst({
          // role: OWNER — defense in depth (PERSONAL Spaces are single-owner by
          // construction now); never resolve to a stranger's personal Space.
          where: { userId, status: SpaceMemberStatus.ACTIVE, role: SpaceMemberRole.OWNER, space: { type: "PERSONAL" } },
          select: { spaceId: true },
        }))?.spaceId;

    if (!personalSpaceId) return { kind: "noPersonalSpace" as const };

    // ── Validate additional space IDs (must be member of each) ────────────
    const additionalIds = [...new Set(spaceIds.filter((id) => id !== personalSpaceId))];
    if (additionalIds.length > 0) {
      const memberships = await tx.spaceMember.findMany({
        where: {
          userId,
          status:      SpaceMemberStatus.ACTIVE,
          spaceId: { in: additionalIds },
        },
        select: { spaceId: true },
      });
      const validIds = new Set(memberships.map((m) => m.spaceId));
      const invalid  = additionalIds.filter((id) => !validIds.has(id));
      if (invalid.length > 0) return { kind: "notAMember" as const };
    }
    return { kind: "ok" as const, personalSpaceId, additionalIds };
  });

  if (resolved.kind === "noPersonalSpace") {
    return NextResponse.json({ error: "Personal Space not found." }, { status: 500 });
  }
  if (resolved.kind === "notAMember") {
    return NextResponse.json({ error: "Not a member of one or more requested Spaces." }, { status: 403 });
  }
  const { personalSpaceId, additionalIds } = resolved;

  // ── D3 Stage B3 — SpaceAccountLink is the sole write target ─────────────
  // Sequential, NOT Promise.all: computeLinkKind() inside
  // dualWriteSpaceAccountLink() decides HOME vs SHARED by counting existing
  // links. Run concurrently, every call could read count === 0 before any
  // commit, assigning HOME to more than one target. Awaiting each write
  // serially removes the race: shareTargets[0] (always personalSpaceId)
  // becomes HOME; subsequent targets see the prior row and become SHARED. See
  // docs/initiatives/d3/D3_STEP4C_REGRESSION_ROOT_CAUSE.md ("Secondary finding") and
  // docs/initiatives/d3/D3_LEGACY_RETIREMENT_AUDIT.md. The KD-5 ordering guard
  // above is preserved: the loop stays sequential inside the transaction.
  const shareTargets = [personalSpaceId, ...additionalIds];

  // ── KD-4 Phase 3 — FinancialAccount + AccountConnection + SAL links commit
  //    atomically. A partial failure previously could leave an account with no
  //    links (invisible/orphaned) or shared into some spaces but not others.
  //
  //    RLS-ACC-S3 — and the transaction is now a TENANT one, which is also what
  //    forced the write order below. See the header.
  const fa = await withTenantDb(userId, async (tx) => {
    const created = await tx.financialAccount.create({
      data: {
        ownerType:   AccountOwnerType.USER,
        ownerUserId: userId,
        createdByUserId: userId, // D11 — human-accountable creator
        name:        name.trim(),
        type:        AccountType.other,
        institution: "Manual Entry",
        balance,
        currency:    normalizedCurrency,
        syncStatus:  "manual",
        lastUpdated: new Date(),
      },
    });

    // THE SPACE LINKS COME FIRST, AND THAT IS NOT A PREFERENCE.
    // `AccountConnection.fm_app_ins` is `WITH CHECK (fm_account_visible(...))`,
    // which is false until an ACTIVE link exists in a Space this identity
    // belongs to. Written the other way round — as this route did — the
    // connection insert is refused 42501 and the whole asset creation rolls
    // back. See the module header.
    for (const wsId of shareTargets) {
      await dualWriteSpaceAccountLink(tx, {
        spaceId:            wsId,
        financialAccountId: created.id,
        creatorUserId:       userId,
        create: {
          addedByUserId:    userId,
          visibilityLevel:  VisibilityLevel.FULL,
          status:           ShareStatus.ACTIVE,
        },
        update: {
          status:           ShareStatus.ACTIVE,
          visibilityLevel:  VisibilityLevel.FULL,
          revokedAt:        null,
          revokedByUserId:  null,
        },
      });
    }

    // AccountConnection (no PlaidItem, no walletAddress) — LAST, because its
    // WITH CHECK needs the links above to exist first.
    await tx.accountConnection.create({
      data: {
        financialAccountId: created.id,
        connectedByUserId:  userId,
        syncStatus:         "manual",
        isCanonical:        true,
      },
    });

    return created;
  });

  // Regenerate SpaceSnapshot for every space this asset was just shared into
  // — same best-effort/non-fatal pattern as the existing archive/restore/
  // share/revoke snapshot fixes (see docs/bugfixes/BUGFIX_ARCHIVED_ACCOUNT_SNAPSHOT_STALENESS.md).
  try {
    await regenerateSnapshotsForAccounts([fa.id]);
  } catch (snapshotErr) {
    console.warn(`[POST /api/accounts/manual] snapshot regen failed for account ${fa.id} (non-fatal):`, snapshotErr);
  }

  // ── Audit log ─────────────────────────────────────────────────────────────
  // Its own short phase, AFTER the snapshot regeneration, exactly where it was.
  // `AuditLog.fm_app_ins` is `WITH CHECK (true)` (migration §18 — 90 independent
  // writers and a shared shape helper with no spaceId parameter), so the tenant
  // role can write it; it is deliberately NOT folded into the create transaction,
  // because that would make an audit failure roll back the asset.
  await withTenantDb(userId, (tx) => tx.auditLog.create({
    data: {
      userId,
      spaceId: personalSpaceId,
      action:      "MANUAL_ASSET_ADD",
      metadata: {
        name:           fa.name,
        balance,
        currency:       fa.currency,
        assetKind,
        purchasePrice,
        purchaseDate,
        sharedSpaces: shareTargets,
      },
    },
  }));

  return NextResponse.json({
    accountId:    fa.id,
    name:         fa.name,
    balance:      fa.balance,
    currency:     fa.currency,
    assetKind,
    purchasePrice,
    purchaseDate,
    notes,
  }, { status: 201 });
}, "POST /api/accounts/manual");
