/**
 * lib/platform/incidents/customer-update/http.ts  (Incident customer update, PR-C1)
 *
 * A service result → the HTTP response (every response no-store). For a
 * mutating route a refusal is recorded FIRST through the operator-action
 * envelope (recordControlRefusal: control "incident-customer-update", the
 * verb, the refusal code, the incident id as the target key, the reason CODE
 * when one parsed — never the paragraph, the note or the body). Best-effort:
 * a failed refusal audit never changes the refusal.
 */

import "server-only";
import { NextResponse } from "next/server";
import type { PlatformAuth } from "@/lib/platform/authorize";
import { recordControlRefusal } from "@/lib/platform/control-refusal";
import type { CustomerUpdateResult } from "./service";

const NO_STORE = { "Cache-Control": "no-store" } as const;

export function customerUpdateJson(r: CustomerUpdateResult): NextResponse {
  return NextResponse.json(r.body, { status: r.status, headers: NO_STORE });
}

export async function customerUpdateMutationResponse(
  r: CustomerUpdateResult,
  auth: Pick<PlatformAuth, "user" | "grant">,
  verb: "preview" | "send",
  incidentId: string,
  meta: { ipAddress?: string | null; userAgent?: string | null },
): Promise<NextResponse> {
  if (r.refusal) {
    await recordControlRefusal(auth, {
      control: "incident-customer-update", verb, code: r.refusal, targetKey: incidentId, reasonCode: r.reasonCode,
    }, meta, undefined, "CUSTOMER_SUCCESS");
  }
  return customerUpdateJson(r);
}
