/**
 * GET /api/platform/growth-revenue/beta-status  (PO-3A)
 *
 * The Beta Access operating status for the Growth & Revenue "Beta Access" block:
 * the current registration_mode (the beta ON/OFF switch) + the invitation
 * lifecycle counts (sent / accepted / expired / revoked). A pure READ projection
 * over the `registration_mode` PlatformSetting + BetaAccessRequest columns — no
 * new store, no write, no fabricated metric.
 *
 * AUTHORIZATION: requirePlatformAccess("GROWTH_REVENUE", "READ"). The mode
 * *write* (the toggle) stays on the Admin/Security settings surface for now —
 * this route only READS it, so the operating area can show the current state
 * without owning the switch.
 */

import { NextResponse } from "next/server";
import { requirePlatformAccess } from "@/lib/platform/authorize";
import {
  getRegistrationMode,
  getProductStatus,
  type RegistrationMode,
  type ProductStatus,
} from "@/lib/platform-settings";
import { getBetaInvitationLifecycle, type BetaInvitationLifecycle } from "@/lib/platform/growth/growth";

export const runtime = "nodejs";

export interface BetaStatusResponse {
  /** The beta switch: "open" (anyone) | "invite_only" (beta ON) | "closed". */
  registrationMode: RegistrationMode;
  /** The LAUNCH axis (development/beta/live), separate from the signup gate. */
  productStatus:    ProductStatus;
  invitations:      Omit<BetaInvitationLifecycle, "checkedAt">;
  checkedAt:        string;
}

export async function GET(): Promise<Response> {
  const [, err] = await requirePlatformAccess("GROWTH_REVENUE", "READ");
  if (err) return err;

  const [registrationMode, productStatus, lifecycle] = await Promise.all([
    getRegistrationMode(),
    getProductStatus(),
    getBetaInvitationLifecycle(),
  ]);

  const { checkedAt, ...invitations } = lifecycle;
  return NextResponse.json({
    registrationMode,
    productStatus,
    invitations,
    checkedAt,
  } satisfies BetaStatusResponse);
}
