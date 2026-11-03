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


/**
 * F2 (S2 review) — refuse an oversized or unsized body BEFORE reading it.
 * `null` = acceptable; otherwise the status to answer with:
 *   400 the Content-Length header is absent or not a non-negative integer
 *       (a browser fetch with a string body always sends one);
 *   413 it declares more than MAX_BODY_BYTES.
 * parsePresenceBody's own length check stays as the backstop (a lying header).
 */
export function presenceContentLengthRefusal(header: string | null): 400 | 413 | null {
  if (header === null || !/^\d{1,10}$/.test(header.trim())) return 400;
  return Number(header.trim()) > MAX_BODY_BYTES ? 413 : null;
}
