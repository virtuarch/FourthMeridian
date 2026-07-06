/**
 * POST /api/user/export  (OPS-2 S6 — personal data export)
 *
 * Streams a ZIP of the authenticated user's personal data (manifest.json,
 * data.json, and CSVs for the tabular sets). Read-only with respect to the
 * user's data; the only side effects are a security-alert email and an audit
 * row. Mirrors the sensitive-action template established by
 * app/api/user/deactivate/route.ts.
 *
 * Privacy: the bundle is assembled by lib/export/assemble.ts, which composes
 * the EXISTING visibility-enforcing read layer — it never bypasses SAL
 * enforcement and adds no parallel permission logic (approved decisions D3–D5).
 *
 * Auth:   requireFreshUser() — live revocation check (no password re-entry, D2).
 * Limit:  3 per day per user (D6-adjacent; §5 of the lifecycle investigation).
 * Design: works unchanged during a future pending-deletion window (D7) — it
 *         depends only on a live session, not on account state.
 */

import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireFreshUser } from "@/lib/session";
import { limitByUser } from "@/lib/rate-limit";
import { sendEmail } from "@/lib/email/send";
import { formatDateTime } from "@/lib/format";
import { AuditAction } from "@/lib/audit-actions";
import { assembleUserExport } from "@/lib/export/assemble";
import { buildExportZip } from "@/lib/export/zip";

export async function POST() {
  try {
    // Fresh, live-revocation-checked session — sensitive data egress.
    const [user, err] = await requireFreshUser();
    if (err) return err;

    // 3 exports per day per user.
    const limited = await limitByUser(user.id, "data-export", { limit: 3, windowSec: 86_400 });
    if (limited) return limited;

    // Compose the bundle from the existing readers, then zip it.
    const data = await assembleUserExport(user.id);
    const zip = await buildExportZip(data);

    // The user's email lives on the row, not the session.
    const dbUser = await db.user.findUnique({ where: { id: user.id }, select: { email: true } });

    // Notify. NON-THROWING: a delivery failure is logged and audited, never
    // fails the export.
    let emailStatus: string = "skipped";
    if (dbUser?.email) {
      const emailResult = await sendEmail("security-alert", dbUser.email, {
        title: "Your data was exported",
        message:
          `A copy of your Fourth Meridian data was exported on ` +
          `${formatDateTime(new Date().toISOString())}. If this wasn't you, ` +
          `change your password and review your active sessions.`,
      });
      emailStatus = emailResult.status;
      if (emailResult.status === "error") {
        console.error("[user/export] security-alert email failed to send:", emailResult.error);
      }
    }

    await db.auditLog.create({
      data: {
        userId:   user.id,
        action:   AuditAction.DATA_EXPORTED,
        metadata: { counts: data.manifest.counts, truncated: data.manifest.truncated, emailStatus },
      },
    });

    const filename = `fourth-meridian-export-${new Date().toISOString().slice(0, 10)}.zip`;
    return new NextResponse(new Uint8Array(zip), {
      status: 200,
      headers: {
        "Content-Type":        "application/zip",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Content-Length":      String(zip.length),
        "Cache-Control":       "no-store",
      },
    });
  } catch (err) {
    console.error("[user/export] error:", err);
    return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }
}
