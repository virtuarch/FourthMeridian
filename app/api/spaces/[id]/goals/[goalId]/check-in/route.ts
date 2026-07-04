/**
 * POST /api/spaces/[id]/goals/[goalId]/check-in
 * Record a habit check-in and update streak counters.
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireSpaceAction } from "@/lib/spaces/authorize";
import { withApiHandler, getClientIp } from "@/lib/api";
import { emitDomainEvent } from "@/lib/events/emit";

export const POST = withApiHandler(async (
  req: NextRequest,
  { params }: { params: Promise<{ id: string; goalId: string }> }
) => {
  const { id: spaceId, goalId } = await params;

  // Any ACTIVE member (any role) may record a check-in.
  const [auth, err] = await requireSpaceAction(spaceId, "goal:checkIn");
  if (err) return err;

  const goal = await db.spaceGoal.findUnique({ where: { id: goalId } });
  if (!goal || goal.spaceId !== spaceId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (goal.goalType !== "HABIT") {
    return NextResponse.json({ error: "Check-ins are only for HABIT goals" }, { status: 400 });
  }

  const body = await req.json().catch(() => ({}));
  const note: string | null = (body as { note?: string }).note?.trim() || null;

  const now       = new Date();
  const lastCheckIn: Date | null = goal.lastCheckIn ? new Date(goal.lastCheckIn) : null;

  // Determine streak logic based on habit frequency
  let newStreak = goal.currentStreak;
  const freq: string = goal.habitFrequency ?? "DAILY";

  const msInDay  = 86_400_000;
  const msInWeek = 7 * msInDay;

  if (lastCheckIn) {
    const diffMs   = now.getTime() - lastCheckIn.getTime();
    const window   = freq === "DAILY" ? msInDay * 2 : freq === "WEEKLY" ? msInWeek * 2 : msInDay * 62;
    const minGap   = freq === "DAILY" ? msInDay * 0.5 : freq === "WEEKLY" ? msInDay * 5 : msInDay * 25;

    if (diffMs < minGap) {
      // Too soon — duplicate check-in, still record it but don't increment
    } else if (diffMs <= window) {
      newStreak += 1;
    } else {
      // Streak broken — reset
      newStreak = 1;
    }
  } else {
    newStreak = 1;
  }

  const newLongest = Math.max(goal.longestStreak, newStreak);

  const [checkIn, updatedGoal] = await db.$transaction([
    db.goalCheckIn.create({
      data: { goalId, note, checkedAt: now },
    }),
    db.spaceGoal.update({
      where: { id: goalId },
      data:  {
        lastCheckIn:   now,
        currentStreak: newStreak,
        longestStreak: newLongest,
      },
    }),
  ]);

  // Timeline T-2 — GoalCheckedIn (audit-only, no handler). Net-new
  // Timeline-visible row. Emitted post-commit (no-tx) so the array-form
  // transaction above is untouched. Note is deliberately excluded from the
  // payload — it is personal free-text and not surfaced in the space feed.
  await emitDomainEvent({
    type:        "GoalCheckedIn",
    spaceId,
    actorUserId: auth.user.id,
    ipAddress:   getClientIp(req),
    payload:     { goalId, goalName: goal.name, streak: newStreak },
  });

  return NextResponse.json({ checkIn, goal: updatedGoal }, { status: 201 });
}, "POST /api/spaces/[id]/goals/[goalId]/check-in");
