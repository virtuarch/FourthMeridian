/**
 * /api/platform/growth-revenue/invitation-policy  (PR B · configurable invitation validity)
 *
 * GET  → { validityDays, min, max, default, version, origin }
 *        requirePlatformAccess("GROWTH_REVENUE", "READ").
 * PUT  { validityDays, version, reason } → the same read model
 *        requireFreshPlatformAccess("GROWTH_REVENUE", "WRITE"), a structured
 *        reason (BETA_INVITATION_VALIDITY_CHANGED is reason-required), and the
 *        optimistic `version` the caller read (null = it saw the default). A
 *        stale version ⇒ 409 with the current model; out of 1–30 ⇒ 400.
 *        The setting write and its audit row commit in ONE transaction
 *        (lib/platform/growth/invitation-policy.ts).
 *
 * Changing this applies to NEW invitations only (approve, direct invite and
 * resend). Invitations already issued keep their expiry; Extend moves one.
 */

import { NextRequest, NextResponse } from "next/server";
import { systemDb } from "@/lib/db";
import { requireFreshPlatformAccess, requirePlatformAccess } from "@/lib/platform/authorize";
import { operatorActorFrom } from "@/lib/platform/operator-actor";
import { getClientIp } from "@/lib/api";
import { readInvitationPolicy, updateInvitationValidity } from "@/lib/platform/growth/invitation-policy";
import { parseRequiredReason } from "@/lib/platform/growth/invitation-http";

export const runtime = "nodejs";

export async function GET() {
  const [, err] = await requirePlatformAccess("GROWTH_REVENUE", "READ");
  if (err) return err;
  return NextResponse.json(await readInvitationPolicy(systemDb));
}

export async function PUT(req: NextRequest) {
  const [auth, err] = await requireFreshPlatformAccess("GROWTH_REVENUE", "WRITE");
  if (err) return err;

  const body = (await req.json().catch(() => ({}))) as { validityDays?: unknown; version?: unknown; reason?: unknown };
  if (!("version" in body) || (body.version !== null && typeof body.version !== "string")) {
    return NextResponse.json({ error: "version is required (the value you loaded, or null for the default)." }, { status: 400 });
  }
  const reason = parseRequiredReason(body.reason);
  if (!reason.ok) return reason.response;

  const r = await updateInvitationValidity(systemDb, {
    validityDays: body.validityDays,
    expectedVersion: body.version as string | null,
    reason: reason.reason,
    actor: operatorActorFrom(auth, "GROWTH_REVENUE"),
    ipAddress: getClientIp(req),
    userAgent: req.headers.get("user-agent"),
  });
  if (r.ok) return NextResponse.json(r.model);
  return NextResponse.json(
    { error: r.reason, code: r.code, model: r.model },
    { status: r.code === "CONFLICT" ? 409 : 400 },
  );
}
