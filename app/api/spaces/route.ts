/**
 * GET  /api/spaces  — list spaces the user belongs to + all public spaces
 * POST /api/spaces  — create a new SHARED space (user becomes OWNER)
 *                         Accepts optional `templateId` (SP-1 registry; must
 *                         be a live template — category derives from it) or
 *                         legacy `category` (SpaceCategory), and generates
 *                         default SpaceDashboardSection rows.
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { Prisma } from "@prisma/client";
// SpaceCategory imported from space-presets so this file compiles
// before `prisma generate` has been re-run with the new schema values.
// The string values are identical to what Prisma generates.
import { requireUser } from "@/lib/session";
import { SpaceCategory } from "@/lib/space-presets";
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
  // `mine` (membership-driven) and `platform` (access-derived) are independent —
  // run them together. Platform Spaces have NO SpaceMember rows by design, so
  // they can never appear in `mine`; the two lists never overlap.
  const [myMemberships, grants] = await Promise.all([
    db.spaceMember.findMany({
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
    db.platformGrant.findMany({
      where:  { userId: user.id, status: "ACTIVE" },
      select: { area: true, level: true },
    }),
  ]);
  console.log(`[api/spaces] myMemberships: ${Date.now() - t1}ms, total: ${Date.now() - t0}ms`);

  const platform = grants.length === 0 ? [] : (
    await db.space.findMany({
      where:  { platformArea: { in: grants.map((g) => g.area) } },
      select: { id: true, name: true, platformArea: true },
    })
  ).map((s) => ({ ...s, access: grants.find((g) => g.area === s.platformArea)!.level }));

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
    const legacyCategory: SpaceCategory =
      category && Object.values(SpaceCategory).includes(category)
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
  const creator = await db.user.findUnique({
    where:  { id: user.id },
    select: { reportingCurrency: true },
  });
  const reportingCurrency = reportingCurrencyForNewSpace(creator);

  // Space creation, membership, dashboard sections, and the Space's AiAgent
  // must all succeed together. Every Space has exactly one AiAgent (schema
  // enforces @@unique on spaceId); creating it here — in the same transaction
  // as the Space — mirrors the register route and prevents the "No AiAgent
  // found" gap that buildContext() would otherwise hit on the Daily Brief.
  const space = await db.$transaction(async (tx) => {
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
        dashboardSections: {
          create: sectionPresets.map((s) => ({
            key:     s.key,
            label:   s.label,
            tab:     s.tab,
            enabled: s.enabled,
            order:   s.order,
            config:  s.config == null ? Prisma.DbNull : s.config as Prisma.InputJsonValue,
          })),
        },
      },
      include: {
        members: {
          include: { user: { select: { id: true, name: true, username: true } } },
        },
        dashboardSections: {
          orderBy: [{ tab: "asc" }, { order: "asc" }],
        },
      },
    });

    await tx.aiAgent.create({
      data: {
        spaceId:    created.id,
        name:       `${created.name} Agent`,
        agentScope: [],   // empty → full template manifest is used
      },
    });

    return created;
  });

  await db.auditLog.create({
    data: {
      userId:      user.id,
      spaceId: space.id,
      action:      AuditAction.SPACE_CREATE,
      // templateId: weak provenance (SP-2 investigation §7) — the template
      // that birthed this Space, recorded here pending the SP-3 column.
      metadata:    { name: space.name, isPublic: space.isPublic, category: resolvedCategory as string, templateId: template.id },
      ipAddress:   getClientIp(req),
    },
  });

  return NextResponse.json(space, { status: 201 });
}, "POST /api/spaces");
