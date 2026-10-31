/**
 * POST /api/platform/customer-success/notifications/test-send  (Comms Center B2, contract v1.1 §6.9)
 *
 * { reason, body: { key, channel: "EMAIL" | "IN_APP", variant?, versionId?, fixture? } }.
 * The recipient is ALWAYS the operator: resolved from the session user's own row —
 * the request has no address or recipient field. The address must be verified
 * (else 422 GUARD_REFUSED guard SELF_UNVERIFIED) and, outside Production, on
 * EMAIL_NONPROD_ALLOWLIST (else 422 guard NONPROD_ALLOWLIST, before any render).
 * Synthetic values only, a "[TEST]" subject, ledger mode TEST; OPERATOR-class (no
 * lifecycle evaluation, exempt from the storm limit). versionId on a protected key
 * → 409 PROTECTED.
 *
 * AUTHORIZATION: requireFreshPlatformAccess("CUSTOMER_SUCCESS", "WRITE"), then the
 * cs-comms-test bucket (5 per 10 min). The reason-required audit row
 * (COMMS_TEST_SEND) is written BEFORE the send: no audit, no send.
 */

import type { NextRequest } from "next/server";
import { requireFreshPlatformAccess } from "@/lib/platform/authorize";
import { getRequestMeta } from "@/lib/api";
import { readJsonBody, runContent } from "@/lib/notifications/content/http";
import { AUTOMATION_BODY_MAX_BYTES, testSendHandler } from "@/lib/notifications/automations/http";
import { automationServices, csCommsTestLimit } from "@/lib/notifications/automations/deps";

export const runtime = "nodejs";

export async function POST(req: NextRequest): Promise<Response> {
  return runContent({ guard: () => requireFreshPlatformAccess("CUSTOMER_SUCCESS", "WRITE"), rateLimit: csCommsTestLimit }, async (auth, now) => {
    const body = await readJsonBody(req, AUTOMATION_BODY_MAX_BYTES);
    if (!body.ok) return body.res;
    return testSendHandler(body.value, auth, getRequestMeta(req), now, automationServices);
  });
}
