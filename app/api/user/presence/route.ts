/**
 * POST /api/user/presence  (PB-10 — the visible-tab presence heartbeat)
 *
 * Body: `{ "interacted": boolean }` and nothing else. 204 on success.
 * A missing / non-numeric Content-Length ⇒ 400, one above the 64-byte cap ⇒ 413,
 * both before the body is read (the parsed-length cap remains as a backstop).
 *
 * WHAT IT RECORDS. "A visible tab holding THIS session checked in" (and, when
 * `interacted` is true, "…and the user clicked / typed / scrolled / focused it
 * since the last beat"). Definitions and thresholds: lib/presence/definitions.ts.
 * A beat is presence, never activity of the session (lastActiveAt) and never
 * engagement — it writes no AuditLog row and no product event.
 *
 * AUTH. The NORMAL session guard (requireUser: claims, revocation cache, row
 * live / owned, SEC-010 lifetime, current role, pending-TOTP gate ⇒ 403) — run
 * inside runWithoutSessionTouch, so the session callback skips ONLY its
 * lastActiveAt touch (lib/auth/presence-scope.ts). The row written is the
 * caller's own: the cookie's sessionToken AND the verified user id. Nothing in
 * the body names a user, a session or a time.
 *
 * SPOOFING. Server (database) clock only. The client sends no timestamp, no
 * count, no duration, no visibility claim — the tab's visibility only decides
 * whether the client sends a beat at all. `interacted` is client-asserted and is
 * treated as LOW TRUST everywhere it is read.
 *
 * RATE LIMIT. Its OWN per-session bucket (`presence`, keyed on a hash of the
 * session token — never the token), PRESENCE_CONFIG.rateLimit; a 429 returns
 * before any write. It is a FIXED, epoch-aligned window (lib/rate-limit.ts):
 * two beats straddling a window boundary are both admitted even if seconds
 * apart; two inside one window are not (see PRESENCE_CONFIG.rateLimit). The database throttle (PRESENCE_CONFIG.serverThrottleSeconds)
 * bounds writes across instances on top of it.
 *
 * PRIVACY. No IP, user agent or page path is read, stored or logged here.
 */

import { NextResponse } from "next/server";
import { requireUser, recordSessionPresence } from "@/lib/session";
import { runWithoutSessionTouch } from "@/lib/auth/presence-scope";
import { limitByKey } from "@/lib/rate-limit";
import { PRESENCE_CONFIG } from "@/lib/presence/definitions";
import { parsePresenceBody, presenceContentLengthRefusal, presenceLimitKey } from "@/lib/presence/heartbeat-request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

export async function POST(req: Request) {
  const [user, err] = await runWithoutSessionTouch(() => requireUser());
  if (err) return err;
  if (!user.sessionToken) return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: NO_STORE });

  // F2 — size the body from its header before reading a byte of it.
  const sizeRefusal = presenceContentLengthRefusal(req.headers.get("content-length"));
  if (sizeRefusal) {
    return NextResponse.json({ error: sizeRefusal === 413 ? "Body too large" : "Invalid body" }, { status: sizeRefusal, headers: NO_STORE });
  }
  const body = parsePresenceBody(await req.text().catch(() => ""));
  if (!body) return NextResponse.json({ error: "Invalid body" }, { status: 400, headers: NO_STORE });

  const limited = await limitByKey(presenceLimitKey(user.sessionToken), "presence", PRESENCE_CONFIG.rateLimit);
  if (limited) return limited;

  await recordSessionPresence(user, body.interacted);
  return new NextResponse(null, { status: 204, headers: NO_STORE });
}
