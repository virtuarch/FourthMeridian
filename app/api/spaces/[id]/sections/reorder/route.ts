/**
 * PATCH /api/spaces/[id]/sections/reorder
 *
 * UX-CUST-1A — batch section reorder for a single tab.
 *
 * Body: { tab: SpaceDashboardTab, sectionIds: string[] }
 *   - sectionIds is the desired top-to-bottom order for that tab.
 *   - Each section's `order` is reassigned to its index in the array, in one
 *     transaction (dense, gap-free 0..n-1).
 *
 * Scope guarantees (tab-scoped, no cross-tab moves, no schema change):
 *   - Every id must belong to this space AND to the named tab. Any mismatch
 *     (foreign id, wrong tab, duplicate, missing) → 400, no writes.
 *   - Only `order` is touched — never tab/enabled/label/config/key.
 *
 * Security:
 *   - Requires the existing `section:edit` action (OWNER/ADMIN). VIEWER/MEMBER
 *     and non-members are rejected with 403 by requireSpaceAction.
 */

import { NextRequest, NextResponse } from "next/server";
import { db }                        from "@/lib/db";
import { requireSpaceAction }        from "@/lib/spaces/authorize";
import type { SpaceDashboardTab }    from "@prisma/client";

const VALID_TABS: readonly SpaceDashboardTab[] = [
  "OVERVIEW", "GOALS", "ACCOUNTS", "DEBT",
  "INVESTMENTS", "RETIREMENT", "ACTIVITY", "SETTINGS",
];

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: spaceId } = await params;

  // Reorder is a section mutation — same gate as toggling/editing sections.
  const [, err] = await requireSpaceAction(spaceId, "section:edit");
  if (err) return err;

  const body = await req.json().catch(() => null) as {
    tab?:        string;
    sectionIds?: unknown;
  } | null;

  const tab = body?.tab;
  if (!tab || !VALID_TABS.includes(tab as SpaceDashboardTab)) {
    return NextResponse.json({ error: "Invalid or missing tab" }, { status: 400 });
  }

  const sectionIds = body?.sectionIds;
  if (
    !Array.isArray(sectionIds) ||
    sectionIds.length === 0 ||
    !sectionIds.every((s): s is string => typeof s === "string")
  ) {
    return NextResponse.json({ error: "sectionIds must be a non-empty string array" }, { status: 400 });
  }

  // Reject duplicates — a permutation must be 1:1.
  if (new Set(sectionIds).size !== sectionIds.length) {
    return NextResponse.json({ error: "sectionIds contains duplicates" }, { status: 400 });
  }

  // Load the tab's real sections and verify the request is exactly a
  // permutation of them (no foreign ids, no cross-tab ids, none omitted).
  const tabSections = await db.spaceDashboardSection.findMany({
    where:  { spaceId, tab: tab as SpaceDashboardTab },
    select: { id: true },
  });

  const tabIds = new Set(tabSections.map((s) => s.id));
  const sameSize    = tabIds.size === sectionIds.length;
  const allInTab    = sectionIds.every((id) => tabIds.has(id));
  if (!sameSize || !allInTab) {
    return NextResponse.json(
      { error: "sectionIds must be exactly the sections of this tab" },
      { status: 400 },
    );
  }

  // Dense reassignment: order = index. Single transaction — all or nothing.
  await db.$transaction(
    sectionIds.map((id, index) =>
      db.spaceDashboardSection.update({
        where: { id },
        data:  { order: index },
      }),
    ),
  );

  return NextResponse.json({ ok: true });
}
