/**
 * GET /api/platform/platform-ops/attention  (UX-P1 · Agent 2)
 *
 * What needs attention right now: one ranked list composed from six existing
 * authorities (lib/platform/ops/attention.ts). Read-only; no provider call; no
 * database client of its own; gated PLATFORM_OPS READ.
 *
 * PRIVACY: rows carry institution / job / provider / resource / rule labels and
 * opaque connection ids. Incident subjects are the D5 institution · account
 * label. Policy-assignment rows (owner ruling, 2026-10-30) name a customer by the
 * opaque `user …abc123` reference only. No email, no userId, no address, no token.
 */

import { NextResponse } from "next/server";
import { requirePlatformAccess } from "@/lib/platform/authorize";
import { getAttention, type AttentionResponse } from "@/lib/platform/ops/attention";

export const runtime = "nodejs";

export type { AttentionResponse };

export async function GET() {
  const [, err] = await requirePlatformAccess("PLATFORM_OPS", "READ");
  if (err) return err;
  return NextResponse.json((await getAttention()) satisfies AttentionResponse);
}
