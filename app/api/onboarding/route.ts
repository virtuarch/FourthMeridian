/**
 * POST /api/onboarding  (Connections pass PR 2 — first-time onboarding)
 *
 * Records one of two per-user markers: `presented` (the welcome view was shown,
 * so the post-login redirect never fires again) or `dismissed` ("Explore My
 * Space" / the invitation's dismiss). Body `{ event: "presented" | "dismissed" }`.
 * Idempotent; the caller's own AuditLog row, written as the caller.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/session";
import { recordOnboardingEvent } from "@/lib/onboarding/first-run";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const [user, err] = await requireUser();
  if (err) return err;

  const body = (await req.json().catch(() => null)) as { event?: unknown } | null;
  const event = body?.event;
  if (event !== "presented" && event !== "dismissed") {
    return NextResponse.json({ error: "Unknown onboarding event." }, { status: 400 });
  }

  await recordOnboardingEvent(user.id, event);
  return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
}
