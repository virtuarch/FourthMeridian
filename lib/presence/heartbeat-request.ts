/**
 * lib/presence/heartbeat-request.ts  (PB-10) — the heartbeat route's pure helpers.
 * Kept out of the route file (Next route modules may only export handlers/config).
 */

import { createHash } from "node:crypto";

/** Bodies above this are refused unread: the only valid one is `{"interacted":false}`. */
export const MAX_BODY_BYTES = 64;

/** Parse the one allowed shape; anything else is null (⇒ 400). */
export function parsePresenceBody(raw: string): { interacted: boolean } | null {
  if (raw.length === 0 || raw.length > MAX_BODY_BYTES) return null;
  let v: unknown;
  try { v = JSON.parse(raw); } catch { return null; }
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const keys = Object.keys(v);
  if (keys.length !== 1 || keys[0] !== "interacted") return null;
  const interacted = (v as { interacted: unknown }).interacted;
  return typeof interacted === "boolean" ? { interacted } : null;
}

/** The per-session rate-limit subject: a one-way digest, never the token itself. */
export function presenceLimitKey(sessionToken: string): string {
  return createHash("sha256").update(`presence:${sessionToken}`).digest("hex").slice(0, 32);
}

