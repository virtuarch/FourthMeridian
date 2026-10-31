/**
 * lib/platform/growth/invitation-http.ts  (PR B)
 *
 * The one IssueResult → HTTP mapping the three issuance routes share, plus the
 * optional-reason parse. Kept out of the route files (Next allows only handler
 * exports there) so approve / resend / direct invite stay thin wrappers.
 *
 * Response bodies carry no token, no link and no expiry beyond the ISO instant
 * already shown in Growth.
 */

import "server-only";
import { NextResponse } from "next/server";
import { OperatorActionValidationError, parseOperatorReason, type OperatorReason } from "@/lib/audit";
import type { IssueResult } from "./invitation-issue";

export function issueResultResponse(r: IssueResult): NextResponse {
  if (!r.ok) return NextResponse.json({ error: r.message, code: r.code }, { status: r.status });
  switch (r.outcome) {
    case "alreadyApproved":
      return NextResponse.json({ success: true, alreadyApproved: true, emailStatus: "skipped" });
    case "alreadyReissued":
      return NextResponse.json({ success: true, alreadyReissued: true, emailStatus: "skipped" });
    case "issued":
      return NextResponse.json({
        success: true,
        emailStatus: r.emailStatus,
        performed: r.performed,
        validityDays: r.validityDays,
        expiresAt: r.expiresAt.toISOString(),
      });
  }
}

/** An OPTIONAL structured reason (approve / resend / direct are reason-optional). */
export function parseOptionalReason(raw: unknown): { ok: true; reason?: OperatorReason } | { ok: false; response: NextResponse } {
  if (raw === undefined || raw === null) return { ok: true };
  try { return { ok: true, reason: parseOperatorReason(raw) }; }
  catch (e) {
    if (e instanceof OperatorActionValidationError) {
      return { ok: false, response: NextResponse.json({ error: e.message }, { status: 400 }) };
    }
    throw e;
  }
}

/** A REQUIRED structured reason (validity change, extend). */
export function parseRequiredReason(raw: unknown): { ok: true; reason: OperatorReason } | { ok: false; response: NextResponse } {
  try { return { ok: true, reason: parseOperatorReason(raw) }; }
  catch (e) {
    if (e instanceof OperatorActionValidationError) {
      return { ok: false, response: NextResponse.json({ error: e.message }, { status: 400 }) };
    }
    throw e;
  }
}
