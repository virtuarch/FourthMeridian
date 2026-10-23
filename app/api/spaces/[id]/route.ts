/**
 * GET    /api/spaces/[id]  — get space details (must be a member, or public)
 * PATCH  /api/spaces/[id]  — update name/description/isPublic/category
 *                                (OWNER/ADMIN only), or archive/unarchive via
 *                                `archivedAt` (OWNER only — see below)
 * DELETE /api/spaces/[id]  — move space to trash (soft-delete, sets
 *                                deletedAt). OWNER only, SHARED only. This no
 *                                longer performs a real delete — see
 *                                app/api/spaces/[id]/permanent/route.ts
 *                                for the only endpoint that does.
 *
 * Lifecycle: active -> archived (this PATCH) -> trashed (this DELETE) ->
 * restored (app/api/spaces/[id]/restore/route.ts) or permanently deleted
 * (app/api/spaces/[id]/permanent/route.ts). Archiving and trashing never
 * touch WorkspaceAccountShare or SpaceSnapshot rows — those are only
 * affected by permanent delete.
 *
 * ── RLS SLICE B — PATCH AND DELETE ENTER THE BOUNDARY; GET CANNOT ────────────
 * PATCH and DELETE are gated by requireSpaceRole, so the caller is an ACTIVE
 * member before a row is touched and every statement is expressible as fm_app.
 *
 * ⚠️ THE GET IS A NAMED EXCEPTION, AND IT IS THE PUBLIC-SPACE READ THAT MAKES IT
 * ONE. fm_app's `Space` SELECT policy is membership-or-platform-grant; it has no
 * `isPublic` arm and cannot be given one from here. Running this handler's fetch
 * as the tenant would return NOTHING for a PUBLIC Space the caller is not a
 * member of, which is property 2 of the three documented below — so a 200 with a
 * public Space's roster would silently become a 404. That is not a tenancy leak
 * being closed, it is a product read being broken, so the fetch stays on the
 * deployment-wide client and says so here. Closing it properly needs an
 * `OR "isPublic"` arm on that policy (a migration, and an owner decision about
 * whether an unauthenticated-adjacent read belongs in the tenant role at all).
 */

import { NextRequest, NextResponse } from "next/server";
import { requireUser, requireSpaceRole } from "@/lib/session";
import { SpaceMemberRole } from "@prisma/client";
import { db } from "@/lib/db";
import { withTenantDb } from "@/lib/db/tenant-context";
import { withApiHandler, getClientIp } from "@/lib/api";
import { AuditAction } from "@/lib/audit-actions";
import { parseReportingCurrencyInput } from "@/lib/spaces/reporting-currency";
import { rosterForViewer } from "@/lib/spaces/roster-visibility";
import { SUPPORTED_SPACE_CATEGORIES } from "@/lib/space-presets";

export const GET = withApiHandler(async (
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) => {
  const { id } = await params;
  const [user, err] = await requireUser();
  if (err) return err;

  // ⚠️ DELIBERATELY NOT withTenantDb — see the public-space note in the file
  // header. As fm_app this returns nothing for a PUBLIC Space the caller is not
  // a member of, and the 403/404/myRole shape below depends on getting the row.
  const space = await db.space.findUnique({
    where: { id },
    include: {
      members: {
        where: { status: "ACTIVE" },
        // RLS Slice 2 — `email` is NOT selected. rosterForViewer already strips
        // it on the public-read path, so it was only ever delivered to ACTIVE
        // members, where its single consumer was a last-resort display fallback
        // in memberDisplayName (after name, after @username). That is not worth
        // loading every member's email address into process memory BEFORE the
        // membership check below — §17.1 item 4 names this route's pre-auth
        // fetch as the starkest of the fourteen. Not selecting it is the fix;
        // stripping it afterwards never was. See lib/spaces/roster-visibility.ts.
        include: { user: { select: { id: true, name: true, username: true } } },
        orderBy: { joinedAt: "asc" },
      },
    },
  });

  if (!space) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // ── SP-2b Batch 3 — DOCUMENTED public-read exception (intentionally inline) ──
  // This GET door is NOT a role/lifecycle gate, so it deliberately does NOT use
  // requireSpaceAction. It is a read-VISIBILITY gate with three properties that
  // requireSpaceAction cannot model, and must be preserved here:
  //   1. Existence first — a missing Space returns 404 (above) BEFORE any auth
  //      check; requireSpaceAction never emits 404 (it would 403 a missing
  //      Space, collapsing the 404/403 distinction).
  //   2. Public OR member — a PUBLIC Space is readable by anyone authenticated,
  //      including non-members; requireSpaceAction 403s every non-member and has
  //      no `isPublic` awareness, so it would break public-Space reads.
  //   3. myRole derivation — the response carries the caller's role (or null for
  //      a public non-member); requireSpaceAction returns no row for a public
  //      non-member (it 403s first).
  // See docs/initiatives/sp2/SP-2B_BATCH3_INVESTIGATION.md. Do NOT swap this for
  // requireSpaceAction("space:read").
  //
  // RLS slice B — this one IS tenant-expressible and is converted: fm_app's
  // `SpaceMember` SELECT policy carries a `userId = current_fm_user_id()` arm, so
  // the caller's own row — ACTIVE, LEFT or REMOVED alike — is visible, which is
  // exactly what the status check below needs.
  const membership = await withTenantDb(user.id, (tx) => tx.spaceMember.findUnique({
    where: { spaceId_userId: { spaceId: id, userId: user.id } },
  }));
  const isActiveMember = membership?.status === "ACTIVE";
  if (!space.isPublic && !isActiveMember) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // W1-D3 — roster privacy on the public-read path. A non-member reading a
  // PUBLIC Space must not receive member emails (or any SpaceMember scalar
  // beyond the intentionally-public shape the /dashboard/spaces page already
  // serves). Members' own view passes through untouched. See
  // lib/spaces/roster-visibility.ts for the allowlist rationale.
  return NextResponse.json({
    ...space,
    members: rosterForViewer(space.members, isActiveMember),
    myRole:  isActiveMember ? membership!.role : null,
  });
}, "GET /api/spaces/[id]");

export const PATCH = withApiHandler(async (
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) => {
  const { id } = await params;
  // Base gate: ADMIN+ for ordinary field edits. Archiving/unarchiving is
  // additionally restricted to OWNER below — ADMINs cannot archive a
  // space they don't own.
  const [patchAuth, patchErr] = await requireSpaceRole(id, SpaceMemberRole.ADMIN);
  if (patchErr) return patchErr;
  const { user, membership } = patchAuth;

  const body = await req.json();
  const { name, description, isPublic, category, archivedAt, reportingCurrency } = body as {
    name?:              string;
    description?:       string;
    isPublic?:          boolean;
    category?:          string;
    archivedAt?:        string | null; // ISO string to archive, null to unarchive
    // MC1 Phase 3 Slice 1 — authoritative Space reporting currency. API-only
    // field (the selector UI is Phase 4); allowlist-validated below; changes
    // are FORWARD-ONLY by architecture (read-time conversion — nothing stored
    // is rewritten). Nothing reads the value until the flip slices.
    reportingCurrency?: string;
  };

  // MC1 Phase 3 Slice 1 — validate against FX_BASE + SUPPORTED_QUOTES before
  // any write; invalid input is a 400, never a silent default.
  let resolvedReportingCurrency: string | undefined;
  if (reportingCurrency !== undefined) {
    const parsed = parseReportingCurrencyInput(reportingCurrency);
    if (!parsed.ok) {
      return NextResponse.json({ error: parsed.error }, { status: 400 });
    }
    resolvedReportingCurrency = parsed.value;
  }

  // RLS slice B — requireSpaceRole has already established an ACTIVE ADMIN
  // membership, so the Space is visible to fm_app and this read is its own short
  // transaction (the validation below sits between it and the write).
  //
  // ⚠️ THE 404 IS NOW REDUNDANT RATHER THAN LOAD-BEARING. It is kept: a Space
  // that genuinely does not exist still returns null, and under the policy a
  // foreign one would too — which is the same answer, reached one layer earlier.
  const existing = await withTenantDb(user.id, (tx) => tx.space.findUnique({ where: { id } }));
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // ── Category allowlist (REVIEW-3, slice F) ─────────────────────────────
  // This route used to write `category: category as never` with NO
  // validation while Manage → General offered all 13 categories — the ONLY
  // path by which a retired category (TRIP, DEBT_PAYOFF, …) could re-enter
  // production, and the only path that reached the deleted Overview canvas.
  // Category writes are now validated against the currently-supported set
  // (creatable + existing-in-prod: PERSONAL, FAMILY, CUSTOM, OTHER;
  // HOUSEHOLD deliberately excluded — hidden template, merged into Family,
  // zero production rows). A no-op re-send of the Space's CURRENT category
  // stays accepted so legacy-category Spaces can still save other fields.
  if (
    category !== undefined &&
    category !== existing.category &&
    !(SUPPORTED_SPACE_CATEGORIES as string[]).includes(category)
  ) {
    return NextResponse.json({ error: "Unsupported category" }, { status: 400 });
  }

  // ── Archive / unarchive ────────────────────────────────────────────────
  if (archivedAt !== undefined) {
    if (membership.role !== SpaceMemberRole.OWNER) {
      return NextResponse.json(
        { error: "Only the Space owner can archive or unarchive this Space" },
        { status: 403 }
      );
    }
    if (existing.type === "PERSONAL") {
      return NextResponse.json({ error: "Cannot archive your Personal Space" }, { status: 400 });
    }
    if (existing.deletedAt) {
      return NextResponse.json(
        { error: "Space is in trash — restore it before archiving" },
        { status: 400 }
      );
    }
  }

  // RLS slice B — the edit and its audit row are adjacent with no intervening
  // work, so they share ONE transaction, which is also the one that carries the
  // identity. They were two independent statements before; nothing that was
  // atomic has been split, and a failed audit write can no longer leave an
  // unrecorded Space edit behind.
  const space = await withTenantDb(user.id, async (tx) => {
    const updated = await tx.space.update({
      where: { id },
      data: {
        ...(name        !== undefined && { name: name.trim() }),
        ...(description !== undefined && { description: description?.trim() || null }),
        ...(isPublic    !== undefined && { isPublic }),
        ...(category    !== undefined && { category: category as never }),
        ...(archivedAt  !== undefined && { archivedAt: archivedAt ? new Date(archivedAt) : null }),
        ...(resolvedReportingCurrency !== undefined && { reportingCurrency: resolvedReportingCurrency }),
      },
    });

    await tx.auditLog.create({
      data: {
        userId:      user.id,
        spaceId: id,
        action:      archivedAt !== undefined
          ? (archivedAt ? AuditAction.SPACE_ARCHIVED : AuditAction.SPACE_UNARCHIVED)
          : AuditAction.SPACE_UPDATE,
        metadata:    {
          name: updated.name, isPublic: updated.isPublic, category,
          // MC1 Phase 4 Slice 2 (plan D-4) — record currency changes with
          // from/to; omitted entirely when the field wasn't part of this PATCH.
          ...(resolvedReportingCurrency !== undefined && resolvedReportingCurrency !== existing.reportingCurrency
            ? { reportingCurrency: { from: existing.reportingCurrency, to: resolvedReportingCurrency } }
            : {}),
        },
        ipAddress:   getClientIp(req),
      },
    });

    return updated;
  });

  return NextResponse.json(space);
}, "PATCH /api/spaces/[id]");

export const DELETE = withApiHandler(async (
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) => {
  const { id } = await params;

  // requireSpaceRole enforces both ACTIVE status and OWNER role —
  // a LEFT or REMOVED owner cannot delete.
  const [auth, err] = await requireSpaceRole(id, SpaceMemberRole.OWNER);
  if (err) return err;
  const { user } = auth;

  // RLS slice B — an ACTIVE OWNER's own Space, read as that owner.
  const space = await withTenantDb(user.id, (tx) => tx.space.findUnique({ where: { id } }));
  if (!space) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (space.type === "PERSONAL") {
    return NextResponse.json({ error: "Cannot delete your Personal Space" }, { status: 400 });
  }
  if (space.deletedAt) {
    return NextResponse.json({ error: "Space is already in trash" }, { status: 400 });
  }

  // Soft-delete only: move to trash. Does NOT cascade-delete members,
  // shares, snapshots, goals, or anything else — those rows are untouched
  // until (and unless) the space is permanently deleted from the trash
  // via app/api/spaces/[id]/permanent/route.ts. Clears archivedAt so a
  // space is never simultaneously "archived" and "trashed".
  //
  // RLS slice B — the trash flip and its audit row share ONE transaction (the
  // one that carries the identity). Two independent statements before; nothing
  // atomic was split. ⚠️ This is an UPDATE, not a DELETE: fm_app has an UPDATE
  // policy on `Space` and no DELETE policy at all, which is exactly why the real
  // delete lives in permanent/route.ts and is called out there.
  await withTenantDb(user.id, async (tx) => {
    await tx.space.update({
      where: { id },
      data:  { deletedAt: new Date(), archivedAt: null },
    });

    await tx.auditLog.create({
      data: {
        userId:    user.id,
        spaceId: id,
        action:    AuditAction.SPACE_TRASHED,
        metadata:  { name: space.name },
        ipAddress: getClientIp(req),
      },
    });
  });

  return NextResponse.json({ ok: true });
}, "DELETE /api/spaces/[id]");
