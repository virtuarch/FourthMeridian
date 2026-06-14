/**
 * GET  /api/workspaces/[id]/goals  — list workspace goals
 * POST /api/workspaces/[id]/goals  — create a new goal (OWNER/ADMIN only)
 */

import { NextRequest, NextResponse } from "next/server";
import { requireWorkspaceRole } from "@/lib/session";
import { GoalCategory, GoalType, WorkspaceMemberRole } from "@prisma/client";
import { db } from "@/lib/db";
import { withApiHandler, getClientIp } from "@/lib/api";

const VALID_GOAL_CATEGORIES = new Set(Object.values(GoalCategory));
const VALID_GOAL_TYPES      = new Set(Object.values(GoalType));

export const GET = withApiHandler(async (
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) => {
  const { id: workspaceId } = await params;
  const [, err] = await requireWorkspaceRole(workspaceId);
  if (err) return err;

  // ?trash=true → return only soft-deleted goals (for the trash drawer)
  const url   = new URL(req.url);
  const trash = url.searchParams.get("trash") === "true";

  const goals = await db.workspaceGoal.findMany({
    where:   trash
      ? { workspaceId, deletedAt: { not: null } }
      : { workspaceId, deletedAt: null },
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

  return NextResponse.json(goals);
}, "GET /api/workspaces/[id]/goals");

export const POST = withApiHandler(async (
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) => {
  const { id: workspaceId } = await params;
  const [auth, err] = await requireWorkspaceRole(workspaceId, WorkspaceMemberRole.ADMIN);
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

  const goal = await db.workspaceGoal.create({
    data: {
      workspaceId,
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

  await db.auditLog.create({
    data: {
      userId:      user.id,
      workspaceId,
      action:      "GOAL_CREATE",
      metadata:    { goalId: goal.id, name: goal.name, goalType, targetAmount },
      ipAddress:   getClientIp(req),
    },
  });

  return NextResponse.json(goal, { status: 201 });
}, "POST /api/workspaces/[id]/goals");
