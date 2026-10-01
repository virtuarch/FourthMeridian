/**
 * GET  /api/spaces  — list spaces the user belongs to + all public spaces
 * POST /api/spaces  — create a new SHARED space (user becomes OWNER)
 *                         Accepts optional `templateId` (SP-1 registry; must
 *                         be a live template — category derives from it) or
 *                         legacy `category` (SpaceCategory), and generates
 *                         default SpaceDashboardSection rows.
 *
 * ── RLS SLICE B — BOTH HANDLERS RUN AS THEIR USER ────────────────────────────
 * Nothing here needs an authority wider than the caller. The GET's three reads
 * are each already keyed on the caller (`SpaceMember.userId`,
 * `PlatformGrant.userId`, and the platform Spaces those grants name), and the
 * policies say the same thing — `SpaceMember.fm_app_sel` is
 * `spaceId IN fm_visible_space_ids() OR userId = me`, and `Space.fm_app_sel`
 * carries the PlatformGrant arm precisely so a platform Space is reachable
 * without a membership row. The application predicates stay exactly as they
 * were; the database now agrees with them instead of trusting them.
 */

import { NextRequest, NextResponse } from "next/server";
import { withTenantDb } from "@/lib/db/tenant-context";
import { Prisma } from "@prisma/client";
// SpaceCategory imported from space-presets so this file compiles
// before `prisma generate` has been re-run with the new schema values.
// The string values are identical to what Prisma generates.
import { requireUser } from "@/lib/session";
import { SpaceCategory, SUPPORTED_SPACE_CATEGORIES } from "@/lib/space-presets";
// SP-2.1 — the SP-1 template registry/planner is this route's sole
// materialization source (same pattern as the register route, SP-2A-3).
import { getTemplate, getTemplateForCategory } from "@/lib/space-templates/registry";
import { planTemplateApplication } from "@/lib/space-templates/apply";
import type { SpaceTemplate } from "@/lib/space-templates/types";
import { withApiHandler, getClientIp } from "@/lib/api";
import { AuditAction } from "@/lib/audit-actions";
import { reportingCurrencyForNewSpace } from "@/lib/spaces/reporting-currency";

export const preferredRegion = "sin1";
export const runtime = "nodejs";

// GET is consumed by two call sites only (Sidebar's space switcher and
// AddManualAssetModal's share-target picker) — both read only
// `data.mine[].{id,name,type,myRole}`. It previously also queried public
// spaces and pending invites and returned full nested member rows, none
// of which either caller used; that's the real "duplicate work" between this
// endpoint and the already-optimized /dashboard/spaces Server Component,
// which is the one place that DOES need the public/invites/members data.
// Trimmed to exactly what's read, which also drops 2 of the original 3
// sequential (non-parallel) Prisma round trips entirely.
export const GET = withApiHandler(async () => {
  const t0 = Date.now();
  const [user, err] = await requireUser();
  if (err) return err;
  console.log(`[api/spaces] requireUser: ${Date.now() - t0}ms`);

  const t1 = Date.now();
  // RLS slice B — ONE short transaction for the whole list read. The three
  // queries are a single coherent operation (the platform read is a function of
  // the grants), there is no non-database work between them, and nothing here
  // calls out of the process.
  const { myMemberships, grants, platformSpaces } = await withTenantDb(user.id, async (tx) => {
    // `mine` (membership-driven) and `platform` (access-derived) are independent —
    // run them together. Platform Spaces have NO SpaceMember rows by design, so
    // they can never appear in `mine`; the two lists never overlap.
    const [myMemberships, grants] = await Promise.all([
      tx.spaceMember.findMany({
        // Exclude archived/trashed spaces from the default switcher list —
        // they're only reachable via the Archive/Bin page from here on.
        where: { userId: user.id, status: "ACTIVE", space: { archivedAt: null, deletedAt: null } },
        select: {
          role: true,
          space: { select: { id: true, name: true, type: true } },
        },
        orderBy: { joinedAt: "asc" },
      }),
      // PO1.0 — platform Spaces the caller holds an ACTIVE grant on
      // (access-derived; no SpaceMember rows exist for platform Spaces).
      tx.platformGrant.findMany({
        where:  { userId: user.id, status: "ACTIVE" },
        select: { area: true, level: true },
      }),
    ]);

    const platformSpaces = grants.length === 0 ? [] : await tx.space.findMany({
      where:  { platformArea: { in: grants.map((g) => g.area) } },
      select: { id: true, name: true, platformArea: true },
    });

    return { myMemberships, grants, platformSpaces };
  });
  console.log(`[api/spaces] myMemberships: ${Date.now() - t1}ms, total: ${Date.now() - t0}ms`);

  const platform = platformSpaces.map((s) => ({
    ...s, access: grants.find((g) => g.area === s.platformArea)!.level,
  }));

  return NextResponse.json({
    mine: myMemberships.map((m) => ({ ...m.space, myRole: m.role })),
    // Additive key — existing consumers (Sidebar switcher, AddManualAssetModal
    // share picker) read only `mine`, so this is invisible to them until opted in.
    platform,
  });
}, "GET /api/spaces");

export const POST = withApiHandler(async (req: NextRequest) => {
  const [user, err] = await requireUser();
  if (err) return err;

  const body = await req.json();
  const { name, description, isPublic, templateId, category } = body as {
    name:         string;
    description?: string;
    isPublic?:    boolean;
    templateId?:  string;
    category?:    SpaceCategory;
  };

  if (!name?.trim()) {
    return NextResponse.json({ error: "Name is required" }, { status: 400 });
  }

  // ── Template resolution (SP-2.1) ──────────────────────────────────────────
  // templateId, when provided, is authoritative: it must name a LIVE template
  // (hidden templates — e.g. `personal` — are resolvable, not creatable; the
  // 400 message deliberately doesn't distinguish unknown from hidden), and
  // the Space's category derives from the template — any client-sent
  // `category` is ignored. Without templateId, the legacy category path is
  // preserved unchanged: validate, fall back to OTHER, resolve that
  // category's template. Both paths materialize via the SP-1 planner, whose
  // birth-plan output is parity-tested byte-identical to the
  // getPresetsForCategory(resolvedCategory) call this replaces.
  let template: SpaceTemplate;
  if (templateId !== undefined) {
    const found = typeof templateId === "string" ? getTemplate(templateId) : undefined;
    if (!found || found.status !== "live") {
      return NextResponse.json({ error: "Unknown template" }, { status: 400 });
    }
    template = found;
  } else {
    // REVIEW-3 (slice F): the legacy `category` field used to accept ANY
    // SpaceCategory and resolve its hidden template — a bypass around the
    // live-template gate above. It now accepts only the currently-supported
    // shared categories (the allowlist minus PERSONAL — a SHARED Space can
    // never be born PERSONAL); anything else falls back to OTHER exactly as
    // an absent/invalid category always has.
    const legacyCategory: SpaceCategory =
      category &&
      category !== SpaceCategory.PERSONAL &&
      SUPPORTED_SPACE_CATEGORIES.includes(category)
        ? category
        : SpaceCategory.OTHER;
    const found = getTemplateForCategory(legacyCategory);
    if (!found) {
      // Static registry invariant — every SpaceCategory has a template
      // (guarded by lib/space-templates tests).
      throw new Error(`space-templates registry has no template for category ${legacyCategory}`);
    }
    template = found;
  }

  const resolvedCategory: SpaceCategory = template.category;

  // Build default section rows from the template's birth plan
  const sectionPresets = planTemplateApplication(template, new Set<string>()).sectionsToCreate;

  // MC1 Phase 3 Slice 1 (D-2) — copy-once: the new Space's reporting currency
  // is seeded from the creator's User default at creation and owned by the
  // Space thereafter (no retroactive inheritance; editing the User default
  // never re-denominates existing Spaces). Nothing reads the value yet — the
  // conversion flip is Phase 3 Slices 3–6.
  // RLS slice B — the creator reads their OWN User row, which is exactly what
  // fm_app's `User` policy (`id = current_fm_user_id()`) permits and all this
  // ever wanted.
  const creator = await withTenantDb(user.id, (tx) => tx.user.findUnique({
    where:  { id: user.id },
    select: { reportingCurrency: true },
  }));
  const reportingCurrency = reportingCurrencyForNewSpace(creator);

  // Space creation, membership, dashboard sections, and the Space's AiAgent
  // must all succeed together. Every Space has exactly one AiAgent (schema
  // enforces @@unique on spaceId); creating it here — in the same transaction
  // as the Space — mirrors the register route and prevents the "No AiAgent
  // found" gap that buildContext() would otherwise hit on the Daily Brief.
  // ⚠️ RLS slice B — THE ORDER OF THE WRITES INSIDE THIS TRANSACTION IS NOW
  // LOAD-BEARING, AND SO IT IS NO LONGER LEFT TO PRISMA'S NESTED-WRITE EMISSION
  // ORDER. Every Space-scoped table's INSERT policy is
  // `spaceId IN (SELECT fm_visible_space_ids())`, and that function reads
  // SpaceMember — so a child row can only be written AFTER the creator's OWNER
  // membership exists. Within one transaction a later statement sees the earlier
  // statement's uncommitted rows, so the sequence below is admissible, but only
  // in this sequence:
  //
  //     1. Space              INSERT policy is WITH CHECK (true) — deliberately,
  //                           because creation is self-service and no membership
  //                           can exist yet (see §11 of the RLS migration).
  //     2. SpaceMember        admitted by the `userId = current_fm_user_id()` arm
  //                           of its INSERT policy — the creator inserting their
  //                           OWN row. This is the statement that makes the new
  //                           Space visible to everything after it.
  //     3. sections, AiAgent  now `spaceId IN fm_visible_space_ids()` holds.
  //
  // `dashboardSections` therefore moved OUT of the nested create: as a sibling
  // nested write its position relative to `members` was Prisma's choice, not
  // ours, and if it had gone first every new Space would have been born with no
  // sections and no error. The response shape is unchanged — the rows are read
  // back under the same orderBy the include used.
  const space = await withTenantDb(user.id, async (tx) => {
    const created = await tx.space.create({
      data: {
        name:        name.trim(),
        description: description?.trim() || null,
        type:        "SHARED",
        category:    resolvedCategory,
        isPublic:    !!isPublic,
        reportingCurrency, // MC1 P3 — copy-once from creator (see above)
        members: {
          create: { userId: user.id, role: "OWNER" },
        },
      },
      include: {
        members: {
          include: { user: { select: { id: true, name: true, username: true } } },
        },
      },
    });

    await tx.spaceDashboardSection.createMany({
      data: sectionPresets.map((s) => ({
        spaceId: created.id,
        key:     s.key,
        label:   s.label,
        tab:     s.tab,
        enabled: s.enabled,
        order:   s.order,
        config:  s.config == null ? Prisma.DbNull : s.config as Prisma.InputJsonValue,
      })),
    });

    const dashboardSections = await tx.spaceDashboardSection.findMany({
      where:   { spaceId: created.id },
      orderBy: [{ tab: "asc" }, { order: "asc" }],
    });

    await tx.aiAgent.create({
      data: {
        spaceId:    created.id,
        name:       `${created.name} Agent`,
        agentScope: [],   // empty → full template manifest is used
      },
    });

    return { ...created, dashboardSections };
  });

  await withTenantDb(user.id, (tx) => tx.auditLog.create({
    data: {
      userId:      user.id,
      spaceId: space.id,
      action:      AuditAction.SPACE_CREATE,
      // templateId: weak provenance (SP-2 investigation §7) — the template
      // that birthed this Space, recorded here pending the SP-3 column.
      metadata:    { name: space.name, isPublic: space.isPublic, category: resolvedCategory as string, templateId: template.id },
      ipAddress:   getClientIp(req),
    },
  }));

  return NextResponse.json(space, { status: 201 });
}, "POST /api/spaces");
