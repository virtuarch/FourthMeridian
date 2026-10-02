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
 *
 * ── RLS-ACC-S1 — ONE TENANT PHASE, AND ONE POLICY ASYMMETRY IT EXPOSES ───────
 * Validation is pure and runs first, outside any transaction. The gate read, the
 * upsert and the audit row are then ONE short phase under the caller's own
 * identity, which also makes the write and its audit trail atomic — they were
 * two independent statements before.
 *
 * ⚠️ THE `WITH CHECK` WAS CHECKED, NOT ASSUMED, AND THE TWO PREDICATES DISAGREE.
 * This route authorizes on `fa.ownerUserId === user.id`, which is served by
 * `FinancialAccount.fm_app_sel`'s owner arm. `DebtProfile` is an account-SUBTREE
 * table (migration §15) and its policies are `fm_account_visible("financialAccountId")`
 * for all four verbs — there is NO `ownerUserId` arm anywhere in the subtree.
 * `fm_account_visible` is true only while an ACTIVE `SpaceAccountLink` exists in
 * a Space this identity is an ACTIVE member of. So for an account the caller
 * genuinely owns but which has NO active link in any of their Spaces — reachable,
 * because the share route lets an owner revoke their own HOME link — the
 * application gate PASSES and the database then refuses:
 *
 *     UPDATE arm   refused by USING       → 0 rows, silent
 *     INSERT arm   refused by WITH CHECK  → RAISES
 *
 * Prisma's `upsert` tries the update, finds nothing, and falls through to the
 * create, so the composite operation RAISES rather than reporting a silent
 * no-op. That is the loud half of the asymmetry and it is the half we want: the
 * caller gets a 500 from the handler's catch instead of a 200 describing a write
 * that never happened. It is nonetheless a FAILURE, not a success, and it is the
 * same gap RLS-C-S7 recorded on the connection-disconnect route. Closing it
 * needs a policy change (an owner arm on the subtree, or on
 * `fm_account_visible` itself) which is a migration and not this slice's to make
 * — so it is recorded here and reported, not papered over with a wider client.
 *
 * `AuditLog.fm_app_ins` is `WITH CHECK (true)` — 90 independent writers and a
 * shared shape helper with no `spaceId` parameter (migration §18) — so the audit
 * row is reachable from the tenant phase and needs no second authority.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/session";
import { withTenantDb } from "@/lib/db/tenant-context";
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

    const data = {
      ...(apr               !== undefined && { apr }),
      ...(minimumPayment    !== undefined && { minimumPayment }),
      ...(dueDay             !== undefined && { dueDay }),
      ...(statementCloseDay !== undefined && { statementCloseDay }),
      ...(parsedPromoEnd     !== undefined && { promoAprEndDate: parsedPromoEnd }),
      ...(notes              !== undefined && { notes }),
    };

    // ONE short tenant phase: gate, upsert, audit. The gate is a PRE-READ
    // database guarantee now — `fm_app_sel`'s owner arm — and not merely a
    // comparison performed after a BYPASSRLS principal handed the row over.
    const gated = await withTenantDb(user.id, async (tx) => {
      const fa = await tx.financialAccount.findUnique({ where: { id } });
      if (!fa) return { kind: "notFound" as const };
      if (fa.ownerUserId !== user.id) return { kind: "forbidden" as const };

      // ⚠️ See the header: the subtree policy has no owner arm, so this upsert
      // RAISES for an owned account with no ACTIVE link. Deliberately not caught
      // here — the handler's catch reports it as a 500, which is a failure, and
      // a silent 200 would be worse.
      const profile = await tx.debtProfile.upsert({
        where:  { financialAccountId: id },
        update: data,
        create: { financialAccountId: id, ...data },
      });

      await tx.auditLog.create({
        data: {
          userId:    user.id,
          action:    AuditAction.DEBT_PROFILE_UPDATED,
          metadata:  { accountId: id, ...data, promoAprEndDate: parsedPromoEnd?.toISOString() ?? undefined },
          ipAddress: getClientIp(req),
        },
      });

      return { kind: "ok" as const, profile };
    });

    if (gated.kind === "notFound") {
      return NextResponse.json({ error: "Account not found" }, { status: 404 });
    }
    if (gated.kind === "forbidden") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    const profile = gated.profile;

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
