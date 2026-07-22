/**
 * GET  /api/spaces/[id]/goals  — list space goals
 * POST /api/spaces/[id]/goals  — create a new goal (OWNER/ADMIN only)
 */

import { NextRequest, NextResponse } from "next/server";
import { requireSpaceRole } from "@/lib/session";
import { GoalCategory, GoalType, SpaceMemberRole } from "@prisma/client";
import { db } from "@/lib/db";
import { withApiHandler, getClientIp } from "@/lib/api";
import { emitDomainEvent } from "@/lib/events/emit";
import { resolveFullVisibleAccountIds } from "@/lib/accounts/space-account-link";
import { filterVisibleContributions } from "@/lib/export/select";

const VALID_GOAL_CATEGORIES = new Set(Object.values(GoalCategory));
const VALID_GOAL_TYPES      = new Set(Object.values(GoalType));

export const GET = withApiHandler(async (
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) => {
  const { id: spaceId } = await params;
  const [, err] = await requireSpaceRole(spaceId);
  if (err) return err;

  // ?trash=true → return only soft-deleted goals (for the trash drawer)
  const url   = new URL(req.url);
  const trash = url.searchParams.get("trash") === "true";

  const goals = await db.spaceGoal.findMany({
    where:   trash
      ? { spaceId, deletedAt: { not: null } }
      : { spaceId, deletedAt: null },
    orderBy: [{ status: "asc" }, { targetDate: "asc" }, { createdAt: "asc" }],
    include: {
      contributions: {
        include: {
          financialAccount: {
            select: { id: true, name: true, balance: true, currency: true },
          },
        },
      },
      checkIns: {
        orderBy: { checkedAt: "desc" },
        take: 30,
        select: { id: true, checkedAt: true, note: true },
      },
    },
  });

  // P1-3 privacy convergence — this route is Space-scoped: it returns every
  // goal in the Space to every member, and each contribution carried the real
  // FinancialAccount name + balance ungated. A contribution pointing at an
  // account the viewing Space can only see as BALANCE_ONLY / SUMMARY_ONLY (or a
  // REVOKED / deleted link) would leak that account's real name, balance, and
  // id. Apply the canonical goals-contribution doctrine (export decision D4):
  // keep only contributions whose account is FULL-visible in this Space. The
  // FULL set already fails closed for non-FULL tiers, REVOKED/inactive links,
  // and soft-deleted accounts, so nothing beyond the link's tier is serialized.
  // Owner/Personal behavior is unchanged: an owned account carries a FULL HOME
  // link in its Space, so its contributions are always retained.
  const fullVisibleAccountIds = await resolveFullVisibleAccountIds(spaceId);
  const safeGoals = goals.map((g) => ({
    ...g,
    contributions: filterVisibleContributions(g.contributions, fullVisibleAccountIds),
  }));

  return NextResponse.json(safeGoals);
}, "GET /api/spaces/[id]/goals");

export const POST = withApiHandler(async (
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) => {
  const { id: spaceId } = await params;
  const [auth, err] = await requireSpaceRole(spaceId, SpaceMemberRole.ADMIN);
  if (err) return err;
  const { user } = auth;

  const body = await req.json();
  const {
    name,
    description,
    category,
    goalType = "FINANCIAL",
    targetAmount,
    targetDate,
    // HABIT
    habitFrequency,
    // SPENDING_LIMIT
    spendingCategory,
    // DEBT_REDUCTION
    linkedAccountId,
    targetReductionAmount,
    targetReductionPct,
    snapshotBalance,
  } = body as {
    name:                  string;
    description?:          string;
    category?:             string;
    goalType?:             string;
    targetAmount?:         number;
    targetDate?:           string | null;
    habitFrequency?:       string;
    spendingCategory?:     string;
    linkedAccountId?:      string;
    targetReductionAmount?: number;
    targetReductionPct?:   number;
    snapshotBalance?:      number;
  };

  if (!name?.trim()) {
    return NextResponse.json({ error: "Name is required" }, { status: 400 });
  }

  // Validate enums server-side (guard against stale clients or direct API calls)
  if (goalType && !VALID_GOAL_TYPES.has(goalType as GoalType)) {
    return NextResponse.json({ error: `Invalid goalType: ${goalType}` }, { status: 400 });
  }
  const resolvedCategory: GoalCategory =
    category && VALID_GOAL_CATEGORIES.has(category as GoalCategory)
      ? (category as GoalCategory)
      : GoalCategory.GENERAL;

  // Type-specific validation
  if (goalType === "FINANCIAL" && (!targetAmount || targetAmount <= 0)) {
    return NextResponse.json({ error: "Target amount must be greater than 0" }, { status: 400 });
  }
  if (goalType === "SPENDING_LIMIT" && (!targetAmount || targetAmount <= 0)) {
    return NextResponse.json({ error: "Monthly limit must be greater than 0" }, { status: 400 });
  }
  if (goalType === "HABIT" && !habitFrequency) {
    return NextResponse.json({ error: "Habit frequency is required" }, { status: 400 });
  }
  if (goalType === "DEBT_REDUCTION" && !linkedAccountId) {
    return NextResponse.json({ error: "A linked account is required for debt reduction goals" }, { status: 400 });
  }

  const goal = await db.spaceGoal.create({
    data: {
      spaceId,
      createdByUserId:       user.id,
      name:                  name.trim(),
      description:           description?.trim() || null,
      category:              resolvedCategory,
      goalType:              goalType as GoalType,
      targetAmount:          targetAmount ?? null,
      // DEBT_REDUCTION: seed currentAmount = snapshotBalance so paid = 0 at start
      currentAmount:         goalType === "DEBT_REDUCTION" ? (snapshotBalance ?? 0) : 0,
      targetDate:            targetDate ? new Date(targetDate) : null,
      habitFrequency:        habitFrequency ?? null,
      spendingCategory:      spendingCategory?.trim() || null,
      linkedAccountId:       linkedAccountId ?? null,
      targetReductionAmount: targetReductionAmount ?? null,
      targetReductionPct:    targetReductionPct ?? null,
      snapshotBalance:       snapshotBalance ?? null,
    },
  });

  // EV-1 Slice 5B — GoalCreated (audit-only, no handler). No transaction and no
  // side effect here today; the no-tx emit persists the canonical GOAL_CREATED
  // row with byte-identical metadata (targetAmount omitted when absent).
  await emitDomainEvent({
    type:        "GoalCreated",
    spaceId,
    actorUserId: user.id,
    ipAddress:   getClientIp(req),
    payload:     { goalId: goal.id, name: goal.name, goalType, targetAmount },
  });

  return NextResponse.json(goal, { status: 201 });
}, "POST /api/spaces/[id]/goals");
