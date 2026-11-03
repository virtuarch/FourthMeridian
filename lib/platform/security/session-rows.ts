/**
 * lib/platform/security/session-rows.ts  (Security Ops recent-sessions row shape)
 *
 * Kept apart from ./live-sessions.ts, whose readers are pinned to counts only.
 */

import { parseUserAgent } from "@/lib/ua-parser";

/**
 * One row of the Security Ops "recent live sessions" list — parsed browser ·
 * device · OS and the last-activity time ONLY. Never a session id, user id or
 * token: the route is identity-free (registry live-sessions@1 drill note), and
 * a session id is joinable to a user wherever session ids appear.
 */
export interface PlatformSessionRow {
  device:  string; // parsed — e.g. "Desktop" / "Mobile"
  browser: string; // parsed — e.g. "Chrome"
  os:      string; // parsed — e.g. "macOS"
  at:      string; // ISO lastActiveAt
}

export function toPlatformSessionRow(s: { userAgent: string | null; lastActiveAt: Date }): PlatformSessionRow {
  const p = parseUserAgent(s.userAgent ?? "");
  return { device: p.device, browser: p.browser, os: p.os, at: s.lastActiveAt.toISOString() };
}
