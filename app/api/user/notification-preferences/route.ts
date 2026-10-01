/**
 * /api/user/notification-preferences  (OPS-3 S3)
 *
 * GET   — the caller's EFFECTIVE category × channel matrix (registry defaults
 *         ⊕ override rows; default-by-absence — lib/notifications/preferences.ts).
 * PATCH — upsert one override cell: { category, channel, enabled }.
 *         Registry-validated; locked categories (ACCOUNT_SECURITY) are
 *         rejected 400 — security notifications can't be turned off (F11).
 *
 * Preference reads/writes go ONLY through lib/notifications/preferences.ts —
 * no other module touches NotificationPreference. No delivery, no digest, no
 * scheduling concerns here (later slices).
 */

import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/session";
import { withTenantDb } from "@/lib/db/tenant-context";
import {
  getPreferenceMatrix,
  setNotificationPreference,
  type PreferenceClient,
} from "@/lib/notifications/preferences";

export async function GET() {
  const [user, err] = await requireUser();
  if (err) return err;

  // RLS slice A — the preference module already took its client as an argument; the
  // route now SAYS which one instead of letting it fall back to the global.
  const matrix = await withTenantDb(user.id, (tx) =>
    getPreferenceMatrix(user.id, { client: tx as unknown as PreferenceClient }));
  return NextResponse.json({ matrix });
}

export async function PATCH(req: NextRequest) {
  const [user, err] = await requireUser();
  if (err) return err;

  const body = (await req.json()) as {
    category?: unknown;
    channel?: unknown;
    enabled?: unknown;
  };
  if (
    typeof body.category !== "string" ||
    typeof body.channel !== "string" ||
    typeof body.enabled !== "boolean"
  ) {
    return NextResponse.json(
      { error: "Expected { category: string, channel: string, enabled: boolean }." },
      { status: 400 },
    );
  }

  // Narrowed OUT of the closure: TypeScript's narrowing of `body.*` does not reach
  // inside a callback, and widening the call signature to take it would be worse.
  const { category, channel, enabled } = body;
  const result = await withTenantDb(user.id, (tx) => setNotificationPreference(
    user.id,
    category,
    channel,
    enabled,
    { client: tx as unknown as PreferenceClient },
  ));
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }
  return NextResponse.json({ ok: true });
}
