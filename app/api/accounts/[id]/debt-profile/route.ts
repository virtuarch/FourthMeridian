/**
 * app/api/accounts/[id]/debt-profile/route.ts
 *
 * id refers to a FinancialAccount.id.
 *
 * PATCH — upserts the account's DebtProfile (apr, minimumPayment, dueDay,
 *         statementCloseDay, promoAprEndDate, notes). All fields optional;
 *         only the fields included in the request body are changed.
 *         Passing `null` for a field clears it. Kept as its own sub-resource
 *         (separate from PATCH /api/accounts/[id]) per the "dedicated debt
 *         profile" design — these fields live on a separate DebtProfile row,
 *         not on FinancialAccount itself.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/session";
import { db } from "@/lib/db";
import { withApiHandler, getClientIp } from "@/lib/api";
import { AuditAction } from "@/lib/audit-actions";

interface DebtProfileBody {
  apr?:               number | null;
  minimumPayment?:    number | null;
  dueDay?:            number | null;
  statementCloseDay?: number | null;
  promoAprEndDate?:   string | null; // ISO date (YYYY-MM-DD)
  notes?:             string | null;
}

function isValidDay(n: number) {
  return Number.isInteger(n) && n >= 1 && n <= 31;
}

export const PATCH = withApiHandler(async (
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) => {
  const { id } = await params;
  if (!id) return NextResponse.json({ error: "Missing account id" }, { status: 400 });

  const [user, err] = await requireUser();
  if (err) return err;

  try {
    const body = await req.json() as DebtProfileBody;
    const { apr, minimumPayment, dueDay, statementCloseDay, promoAprEndDate, notes } = body;

    if (apr !== undefined && apr !== null && (typeof apr !== "number" || apr < 0 || apr > 100)) {
      return NextResponse.json({ error: "Invalid apr — must be 0–100" }, { status: 400 });
    }
    if (minimumPayment !== undefined && minimumPayment !== null &&
        (typeof minimumPayment !== "number" || minimumPayment < 0)) {
      return NextResponse.json({ error: "Invalid minimumPayment" }, { status: 400 });
    }
    if (dueDay !== undefined && dueDay !== null && !isValidDay(dueDay)) {
      return NextResponse.json({ error: "Invalid dueDay — must be 1–31" }, { status: 400 });
    }
    if (statementCloseDay !== undefined && statementCloseDay !== null && !isValidDay(statementCloseDay)) {
      return NextResponse.json({ error: "Invalid statementCloseDay — must be 1–31" }, { status: 400 });
    }
    let parsedPromoEnd: Date | null | undefined = undefined;
    if (promoAprEndDate !== undefined) {
      if (promoAprEndDate === null) {
        parsedPromoEnd = null;
      } else {
        const d = new Date(promoAprEndDate);
        if (isNaN(d.getTime())) {
          return NextResponse.json({ error: "Invalid promoAprEndDate" }, { status: 400 });
        }
        parsedPromoEnd = d;
      }
    }
    if (notes !== undefined && notes !== null && typeof notes !== "string") {
      return NextResponse.json({ error: "Invalid notes" }, { status: 400 });
    }

    const fa = await db.financialAccount.findUnique({ where: { id } });
    if (!fa) return NextResponse.json({ error: "Account not found" }, { status: 404 });
    if (fa.ownerUserId !== user.id) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const data = {
      ...(apr               !== undefined && { apr }),
      ...(minimumPayment    !== undefined && { minimumPayment }),
      ...(dueDay             !== undefined && { dueDay }),
      ...(statementCloseDay !== undefined && { statementCloseDay }),
      ...(parsedPromoEnd     !== undefined && { promoAprEndDate: parsedPromoEnd }),
      ...(notes              !== undefined && { notes }),
    };

    const profile = await db.debtProfile.upsert({
      where:  { financialAccountId: id },
      update: data,
      create: { financialAccountId: id, ...data },
    });

    await db.auditLog.create({
      data: {
        userId:    user.id,
        action:    AuditAction.DEBT_PROFILE_UPDATED,
        metadata:  { accountId: id, ...data, promoAprEndDate: parsedPromoEnd?.toISOString() ?? undefined },
        ipAddress: getClientIp(req),
      },
    });

    return NextResponse.json({
      ok: true,
      debtProfile: {
        apr:               profile.apr               ?? undefined,
        minimumPayment:    profile.minimumPayment     ?? undefined,
        dueDay:            profile.dueDay             ?? undefined,
        statementCloseDay: profile.statementCloseDay  ?? undefined,
        promoAprEndDate:   profile.promoAprEndDate ? profile.promoAprEndDate.toISOString().split("T")[0] : undefined,
        notes:             profile.notes              ?? undefined,
      },
    });
  } catch (err) {
    console.error("[PATCH /api/accounts/:id/debt-profile]", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}, "PATCH /api/accounts/[id]/debt-profile");
